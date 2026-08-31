const assert = require("node:assert/strict");
const { mkdir, mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
  createCodingToolExecutor,
  createToolApprovalGate,
} = require("../dist/tools");
const { FileChannelWorkspaceStore } = require("../dist/workspace/store");
const { WorkspaceSessionStore } = require("../dist/workspace/session");
const { MemoryCurationPipeline } = require("../dist/workspace/memory-curation");
const { MemoryUsageRuntimeHook } = require("../dist/runtime/memory-usage");
const {
  captureAgentStepContext,
  createAgentRunContext,
} = require("../dist/runtime/context");

async function runAcceptance() {
  await runCase("memory tools write topics and concise indexes", acceptsMemoryWriteAndRead);
  await runCase("memory tools write Codex-like memory documents", acceptsCodexLikeMemoryDocuments);
  await runCase("memory store records run rollout summaries", acceptsRunRolloutSummarySedimentation);
  await runCase("rollout routing stays bounded and keeps the newest recaps", acceptsBoundedRolloutRouting);
  await runCase("memory curation stages then consolidates reusable knowledge", acceptsMemoryCurationPipeline);
  await runCase("one run can consolidate separate semantic Task Groups", acceptsMultiTopicMemoryCuration);
  await runCase("memory curation keeps risky preferences pending", acceptsRiskyMemoryCandidateStaging);
  await runCase("historical metadata alone cannot become routed knowledge", acceptsHistoricalOnlyCandidateRejection);
  await runCase("memory curation no-ops when a run has no durable value", acceptsMemoryCurationNoop);
  await runCase("timed-out curation stays durable and recovers on restart", acceptsMemoryCurationTimeoutRecovery);
  await runCase("historical rollout backfill is bounded and idempotent", acceptsHistoricalRolloutBackfill);
  await runCase("successful memory reads record usage feedback", acceptsMemoryUsageFeedback);
  await runCase("usage feedback reorders routing without deleting topics", acceptsUsageWeightedRouting);
  await runCase("validated outcomes retire and reactivate routed memory", acceptsEvidenceGatedMemoryLifecycle);
  await runCase("weak contradiction evidence stays reviewable", acceptsWeakLifecycleEvidenceReview);
  await runCase("memory tools read legacy topic fallback", acceptsLegacyMemoryTopicFallback);
  await runCase("memory mutations append an audit log and can be deleted", acceptsMemoryAuditAndDelete);
  await runCase("MEMORY.md index length is limited", acceptsMemoryIndexLimit);
  console.log("Memory acceptance passed");
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

async function acceptsMemoryWriteAndRead() {
  const fixture = await createFixture();
  await writeFile(join(fixture.storeRoot, "instructions.md"), "Always run tests.\n", "utf8");
  await writeFile(join(fixture.channelDir, "instructions.md"), "Prefer TypeScript.\n", "utf8");

  const topicWrite = await execute(fixture.tools, {
    id: "memory-topic-write",
    name: "memory_write",
    input: {
      scope: "global",
      document: "topic",
      topic: "preferences",
      content: "# Preferences\n\n- Use focused tests.\n",
      reason: "Remember the user's testing preference",
    },
  });
  const indexWrite = await execute(fixture.tools, {
    id: "memory-index-write",
    name: "memory_write",
    input: {
      scope: "global",
      document: "index",
      content: "# Memory\n\n- [preferences](memory/preferences.md)\n",
      reason: "Add a concise index link for the preference topic",
    },
  });
  const topicRead = await execute(fixture.tools, {
    id: "memory-topic-read",
    name: "memory_read",
    input: {
      scope: "global",
      document: "topic",
      topic: "preferences",
    },
  });
  const promptMemories = await fixture.store.readMemories(channelKey());

  assert.equal(topicWrite.ok, true);
  assert.equal(indexWrite.ok, true);
  assert.equal(topicRead.ok, true);
  assert.match(topicRead.output.content, /focused tests/u);
  assert.equal(promptMemories.globalInstructions, "Always run tests.\n");
  assert.equal(promptMemories.channelInstructions, "Prefer TypeScript.\n");
  assert.match(promptMemories.globalMemory, /preferences/u);
  assert.equal(
    await readFile(
      join(
        fixture.storeRoot,
        "memories",
        "topics",
        "preferences.md",
      ),
      "utf8",
    ),
    "# Preferences\n\n- Use focused tests.\n",
  );
}

async function acceptsCodexLikeMemoryDocuments() {
  const fixture = await createFixture();
  await execute(fixture.tools, {
    id: "memory-summary-write",
    name: "memory_write",
    input: {
      scope: "global",
      document: "summary",
      content: "v1\n\n- Use memory indexes as routing maps.\n",
      reason: "Capture the compact memory summary",
    },
  });
  await execute(fixture.tools, {
    id: "memory-rollout-write",
    name: "memory_write",
    input: {
      scope: "global",
      document: "rollout_summary",
      topic: "2026-07-04-memory-layout",
      content: "# Memory Layout\n\n- Added Codex-like memory documents.\n",
      reason: "Capture a completed task summary",
    },
  });
  await execute(fixture.tools, {
    id: "memory-extension-write",
    name: "memory_write",
    input: {
      scope: "global",
      document: "extension_note",
      topic: "memory-candidate",
      content: "# Candidate\n\n- Review before merging into registry.\n",
      reason: "Stage a memory candidate for later curation",
    },
  });

  const memories = await fixture.store.readMemories(channelKey());
  const rollout = await execute(fixture.tools, {
    id: "memory-rollout-read",
    name: "memory_read",
    input: {
      scope: "global",
      document: "rollout_summary",
      topic: "2026-07-04-memory-layout",
    },
  });
  const note = await execute(fixture.tools, {
    id: "memory-extension-read",
    name: "memory_read",
    input: {
      scope: "global",
      document: "extension_note",
      topic: "memory-candidate",
    },
  });

  assert.match(memories.globalMemorySummary, /routing maps/u);
  assert.match(memories.globalMemory, /Recent Rollout Summaries/u);
  assert.match(memories.globalMemory, /2026-07-04-memory-layout/u);
  assert.match(memories.globalMemory, /Pending Extension Notes/u);
  assert.match(memories.globalMemory, /memory-candidate/u);
  assert.match(memories.globalMemorySummary, /Pending Extension Notes/u);
  assert.match(memories.globalMemorySummary, /memory-candidate/u);
  assert.equal(rollout.ok, true);
  assert.match(rollout.output.path, /memories\/rollout_summaries\/2026-07-04-memory-layout\.md/u);
  assert.match(rollout.output.content, /Codex-like memory documents/u);
  assert.equal(note.ok, true);
  assert.match(note.output.path, /extensions\/ad_hoc\/notes\/memory-candidate\.md/u);
  assert.match(note.output.content, /Review before merging/u);

  const deletedNote = await execute(fixture.tools, {
    id: "memory-extension-delete",
    name: "memory_delete",
    input: {
      scope: "global",
      document: "extension_note",
      topic: "memory-candidate",
      reason: "Candidate was reviewed and no longer needs pending status",
    },
  });
  const afterDeleteMemories = await fixture.store.readMemories(channelKey());

  assert.equal(deletedNote.ok, true);
  assert.doesNotMatch(afterDeleteMemories.globalMemory ?? "", /memory-candidate/u);
  assert.doesNotMatch(afterDeleteMemories.globalMemorySummary ?? "", /memory-candidate/u);
}

async function acceptsRunRolloutSummarySedimentation() {
  const fixture = await createFixture();
  const sessions = new WorkspaceSessionStore({
    store: fixture.store,
    clock: () => new Date("2026-07-04T12:00:00.000Z"),
  });

  await sessions.recordRunRolloutSummary({
    key: channelKey(),
    runId: "run-memory-sedimentation",
    userText: "Fix the memory sedimentation path.",
    reason: "completed",
    steps: 2,
    messages: [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tool-read",
            name: "read",
            argumentsJson: "{\"path\":\"src/workspace/store.ts\"}",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "tool-read",
        content: "store content",
      },
      {
        role: "assistant",
        content: "Implemented memory sedimentation.",
      },
    ],
    source: {
      type: "system",
      runId: "run-memory-sedimentation",
    },
  });

  const rollout = await fixture.store.readMemoryDocument(channelKey(), {
    scope: "global",
    document: "rollout_summary",
    topic: "run-20260704-run-memory-sedimentation",
  });
  const memories = await fixture.store.readMemories(channelKey());

  assert.match(rollout.path, /rollout_summaries\/run-20260704-run-memory-sedimentation\.md/u);
  assert.match(rollout.content, /Fix the memory sedimentation path/u);
  assert.match(rollout.content, /Implemented memory sedimentation/u);
  assert.match(rollout.content, /Tools used: read/u);
  assert.match(memories.globalMemory, /Recent Rollout Summaries/u);
  assert.match(memories.globalMemory, /run-20260704-run-memory-sedimentation/u);
}

