const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { MinimalAgentLoop } = require("../dist/agent/agent-loop");
const { PerChannelAgentRunner } = require("../dist/agent/runner");
const {
  configureAgentRuntimeState,
  createToolPlanApprovalRequester,
  createAgentRuntimeState,
  RuntimeModeHook,
} = require("../dist/runtime/mode");
const {
  SlackToolApprovalBroker,
  TOOL_APPROVAL_ALLOW_ACTION,
} = require("../dist/slack/approval");
const {
  createCodingToolExecutor,
  createToolApprovalGate,
  getCodingToolSchemas,
} = require("../dist/tools");
const { WorkspaceSessionStore } = require("../dist/workspace/session");
const { FileChannelWorkspaceStore } = require("../dist/workspace/store");
const { FileTaskStore } = require("../dist/workspace/tasks");

async function runAcceptance() {
  await runCase(
    "Plan Mode filters mutating tools and requires approval to exit",
    acceptsPlanModeApproval,
  );
  await runCase(
    "Slack Plan Mode approval resumes updates and final output",
    acceptsSlackPlanApprovalResumesOutput,
  );
  await runCase(
    "Slack Plan Mode persists across messages",
    acceptsSlackPlanModePersistsAcrossMessages,
  );
  await runCase(
    "TaskStore persists tasks and enforces replan limit",
    acceptsTaskStoreReplanLimit,
  );
  await runCase(
    "Reflection stops after the configured fix budget",
    acceptsReflectionFixBudget,
  );
  await runCase(
    "Coordinator Mode filters direct mutation tools but allows child-agent controls",
    acceptsCoordinatorModeToolPolicy,
  );
  await runCase(
    "Slack text can start a run in Coordinator Mode",
    acceptsSlackCoordinatorModeRequest,
  );
  await runCase(
    "Explicit follow-up messages queue while a run is active",
    acceptsFollowUpQueue,
  );
  console.log("Workflow acceptance passed");
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

async function acceptsPlanModeApproval() {
  const workspaceRoot = await createWorkspace("pibot-workflows-plan-");
  const approvals = [];
  const taskStore = new FileTaskStore({ workspaceRoot });
  const runtime = createAgentRuntimeState({
    taskStore,
    planApproval: {
      async requestEnterPlanMode(request) {
        approvals.push({ type: "enter", request });
        return { approved: true };
      },
      async requestExitPlanMode(request) {
        approvals.push({ type: "exit", request });
        return { approved: true };
      },
    },
  });
  const tools = createCodingToolExecutor({
    workspaceRoot,
    runtime,
    tasks: taskStore,
    approvalGate: createToolApprovalGate("read-only"),
  });
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield startEvent();
      if (requests.length === 1) {
        yield toolCall("enter-plan", "enter_plan_mode", {
          goal: "Add a feature safely",
        });
      } else if (requests.length === 2) {
        const toolNames = request.tools.map((tool) => tool.name);
        assert.equal(toolNames.includes("read"), true);
        assert.equal(toolNames.includes("grep"), true);
        assert.equal(toolNames.includes("update_plan"), true);
        assert.equal(toolNames.includes("exit_plan_mode"), true);
        assert.equal(toolNames.includes("write"), false);
        assert.equal(toolNames.includes("edit"), false);
        assert.equal(toolNames.includes("bash"), false);
        yield toolCall("save-plan", "update_plan", {
          content: "# Plan\n\n1. Read files.\n2. Edit after approval.\n",
          tasks: [
            { id: "t1", title: "Read files" },
            { id: "t2", title: "Edit after approval", dependencies: ["t1"] },
          ],
          reason: "initial plan",
        });
        yield toolCall("bad-write", "write", {
          path: "src/bad.txt",
          content: "should not write",
          overwrite: true,
        });
      } else if (requests.length === 3) {
        const denied = request.messages
          .filter((message) => message.role === "tool")
          .map((message) => JSON.parse(message.content))
          .find((payload) => payload.callId === "bad-write");
        assert.equal(denied.ok, false);
        assert.equal(denied.error.code, "permission_denied");
        yield toolCall("exit-plan", "exit_plan_mode", {
          summary: "Approve the saved plan.",
        });
      } else {
        yield { type: "text_delta", text: "Plan approved; execution may continue." };
      }
      yield { type: "done" };
    },
  };

  const result = await new MinimalAgentLoop({
    model,
    tools,
    hooks: [
      new RuntimeModeHook({
        state: runtime,
        describeTool: (name) => tools.describeTool(name),
      }),
    ],
  }).run({
    userText: "Plan this change first",
    systemPrompt: "Use Plan Mode for complex changes.",
    history: [],
    tools: getCodingToolSchemas(),
    maxSteps: 5,
    runContext: { runId: "run-plan", agentId: "agent-plan", state: runtime },
  });

  assert.equal(result.reason, "completed");
  assert.equal(runtime.mode, "execute");
  assert.equal(approvals.length, 2);
  assert.equal(approvals[0].type, "enter");
  assert.equal(approvals[1].type, "exit");
  assert.match(await readFile(join(workspaceRoot, "PLAN.md"), "utf8"), /# Plan/u);
  const tasks = JSON.parse(await readFile(join(workspaceRoot, "tasks.json"), "utf8"));
  assert.equal(tasks.tasks.length, 2);
}

