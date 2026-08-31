import { createHash } from "node:crypto";
import type { AgentRunId } from "../core/ids";
import type { ChildAgentRuntime } from "../runtime/child-agents";
import type {
  PlanTask,
  TaskStatus,
  TaskStatusUpdate,
  TaskStore,
  TaskStoreSnapshot,
} from "../workspace/tasks";
import { isTerminalChildStatus } from "../workspace/child-agents";
import { fingerprintError } from "./fingerprints";
import type { WorkflowOrchestrator } from "./orchestrator";
import type {
  WorkflowAttemptRecord,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStepRecord,
} from "./types";

export interface TaskGraphParentResumeEvent {
  readonly workflowRunId: string;
  readonly graphVersion: number;
  readonly tasksDigest: string;
  readonly status: Extract<WorkflowRunStatus, "succeeded" | "blocked">;
  readonly terminalReason?: string;
}

export interface TaskGraphParentResumeBinding {
  acquireHold(input: {
    readonly workflowRunId: string;
    readonly graphVersion: number;
    readonly tasksDigest: string;
  }): { release(): void } | undefined;
  enqueue(event: TaskGraphParentResumeEvent): Promise<boolean> | boolean;
}

export interface TaskGraphSchedulerOptions {
  readonly taskStore: TaskStore;
  readonly workflows: WorkflowOrchestrator;
  readonly externalKeyPrefix: string;
  readonly createChildRuntime: (workflowRunId: AgentRunId) => ChildAgentRuntime;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly parentResume?: TaskGraphParentResumeBinding;
}

export interface TaskGraphSchedulingResult {
  readonly workflowRunId: string;
  readonly graphVersion: number;
  readonly startedTaskIds: readonly string[];
  readonly observedTaskIds: readonly string[];
  readonly status: WorkflowRunRecord["status"];
}

/**
 * Runtime-owned bridge from one approved TaskGraph to Workflow Step/Attempt and
 * durable child-agent runs. The scheduler is the sole execution-state writer.
 */
export class TaskGraphScheduler {
  private queue: Promise<void> = Promise.resolve();
  private readonly observedChildren = new Set<string>();
  private readonly parentHolds = new Map<string, { release(): void }>();

  constructor(private readonly options: TaskGraphSchedulerOptions) {}

  startFrozenGraph(
    snapshot?: TaskStoreSnapshot,
  ): Promise<TaskGraphSchedulingResult> {
    return this.enqueue(async () => {
      const graph = snapshot ?? await this.options.taskStore.read();
      if (graph.graphState !== "frozen" || !await this.isCurrentFrozenGraph(graph)) {
        throw schedulerError("conflict", "Task graph must be frozen before scheduling");
      }
      const run = await this.ensureWorkflow(graph);
      this.acquireParentHold(graph, run);
      try {
        const runtime = this.options.createChildRuntime(run.runId as AgentRunId);
        const observedTaskIds = await this.reconcileAttempts(graph, run, runtime);
        const startedTaskIds = await this.dispatchReady(graph, run, runtime);
        const current = await this.options.workflows.refreshGraph(run.runId);
        await this.syncTaskProjection(graph, current.steps);
        await this.resumeParentIfSettled(graph, current.run);
        return {
          workflowRunId: run.runId,
          graphVersion: graph.graphVersion,
          startedTaskIds,
          observedTaskIds,
          status: current.run.status,
        };
      } catch (error: unknown) {
        this.releaseParentHold(graph, run.runId);
        throw error;
      }
    });
  }

  resumeFrozenGraph(): Promise<TaskGraphSchedulingResult | undefined> {
    return this.options.taskStore.read().then((snapshot) =>
      snapshot.graphState === "frozen" && snapshot.tasks.length > 0
        ? this.startFrozenGraph(snapshot)
        : undefined);
  }

  waitForIdle(): Promise<void> {
    return this.queue;
  }

