const assert = require("node:assert/strict");
const { mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { MinimalAgentLoop } = require("../dist/agent/agent-loop");
const { PerChannelAgentRunner } = require("../dist/agent/runner");
const {
  createLlmSessionCompactor,
  createSessionCompactor,
} = require("../dist/workspace/compaction");
const { WorkspaceSessionStore } = require("../dist/workspace/session");
const { FileChannelWorkspaceStore } = require("../dist/workspace/store");

async function runAcceptance() {
  await runCase("long session writes a summary record", acceptsSummaryWrite);
  await runCase("compacted history preserves current goal and modified files", acceptsSummaryShape);
  await runCase("recent history is retained by token budget", acceptsRecentTokenBudget);
  await runCase("recent tool result keeps its assistant tool call", acceptsRecentToolResultPair);
  await runCase("LLM compaction writes a structured summary", acceptsLlmSummary);
  await runCase("LLM compaction keeps long summaries", acceptsLlmLongSummary);
  await runCase("invalid LLM compaction falls back to heuristic summary", acceptsLlmFallback);
  await runCase("runner displays compaction status in Slack", acceptsRunnerCompactionStatus);
  await runCase("runner compacts context between model turns", acceptsRuntimeCompaction);
  await runCase("context overflow forces compaction and retries the run", acceptsOverflowRetry);
  await runCase("compaction failure warns and keeps original context", acceptsFailureWarning);
  console.log("Session compaction acceptance passed");
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

async function acceptsSummaryWrite() {
  const fixture = await createFixture({
    compactor: createSessionCompactor({
      contextWindowTokens: 100,
      reserveTokens: 40,
      keepRecentTokens: 1,
    }),
  });
  await seedLongContext(fixture.store);

  const prepared = await fixture.session.prepareRun(slackEvent("current", "Now continue"));
  const records = await fixture.store.readContextEntries(channelKey());
  const summary = records
    .map((entry) => entry.record)
    .find((record) => record.source === "compaction");

  assert.notEqual(summary, undefined);
  assert.equal(summary.role, "user");
  assert.equal(summary.compactionKind, "session_summary");
  assert.equal(typeof summary.coveredThroughLineNumber, "number");
  assert.equal(summary.contextWindowTokens, 100);
  assert.equal(summary.reserveTokens, 40);
  assert.equal(summary.compactionTriggerTokens, 60);
  assert.equal(summary.keepRecentTokens, 1);
  assert.equal(typeof summary.keptRecentTokens, "number");
  assert.equal(prepared.history.some((message) => message.content.includes("[SESSION COMPACTION SUMMARY]")), true);
}

async function acceptsSummaryShape() {
  const fixture = await createFixture({
    compactor: createSessionCompactor({
      contextWindowTokens: 100,
      reserveTokens: 40,
      keepRecentTokens: 1,
    }),
  });
  await seedLongContext(fixture.store);

  const prepared = await fixture.session.prepareRun(slackEvent("current", "Now continue"));
  const summaryMessage = prepared.history.find((message) =>
    message.content.includes("[SESSION COMPACTION SUMMARY]"),
  );

  assert.notEqual(summaryMessage, undefined);
  assert.match(summaryMessage.content, /目标:/u);
  assert.match(summaryMessage.content, /约束:/u);
  assert.match(summaryMessage.content, /已读文件:/u);
  assert.match(summaryMessage.content, /已改文件:/u);
  assert.match(summaryMessage.content, /下一步:/u);
  assert.match(summaryMessage.content, /PNG grayscale script/u);
  assert.match(summaryMessage.content, /input\.py/u);
  assert.match(summaryMessage.content, /result\.py/u);
  assert.equal(
    prepared.history.some((message) => message.content.includes("recent message stays")),
    true,
  );
  assert.equal(prepared.history.length <= 2, true);
}

async function acceptsRecentTokenBudget() {
  const fixture = await createFixture({
    compactor: createSessionCompactor({
      contextWindowTokens: 100,
      reserveTokens: 40,
      keepRecentTokens: 10,
    }),
  });
  await seedContextWithRecentMessages(fixture.store);

  const prepared = await fixture.session.prepareRun(slackEvent("current", "Now continue"));

  assert.equal(prepared.history.some((message) => message.content === "recent-a"), false);
  assert.equal(prepared.history.some((message) => message.content === "recent-b"), true);
  assert.equal(prepared.history.some((message) => message.content === "recent-c"), true);
}

async function acceptsRecentToolResultPair() {
  const fixture = await createFixture({
    compactor: createSessionCompactor({
      contextWindowTokens: 100,
      reserveTokens: 40,
      keepRecentTokens: 1,
    }),
  });
  await seedContextWithRecentToolPair(fixture.store);

  const prepared = await fixture.session.prepareRun(slackEvent("current", "Now continue"));
  const recentToolResult = prepared.history.find(
    (message) => message.role === "tool" && message.toolCallId === "write:recent",
  );
  const recentToolCall = prepared.history.find(
    (message) =>
      message.role === "assistant" &&
      message.toolCalls?.some((toolCall) => toolCall.id === "write:recent") === true,
  );

  assert.notEqual(recentToolResult, undefined);
  assert.notEqual(recentToolCall, undefined);
  assert.equal(
    prepared.history.indexOf(recentToolCall) < prepared.history.indexOf(recentToolResult),
    true,
  );
}

async function acceptsLlmSummary() {
  const summaryRequests = [];
  const fixture = await createFixture({
    compactor: createLlmSessionCompactor({
      contextWindowTokens: 100,
      reserveTokens: 40,
      keepRecentTokens: 1,
      model: summaryModel(
        JSON.stringify({
          goal: "Ship the grayscale utility",
          constraints: ["Keep output predictable"],
          progress: ["Read input.py"],
          decisions: ["Use a deterministic conversion"],
          nextSteps: ["Run tests"],
          readFiles: ["input.py"],
          modifiedFiles: ["result.py"],
          fileOperations: ["write: result.py"],
        }),
        summaryRequests,
      ),
    }),
  });
  await seedLongContext(fixture.store);

  await fixture.session.prepareRun(slackEvent("current", "Now continue"));
  const summary = await latestSummary(fixture.store);

  assert.equal(summary.summaryStrategy, "llm");
  assert.equal(summaryRequests[0].maxOutputTokens, 32);
  assert.equal(summary.summaryUsage.totalTokens, 15);
  assert.match(summary.content, /进度:/u);
  assert.match(summary.content, /决策:/u);
  assert.match(summary.content, /文件操作:/u);
  assert.match(summary.content, /Use a deterministic conversion/u);
}

async function acceptsLlmLongSummary() {
  const fixture = await createFixture({
    compactor: createLlmSessionCompactor({
      contextWindowTokens: 100,
      reserveTokens: 40,
      keepRecentTokens: 1,
      model: summaryModel(JSON.stringify({
        goal: "Preserve a detailed session summary",
        constraints: longItems("constraint", 8),
        progress: longItems("progress", 12),
        decisions: longItems("decision", 12),
        nextSteps: longItems("next-step", 8),
        readFiles: [],
        modifiedFiles: [],
        fileOperations: [],
      })),
    }),
  });
  await seedLongContext(fixture.store);

  await fixture.session.prepareRun(slackEvent("current", "Now continue"));
  const summary = await latestSummary(fixture.store);

  assert.equal(summary.summaryStrategy, "llm");
  assert.equal(summary.content.length > 6000, true);
  assert.equal(summary.content.includes("\n[truncated]"), false);
}

async function acceptsLlmFallback() {
  const fixture = await createFixture({
    compactor: createLlmSessionCompactor({
      contextWindowTokens: 100,
      reserveTokens: 40,
      keepRecentTokens: 1,
      model: summaryModel("not-json"),
    }),
  });
  await seedLongContext(fixture.store);

  await fixture.session.prepareRun(slackEvent("current", "Now continue"));
  const summary = await latestSummary(fixture.store);

  assert.equal(summary.summaryStrategy, "heuristic_fallback");
  assert.match(summary.fallbackReason, /JSON object/u);
  assert.match(summary.content, /PNG grayscale script/u);
}

async function acceptsRunnerCompactionStatus() {
  const fixture = await createFixture({
    compactor: createSessionCompactor({
      contextWindowTokens: 100,
      reserveTokens: 40,
      keepRecentTokens: 1,
    }),
  });
  await seedLongContext(fixture.store);
  const model = {
    async *stream() {
      yield startEvent();
      yield { type: "text_delta", text: "Continued after compaction." };
      yield { type: "done" };
    },
  };
  const slack = new FakeSlackPublisher();
  const runner = new PerChannelAgentRunner({
    slack,
    agentLoop: new MinimalAgentLoop({
      model,
      tools: emptyTools(),
    }),
    sessions: fixture.session,
    tools: [],
    maxSteps: 1,
    updateThrottleMs: 0,
    updateMinChars: 0,
  });

  await runner.handleSlackMessage(slackEvent("compact-visible", "Continue task"));

  assert.equal(
    slack.events.some(
      (event) =>
        event.type === "message.update" &&
        /Checking context size/u.test(event.update.text),
    ),
    true,
  );
  assert.equal(
    slack.events.some(
      (event) =>
        event.type === "message.update" &&
        /Context compacted/u.test(event.update.text),
    ),
    true,
  );
  assert.equal(
    slack.events.some(
      (event) =>
        event.type === "message.update" &&
        /Compacting context now/u.test(event.update.text),
    ),
    true,
  );
}

async function acceptsRuntimeCompaction() {
  const fixture = await createFixture({
    compactor: createSessionCompactor({
      contextWindowTokens: 1300,
      reserveTokens: 300,
      keepRecentTokens: 300,
    }),
  });
  await seedContextNearRuntimeThreshold(fixture.store);
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield startEvent();
      if (requests.length === 1) {
        yield {
          type: "tool_call",
          call: {
            id: "read:runtime",
            name: "read",
            argumentsJson: JSON.stringify({ path: "runtime.txt" }),
          },
        };
        yield { type: "done" };
        return;
      }
      yield { type: "text_delta", text: "Continued after runtime compaction." };
      yield { type: "done" };
    },
  };
  const traces = [];
  const slack = new FakeSlackPublisher();
  const tools = readToolSchemas();
  const runner = new PerChannelAgentRunner({
    slack,
    agentLoop: new MinimalAgentLoop({
      model,
      tools: readToolExecutor("runtime tool output ".repeat(170)),
    }),
    sessions: fixture.session,
    tools,
    maxSteps: 3,
    traceRecorder: {
      async record(event) {
        traces.push(event);
      },
    },
    updateThrottleMs: 0,
    updateMinChars: 0,
  });

  await runner.handleSlackMessage(slackEvent("runtime-current", "Continue task"));
  const summary = await latestSummary(fixture.store);

  assert.equal(requests.length, 2);
  assert.equal(
    requests[0].messages.some((message) =>
      message.content.includes("[SESSION COMPACTION SUMMARY]")),
    false,
  );
  assert.equal(
    requests[1].messages.some((message) =>
      message.content.includes("[SESSION COMPACTION SUMMARY]")),
    true,
  );
  assert.equal(summary.compactionReason, "threshold");
  assert.equal(
    traces.some(
      (event) =>
        event.type === "session.compacted" &&
        event.reason === "threshold" &&
        typeof event.estimatedTokensBefore === "number",
    ),
    true,
  );
  assert.equal(
    slack.events.some(
      (event) =>
        event.type === "message.update" &&
        /Context compacted/u.test(event.update.text),
    ),
    true,
  );
  assert.equal(
    slack.events.some(
      (event) =>
        event.type === "message.update" &&
        /Compacting context now/u.test(event.update.text),
    ),
    true,
  );
}