async function acceptsBoundedRolloutRouting() {
  const fixture = await createFixture();
  const sessions = new WorkspaceSessionStore({ store: fixture.store });
  for (let index = 0; index < 12; index += 1) {
    await sessions.recordRunRolloutSummary({
      ...memoryRunRequest(`bounded-rollout-${String(index).padStart(2, "0")}`),
      createdAt: new Date(`2026-07-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`),
    });
  }

  const memories = await fixture.store.readMemories(channelKey());
  const rolloutLinks = memories.globalMemory.match(/rollout_summaries\//gu) ?? [];

  assert.equal(rolloutLinks.length, 5);
  assert.match(memories.globalMemory, /bounded-rollout-11/u);
  assert.doesNotMatch(memories.globalMemory, /bounded-rollout-00/u);
  assert.ok(Buffer.byteLength(memories.globalMemory, "utf8") <= 8000);
}

async function acceptsMemoryCurationPipeline() {
  const fixture = await createFixture();
  const runId = "run-memory-curation";
  let modelRefResolutions = 0;
  const model = createQueuedModel([
    {
      candidate: {
        targetTopic: "memory-curation",
        title: "Persistent memory curation",
        scope: "PIBot run evidence to accepted reusable memory",
        appliesTo: "PIBot memory runtime",
        reuseRule: "Recheck current source and preserve validation boundaries",
        keywords: ["memory", "curation", "evidence", "consolidation"],
        risk: "low",
        claims: [{
          type: "workflow",
          statement: "Stage extracted claims before mutating accepted Task Groups.",
          trigger: "When a completed run contains reusable knowledge",
          scope: "Run-end persistent-memory processing",
          reuseRule: "Consolidate against existing accepted topics and preserve provenance",
          durability: "durable",
          verifiedBy: ["source_inspection", "focused_test"],
          notVerified: ["production_observation"],
        }],
      },
    },
    {
      decision: "accept",
      reason: "Adds a reusable workflow without conflicting accepted knowledge",
      taskGroup: {
        schemaVersion: 1,
        topic: "memory-curation",
        title: "Persistent memory curation",
        scope: "PIBot run evidence to accepted reusable memory",
        appliesTo: "PIBot memory runtime",
        reuseRule: "Recheck current source and preserve validation boundaries",
        keywords: ["memory", "curation", "evidence", "consolidation"],
        description: "A completed run may contain reusable knowledge that needs staged consolidation",
        learning: "Evidence, candidates, and accepted knowledge remain separate states",
        importance: "critical",
        userPreferences: [],
        reusableKnowledge: [{
          id: "stage-before-accept",
          statement: "Stage extracted claims before mutating accepted Task Groups.",
          trigger: "When a completed run contains reusable knowledge",
          scope: "Run-end persistent-memory processing",
          reuseRule: "Compare with accepted topics, merge duplicates, and preserve provenance",
          sourceRuns: [runId],
          verifiedBy: ["source_inspection", "focused_test"],
          notVerified: ["production_observation"],
        }],
        failures: [],
        verificationBoundaries: [{
          claim: "The curation path is source-inspected and focused-test verified, not production observed.",
          verifiedBy: ["source_inspection", "focused_test"],
          notVerified: ["production_observation"],
          sourceRuns: [runId],
        }],
        historicalState: [],
        sourceRuns: [runId],
      },
    },
  ]);
  const curator = new MemoryCurationPipeline({
    store: fixture.store,
    model,
    resolveModelRef: () => {
      modelRefResolutions += 1;
      return { provider: "test-provider", model: "memory-model" };
    },
    clock: () => new Date("2026-07-05T12:00:00.000Z"),
  });
  const sessions = new WorkspaceSessionStore({
    store: fixture.store,
    memoryCurator: curator,
    clock: () => new Date("2026-07-05T12:00:00.000Z"),
  });

  await sessions.recordRunRolloutSummary(memoryRunRequest(runId));
  await curator.waitForIdle();

  const topic = await fixture.store.readMemoryDocument(channelKey(), {
    scope: "global",
    document: "topic",
    topic: "memory-curation",
  });
  const notes = await fixture.store.listMemoryDocuments(channelKey(), "extension_note");
  const memories = await fixture.store.readMemories(channelKey());
  const audit = await fixture.store.readMemoryDocument(channelKey(), {
    scope: "global",
    document: "audit",
  });
  const events = audit.content.trim().split("\n").map((line) => JSON.parse(line));
  const jobs = await fixture.store.listMemoryCurationJobs();

  assert.equal(model.requests.length, 2);
  assert.equal(modelRefResolutions, 1);
  assert.equal(
    model.requests.every((request) => request.modelRef.model === "memory-model"),
    true,
  );
  assert.match(model.requests[0].messages[1].content, /Fix persistent memory curation/u);
  assert.match(topic.content, /# Task Group: Persistent memory curation/u);
  assert.match(topic.content, /stage-before-accept/u);
  assert.match(topic.content, /Not verified: production_observation/u);
  assert.match(topic.content, /Last validated: 2026-07-05T12:00:00\.000Z/u);
  assert.match(topic.content, new RegExp(runId, "u"));
  assert.equal(notes.length, 1);
  assert.equal(jobs.length, 0);
  assert.match(notes[0].content, /status: accepted/u);
  assert.match(memories.globalMemory, /Accepted Task Groups/u);
  assert.match(memories.globalMemory, /memory-curation/u);
  assert.match(memories.globalMemorySummary, /Memory Routing/u);
  assert.match(memories.globalMemorySummary, /Evidence, candidates, and accepted knowledge/u);
  assert.deepEqual(
    events.filter((event) => event.type === "memory_curation").map((event) => event.action),
    ["candidate_staged", "routing_rebuilt", "candidate_accepted", "run_completed"],
  );
}

async function acceptsMultiTopicMemoryCuration() {
  const fixture = await createFixture();
  const runId = "run-multi-topic-memory";
  const model = createQueuedModel([
    {
      candidates: [
        candidateFixture("runtime-memory", "Runtime memory"),
        candidateFixture("webui-memory", "WebUI memory"),
      ],
    },
    {
      decision: "accept",
      reason: "Runtime workflow is reusable",
      taskGroup: taskGroupFixture("runtime-memory", "Runtime memory", runId),
    },
    {
      decision: "accept",
      reason: "WebUI workflow is a separate semantic group",
      taskGroup: taskGroupFixture("webui-memory", "WebUI memory", runId),
    },
  ]);
  const curator = new MemoryCurationPipeline({
    store: fixture.store,
    model,
    clock: () => new Date("2026-07-05T13:00:00.000Z"),
  });
  const sessions = new WorkspaceSessionStore({ store: fixture.store, memoryCurator: curator });

  await sessions.recordRunRolloutSummary(memoryRunRequest(runId));
  await curator.waitForIdle();

  const topics = await fixture.store.listMemoryDocuments(channelKey(), "topic");
  const notes = await fixture.store.listMemoryDocuments(channelKey(), "extension_note");
  const memories = await fixture.store.readMemories(channelKey());

  assert.equal(model.requests.length, 3);
  assert.deepEqual(topics.map((value) => value.topic), ["runtime-memory", "webui-memory"]);
  assert.equal(notes.length, 2);
  assert.equal(notes.every((value) => /status: accepted/u.test(value.content)), true);
  assert.match(memories.globalMemorySummary, /runtime-memory/u);
  assert.match(memories.globalMemorySummary, /webui-memory/u);
}

async function acceptsRiskyMemoryCandidateStaging() {
  const fixture = await createFixture();
  const model = createQueuedModel([{
    candidate: {
      targetTopic: "user-preferences",
      title: "User memory preference",
      scope: "Persistent memory behavior",
      appliesTo: "PIBot",
      reuseRule: "Require user review before changing future behavior",
      keywords: ["preference", "memory"],
      risk: "review",
      reviewReason: "This changes future agent behavior",
      claims: [{
        type: "preference",
        statement: "Always accept every extracted candidate.",
        trigger: "Whenever curation runs",
        scope: "All PIBot runs",
        reuseRule: "Do not apply without explicit user confirmation",
        durability: "durable",
        verifiedBy: ["user_message"],
        notVerified: ["explicit_confirmation"],
      }],
    },
  }]);
  const curator = new MemoryCurationPipeline({
    store: fixture.store,
    model,
    clock: () => new Date("2026-07-06T12:00:00.000Z"),
  });
  const sessions = new WorkspaceSessionStore({ store: fixture.store, memoryCurator: curator });

  await sessions.recordRunRolloutSummary(memoryRunRequest("run-memory-review"));
  await curator.waitForIdle();

  const notes = await fixture.store.listMemoryDocuments(channelKey(), "extension_note");
  const topics = await fixture.store.listMemoryDocuments(channelKey(), "topic");
  const memories = await fixture.store.readMemories(channelKey());

  assert.equal(model.requests.length, 1);
  assert.equal(notes.length, 1);
  assert.match(notes[0].content, /status: needs_review/u);
  assert.equal(topics.length, 0);
  assert.match(memories.globalMemory, /Pending Extension Notes/u);
  assert.match(memories.globalMemory, /Pending memory candidate/u);
  assert.doesNotMatch(memories.globalMemory, /Always accept every extracted candidate/u);
}

async function acceptsHistoricalOnlyCandidateRejection() {
  const fixture = await createFixture();
  const runId = "run-memory-historical-only";
  const model = createQueuedModel([
    {
      candidate: {
        targetTopic: "historical-runtime-state",
        title: "Historical runtime state",
        scope: "One observed runtime snapshot",
        appliesTo: "PIBot at the source-run time",
        reuseRule: "Never treat this snapshot as current without revalidation",
        keywords: ["historical", "runtime"],
        risk: "low",
        claims: [{
          type: "historical_state",
          statement: "The runtime used a temporary model configuration.",
          trigger: "When investigating the historical run",
          scope: "Source-run snapshot only",
          reuseRule: "Recheck current configuration",
          durability: "historical",
          verifiedBy: ["runtime_observation"],
          notVerified: ["current_configuration"],
        }],
      },
    },
    {
      decision: "accept",
      reason: "Preserve the old runtime snapshot",
      taskGroup: {
        schemaVersion: 1,
        topic: "historical-runtime-state",
        title: "Historical runtime state",
        scope: "One observed runtime snapshot",
        appliesTo: "PIBot at the source-run time",
        reuseRule: "Never treat this snapshot as current without revalidation",
        keywords: ["historical", "runtime"],
        description: "Historical runtime snapshot",
        learning: "A temporary model configuration was once observed",
        importance: "normal",
        userPreferences: [],
        reusableKnowledge: [],
        failures: [],
        verificationBoundaries: [],
        historicalState: [{
          observation: "The runtime used a temporary model configuration.",
          observedAt: "2026-07-06T12:00:00.000Z",
          sourceRuns: [runId],
        }],
        sourceRuns: [runId],
      },
    },
  ]);
  const curator = new MemoryCurationPipeline({ store: fixture.store, model });
  const sessions = new WorkspaceSessionStore({ store: fixture.store, memoryCurator: curator });

  await sessions.recordRunRolloutSummary(memoryRunRequest(runId));
  await curator.waitForIdle();

  const topics = await fixture.store.listMemoryDocuments(channelKey(), "topic");
  const notes = await fixture.store.listMemoryDocuments(channelKey(), "extension_note");
  const memories = await fixture.store.readMemories(channelKey());

  assert.equal(topics.length, 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0].content, /status: rejected/u);
  assert.match(notes[0].content, /require reusable knowledge or a negative failure lesson/u);
  assert.doesNotMatch(memories.globalMemory ?? "", /historical-runtime-state/u);
}

async function acceptsMemoryCurationNoop() {
  const fixture = await createFixture();
  const model = createQueuedModel([{ candidate: null }]);
  const curator = new MemoryCurationPipeline({ store: fixture.store, model });
  const sessions = new WorkspaceSessionStore({ store: fixture.store, memoryCurator: curator });

  await sessions.recordRunRolloutSummary(memoryRunRequest("run-memory-noop"));
  await curator.waitForIdle();

  const notes = await fixture.store.listMemoryDocuments(channelKey(), "extension_note");
  const audit = await fixture.store.readMemoryDocument(channelKey(), {
    scope: "global",
    document: "audit",
  });

  assert.equal(model.requests.length, 1);
  assert.equal(notes.length, 0);
  assert.match(audit.content, /"action":"candidate_noop"/u);
  assert.match(audit.content, /"action":"run_completed"/u);
  assert.equal((await fixture.store.listMemoryCurationJobs()).length, 0);
}

async function acceptsMemoryCurationTimeoutRecovery() {
  const warnings = [];
  const fixture = await createFixture({
    onWarning: (warning) => warnings.push(warning),
  });
  const blockingModel = {
    aborted: false,
    async *stream(_request, signal) {
      await new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          this.aborted = true;
          resolve();
        }, { once: true });
      });
      yield {
        type: "error",
        error: {
          code: "aborted",
          message: "aborted by curation deadline",
          retryable: false,
        },
      };
    },
  };
  const curator = new MemoryCurationPipeline({
    store: fixture.store,
    model: blockingModel,
    requestTimeoutMs: 10,
  });
  const sessions = new WorkspaceSessionStore({ store: fixture.store, memoryCurator: curator });

  await sessions.recordRunRolloutSummary(memoryRunRequest("run-memory-timeout"));
  await curator.waitForIdle();

  const pendingJobs = await fixture.store.listMemoryCurationJobs();
  assert.equal(blockingModel.aborted, true);
  assert.equal(pendingJobs.length, 1);
  assert.match(pendingJobs[0].content, /run-memory-timeout/u);
  assert.match(pendingJobs[0].content, /"messages": \[\]/u);
  assert.equal(warnings.some((warning) => warning.code === "memory_curation_failed"), true);

  const recoveryModel = createQueuedModel([{ candidate: null }]);
  const recoveredCurator = new MemoryCurationPipeline({
    store: fixture.store,
    model: recoveryModel,
  });
  assert.equal(await recoveredCurator.recoverPending(), 1);
  await recoveredCurator.waitForIdle();

  assert.equal(recoveryModel.requests.length, 1);
  assert.equal((await fixture.store.listMemoryCurationJobs()).length, 0);
  const audit = await fixture.store.readMemoryDocument(channelKey(), {
    scope: "global",
    document: "audit",
  });
  assert.match(audit.content, /"action":"curation_failed"/u);
  assert.match(audit.content, /"action":"run_completed"/u);

  await fixture.store.writeMemoryCurationJob(
    channelKey(),
    "run-memory-timeout",
    pendingJobs[0].content,
  );
  const terminalRecoveryModel = createQueuedModel([]);
  const terminalRecoveryCurator = new MemoryCurationPipeline({
    store: fixture.store,
    model: terminalRecoveryModel,
  });
  assert.equal(await terminalRecoveryCurator.recoverPending(), 0);
  await terminalRecoveryCurator.waitForIdle();
  assert.equal(terminalRecoveryModel.requests.length, 0);
  assert.equal((await fixture.store.listMemoryCurationJobs()).length, 0);
}

