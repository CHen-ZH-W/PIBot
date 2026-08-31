import { createHash } from "node:crypto";
import type { AgentRunId, ToolCallId } from "../core/ids";
import {
  type ChildAgentRuntime,
  type SpawnChildAgentRequest,
} from "../runtime/child-agents";
import type {
  ChildAgentRunRecord,
  ChildAgentStatus,
} from "../workspace/child-agents";
import { fingerprintError } from "./fingerprints";
import type { WorkflowOrchestrator } from "./orchestrator";
import type {
  WorkflowAttemptRecord,
  WorkflowRunRecord,
} from "./types";

const CHILD_STEP_ID = "child";

export interface ChildWorkflowParentResumeEvent {
  readonly workflowRunId: string;
  readonly childRunId?: AgentRunId;
  readonly parentAgentRunId: AgentRunId;
  readonly status: "completed" | "blocked";
  readonly childStatus?: ChildAgentStatus;
  readonly role: SpawnChildAgentRequest["role"];
  readonly task: string;
  readonly resultSummary: string;
  readonly attempts: number;
  readonly terminalReason?: string;
}

export interface ChildWorkflowParentResumeBinding {
  acquireHold(input: {
    readonly workflowRunId: string;
    readonly parentAgentRunId: AgentRunId;
  }): { release(): void } | undefined;
  enqueue(event: ChildWorkflowParentResumeEvent): Promise<boolean> | boolean;
}

export interface ChildWorkflowSchedulerOptions {
  readonly workflows: WorkflowOrchestrator;
  readonly childAgents: ChildAgentRuntime;
  readonly parentAgentRunId: AgentRunId;
  readonly externalKeyPrefix: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly parentResume?: ChildWorkflowParentResumeBinding;
}

export interface ScheduledChildSpawnRequest extends SpawnChildAgentRequest {
  readonly toolCallId: ToolCallId;
}

/**
 * Routes model-requested child runs through WorkflowOrchestrator. Each tool call
 * owns one durable workflow whose child Step may consume several bounded
 * Attempts before the Parent receives a terminal completion event.
 */
export class ChildWorkflowScheduler {
  private queue: Promise<void> = Promise.resolve();
  private readonly observedChildren = new Set<string>();
  private readonly parentHolds = new Map<string, { release(): void }>();

  constructor(private readonly options: ChildWorkflowSchedulerOptions) {}

  spawnAgent(request: ScheduledChildSpawnRequest): Promise<ChildAgentRunRecord> {
    return this.enqueue(async () => {
      const run = await this.ensureWorkflow(request);
      await this.options.workflows.ensureStep({
        runId: run.runId,
        stepId: CHILD_STEP_ID,
        kind: "child_agent_task",
      });
      this.acquireParentHold(run);

      const existing = await this.reconcileExisting(run, request);
      if (existing !== undefined) return existing;

      const admission = await this.options.workflows.beginAttempt({
        runId: run.runId,
        stepId: CHILD_STEP_ID,
        strategy: childStrategy(request),
        circuitKey: childCircuitKey(this.options.externalKeyPrefix, request),
      });
      if (!admission.allowed || admission.attempt === undefined) {
        await this.notifyBlocked(
          run,
          request,
          admission.reason ?? "workflow_attempt_rejected",
        );
        throw schedulerError(
          "conflict",
          `Child workflow attempt rejected: ${admission.reason ?? "unknown"}`,
        );
      }
      return this.spawnForAttempt(run, request, admission.attempt);
    });
  }

  async cancelChild(childRunId: AgentRunId, reason: string): Promise<void> {
    const binding = await this.findWorkflowByChild(childRunId);
    if (binding === undefined) return;
    await this.options.workflows.cancelRun(binding.run.runId, reason);
  }

  waitForIdle(): Promise<void> {
    return this.queue;
  }

  private async ensureWorkflow(
    request: ScheduledChildSpawnRequest,
  ): Promise<WorkflowRunRecord> {
    return this.options.workflows.ensureRun({
      externalKey: [
        this.options.externalKeyPrefix,
        this.options.parentAgentRunId,
        request.toolCallId,
      ].join(":"),
      kind: "coordinator_child",
      lifecycle: "detached",
      metadata: {
        ...this.options.metadata,
        parentAgentRunId: this.options.parentAgentRunId,
        toolCallId: request.toolCallId,
        role: request.role,
        readOnly: String(request.readOnly ?? false),
      },
    });
  }

