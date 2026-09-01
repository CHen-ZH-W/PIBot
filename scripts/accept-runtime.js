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
const { AgentRuntime } = require("../dist/runtime/agent-runtime");
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
  assertToolCapability,
  CodingToolRegistry,
  createCodingToolExecutor,
  createToolApprovalGate,
  FileToolApprovalRuleStore,
  getCodingToolSchemas,
  toolApprovalRulesForRun,
} = require("../dist/tools");
const { createSandboxExecutor } = require("../dist/workspace/sandbox");
const { defaultSandboxPolicy } = require("../dist/workspace/sandbox-policy");
const { FileTaskStore } = require("../dist/workspace/tasks");
const {
  createRuntimeWorldStateProvider,
} = require("../dist/runtime/world-state");

async function runAcceptance() {
  await runCase("registry executes a newly registered tool", acceptsRegisteredTool);
  await runCase("capability policy overrides static tool risk", acceptsCapabilityPolicy);
  await runCase("one-shot grants enforce declared resources", acceptsCapabilityGrantResources);
  await runCase("inactive grants cannot be replayed", acceptsCapabilityGrantReplayDenial);
  await runCase("sandbox grants are bound to the approved command", acceptsCapabilityGrantCommandBinding);
  await runCase("run-scoped approval rules match exact capabilities", acceptsRunScopedApprovalRules);
  await runCase("session and repo approval rules persist with exact identity", acceptsPersistentApprovalRules);
  await runCase("bash path scopes participate in approval rules", acceptsBashPathScopedApprovalRules);
  await runCase("direct file tools consume the executor sandbox policy", acceptsDirectFileToolSandboxPolicy);
  await runCase("tool execution rejects a stale Step authority snapshot", acceptsStaleStepAuthoritySnapshot);
  await runCase("mode tightening during approval revokes stale authority", acceptsApprovalModeTightening);
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
  await runCase("agent runtime owns active run registration and release", acceptsAgentRuntimeOwnership);
  await runCase("runtime completion holds resume the same run", acceptsDeferredRunCompletion);
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
      sandboxPolicy: defaultSandboxPolicy,
      sandboxEnforcement: {
        backend: "linux-native",
        filesystem: "path-scoped",
        network: "per-call",
      },
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
  assert.equal(first.messages[1].role, "developer");
  assert.match(first.messages[1].content, /\[pibot-context:world-state\]/u);
  assert.match(first.messages[1].content, /pibot-context-authority:developer/u);
  assert.match(first.messages[1].content, /pibot-context-kind:state/u);
  assert.match(first.messages[1].content, /pibot-context-placement:dynamic-tail/u);
  assert.match(first.messages[1].content, /"mode": "plan"/u);
  assert.match(first.messages[1].content, /"status": "pending"/u);
  assert.match(first.messages[1].content, /tasks\.json/u);
  assert.match(first.messages[1].content, /"branch": "context-test"/u);
  assert.match(first.messages[1].content, /"dirty": true/u);
  assert.match(first.messages[1].content, /linux-native\(test\)/u);
  assert.match(first.messages[1].content, new RegExp(defaultSandboxPolicy.version, "u"));
  assert.match(first.messages[1].content, /"filesystem": "path-scoped"/u);
  assert.match(first.messages[1].content, /"network": "per-call"/u);
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

  await taskStore.updateTask({
    id: "context-1",
    status: "completed",
    result: "event-driven child evidence",
  });
  const thirdStep = captureAgentStepContext(run, "fake-model");
  const third = await hook.beforeModelCall({
    run,
    step: thirdStep.step,
    stepContext: thirdStep,
    request: second,
  });
  assert.match(third.messages[1].content, /"completedResults"/u);
  assert.match(third.messages[1].content, /event-driven child evidence/u);
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

async function acceptsCapabilityPolicy() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pibot-runtime-capability-"));
  const workspaceTools = createCodingToolExecutor({
    workspaceRoot,
    sandboxExecutor: createSandboxExecutor({ kind: "host", enabled: true }),
    approvalGate: createToolApprovalGate("workspace-write"),
  });
  const localCommand = await workspaceTools.executeTool({
    id: "local-process",
    name: "bash",
    input: {
      command: "printf local-only",
      permissions: {
        filesystem: "read",
        network: false,
        externalSideEffect: false,
        destructive: false,
      },
    },
  });
  assert.equal(localCommand.ok, true);
  assert.equal(localCommand.output.stdout, "local-only");
  const networkCommand = await workspaceTools.executeTool({
    id: "network-process",
    name: "bash",
    input: {
      command: "printf should-not-run",
      permissions: {
        filesystem: "read",
        network: true,
        externalSideEffect: false,
        destructive: false,
      },
    },
  });
  assert.equal(networkCommand.ok, false);
  assert.match(networkCommand.error.message, /interactive approval/u);
  const destructiveCommand = await workspaceTools.executeTool({
    id: "destructive-process",
    name: "bash",
    input: {
      command: "printf should-not-run",
      permissions: {
        filesystem: "write",
        network: false,
        externalSideEffect: false,
        destructive: true,
      },
    },
  });
  assert.equal(destructiveCommand.ok, false);
  assert.match(destructiveCommand.error.message, /interactive approval/u);

  const readOnlyChildTools = createCodingToolExecutor({
    workspaceRoot,
    sandboxExecutor: createSandboxExecutor({ kind: "host", enabled: true }),
    approvalGate: createToolApprovalGate("full-access"),
    deniedCapabilities: ["filesystem.write"],
  });
  const ceilingResult = await readOnlyChildTools.executeTool({
    id: "read-only-ceiling",
    name: "bash",
    input: {
      command: "printf should-not-run > ceiling.txt",
      permissions: {
        filesystem: "write",
        network: false,
        externalSideEffect: false,
        destructive: false,
      },
    },
  });
  assert.equal(ceilingResult.ok, false);
  assert.match(ceilingResult.error.message, /capability ceiling/u);
  await assert.rejects(readFile(join(workspaceRoot, "ceiling.txt"), "utf8"), {
    code: "ENOENT",
  });

  let requestedApproval;
  const tools = createCodingToolExecutor({
    workspaceRoot,
    sandboxExecutor: createSandboxExecutor({ kind: "host", enabled: true }),
    approvalGate: createToolApprovalGate("approval-required", {
      context: {
        conversation: { teamId: "T-capability", channelId: "D-capability" },
        requestedByUserId: "U-capability",
      },
      prompter: {
        async requestToolApproval(request) {
          requestedApproval = request;
          return { approved: true };
        },
      },
    }),
  });
  const result = await tools.executeTool({
    id: "capability-write",
    name: "write",
    input: { path: "scoped.txt", content: "scoped\n", overwrite: true },
  });
  assert.equal(result.ok, true);
  assert.equal(requestedApproval.risk, "mutating");
  assert.deepEqual(requestedApproval.capabilities.requirements, [
    { capability: "filesystem.read", paths: ["scoped.txt"] },
    { capability: "filesystem.write", paths: ["scoped.txt"] },
  ]);

  const registry = new CodingToolRegistry();
  let executed = false;
  registry.registerTool({
    name: "misclassified-write",
    description: "Static read-only metadata with a write capability.",
    schema: {},
    riskLevel: "read-only",
    executionMode: "sequential",
    parse: (input) => ({ ok: true, input }),
    resolveCapabilities: () => ({
      requirements: [{ capability: "filesystem.write", paths: ["target.txt"] }],
    }),
    execute: () => {
      executed = true;
      return {};
    },
  });
  const denied = createCodingToolExecutor({
    workspaceRoot,
    registry,
    approvalGate: createToolApprovalGate("read-only"),
  });
  const deniedResult = await denied.executeTool({
    id: "capability-denied",
    name: "misclassified-write",
    input: {},
  });
  assert.equal(deniedResult.ok, false);
  assert.equal(deniedResult.error.code, "permission_denied");
  assert.equal(executed, false);
}