async function acceptsHistoricalRolloutBackfill() {
  const fixture = await createFixture();
  const sessions = new WorkspaceSessionStore({ store: fixture.store });
  await sessions.recordRunRolloutSummary({
    ...memoryRunRequest("run-memory-backfill-old"),
    createdAt: new Date("2026-07-01T12:00:00.000Z"),
  });
  await sessions.recordRunRolloutSummary({
    ...memoryRunRequest("run-memory-backfill-new"),
    createdAt: new Date("2026-07-02T12:00:00.000Z"),
  });

  const model = createQueuedModel([
    { candidate: null },
    { candidate: null },
  ]);
  const curator = new MemoryCurationPipeline({ store: fixture.store, model });

  const first = await curator.backfillRolloutSummaries(channelKey(), 1);
  await curator.waitForIdle();
  assert.deepEqual(first, {
    scanned: 1,
    enqueued: 1,
    skippedCompleted: 0,
    skippedPending: 0,
    skippedInvalid: 0,
  });
  assert.match(JSON.stringify(model.requests[0]), /historical_rollout_recap_only/u);
  assert.match(
    JSON.stringify(model.requests[0]),
    /not raw trace\/diff\/tool proof/u,
  );
  assert.match(JSON.stringify(model.requests[0]), /run-memory-backfill-new/u);

  const second = await curator.backfillRolloutSummaries(channelKey(), 1);
  await curator.waitForIdle();
  assert.deepEqual(second, {
    scanned: 2,
    enqueued: 1,
    skippedCompleted: 1,
    skippedPending: 0,
    skippedInvalid: 0,
  });
  assert.match(JSON.stringify(model.requests[1]), /run-memory-backfill-old/u);

  const third = await curator.backfillRolloutSummaries(channelKey(), 1);
  await curator.waitForIdle();
  assert.deepEqual(third, {
    scanned: 2,
    enqueued: 0,
    skippedCompleted: 2,
    skippedPending: 0,
    skippedInvalid: 0,
  });
  assert.equal(model.requests.length, 2);
  assert.equal((await fixture.store.listMemoryCurationJobs()).length, 0);
}

