const assert = require("node:assert/strict");
const {
  mkdtemp,
  readFile,
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { MinimalAgentLoop } = require("../dist/agent/agent-loop");
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

async function runAcceptance() {
  await runCase("registry executes a newly registered tool", acceptsRegisteredTool);
  await runCase("parallel tools overlap while file writes serialize", acceptsExecutionModes);
  await runCase("beforeToolCall hook blocks dangerous bash", acceptsHookInterception);
  await runCase("model retries then switches to fallback", acceptsRetryAndFallback);
  await runCase("provider classifies context overflow", acceptsContextOverflow);
  await runCase("trace JSONL replays a complete run", acceptsTraceReplay);
  console.log("Runtime acceptance passed");
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
    maxTurns: 3,
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
    maxTurns: 3,
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
  const run = {
    runId: "run-trace-1",
    parentRunId: "run-parent-1",
    agentId: "coding-bot",
  };
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
    maxTurns: 3,
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