async function acceptsCapabilityGrantResources() {
  const registry = new CodingToolRegistry();
  registry.registerTool({
    name: "resource-check",
    description: "Try to consume a resource outside the issued grant.",
    schema: {},
    riskLevel: "read-only",
    executionMode: "parallel",
    parse: (input) => ({ ok: true, input }),
    resolveCapabilities: () => ({
      requirements: [{ capability: "filesystem.read", paths: ["allowed.txt"] }],
    }),
    execute: (_input, context) => {
      assertToolCapability(context, "filesystem.read", "other.txt");
      return {};
    },
  });
  const executor = await createExecutor(registry);
  const result = await executor.executeTool({
    id: "resource-check-call",
    name: "resource-check",
    input: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "permission_denied");
  assert.match(result.error.message, /other\.txt/u);
}

async function acceptsCapabilityGrantReplayDenial() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pibot-runtime-grant-replay-"));
  const sandboxExecutor = createSandboxExecutor({ kind: "host", enabled: true });
  const registry = new CodingToolRegistry();
  let capturedGrant;
  registry.registerTool({
    name: "capture-grant",
    description: "Capture a grant so replay can be attempted after the call.",
    schema: {},
    riskLevel: "mutating",
    executionMode: "sequential",
    parse: (input) => ({ ok: true, input }),
    resolveCapabilities: () => ({
      requirements: [
        { capability: "process.exec", commands: ["printf replayed"] },
        { capability: "filesystem.read", paths: ["."] },
      ],
    }),
    execute: (_input, context) => {
      capturedGrant = context.authorization.grant;
      return {};
    },
  });
  const executor = createCodingToolExecutor({
    workspaceRoot,
    registry,
    sandboxExecutor,
    approvalGate: createToolApprovalGate("full-access"),
  });
  const result = await executor.executeTool({
    id: "capture-grant-call",
    name: "capture-grant",
    input: {},
  });
  assert.equal(result.ok, true);
  assert.throws(
    () => sandboxExecutor.execute({
      command: "printf replayed",
      workspaceRoot,
      cwd: workspaceRoot,
      timeoutMs: 1000,
      maxOutputChars: 1000,
      authorization: capturedGrant,
    }),
    /not active/u,
  );
}