async function acceptsMemoryUsageFeedback() {
  const fixture = await createFixture();
  const hook = new MemoryUsageRuntimeHook({
    store: fixture.store,
    key: channelKey(),
    clock: () => new Date("2026-07-07T12:00:00.000Z"),
  });
  const run = createAgentRunContext({
    runId: "run-memory-usage",
    userTurnId: "turn-memory-usage",
  });
  const stepContext = captureAgentStepContext(run, "test-model");

  await hook.afterToolCall({
    run,
    step: stepContext.step,
    stepContext,
    call: {
      id: "call-memory-read",
      name: "memory_read",
      input: { scope: "global", document: "topic", topic: "memory-curation" },
    },
    startedAtMs: 0,
    durationMs: 1,
    result: { ok: true, callId: "call-memory-read", output: { content: "memory" } },
  });

  const usage = await fixture.store.readMemoryDocument(channelKey(), {
    scope: "global",
    document: "usage",
  });
  const event = JSON.parse(usage.content.trim());

  assert.equal(event.type, "memory_usage");
  assert.equal(event.document, "topic");
  assert.equal(event.topic, "memory-curation");
  assert.equal(event.runId, "run-memory-usage");
  assert.equal(event.userTurnId, "turn-memory-usage");
  assert.equal(event.stepId, "turn-memory-usage:1");
  assert.equal(event.toolCallId, "call-memory-read");
}

