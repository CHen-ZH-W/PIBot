const assert = require("node:assert/strict");
const { mkdir, mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { MinimalAgentLoop } = require("../dist/agent/agent-loop");
const { PerChannelAgentRunner } = require("../dist/agent/runner");
const {
  createLlmSessionCompactor,
  createSessionCompactor,
} = require("../dist/workspace/compaction");
const { WorkspaceSessionStore } = require("../dist/workspace/session");
const { ContextManager } = require("../dist/workspace/context-manager");
const { FileChannelWorkspaceStore } = require("../dist/workspace/store");
const { WorkingSetHook } = require("../dist/runtime/working-set");
const {
  buildCodingAgentPromptParts,
} = require("../dist/agent/system-prompt");

async function runAcceptance() {
  await runCase("context projection keeps non-event messages", acceptsContextProjection);
  await runCase("context lanes replace runtime state without touching history", acceptsContextSystemLane);
  await runCase("dynamic lanes survive history replacement at the tail", acceptsDynamicTailReplacement);
  await runCase("stable prompt excludes refreshable cross-run context", acceptsStablePromptBoundary);
  await runCase("request estimates include tools and multimodal input", acceptsRequestEstimate);
  await runCase("microcompact balances warm and cold prompt caches", acceptsCacheAwareMicrocompact);
  await runCase("microcompact keeps failed and unsafe tool results", acceptsMicrocompactSafetyBoundary);
  await runCase("full compaction starts a new cache epoch", acceptsFullCompactionCacheEpoch);
  await runCase("exact user intent survives repeated compaction", acceptsExactUserIntentAcrossCompactions);
  await runCase("forced recompaction keeps the uncovered recent tail", acceptsForcedRecompactionTail);
  await runCase("request overhead can trigger proactive compaction", acceptsRequestOverheadCompaction);
  await runCase("working set rehydrates current modified files", acceptsWorkingSetRehydration);
  await runCase("raw tool results are archived before context admission", acceptsToolResultArchive);
  await runCase("context lifecycle persists active regenerable pruned and stale states", acceptsContextLifecycle);
  await runCase("long session writes a summary record", acceptsSummaryWrite);
  await runCase("compacted history preserves current goal and modified files", acceptsSummaryShape);
  await runCase("recent history is retained by token budget", acceptsRecentTokenBudget);
  await runCase("recent tool result keeps its assistant tool call", acceptsRecentToolResultPair);
  await runCase("LLM compaction writes a structured summary", acceptsLlmSummary);
  await runCase("LLM compaction keeps long summaries", acceptsLlmLongSummary);
  await runCase("invalid LLM compaction falls back to heuristic summary", acceptsLlmFallback);
  await runCase("compaction input omits complete regions", acceptsStructuredCompactionInput);
  await runCase("fallback carries the previous durable checkpoint", acceptsRepeatedFallback);
  await runCase("legacy rendered checkpoints remain inheritable", acceptsLegacyCheckpoint);
  await runCase("runner displays compaction status in Slack", acceptsRunnerCompactionStatus);
  await runCase("runner compacts context between model turns", acceptsRuntimeCompaction);
  await runCase("context overflow forces compaction and retries the run", acceptsOverflowRetry);
  await runCase("compaction failure warns and keeps original context", acceptsFailureWarning);
  console.log("Session compaction acceptance passed");
}

async function acceptsWorkingSetRehydration() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pibot-working-set-"));
  await mkdir(join(workspaceRoot, "src"));
  await writeFile(
    join(workspaceRoot, "src", "current.ts"),
    "export const current = 'first';\n",
    "utf8",
  );
  await writeFile(join(workspaceRoot, ".env"), "SECRET=must-not-leak\n", "utf8");
  const hook = new WorkingSetHook({ workspaceRoot });
  const summary = [
    "[SESSION COMPACTION SUMMARY]",
    "目标:",
    "- continue current implementation",
    "用户原始约束:",
    "- do not change the public API",
    "当前工作:",
    "- updating current.ts",
    "已改文件:",
    "- .env",
    "- src/current.ts",
    "当前代码状态:",
    "- modified: src/current.ts",
  ].join("\n");
  const request = {
    messages: [
      { role: "system", content: "base" },
      { role: "user", content: summary },
    ],
    tools: [],
  };
  const context = {
    run: { runId: "run", agentId: "agent", state: {} },
    step: 1,
    stepContext: { stepId: "turn:1" },
    request,
  };
  const first = await hook.beforeModelCall(context);

  assert.notEqual(first, undefined);
  const firstLane = first.messages.find((message) =>
    /\[pibot-context:working-set\]/u.test(message.content));
  assert.notEqual(firstLane, undefined);
  assert.match(
    firstLane.content,
    /\[pibot-context:working-set\]/u,
  );
  assert.equal(first.messages.at(-1), firstLane);
  assert.match(firstLane.content, /export const current = 'first'/u);
  assert.match(firstLane.content, /do not change the public API/u);
  assert.doesNotMatch(firstLane.content, /must-not-leak/u);
  assert.match(firstLane.content, /Path is protected/u);

  await writeFile(
    join(workspaceRoot, "src", "current.ts"),
    "export const current = 'second-current-state';\n",
    "utf8",
  );
  const second = await hook.beforeModelCall({ ...context, request: first });
  const secondLane = second.messages.find((message) =>
    /\[pibot-context:working-set\]/u.test(message.content));
  assert.notEqual(secondLane, undefined);
  assert.equal(second.messages.at(-1), secondLane);
  assert.match(secondLane.content, /second-current-state/u);
  assert.equal(
    second.messages.filter((message) =>
      /\[pibot-context:working-set\]/u.test(message.content),
    ).length,
    1,
  );
}