async function acceptsSlackPlanApprovalResumesOutput() {
  const workspaceRoot = await createWorkspace("pibot-workflows-slack-plan-");
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const sessions = new WorkspaceSessionStore({ store });
  const slack = new FakeSlackPublisher();
  const approvalBroker = new SlackToolApprovalBroker(slack);
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield startEvent();
      if (requests.length === 1) {
        yield toolCall("enter-plan", "enter_plan_mode", {
          goal: "Plan before editing",
        });
      } else if (requests.length === 2) {
        yield toolCall("update-plan", "update_plan", {
          content: "# Plan\n\n1. Inspect.\n2. Edit after approval.\n",
          reason: "test plan",
        });
      } else if (requests.length === 3) {
        yield toolCall("exit-plan", "exit_plan_mode", {
          summary: "Approve the saved plan.",
        });
      } else {
        yield {
          type: "text_delta",
          text: "Execution after approval complete.",
        };
      }
      yield { type: "done" };
    },
  };

  const runner = new PerChannelAgentRunner({
    slack,
    agentLoop: new MinimalAgentLoop({
      model,
      tools: emptyTools(),
    }),
    createAgentLoopForWorkspace: (runWorkspaceRoot, approvalContext, runContext) => {
      const taskStore = new FileTaskStore({ workspaceRoot: runWorkspaceRoot });
      configureAgentRuntimeState(runContext.state, {
        taskStore,
        planApproval: createToolPlanApprovalRequester({
          prompter: approvalBroker,
          context: approvalContext,
          timeoutMs: 5000,
        }),
      });
      const tools = createCodingToolExecutor({
        workspaceRoot: runWorkspaceRoot,
        runtime: runContext.state,
        tasks: taskStore,
        approvalGate: createToolApprovalGate("read-only"),
      });
      return new MinimalAgentLoop({
        model,
        tools,
        hooks: [
          new RuntimeModeHook({
            state: runContext.state,
            describeTool: (name) => tools.describeTool(name),
          }),
        ],
      });
    },
    resolveChannelWorkspaceRoot: async () => workspaceRoot,
    sessions,
    tools: getCodingToolSchemas(),
    maxSteps: 6,
    updateThrottleMs: 0,
    updateMinChars: 0,
  });

  const run = runner.handleSlackMessage(slackEvent("Plan this first"));
  await waitFor(() => approvalPost(slack.events, /enter Plan Mode/u) !== undefined);
  const enterPost = approvalPost(slack.events, /enter Plan Mode/u);
  assert.notEqual(enterPost, undefined);
  await approvalBroker.handleSlackInteraction(
    approvalAction(readApprovalId(enterPost), TOOL_APPROVAL_ALLOW_ACTION),
  );
  await waitFor(() => approvalPost(slack.events, /leave Plan Mode/u) !== undefined);
  const exitPost = approvalPost(slack.events, /leave Plan Mode/u);
  assert.notEqual(exitPost, undefined);
  await approvalBroker.handleSlackInteraction(
    approvalAction(readApprovalId(exitPost), TOOL_APPROVAL_ALLOW_ACTION),
  );
  await run;

  assert.equal(requests.length, 4);
  assert.equal(
    slack.events.some(
      (event) =>
        event.type === "message.update" &&
        /Plan Mode approved by .* Entering Plan Mode/u.test(event.update.text),
    ),
    true,
  );
  assert.equal(
    slack.events.some(
      (event) =>
        event.type === "message.update" &&
        /Plan approved\. Continuing execution/u.test(event.update.text),
    ),
    true,
  );
  assert.equal(
    slack.events.some(
      (event) =>
        event.type === "message.update" &&
        /Execution after approval complete/u.test(event.update.text),
    ),
    true,
  );
}