async function acceptsUsageWeightedRouting() {
  const fixture = await createFixture();
  await fixture.store.writeMemoryDocument(channelKey(), {
    scope: "global",
    document: "topic",
    topic: "alpha-topic",
    content: renderTaskGroupFixture("alpha-topic", "Alpha topic", "run-alpha"),
    reason: "Seed accepted alpha topic",
    source: { type: "system", runId: "run-alpha" },
  });
  await fixture.store.writeMemoryDocument(channelKey(), {
    scope: "global",
    document: "topic",
    topic: "beta-topic",
    content: renderTaskGroupFixture("beta-topic", "Beta topic", "run-beta"),
    reason: "Seed accepted beta topic",
    source: { type: "system", runId: "run-beta" },
  });
  await fixture.store.appendMemoryUsage(channelKey(), {
    document: "topic",
    topic: "beta-topic",
    runId: "run-usage-routing",
    userTurnId: "turn-usage-routing",
    stepId: "turn-usage-routing:1",
    toolCallId: "call-beta-read",
    createdAt: "2026-07-08T12:00:00.000Z",
  });
  for (let index = 0; index < 3; index += 1) {
    await fixture.store.appendMemoryUsage(channelKey(), {
      document: "topic",
      topic: "alpha-topic",
      runId: `run-alpha-routing-${index}`,
      userTurnId: `turn-alpha-routing-${index}`,
      stepId: `turn-alpha-routing-${index}:1`,
      toolCallId: `call-alpha-read-${index}`,
      createdAt: `2026-07-08T0${index + 1}:00:00.000Z`,
    });
  }
  await fixture.store.appendMemoryFeedback(channelKey(), {
    topic: "beta-topic",
    outcome: "helpful",
    reason: "The retrieved workflow directly reduced repeated inspection",
    verifiedBy: [],
    notVerified: ["current_source_validation"],
    runId: "run-usage-routing",
    disposition: "observed",
    createdAt: "2026-07-08T12:05:00.000Z",
  });

  const runId = "run-gamma";
  const model = createQueuedModel([
    {
      candidate: {
        targetTopic: "gamma-topic",
        title: "Gamma topic",
        scope: "Gamma memory behavior",
        appliesTo: "PIBot",
        reuseRule: "Revalidate current source",
        keywords: ["gamma"],
        risk: "low",
        claims: [{
          type: "workflow",
          statement: "Gamma reusable workflow",
          trigger: "When gamma applies",
          scope: "Gamma",
          reuseRule: "Revalidate current source",
          durability: "durable",
          verifiedBy: ["focused_test"],
          notVerified: ["production_observation"],
        }],
      },
    },
    {
      decision: "accept",
      reason: "New reusable gamma workflow",
      taskGroup: taskGroupFixture("gamma-topic", "Gamma topic", runId),
    },
  ]);
  const curator = new MemoryCurationPipeline({ store: fixture.store, model });
  const sessions = new WorkspaceSessionStore({ store: fixture.store, memoryCurator: curator });

  await sessions.recordRunRolloutSummary(memoryRunRequest(runId));
  await curator.waitForIdle();

  const memories = await fixture.store.readMemories(channelKey());
  const betaPosition = memories.globalMemory.indexOf("`beta-topic`");
  const alphaPosition = memories.globalMemory.indexOf("`alpha-topic`");

  assert.ok(betaPosition >= 0 && alphaPosition >= 0);
  assert.ok(betaPosition < alphaPosition);
  assert.match(memories.globalMemory, /`gamma-topic`/u);
}