async function acceptsOverflowRetry() {
  const fixture = await createFixture({
    compactor: createSessionCompactor({
      contextWindowTokens: 1000,
      reserveTokens: 100,
      keepRecentTokens: 10,
    }),
  });
  await seedContextWithRecentMessages(fixture.store);
  let requests = 0;
  const model = {
    async *stream() {
      requests += 1;
      yield startEvent();
      if (requests === 1) {
        yield {
          type: "error",
          error: {
            code: "context_overflow",
            message: "maximum context length reached",
            retryable: false,
          },
        };
        return;
      }
      yield { type: "text_delta", text: "Recovered after compaction." };
      yield { type: "done" };
    },
  };
  const traces = [];
  const slack = new FakeSlackPublisher();
  const runner = new PerChannelAgentRunner({
    slack,
    agentLoop: new MinimalAgentLoop({
      model,
      tools: emptyTools(),
    }),
    sessions: fixture.session,
    tools: [],
    maxSteps: 2,
    traceRecorder: {
      async record(event) {
        traces.push(event);
      },
    },
    updateThrottleMs: 0,
    updateMinChars: 0,
  });

  await runner.handleSlackMessage(slackEvent("overflow-current", "Continue task"));
  const summary = await latestSummary(fixture.store);

  assert.equal(requests, 2);
  assert.equal(summary.compactionReason, "context_overflow");
  assert.equal(
    traces.some((event) => event.type === "run.context_overflow_retry"),
    true,
  );
  assert.equal(
    traces.some(
      (event) =>
        event.type === "session.compacted" &&
        event.reason === "context_overflow" &&
        typeof event.estimatedTokensBefore === "number" &&
        typeof event.estimatedTokensAfter === "number",
    ),
    true,
  );
  assert.equal(
    slack.events.some(
      (event) =>
        event.type === "message.update" &&
        /Context is too large\. Compacting history before retry/u.test(
          event.update.text,
        ),
    ),
    true,
  );
  assert.equal(
    slack.events.some(
      (event) =>
        event.type === "message.update" &&
        /Context compacted after overflow/u.test(event.update.text),
    ),
    true,
  );
}

