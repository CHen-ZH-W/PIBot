const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const {
  mkdtemp,
  readFile,
  writeFile,
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { MinimalAgentLoop } = require("../dist/agent/agent-loop");
const {
  captureAgentStepContext,
  createAgentRunContext,
} = require("../dist/runtime/context");
const {
  AgentRunController,
  driveWithContextRecovery,
} = require("../dist/runtime/run-controller");
const {
  NextStepInbox,
  NextTurnQueue,
} = require("../dist/runtime/control");
const { RuntimeHookRunner } = require("../dist/runtime/hooks");
const { BoundedToolScheduler } = require("../dist/runtime/tool-scheduler");
const {
  createAgentRuntimeState,
  enterPlanMode,
  exitPlanMode,
  RuntimeModeHook,
} = require("../dist/runtime/mode");
const {
  OpenAICompatibleProviderAdapter,
  RetryingModelClient,
} = require("../dist/agent/model");
const {
  createTraceApprovalObserver,
  JsonlTraceRecorder,
  TraceRuntimeHook,
  withRun,
} = require("../dist/runtime/trace");
const {
  CodingToolRegistry,
  createCodingToolExecutor,
  createToolApprovalGate,
  getCodingToolSchemas,
} = require("../dist/tools");
const { createSandboxExecutor } = require("../dist/workspace/sandbox");
const { FileTaskStore } = require("../dist/workspace/tasks");
const {
  createRuntimeWorldStateProvider,
} = require("../dist/runtime/world-state");

async function runAcceptance() {
  await runCase("registry executes a newly registered tool", acceptsRegisteredTool);
  await runCase("parallel tools overlap while file writes serialize", acceptsExecutionModes);
  await runCase("parallel tool batches apply bounded backpressure", acceptsBoundedParallelTools);
  await runCase("aborted queued tools keep complete tool-result pairing", acceptsAbortPairing);
  await runCase("abort wins when a model stream ignores the signal", acceptsAbortAfterModel);
  await runCase("step context freezes advertised capabilities", acceptsStepContextSnapshot);
  await runCase("world state refreshes plan and task truth each step", acceptsWorldStateProjection);
  await runCase("in-flight steering advances to the next step", acceptsSteeringTransition);
  await runCase("step-end observer steering reaches the next step", acceptsTerminalSteeringRace);
  await runCase("control mailboxes enforce delivery and terminal boundaries", acceptsControlMailboxes);
  await runCase("run controller owns control transitions and follow-ups", acceptsRunController);
  await runCase("context recovery keeps next-step steering open", acceptsRecoverySteering);
  await runCase("failed user turns terminate before queued follow-ups", acceptsFailurePrecedence);
  await runCase("cancellation is first-cause and produces one terminal event", acceptsCancellationRace);
  await runCase("tool hook failures preserve tool-result pairing", acceptsToolHookFailurePairing);
  await runCase("beforeToolCall hook blocks dangerous bash", acceptsHookInterception);
  await runCase("model retries then switches to fallback", acceptsRetryAndFallback);
  await runCase("provider classifies context overflow", acceptsContextOverflow);
  await runCase("trace JSONL replays a complete run", acceptsTraceReplay);
  console.log("Runtime acceptance passed");
}

async function acceptsWorldStateProjection() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pibot-world-state-"));
  const taskStore = new FileTaskStore({ workspaceRoot });
  await taskStore.writeTasks({
    tasks: [{ id: "context-1", title: "Project current task state" }],
  });
  const state = createAgentRuntimeState({ taskStore });
  enterPlanMode(state);
  const run = createAgentRunContext({ state });
  execFileSync("git", ["init", "--initial-branch=context-test"], {
    cwd: workspaceRoot,
    stdio: "ignore",
  });
  await writeFile(join(workspaceRoot, "dirty.txt"), "dirty\n", "utf8");
  const hook = new RuntimeModeHook({
    state,
    worldState: createRuntimeWorldStateProvider({
      workspaceRoot,
      sandboxLabel: "linux-native(test)",
      approvalMode: "approval-required",
      pendingApprovalCount: () => 2,
      childAgents: {
        async listAgents() {
          return [{
            childRunId: "child-1",
            agentId: "ExploreAgent",
            role: "explore",
            status: "running",
            readOnly: true,
            task: "inspect context",
            updatedAt: "2026-08-27T00:00:00Z",
          }];
        },
      },
    }),
  });
  const baseRequest = {
    messages: [{ role: "system", content: "base system" }],
    tools: [],
  };
  const firstStep = captureAgentStepContext(run, "fake-model");
  const first = await hook.beforeModelCall({
    run,
    step: firstStep.step,
    stepContext: firstStep,
    request: baseRequest,
  });

  assert.equal(first.messages.length, 2);
  assert.match(first.messages[1].content, /\[pibot-context:world-state\]/u);
  assert.match(first.messages[1].content, /"mode": "plan"/u);
  assert.match(first.messages[1].content, /"status": "pending"/u);
  assert.match(first.messages[1].content, /tasks\.json/u);
  assert.match(first.messages[1].content, /"branch": "context-test"/u);
  assert.match(first.messages[1].content, /"dirty": true/u);
  assert.match(first.messages[1].content, /linux-native\(test\)/u);
  assert.match(first.messages[1].content, /"pending": 2/u);
  assert.match(first.messages[1].content, /"supported": false/u);
  assert.match(first.messages[1].content, /"childRunId": "child-1"/u);

  await taskStore.updateTask({ id: "context-1", status: "in_progress" });
  const secondStep = captureAgentStepContext(run, "fake-model");
  const second = await hook.beforeModelCall({
    run,
    step: secondStep.step,
    stepContext: secondStep,
    request: first,
  });

  assert.equal(second.messages.length, 2);
  assert.match(second.messages[1].content, /"status": "in_progress"/u);
  assert.equal(
    second.messages.filter((message) =>
      /\[pibot-context:world-state\]/u.test(message.content),
    ).length,
    1,
  );
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

async function acceptsRegisteredTool() {
  const registry = new CodingToolRegistry();
  registry.registerTool({
    name: "echo",
    description: "Echo text.",
    schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    riskLevel: "read-only",
    executionMode: "parallel",
    parse(input) {
      return typeof input.text === "string"
        ? { ok: true, input: { text: input.text } }
        : { ok: false, message: "echo.text must be a string" };
    },
    execute(input) {
      return { echoed: input.text };
    },
  });
  assert.throws(
    () => registry.registerTool({
      name: "echo",
      description: "duplicate",
      schema: {},
      riskLevel: "read-only",
      executionMode: "parallel",
      parse: () => ({ ok: true, input: {} }),
      execute: () => ({}),
    }),
    /already registered/u,
  );
  const executor = await createExecutor(registry);
  const parsed = executor.parseToolCall({
    id: "echo-1",
    name: "echo",
    argumentsJson: JSON.stringify({ text: "hello" }),
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(await executor.executeTool(parsed.call), {
    ok: true,
    callId: "echo-1",
    output: { echoed: "hello" },
  });
  assert.deepEqual(executor.describeTool("echo"), {
    name: "echo",
    riskLevel: "read-only",
    executionMode: "parallel",
  });
}

async function acceptsExecutionModes() {
  let activeReads = 0;
  let maxActiveReads = 0;
  const requests = [];
  const parallelTools = {
    listTools: () => ["read"],
    describeTool: () => ({
      name: "read",
      riskLevel: "read-only",
      executionMode: "parallel",
    }),
    async executeTool(call) {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await wait(20);
      activeReads -= 1;
      return { ok: true, callId: call.id, output: { path: call.input.path } };
    },
  };
  const model = {
    async *stream(request) {
      requests.push(request);
      yield startEvent(requests.length === 1 ? "parallel" : "done");
      if (requests.length === 1) {
        yield toolCall("read-a", "read", { path: "a.txt" });
        yield toolCall("read-b", "read", { path: "b.txt" });
      } else {
        yield { type: "text_delta", text: "done" };
      }
      yield { type: "done" };
    },
  };
  await new MinimalAgentLoop({ model, tools: parallelTools }).run({
    userText: "read both",
    systemPrompt: "Use tools.",
    history: [],
    tools: [{ name: "read", description: "read", inputSchemaJson: "{}" }],
    maxSteps: 3,
  });
  assert.equal(maxActiveReads, 2);

  let activeWrites = 0;
  let maxActiveWrites = 0;
  const registry = new CodingToolRegistry();
  registry.registerTool({
    name: "write-test",
    description: "Serialize fixture writes.",
    schema: {},
    riskLevel: "mutating",
    executionMode: "sequential",
    parse: (input) => ({ ok: true, input }),
    concurrencyKey: (input) => `file:${input.path}`,
    async execute(input) {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      await wait(20);
      activeWrites -= 1;
      return { path: input.path };
    },
  });
  const writeWorkspace = await mkdtemp(join(tmpdir(), "pibot-runtime-queue-"));
  const firstExecutor = await createExecutor(registry, writeWorkspace);
  const secondExecutor = await createExecutor(registry, writeWorkspace);
  await Promise.all([
    firstExecutor.executeTool({
      id: "write-a",
      name: "write-test",
      input: { path: "same.txt" },
    }),
    secondExecutor.executeTool({
      id: "write-b",
      name: "write-test",
      input: { path: "nested/../same.txt" },
    }),
  ]);
  assert.equal(maxActiveWrites, 1);
}

async function acceptsBoundedParallelTools() {
  let active = 0;
  let maxActive = 0;
  let executed = 0;
  let modelCalls = 0;
  const tools = {
    listTools: () => ["read"],
    describeTool: () => ({
      name: "read",
      riskLevel: "read-only",
      executionMode: "parallel",
    }),
    async executeTool(call) {
      executed += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await wait(10);
      active -= 1;
      return { ok: true, callId: call.id, output: call.input };
    },
  };
  const model = {
    async *stream() {
      modelCalls += 1;
      yield startEvent("bounded-tools");
      if (modelCalls === 1) {
        for (let index = 0; index < 7; index += 1) {
          yield toolCall(`bounded-${index}`, "read", { path: `${index}.txt` });
        }
      } else {
        yield { type: "text_delta", text: "done" };
      }
      yield { type: "done" };
    },
  };

  const result = await new MinimalAgentLoop({ model, tools }).run({
    userText: "read seven files",
    systemPrompt: "Use tools.",
    history: [],
    tools: [{ name: "read", description: "read", inputSchemaJson: "{}" }],
    maxSteps: 2,
    maxParallelToolCalls: 2,
  });

  assert.equal(result.reason, "completed");
  assert.equal(executed, 7);
  assert.equal(maxActive, 2);
}

async function acceptsAbortPairing() {
  const controller = new AbortController();
  const events = [];
  let executions = 0;
  const tools = {
    listTools: () => ["read"],
    describeTool: () => ({
      name: "read",
      riskLevel: "read-only",
      executionMode: "parallel",
    }),
    async executeTool(call) {
      executions += 1;
      controller.abort();
      await wait(5);
      return { ok: true, callId: call.id, output: call.input };
    },
  };
  const model = {
    async *stream() {
      yield startEvent("abort-pairing");
      for (let index = 0; index < 3; index += 1) {
        yield toolCall(`abort-${index}`, "read", { path: `${index}.txt` });
      }
      yield { type: "done" };
    },
  };

  const result = await new MinimalAgentLoop({ model, tools }).run({
    userText: "read three files",
    systemPrompt: "Use tools.",
    history: [],
    tools: [{ name: "read", description: "read", inputSchemaJson: "{}" }],
    maxSteps: 2,
    maxParallelToolCalls: 1,
    onEvent: (event) => events.push(event),
  }, controller.signal);
  const toolMessages = result.messages.filter((message) => message.role === "tool");
  const payloads = toolMessages.map((message) => JSON.parse(message.content));

  assert.equal(result.reason, "aborted");
  assert.equal(executions, 1);
  assert.equal(toolMessages.length, 3);
  assert.equal(payloads.filter((payload) => payload.error?.code === "aborted").length, 2);
  assert.equal(events.filter((event) => event.type === "tool_start").length, 1);
  assert.equal(events.filter((event) => event.type === "tool_end").length, 3);
}

async function acceptsAbortAfterModel() {
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  const model = {
    async *stream() {
      yield startEvent("abort-after-model");
      markStarted();
      await released;
      yield { type: "text_delta", text: "stale completion" };
      yield { type: "done" };
    },
  };
  const tools = {
    listTools: () => [],
    async executeTool() {
      throw new Error("No tool should execute");
    },
  };
  const controller = new AbortController();
  const running = new MinimalAgentLoop({ model, tools }).run({
    userText: "wait",
    systemPrompt: "Wait.",
    history: [],
    tools: [],
    maxSteps: 1,
  }, controller.signal);

  await started;
  controller.abort();
  release();
  const result = await running;

  assert.equal(result.reason, "aborted");
  assert.equal(result.error.code, "aborted");
  assert.equal(result.steps, 1);
}

async function acceptsStepContextSnapshot() {
  const state = createAgentRuntimeState();
  const stepStarts = [];
  const toolContexts = [];
  const requests = [];
  let executions = 0;
  const tools = {
    listTools: () => ["edit"],
    describeTool: () => ({
      name: "edit",
      riskLevel: "mutating",
      executionMode: "sequential",
    }),
    async executeTool(call) {
      executions += 1;
      return { ok: true, callId: call.id, output: {} };
    },
  };
  const model = {
    async *stream(request) {
      requests.push(request);
      yield startEvent("step-context");
      if (requests.length === 1) {
        enterPlanMode(state);
        exitPlanMode(state);
        yield toolCall("edit-after-mode-change", "edit", { path: "a.txt" });
      } else {
        yield { type: "text_delta", text: "permission restored next step" };
      }
      yield { type: "done" };
    },
  };
  const captureHook = {
    beforeModelCall({ stepContext }) {
      stepStarts.push(stepContext);
    },
    beforeToolCall({ stepContext }) {
      toolContexts.push(stepContext);
    },
  };
  const runContext = createAgentRunContext({ state });
  const result = await new MinimalAgentLoop({
    model,
    tools,
    hooks: [
      captureHook,
      new RuntimeModeHook({ state, describeTool: tools.describeTool }),
    ],
  }).run({
    userText: "edit a file",
    systemPrompt: "Use tools.",
    history: [],
    tools: [{ name: "edit", description: "edit", inputSchemaJson: "{}" }],
    maxSteps: 2,
    runContext,
  });
  const denied = JSON.parse(
    result.messages.find((message) => message.role === "tool").content,
  );

  assert.equal(result.reason, "completed");
  assert.equal(executions, 0);
  assert.deepEqual(requests[0].tools.map((tool) => tool.name), ["edit"]);
  assert.deepEqual(requests[1].tools.map((tool) => tool.name), ["edit"]);
  assert.equal(stepStarts[0].mode, "execute");
  assert.equal(Object.isFrozen(stepStarts[0]), true);
  assert.deepEqual(toolContexts[0].advertisedTools, ["edit"]);
  assert.equal(toolContexts[0].stateVersion < state.version, true);
  assert.equal(denied.error.code, "permission_denied");
}

async function acceptsControlMailboxes() {
  const context = createAgentRunContext();
  const inbox = new NextStepInbox({ maxEntries: 2, maxBytes: 8 });
  inbox.openUserTurn(context.userTurnId);
  const first = inbox.enqueue({
    id: "steer-1",
    runId: context.runId,
    userTurnId: context.userTurnId,
    text: "one",
    source: "runtime",
  });
  const duplicate = inbox.enqueue({
    id: "steer-1",
    runId: context.runId,
    userTurnId: context.userTurnId,
    text: "ignored",
    source: "runtime",
  });
  const second = inbox.enqueue({
    id: "steer-2",
    runId: context.runId,
    userTurnId: context.userTurnId,
    text: "two",
    source: "runtime",
  });
  const overflow = inbox.enqueue({
    id: "steer-3",
    runId: context.runId,
    userTurnId: context.userTurnId,
    text: "x",
    source: "runtime",
  });
  assert.equal(first.accepted, true);
  assert.equal(duplicate.accepted, true);
  assert.equal(inbox.history().length, 3);
  assert.equal(second.accepted, true);
  assert.equal(overflow.accepted, false);
  assert.equal(overflow.reason, "next_step_inbox_full");
  assert.deepEqual(
    inbox.drain(context.userTurnId, "step-1").map((message) => message.id),
    ["steer-1", "steer-2"],
  );
  assert.deepEqual(inbox.drain(context.userTurnId, "step-2"), []);
  assert.equal(inbox.enqueue({
    runId: context.runId,
    userTurnId: context.userTurnId,
    text: "   ",
  }).reason, "empty_control_message");
  inbox.closeUserTurn(context.userTurnId);
  assert.equal(inbox.enqueue({
    runId: context.runId,
    userTurnId: context.userTurnId,
    text: "late",
  }).reason, "user_turn_completed");

  const byteInbox = new NextStepInbox({ maxEntries: 2, maxBytes: 3 });
  byteInbox.openUserTurn(context.userTurnId);
  assert.equal(byteInbox.enqueue({
    runId: context.runId,
    userTurnId: context.userTurnId,
    text: "四",
  }).accepted, true);
  assert.equal(byteInbox.enqueue({
    runId: context.runId,
    userTurnId: context.userTurnId,
    text: "a",
  }).reason, "next_step_inbox_bytes_exceeded");

  const queue = new NextTurnQueue({ maxEntries: 2, maxBytes: 5 });
  assert.equal(queue.enqueue("first", {
    id: "turn-1",
    runId: context.runId,
    userTurnId: context.userTurnId,
    text: "ab",
  }).position, 1);
  assert.equal(queue.enqueue("second", {
    id: "turn-2",
    runId: context.runId,
    userTurnId: context.userTurnId,
    text: "cd",
  }).position, 2);
  assert.equal(queue.enqueue("overflow", {
    runId: context.runId,
    userTurnId: context.userTurnId,
    text: "e",
  }).reason, "next_turn_queue_full");
  assert.equal(queue.dequeue().payload, "first");
  queue.close("run_completed", "expired");
  assert.equal(queue.size, 0);
  assert.equal(queue.history().find((record) =>
    record.message.id === "turn-2").status, "expired");
  assert.equal(queue.enqueue("late", {
    runId: context.runId,
    userTurnId: context.userTurnId,
    text: "late",
  }).reason, "run_completed");

  const byteQueue = new NextTurnQueue({ maxEntries: 3, maxBytes: 4 });
  assert.equal(byteQueue.enqueue("first", {
    runId: context.runId,
    userTurnId: context.userTurnId,
    text: "abc",
  }).accepted, true);
  assert.equal(byteQueue.enqueue("second", {
    runId: context.runId,
    userTurnId: context.userTurnId,
    text: "二",
  }).reason, "next_turn_queue_bytes_exceeded");
}

async function acceptsRunController() {
  const transitions = [];
  const initial = createAgentRunContext();
  const controller = new AgentRunController({
    runContext: initial,
    maxFollowUps: 2,
    onTransition: (transition) => transitions.push(transition),
  });
  const firstUserTurnId = controller.runContext.userTurnId;

  controller.steer("new constraint");
  assert.equal(controller.followUp("first"), 1);
  assert.equal(controller.followUp("second"), 2);
  assert.equal(controller.followUp("overflow"), undefined);

  const recoveryController = new AgentRunController({
    runContext: createAgentRunContext(),
    maxFollowUps: 0,
  });
  let driverExecutions = 0;
  const recovered = await driveWithContextRecovery(recoveryController, {
    maxAttempts: 1,
    async execute() {
      driverExecutions += 1;
      return { needsRecovery: driverExecutions === 1 };
    },
    needsRecovery: (result) => result.needsRecovery,
    recover: async () => true,
  });
  assert.equal(recovered.needsRecovery, false);
  assert.equal(driverExecutions, 2);

  let runAttempts = 0;
  const drivenTurns = [];
  const finalResult = await controller.runUserTurns({
    initial: "current",
    async execute(value, context) {
      drivenTurns.push({ value, userTurnId: context.userTurnId });
      return controller.run({
        async execute() {
          runAttempts += 1;
          return runAttempts === 1
            ? {
                reason: "error",
                messages: [],
                steps: 1,
                error: {
                  code: "context_overflow",
                  message: "compact",
                  retryable: true,
                },
              }
            : { reason: "completed", messages: [], steps: 1 };
        },
        lifecycle: value === "current"
          ? {
              contextRecovery: {
                maxAttempts: 1,
                shouldRecover: (result) =>
                  result.error?.code === "context_overflow",
                recover: async () => true,
              },
            }
          : undefined,
      });
    },
  });
  assert.equal(finalResult.reason, "completed");
  assert.equal(runAttempts, 4);
  assert.deepEqual(
    drivenTurns.map((turn) => turn.value),
    ["current", "first", "second"],
  );
  assert.equal(drivenTurns[0].userTurnId, firstUserTurnId);
  assert.equal(new Set(drivenTurns.map((turn) => turn.userTurnId)).size, 3);
  assert.equal(controller.runContext.runId, initial.runId);
  assert.equal(controller.queuedFollowUps, 0);
  assert.equal(
    transitions.filter((transition) =>
      transition.type === "complete_user_turn").length,
    3,
  );
  assert.equal(
    transitions.filter((transition) =>
      transition.type === "start_followup_turn").length,
    2,
  );
  assert.equal(
    transitions.filter((transition) =>
      transition.type === "recover_context").length,
    1,
  );
  assert.equal(
    transitions.filter((transition) => transition.type === "complete_run").length,
    1,
  );

  const lateCancel = controller.cancel({
    reason: "user_stop",
    source: "runtime",
  });
  await controller.flushTransitions();
  assert.equal(lateCancel.accepted, false);
  assert.equal(lateCancel.reason, "run_already_terminal");
  assert.equal(controller.cancelled, false);
  assert.equal(controller.queuedFollowUps, 0);
  assert.equal(transitions.at(-1).type, "complete_run");
  const completedMode = controller.runContext.state.mode;
  assert.equal(controller.changeMode(
    { mode: "coordinator", goal: "too late" },
    "too late",
  ).accepted, false);
  assert.equal(controller.runContext.state.mode, completedMode);
  const lateFollowUp = controller.enqueueFollowUp("too late");
  assert.equal(lateFollowUp.accepted, false);
  assert.equal(lateFollowUp.reason, "run_completed");

  const cancelled = new AgentRunController({
    runContext: createAgentRunContext(),
    maxFollowUps: 1,
  });
  cancelled.followUp("discarded");
  const firstCancel = cancelled.cancel({
    reason: "user_stop",
    source: "runtime",
  });
  const repeatedCancel = cancelled.cancel({
    reason: "timeout",
    source: "runtime",
  });
  assert.equal(firstCancel.accepted, true);
  assert.equal(firstCancel.cancellation.reason, "user_stop");
  assert.equal(repeatedCancel.accepted, false);
  assert.equal(repeatedCancel.cancellation.reason, "user_stop");
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.queuedFollowUps, 0);
  assert.equal(cancelled.transitions.at(-1).type, "cancel_requested");
}

async function acceptsCancellationRace() {
  const controller = new AgentRunController({
    runContext: createAgentRunContext(),
    maxFollowUps: 1,
    observers: [{
      onEvent() {
        throw new Error("observer failure must be fail-open");
      },
    }],
  });
  controller.followUp("discard me");
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  const running = controller.runUserTurns({
    initial: "current",
    execute: () => controller.run({
      async execute() {
        markStarted();
        await released;
        return {
          reason: "aborted",
          messages: [],
          steps: 1,
          error: {
            code: "aborted",
            message: "stopped",
            retryable: false,
          },
        };
      },
    }),
  });
  await started;
  const first = controller.cancel({ reason: "user_stop", source: "runtime" });
  const racing = controller.cancel({ reason: "timeout", source: "runtime" });
  release();
  await running;
  const late = controller.cancel({ reason: "shutdown", source: "runtime" });
  await controller.flushTransitions();

  assert.equal(first.accepted, true);
  assert.equal(racing.accepted, false);
  assert.equal(racing.cancellation.reason, "user_stop");
  assert.equal(late.accepted, false);
  assert.equal(late.reason, "run_already_terminal");
  assert.equal(controller.queuedFollowUps, 0);
  assert.equal(controller.transitions.filter((event) =>
    event.type === "cancel_requested").length, 1);
  assert.equal(controller.transitions.filter((event) =>
    event.type === "abort_user_turn").length, 1);
  assert.equal(controller.transitions.filter((event) =>
    event.type === "abort_run").length, 1);
  assert.equal(controller.steer("too late").accepted, false);
  assert.equal(controller.enqueueFollowUp("too late").accepted, false);
}

async function acceptsFailurePrecedence() {
  const controller = new AgentRunController({
    runContext: createAgentRunContext(),
    maxFollowUps: 1,
  });
  controller.followUp("must expire");
  const result = await controller.runUserTurns({
    initial: "current",
    execute: () => controller.run({
      execute: async () => ({
        reason: "error",
        messages: [],
        steps: 1,
        error: {
          code: "unknown",
          message: "terminal failure",
          retryable: false,
        },
      }),
    }),
  });

  assert.equal(result.reason, "error");
  assert.equal(controller.queuedFollowUps, 0);
  assert.equal(controller.transitions.filter((event) =>
    event.type === "fail_user_turn").length, 1);
  assert.equal(controller.transitions.filter((event) =>
    event.type === "start_followup_turn").length, 0);
  assert.equal(controller.transitions.filter((event) =>
    event.type === "fail_run").length, 1);
}

async function acceptsRecoverySteering() {
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield startEvent("recovery-steering");
      if (requests.length === 1) {
        yield {
          type: "error",
          error: {
            code: "context_overflow",
            message: "compact first",
            retryable: true,
          },
        };
        return;
      }
      yield { type: "text_delta", text: "recovered" };
      yield { type: "done" };
    },
  };
  const tools = {
    listTools: () => [],
    async executeTool() {
      throw new Error("No tool should execute");
    },
  };
  const controller = new AgentRunController({
    runContext: createAgentRunContext(),
    maxFollowUps: 0,
  });
  const loop = new MinimalAgentLoop({ model, tools });
  let recoveryReceipt;
  const result = await controller.run({
    execute: () => loop.run({
      userText: "recover",
      systemPrompt: "Recover.",
      history: [],
      tools: [],
      maxSteps: 1,
      runContext: controller.runContext,
    }),
    lifecycle: {
      contextRecovery: {
        maxAttempts: 1,
        shouldRecover: (attempt) =>
          attempt.error?.code === "context_overflow",
        async recover() {
          recoveryReceipt = controller.steer("new recovery constraint");
          return true;
        },
      },
    },
  });

  assert.equal(result.reason, "completed");
  assert.equal(result.steps, 2);
  assert.equal(recoveryReceipt.accepted, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.some((message) =>
    message.role === "user" && /new recovery constraint/u.test(message.content)), true);
}