async function acceptsCapabilityGrantCommandBinding() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pibot-runtime-command-bind-"));
  const registry = new CodingToolRegistry();
  registry.registerTool({
    name: "command-swap",
    description: "Try to execute a command other than the approved one.",
    schema: {},
    riskLevel: "mutating",
    executionMode: "sequential",
    parse: (input) => ({ ok: true, input }),
    resolveCapabilities: () => ({
      requirements: [
        { capability: "process.exec", commands: ["printf approved"] },
        { capability: "filesystem.read", paths: ["."] },
      ],
    }),
    execute: (_input, context) => context.sandboxExecutor.execute({
      command: "printf swapped",
      workspaceRoot,
      cwd: workspaceRoot,
      timeoutMs: 1000,
      maxOutputChars: 1000,
      authorization: context.authorization.grant,
    }),
  });
  const executor = createCodingToolExecutor({
    workspaceRoot,
    registry,
    sandboxExecutor: createSandboxExecutor({ kind: "host", enabled: true }),
    approvalGate: createToolApprovalGate("full-access"),
  });
  const result = await executor.executeTool({
    id: "command-swap-call",
    name: "command-swap",
    input: {},
  });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /lacks process\.exec for this command/u);
}

async function acceptsRunScopedApprovalRules() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pibot-runtime-run-rule-"));
  const prompts = [];
  const rules = toolApprovalRulesForRun(createAgentRuntimeState());
  const gateOptions = {
    context: {
      conversation: { teamId: "T-run-rule", channelId: "D-run-rule" },
      requestedByUserId: "U-run-rule",
    },
    rules,
    prompter: {
      async requestToolApproval(request) {
        prompts.push(request);
        return prompts.length === 1
          ? { approved: true, scope: "run" }
          : { approved: false, scope: "run", reason: "deny other path" };
      },
    },
  };
  const firstExecutor = createCodingToolExecutor({
    workspaceRoot,
    approvalGate: createToolApprovalGate("approval-required", gateOptions),
  });
  const nextTurnExecutor = createCodingToolExecutor({
    workspaceRoot,
    approvalGate: createToolApprovalGate("approval-required", gateOptions),
  });
  const first = await firstExecutor.executeTool({
    id: "run-rule-first",
    name: "write",
    input: { path: "same.txt", content: "first", overwrite: true },
  });
  const second = await nextTurnExecutor.executeTool({
    id: "run-rule-second",
    name: "write",
    input: { path: "same.txt", content: "second", overwrite: true },
  });
  const denied = await nextTurnExecutor.executeTool({
    id: "run-rule-denied",
    name: "write",
    input: { path: "other.txt", content: "other", overwrite: true },
  });
  const deniedAgain = await nextTurnExecutor.executeTool({
    id: "run-rule-denied-again",
    name: "write",
    input: { path: "other.txt", content: "other", overwrite: true },
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(denied.ok, false);
  assert.equal(deniedAgain.ok, false);
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts[0].escalation.requirements, [
    { capability: "filesystem.write", paths: ["same.txt"] },
  ]);
  assert.equal(prompts[0].runScopeAllowed, true);
  assert.match(deniedAgain.error.message, /run-scoped approval rule/u);
}

