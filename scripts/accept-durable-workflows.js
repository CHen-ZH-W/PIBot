const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { FileWorkflowStore } = require("../dist/workflow/store");
const { WorkflowOrchestrator } = require("../dist/workflow/orchestrator");
const { ChildWorkflowScheduler } = require("../dist/workflow/child-scheduler");
const { TaskGraphScheduler } = require("../dist/workflow/task-scheduler");
const {
  createCodingToolExecutor,
  createToolApprovalGate,
} = require("../dist/tools");
const { FileWebConversationStore } = require("../dist/web/conversations");
const { startWebUiServer } = require("../dist/web/server");
const { FileTaskStore } = require("../dist/workspace/tasks");
const { createAgentRunContext } = require("../dist/runtime/context");
const { AgentRunController } = require("../dist/runtime/run-controller");

async function runAcceptance() {
  await runCase(
    "workflow persists attempts and blocks duplicate error plus strategy",
    acceptsPersistentDuplicateGuard,
  );
  await runCase(
    "workflow enforces edge budgets and global circuit breaker",
    acceptsBudgetsAndCircuitBreaker,
  );
  await runCase(
    "workflow DAG unlocks dependents only after every dependency succeeds",
    acceptsWorkflowDagUnlock,
  );
  await runCase(
    "frozen TaskGraph dispatches ready children and consumes terminal events",
    acceptsFrozenTaskGraphScheduling,
  );
  await runCase(
    "replanning supersedes the old graph before it can dispatch dependents",
    acceptsTaskGraphSupersession,
  );
  await runCase(
    "scheduler retries mechanical child failures inside workflow budgets",
    acceptsTaskGraphMechanicalRetry,
  );
  await runCase(
    "blocked TaskGraph resumes parent after retry policy settles",
    acceptsBlockedTaskGraphParentResume,
  );
  await runCase(
    "Coordinator child tools use Workflow attempts and resume Parent on terminal events",
    acceptsCoordinatorChildWorkflow,
  );
  await runCase(
    "intentional Coordinator child stop cancels Workflow without retry",
    acceptsCoordinatorChildCancellation,
  );
  await runCase(
    "Coordinator child completion starts a new UserTurn in the same Parent Run",
    acceptsCoordinatorChildSameRunResume,
  );
  await runCase(
    "detached HTTP run survives subscriber disconnect and replays SSE events",
    acceptsDetachedRunReplay,
  );
  console.log("Durable workflow acceptance passed");
}