async function acceptsToolHookFailurePairing() {
  let executions = 0;
  const context = createAgentRunContext();
  const stepContext = {
    runId: context.runId,
    userTurnId: context.userTurnId,
    stepId: "hook-step",
    step: 1,
    stateVersion: context.state.version,
    mode: context.state.mode,
    advertisedTools: ["read"],
    controlMessages: [],
    steeringMessages: [],
  };
  const scheduler = new BoundedToolScheduler({
    maxParallelToolCalls: 1,
    tools: {
      listTools: () => ["read"],
      describeTool: () => ({
        name: "read",
        riskLevel: "read-only",
        executionMode: "parallel",
      }),
      async executeTool(call) {
        executions += 1;
        return { ok: true, callId: call.id, output: {} };
      },
    },
    hooks: new RuntimeHookRunner([{
      beforeToolCall() {
        throw new Error("policy hook failed");
      },
      onToolFailure() {
        throw new Error("failure hook failed");
      },
    }]),
  });
  const results = await scheduler.schedule({
    run: context,
    stepContext,
    calls: [{ id: "hook-call", name: "read", input: {} }],
    onEvent(event) {
      if (event.type === "tool_start" || event.type === "tool_end") {
        throw new Error("presentation observer failed");
      }
    },
  });

  assert.equal(executions, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].callId, "hook-call");
  assert.equal(results[0].ok, false);
  assert.equal(results[0].error.code, "execution_failed");
  assert.match(results[0].error.message, /failure hook failed/u);

  const identityScheduler = new BoundedToolScheduler({
    maxParallelToolCalls: 1,
    tools: {
      listTools: () => ["read"],
      describeTool: () => ({
        name: "read",
        riskLevel: "read-only",
        executionMode: "parallel",
      }),
      async executeTool(call) {
        return { ok: true, callId: call.id, output: {} };
      },
    },
    hooks: new RuntimeHookRunner([{
      beforeToolCall({ call }) {
        return { allowed: true, call: { ...call, id: "rewritten-call" } };
      },
      afterToolCall({ result }) {
        return { ...result, callId: "rewritten-result" };
      },
    }]),
  });
  const identityResults = await identityScheduler.schedule({
    run: context,
    stepContext,
    calls: [{ id: "model-call", name: "read", input: {} }],
  });
  assert.equal(identityResults.length, 1);
  assert.equal(identityResults[0].callId, "model-call");

  const metadataFailure = await new BoundedToolScheduler({
    maxParallelToolCalls: 1,
    tools: {
      listTools: () => ["read"],
      describeTool() {
        throw new Error("metadata unavailable");
      },
      async executeTool() {
        throw new Error("must not dispatch without metadata");
      },
    },
    hooks: new RuntimeHookRunner(),
  }).schedule({
    run: context,
    stepContext,
    calls: [{ id: "metadata-call", name: "read", input: {} }],
  });
  assert.equal(metadataFailure.length, 1);
  assert.equal(metadataFailure[0].callId, "metadata-call");
  assert.equal(metadataFailure[0].ok, false);
  assert.match(metadataFailure[0].error.message, /metadata unavailable/u);
}

