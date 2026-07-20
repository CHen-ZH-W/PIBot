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

async function runAcceptance() {
  await runCase("memory tools write topics and concise indexes", acceptsMemoryWriteAndRead);
  await runCase("memory tools write Codex-like memory documents", acceptsCodexLikeMemoryDocuments);
  await runCase("memory store records run rollout summaries", acceptsRunRolloutSummarySedimentation);
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
    turns: 2,
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

  assert.equal(legacy.ok, true);
  assert.match(legacy.output.path, /memory\/legacy-topic\.md/u);
  assert.match(legacy.output.content, /Old memory remains readable/u);
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
    approvalGate: createToolApprovalGate("workspace-write"),
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