async function acceptsStablePromptBoundary() {
  const parts = buildCodingAgentPromptParts({
    tools: [{
      name: "read",
      description: "Read a file",
      inputSchemaJson: '{"type":"object"}',
    }],
    memories: {
      globalMemorySummary: "MEMORY_DYNAMIC_SENTINEL",
    },
    workspaceSkills: [{
      name: "dynamic-skill",
      description: "SKILL_DYNAMIC_SENTINEL",
      location: ".agents/skills/dynamic-skill/SKILL.md",
      source: "workspace",
      disableModelInvocation: false,
    }],
    repoPrompt: "REPO_DYNAMIC_SENTINEL",
    channelWorkspacePrompt: "WORKSPACE_DYNAMIC_SENTINEL",
    workspaceRoot: "/tmp/dynamic-cwd",
    mode: "execute",
    reflectionEnabled: false,
    now: new Date("2026-08-27T00:00:00Z"),
  });
  assert.match(parts.stableSystemPrompt, /Available tools/u);
  assert.doesNotMatch(parts.stableSystemPrompt, /DYNAMIC_SENTINEL/u);
  assert.doesNotMatch(parts.stableSystemPrompt, /dynamic-cwd/u);
  assert.match(parts.dynamicContext, /MEMORY_DYNAMIC_SENTINEL/u);
  assert.match(parts.dynamicContext, /SKILL_DYNAMIC_SENTINEL/u);
  assert.match(parts.dynamicContext, /REPO_DYNAMIC_SENTINEL/u);
  assert.match(parts.dynamicContext, /2026-08-27/u);

  let request;
  const loop = new MinimalAgentLoop({
    model: {
      async *stream(modelRequest) {
        request = modelRequest;
        yield { type: "text_delta", text: "done" };
        yield { type: "done" };
      },
    },
    tools: emptyTools(),
  });
  await loop.run({
    userText: "current request",
    systemPrompt: parts.stableSystemPrompt,
    dynamicContext: parts.dynamicContext,
    history: [],
    tools: [],
    maxSteps: 1,
  });
  assert.equal(request.messages[0].content, parts.stableSystemPrompt);
  assert.match(request.messages.at(-1).content, /pibot-context:run-context/u);
  assert.match(request.messages.at(-1).content, /MEMORY_DYNAMIC_SENTINEL/u);
}

async function acceptsToolResultArchive() {
  const fixture = await createFixture({});
  const hook = fixture.session.createToolResultArchiveHook(channelKey());
  const rawResult = {
    ok: true,
    callId: "read:archive",
    output: {
      path: "large.txt",
      content: "complete raw result before model admission",
      truncated: false,
    },
  };
  const archived = await hook.afterToolCall({
    run: { runId: "run", agentId: "agent" },
    step: 1,
    stepContext: { stepId: "turn:1" },
    call: {
      id: "read:archive",
      name: "read",
      input: { path: "large.txt" },
    },
    startedAtMs: Date.now(),
    durationMs: 1,
    result: rawResult,
  });
  assert.equal(archived.artifact.kind, "tool_result_blob");
  assert.equal(archived.artifact.regenerable, true);
  const root = fixture.store.getPaths(channelKey()).rootDir;
  const blob = JSON.parse(await readFile(
    join(root, archived.artifact.path),
    "utf8",
  ));
  assert.deepEqual(blob.result, rawResult);
  assert.equal(blob.resultSha256, archived.artifact.sha256);

  await fixture.session.appendContextMessage(channelKey(), {
    source: "agent",
    message: {
      role: "tool",
      toolCallId: archived.callId,
      content: JSON.stringify(archived),
    },
  });
  const messages = await fixture.session.readChannelContextMessages(channelKey());
  assert.equal(messages.at(-1).lifecycleState, "Regenerable");
}