async function acceptsSteeringTransition() {
  let releaseFirstStep;
  const firstStepReleased = new Promise((resolve) => {
    releaseFirstStep = resolve;
  });
  let markFirstStepStarted;
  const firstStepStarted = new Promise((resolve) => {
    markFirstStepStarted = resolve;
  });
  const requests = [];
  const stepContexts = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield startEvent("steering-transition");
      if (requests.length === 1) {
        markFirstStepStarted();
        await firstStepReleased;
        yield { type: "text_delta", text: "stale answer" };
      } else {
        assert.equal(
          request.messages.some(
            (message) =>
              message.role === "user" && /new requirement/u.test(message.content),
          ),
          true,
        );
        yield { type: "text_delta", text: "updated answer" };
      }
      yield { type: "done" };
    },
  };
  const tools = {
    listTools: () => [],
    async executeTool() {
      throw new Error("No tool should execute");
    },
  };
  const state = createAgentRuntimeState();
  const controller = new AgentRunController({
    runContext: createAgentRunContext({
      state,
      onTransition() {
        throw new Error("diagnostic observer failure");
      },
    }),
    maxFollowUps: 0,
  });
  const running = new MinimalAgentLoop({
    model,
    tools,
    hooks: [
      {
        beforeModelCall({ stepContext }) {
          stepContexts.push(stepContext);
        },
      },
      new RuntimeModeHook({ state }),
    ],
  }).run({
    userText: "answer once",
    systemPrompt: "Follow steering.",
    history: [],
    tools: [],
    maxSteps: 2,
    runContext: controller.runContext,
  });

  await firstStepStarted;
  controller.steer("use the new requirement");
  releaseFirstStep();
  const result = await running;

  assert.equal(result.reason, "completed");
  assert.equal(requests.length, 2);
  assert.deepEqual(stepContexts.map((context) => context.step), [1, 2]);
  assert.equal(new Set(stepContexts.map((context) => context.stepId)).size, 2);
  assert.equal(
    controller.transitions.some(
      (transition) => transition.type === "continue_with_steering",
    ),
    true,
  );
}