async function acceptsSlackPlanModePersistsAcrossMessages() {
  const workspaceRoot = await createWorkspace("pibot-workflows-slack-plan-persist-");
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const sessions = new WorkspaceSessionStore({ store });
  const slack = new FakeSlackPublisher();
  const approvalBroker = new SlackToolApprovalBroker(slack);
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield startEvent();
      if (requests.length === 1) {
        yield toolCall("enter-plan", "enter_plan_mode", {
          goal: "Plan before editing",
        });
      } else if (requests.length === 2) {
        yield {
          type: "text_delta",
          text: "Plan Mode is active. Send any constraints before I save the plan.",
        };
      } else if (requests.length === 3) {
        const toolNames = request.tools.map((tool) => tool.name);
        assert.equal(toolNames.includes("update_plan"), true);
        assert.equal(toolNames.includes("exit_plan_mode"), true);
        assert.equal(toolNames.includes("write"), false);
        assert.equal(toolNames.includes("bash"), false);
        yield toolCall("update-plan", "update_plan", {
          content: "# Plan\n\n1. Inspect.\n2. Edit after approval.\n",
          tasks: [
            { id: "inspect", title: "Inspect current code" },
            { id: "edit", title: "Edit after approval", dependencies: ["inspect"] },
          ],
          reason: "persisted plan mode",
        });
      } else if (requests.length === 4) {
        yield toolCall("exit-plan", "exit_plan_mode", {
          summary: "Approve the persisted plan.",
        });
      } else {
        yield {
          type: "text_delta",
          text: "Execution after persisted approval complete.",
        };
      }
      yield { type: "done" };
    },
  };

  const runner = new PerChannelAgentRunner({
    slack,
    agentLoop: new MinimalAgentLoop({
      model,
      tools: emptyTools(),
    }),
    createAgentLoopForWorkspace: (runWorkspaceRoot, approvalContext, runContext) => {
      const taskStore = new FileTaskStore({ workspaceRoot: runWorkspaceRoot });
      configureAgentRuntimeState(runContext.state, {
        taskStore,
        planApproval: createToolPlanApprovalRequester({
          prompter: approvalBroker,
          context: approvalContext,
          timeoutMs: 5000,
        }),
      });
      const tools = createCodingToolExecutor({
        workspaceRoot: runWorkspaceRoot,
        runtime: runContext.state,
        tasks: taskStore,
        approvalGate: createToolApprovalGate("read-only"),
      });
      return new MinimalAgentLoop({
        model,
        tools,
        hooks: [
          new RuntimeModeHook({
            state: runContext.state,
            describeTool: (name) => tools.describeTool(name),
          }),
        ],
      });
    },
    resolveChannelWorkspaceRoot: async () => workspaceRoot,
    sessions,
    tools: getCodingToolSchemas(),
    maxSteps: 6,
    updateThrottleMs: 0,
    updateMinChars: 0,
  });

  const firstRun = runner.handleSlackMessage(slackEvent("Plan this first"));
  await waitFor(() => approvalPost(slack.events, /enter Plan Mode/u) !== undefined);
  const enterPost = approvalPost(slack.events, /enter Plan Mode/u);
  assert.notEqual(enterPost, undefined);
  await approvalBroker.handleSlackInteraction(
    approvalAction(readApprovalId(enterPost), TOOL_APPROVAL_ALLOW_ACTION),
  );
  await firstRun;

  const channelDir = store.getPaths({
    teamId: "T-workflows",
    channelId: "D-workflows",
  }).channelDir;
  const persistedPlanState = JSON.parse(
    await readFile(join(channelDir, "runtime-state.json"), "utf8"),
  );
  assert.equal(persistedPlanState.state.mode, "plan");
  assert.equal(persistedPlanState.state.version > 0, true);
  await rm(join(channelDir, "runtime-state.json"), { force: true });

  const secondRun = runner.handleSlackMessage(slackEvent("No changes needed"));
  await waitFor(() => approvalPost(slack.events, /leave Plan Mode/u) !== undefined);
  const exitPost = approvalPost(slack.events, /leave Plan Mode/u);
  assert.notEqual(exitPost, undefined);
  await approvalBroker.handleSlackInteraction(
    approvalAction(readApprovalId(exitPost), TOOL_APPROVAL_ALLOW_ACTION),
  );
  await secondRun;

  assert.equal(requests.length, 5);
  const tasks = JSON.parse(await readFile(join(workspaceRoot, "tasks.json"), "utf8"));
  assert.equal(tasks.tasks.length, 2);
  const persistedExecuteState = JSON.parse(
    await readFile(join(channelDir, "runtime-state.json"), "utf8"),
  );
  assert.equal(persistedExecuteState.state.mode, "execute");
  assert.equal(persistedExecuteState.state.version > 0, true);
  assert.equal(
    slack.events.some(
      (event) =>
        event.type === "message.update" &&
        /Execution after persisted approval complete/u.test(event.update.text),
    ),
    true,
  );
}