  private async reconcileExisting(
    run: WorkflowRunRecord,
    request: ScheduledChildSpawnRequest,
  ): Promise<ChildAgentRunRecord | undefined> {
    const attempts = await this.options.workflows.store.readAttempts(run.runId);
    const latest = attempts.at(-1);
    if (latest?.execution !== undefined) {
      const collected = await this.options.childAgents.collectAgent(
        latest.execution.childRunId as AgentRunId,
      );
      if (isTerminalChildStatus(collected.run.status)) {
        await this.handleTerminal(run, request, latest, collected.run);
      } else {
        this.observeTerminal(run, request, latest);
      }
      return collected.run;
    }
    if (latest?.status === "running" || latest?.status === "interrupted") {
      return this.spawnForAttempt(run, request, latest);
    }
    if (run.status === "succeeded" || run.status === "blocked") {
      this.releaseParentHold(run.runId);
    }
    return undefined;
  }

  private async spawnForAttempt(
    run: WorkflowRunRecord,
    request: ScheduledChildSpawnRequest,
    attempt: WorkflowAttemptRecord,
  ): Promise<ChildAgentRunRecord> {
    try {
      const child = await this.options.childAgents.spawnAgent({
        role: request.role,
        task: request.task,
        ...(request.readOnly === undefined ? {} : { readOnly: request.readOnly }),
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        ...(request.maxToolCalls === undefined
          ? {}
          : { maxToolCalls: request.maxToolCalls }),
        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
        ...(request.worktreePath === undefined
          ? {}
          : { worktreePath: request.worktreePath }),
        externalKey: attempt.idempotencyPrefix,
      });
      const bound = await this.options.workflows.bindAttemptChild({
        runId: run.runId,
        attemptId: attempt.attemptId,
        externalKey: attempt.idempotencyPrefix,
        childRunId: child.childRunId,
      });
      await this.options.workflows.store.appendEvent({
        runId: run.runId,
        stepId: CHILD_STEP_ID,
        attemptId: attempt.attemptId,
        type: "coordinator.child_started",
        payload: {
          childRunId: child.childRunId,
          parentAgentRunId: this.options.parentAgentRunId,
          role: child.role,
          readOnly: child.readOnly,
        },
      });
      if (isTerminalChildStatus(child.status)) {
        await this.handleTerminal(run, request, bound, child);
      } else {
        this.observeTerminal(run, request, bound);
      }
      return child;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const fingerprint = fingerprintError({
        stepKind: "coordinator_child_spawn",
        errorCode: error instanceof Error ? error.name : "unknown",
        message,
      });
      await this.options.workflows.finishAttempt({
        runId: run.runId,
        attemptId: attempt.attemptId,
        success: false,
        resultErrorFingerprint: fingerprint,
        summary: `Child dispatch failed: ${message}`,
      });
      const retry = await this.retryMechanicalFailure(run, request, fingerprint);
      if (retry !== undefined) return retry;
      throw schedulerError("child_spawn_failed", message);
    }
  }

  private observeTerminal(
    run: WorkflowRunRecord,
    request: ScheduledChildSpawnRequest,
    attempt: WorkflowAttemptRecord,
  ): void {
    const childRunId = attempt.execution?.childRunId;
    if (childRunId === undefined || this.observedChildren.has(childRunId)) return;
    this.observedChildren.add(childRunId);
    void this.options.childAgents.waitForTerminal(childRunId as AgentRunId)
      .then((terminal) => this.enqueue(async () => {
        this.observedChildren.delete(childRunId);
        await this.handleTerminal(run, request, attempt, terminal);
      }))
      .catch((error: unknown) => this.enqueue(async () => {
        this.observedChildren.delete(childRunId);
        const message = error instanceof Error ? error.message : String(error);
        const fingerprint = fingerprintError({
          stepKind: "coordinator_child_observer",
          errorCode: error instanceof Error ? error.name : "unknown",
          message,
        });
        await this.options.workflows.store.appendEvent({
          runId: run.runId,
          stepId: CHILD_STEP_ID,
          attemptId: attempt.attemptId,
          type: "coordinator.child_observer_failed",
          payload: { error: message },
        });
        await this.options.workflows.finishAttempt({
          runId: run.runId,
          attemptId: attempt.attemptId,
          success: false,
          resultErrorFingerprint: fingerprint,
          summary: message,
        });
        await this.retryMechanicalFailure(run, request, fingerprint);
      }));
  }