async function acceptsTerminalSteeringRace() {
  let terminalReceipt;
  let controller;
  controller = new AgentRunController({
    runContext: createAgentRunContext(),
    maxFollowUps: 0,
    observers: [{
      onEvent(event) {
        if (event.type === "complete_user_turn") {
          terminalReceipt = controller.steer("arrived after user-turn terminal");
        }
      },
    }],
  });
  const model = {
    async *stream() {
      yield startEvent("terminal-steering-race");
      yield { type: "text_delta", text: "done" };
      yield { type: "done" };
    },
  };
  const tools = {
    listTools: () => [],
    async executeTool() {
      throw new Error("No tool should execute");
    },
  };
  let lateReceipt;
  let stepEnds = 0;
  const result = await controller.run({
    execute: () => new MinimalAgentLoop({ model, tools }).run({
      userText: "finish",
      systemPrompt: "Finish.",
      history: [],
      tools: [],
      maxSteps: 2,
      runContext: controller.runContext,
      onEvent(event) {
        if (event.type === "step_end" && stepEnds === 0) {
          stepEnds += 1;
          lateReceipt = controller.steer("arrived after terminal decision");
        }
      },
    }),
  });

  assert.equal(result.reason, "completed");
  assert.equal(result.steps, 2);
  assert.equal(lateReceipt.accepted, true);
  assert.equal(terminalReceipt.accepted, false);
  assert.equal(terminalReceipt.reason, "user_turn_completed");
}