async function acceptsContextLifecycle() {
  const fixture = await createFixture({
    contextManager: new ContextManager({
      microcompact: {
        contextWindowTokens: 2_000,
        reserveTokens: 200,
        triggerRatio: 0.5,
        targetRatio: 0.4,
        criticalRatio: 0.95,
        protectRecentTokens: 0,
        minReclaimTokens: 1,
        maxItems: 4,
      },
    }),
  });
  await fixture.session.appendContextMessage(channelKey(), {
    source: "webui",
    message: {
      role: "user",
      content: `active lifecycle user ${"prefix ".repeat(200)}`,
    },
  });
  await fixture.session.appendContextMessage(channelKey(), {
    source: "agent",
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "read:lifecycle",
        name: "read",
        argumentsJson: JSON.stringify({ path: "lifecycle.txt" }),
      }],
    },
  });
  await fixture.session.appendContextMessage(channelKey(), {
    source: "agent",
    message: {
      role: "tool",
      toolCallId: "read:lifecycle",
      content: JSON.stringify({
        ok: true,
        callId: "read:lifecycle",
        output: {
          path: "lifecycle.txt",
          content: "large regenerable result ".repeat(500),
          truncated: false,
        },
        artifact: {
          kind: "tool_result_blob",
          path: "channels/test/tool-results/lifecycle.json",
          sha256: "a".repeat(64),
          bytes: 10_000,
          toolName: "read",
          regenerable: true,
        },
      }),
    },
  });
  const before = await fixture.session.readChannelContextMessages(channelKey());
  assert.equal(before[0].lifecycleState, "Active");
  assert.equal(before[2].lifecycleState, "Regenerable");

  const prepared = await fixture.session.prepareChannelRun(channelKey());
  const refreshed = await fixture.session.compactChannelRunMessagesIfNeeded(
    prepared,
    {
      modelRequest: {
        messages: [
          { role: "system", content: "stable" },
          ...prepared.history,
        ],
        tools: [],
      },
    },
  );
  assert.equal(refreshed.microcompaction.triggered, true);
  const after = await fixture.session.readChannelContextMessages(channelKey());
  assert.equal(after[2].lifecycleState, "Pruned");
  const records = await fixture.store.readContextEntries(channelKey());
  assert.equal(
    records.some((entry) =>
      entry.record.type === "context_lifecycle" &&
      entry.record.reason === "microcompact_projection" &&
      entry.record.transitions.some((transition) =>
        transition.state === "Pruned")),
    true,
  );
}

async function acceptsDynamicTailReplacement() {
  const manager = new ContextManager();
  const request = manager.projectSystemLane({
    messages: [
      { role: "system", content: "stable system prompt" },
      { role: "user", content: "old history" },
      {
        role: "user",
        content: "Steering message received during this run:\nkeep the API stable",
      },
    ],
    tools: [],
  }, {
    id: "world-state",
    placement: "dynamic_tail",
    content: '{"mode":"execute"}',
  });
  const replaced = manager.replaceHistoryMessages(request, [
    { role: "user", content: "fresh durable history" },
  ]);

  assert.deepEqual(
    replaced.messages.map((message) => message.content),
    [
      "stable system prompt",
      "fresh durable history",
      "Steering message received during this run:\nkeep the API stable",
      request.messages.at(-1).content,
    ],
  );
  assert.match(replaced.messages.at(-1).content, /dynamic-tail/u);
}