  private async ensureWorkflow(
    graph: TaskStoreSnapshot,
  ): Promise<WorkflowRunRecord> {
    const externalKey = [
      this.options.externalKeyPrefix,
      `v${graph.graphVersion}`,
      graph.tasksDigest,
    ].join(":");
    const run = await this.options.workflows.ensureRun({
      externalKey,
      kind: "task_graph",
      lifecycle: "detached",
      budget: {
        maxTotalAttempts: Math.max(4, graph.tasks.length * 4),
        maxAttemptsPerStep: 4,
        maxCallsPerEdge: 3,
      },
      metadata: {
        ...this.options.metadata,
        tasksPath: this.options.taskStore.filePath,
        graphVersion: String(graph.graphVersion),
        tasksDigest: graph.tasksDigest,
        ...(graph.planDigest === undefined ? {} : { planDigest: graph.planDigest }),
      },
      versions: {
        workflowVersion: `task-graph-v${graph.graphVersion}`,
      },
    });
    for (const task of graph.tasks) {
      await this.options.workflows.ensureStep({
        runId: run.runId,
        stepId: task.id,
        kind: "child_agent_task",
        dependencies: task.dependencies,
        ...(task.status === "completed" ? { initialStatus: "succeeded" } : {}),
      });
    }
    return (await this.options.workflows.refreshGraph(run.runId)).run;
  }

  private async reconcileAttempts(
    graph: TaskStoreSnapshot,
    run: WorkflowRunRecord,
    runtime: ChildAgentRuntime,
  ): Promise<readonly string[]> {
    const tasks = new Map(graph.tasks.map((task) => [task.id, task]));
    const attempts = await this.options.workflows.store.readAttempts(run.runId);
    const observed: string[] = [];
    for (const attempt of attempts) {
      if (attempt.status !== "running" && attempt.status !== "interrupted") continue;
      const task = tasks.get(attempt.stepId);
      if (task === undefined) continue;
      if (attempt.execution === undefined) {
        await this.spawnForAttempt(graph, run, task, attempt, runtime);
        observed.push(task.id);
        continue;
      }
      const collected = await runtime.collectAgent(
        attempt.execution.childRunId as AgentRunId,
      );
      if (isTerminalChildStatus(collected.run.status)) {
        await this.handleTerminal(graph, run, task, attempt, runtime, collected.run);
      } else {
        this.observeTerminal(graph, run, task, attempt, runtime);
      }
      observed.push(task.id);
    }
    return observed;
  }

  private async dispatchReady(
    graph: TaskStoreSnapshot,
    run: WorkflowRunRecord,
    runtime: ChildAgentRuntime,
  ): Promise<readonly string[]> {
    if (await this.supersedeIfStale(graph, run)) return [];
    const state = await this.options.workflows.refreshGraph(run.runId);
    let slots = await runtime.availableSlots();
    const byId = new Map(graph.tasks.map((task) => [task.id, task]));
    const started: string[] = [];
    for (const step of state.ready) {
      if (slots <= 0) break;
      if (await this.supersedeIfStale(graph, run)) break;
      const task = byId.get(step.stepId);
      if (task === undefined) continue;
      const admission = await this.options.workflows.beginAttempt({
        runId: run.runId,
        stepId: step.stepId,
        strategy: taskStrategy(graph, task),
        circuitKey: taskCircuitKey(this.options.externalKeyPrefix, task),
      });
      if (!admission.allowed || admission.attempt === undefined) continue;
      await this.spawnForAttempt(graph, run, task, admission.attempt, runtime);
      started.push(task.id);
      slots -= 1;
    }
    return started;
  }