async function acceptsHookInterception() {
  let executions = 0;
  let failures = 0;
  const requests = [];
  const tools = {
    listTools: () => ["bash"],
    describeTool: () => ({
      name: "bash",
      riskLevel: "external",
      executionMode: "sequential",
    }),
    async executeTool(call) {
      executions += 1;
      return { ok: true, callId: call.id, output: {} };
    },
  };
  const model = {
    async *stream(request) {
      requests.push(request);
      yield startEvent("hook-test");
      if (requests.length === 1) {
        yield toolCall("bash-danger", "bash", { command: "rm -rf ." });
      } else {
        const result = JSON.parse(
          request.messages.find((message) => message.role === "tool").content,
        );
        assert.equal(result.error.code, "permission_denied");
        yield { type: "text_delta", text: "blocked" };
      }
      yield { type: "done" };
    },
  };
  const hook = {
    beforeToolCall({ call }) {
      if (call.name === "bash" && call.input.command.includes("rm -rf")) {
        return { allowed: false, reason: "dangerous bash blocked by hook" };
      }
    },
    onToolFailure() {
      failures += 1;
    },
  };
  const result = await new MinimalAgentLoop({ model, tools, hooks: [hook] }).run({
    userText: "remove workspace",
    systemPrompt: "Use tools.",
    history: [],
    tools: [{ name: "bash", description: "bash", inputSchemaJson: "{}" }],
    maxSteps: 3,
  });
  assert.equal(result.reason, "completed");
  assert.equal(executions, 0);
  assert.equal(failures, 1);
}