async function acceptsCacheAwareMicrocompact() {
  const policy = {
    contextWindowTokens: 3_000,
    reserveTokens: 100,
    triggerRatio: 0.75,
    targetRatio: 0.65,
    criticalRatio: 0.98,
    protectRecentTokens: 0,
    minReclaimTokens: 50,
    warmCacheTtlMs: 5_000,
  };
  const entries = cachePolicyEntries();
  const request = {
    messages: [
      { role: "system", content: "stable prefix" },
      ...entries.map((entry) => entry.message),
    ],
    tools: readToolSchemas(),
  };
  const warmManager = new ContextManager({
    microcompact: policy,
  });
  const warm = warmManager.projectHistorySurface(entries, {
    modelRequest: request,
    preserveFromLineNumber: 7,
    recentCacheHitRatio: 0.8,
    cacheAgeMs: 1_000,
    cacheEpoch: 4,
  });

  assert.equal(warm.microcompaction.triggered, true);
  assert.equal(warm.microcompaction.cacheState, "warm_conservative");
  assert.equal(warm.microcompaction.cacheEpoch, 4);
  assert.deepEqual(
    warm.microcompaction.compactedItems.map((item) => item.lineNumber),
    [6],
  );
  const requestWithDynamicTail = warmManager.projectSystemLane(request, {
    id: "world-state",
    placement: "dynamic_tail",
    content: "runtime tail ".repeat(20),
  });
  const warmWithDynamicTail = warmManager.projectHistorySurface(entries, {
    modelRequest: requestWithDynamicTail,
    preserveFromLineNumber: 7,
    recentCacheHitRatio: 0.8,
    cacheAgeMs: 1_000,
    cacheEpoch: 4,
  });
  assert.equal(
    warmWithDynamicTail.microcompaction.protectedPrefixTokens,
    warm.microcompaction.protectedPrefixTokens,
  );
  assert.equal(
    warmWithDynamicTail.microcompaction.estimatedInvalidatedSuffixTokens >
      warm.microcompaction.estimatedInvalidatedSuffixTokens,
    true,
  );

  const cold = warmManager.projectHistorySurface(entries, {
    modelRequest: request,
    preserveFromLineNumber: 7,
    recentCacheHitRatio: 0.8,
    cacheAgeMs: 5_001,
    cacheEpoch: 4,
  });
  assert.equal(cold.microcompaction.triggered, true);
  assert.equal(cold.microcompaction.cacheState, "cold");
  assert.equal(cold.microcompaction.compactedItems[0].lineNumber, 3);
  assert.equal(
    cold.microcompaction.protectedPrefixTokens <
      warm.microcompaction.protectedPrefixTokens,
    true,
  );

}

async function acceptsMicrocompactSafetyBoundary() {
  const entries = [
    contextItem(1, { role: "user", content: "prefix ".repeat(400) }),
    contextItem(2, {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "failed-read",
        name: "read",
        argumentsJson: JSON.stringify({ path: "failed.txt" }),
      }],
    }),
    contextItem(3, {
      role: "tool",
      toolCallId: "failed-read",
      content: JSON.stringify({
        ok: false,
        callId: "failed-read",
        error: { message: "read failed ".repeat(500) },
      }),
    }),
    contextItem(4, {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "unsafe-bash",
        name: "bash",
        argumentsJson: JSON.stringify({ command: "echo changed > state.txt" }),
      }],
    }),
    contextItem(5, {
      role: "tool",
      toolCallId: "unsafe-bash",
      content: JSON.stringify({
        ok: true,
        callId: "unsafe-bash",
        output: { exitCode: 0, stdout: "unsafe output ".repeat(500) },
      }),
    }),
    contextItem(6, { role: "user", content: "current turn" }),
  ];
  const manager = new ContextManager({
    microcompact: {
      contextWindowTokens: 2_000,
      reserveTokens: 100,
      triggerRatio: 0.5,
      targetRatio: 0.4,
      protectRecentTokens: 0,
      minReclaimTokens: 10,
    },
  });
  const surface = manager.projectHistorySurface(entries, {
    modelRequest: {
      messages: [
        { role: "system", content: "stable" },
        ...entries.map((entry) => entry.message),
      ],
      tools: [],
    },
    preserveFromLineNumber: 6,
    cacheAgeMs: 999_999,
  });

  assert.equal(surface.microcompaction.reason, "no_eligible_items");
  assert.deepEqual(surface.messages, entries.map((entry) => entry.message));
}

async function acceptsFullCompactionCacheEpoch() {
  let now = new Date("2026-08-27T00:00:00.000Z");
  const contextManager = new ContextManager({
    microcompact: {
      contextWindowTokens: 120,
      reserveTokens: 40,
      triggerRatio: 0.5,
      targetRatio: 0.4,
      protectRecentTokens: 0,
      minReclaimTokens: 10,
      warmCacheTtlMs: 300_000,
    },
  });
  const fixture = await createFixture({
    clock: () => now,
    contextManager,
    compactor: createSessionCompactor({
      contextWindowTokens: 120,
      reserveTokens: 40,
      keepRecentTokens: 1,
    }),
  });
  await appendContext(fixture.store, {
    role: "user",
    source: "webui",
    content: "old compactable context",
  });
  await appendContext(fixture.store, {
    role: "assistant",
    source: "agent",
    content: "old response",
  });
  await appendContext(fixture.store, {
    role: "user",
    source: "webui",
    content: "current request",
  });
  const prepared = await fixture.session.prepareChannelRun(channelKey());
  fixture.session.observePromptCacheUsage(channelKey(), {
    inputTokens: 100,
    cachedInputTokens: 80,
    outputTokens: 10,
    totalTokens: 110,
  });
  now = new Date(now.getTime() + 1_000);
  const refreshed = await fixture.session.compactChannelRunMessagesIfNeeded(
    prepared,
    {
      modelRequest: {
        messages: [
          { role: "system", content: "large stable prefix ".repeat(20) },
          ...prepared.history,
        ],
        tools: [],
      },
      currentUserMessage: { role: "user", content: "current request" },
    },
  );

  assert.equal(refreshed.compaction.triggered, true);
  assert.equal(refreshed.microcompaction.cacheEpoch, 1);
  assert.equal(refreshed.microcompaction.cacheState, "cold");
}