async function acceptsPersistentApprovalRules() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pibot-runtime-persistent-rule-"));
  const storeRoot = await mkdtemp(join(tmpdir(), "pibot-runtime-rule-store-"));
  const actor = "U-persistent-rule";
  const context = (channelId, requestedByUserId = actor) => ({
    conversation: { teamId: "T-persistent-rule", channelId },
    requestedByUserId,
  });
  const executeWrite = (gate, id, content) => createCodingToolExecutor({
    workspaceRoot,
    approvalGate: gate,
  }).executeTool({
    id,
    name: "write",
    input: { path: "same.txt", content, overwrite: true },
  });

  let sessionPrompts = 0;
  const firstStore = new FileToolApprovalRuleStore({ rootDir: storeRoot });
  const firstGate = createToolApprovalGate("approval-required", {
    context: context("session-a"),
    workspaceRoot,
    persistentRules: firstStore,
    prompter: {
      async requestToolApproval(request) {
        sessionPrompts += 1;
        assert.equal(request.sessionScopeAllowed, true);
        assert.equal(request.repoScopeAllowed, true);
        return { approved: true, scope: "session" };
      },
    },
  });
  assert.equal((await executeWrite(firstGate, "persistent-session-first", "one")).ok, true);

  const restartedStore = new FileToolApprovalRuleStore({ rootDir: storeRoot });
  const restartedSessionGate = createToolApprovalGate("approval-required", {
    context: context("session-a"),
    workspaceRoot,
    persistentRules: restartedStore,
    prompter: {
      async requestToolApproval() {
        throw new Error("same session should reuse the persisted rule");
      },
    },
  });
  assert.equal(
    (await executeWrite(restartedSessionGate, "persistent-session-restart", "two")).ok,
    true,
  );
  assert.equal(sessionPrompts, 1);

  let repoPrompts = 0;
  const repoGate = createToolApprovalGate("approval-required", {
    context: context("session-b"),
    workspaceRoot,
    persistentRules: restartedStore,
    prompter: {
      async requestToolApproval() {
        repoPrompts += 1;
        return { approved: true, scope: "repo" };
      },
    },
  });
  assert.equal((await executeWrite(repoGate, "persistent-repo-first", "three")).ok, true);
  assert.equal(repoPrompts, 1);

  const thirdSessionGate = createToolApprovalGate("approval-required", {
    context: context("session-c"),
    workspaceRoot,
    persistentRules: new FileToolApprovalRuleStore({ rootDir: storeRoot }),
    prompter: {
      async requestToolApproval() {
        throw new Error("same actor and repo should reuse the repo rule");
      },
    },
  });
  assert.equal((await executeWrite(thirdSessionGate, "persistent-repo-reuse", "four")).ok, true);

  let otherActorPrompts = 0;
  const otherActorGate = createToolApprovalGate("approval-required", {
    context: context("session-c", "U-other-actor"),
    workspaceRoot,
    persistentRules: restartedStore,
    prompter: {
      async requestToolApproval() {
        otherActorPrompts += 1;
        return { approved: false, scope: "repo", reason: "actor-specific deny" };
      },
    },
  });
  assert.equal(
    (await executeWrite(otherActorGate, "persistent-other-actor", "blocked")).ok,
    false,
  );
  assert.equal(otherActorPrompts, 1);
  const persistedDenyGate = createToolApprovalGate("approval-required", {
    context: context("session-d", "U-other-actor"),
    workspaceRoot,
    persistentRules: new FileToolApprovalRuleStore({ rootDir: storeRoot }),
    prompter: {
      async requestToolApproval() {
        throw new Error("repo deny should be reused without another prompt");
      },
    },
  });
  const persistedDeny = await executeWrite(
    persistedDenyGate,
    "persistent-other-actor-denied-again",
    "blocked-again",
  );
  assert.equal(persistedDeny.ok, false);
  assert.match(persistedDeny.error.message, /repo-scoped approval rule/u);

  const activeRules = await restartedStore.list();
  const repoAllow = activeRules.find((rule) =>
    rule.scope === "repo" && rule.effect === "allow"
  );
  assert.ok(repoAllow);
  assert.equal(await restartedStore.revoke(repoAllow.id, actor), true);
  assert.equal(
    (await restartedStore.list()).some((rule) => rule.id === repoAllow.id),
    false,
  );
}