async function acceptsEvidenceGatedMemoryLifecycle() {
  const fixture = await createFixture();
  const topic = "lifecycle-topic";
  await fixture.store.writeMemoryDocument(channelKey(), {
    scope: "global",
    document: "topic",
    topic,
    content: renderTaskGroupFixture(topic, "Lifecycle topic", "run-seed"),
    reason: "Seed accepted lifecycle topic",
    source: { type: "system", runId: "run-seed" },
  });
  await seedAcceptedRouting(fixture.store, topic, "Lifecycle topic");

  const model = createQueuedModel([
    {
      candidates: [],
      memoryFeedback: [{
        topic,
        outcome: "contradicted",
        reason: "Current source no longer uses the remembered entrypoint",
        verifiedBy: ["source_inspection", "focused_test"],
        notVerified: ["production_observation"],
      }],
    },
    {
      decision: "stale",
      reason: "Current source and focused test contradict the accepted entrypoint",
    },
    {
      candidates: [],
      memoryFeedback: [{
        topic,
        outcome: "validated",
        reason: "The repaired workflow is valid again in current source",
        verifiedBy: ["source_inspection", "focused_test"],
        notVerified: ["production_observation"],
      }],
    },
    {
      decision: "reactivate",
      reason: "Current source and focused test revalidate the Task Group",
    },
  ]);
  const curator = new MemoryCurationPipeline({
    store: fixture.store,
    model,
    clock: () => new Date("2026-07-09T12:00:00.000Z"),
  });
  const sessions = new WorkspaceSessionStore({ store: fixture.store, memoryCurator: curator });

  await appendTopicRead(fixture.store, topic, "run-lifecycle-stale");
  await sessions.recordRunRolloutSummary(memoryRunRequest("run-lifecycle-stale"));
  await curator.waitForIdle();

  const staleTopic = await fixture.store.readMemoryDocument(channelKey(), {
    scope: "global",
    document: "topic",
    topic,
  });
  const staleRouting = await fixture.store.readMemories(channelKey());
  assert.match(staleTopic.content, /- State: stale/u);
  assert.doesNotMatch(staleRouting.globalMemory, /`lifecycle-topic`/u);
  assert.match(model.requests[0].messages[1].content, /used_task_groups/u);
  assert.match(model.requests[0].messages[1].content, /Lifecycle topic/u);

  await appendTopicRead(fixture.store, topic, "run-lifecycle-reactivate");
  await sessions.recordRunRolloutSummary(memoryRunRequest("run-lifecycle-reactivate"));
  await curator.waitForIdle();

  const activeTopic = await fixture.store.readMemoryDocument(channelKey(), {
    scope: "global",
    document: "topic",
    topic,
  });
  const activeRouting = await fixture.store.readMemories(channelKey());
  const usage = await fixture.store.readMemoryDocument(channelKey(), {
    scope: "global",
    document: "usage",
  });
  const audit = await fixture.store.readMemoryDocument(channelKey(), {
    scope: "global",
    document: "audit",
  });

  assert.match(activeTopic.content, /- State: active/u);
  assert.match(activeRouting.globalMemory, /`lifecycle-topic`/u);
  assert.equal((usage.content.match(/"type":"memory_feedback"/gu) ?? []).length, 2);
  assert.equal((usage.content.match(/"disposition":"accepted"/gu) ?? []).length, 2);
  assert.match(audit.content, /"action":"topic_stale"/u);
  assert.match(audit.content, /"action":"topic_reactivated"/u);
}