  private async handleTerminal(
    run: WorkflowRunRecord,
    request: ScheduledChildSpawnRequest,
    attempt: WorkflowAttemptRecord,
    terminal: ChildAgentRunRecord,
  ): Promise<void> {
    const persistedRun = await this.options.workflows.store.readRun(run.runId);
    const persistedAttempt = (await this.options.workflows.store.readAttempts(run.runId))
      .find((candidate) => candidate.attemptId === attempt.attemptId);
    if (persistedRun.status === "cancelled" || persistedAttempt?.status === "cancelled") {
      this.releaseParentHold(run.runId);
      return;
    }
    if (
      persistedAttempt === undefined ||
      persistedAttempt.status === "succeeded" ||
      persistedAttempt.status === "failed"
    ) {
      return;
    }

    const collected = await this.options.childAgents.collectAgent(terminal.childRunId);
    const success = collected.run.status === "completed";
    const summary = truncate(
      collected.result?.trim() ||
        `Child ${collected.run.childRunId} ended with ${collected.run.status}${
          collected.run.stopReason === undefined ? "" : `: ${collected.run.stopReason}`
        }`,
      4000,
    );
    const errorFingerprint = success
      ? undefined
      : fingerprintError({
          stepKind: "coordinator_child",
          errorCode: collected.run.status,
          message: collected.run.stopReason ?? collected.run.status,
        });
    await this.options.workflows.store.appendEvent({
      runId: run.runId,
      stepId: CHILD_STEP_ID,
      attemptId: attempt.attemptId,
      type: "coordinator.child_terminal",
      payload: {
        childRunId: collected.run.childRunId,
        status: collected.run.status,
        resultSummary: summary,
        usage: collected.usage as Readonly<Record<string, unknown>>,
      },
    });
    await this.options.workflows.finishAttempt({
      runId: run.runId,
      attemptId: attempt.attemptId,
      success,
      ...(errorFingerprint === undefined
        ? {}
        : { resultErrorFingerprint: errorFingerprint }),
      summary,
    });
    const current = await this.options.workflows.store.readRun(run.runId);
    if (success) {
      await this.notifyParent(run, request, {
        child: collected.run,
        status: "completed",
        summary,
        attempts: current.attemptsUsed,
      });
      return;
    }
    if (errorFingerprint !== undefined && current.status === "retrying") {
      await this.retryMechanicalFailure(run, request, errorFingerprint);
      return;
    }
    await this.notifyBlocked(
      current,
      request,
      current.terminalReason ?? summary,
      collected.run,
      summary,
    );
  }

  private async retryMechanicalFailure(
    run: WorkflowRunRecord,
    request: ScheduledChildSpawnRequest,
    triggerErrorFingerprint: string,
  ): Promise<ChildAgentRunRecord | undefined> {
    const current = await this.options.workflows.store.readRun(run.runId);
    if (current.status === "cancelled") {
      this.releaseParentHold(run.runId);
      return undefined;
    }
    if (current.status !== "retrying" && current.status !== "interrupted") {
      await this.notifyBlocked(
        current,
        request,
        current.terminalReason ?? "workflow_not_retryable",
      );
      return undefined;
    }
    const admission = await this.options.workflows.beginAttempt({
      runId: run.runId,
      stepId: CHILD_STEP_ID,
      strategy: childStrategy(request),
      triggerErrorFingerprint,
      edgeKey: "child.mechanical_retry",
      circuitKey: childCircuitKey(this.options.externalKeyPrefix, request),
      allowDuplicateStrategy: true,
    });
    if (!admission.allowed || admission.attempt === undefined) {
      const blocked = await this.options.workflows.store.readRun(run.runId);
      await this.notifyBlocked(
        blocked,
        request,
        admission.reason ?? blocked.terminalReason ?? "retry_rejected",
      );
      return undefined;
    }
    return this.spawnForAttempt(run, request, admission.attempt);
  }

  private async notifyBlocked(
    run: WorkflowRunRecord,
    request: ScheduledChildSpawnRequest,
    reason: string,
    child?: ChildAgentRunRecord,
    summary = reason,
  ): Promise<void> {
    await this.notifyParent(run, request, {
      ...(child === undefined ? {} : { child }),
      status: "blocked",
      summary,
      attempts: run.attemptsUsed,
      terminalReason: reason,
    });
  }