async function acceptsExactUserIntentAcrossCompactions() {
  const fixture = await createFixture({
    compactor: createSessionCompactor({
      contextWindowTokens: 500,
      reserveTokens: 100,
      keepRecentTokens: 1,
    }),
  });
  const firstUser = "First exact user request.\nDo not rename public_api().";
  const secondUser = "Second exact user request.\n必须保留第一条用户原话。";
  await appendContext(fixture.store, {
    role: "user",
    source: "webui",
    content: firstUser,
  });
  await appendContext(fixture.store, {
    role: "assistant",
    source: "agent",
    content: "first compactable work ".repeat(60),
  });
  await appendContext(fixture.store, {
    role: "assistant",
    source: "agent",
    content: "first recent tail",
  });
  const first = await fixture.session.forceCompact(channelKey());
  assert.equal(first.triggered, true);
  assert.equal(first.protectedUserIntentTokensAfter > 0, true);

  await appendContext(fixture.store, {
    role: "user",
    source: "webui",
    content: secondUser,
  });
  await appendContext(fixture.store, {
    role: "assistant",
    source: "agent",
    content: "second compactable work ".repeat(60),
  });
  await appendContext(fixture.store, {
    role: "assistant",
    source: "agent",
    content: "second recent tail",
  });
  const second = await fixture.session.forceCompact(channelKey());
  assert.equal(second.triggered, true);
  assert.equal(second.protectedUserIntentTokensBefore > 0, true);
  assert.equal(
    second.protectedUserIntentTokensAfter >
      second.protectedUserIntentTokensBefore,
    true,
  );
  assert.equal(first.summaryHierarchy.level, 1);
  assert.equal(second.summaryHierarchy.level, 2);
  assert.equal(second.summaryHierarchy.parentSummaryLineNumbers.length, 1);
  const hierarchicalRecords = (await fixture.store.readContextEntries(channelKey()))
    .filter((entry) => entry.record.source === "compaction");
  assert.equal(hierarchicalRecords[0].record.summaryHierarchy.level, 1);
  assert.equal(hierarchicalRecords[1].record.summaryHierarchy.level, 2);
  assert.deepEqual(
    hierarchicalRecords[1].record.summaryHierarchy.parentSummaryLineNumbers,
    [hierarchicalRecords[0].lineNumber],
  );

  const history = await fixture.session.readContextMessages(channelKey());
  assert.equal(
    history.filter((message) => message.content === firstUser).length,
    1,
  );
  assert.equal(
    history.filter((message) => message.content === secondUser).length,
    1,
  );
  assert.equal(
    history.filter((message) =>
      message.content.includes("[pibot-context:exact-user-intent]"),
    ).length,
    1,
  );

  const summariesBefore = (await fixture.store.readContextEntries(channelKey()))
    .filter((entry) => entry.record.source === "compaction").length;
  const prepared = await fixture.session.prepareChannelRun(channelKey());
  const refreshed = await fixture.session.compactChannelRunMessagesIfNeeded(
    prepared,
    {
      modelRequest: {
        messages: [
          { role: "system", content: "large request overhead ".repeat(200) },
          ...prepared.history,
        ],
        tools: [],
      },
    },
  );
  const summariesAfter = (await fixture.store.readContextEntries(channelKey()))
    .filter((entry) => entry.record.source === "compaction").length;
  assert.equal(refreshed.compaction.triggered, false);
  assert.equal(summariesAfter, summariesBefore);
}