async function acceptsWeakLifecycleEvidenceReview() {
  const fixture = await createFixture();
  const topic = "weak-evidence-topic";
  await fixture.store.writeMemoryDocument(channelKey(), {
    scope: "global",
    document: "topic",
    topic,
    content: renderTaskGroupFixture(topic, "Weak evidence topic", "run-seed"),
    reason: "Seed accepted weak-evidence topic",
    source: { type: "system", runId: "run-seed" },
  });
  await seedAcceptedRouting(fixture.store, topic, "Weak evidence topic");
  await appendTopicRead(fixture.store, topic, "run-weak-evidence");
  const model = createQueuedModel([
    {
      candidates: [],
      memoryFeedback: [{
        topic,
        outcome: "contradicted",
        reason: "The retrieved memory seemed inconsistent",
        verifiedBy: [],
        notVerified: ["source_inspection", "focused_test"],
      }],
    },
    {
      decision: "stale",
      reason: "Proposed stale transition",
    },
  ]);
  const curator = new MemoryCurationPipeline({ store: fixture.store, model });
  const sessions = new WorkspaceSessionStore({ store: fixture.store, memoryCurator: curator });

  await sessions.recordRunRolloutSummary(memoryRunRequest("run-weak-evidence"));
  await curator.waitForIdle();

  const storedTopic = await fixture.store.readMemoryDocument(channelKey(), {
    scope: "global",
    document: "topic",
    topic,
  });
  const notes = await fixture.store.listMemoryDocuments(channelKey(), "extension_note");
  const routing = await fixture.store.readMemories(channelKey());
  const usage = await fixture.store.readMemoryDocument(channelKey(), {
    scope: "global",
    document: "usage",
  });

  assert.doesNotMatch(storedTopic.content, /- State: stale/u);
  assert.equal(notes.length, 1);
  assert.match(notes[0].content, /candidate_type: memory_lifecycle/u);
  assert.match(notes[0].content, /status: needs_review/u);
  assert.match(routing.globalMemory, /`weak-evidence-topic`/u);
  assert.match(usage.content, /"disposition":"needs_review"/u);
}

async function appendTopicRead(store, topic, runId) {
  await store.appendMemoryUsage(channelKey(), {
    document: "topic",
    topic,
    runId,
    userTurnId: `${runId}-turn`,
    stepId: `${runId}-turn:1`,
    toolCallId: `${runId}-read`,
    createdAt: "2026-07-09T11:00:00.000Z",
  });
}

async function seedAcceptedRouting(store, topic, title) {
  await store.writeMemoryDocument(channelKey(), {
    scope: "global",
    document: "index",
    content: [
      "# Memory",
      "",
      "## Accepted Task Groups",
      "",
      "<!-- pibot:accepted-task-groups:start -->",
      `- \`${topic}\`: [${title}](topics/${topic}.md)`,
      "<!-- pibot:accepted-task-groups:end -->",
      "",
    ].join("\n"),
    reason: "Seed accepted routing fixture",
    source: { type: "system", runId: "run-seed" },
  });
}

function memoryRunRequest(runId) {
  return {
    key: channelKey(),
    runId,
    userText: "Fix persistent memory curation without treating rollout summaries as raw evidence.",
    reason: "completed",
    steps: 2,
    messages: [
      { role: "assistant", content: "Inspected current memory runtime." },
      { role: "assistant", content: "Implemented and ran focused tests." },
    ],
    source: { type: "system", runId },
  };
}

function createQueuedModel(responses) {
  const queue = responses.map((response) => JSON.stringify(response));
  return {
    requests: [],
    async *stream(request) {
      this.requests.push(request);
      const response = queue.shift();
      assert.notEqual(response, undefined, "unexpected memory-curation model call");
      yield { type: "text_delta", text: response };
    },
  };
}