async function acceptsTaskStoreReplanLimit() {
  const workspaceRoot = await createWorkspace("pibot-workflows-tasks-");
  const taskStore = new FileTaskStore({ workspaceRoot });
  const runtime = createAgentRuntimeState({ taskStore });
  const tools = createCodingToolExecutor({
    workspaceRoot,
    runtime,
    tasks: taskStore,
    approvalGate: createToolApprovalGate("full-access"),
  });

  assert.equal(
    (await tools.executeTool({
      id: "tasks-initial",
      name: "tasks_update",
      input: {
        maxReplans: 1,
        tasks: [{ id: "t1", title: "Initial task" }],
      },
    })).ok,
    true,
  );
  const firstReplan = await tools.executeTool({
    id: "tasks-replan-1",
    name: "tasks_update",
    input: {
      reason: "test discovered a missing step",
      tasks: [
        { id: "t1", title: "Initial task", status: "completed" },
        { id: "t2", title: "Follow-up task", dependencies: ["t1"] },
      ],
    },
  });
  assert.equal(firstReplan.ok, true);
  assert.equal(firstReplan.output.replanCount, 1);

  const secondReplan = await tools.executeTool({
    id: "tasks-replan-2",
    name: "tasks_update",
    input: {
      reason: "another replan should fail",
      tasks: [{ id: "t3", title: "Too many replans" }],
    },
  });
  assert.equal(secondReplan.ok, false);
  assert.equal(secondReplan.error.code, "conflict");
}

async function acceptsReflectionFixBudget() {
  const workspaceRoot = await createWorkspace("pibot-workflows-reflect-");
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield startEvent();
      if (requests.length === 1) {
        yield { type: "text_delta", text: "Implemented the requested change." };
      } else {
        const latestUser = [...request.messages]
          .reverse()
          .find((message) => message.role === "user");
        assert.match(latestUser.content, /Reflection pass/u);
        yield {
          type: "text_delta",
          text: `Found and fixed an issue in reflection pass ${requests.length - 1}.\nreflection_status: fixed`,
        };
      }
      yield { type: "done" };
    },
  };
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const sessions = new WorkspaceSessionStore({ store });
  const toolsForWorkspace = () =>
    createCodingToolExecutor({
      workspaceRoot,
      approvalGate: createToolApprovalGate("full-access"),
    });
  const runner = new PerChannelAgentRunner({
    slack: new FakeSlackPublisher(),
    agentLoop: new MinimalAgentLoop({
      model,
      tools: toolsForWorkspace(),
    }),
    createAgentLoopForWorkspace: () =>
      new MinimalAgentLoop({
        model,
        tools: toolsForWorkspace(),
      }),
    resolveChannelWorkspaceRoot: async () => workspaceRoot,
    sessions,
    tools: getCodingToolSchemas(),
    maxSteps: 2,
    reflection: {
      enabled: true,
      maxFixAttempts: 2,
      maxSteps: 2,
      verifyCommands: ["npm test"],
    },
  });

  await runner.handleSlackMessage(slackEvent("Make the change and reflect"));

  assert.equal(requests.length, 3);
  assert.equal(
    requests.filter((request) =>
      request.messages.some(
        (message) =>
          message.role === "user" && /Reflection pass/u.test(message.content),
      ),
    ).length,
    2,
  );
}