async function acceptsForcedRecompactionTail() {
  const fixture = await createFixture({
    compactor: createSessionCompactor({
      contextWindowTokens: 500,
      reserveTokens: 100,
      keepRecentTokens: 1,
    }),
  });
  const exactUser = "Exact user request before forced recompaction.";
  const recentTail = "Recent tail must survive summary-only recompaction.";
  await appendContext(fixture.store, {
    role: "user",
    source: "webui",
    content: exactUser,
  });
  await appendContext(fixture.store, {
    role: "assistant",
    source: "agent",
    content: recentTail,
  });
  const first = await fixture.session.forceCompact(channelKey());
  const second = await fixture.session.forceCompact(channelKey());
  assert.equal(first.triggered, true);
  assert.equal(second.triggered, true);
  assert.equal(
    second.coveredThroughLineNumber,
    first.coveredThroughLineNumber,
  );

  const history = await fixture.session.readContextMessages(channelKey());
  assert.equal(
    history.filter((message) => message.content === recentTail).length,
    1,
  );
  assert.equal(
    history.filter((message) => message.content === exactUser).length,
    1,
  );
  assert.equal(
    history.filter((message) =>
      message.content.includes("[SESSION COMPACTION SUMMARY]"),
    ).length,
    1,
  );
}

async function acceptsContextSystemLane() {
  const manager = new ContextManager();
  const base = {
    messages: [
      { role: "system", content: "base" },
      { role: "user", content: "durable user history" },
    ],
    tools: [],
  };
  const first = manager.projectSystemLane(base, {
    id: "world-state",
    content: '{"mode":"execute"}',
  });
  const second = manager.projectSystemLane(first, {
    id: "world-state",
    content: '{"mode":"plan"}',
  });

  assert.equal(second.messages.length, 3);
  assert.equal(second.messages[0].content, "base");
  assert.match(second.messages[1].content, /\[pibot-context:world-state\]/u);
  assert.match(second.messages[1].content, /"plan"/u);
  assert.equal(second.messages[2].content, "durable user history");
  assert.equal(
    second.messages.some((message) => /"execute"/u.test(message.content)),
    false,
  );
}

async function acceptsRequestEstimate() {
  const manager = new ContextManager();
  const request = {
    messages: [{
      role: "user",
      content: "ignored when provider content parts are present",
      contentParts: [
        { type: "text", text: "inspect this image" },
        { type: "image_url", imageUrl: { url: "data:image/png;base64,AAAA" } },
      ],
    }],
    tools: [{
      name: "read",
      description: "Read a file".repeat(20),
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: { path: { type: "string" } },
      }),
    }],
  };
  const estimate = manager.estimateModelRequest(request);
  const budget = manager.estimateModelRequestBudget(request, {
    contextWindowTokens: 2_000,
    reserveTokens: 100,
  });

  assert.equal(estimate.imageCount, 1);
  assert.equal(estimate.imageTokens, 1_700);
  assert.equal(estimate.toolTokens > 0, true);
  assert.equal(estimate.totalTokens, estimate.messageTokens + estimate.toolTokens);
  assert.equal(budget.overBudget, false);
  assert.equal(budget.remainingInputTokens, 1_900 - estimate.totalTokens);
}

async function acceptsRequestOverheadCompaction() {
  const fixture = await createFixture({
    compactor: createSessionCompactor({
      contextWindowTokens: 120,
      reserveTokens: 40,
      keepRecentTokens: 1,
    }),
  });
  await appendContext(fixture.store, {
    role: "user",
    source: "webui",
    content: "old but compactable context",
  });
  await appendContext(fixture.store, {
    role: "assistant",
    source: "agent",
    content: "old response",
  });
  await appendContext(fixture.store, {
    role: "user",
    source: "webui",
    content: "raw current request",
  });
  const prepared = await fixture.session.prepareChannelRun(channelKey());
  assert.equal(prepared.compaction?.triggered === true, false);

  const refreshed = await fixture.session.compactChannelRunMessagesIfNeeded(
    prepared,
    {
      modelRequest: {
        messages: [
          { role: "system", content: "large system prompt ".repeat(20) },
          ...prepared.history,
        ],
        tools: [{
          name: "large_tool",
          description: "large schema ".repeat(20),
          inputSchemaJson: '{"type":"object"}',
        }],
      },
      currentUserMessage: {
        role: "user",
        content: "formatted exact current request",
      },
    },
  );

  assert.equal(refreshed.compaction?.triggered, true);
  assert.equal(refreshed.compaction.additionalInputTokens > 0, true);
  assert.equal(
    refreshed.messages.some(
      (message) => message.content === "formatted exact current request",
    ),
    true,
  );
  assert.equal(
    refreshed.messages.some(
      (message) => message.content === "raw current request",
    ),
    false,
  );
  assert.equal(
    refreshed.compaction.estimatedTokensBefore,
    refreshed.compaction.estimatedHistoryTokensBefore +
      refreshed.compaction.additionalInputTokens,
  );
}