async function acceptsBashPathScopedApprovalRules() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pibot-runtime-bash-path-rule-"));
  await writeFile(join(workspaceRoot, "a.txt"), "a", "utf8");
  await writeFile(join(workspaceRoot, "b.txt"), "b", "utf8");
  const prompts = [];
  const gate = createToolApprovalGate("approval-required", {
    context: {
      conversation: { teamId: "T-bash-path", channelId: "D-bash-path" },
      requestedByUserId: "U-bash-path",
    },
    prompter: {
      async requestToolApproval(request) {
        prompts.push(request);
        return { approved: true, scope: "run" };
      },
    },
  });
  const executor = createCodingToolExecutor({
    workspaceRoot,
    sandboxExecutor: {
      policy: defaultSandboxPolicy,
      enforcement: {
        backend: "linux-native",
        filesystem: "path-scoped",
        network: "per-call",
      },
      assertWorkspaceAccess() {},
      async execute(request) {
        assert.equal(request.authorization.policyVersion, defaultSandboxPolicy.version);
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          aborted: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      },
    },
    approvalGate: gate,
  });
  const call = (id, scopedPath) => executor.executeTool({
    id,
    name: "bash",
    input: {
      command: "true",
      permissions: {
        filesystem: { read: [scopedPath], write: [] },
        network: false,
        externalSideEffect: false,
        destructive: false,
      },
    },
  });

  assert.equal((await call("bash-path-a-first", "a.txt")).ok, true);
  assert.equal((await call("bash-path-a-second", "a.txt")).ok, true);
  assert.equal((await call("bash-path-b", "b.txt")).ok, true);
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts[0].capabilities.requirements, [
    { capability: "process.exec", commands: ["true"] },
    { capability: "filesystem.read", paths: ["a.txt"] },
  ]);
  assert.deepEqual(prompts[1].capabilities.requirements, [
    { capability: "process.exec", commands: ["true"] },
    { capability: "filesystem.read", paths: ["b.txt"] },
  ]);
  assert.deepEqual(prompts[0].sandbox, {
    policyVersion: defaultSandboxPolicy.version,
    backend: "linux-native",
    filesystemEnforcement: "path-scoped",
    networkEnforcement: "per-call",
    readPaths: ["a.txt"],
    writePaths: [],
    networkEnabled: false,
  });
}