function taskGroupFixture(topic, title, runId) {
  return {
    schemaVersion: 1,
    topic,
    title,
    scope: `${title} scope`,
    appliesTo: "PIBot",
    reuseRule: "Revalidate current source",
    keywords: [topic],
    description: `Search first when ${title} applies`,
    learning: `${title} retains reusable evidence`,
    importance: "normal",
    userPreferences: [],
    reusableKnowledge: [{
      id: `${topic}-knowledge`,
      statement: `${title} reusable workflow`,
      trigger: `When ${title} applies`,
      scope: title,
      reuseRule: "Revalidate current source",
      sourceRuns: [runId],
      verifiedBy: ["focused_test"],
      notVerified: ["production_observation"],
    }],
    failures: [],
    verificationBoundaries: [],
    historicalState: [],
    sourceRuns: [runId],
  };
}

function candidateFixture(topic, title) {
  return {
    targetTopic: topic,
    title,
    scope: `${title} scope`,
    appliesTo: "PIBot",
    reuseRule: "Revalidate current source",
    keywords: [topic],
    risk: "low",
    claims: [{
      type: "workflow",
      statement: `${title} reusable workflow`,
      trigger: `When ${title} applies`,
      scope: title,
      reuseRule: "Revalidate current source",
      durability: "durable",
      verifiedBy: ["focused_test"],
      notVerified: ["production_observation"],
    }],
  };
}

function renderTaskGroupFixture(topic, title, runId) {
  const group = taskGroupFixture(topic, title, runId);
  return [
    `# Task Group: ${title}`,
    "",
    "<!-- pibot:task-group-json:start -->",
    "```json",
    JSON.stringify(group, null, 2),
    "```",
    "<!-- pibot:task-group-json:end -->",
    "",
  ].join("\n");
}

async function acceptsLegacyMemoryTopicFallback() {
  const fixture = await createFixture();
  const legacyTopicDir = join(
    fixture.storeRoot,
    "memory",
  );
  await mkdir(legacyTopicDir, { recursive: true });
  await writeFile(
    join(legacyTopicDir, "legacy-topic.md"),
    "# Legacy Topic\n\n- Old memory remains readable.\n",
    "utf8",
  );

  const legacy = await execute(fixture.tools, {
    id: "memory-legacy-read",
    name: "memory_read",
    input: {
      scope: "global",
      document: "topic",
      topic: "legacy-topic",
    },
  });
  const listedTopics = await fixture.store.listMemoryDocuments(channelKey(), "topic");

  assert.equal(legacy.ok, true);
  assert.match(legacy.output.path, /memory\/legacy-topic\.md/u);
  assert.match(legacy.output.content, /Old memory remains readable/u);
  assert.deepEqual(listedTopics.map((value) => value.topic), ["legacy-topic"]);
}

async function acceptsMemoryAuditAndDelete() {
  const fixture = await createFixture();
  await execute(fixture.tools, {
    id: "memory-write",
    name: "memory_write",
    input: {
      scope: "global",
      document: "topic",
      topic: "debugging",
      content: "# Debugging\n\n- Reproduce first.\n",
      reason: "Save a reusable debugging preference",
    },
  });
  const deleted = await execute(fixture.tools, {
    id: "memory-delete",
    name: "memory_delete",
    input: {
      scope: "global",
      document: "topic",
      topic: "debugging",
      reason: "User asked to forget the debugging preference",
    },
  });
  const missing = await execute(fixture.tools, {
    id: "memory-read-missing",
    name: "memory_read",
    input: {
      scope: "global",
      document: "topic",
      topic: "debugging",
    },
  });
  const audit = await execute(fixture.tools, {
    id: "memory-read-audit",
    name: "memory_read",
    input: {
      scope: "global",
      document: "audit",
    },
  });
  const records = audit.output.content.trim().split("\n").map((line) => JSON.parse(line));

  assert.equal(deleted.ok, true);
  assert.equal(deleted.output.changed, true);
  assert.equal(missing.ok, true);
  assert.equal(missing.output.content, undefined);
  assert.deepEqual(records.map((record) => record.action), ["write", "delete"]);
  assert.equal(records[0].source.type, "agent_tool");
  assert.equal(records[0].source.runId, "run-memory-test");
  assert.equal(records[0].source.userId, "U-memory-test");
  assert.match(records[1].reason, /forget/u);
}

async function acceptsMemoryIndexLimit() {
  const fixture = await createFixture({ maxMemoryIndexFileBytes: 20 });
  const result = await fixture.tools.executeTool({
    id: "memory-large-index",
    name: "memory_write",
    input: {
      scope: "global",
      document: "index",
      content: "x".repeat(21),
      reason: "Exercise the concise index limit",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_input");
  assert.match(result.error.message, /maximum size of 20 bytes/u);
}

async function createFixture(options = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pibot-memory-"));
  const storeRoot = join(workspaceRoot, ".pibot");
  const store = new FileChannelWorkspaceStore({
    rootDir: storeRoot,
    ...options,
  });
  const channelDir = (await store.ensureChannelDirectory(channelKey())).channelDir;
  const tools = createCodingToolExecutor({
    workspaceRoot: channelDir,
    // Memory deletion is explicitly destructive and therefore prompts under
    // workspace-write; this fixture exercises storage semantics, not prompting.
    approvalGate: createToolApprovalGate("full-access"),
    memory: {
      store,
      key: channelKey(),
      source: {
        type: "agent_tool",
        runId: "run-memory-test",
        userId: "U-memory-test",
      },
    },
  });
  return {
    storeRoot,
    store,
    channelDir,
    tools,
  };
}

async function execute(tools, call) {
  const parsed = tools.parseToolCall({
    id: call.id,
    name: call.name,
    argumentsJson: JSON.stringify(call.input),
  });
  assert.equal(parsed.ok, true);
  return tools.executeTool(parsed.call);
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