async function acceptsContextProjection() {
  const fixture = await createFixture({});
  await appendContext(fixture.store, {
    role: "user",
    source: "slack_log",
    eventId: "projection-user",
    content: "Projection user message",
  });
  await appendContext(fixture.store, {
    role: "assistant",
    source: "agent",
    content: "Projection assistant message",
  });

  const prepared = await fixture.session.prepareChannelRun(channelKey());
  assert.deepEqual(
    prepared.history.map((message) => message.content),
    ["Projection user message", "Projection assistant message"],
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
  const lifecycle = records
    .map((entry) => entry.record)
    .find((record) =>
      record.type === "context_lifecycle" && record.reason === "full_compact");
  assert.notEqual(lifecycle, undefined);
  assert.equal(
    lifecycle.transitions.some((transition) => transition.state === "Stale"),
    true,
  );
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
  const exactIntentHeader = prepared.history.find((message) =>
    message.content.includes("[pibot-context:exact-user-intent]"));
  const exactUserMessage = prepared.history.find(
    (message) =>
      message.role === "user" &&
      message.content.startsWith("目标: build a PNG grayscale script"),
  );
  assert.notEqual(exactIntentHeader, undefined);
  assert.notEqual(exactUserMessage, undefined);
  assert.match(exactUserMessage.content, /必须 support folder input/u);
  assert.equal(
    prepared.history.indexOf(exactIntentHeader) <
      prepared.history.indexOf(exactUserMessage),
    true,
  );
  assert.equal(prepared.history.length, 4);
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
  assert.match(summary.content, /当前工作:/u);
  assert.match(summary.content, /用户原始约束:/u);
  assert.match(summary.content, /Use a deterministic conversion/u);
  assert.equal(Array.isArray(summary.summaryFacts.exactUserConstraints), true);
  assert.equal(
    summary.summaryFacts.exactUserConstraints.some((constraint) =>
      constraint.includes("必须 support folder input")),
    true,
  );
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

async function acceptsStructuredCompactionInput() {
  const summaryRequests = [];
  const fixture = await createFixture({
    compactor: createLlmSessionCompactor({
      contextWindowTokens: 200,
      reserveTokens: 50,
      keepRecentTokens: 1,
      model: summaryModel(validSummaryFacts("structured regions"), summaryRequests),
    }),
  });
  await appendContext(fixture.store, {
    role: "user",
    source: "slack_log",
    eventId: "structured-first",
    content: "First request must preserve tool pairs.",
  });
  await appendContext(fixture.store, {
    role: "assistant",
    source: "agent",
    content: "middle assistant context ".repeat(80),
  });
  await appendContext(fixture.store, {
    role: "assistant",
    source: "agent",
    content: "",
    toolCalls: [{
      id: "structured-tool",
      name: "read",
      argumentsJson: JSON.stringify({ path: "large.txt" }),
    }],
  });
  await appendContext(fixture.store, {
    role: "tool",
    source: "agent",
    toolCallId: "structured-tool",
    content: JSON.stringify({
      ok: true,
      callId: "structured-tool",
      output: { path: "large.txt", content: "tool output ".repeat(100) },
    }),
  });
  await appendContext(fixture.store, {
    role: "user",
    source: "slack_log",
    eventId: "structured-last",
    content: "Latest pending work stays visible.",
  });
  await appendContext(fixture.store, {
    role: "assistant",
    source: "agent",
    content: "Recent tail remains active.",
  });

  await fixture.session.forceCompact(channelKey());
  const transcript = summaryRequests[0].messages.at(-1).content;
  assert.match(transcript, /complete context region\(s\) omitted/u);
  assert.doesNotMatch(transcript, /older transcript middle truncated/u);
  assert.match(transcript, /First request must preserve tool pairs/u);
  assert.match(transcript, /Latest pending work stays visible/u);
}

async function acceptsRepeatedFallback() {
  const model = summaryModelSequence([
    validSummaryFacts("durable checkpoint sentinel"),
    "not-json",
  ]);
  const fixture = await createFixture({
    compactor: createLlmSessionCompactor({
      contextWindowTokens: 100,
      reserveTokens: 40,
      keepRecentTokens: 1,
      model,
    }),
  });
  await seedLongContext(fixture.store);
  await fixture.session.prepareRun(slackEvent("first-compact", "Continue"));
  await appendContext(fixture.store, {
    role: "user",
    source: "slack_log",
    eventId: "second-compact",
    content: "Continue after checkpoint. 必须 preserve the durable checkpoint.",
  });
  await appendContext(fixture.store, {
    role: "assistant",
    source: "agent",
    content: "New work after the first checkpoint. ".repeat(30),
  });

  await fixture.session.forceCompact(channelKey());
  const summary = await latestSummary(fixture.store);
  assert.equal(summary.summaryStrategy, "heuristic_fallback");
  assert.match(summary.content, /durable checkpoint sentinel/u);
  assert.equal(
    summary.summaryFacts.decisions.some((decision) =>
      decision.includes("durable checkpoint sentinel")),
    true,
  );
  assert.equal(
    summary.summaryFacts.exactUserConstraints.some((constraint) =>
      constraint.includes("必须 preserve the durable checkpoint")),
    true,
  );
}

async function acceptsLegacyCheckpoint() {
  const fixture = await createFixture({
    compactor: createSessionCompactor({
      contextWindowTokens: 100,
      reserveTokens: 40,
      keepRecentTokens: 1,
    }),
  });
  await appendContext(fixture.store, {
    role: "user",
    source: "slack_log",
    eventId: "legacy-covered",
    content: "Covered legacy history.",
  });
  await appendContext(fixture.store, {
    role: "user",
    source: "compaction",
    compactionKind: "session_summary",
    coveredThroughLineNumber: 1,
    content: [
      "[SESSION COMPACTION SUMMARY]",
      "",
      "目标:",
      "- Legacy checkpoint goal",
      "",
      "决策:",
      "- legacy decision sentinel",
      "",
      "下一步:",
      "- Continue legacy work",
    ].join("\n"),
  });
  await appendContext(fixture.store, {
    role: "assistant",
    source: "agent",
    content: "New compactable work after the legacy checkpoint. ".repeat(20),
  });
  await appendContext(fixture.store, {
    role: "assistant",
    source: "agent",
    content: "Recent tail after legacy summary.",
  });

  await fixture.session.forceCompact(channelKey());
  const summary = await latestSummary(fixture.store);
  assert.match(summary.content, /legacy decision sentinel/u);
  assert.equal(
    summary.summaryFacts.decisions.includes("legacy decision sentinel"),
    true,
  );
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
      if (requests.length <= 2) {
        yield {
          type: "tool_call",
          call: {
            id: `read:runtime:${requests.length}`,
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

  assert.equal(requests.length, 3);
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
  assert.equal(
    requests[2].messages.some((message) =>
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

function summaryModelSequence(contents, requests = []) {
  let index = 0;
  return {
    async *stream(request) {
      requests.push(request);
      const content = contents[Math.min(index, contents.length - 1)];
      index += 1;
      yield startEvent();
      yield { type: "text_delta", text: content };
      yield { type: "done" };
    },
  };
}

function validSummaryFacts(goal) {
  return JSON.stringify({
    goal,
    constraints: [],
    exactUserConstraints: [],
    technicalContext: [],
    progress: [],
    currentWork: [],
    pendingTasks: [],
    decisions: [`checkpoint: ${goal}`],
    attemptedApproaches: [],
    errorsAndFixes: [],
    nextSteps: [],
    readFiles: [],
    modifiedFiles: [],
    fileOperations: [],
    currentCodeState: [],
    verificationState: [],
  });
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
    contextManager: options.contextManager,
    clock: options.clock,
  });

  return {
    store,
    session,
  };
}

function cachePolicyEntries() {
  return [
    contextItem(1, { role: "user", content: "old prefix ".repeat(200) }),
    contextItem(2, {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "read-old",
        name: "read",
        argumentsJson: JSON.stringify({ path: "old.txt" }),
      }],
    }),
    contextItem(3, {
      role: "tool",
      toolCallId: "read-old",
      content: JSON.stringify({
        ok: true,
        callId: "read-old",
        output: {
          path: "old.txt",
          content: "old read output ".repeat(100),
          startLine: 1,
          endLine: 100,
          totalLines: 100,
          truncated: false,
        },
      }),
    }),
    contextItem(4, { role: "assistant", content: "middle ".repeat(860) }),
    contextItem(5, {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "read-late",
        name: "read",
        argumentsJson: JSON.stringify({ path: "late.txt" }),
      }],
    }),
    contextItem(6, {
      role: "tool",
      toolCallId: "read-late",
      content: JSON.stringify({
        ok: true,
        callId: "read-late",
        output: {
          path: "late.txt",
          content: "late read output ".repeat(100),
          startLine: 1,
          endLine: 100,
          totalLines: 100,
          truncated: false,
        },
      }),
    }),
    contextItem(7, { role: "user", content: "current turn ".repeat(20) }),
  ];
}

function contextItem(lineNumber, message) {
  return {
    lineNumber,
    message,
    isCompactionSummary: false,
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