async function acceptsRetryAndFallback() {
  const requestedModels = [];
  const adapter = {
    async *stream(request) {
      requestedModels.push(request.model);
      yield startEvent(request.model);
      if (requestedModels.length < 3) {
        yield {
          type: "error",
          error: {
            code: "network_error",
            message: "temporary network failure",
            retryable: true,
          },
        };
        return;
      }
      yield { type: "text_delta", text: "fallback worked" };
      yield { type: "done" };
    },
  };
  const model = new RetryingModelClient(adapter, {
    maxRetries: 1,
    fallbackModels: ["fallback-model"],
    baseRetryDelayMs: 1,
    maxRetryDelayMs: 1,
    random: () => 0.5,
  });
  const events = [];
  for await (const event of model.stream({
    model: "primary-model",
    messages: [],
    tools: [],
  })) {
    events.push(event);
  }
  assert.deepEqual(requestedModels, [
    "primary-model",
    "primary-model",
    "fallback-model",
  ]);
  assert.equal(events.filter((event) => event.type === "retry").length, 2);
  assert.equal(events.some((event) => event.type === "text_delta"), true);
}

async function acceptsContextOverflow() {
  const previousApiKey = process.env.PIBOT_RUNTIME_TEST_API_KEY;
  const previousFetch = global.fetch;
  process.env.PIBOT_RUNTIME_TEST_API_KEY = "test-key";
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "context_length_exceeded",
          message: "The request cannot be processed.",
        },
      }),
      { status: 400 },
    );
  try {
    const provider = new OpenAICompatibleProviderAdapter({
      apiKeyEnvVar: "PIBOT_RUNTIME_TEST_API_KEY",
      defaultBaseUrl: "https://provider.test/v1",
      defaultModel: "test-model",
    });
    const events = [];
    for await (const event of provider.stream({ messages: [], tools: [] })) {
      events.push(event);
    }
    assert.equal(events.at(-1).type, "error");
    assert.equal(events.at(-1).error.code, "context_overflow");
  } finally {
    global.fetch = previousFetch;
    if (previousApiKey === undefined) {
      delete process.env.PIBOT_RUNTIME_TEST_API_KEY;
    } else {
      process.env.PIBOT_RUNTIME_TEST_API_KEY = previousApiKey;
    }
  }
}