async function acceptsDirectFileToolSandboxPolicy() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pibot-runtime-custom-policy-"));
  await writeFile(join(workspaceRoot, "ordinary.txt"), "ordinary", "utf8");
  await writeFile(join(workspaceRoot, "custom-secret.txt"), "secret", "utf8");
  const customPolicy = {
    ...defaultSandboxPolicy,
    version: "sandbox-policy-custom-test",
    filesystem: {
      ...defaultSandboxPolicy.filesystem,
      protectedFileNames: [
        ...defaultSandboxPolicy.filesystem.protectedFileNames,
        "custom-secret.txt",
      ],
    },
  };
  const executor = createCodingToolExecutor({
    workspaceRoot,
    approvalGate: createToolApprovalGate("full-access"),
    sandboxExecutor: {
      policy: customPolicy,
      enforcement: {
        backend: "linux-native",
        filesystem: "path-scoped",
        network: "per-call",
      },
      assertWorkspaceAccess() {},
      async execute() {
        throw new Error("sandbox execution is not expected");
      },
    },
  });
  const ordinary = await executor.executeTool({
    id: "custom-policy-ordinary",
    name: "read",
    input: { path: "ordinary.txt" },
  });
  const protectedResult = await executor.executeTool({
    id: "custom-policy-protected",
    name: "read",
    input: { path: "custom-secret.txt" },
  });

  assert.equal(ordinary.ok, true);
  assert.equal(protectedResult.ok, false);
  assert.match(protectedResult.error.message, /Path is protected/u);

  let protectedWritePrompts = 0;
  const protectedWriteExecutor = createCodingToolExecutor({
    workspaceRoot,
    sandboxExecutor: {
      policy: customPolicy,
      enforcement: {
        backend: "linux-native",
        filesystem: "path-scoped",
        network: "per-call",
      },
      assertWorkspaceAccess() {},
      async execute() {
        throw new Error("sandbox execution is not expected");
      },
    },
    approvalGate: createToolApprovalGate("approval-required", {
      context: {
        conversation: { teamId: "T-custom-policy", channelId: "D-custom-policy" },
        requestedByUserId: "U-custom-policy",
      },
      prompter: {
        async requestToolApproval() {
          protectedWritePrompts += 1;
          return { approved: true };
        },
      },
    }),
  });
  const protectedWrite = await protectedWriteExecutor.executeTool({
    id: "custom-policy-protected-write",
    name: "write",
    input: {
      path: "custom-secret.txt",
      content: "changed",
      overwrite: true,
    },
  });
  assert.equal(protectedWrite.ok, false);
  assert.match(protectedWrite.error.message, /Path is protected/u);
  assert.equal(protectedWritePrompts, 0);
}