async function acceptsCoordinatorModeToolPolicy() {
  const workspaceRoot = await createWorkspace("pibot-workflows-coordinator-");
  const taskStore = new FileTaskStore({ workspaceRoot });
  const runtime = createAgentRuntimeState({ taskStore });
  const tools = createCodingToolExecutor({
    workspaceRoot,
    runtime,
    tasks: taskStore,
    approvalGate: createToolApprovalGate("full-access"),
  });
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield startEvent();
      if (requests.length === 1) {
        yield toolCall("enter-coordinator", "enter_coordinator_mode", {
          goal: "Coordinate a multi-agent review",
        });
      } else if (requests.length === 2) {
        const toolNames = request.tools.map((tool) => tool.name);
        assert.equal(toolNames.includes("read"), true);
        assert.equal(toolNames.includes("grep"), true);
        assert.equal(toolNames.includes("agent_spawn"), true);
        assert.equal(toolNames.includes("agent_send"), true);
        assert.equal(toolNames.includes("agent_stop"), true);
        assert.equal(toolNames.includes("agent_collect"), true);
        assert.equal(toolNames.includes("tasks_update"), true);
        assert.equal(toolNames.includes("exit_coordinator_mode"), true);
        assert.equal(toolNames.includes("write"), false);
        assert.equal(toolNames.includes("edit"), false);
        assert.equal(toolNames.includes("bash"), false);
        assert.equal(toolNames.includes("attach"), false);
        yield toolCall("bad-write", "write", {
          path: "src/bad.txt",
          content: "should not write",
          overwrite: true,
        });
      } else if (requests.length === 3) {
        const denied = request.messages
          .filter((message) => message.role === "tool")
          .map((message) => JSON.parse(message.content))
          .find((payload) => payload.callId === "bad-write");
        assert.equal(denied.ok, false);
        assert.equal(denied.error.code, "permission_denied");
        yield toolCall("exit-coordinator", "exit_coordinator_mode", {
          summary: "Coordinated review is complete.",
        });
      } else {
        yield { type: "text_delta", text: "Coordinator Mode finished." };
      }
      yield { type: "done" };
    },
  };

  const result = await new MinimalAgentLoop({
    model,
    tools,
    hooks: [
      new RuntimeModeHook({
        state: runtime,
        describeTool: (name) => tools.describeTool(name),
      }),
    ],
  }).run({
    userText: "Coordinate this review with child agents",
    systemPrompt: "Use Coordinator Mode for multi-agent work.",
    history: [],
    tools: getCodingToolSchemas(),
    maxSteps: 5,
    runContext: {
      runId: "run-coordinator",
      agentId: "agent-coordinator",
      state: runtime,
    },
  });

  assert.equal(result.reason, "completed");
  assert.equal(runtime.mode, "execute");
  assert.equal(requests.length, 4);
}

async function acceptsSlackCoordinatorModeRequest() {
  const workspaceRoot = await createWorkspace("pibot-workflows-slack-coordinator-");
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      const system = request.messages.find((message) =>
        message.role === "system" &&
        message.content.includes("Current runtime mode is coordinator"));
      assert.notEqual(system, undefined);
      assert.match(system.content, /Current runtime mode is coordinator/u);
      assert.match(system.content, /In Coordinator Mode/u);
      yield startEvent();
      yield { type: "text_delta", text: "Coordinator run started." };
      yield { type: "done" };
    },
  };
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const sessions = new WorkspaceSessionStore({ store });
  const toolsForWorkspace = () =>
    createCodingToolExecutor({
      workspaceRoot,
      approvalGate: createToolApprovalGate("full-access"),
    });
  const runner = new PerChannelAgentRunner({
    slack: new FakeSlackPublisher(),
    agentLoop: new MinimalAgentLoop({
      model,
      tools: toolsForWorkspace(),
    }),
    createAgentLoopForWorkspace: () =>
      new MinimalAgentLoop({
        model,
        tools: toolsForWorkspace(),
      }),
    resolveChannelWorkspaceRoot: async () => workspaceRoot,
    sessions,
    tools: getCodingToolSchemas(),
    maxSteps: 1,
  });

  await runner.handleSlackMessage(
    slackEvent("进入 coordinator 模式：审查 diff 并汇总风险"),
  );

  assert.equal(requests.length, 1);
}