async function acceptsWorkflowDagUnlock() {
  const root = await mkdtemp(join(tmpdir(), "pibot-workflow-dag-"));
  try {
    const store = new FileWorkflowStore({ rootDir: root });
    const workflows = new WorkflowOrchestrator({ store });
    const run = await workflows.ensureRun({
      externalKey: "task-graph:v1",
      kind: "task_graph",
      lifecycle: "detached",
    });
    await workflows.ensureStep({ runId: run.runId, stepId: "a", kind: "task" });
    await workflows.ensureStep({ runId: run.runId, stepId: "b", kind: "task" });
    await workflows.ensureStep({
      runId: run.runId,
      stepId: "c",
      kind: "task",
      dependencies: ["a", "b"],
    });

    let graph = await workflows.refreshGraph(run.runId);
    assert.deepEqual(graph.ready.map((step) => step.stepId).sort(), ["a", "b"]);
    assert.equal(graph.steps.find((step) => step.stepId === "c").status, "pending");
    const premature = await workflows.beginAttempt({
      runId: run.runId,
      stepId: "c",
      strategy: { type: "premature" },
    });
    assert.equal(premature.allowed, false);
    assert.equal(premature.reason, "step_dependencies_unmet:a,b");

    const attemptA = await workflows.beginAttempt({
      runId: run.runId,
      stepId: "a",
      strategy: { type: "execute" },
    });
    const attemptB = await workflows.beginAttempt({
      runId: run.runId,
      stepId: "b",
      strategy: { type: "execute" },
    });
    await workflows.finishAttempt({
      runId: run.runId,
      attemptId: attemptA.attempt.attemptId,
      success: true,
      summary: "a complete",
    });
    graph = await workflows.refreshGraph(run.runId);
    assert.equal(graph.steps.find((step) => step.stepId === "c").status, "pending");

    await workflows.finishAttempt({
      runId: run.runId,
      attemptId: attemptB.attempt.attemptId,
      success: true,
      summary: "b complete",
    });
    graph = await workflows.refreshGraph(run.runId);
    assert.deepEqual(graph.ready.map((step) => step.stepId), ["c"]);

    const attemptC = await workflows.beginAttempt({
      runId: run.runId,
      stepId: "c",
      strategy: { type: "execute" },
    });
    await workflows.finishAttempt({
      runId: run.runId,
      attemptId: attemptC.attempt.attemptId,
      success: true,
      summary: "c complete",
    });
    graph = await workflows.refreshGraph(run.runId);
    assert.equal(graph.run.status, "succeeded");
    assert.equal(graph.steps.every((step) => step.status === "succeeded"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function acceptsFrozenTaskGraphScheduling() {
  const root = await mkdtemp(join(tmpdir(), "pibot-task-scheduler-"));
  try {
    const taskStore = new FileTaskStore({ workspaceRoot: root });
    const draft = await taskStore.writeTasks({
      tasks: [
        { id: "a", title: "Explore A" },
        { id: "b", title: "Explore B" },
        {
          id: "c",
          title: "Implement C",
          dependencies: ["a", "b"],
          execution: { role: "implement", readOnly: false },
        },
      ],
    });
    const frozen = await taskStore.freezeGraph({
      planDigest: "plan-digest",
      expectedTasksDigest: draft.tasksDigest,
    });
    const store = new FileWorkflowStore({ rootDir: join(root, "workflows") });
    const workflows = new WorkflowOrchestrator({ store });
    const childRuntime = new ControlledChildRuntime();
    let acquiredParentHolds = 0;
    let releasedParentHolds = 0;
    const parentResumeEvents = [];
    const scheduler = new TaskGraphScheduler({
      taskStore,
      workflows,
      externalKeyPrefix: "acceptance",
      createChildRuntime: () => childRuntime,
      parentResume: {
        acquireHold() {
          acquiredParentHolds += 1;
          let released = false;
          return {
            release() {
              if (released) return;
              released = true;
              releasedParentHolds += 1;
            },
          };
        },
        enqueue(event) {
          parentResumeEvents.push(event);
          return true;
        },
      },
    });

    const scheduled = await scheduler.startFrozenGraph(frozen);
    assert.deepEqual([...scheduled.startedTaskIds].sort(), ["a", "b"]);
    assert.equal(acquiredParentHolds, 1);
    assert.equal(releasedParentHolds, 0);
    assert.deepEqual(childRuntime.startedTaskIds().sort(), ["a", "b"]);
    let projected = await taskStore.read();
    assert.equal(projected.graphState, "frozen");
    assert.equal(projected.tasks.find((task) => task.id === "a").status, "in_progress");
    assert.equal(projected.tasks.find((task) => task.id === "b").status, "in_progress");
    assert.equal(projected.tasks.find((task) => task.id === "c").status, "pending");

    childRuntime.complete("a", "A evidence");
    await waitFor(async () =>
      (await taskStore.read()).tasks.find((task) => task.id === "a").status === "completed");
    projected = await taskStore.read();
    assert.equal(projected.tasks.find((task) => task.id === "c").status, "pending");

    childRuntime.complete("b", "B evidence");
    await waitFor(() => childRuntime.startedTaskIds().includes("c"));
    projected = await taskStore.read();
    assert.equal(projected.tasks.find((task) => task.id === "c").status, "in_progress");

    childRuntime.complete("c", "C evidence");
    await waitFor(async () =>
      (await store.readRun(scheduled.workflowRunId)).status === "succeeded");
    await waitFor(() => parentResumeEvents.length === 1);
    await scheduler.waitForIdle();
    projected = await taskStore.read();
    assert.equal(projected.tasks.every((task) => task.status === "completed"), true);
    assert.equal(projected.tasks.find((task) => task.id === "c").result, "C evidence");
    const events = await store.readEvents(scheduled.workflowRunId);
    assert.equal(events.filter((event) => event.type === "task.child_terminal").length, 3);
    assert.equal(events.filter((event) =>
      event.type === "task.parent_resume_requested").length, 1);
    assert.equal(releasedParentHolds, 1);
    assert.equal(parentResumeEvents[0].status, "succeeded");
    assert.equal(parentResumeEvents[0].graphVersion, frozen.graphVersion);

    await scheduler.startFrozenGraph(frozen);
    assert.equal(acquiredParentHolds, 1);
    assert.equal(parentResumeEvents.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function acceptsTaskGraphSupersession() {
  const root = await mkdtemp(join(tmpdir(), "pibot-task-supersession-"));
  try {
    const taskStore = new FileTaskStore({ workspaceRoot: root });
    const draft = await taskStore.writeTasks({
      tasks: [
        { id: "a", title: "A" },
        { id: "b", title: "B", dependencies: ["a"] },
      ],
    });
    const frozen = await taskStore.freezeGraph({
      planDigest: "plan-v1",
      expectedTasksDigest: draft.tasksDigest,
    });
    const store = new FileWorkflowStore({ rootDir: join(root, "workflows") });
    const workflows = new WorkflowOrchestrator({ store });
    const childRuntime = new ControlledChildRuntime();
    const scheduler = new TaskGraphScheduler({
      taskStore,
      workflows,
      externalKeyPrefix: "supersession",
      createChildRuntime: () => childRuntime,
    });
    const scheduled = await scheduler.startFrozenGraph(frozen);
    assert.deepEqual(childRuntime.startedTaskIds(), ["a"]);

    const replacement = await taskStore.writeTasks({
      reason: "replace the approved graph",
      tasks: [{ id: "replacement", title: "Replacement" }],
    });
    assert.equal(replacement.graphVersion, 2);
    assert.equal(replacement.graphState, "draft");
    childRuntime.complete("a", "old graph evidence");
    await waitFor(async () =>
      (await store.readRun(scheduled.workflowRunId)).status === "cancelled");
    await scheduler.waitForIdle();

    assert.deepEqual(childRuntime.startedTaskIds(), ["a"]);
    const superseded = await workflows.refreshGraph(scheduled.workflowRunId);
    assert.equal(superseded.run.status, "cancelled");
    assert.deepEqual(superseded.ready, []);
    assert.equal(
      superseded.steps.every((step) =>
        step.status === "succeeded" || step.status === "blocked"),
      true,
    );
    const current = await taskStore.read();
    assert.equal(current.graphVersion, 2);
    assert.deepEqual(current.tasks.map((task) => task.id), ["replacement"]);
    assert.equal(current.tasks[0].status, "pending");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function acceptsTaskGraphMechanicalRetry() {
  const root = await mkdtemp(join(tmpdir(), "pibot-task-retry-"));
  try {
    const taskStore = new FileTaskStore({ workspaceRoot: root });
    const draft = await taskStore.writeTasks({
      tasks: [{ id: "a", title: "Retry A" }],
    });
    const frozen = await taskStore.freezeGraph({
      planDigest: "plan-retry",
      expectedTasksDigest: draft.tasksDigest,
    });
    const store = new FileWorkflowStore({ rootDir: join(root, "workflows") });
    const workflows = new WorkflowOrchestrator({ store });
    const childRuntime = new ControlledChildRuntime();
    const scheduler = new TaskGraphScheduler({
      taskStore,
      workflows,
      externalKeyPrefix: "mechanical-retry",
      createChildRuntime: () => childRuntime,
    });
    const scheduled = await scheduler.startFrozenGraph(frozen);

    childRuntime.fail("a", "provider process failed");
    await waitFor(() => childRuntime.startedTaskIds().length === 2);
    childRuntime.complete("a", "retry succeeded");
    await waitFor(async () =>
      (await store.readRun(scheduled.workflowRunId)).status === "succeeded");
    await scheduler.waitForIdle();

    const task = (await taskStore.read()).tasks[0];
    assert.equal(task.status, "completed");
    assert.equal(task.attempts, 2);
    assert.equal(task.result, "retry succeeded");
    const attempts = await store.readAttempts(scheduled.workflowRunId);
    assert.deepEqual(attempts.map((attempt) => attempt.status), ["failed", "succeeded"]);
    assert.equal(attempts[1].triggerErrorFingerprint, attempts[0].resultErrorFingerprint);
    const circuits = await store.readCircuits();
    assert.equal(circuits.length, 1);
    assert.equal(circuits[0].state, "closed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function acceptsBlockedTaskGraphParentResume() {
  const root = await mkdtemp(join(tmpdir(), "pibot-task-blocked-resume-"));
  try {
    const taskStore = new FileTaskStore({ workspaceRoot: root });
    const draft = await taskStore.writeTasks({
      tasks: [{ id: "a", title: "Eventually blocked A" }],
    });
    const frozen = await taskStore.freezeGraph({
      planDigest: "plan-blocked",
      expectedTasksDigest: draft.tasksDigest,
    });
    const store = new FileWorkflowStore({ rootDir: join(root, "workflows") });
    const workflows = new WorkflowOrchestrator({ store });
    const childRuntime = new ControlledChildRuntime();
    let released = 0;
    const resumeEvents = [];
    const scheduler = new TaskGraphScheduler({
      taskStore,
      workflows,
      externalKeyPrefix: "blocked-resume",
      createChildRuntime: () => childRuntime,
      parentResume: {
        acquireHold() {
          return { release: () => { released += 1; } };
        },
        enqueue(event) {
          resumeEvents.push(event);
          return true;
        },
      },
    });
    const scheduled = await scheduler.startFrozenGraph(frozen);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      childRuntime.fail("a", `same provider failure ${attempt}`);
      await waitFor(async () => {
        const run = await store.readRun(scheduled.workflowRunId);
        return run.status === "blocked" ||
          childRuntime.startedTaskIds().length > attempt;
      });
      if ((await store.readRun(scheduled.workflowRunId)).status === "blocked") {
        break;
      }
    }

    await waitFor(() => resumeEvents.length === 1);
    await scheduler.waitForIdle();
    const run = await store.readRun(scheduled.workflowRunId);
    const task = (await taskStore.read()).tasks[0];
    assert.equal(run.status, "blocked");
    assert.equal(task.status, "blocked");
    assert.equal(resumeEvents[0].status, "blocked");
    assert.equal(typeof resumeEvents[0].terminalReason, "string");
    assert.equal(released, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function acceptsCoordinatorChildWorkflow() {
  const root = await mkdtemp(join(tmpdir(), "pibot-coordinator-child-"));
  try {
    const store = new FileWorkflowStore({ rootDir: join(root, "workflows") });
    const workflows = new WorkflowOrchestrator({ store });
    const childRuntime = new ControlledCoordinatorChildRuntime(root);
    let acquired = 0;
    let released = 0;
    const resumeEvents = [];
    const scheduler = new ChildWorkflowScheduler({
      workflows,
      childAgents: childRuntime,
      parentAgentRunId: "parent-run",
      externalKeyPrefix: "coordinator-acceptance",
      parentResume: {
        acquireHold() {
          acquired += 1;
          let done = false;
          return {
            release() {
              if (done) return;
              done = true;
              released += 1;
            },
          };
        },
        enqueue(event) {
          resumeEvents.push(event);
          return true;
        },
      },
    });
    const tools = createCodingToolExecutor({
      workspaceRoot: root,
      childAgents: childRuntime,
      childScheduler: scheduler,
      approvalGate: createToolApprovalGate("full-access"),
    });

    const first = await tools.executeTool({
      id: "coordinator-spawn",
      name: "agent_spawn",
      input: { role: "review", task: "Review the scheduler", readOnly: true },
    });
    assert.equal(first.ok, true);
    assert.equal(childRuntime.spawned.length, 1);
    assert.equal(acquired, 1);
    const workflowRun = (await store.listRuns()).find((run) =>
      run.kind === "coordinator_child");
    assert.notEqual(workflowRun, undefined);
    let attempts = await store.readAttempts(workflowRun.runId);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].execution.childRunId, first.output.childRunId);

    const duplicate = await tools.executeTool({
      id: "coordinator-spawn",
      name: "agent_spawn",
      input: { role: "review", task: "Review the scheduler", readOnly: true },
    });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.output.childRunId, first.output.childRunId);
    assert.equal(childRuntime.spawned.length, 1);

    childRuntime.fail(first.output.childRunId, "provider process failed");
    await waitFor(() => childRuntime.spawned.length === 2);
    const retryChild = childRuntime.spawned[1].childRunId;
    childRuntime.complete(retryChild, "review evidence");
    await waitFor(() => resumeEvents.length === 1);
    await scheduler.waitForIdle();

    const completed = await store.readRun(workflowRun.runId);
    attempts = await store.readAttempts(workflowRun.runId);
    assert.equal(completed.status, "succeeded");
    assert.deepEqual(attempts.map((attempt) => attempt.status), ["failed", "succeeded"]);
    assert.equal(resumeEvents[0].parentAgentRunId, "parent-run");
    assert.equal(resumeEvents[0].resultSummary, "review evidence");
    assert.equal(resumeEvents[0].attempts, 2);
    assert.equal(released, 1);
    const events = await store.readEvents(workflowRun.runId);
    assert.equal(events.filter((event) =>
      event.type === "coordinator.child_terminal").length, 2);
    assert.equal(events.filter((event) =>
      event.type === "coordinator.parent_resume_requested").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function acceptsCoordinatorChildCancellation() {
  const root = await mkdtemp(join(tmpdir(), "pibot-coordinator-cancel-"));
  try {
    const store = new FileWorkflowStore({ rootDir: join(root, "workflows") });
    const workflows = new WorkflowOrchestrator({ store });
    const childRuntime = new ControlledCoordinatorChildRuntime(root);
    let released = 0;
    const resumeEvents = [];
    const scheduler = new ChildWorkflowScheduler({
      workflows,
      childAgents: childRuntime,
      parentAgentRunId: "parent-run",
      externalKeyPrefix: "coordinator-cancel",
      parentResume: {
        acquireHold() {
          return { release: () => { released += 1; } };
        },
        enqueue(event) {
          resumeEvents.push(event);
          return true;
        },
      },
    });
    const child = await scheduler.spawnAgent({
      toolCallId: "cancel-spawn",
      role: "test",
      task: "Run a cancellable check",
      readOnly: true,
    });
    await scheduler.cancelChild(child.childRunId, "no longer needed");
    childRuntime.finish(child.childRunId, "stopped", "no longer needed");
    await waitFor(() => released === 1);
    await scheduler.waitForIdle();

    const workflowRun = (await store.listRuns())[0];
    assert.equal((await store.readRun(workflowRun.runId)).status, "cancelled");
    assert.equal(childRuntime.spawned.length, 1);
    assert.equal(resumeEvents.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function acceptsCoordinatorChildSameRunResume() {
  const root = await mkdtemp(join(tmpdir(), "pibot-coordinator-resume-"));
  try {
    const store = new FileWorkflowStore({ rootDir: join(root, "workflows") });
    const workflows = new WorkflowOrchestrator({ store });
    const childRuntime = new ControlledCoordinatorChildRuntime(root);
    const controller = new AgentRunController({
      runContext: createAgentRunContext(),
      maxFollowUps: 0,
    });
    const scheduler = new ChildWorkflowScheduler({
      workflows,
      childAgents: childRuntime,
      parentAgentRunId: controller.runId,
      externalKeyPrefix: "coordinator-resume",
      parentResume: {
        acquireHold: ({ workflowRunId }) =>
          controller.deferRunCompletion(`coordinator_child:${workflowRunId}`),
        enqueue(event) {
          return controller.enqueueFollowUp(event, {
            text: event.resultSummary,
            source: "runtime",
            reserveCapacity: true,
          }).accepted;
        },
      },
    });
    const turns = [];
    let childRunId;
    const originalRunId = controller.runId;
    const result = await controller.runUserTurns({
      initial: { status: "initial" },
      async execute(input, context) {
        turns.push({ input, userTurnId: context.userTurnId, runId: context.runId });
        if (input.status === "initial") {
          const child = await scheduler.spawnAgent({
            toolCallId: "resume-child",
            role: "review",
            task: "Return resumable evidence",
            readOnly: true,
          });
          childRunId = child.childRunId;
          setImmediate(() => childRuntime.complete(child.childRunId, "resume evidence"));
        }
        return controller.run({
          execute: async () => ({
            reason: "completed",
            messages: [],
            steps: 1,
          }),
        });
      },
    });

    assert.equal(result.reason, "completed");
    assert.equal(controller.runId, originalRunId);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].runId, turns[1].runId);
    assert.notEqual(turns[0].userTurnId, turns[1].userTurnId);
    assert.equal(turns[1].input.childRunId, childRunId);
    assert.equal(turns[1].input.resultSummary, "resume evidence");
    assert.equal(controller.transitions.filter((event) =>
      event.type === "start_followup_turn").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

class ControlledCoordinatorChildRuntime {
  constructor(root) {
    this.root = root;
    this.spawned = [];
    this.children = new Map();
    this.waiters = new Map();
  }

  async spawnAgent(request) {
    const childRunId = `coordinator-child-${this.spawned.length + 1}`;
    const now = new Date().toISOString();
    const runDir = join(this.root, childRunId);
    const child = {
      childRunId,
      parentRunId: "parent-run",
      role: request.role,
      agentId: `agent-${childRunId}`,
      task: request.task,
      readOnly: request.readOnly ?? false,
      status: "starting",
      workspaceRoot: this.root,
      createdAt: now,
      updatedAt: now,
      paths: {
        runDir,
        taskFile: join(runDir, "task.md"),
        statusFile: join(runDir, "status.json"),
        resultFile: join(runDir, "result.md"),
        usageFile: join(runDir, "usage.json"),
      },
      budget: { timeoutMs: 1000, maxToolCalls: 10, maxTokens: 1000 },
    };
    this.spawned.push(child);
    this.children.set(childRunId, { run: child, result: undefined });
    return child;
  }

  async collectAgent(childRunId) {
    const child = this.children.get(childRunId);
    assert.notEqual(child, undefined);
    return {
      run: child.run,
      alive: !["completed", "failed", "stopped", "timeout"].includes(child.run.status),
      result: child.result,
      usage: { totalTokens: 1 },
    };
  }

  waitForTerminal(childRunId) {
    const child = this.children.get(childRunId);
    assert.notEqual(child, undefined);
    if (["completed", "failed", "stopped", "timeout"].includes(child.run.status)) {
      return Promise.resolve(child.run);
    }
    return new Promise((resolve) => {
      this.waiters.set(childRunId, resolve);
    });
  }

  complete(childRunId, result) {
    this.finish(childRunId, "completed", result);
  }

  fail(childRunId, reason) {
    this.finish(childRunId, "failed", reason);
  }

  finish(childRunId, status, result) {
    const child = this.children.get(childRunId);
    assert.notEqual(child, undefined);
    child.run = {
      ...child.run,
      status,
      ...(status === "completed" ? {} : { stopReason: result }),
      updatedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    };
    child.result = result;
    const resolve = this.waiters.get(childRunId);
    if (resolve !== undefined) {
      this.waiters.delete(childRunId);
      resolve(child.run);
    }
  }
}

class ControlledChildRuntime {
  constructor() {
    this.children = new Map();
    this.waiters = new Map();
  }

  async availableSlots() {
    return 4;
  }

  async spawnAgent(request) {
    const taskId = /^Execute frozen TaskGraph v\d+ task ([^.]+)\./u.exec(request.task)?.[1];
    assert.equal(typeof taskId, "string");
    const ordinal = this.startedTaskIds().filter((id) => id === taskId).length + 1;
    const childRunId = `child-${taskId}-${ordinal}`;
    const child = {
      childRunId,
      parentRunId: "workflow",
      role: request.role,
      task: request.task,
      readOnly: request.readOnly,
      status: "starting",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.children.set(childRunId, { taskId, run: child, result: undefined });
    return child;
  }

  async collectAgent(childRunId) {
    const child = this.children.get(childRunId);
    assert.notEqual(child, undefined);
    return { run: child.run, result: child.result, usage: { totalTokens: 1 } };
  }

  waitForTerminal(childRunId) {
    const child = this.children.get(childRunId);
    assert.notEqual(child, undefined);
    if (["completed", "failed", "stopped", "timeout"].includes(child.run.status)) {
      return Promise.resolve(child.run);
    }
    return new Promise((resolve) => {
      this.waiters.set(childRunId, resolve);
    });
  }

  startedTaskIds() {
    return [...this.children.values()].map((child) => child.taskId);
  }

  complete(taskId, result) {
    this.finish(taskId, "completed", result);
  }

  fail(taskId, reason) {
    this.finish(taskId, "failed", reason);
  }

  finish(taskId, status, result) {
    const entries = [...this.children.entries()].filter(([, child]) =>
      child.taskId === taskId);
    const [childRunId, child] = entries.at(-1) ?? [];
    assert.equal(typeof childRunId, "string");
    assert.notEqual(child, undefined);
    child.run = {
      ...child.run,
      status,
      ...(status === "completed" ? {} : { stopReason: result }),
      updatedAt: new Date().toISOString(),
    };
    child.result = result;
    const resolve = this.waiters.get(childRunId);
    if (resolve !== undefined) {
      this.waiters.delete(childRunId);
      resolve(child.run);
    }
  }
}

async function runCase(name, test) {
  process.stdout.write(`- ${name}: `);
  try {
    await test();
    console.log("PASS");
  } catch (error) {
    console.log("FAIL");
    throw error;
  }
}

async function acceptsPersistentDuplicateGuard() {
  const root = await mkdtemp(join(tmpdir(), "pibot-durable-workflow-"));
  try {
    const store = new FileWorkflowStore({ rootDir: root });
    const workflows = new WorkflowOrchestrator({
      store,
      defaultBudget: {
        maxTotalAttempts: 4,
        maxAttemptsPerStep: 4,
        maxCallsPerEdge: 3,
      },
    });
    const run = await workflows.ensureRun({
      externalKey: "ticket:1",
      kind: "evolution_implementation",
      lifecycle: "detached",
      versions: {
        workflowVersion: "workflow-v1",
        runtimeVersion: "runtime-v3",
        agentVersion: "agent-v2",
        modelName: "model-v4",
      },
    });
    await workflows.ensureStep({
      runId: run.runId,
      stepId: "implementation",
      kind: "agent_implementation",
    });
    const strategyA = { type: "patch", diagnosis: "stale lock" };
    const first = await workflows.beginAttempt({
      runId: run.runId,
      stepId: "implementation",
      strategy: strategyA,
    });
    assert.equal(first.allowed, true);
    const errorFingerprint = "error-same";
    const diffFingerprint = "diff-same";
    await workflows.finishAttempt({
      runId: run.runId,
      attemptId: first.attempt.attemptId,
      success: false,
      resultErrorFingerprint: errorFingerprint,
      diffFingerprint,
      contextFingerprint: "context-v1",
      summary: "CI conflict remained after applying the lock cleanup.",
    });

    const duplicate = await workflows.beginAttempt({
      runId: run.runId,
      stepId: "implementation",
      strategy: strategyA,
      triggerErrorFingerprint: errorFingerprint,
      edgeKey: "implementation.retry",
    });
    assert.equal(duplicate.allowed, false);
    assert.equal(duplicate.reason, "duplicate_error_and_strategy");
    assert.equal((await store.readAttempts(run.runId)).length, 1);

    const changed = await workflows.beginAttempt({
      runId: run.runId,
      stepId: "implementation",
      strategy: { type: "rebase_then_patch", diagnosis: "stale lock" },
      triggerErrorFingerprint: errorFingerprint,
      edgeKey: "implementation.retry",
    });
    assert.equal(changed.allowed, true);
    assert.equal(changed.run.terminalReason, undefined);
    assert.equal(changed.step.terminalReason, undefined);
    await workflows.finishAttempt({
      runId: run.runId,
      attemptId: changed.attempt.attemptId,
      success: false,
      resultErrorFingerprint: errorFingerprint,
      diffFingerprint,
      contextFingerprint: "context-v1",
      summary: "The changed strategy produced the same failing diff.",
    });
    const blocked = await store.readRun(run.runId);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.terminalReason, "duplicate_error_and_diff");

    const experiences = await store.readFailureExperiences();
    assert.equal(experiences.length, 2);
    assert.equal(experiences[0].versions.runtimeVersion, "runtime-v3");
    assert.equal(experiences[0].strategyFingerprint.length, 64);
    assert.equal(experiences[0].diffFingerprint, diffFingerprint);
    const experienceText = await readFile(
      join(root, "experience", "failures.jsonl"),
      "utf8",
    );
    assert.match(experienceText, /CI conflict remained/u);
    await assert.rejects(readFile(join(root, "MEMORY.md"), "utf8"), /ENOENT/u);

    const events = await store.readEvents(run.runId);
    assert.deepEqual(
      events.map((event) => event.seq),
      events.map((_event, index) => index + 1),
    );
    assert.deepEqual(
      (await store.readEvents(run.runId, events.at(-2).seq)).map((event) => event.seq),
      [events.at(-1).seq],
    );

    const orphanedRun = await workflows.ensureRun({
      kind: "restart_recovery",
      lifecycle: "detached",
      versions: { agentVersion: "agent-before-restart" },
    });
    await workflows.ensureStep({
      runId: orphanedRun.runId,
      stepId: "agent_run",
      kind: "agent_conversation",
    });
    const orphanedAttempt = await workflows.beginAttempt({
      runId: orphanedRun.runId,
      stepId: "agent_run",
      strategy: { type: "long_task" },
    });
    await workflows.recordStepCheckpoint({
      runId: orphanedRun.runId,
      stepId: "agent_run",
      checkpoint: { completedToolCallFingerprints: ["completed-before-restart"] },
    });
    assert.equal(await workflows.recoverInterruptedRuns(), 1);
    assert.equal((await store.readRun(orphanedRun.runId)).status, "interrupted");
    const interruptedAttempt = (await store.readAttempts(orphanedRun.runId))
      .find((attempt) => attempt.attemptId === orphanedAttempt.attempt.attemptId);
    assert.equal(interruptedAttempt.status, "interrupted");
    assert.equal(typeof interruptedAttempt.resultErrorFingerprint, "string");
    assert.equal((await store.readFailureExperiences()).length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function acceptsBudgetsAndCircuitBreaker() {
  const root = await mkdtemp(join(tmpdir(), "pibot-durable-budget-"));
  try {
    const store = new FileWorkflowStore({ rootDir: root });
    const workflows = new WorkflowOrchestrator({
      store,
      defaultBudget: {
        maxTotalAttempts: 4,
        maxAttemptsPerStep: 4,
        maxCallsPerEdge: 1,
      },
      circuitThreshold: 1,
      circuitCooldownMs: 60_000,
    });
    const run = await workflows.ensureRun({
      kind: "edge_budget",
      lifecycle: "detached",
    });
    await workflows.ensureStep({ runId: run.runId, stepId: "step", kind: "test" });
    const first = await workflows.beginAttempt({
      runId: run.runId,
      stepId: "step",
      strategy: { type: "first" },
      edgeKey: "retry",
    });
    await workflows.finishAttempt({
      runId: run.runId,
      attemptId: first.attempt.attemptId,
      success: false,
      resultErrorFingerprint: "edge-error",
      summary: "first edge failure",
    });
    const edgeRejected = await workflows.beginAttempt({
      runId: run.runId,
      stepId: "step",
      strategy: { type: "second" },
      triggerErrorFingerprint: "different-error",
      edgeKey: "retry",
    });
    assert.equal(edgeRejected.allowed, false);
    assert.equal(edgeRejected.reason, "edge_budget_exhausted:retry");

    const circuitRun = await workflows.ensureRun({
      kind: "circuit_source",
      lifecycle: "detached",
    });
    await workflows.ensureStep({
      runId: circuitRun.runId,
      stepId: "step",
      kind: "test",
    });
    const circuitAttempt = await workflows.beginAttempt({
      runId: circuitRun.runId,
      stepId: "step",
      strategy: { type: "probe" },
      circuitKey: "provider:model-a",
    });
    await workflows.finishAttempt({
      runId: circuitRun.runId,
      attemptId: circuitAttempt.attempt.attemptId,
      success: false,
      resultErrorFingerprint: "provider-down",
      summary: "provider unavailable",
    });
    const nextRun = await workflows.ensureRun({
      kind: "circuit_consumer",
      lifecycle: "detached",
    });
    await workflows.ensureStep({
      runId: nextRun.runId,
      stepId: "step",
      kind: "test",
    });
    const circuitRejected = await workflows.beginAttempt({
      runId: nextRun.runId,
      stepId: "step",
      strategy: { type: "new-agent" },
      circuitKey: "provider:model-a",
    });
    assert.equal(circuitRejected.allowed, false);
    assert.equal(circuitRejected.reason, "circuit_open:provider:model-a");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function acceptsDetachedRunReplay() {
  const root = await mkdtemp(join(tmpdir(), "pibot-detached-http-"));
  let releaseAgent;
  let observedSignal;
  const agentGate = new Promise((resolve) => {
    releaseAgent = resolve;
  });
  const agent = {
    async runUserMessage(conversationId, _content, options) {
      observedSignal = options.signal;
      await options.onEvent({
        type: "run_start",
        conversationId,
        runId: "agent-run-1",
      });
      await options.onEvent({
        type: "agent_event",
        conversationId,
        runId: "agent-run-1",
        event: {
          type: "tool_end",
          step: 1,
          call: {
            id: "tool-1",
            name: "read",
            fingerprint: "tool-fingerprint-1",
          },
          result: { ok: true, summary: "read complete" },
        },
      });
      await agentGate;
      return {
        conversationId,
        runId: "agent-run-1",
        reason: "completed",
      };
    },
    async getConversation(conversationId) {
      return {
        id: conversationId,
        title: "Detached",
        messages: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
    },
  };
  const evolution = {
    async readSnapshot() {
      return { tickets: [] };
    },
  };
  let started;
  try {
    const store = new FileWorkflowStore({ rootDir: join(root, "workflows") });
    const workflows = new WorkflowOrchestrator({ store });
    const conversations = new FileWebConversationStore(root);
    started = await startWebUiServer({
      host: "127.0.0.1",
      port: 0,
      workspaceRoot: root,
      evolution,
      conversations,
      agent,
      workflows,
    });
    const address = started.server.address();
    assert.equal(typeof address, "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const submitted = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "conversation",
        conversationId: "conversation-1",
        content: "perform a long task",
      }),
    });
    assert.equal(submitted.status, 202);
    const accepted = await submitted.json();
    assert.equal(typeof accepted.runId, "string");

    const firstStream = await fetch(`${baseUrl}${accepted.eventsUrl}`, {
      headers: { "Last-Event-ID": `${accepted.runId}:${accepted.eventCursor}` },
    });
    const firstReader = firstStream.body.getReader();
    await firstReader.read();
    await firstReader.cancel();
    await waitFor(() => observedSignal !== undefined);
    assert.equal(observedSignal.aborted, false);

    releaseAgent();
    await waitFor(async () =>
      (await store.readRun(accepted.runId)).status === "succeeded");
    assert.equal(observedSignal.aborted, false);

    const replay = await fetch(`${baseUrl}${accepted.eventsUrl}`, {
      headers: { "Last-Event-ID": `${accepted.runId}:${accepted.eventCursor}` },
    });
    const replayText = await replay.text();
    assert.match(replayText, new RegExp(`id: ${accepted.runId}:\\d+`, "u"));
    assert.match(replayText, /"type":"done"/u);
    const persistedEvents = await store.readEvents(accepted.runId);
    const checkpoint = (await store.readSteps(accepted.runId))[0].checkpoint;
    assert.deepEqual(checkpoint.completedToolCallFingerprints, ["tool-fingerprint-1"]);
    assert.equal(
      persistedEvents.every((event, index) => event.seq === index + 1),
      true,
    );
  } finally {
    if (started !== undefined) {
      await new Promise((resolve, reject) =>
        started.server.close((error) => error ? reject(error) : resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

runAcceptance().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