  private async spawnForAttempt(
    graph: TaskStoreSnapshot,
    run: WorkflowRunRecord,
    task: PlanTask,
    attempt: WorkflowAttemptRecord,
    runtime: ChildAgentRuntime,
  ): Promise<void> {
    try {
      if (await this.supersedeIfStale(graph, run)) return;
      const child = await runtime.spawnAgent({
        role: task.execution.role,
        task: renderChildTask(graph, task),
        readOnly: task.execution.readOnly,
        externalKey: attempt.idempotencyPrefix,
        ...optionalNumber("timeoutMs", task.execution.timeoutMs),
        ...optionalNumber("maxToolCalls", task.execution.maxToolCalls),
        ...optionalNumber("maxTokens", task.execution.maxTokens),
      });
      const bound = await this.options.workflows.bindAttemptChild({
        runId: run.runId,
        attemptId: attempt.attemptId,
        externalKey: attempt.idempotencyPrefix,
        childRunId: child.childRunId,
      });
      await this.options.workflows.store.appendEvent({
        runId: run.runId,
        stepId: task.id,
        attemptId: attempt.attemptId,
        type: "task.child_started",
        payload: {
          childRunId: child.childRunId,
          role: child.role,
          readOnly: child.readOnly,
        },
      });
      await this.syncTaskProjection(
        graph,
        await this.options.workflows.store.readSteps(run.runId),
      );
      if (isTerminalChildStatus(child.status)) {
        await this.handleTerminal(graph, run, task, bound, runtime, child);
      } else {
        this.observeTerminal(graph, run, task, bound, runtime);
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorFingerprint = fingerprintError({
        stepKind: "child_agent_spawn",
        errorCode: error instanceof Error ? error.name : "unknown",
        message: errorMessage,
      });
      await this.options.workflows.finishAttempt({
        runId: run.runId,
        attemptId: attempt.attemptId,
        success: false,
        resultErrorFingerprint: errorFingerprint,
        summary: `Child dispatch failed: ${errorMessage}`,
      });
      await this.retryMechanicalFailure(graph, run, task, runtime, errorFingerprint);
    }
  }

  private observeTerminal(
    graph: TaskStoreSnapshot,
    run: WorkflowRunRecord,
    task: PlanTask,
    attempt: WorkflowAttemptRecord,
    runtime: ChildAgentRuntime,
  ): void {
    const childRunId = attempt.execution?.childRunId;
    if (childRunId === undefined || this.observedChildren.has(childRunId)) return;
    this.observedChildren.add(childRunId);
    void runtime.waitForTerminal(childRunId as AgentRunId).then((terminal) =>
      this.enqueue(async () => {
        this.observedChildren.delete(childRunId);
        await this.handleTerminal(graph, run, task, attempt, runtime, terminal);
      })).catch(async (error: unknown) => {
        this.observedChildren.delete(childRunId);
        await this.options.workflows.store.appendEvent({
          runId: run.runId,
          stepId: task.id,
          attemptId: attempt.attemptId,
          type: "task.child_observer_failed",
          payload: { error: error instanceof Error ? error.message : String(error) },
        }).catch(() => undefined);
      });
  }

  private async handleTerminal(
    graph: TaskStoreSnapshot,
    run: WorkflowRunRecord,
    task: PlanTask,
    attempt: WorkflowAttemptRecord,
    runtime: ChildAgentRuntime,
    terminal: { readonly status: string; readonly childRunId: AgentRunId },
  ): Promise<void> {
    const persistedAttempt = (await this.options.workflows.store.readAttempts(run.runId))
      .find((candidate) => candidate.attemptId === attempt.attemptId);
    if (
      persistedAttempt === undefined ||
      persistedAttempt.status === "succeeded" ||
      persistedAttempt.status === "failed" ||
      persistedAttempt.status === "cancelled"
    ) {
      return;
    }
    const collected = await runtime.collectAgent(terminal.childRunId);
    const success = terminal.status === "completed";
    const summary = truncate(
      collected.result?.trim() ||
        `${task.id} child ended with ${terminal.status}${collected.run.stopReason === undefined
          ? ""
          : `: ${collected.run.stopReason}`}`,
      4000,
    );
    const errorFingerprint = success
      ? undefined
      : fingerprintError({
          stepKind: "child_agent_task",
          errorCode: terminal.status,
          message: collected.run.stopReason ?? terminal.status,
        });
    await this.options.workflows.store.appendEvent({
      runId: run.runId,
      stepId: task.id,
      attemptId: attempt.attemptId,
      type: "task.child_terminal",
      payload: {
        childRunId: terminal.childRunId,
        status: terminal.status,
        resultSummary: summary,
        usage: collected.usage as Readonly<Record<string, unknown>>,
      },
    });
    await this.options.workflows.finishAttempt({
      runId: run.runId,
      attemptId: attempt.attemptId,
      success,
      ...(errorFingerprint === undefined ? {} : { resultErrorFingerprint: errorFingerprint }),
      summary,
    });
    const current = await this.options.workflows.refreshGraph(run.runId);
    await this.syncTaskProjection(graph, current.steps, task.id, summary);
    if (await this.supersedeIfStale(graph, run)) return;
    await this.resumeParentIfSettled(graph, current.run);
    if (isSettledTaskGraphStatus(current.run.status)) return;
    if (!success && errorFingerprint !== undefined && current.run.status === "retrying") {
      await this.retryMechanicalFailure(graph, run, task, runtime, errorFingerprint);
      return;
    }
    await this.dispatchReady(graph, run, runtime);
  }

  private async retryMechanicalFailure(
    graph: TaskStoreSnapshot,
    run: WorkflowRunRecord,
    task: PlanTask,
    runtime: ChildAgentRuntime,
    triggerErrorFingerprint: string,
  ): Promise<void> {
    if (await this.supersedeIfStale(graph, run)) return;
    const currentRun = await this.options.workflows.store.readRun(run.runId);
    if (currentRun.status !== "retrying" && currentRun.status !== "interrupted") return;
    const admission = await this.options.workflows.beginAttempt({
      runId: run.runId,
      stepId: task.id,
      strategy: taskStrategy(graph, task),
      triggerErrorFingerprint,
      edgeKey: `${task.id}.mechanical_retry`,
      circuitKey: taskCircuitKey(this.options.externalKeyPrefix, task),
      allowDuplicateStrategy: true,
    });
    if (!admission.allowed || admission.attempt === undefined) {
      const current = await this.options.workflows.refreshGraph(run.runId);
      await this.syncTaskProjection(graph, current.steps);
      await this.resumeParentIfSettled(graph, current.run);
      return;
    }
    await this.spawnForAttempt(graph, run, task, admission.attempt, runtime);
  }

  private async syncTaskProjection(
    graph: TaskStoreSnapshot,
    steps: readonly WorkflowStepRecord[],
    completedTaskId?: string,
    result?: string,
  ): Promise<void> {
    const currentGraph = await this.options.taskStore.read();
    if (
      currentGraph.graphState !== "frozen" ||
      currentGraph.graphVersion !== graph.graphVersion ||
      currentGraph.tasksDigest !== graph.tasksDigest
    ) {
      return;
    }
    const byTask = new Map(graph.tasks.map((task) => [task.id, task]));
    const updates: Record<string, TaskStatusUpdate> = {};
    for (const step of steps) {
      if (!byTask.has(step.stepId)) continue;
      updates[step.stepId] = {
        id: step.stepId,
        status: taskStatusForStep(step),
        attempts: step.attemptsUsed,
        notes: `workflow:${step.runId} step:${step.stepId}`,
        ...(step.status === "failed" || step.status === "blocked"
          ? optionalString(
              "error",
              step.terminalReason ??
                (completedTaskId === step.stepId ? result : undefined),
            )
          : {}),
        ...(completedTaskId === step.stepId && result !== undefined ? { result } : {}),
      };
    }
    await this.options.taskStore.syncExecutionState(updates, {
      graphVersion: graph.graphVersion,
      tasksDigest: graph.tasksDigest,
    });
  }

  private async isCurrentFrozenGraph(graph: TaskStoreSnapshot): Promise<boolean> {
    const current = await this.options.taskStore.read();
    return current.graphState === "frozen" &&
      current.graphVersion === graph.graphVersion &&
      current.tasksDigest === graph.tasksDigest;
  }

  private async supersedeIfStale(
    graph: TaskStoreSnapshot,
    run: WorkflowRunRecord,
  ): Promise<boolean> {
    if (await this.isCurrentFrozenGraph(graph)) return false;
    const currentRun = await this.options.workflows.store.readRun(run.runId);
    if (currentRun.status !== "cancelled" && currentRun.status !== "succeeded") {
      await this.options.workflows.cancelRun(
        run.runId,
        `task_graph_superseded:v${graph.graphVersion}`,
      );
    }
    this.releaseParentHold(graph, run.runId);
    return true;
  }

  private acquireParentHold(
    graph: TaskStoreSnapshot,
    run: WorkflowRunRecord,
  ): void {
    if (
      this.options.parentResume === undefined ||
      isSettledTaskGraphStatus(run.status)
    ) {
      return;
    }
    const key = parentHoldKey(graph, run.runId);
    if (this.parentHolds.has(key)) return;
    const hold = this.options.parentResume.acquireHold({
      workflowRunId: run.runId,
      graphVersion: graph.graphVersion,
      tasksDigest: graph.tasksDigest,
    });
    if (hold !== undefined) {
      this.parentHolds.set(key, hold);
    }
  }

  private async resumeParentIfSettled(
    graph: TaskStoreSnapshot,
    run: WorkflowRunRecord,
  ): Promise<void> {
    if (!isSettledTaskGraphStatus(run.status)) return;
    const key = parentHoldKey(graph, run.runId);
    const hold = this.parentHolds.get(key);
    if (hold === undefined) return;
    this.parentHolds.delete(key);
    let accepted = false;
    let errorMessage: string | undefined;
    try {
      accepted = await this.options.parentResume?.enqueue({
        workflowRunId: run.runId,
        graphVersion: graph.graphVersion,
        tasksDigest: graph.tasksDigest,
        status: run.status,
        ...(run.terminalReason === undefined
          ? {}
          : { terminalReason: run.terminalReason }),
      }) ?? false;
    } catch (error: unknown) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      hold.release();
    }
    await this.options.workflows.store.appendEvent({
      runId: run.runId,
      type: "task.parent_resume_requested",
      payload: {
        accepted,
        graphVersion: graph.graphVersion,
        tasksDigest: graph.tasksDigest,
        status: run.status,
        ...(errorMessage === undefined ? {} : { error: errorMessage }),
      },
    });
  }