async function acceptsApprovalModeTightening() {
  const state = createAgentRuntimeState();
  const registry = new CodingToolRegistry();
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pibot-runtime-approval-race-"));
  const persistentRules = new FileToolApprovalRuleStore({
    rootDir: await mkdtemp(join(tmpdir(), "pibot-runtime-approval-race-store-")),
  });
  let executed = false;
  registry.registerTool({
    name: "approval-race-write",
    description: "Wait for approval before writing.",
    schema: {},
    riskLevel: "mutating",
    executionMode: "sequential",
    parse: (input) => ({ ok: true, input }),
    resolveCapabilities: () => ({
      requirements: [{ capability: "filesystem.write", paths: ["race.txt"] }],
    }),
    execute: () => {
      executed = true;
      return {};
    },
  });
  const executor = createCodingToolExecutor({
    workspaceRoot,
    registry,
    runtime: state,
    approvalGate: createToolApprovalGate("approval-required", {
      context: {
        conversation: { teamId: "T-race", channelId: "D-race" },
        requestedByUserId: "U-race",
      },
      workspaceRoot,
      persistentRules,
      prompter: {
        async requestToolApproval() {
          enterPlanMode(state);
          exitPlanMode(state, "Mode changed while approval was pending");
          return { approved: true, scope: "session" };
        },
      },
    }),
  });
  const result = await executor.executeTool({
    id: "approval-race",
    name: "approval-race-write",
    input: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "permission_denied");
  assert.match(result.error.message, /approval became stale.*AgentMode=plan/u);
  assert.equal(state.mode, "execute");
  assert.equal(executed, false);
  assert.deepEqual(await persistentRules.list(), []);
}

async function acceptsStaleStepAuthoritySnapshot() {
  let executed = false;
  const registry = new CodingToolRegistry();
  registry.registerTool({
    name: "snapshot-read",
    description: "Read under a captured authority snapshot.",
    schema: {},
    riskLevel: "read-only",
    executionMode: "parallel",
    parse: (input) => ({ ok: true, input }),
    execute() {
      executed = true;
      return {};
    },
  });
  const executor = await createExecutor(registry);
  const snapshot = executor.captureExecutionSnapshot();
  const result = await executor.executeTool(
    { id: "stale-snapshot", name: "snapshot-read", input: {} },
    undefined,
    { ...snapshot, authorityVersion: `${snapshot.authorityVersion}:stale` },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "permission_denied");
  assert.match(result.error.message, /authority changed/u);
  assert.equal(executed, false);
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
  const transitions = [];
  const runContext = createAgentRunContext({
    onTransition: (transition) => transitions.push(transition),
  });
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
    runContext,
  });

  assert.equal(result.reason, "completed");
  assert.equal(executed, 7);
  assert.equal(maxActive, 2);
  assert.equal(transitions.filter((item) => item.type === "queue_tool_call").length, 7);
  assert.equal(transitions.filter((item) => item.type === "dispatch_tool_call").length, 7);
  assert.equal(transitions.filter((item) => item.type === "complete_tool_call").length, 7);
}