async function acceptsTraceReplay() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pibot-runtime-trace-"));
  const traceFile = join(workspaceRoot, "trace.jsonl");
  const recorder = new JsonlTraceRecorder({ filePath: traceFile });
  const run = createAgentRunContext({
    runId: "run-trace-1",
    parentRunId: "run-parent-1",
    agentId: "coding-bot",
  });
  await recorder.record(withRun(run, { type: "run.started" }));
  const approvalGate = createToolApprovalGate("workspace-write", {
    onDecision: createTraceApprovalObserver(recorder, run),
  });
  const tools = createCodingToolExecutor({
    workspaceRoot,
    sandboxExecutor: createSandboxExecutor({ kind: "host", enabled: true }),
    approvalGate,
  });
  let requests = 0;
  const model = {
    async *stream() {
      requests += 1;
      yield startEvent("trace-model");
      if (requests === 1) {
        yield toolCall("trace-write", "write", {
          path: "trace.txt",
          content: "hello trace\n",
          overwrite: true,
        });
      } else {
        yield { type: "text_delta", text: "created" };
      }
      yield {
        type: "done",
        usage: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 3,
          totalTokens: 13,
        },
      };
    },
  };
  const traceHook = new TraceRuntimeHook({
    recorder,
    calculateCost: () => ({ cost: 0.01, currency: "USD" }),
  });
  const result = await new MinimalAgentLoop({
    model,
    tools,
    hooks: [traceHook],
  }).run({
    userText: "create trace file",
    systemPrompt: "Use tools.",
    history: [],
    tools: getCodingToolSchemas(),
    maxSteps: 3,
    runContext: run,
  });
  await recorder.record(withRun(run, {
    type: "run.completed",
    reason: result.reason,
  }));

  assert.equal(await readFile(join(workspaceRoot, "trace.txt"), "utf8"), "hello trace\n");
  const records = (await readFile(traceFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const types = records.map((record) => record.type);
  for (const type of [
    "run.started",
    "model.started",
    "model.completed",
    "tool.started",
    "approval.decided",
    "tool.completed",
    "agent.stopped",
    "run.completed",
  ]) {
    assert.equal(types.includes(type), true, `missing trace event: ${type}`);
  }
  assert.equal(records.every((record) => record.runId === run.runId), true);
  assert.equal(records.every((record) => record.parentRunId === run.parentRunId), true);
  assert.equal(records.every((record) => record.agentId === run.agentId), true);
  const modelCompleted = records.find((record) => record.type === "model.completed");
  assert.equal(modelCompleted.retryCount, 0);
  assert.equal(modelCompleted.usage.totalTokens, 13);
  assert.equal(modelCompleted.cost, 0.01);
}

async function createExecutor(registry, requestedWorkspaceRoot) {
  const workspaceRoot =
    requestedWorkspaceRoot ??
    await mkdtemp(join(tmpdir(), "pibot-runtime-tools-"));
  return createCodingToolExecutor({
    workspaceRoot,
    registry,
    sandboxExecutor: createSandboxExecutor({ kind: "host", enabled: true }),
    approvalGate: createToolApprovalGate("full-access"),
  });
}

function startEvent(model) {
  return {
    type: "start",
    provider: "openai_compatible",
    model: model ?? "fake-model",
  };
}

function toolCall(id, name, input) {
  return {
    type: "tool_call",
    call: {
      id,
      name,
      argumentsJson: JSON.stringify(input),
    },
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

runAcceptance().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