async function acceptsFailureWarning() {
  const warnings = [];
  const fixture = await createFixture({
    warnings,
    compactor: {
      maybeCompact() {
        throw new Error("boom");
      },
    },
  });
  await seedLongContext(fixture.store);

  const prepared = await fixture.session.prepareRun(slackEvent("current", "Now continue"));

  assert.equal(
    warnings.some(
      (warning) =>
        warning.code === "compaction_failed" && warning.message.includes("boom"),
    ),
    true,
  );
  assert.equal(prepared.history.length > 5, true);
}

async function latestSummary(store) {
  const records = await store.readContextEntries(channelKey());
  return records
    .map((entry) => entry.record)
    .filter((record) => record.source === "compaction")
    .at(-1);
}

function summaryModel(content, requests = []) {
  return {
    async *stream(request) {
      requests.push(request);
      yield startEvent();
      yield { type: "text_delta", text: content };
      yield {
        type: "done",
        usage: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 5,
          totalTokens: 15,
        },
      };
    },
  };
}

function longItems(prefix, count) {
  return Array.from({ length: count }, (_, index) =>
    `${prefix}-${index}: ${"x".repeat(480)}`);
}

function emptyTools() {
  return {
    listTools() {
      return [];
    },
    async executeTool(call) {
      return { ok: false, callId: call.id, error: { code: "invalid_input" } };
    },
  };
}