  private async notifyParent(
    run: WorkflowRunRecord,
    request: ScheduledChildSpawnRequest,
    result: {
      readonly child?: ChildAgentRunRecord;
      readonly status: "completed" | "blocked";
      readonly summary: string;
      readonly attempts: number;
      readonly terminalReason?: string;
    },
  ): Promise<void> {
    const hold = this.parentHolds.get(run.runId);
    if (hold === undefined) return;
    this.parentHolds.delete(run.runId);
    let accepted = false;
    let errorMessage: string | undefined;
    try {
      accepted = await this.options.parentResume?.enqueue({
        workflowRunId: run.runId,
        ...(result.child === undefined
          ? {}
          : {
              childRunId: result.child.childRunId,
              childStatus: result.child.status,
            }),
        parentAgentRunId: this.options.parentAgentRunId,
        status: result.status,
        role: request.role,
        task: request.task,
        resultSummary: result.summary,
        attempts: result.attempts,
        ...(result.terminalReason === undefined
          ? {}
          : { terminalReason: result.terminalReason }),
      }) ?? false;
    } catch (error: unknown) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      hold.release();
    }
    await this.options.workflows.store.appendEvent({
      runId: run.runId,
      stepId: CHILD_STEP_ID,
      type: "coordinator.parent_resume_requested",
      payload: {
        accepted,
        status: result.status,
        ...(result.child === undefined
          ? {}
          : { childRunId: result.child.childRunId }),
        ...(errorMessage === undefined ? {} : { error: errorMessage }),
      },
    });
  }

  private acquireParentHold(run: WorkflowRunRecord): void {
    if (
      this.options.parentResume === undefined ||
      run.status === "succeeded" ||
      run.status === "blocked" ||
      run.status === "cancelled" ||
      this.parentHolds.has(run.runId)
    ) {
      return;
    }
    const hold = this.options.parentResume.acquireHold({
      workflowRunId: run.runId,
      parentAgentRunId: this.options.parentAgentRunId,
    });
    if (hold !== undefined) this.parentHolds.set(run.runId, hold);
  }

  private releaseParentHold(runId: string): void {
    const hold = this.parentHolds.get(runId);
    if (hold === undefined) return;
    this.parentHolds.delete(runId);
    hold.release();
  }

  private async findWorkflowByChild(
    childRunId: AgentRunId,
  ): Promise<{ readonly run: WorkflowRunRecord } | undefined> {
    for (const run of await this.options.workflows.store.listRuns()) {
      if (
        run.kind !== "coordinator_child" ||
        run.metadata.parentAgentRunId !== this.options.parentAgentRunId
      ) {
        continue;
      }
      const matched = (await this.options.workflows.store.readAttempts(run.runId))
        .some((attempt) => attempt.execution?.childRunId === childRunId);
      if (matched) return { run };
    }
    return undefined;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

function childStrategy(
  request: ScheduledChildSpawnRequest,
): Readonly<Record<string, unknown>> {
  return {
    type: "execute_coordinator_child",
    role: request.role,
    task: request.task,
    readOnly: request.readOnly ?? false,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.maxToolCalls === undefined
      ? {}
      : { maxToolCalls: request.maxToolCalls }),
    ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    ...(request.worktreePath === undefined
      ? {}
      : { worktreePath: request.worktreePath }),
  };
}

function childCircuitKey(
  prefix: string,
  request: ScheduledChildSpawnRequest,
): string {
  const scope = createHash("sha256").update(prefix).digest("hex").slice(0, 16);
  return [
    "coordinator-child",
    scope,
    request.role,
    request.readOnly === true ? "read-only" : "write",
  ].join(":");
}

function isTerminalChildStatus(status: ChildAgentStatus): boolean {
  return status === "completed" ||
    status === "failed" ||
    status === "stopped" ||
    status === "timeout";
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars - 15)}...[truncated]`;
}

function schedulerError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

export function childWorkflowExternalKeyPrefix(input: {
  readonly workspaceRoot: string;
  readonly conversationKey: string;
}): string {
  const workspaceHash = createHash("sha256")
    .update(input.workspaceRoot)
    .digest("hex")
    .slice(0, 16);
  return `coordinator-child:${input.conversationKey}:${workspaceHash}`;
}

export function formatChildWorkflowParentResume(
  event: ChildWorkflowParentResumeEvent,
): string {
  return [
    "[Runtime child completion event]",
    `Child workflow ${event.workflowRunId} is ${event.status}.`,
    ...(event.childRunId === undefined ? [] : [`Child run: ${event.childRunId}.`]),
    ...(event.childStatus === undefined ? [] : [`Child status: ${event.childStatus}.`]),
    `Role: ${event.role}. Attempts: ${event.attempts}.`,
    `Task: ${truncate(event.task, 1000)}`,
    `Result: ${truncate(event.resultSummary, 4000)}`,
    ...(event.terminalReason === undefined
      ? []
      : [`Terminal reason: ${event.terminalReason}`]),
    "This is a runtime-generated event, not a new user instruction. Continue the same coordination run using this result; do not call agent_collect for this completed child.",
  ].join("\n");
}