  private releaseParentHold(
    graph: TaskStoreSnapshot,
    runId: string,
  ): void {
    const key = parentHoldKey(graph, runId);
    const hold = this.parentHolds.get(key);
    if (hold === undefined) return;
    this.parentHolds.delete(key);
    hold.release();
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

function taskStrategy(
  graph: TaskStoreSnapshot,
  task: PlanTask,
): Readonly<Record<string, unknown>> {
  return {
    type: "execute_frozen_task",
    graphVersion: graph.graphVersion,
    tasksDigest: graph.tasksDigest,
    taskId: task.id,
    role: task.execution.role,
    readOnly: task.execution.readOnly,
  };
}

function taskCircuitKey(prefix: string, task: PlanTask): string {
  const scope = createHash("sha256").update(prefix).digest("hex").slice(0, 16);
  return [
    "task-graph-child",
    scope,
    task.execution.role,
    task.execution.readOnly ? "read-only" : "write",
  ].join(":");
}

function parentHoldKey(graph: TaskStoreSnapshot, runId: string): string {
  return `${runId}:v${graph.graphVersion}:${graph.tasksDigest}`;
}

function isSettledTaskGraphStatus(
  status: WorkflowRunStatus,
): status is Extract<WorkflowRunStatus, "succeeded" | "blocked"> {
  return status === "succeeded" || status === "blocked";
}

function renderChildTask(graph: TaskStoreSnapshot, task: PlanTask): string {
  return [
    `Execute frozen TaskGraph v${graph.graphVersion} task ${task.id}.`,
    `Title: ${task.title}`,
    ...(task.description === undefined ? [] : [`Description: ${task.description}`]),
    `Dependencies: ${task.dependencies.length === 0 ? "none" : task.dependencies.join(", ")}`,
    `TaskGraph digest: ${graph.tasksDigest}`,
    "Stay within this task. Report a concise outcome and concrete evidence in result.md.",
  ].join("\n");
}

function taskStatusForStep(step: WorkflowStepRecord): TaskStatus {
  if (step.status === "running") return "in_progress";
  if (step.status === "succeeded" || step.status === "skipped") return "completed";
  if (step.status === "failed") return "failed";
  if (step.status === "blocked") return "blocked";
  return "pending";
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 15)}...[truncated]`;
}

function optionalNumber<Key extends string>(
  key: Key,
  value: number | undefined,
): { readonly [Property in Key]: number } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: number;
  };
}

function optionalString<Key extends string>(
  key: Key,
  value: string | undefined,
): { readonly [Property in Key]: string } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: string;
  };
}

function schedulerError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

export function taskGraphExternalKeyPrefix(input: {
  readonly workspaceRoot: string;
  readonly conversationKey: string;
}): string {
  const workspaceHash = createHash("sha256")
    .update(input.workspaceRoot)
    .digest("hex")
    .slice(0, 16);
  return `task-graph:${input.conversationKey}:${workspaceHash}`;
}

export function formatTaskGraphParentResume(
  event: TaskGraphParentResumeEvent,
): string {
  return [
    "[Runtime TaskGraph completion event]",
    `Frozen TaskGraph v${event.graphVersion} (${event.tasksDigest}) is ${event.status}.`,
    ...(event.terminalReason === undefined
      ? []
      : [`Terminal reason: ${event.terminalReason}`]),
    "This is a runtime-generated follow-up, not a new user instruction.",
    "Inspect the current World State and terminal task results. If the graph succeeded, integrate the evidence and report the outcome. If it is blocked, explain the failure and enter Plan Mode before proposing a revised tasks.json version. Do not manually mutate frozen task execution state.",
  ].join("\n");
}
