import { randomUUID } from "node:crypto";
import { fingerprintCanonical, fingerprintError, fingerprintStrategy } from "./fingerprints";
import { FileWorkflowStore } from "./store";
import type {
  CircuitBreakerRecord,
  FailureExperienceRecord,
  WorkflowAttemptRecord,
  WorkflowBudget,
  WorkflowLifecycle,
  WorkflowRunRecord,
  WorkflowStepRecord,
  WorkflowVersionSnapshot,
} from "./types";

export interface WorkflowOrchestratorOptions {
  readonly store: FileWorkflowStore;
  readonly defaultBudget?: Partial<WorkflowBudget>;
  readonly circuitThreshold?: number;
  readonly circuitCooldownMs?: number;
}

export interface AttemptAdmission {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly run: WorkflowRunRecord;
  readonly step: WorkflowStepRecord;
  readonly attempt?: WorkflowAttemptRecord;
}

export interface WorkflowGraphState {
  readonly run: WorkflowRunRecord;
  readonly steps: readonly WorkflowStepRecord[];
  readonly ready: readonly WorkflowStepRecord[];
}

export class WorkflowOrchestrator {
  readonly store: FileWorkflowStore;
  private readonly defaultBudget: WorkflowBudget;
  private readonly circuitThreshold: number;
  private readonly circuitCooldownMs: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: WorkflowOrchestratorOptions) {
    this.store = options.store;
    this.defaultBudget = {
      maxTotalAttempts: positiveInteger(
        options.defaultBudget?.maxTotalAttempts,
        4,
        "maxTotalAttempts",
      ),
      maxAttemptsPerStep: positiveInteger(
        options.defaultBudget?.maxAttemptsPerStep,
        4,
        "maxAttemptsPerStep",
      ),
      maxCallsPerEdge: positiveInteger(
        options.defaultBudget?.maxCallsPerEdge,
        3,
        "maxCallsPerEdge",
      ),
    };
    this.circuitThreshold = positiveInteger(
      options.circuitThreshold,
      3,
      "circuitThreshold",
    );
    this.circuitCooldownMs = positiveInteger(
      options.circuitCooldownMs,
      300_000,
      "circuitCooldownMs",
    );
  }

  ensureRun(input: {
    readonly externalKey?: string;
    readonly kind: string;
    readonly lifecycle: WorkflowLifecycle;
    readonly budget?: Partial<WorkflowBudget>;
    readonly metadata?: Readonly<Record<string, string>>;
    readonly versions?: WorkflowVersionSnapshot;
  }): Promise<WorkflowRunRecord> {
    return this.enqueue(async () => {
      if (input.externalKey !== undefined) {
        const existing = await this.store.findRunByExternalKey(input.externalKey);
        if (existing !== undefined) {
          return existing;
        }
      }
      const now = new Date().toISOString();
      const run: WorkflowRunRecord = {
        schemaVersion: 1,
        runId: randomUUID(),
        ...(input.externalKey === undefined
          ? {}
          : { externalKey: input.externalKey }),
        kind: input.kind,
        lifecycle: input.lifecycle,
        status: "queued",
        budget: {
          maxTotalAttempts: positiveInteger(
            input.budget?.maxTotalAttempts,
            this.defaultBudget.maxTotalAttempts,
            "maxTotalAttempts",
          ),
          maxAttemptsPerStep: positiveInteger(
            input.budget?.maxAttemptsPerStep,
            this.defaultBudget.maxAttemptsPerStep,
            "maxAttemptsPerStep",
          ),
          maxCallsPerEdge: positiveInteger(
            input.budget?.maxCallsPerEdge,
            this.defaultBudget.maxCallsPerEdge,
            "maxCallsPerEdge",
          ),
        },
        attemptsUsed: 0,
        metadata: input.metadata ?? {},
        versions: input.versions ?? {},
        createdAt: now,
        updatedAt: now,
      };
      await this.store.createRun(run);
      await this.store.appendEvent({
        runId: run.runId,
        type: "workflow.created",
        payload: { kind: run.kind, lifecycle: run.lifecycle },
      });
      return run;
    });
  }

  ensureStep(input: {
    readonly runId: string;
    readonly stepId: string;
    readonly kind: string;
    readonly dependencies?: readonly string[];
    readonly initialStatus?: "succeeded" | "skipped";
  }): Promise<WorkflowStepRecord> {
    return this.enqueue(async () => {
      const existing = (await this.store.readSteps(input.runId))
        .find((step) => step.stepId === input.stepId);
      if (existing !== undefined) {
        if (
          existing.kind !== input.kind ||
          !sameStrings(existing.dependencies, input.dependencies ?? [])
        ) {
          throw new Error(
            `Workflow step ${input.stepId} already exists with a different definition`,
          );
        }
        return existing;
      }
      const now = new Date().toISOString();
      const step: WorkflowStepRecord = {
        schemaVersion: 1,
        runId: input.runId,
        stepId: input.stepId,
        kind: input.kind,
        status: input.initialStatus ??
          ((input.dependencies?.length ?? 0) === 0 ? "ready" : "pending"),
        dependencies: input.dependencies ?? [],
        attemptsUsed: 0,
        edgeCalls: {},
        createdAt: now,
        updatedAt: now,
      };
      await this.store.writeSteps(input.runId, (steps) => [...steps, step]);
      await this.store.appendEvent({
        runId: input.runId,
        stepId: input.stepId,
        type: step.status === "ready" ? "step.ready" : "step.pending",
      });
      return step;
    });
  }

  beginAttempt(input: {
    readonly runId: string;
    readonly stepId: string;
    readonly strategy: Readonly<Record<string, unknown>>;
    readonly triggerErrorFingerprint?: string;
    readonly edgeKey?: string;
    readonly circuitKey?: string;
    readonly versions?: WorkflowVersionSnapshot;
    readonly allowDuplicateStrategy?: boolean;
  }): Promise<AttemptAdmission> {
    return this.enqueue(async () => {
      const run = await this.store.readRun(input.runId);
      const step = requireStep(await this.store.readSteps(input.runId), input.stepId);
      const attempts = await this.store.readAttempts(input.runId);
      const strategyFingerprint = fingerprintStrategy(input.strategy);

      const dependencies = new Set(step.dependencies);
      if (dependencies.size > 0) {
        const succeeded = new Set(
          (await this.store.readSteps(input.runId))
            .filter((candidate) =>
              candidate.status === "succeeded" || candidate.status === "skipped")
            .map((candidate) => candidate.stepId),
        );
        const unmet = [...dependencies].filter((dependency) => !succeeded.has(dependency));
        if (unmet.length > 0) {
          return this.denyAttempt(run, step, `step_dependencies_unmet:${unmet.join(",")}`);
        }
      }
      if (step.status === "running" || step.status === "succeeded" ||
          step.status === "skipped") {
        return this.denyAttempt(run, step, `step_is_${step.status}`);
      }

      if (isTerminalWithoutRetry(run.status)) {
        return this.rejectAttempt(run, step, `workflow_is_${run.status}`);
      }
      if (run.attemptsUsed >= run.budget.maxTotalAttempts) {
        return this.rejectAttempt(run, step, "workflow_attempt_budget_exhausted");
      }
      if (step.attemptsUsed >= run.budget.maxAttemptsPerStep) {
        return this.rejectAttempt(run, step, "step_attempt_budget_exhausted");
      }
      if (
        input.edgeKey !== undefined &&
        (step.edgeCalls[input.edgeKey] ?? 0) >= run.budget.maxCallsPerEdge
      ) {
        return this.rejectAttempt(run, step, `edge_budget_exhausted:${input.edgeKey}`);
      }
      if (
        input.allowDuplicateStrategy !== true &&
        input.triggerErrorFingerprint !== undefined &&
        attempts.some((attempt) =>
          attempt.resultErrorFingerprint === input.triggerErrorFingerprint &&
          attempt.strategyFingerprint === strategyFingerprint)
      ) {
        return this.rejectAttempt(run, step, "duplicate_error_and_strategy");
      }
      if (input.circuitKey !== undefined) {
        const circuit = await this.admitCircuit(input.circuitKey, run.runId);
        if (!circuit.allowed) {
          return this.rejectAttempt(run, step, circuit.reason);
        }
      }

      const now = new Date().toISOString();
      const attempt: WorkflowAttemptRecord = {
        schemaVersion: 1,
        runId: run.runId,
        stepId: step.stepId,
        attemptId: randomUUID(),
        ordinal: step.attemptsUsed + 1,
        status: "running",
        strategy: input.strategy,
        strategyFingerprint,
        ...(input.triggerErrorFingerprint === undefined
          ? {}
          : { triggerErrorFingerprint: input.triggerErrorFingerprint }),
        idempotencyPrefix: `${run.runId}/${step.stepId}/${step.attemptsUsed + 1}`,
        ...(input.circuitKey === undefined ? {} : { circuitKey: input.circuitKey }),
        versions: { ...run.versions, ...input.versions },
        createdAt: now,
        updatedAt: now,
      };
      await this.store.writeAttempts(run.runId, (current) => [...current, attempt]);
      const updatedRun = await this.store.updateRun(run.runId, (current) => {
        const { endedAt: _endedAt, terminalReason: _terminalReason, ...active } =
          current;
        return {
          ...active,
          status: "running",
          attemptsUsed: current.attemptsUsed + 1,
          startedAt: current.startedAt ?? now,
          updatedAt: now,
        };
      });
      const updatedSteps = await this.store.writeSteps(run.runId, (current) =>
        current.map((candidate) =>
          candidate.stepId === step.stepId
            ? activateStep(candidate, input.edgeKey, now)
            : candidate));
      const updatedStep = requireStep(updatedSteps, step.stepId);
      await this.store.appendEvent({
        runId: run.runId,
        stepId: step.stepId,
        attemptId: attempt.attemptId,
        type: "attempt.started",
        payload: {
          ordinal: attempt.ordinal,
          strategyFingerprint,
          idempotencyPrefix: attempt.idempotencyPrefix,
        },
      });
      return {
        allowed: true,
        run: updatedRun,
        step: updatedStep,
        attempt,
      };
    });
  }

  finishAttempt(input: {
    readonly runId: string;
    readonly attemptId: string;
    readonly success: boolean;
    readonly resultErrorFingerprint?: string;
    readonly diffFingerprint?: string;
    readonly contextFingerprint?: string;
    readonly summary: string;
  }): Promise<WorkflowAttemptRecord> {
    return this.enqueue(async () => {
      const run = await this.store.readRun(input.runId);
      const attempts = await this.store.readAttempts(input.runId);
      const attempt = requireAttempt(attempts, input.attemptId);
      if (run.status === "cancelled" || attempt.status === "cancelled") {
        return attempt;
      }
      if (attempt.status === "succeeded" || attempt.status === "failed") {
        return attempt;
      }
      const now = new Date().toISOString();
      const completed: WorkflowAttemptRecord = {
        ...attempt,
        status: input.success ? "succeeded" : "failed",
        ...(input.resultErrorFingerprint === undefined
          ? {}
          : { resultErrorFingerprint: input.resultErrorFingerprint }),
        ...(input.diffFingerprint === undefined
          ? {}
          : { diffFingerprint: input.diffFingerprint }),
        summary: input.summary,
        updatedAt: now,
        endedAt: now,
      };
      await this.store.writeAttempts(run.runId, (current) =>
        current.map((candidate) =>
          candidate.attemptId === completed.attemptId ? completed : candidate));

      const repeatedDiff = !input.success &&
        input.resultErrorFingerprint !== undefined &&
        input.diffFingerprint !== undefined &&
        attempts.some((candidate) =>
          candidate.attemptId !== attempt.attemptId &&
          candidate.resultErrorFingerprint === input.resultErrorFingerprint &&
          candidate.diffFingerprint === input.diffFingerprint);
      const budgetExhausted = run.attemptsUsed >= run.budget.maxTotalAttempts ||
        attempt.ordinal >= run.budget.maxAttemptsPerStep;
      const blocked = repeatedDiff || budgetExhausted;
      const nextStepStatus = input.success
        ? "succeeded"
        : blocked
        ? "blocked"
        : "failed";
      const previousSteps = await this.store.readSteps(run.runId);
      const updatedSteps = await this.store.writeSteps(run.runId, (steps) =>
        advanceDependencyState(steps.map((step) =>
          step.stepId === attempt.stepId
            ? {
                ...step,
                status: nextStepStatus,
                updatedAt: now,
                ...(blocked
                  ? {
                      terminalReason: repeatedDiff
                        ? "duplicate_error_and_diff"
                        : "attempt_budget_exhausted",
                    }
                  : {}),
              }
            : step), now));
      await this.appendStepTransitionEvents(run.runId, previousSteps, updatedSteps);
      const runState = deriveRunState(updatedSteps, input.success ? "running" : "retrying");
      await this.store.updateRun(run.runId, (current) => {
        const terminal = runState.status === "succeeded" || runState.status === "blocked";
        const { endedAt: _endedAt, terminalReason: _terminalReason, ...active } = current;
        return {
          ...active,
          status: runState.status,
          updatedAt: now,
          ...(terminal ? { endedAt: now } : {}),
          ...(runState.terminalReason === undefined
            ? {}
            : { terminalReason: runState.terminalReason }),
        };
      });
      await this.store.appendEvent({
        runId: run.runId,
        stepId: attempt.stepId,
        attemptId: attempt.attemptId,
        type: input.success ? "attempt.succeeded" : "attempt.failed",
        payload: {
          summary: input.summary,
          ...(input.resultErrorFingerprint === undefined
            ? {}
            : { errorFingerprint: input.resultErrorFingerprint }),
          ...(input.diffFingerprint === undefined
            ? {}
            : { diffFingerprint: input.diffFingerprint }),
          blocked,
        },
      });

      if (!input.success && input.resultErrorFingerprint !== undefined) {
        const experience: FailureExperienceRecord = {
          schemaVersion: 1,
          experienceId: randomUUID(),
          runId: run.runId,
          stepId: attempt.stepId,
          attemptId: attempt.attemptId,
          workflowKind: run.kind,
          errorFingerprint: input.resultErrorFingerprint,
          strategyFingerprint: attempt.strategyFingerprint,
          ...(input.diffFingerprint === undefined
            ? {}
            : { diffFingerprint: input.diffFingerprint }),
          ...(input.contextFingerprint === undefined
            ? {}
            : { contextFingerprint: input.contextFingerprint }),
          summary: input.summary.slice(0, 4000),
          versions: attempt.versions,
          createdAt: now,
          resolution: "unresolved",
        };
        await this.store.appendFailureExperience(experience);
        if (attempt.circuitKey !== undefined) {
          await this.recordCircuitFailure(attempt.circuitKey);
        }
      } else if (input.success && attempt.circuitKey !== undefined) {
        await this.closeCircuit(attempt.circuitKey);
      }
      return completed;
    });
  }

  refreshGraph(runId: string): Promise<WorkflowGraphState> {
    return this.enqueue(async () => {
      const existingRun = await this.store.readRun(runId);
      if (existingRun.status === "cancelled") {
        return {
          run: existingRun,
          steps: await this.store.readSteps(runId),
          ready: [],
        };
      }
      const now = new Date().toISOString();
      const before = await this.store.readSteps(runId);
      const steps = advanceDependencyState(before, now);
      await this.store.writeSteps(runId, () => steps);
      await this.appendStepTransitionEvents(runId, before, steps);
      const derived = deriveRunState(steps, "queued");
      const run = await this.store.updateRun(runId, (current) => {
        const terminal = derived.status === "succeeded" || derived.status === "blocked";
        const { endedAt: _endedAt, terminalReason: _terminalReason, ...active } = current;
        return {
          ...active,
          status: derived.status,
          updatedAt: now,
          ...(terminal ? { endedAt: now } : {}),
          ...(derived.terminalReason === undefined
            ? {}
            : { terminalReason: derived.terminalReason }),
        };
      });
      return {
        run,
        steps,
        ready: steps.filter((step) => step.status === "ready"),
      };
    });
  }

  bindAttemptChild(input: {
    readonly runId: string;
    readonly attemptId: string;
    readonly externalKey: string;
    readonly childRunId: string;
  }): Promise<WorkflowAttemptRecord> {
    return this.enqueue(async () => {
      const attempts = await this.store.readAttempts(input.runId);
      const attempt = requireAttempt(attempts, input.attemptId);
      if (attempt.execution !== undefined) {
        if (
          attempt.execution.externalKey !== input.externalKey ||
          attempt.execution.childRunId !== input.childRunId
        ) {
          throw new Error(`Workflow attempt ${input.attemptId} is already bound`);
        }
        return attempt;
      }
      const execution = {
        kind: "child_agent" as const,
        externalKey: input.externalKey,
        childRunId: input.childRunId,
        boundAt: new Date().toISOString(),
      };
      const updated = { ...attempt, execution, updatedAt: execution.boundAt };
      await this.store.writeAttempts(input.runId, (current) =>
        current.map((candidate) =>
          candidate.attemptId === input.attemptId ? updated : candidate));
      await this.store.appendEvent({
        runId: input.runId,
        stepId: attempt.stepId,
        attemptId: attempt.attemptId,
        type: "attempt.child_bound",
        payload: {
          externalKey: input.externalKey,
          childRunId: input.childRunId,
        },
      });
      return updated;
    });
  }

  async failureDigest(input: {
    readonly workflowKind: string;
    readonly errorFingerprint?: string;
    readonly contextFingerprint?: string;
    readonly limit?: number;
  }): Promise<readonly FailureExperienceRecord[]> {
    const limit = input.limit ?? 5;
    return (await this.store.readFailureExperiences())
      .filter((experience) =>
        experience.workflowKind === input.workflowKind &&
        experience.resolution === "unresolved" &&
        (input.errorFingerprint === undefined ||
          experience.errorFingerprint === input.errorFingerprint) &&
        (input.contextFingerprint === undefined ||
          experience.contextFingerprint === undefined ||
          experience.contextFingerprint === input.contextFingerprint))
      .slice(-limit)
      .reverse();
  }

  recordStepCheckpoint(input: {
    readonly runId: string;
    readonly stepId: string;
    readonly checkpoint: Readonly<Record<string, unknown>>;
  }): Promise<WorkflowStepRecord> {
    return this.enqueue(async () => {
      const now = new Date().toISOString();
      const steps = await this.store.writeSteps(input.runId, (current) =>
        current.map((step) =>
          step.stepId === input.stepId
            ? {
                ...step,
                checkpoint: {
                  ...step.checkpoint,
                  ...input.checkpoint,
                  checkpointedAt: now,
                },
                updatedAt: now,
              }
            : step));
      const step = requireStep(steps, input.stepId);
      await this.store.appendEvent({
        runId: input.runId,
        stepId: input.stepId,
        type: "step.checkpointed",
        payload: input.checkpoint,
      });
      return step;
    });
  }

  recoverInterruptedRuns(reason = "orchestrator_restarted"): Promise<number> {
    return this.enqueue(async () => {
      let recovered = 0;
      for (const run of await this.store.listRuns()) {
        if (run.status !== "running" && run.status !== "retrying") {
          continue;
        }
        recovered += 1;
        const now = new Date().toISOString();
        const interruptionFingerprint = fingerprintError({
          stepKind: run.kind,
          errorCode: "orchestrator_interrupted",
          message: reason,
        });
        const attempts = await this.store.readAttempts(run.runId);
        const interruptedAttempts = attempts.filter((attempt) =>
          attempt.status === "running");
        await this.store.updateRun(run.runId, (current) => ({
          ...current,
          status: "interrupted",
          updatedAt: now,
          endedAt: now,
          terminalReason: reason,
        }));
        await this.store.writeSteps(run.runId, (steps) =>
          steps.map((step) =>
            step.status === "running"
              ? {
                  ...step,
                  status: "failed",
                  updatedAt: now,
                  terminalReason: reason,
                }
              : step));
        await this.store.writeAttempts(run.runId, (current) =>
          current.map((attempt) =>
            attempt.status === "running"
              ? {
                  ...attempt,
                  status: "interrupted",
                  resultErrorFingerprint: interruptionFingerprint,
                  diffFingerprint: fingerprintCanonical({
                    state: "diff_unavailable",
                    reason,
                  }),
                  summary: reason,
                  updatedAt: now,
                  endedAt: now,
                }
              : attempt));
        for (const attempt of interruptedAttempts) {
          await this.store.appendFailureExperience({
            schemaVersion: 1,
            experienceId: randomUUID(),
            runId: run.runId,
            stepId: attempt.stepId,
            attemptId: attempt.attemptId,
            workflowKind: run.kind,
            errorFingerprint: interruptionFingerprint,
            strategyFingerprint: attempt.strategyFingerprint,
            diffFingerprint: fingerprintCanonical({
              state: "diff_unavailable",
              reason,
            }),
            summary: reason,
            versions: attempt.versions,
            createdAt: now,
            resolution: "unresolved",
          });
        }
        await this.store.appendEvent({
          runId: run.runId,
          type: "workflow.interrupted",
          payload: { reason, interruptionFingerprint },
        });
      }
      return recovered;
    });
  }

  cancelRun(runId: string, reason = "cancelled_by_user"): Promise<WorkflowRunRecord> {
    return this.enqueue(async () => {
      const existing = await this.store.readRun(runId);
      if (existing.status === "cancelled") return existing;
      const now = new Date().toISOString();
      const run = await this.store.updateRun(runId, (current) => ({
        ...current,
        status: "cancelled",
        updatedAt: now,
        endedAt: now,
        terminalReason: reason,
      }));
      await this.store.writeSteps(runId, (steps) =>
        steps.map((step) =>
          step.status === "running" ||
              step.status === "ready" ||
              step.status === "pending"
            ? {
                ...step,
                status: "blocked",
                updatedAt: now,
                terminalReason: reason,
              }
            : step));
      await this.store.writeAttempts(runId, (attempts) =>
        attempts.map((attempt) =>
          attempt.status === "running"
            ? {
                ...attempt,
                status: "cancelled",
                updatedAt: now,
                endedAt: now,
                summary: reason,
              }
            : attempt));
      await this.store.appendEvent({
        runId,
        type: "workflow.cancelled",
        payload: { reason },
      });
      return run;
    });
  }

  private async rejectAttempt(
    run: WorkflowRunRecord,
    step: WorkflowStepRecord,
    reason: string,
  ): Promise<AttemptAdmission> {
    const now = new Date().toISOString();
    const updatedRun = await this.store.updateRun(run.runId, (current) => ({
      ...current,
      status: "blocked",
      updatedAt: now,
      endedAt: now,
      terminalReason: reason,
    }));
    const steps = await this.store.writeSteps(run.runId, (current) =>
      current.map((candidate) =>
        candidate.stepId === step.stepId
          ? {
              ...candidate,
              status: "blocked",
              updatedAt: now,
              terminalReason: reason,
            }
          : candidate));
    const updatedStep = requireStep(steps, step.stepId);
    await this.store.appendEvent({
      runId: run.runId,
      stepId: step.stepId,
      type: "attempt.rejected",
      payload: { reason },
    });
    return {
      allowed: false,
      reason,
      run: updatedRun,
      step: updatedStep,
    };
  }

  private async denyAttempt(
    run: WorkflowRunRecord,
    step: WorkflowStepRecord,
    reason: string,
  ): Promise<AttemptAdmission> {
    await this.store.appendEvent({
      runId: run.runId,
      stepId: step.stepId,
      type: "attempt.denied",
      payload: { reason },
    });
    return { allowed: false, reason, run, step };
  }

  private async appendStepTransitionEvents(
    runId: string,
    before: readonly WorkflowStepRecord[],
    after: readonly WorkflowStepRecord[],
  ): Promise<void> {
    const previous = new Map(before.map((step) => [step.stepId, step.status]));
    for (const step of after) {
      if (previous.get(step.stepId) === step.status) continue;
      await this.store.appendEvent({
        runId,
        stepId: step.stepId,
        type: `step.${step.status}`,
        ...(step.terminalReason === undefined
          ? {}
          : { payload: { reason: step.terminalReason } }),
      });
    }
  }

  private async admitCircuit(
    key: string,
    runId: string,
  ): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly reason: string }> {
    const circuit = (await this.store.readCircuits()).find((item) => item.key === key);
    if (circuit === undefined || circuit.state === "closed") {
      return { allowed: true };
    }
    const now = Date.now();
    if (
      circuit.state === "open" &&
      circuit.cooldownUntil !== undefined &&
      Date.parse(circuit.cooldownUntil) <= now
    ) {
      await this.store.writeCircuits((current) =>
        replaceCircuit(current, {
          ...circuit,
          state: "half_open",
          probeRunId: runId,
          updatedAt: new Date(now).toISOString(),
        }));
      return { allowed: true };
    }
    if (circuit.state === "half_open" && circuit.probeRunId === runId) {
      return { allowed: true };
    }
    return { allowed: false, reason: `circuit_open:${key}` };
  }

  private async recordCircuitFailure(key: string): Promise<void> {
    const now = new Date();
    await this.store.writeCircuits((current) => {
      const existing = current.find((item) => item.key === key);
      const failureCount = (existing?.failureCount ?? 0) + 1;
      const open = existing?.state === "half_open" ||
        failureCount >= this.circuitThreshold;
      const next: CircuitBreakerRecord = {
        schemaVersion: 1,
        key,
        state: open ? "open" : "closed",
        failureCount,
        threshold: this.circuitThreshold,
        updatedAt: now.toISOString(),
        ...(open
          ? {
              openedAt: now.toISOString(),
              cooldownUntil: new Date(
                now.getTime() + this.circuitCooldownMs,
              ).toISOString(),
            }
          : {}),
      };
      return replaceCircuit(current, next);
    });
  }

  private async closeCircuit(key: string): Promise<void> {
    await this.store.writeCircuits((current) => {
      const existing = current.find((item) => item.key === key);
      if (existing === undefined) {
        return current;
      }
      return replaceCircuit(current, {
        schemaVersion: 1,
        key,
        state: "closed",
        failureCount: 0,
        threshold: existing.threshold,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function replaceCircuit(
  circuits: readonly CircuitBreakerRecord[],
  next: CircuitBreakerRecord,
): readonly CircuitBreakerRecord[] {
  return circuits.some((item) => item.key === next.key)
    ? circuits.map((item) => item.key === next.key ? next : item)
    : [...circuits, next];
}

function requireStep(
  steps: readonly WorkflowStepRecord[],
  stepId: string,
): WorkflowStepRecord {
  const step = steps.find((candidate) => candidate.stepId === stepId);
  if (step === undefined) {
    throw new Error(`Workflow step not found: ${stepId}`);
  }
  return step;
}

function requireAttempt(
  attempts: readonly WorkflowAttemptRecord[],
  attemptId: string,
): WorkflowAttemptRecord {
  const attempt = attempts.find((candidate) => candidate.attemptId === attemptId);
  if (attempt === undefined) {
    throw new Error(`Workflow attempt not found: ${attemptId}`);
  }
  return attempt;
}

function isTerminalWithoutRetry(status: WorkflowRunRecord["status"]): boolean {
  return status === "succeeded" || status === "cancelled";
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function advanceDependencyState(
  input: readonly WorkflowStepRecord[],
  now: string,
): readonly WorkflowStepRecord[] {
  let steps = [...input];
  let changed = true;
  while (changed) {
    changed = false;
    const byId = new Map(steps.map((step) => [step.stepId, step]));
    steps = steps.map((step) => {
      if (step.status !== "pending" && step.status !== "ready") return step;
      const dependencies = step.dependencies.map((dependency) => byId.get(dependency));
      const missingDependency = dependencies.some((dependency) => dependency === undefined);
      const blockedDependency = dependencies.find((dependency) =>
        dependency?.status === "blocked");
      if (missingDependency || blockedDependency !== undefined) {
        changed = true;
        return {
          ...step,
          status: "blocked" as const,
          updatedAt: now,
          terminalReason: missingDependency
            ? "dependency_missing"
            : `dependency_blocked:${blockedDependency?.stepId ?? "unknown"}`,
        };
      }
      const nextStatus = dependencies.every((dependency) =>
        dependency?.status === "succeeded" || dependency?.status === "skipped")
        ? "ready" as const
        : "pending" as const;
      if (step.status === nextStatus) return step;
      changed = true;
      return { ...step, status: nextStatus, updatedAt: now };
    });
  }
  return steps;
}

function deriveRunState(
  steps: readonly WorkflowStepRecord[],
  activeFallback: "queued" | "running" | "retrying",
): {
  readonly status: WorkflowRunRecord["status"];
  readonly terminalReason?: string;
} {
  if (steps.length === 0) return { status: activeFallback };
  if (steps.every((step) => step.status === "succeeded" || step.status === "skipped")) {
    return { status: "succeeded" };
  }
  if (steps.some((step) => step.status === "running")) return { status: "running" };
  if (steps.some((step) => step.status === "failed")) return { status: "retrying" };
  if (steps.some((step) => step.status === "ready" || step.status === "pending")) {
    return { status: activeFallback };
  }
  const blocked = steps.find((step) => step.status === "blocked");
  return {
    status: "blocked",
    terminalReason: blocked?.terminalReason ?? "workflow_steps_blocked",
  };
}

function activateStep(
  step: WorkflowStepRecord,
  edgeKey: string | undefined,
  now: string,
): WorkflowStepRecord {
  const { terminalReason: _terminalReason, ...active } = step;
  return {
    ...active,
    status: "running",
    attemptsUsed: step.attemptsUsed + 1,
    edgeCalls: edgeKey === undefined
      ? step.edgeCalls
      : {
          ...step.edgeCalls,
          [edgeKey]: (step.edgeCalls[edgeKey] ?? 0) + 1,
        },
    updatedAt: now,
  };
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return resolved;
}