async function acceptsAbortPairing() {
  const controller = new AbortController();
  const events = [];
  let executions = 0;
  const transitions = [];
  const runContext = createAgentRunContext({
    onTransition: (transition) => transitions.push(transition),
  });
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
    runContext,
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
  assert.equal(transitions.filter((item) => item.type === "queue_tool_call").length, 3);
  assert.equal(transitions.filter((item) => item.type === "abort_tool_call").length, 2);
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
  assert.equal(Object.isFrozen(stepStarts[0].snapshot), true);
  assert.equal(Object.isFrozen(stepStarts[0].snapshot.worldState), true);
  assert.deepEqual(toolContexts[0].advertisedTools, ["edit"]);
  assert.equal(
    toolContexts[0].snapshot.worldState,
    stepStarts[0].snapshot.worldState,
  );
  assert.deepEqual(toolContexts[0].snapshot.execution.availableTools, ["edit"]);
  assert.equal(stepStarts[0].snapshot.runtime.mode, "execute");
  assert.equal(stepStarts[0].snapshot.execution.runtimeStateVersion, 0);
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
  assert.equal(queue.enqueue("runtime-reserved", {
    id: "turn-runtime",
    runId: context.runId,
    userTurnId: context.userTurnId,
    text: "e",
    source: "runtime",
  }, { reserveCapacity: true }).position, 3);
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
  assert.equal(byteQueue.enqueue("runtime-too-large", {
    runId: context.runId,
    userTurnId: context.userTurnId,
    text: "二",
    source: "runtime",
  }, { reserveCapacity: true }).reason, "next_turn_queue_bytes_exceeded");
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

async function acceptsDeferredRunCompletion() {
  const controller = new AgentRunController({
    runContext: createAgentRunContext(),
    maxFollowUps: 2,
  });
  const originalRunId = controller.runId;
  const hold = controller.deferRunCompletion("task_graph:v1:digest");
  assert.notEqual(hold, undefined);
  assert.equal(controller.pendingCompletionHolds, 1);
  const turns = [];
  let firstTurnCompleted;
  const firstTurnTerminal = new Promise((resolve) => {
    firstTurnCompleted = resolve;
  });
  const running = controller.runUserTurns({
    initial: "initial",
    async execute(input, context) {
      turns.push({ input, userTurnId: context.userTurnId });
      const result = await controller.run({
        execute: async () => ({
          reason: "completed",
          messages: [],
          steps: 1,
        }),
      });
      if (input === "initial") firstTurnCompleted();
      return result;
    },
  });
  await firstTurnTerminal;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.awaitingFollowUp, true);
  assert.equal(controller.transitions.some((event) =>
    event.type === "complete_run"), false);

  const receipt = controller.enqueueFollowUp("task graph completed", {
    source: "runtime",
  });
  assert.equal(receipt.accepted, true);
  hold.release();
  hold.release();
  const result = await running;

  assert.equal(result.reason, "completed");
  assert.equal(controller.runId, originalRunId);
  assert.equal(controller.pendingCompletionHolds, 0);
  assert.equal(controller.awaitingFollowUp, false);
  assert.deepEqual(turns.map((turn) => turn.input), [
    "initial",
    "task graph completed",
  ]);
  assert.equal(new Set(turns.map((turn) => turn.userTurnId)).size, 2);
  assert.equal(controller.transitions.filter((event) =>
    event.type === "defer_run_completion").length, 1);
  assert.equal(controller.transitions.filter((event) =>
    event.type === "release_run_completion").length, 1);
  assert.equal(controller.transitions.filter((event) =>
    event.type === "start_followup_turn").length, 1);
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

async function acceptsAgentRuntimeOwnership() {
  const runtime = new AgentRuntime();
  const context = createAgentRunContext();
  const controller = runtime.createRun({
    scope: "web:conversation-1",
    runContext: context,
    maxFollowUps: 2,
  });

  assert.equal(runtime.activeRuns().length, 1);
  assert.equal(runtime.runForScope("web:conversation-1"), controller);
  assert.equal(runtime.steer(context.runId, "next-step correction").accepted, true);
  assert.throws(
    () => runtime.createRun({
      scope: "web:conversation-1",
      runContext: createAgentRunContext(),
      maxFollowUps: 0,
    }),
    /already has an active Run/u,
  );

  const result = await runtime.runUserTurns(controller, {
    initial: "initial",
    async execute(value) {
      return value;
    },
  });
  assert.equal(result, "initial");
  assert.equal(runtime.activeRuns().length, 0);
  assert.equal(runtime.runForScope("web:conversation-1"), undefined);
  assert.equal(
    controller.transitions.some((transition) => transition.type === "complete_run"),
    true,
  );
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
      yield {
        ...startEvent("trace-model"),
        developerRoleMode: "native",
        authorityDegraded: false,
      };
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
    contextLanes: [{
      id: "trace-developer",
      authority: "developer",
      kind: "instruction",
      placement: "stable_prefix",
      content: "Trace developer authority.",
    }],
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
  const modelStarted = records.find((record) => record.type === "model.started");
  assert.equal(modelStarted.messageRoleCounts.system, 1);
  assert.equal(modelStarted.messageRoleCounts.developer, 1);
  assert.equal(modelStarted.messageRoleCounts.user, 1);
  const modelCompleted = records.find((record) => record.type === "model.completed");
  assert.equal(modelCompleted.retryCount, 0);
  assert.equal(modelCompleted.developerRoleMode, "native");
  assert.equal(modelCompleted.authorityDegraded, false);
  assert.equal(modelCompleted.usage.totalTokens, 13);
  assert.equal(modelCompleted.cost, 0.01);
  const approvalDecided = records.find(
    (record) => record.type === "approval.decided",
  );
  assert.deepEqual(approvalDecided.capabilities.requirements, [
    { capability: "filesystem.read", paths: ["trace.txt"] },
    { capability: "filesystem.write", paths: ["trace.txt"] },
  ]);
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