function readToolSchemas() {
  return [
    {
      name: "read",
      description: "Read a fixture file.",
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {
          path: { type: "string" },
        },
      }),
    },
  ];
}

function readToolExecutor(content) {
  return {
    listTools() {
      return ["read"];
    },
    async executeTool(call) {
      return {
        ok: true,
        callId: call.id,
        output: {
          path: call.input.path ?? "runtime.txt",
          content,
          startLine: 1,
          endLine: 1,
          totalLines: 1,
          truncated: false,
        },
      };
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

async function createFixture(options) {
  const root = await mkdtemp(join(tmpdir(), "pibot-compaction-"));
  const store = new FileChannelWorkspaceStore({
    rootDir: join(root, ".pibot"),
    onWarning: (warning) => {
      options.warnings?.push(warning);
    },
  });
  const session = new WorkspaceSessionStore({
    store,
    compactor: options.compactor,
  });

  return {
    store,
    session,
  };
}

async function seedLongContext(store) {
  const key = channelKey();
  await appendContext(store, {
    role: "user",
    source: "slack_log",
    eventId: "old-1",
    content:
      "目标: build a PNG grayscale script. 必须 support folder input and keep output predictable. " +
      "Extra context ".repeat(80),
  });
  await appendContext(store, {
    role: "assistant",
    source: "agent",
    content: "",
    toolCalls: [
      {
        id: "read:1",
        name: "read",
        argumentsJson: JSON.stringify({ path: "input.py" }),
      },
    ],
  });
  await appendContext(store, {
    role: "tool",
    source: "agent",
    toolCallId: "read:1",
    content: JSON.stringify({
      ok: true,
      callId: "read:1",
      output: {
        path: "input.py",
        content: "print('old')",
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        truncated: false,
      },
    }),
  });
  await appendContext(store, {
    role: "assistant",
    source: "agent",
    content: "",
    toolCalls: [
      {
        id: "write:1",
        name: "write",
        argumentsJson: JSON.stringify({
          path: "result.py",
          content: "print('new')",
          overwrite: true,
        }),
      },
    ],
  });
  await appendContext(store, {
    role: "tool",
    source: "agent",
    toolCallId: "write:1",
    content: JSON.stringify({
      ok: true,
      callId: "write:1",
      output: {
        path: "result.py",
        afterSha256: "abc",
        summary: {
          changed: true,
          afterBytes: 12,
          addedLines: 1,
          removedLines: 0,
          description: "write: created file",
        },
      },
    }),
  });
  await appendContext(store, {
    role: "assistant",
    source: "agent",
    content: "recent message stays",
  });
}

async function seedContextWithRecentMessages(store) {
  await appendContext(store, {
    role: "user",
    source: "slack_log",
    eventId: "old-1",
    content: "Old context ".repeat(100),
  });
  await appendContext(store, {
    role: "assistant",
    source: "agent",
    content: "recent-a",
  });
  await appendContext(store, {
    role: "assistant",
    source: "agent",
    content: "recent-b",
  });
  await appendContext(store, {
    role: "assistant",
    source: "agent",
    content: "recent-c",
  });
}

async function seedContextNearRuntimeThreshold(store) {
  await appendContext(store, {
    role: "user",
    source: "slack_log",
    eventId: "runtime-old-1",
    content:
      "Goal: continue a runtime compaction task. Must keep tool results usable. " +
      "Old runtime context ".repeat(160),
  });
}

async function seedContextWithRecentToolPair(store) {
  const key = channelKey();
  await appendContext(store, {
    role: "user",
    source: "slack_log",
    eventId: "old-1",
    content:
      "目标: continue current image utility task. 必须 preserve generated script behavior. " +
      "Old context ".repeat(100),
  });
  await appendContext(store, {
    role: "assistant",
    source: "agent",
    content: "Older assistant context that can be summarized.",
  });
  await appendContext(store, {
    role: "assistant",
    source: "agent",
    content: "",
    toolCalls: [
      {
        id: "write:recent",
        name: "write",
        argumentsJson: JSON.stringify({
          path: "recent.py",
          content: "print('recent')",
          overwrite: true,
        }),
      },
    ],
  });
  await appendContext(store, {
    role: "tool",
    source: "agent",
    toolCallId: "write:recent",
    content: JSON.stringify({
      ok: true,
      callId: "write:recent",
      output: {
        path: "recent.py",
        afterSha256: "recent",
        summary: {
          changed: true,
          afterBytes: 15,
          addedLines: 1,
          removedLines: 0,
          description: "write: created file",
        },
      },
    }),
  });
}

async function appendContext(store, record) {
  await store.appendContextRecord(channelKey(), {
    type: "context_message",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    ...record,
  });
}

function slackEvent(eventId, text) {
  return {
    type: "direct_message",
    eventId,
    conversation: channelKey(),
    senderUserId: "U-user",
    text,
    messageTs: `${Date.now()}.000000`,
    files: [],
    receivedAt: new Date(),
  };
}

function channelKey() {
  return {
    teamId: "T-test",
    channelId: "D-test",
  };
}

runAcceptance().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