async function acceptsFollowUpQueue() {
  const workspaceRoot = await createWorkspace("pibot-workflows-followup-");
  const traces = [];
  let releaseFirst;
  const firstStarted = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let allowFirstToFinish;
  const firstMayFinish = new Promise((resolve) => {
    allowFirstToFinish = resolve;
  });
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield startEvent();
      if (requests.length === 1) {
        releaseFirst();
        await firstMayFinish;
        yield { type: "text_delta", text: "First run done." };
      } else {
        yield { type: "text_delta", text: "Queued follow-up done." };
      }
      yield { type: "done" };
    },
  };
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const sessions = new WorkspaceSessionStore({ store });
  const slack = new FakeSlackPublisher();
  const toolsForWorkspace = () =>
    createCodingToolExecutor({
      workspaceRoot,
      approvalGate: createToolApprovalGate("full-access"),
    });
  const runner = new PerChannelAgentRunner({
    slack,
    agentLoop: new MinimalAgentLoop({
      model,
      tools: toolsForWorkspace(),
    }),
    createAgentLoopForWorkspace: () =>
      new MinimalAgentLoop({
        model,
        tools: toolsForWorkspace(),
      }),
    resolveChannelWorkspaceRoot: async () => workspaceRoot,
    sessions,
    tools: getCodingToolSchemas(),
    maxSteps: 2,
    traceRecorder: {
      async record(event) {
        traces.push(event);
      },
    },
  });

  const firstRun = runner.handleSlackMessage(slackEvent("first request"));
  await firstStarted;
  await runner.handleSlackMessage(slackEvent("follow-up: correction"));
  allowFirstToFinish();
  await firstRun;

  assert.equal(requests.length, 2);
  const userTurns = traces.filter((event) => event.type === "user_turn.started");
  assert.equal(traces.filter((event) => event.type === "run.started").length, 1);
  assert.equal(traces.filter((event) => event.type === "run.completed").length, 1);
  assert.equal(userTurns.length, 2);
  assert.equal(new Set(userTurns.map((event) => event.runId)).size, 1);
  assert.equal(new Set(userTurns.map((event) => event.userTurnId)).size, 2);
  assert.equal(
    slack.events.some(
      (event) =>
        event.type === "message.post" &&
        /follow-up queue/u.test(event.draft.text),
    ),
    true,
  );
}

async function createWorkspace(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

function slackEvent(text) {
  return {
    type: "direct_message",
    eventId: `E-${Date.now()}-${Math.random()}`,
    conversation: {
      teamId: "T-workflows",
      channelId: "D-workflows",
    },
    senderUserId: "U-workflows",
    text,
    messageTs: `${Date.now()}.000000`,
    files: [],
    receivedAt: new Date(),
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

function startEvent() {
  return {
    type: "start",
    provider: "openai_compatible",
    model: "fake-model",
  };
}

function emptyTools() {
  return {
    listTools() {
      return [];
    },
    async executeTool(call) {
      return {
        ok: false,
        callId: call.id,
        error: {
          code: "not_found",
          message: "No tools are registered",
          retryable: false,
        },
      };
    },
  };
}

function approvalPost(events, pattern) {
  return events.find(
    (event) =>
      event.type === "message.post" &&
      Array.isArray(event.draft.blocks) &&
      pattern.test(blockText(event.draft.blocks)),
  );
}

function readApprovalId(event) {
  assert.equal(event.type, "message.post");
  const actions = event.draft.blocks.find((block) => block.type === "actions");
  assert.notEqual(actions, undefined);
  return actions.elements[0].value;
}

function approvalAction(approvalId, actionId) {
  return {
    type: "block_actions",
    user: { id: "U-workflows" },
    actions: [
      {
        action_id: actionId,
        value: approvalId,
      },
    ],
  };
}

function blockText(blocks) {
  return blocks
    .flatMap((block) => {
      if (block.text?.text !== undefined) {
        return [block.text.text];
      }
      if (Array.isArray(block.elements)) {
        return block.elements
          .map((element) => element.text)
          .filter((text) => typeof text === "string");
      }
      return [];
    })
    .join("\n");
}

async function waitFor(predicate, options = {}) {
  const attempts = options.attempts ?? 100;
  const intervalMs = options.intervalMs ?? 10;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

class FakeSlackPublisher {
  constructor() {
    this.nextTs = 1;
    this.events = [];
  }

  async publishSlackEvent(event) {
    this.events.push(event);
    if (event.type === "message.post") {
      return {
        conversation: event.draft.conversation,
        messageTs: `${this.nextTs++}.000000`,
      };
    }
    return {
      conversation: event.update.conversation,
      messageTs: event.update.messageTs,
    };
  }
}

runAcceptance().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
