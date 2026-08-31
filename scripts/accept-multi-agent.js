const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  stat,
  writeFile,
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
  createCodingToolExecutor,
  createToolApprovalGate,
} = require("../dist/tools");
const {
  ChildAgentRuntime,
  TmuxChildAgentSupervisor,
  defaultChildAgentCommandTemplate,
} = require("../dist");
const {
  FileChildAgentRunStore,
} = require("../dist/workspace/child-agents");
const { FileChannelWorkspaceStore } = require("../dist/workspace/store");

async function runAcceptance() {
  await runCase(
    "default child-agent command points at the built-in CLI",
    acceptsDefaultChildAgentCommand,
  );

  if (!(await canStartTmux())) {
    console.log("Multi-agent acceptance skipped: tmux server is not available");
    return;
  }

  await runCase(
    "agent_spawn starts a write-capable ReviewAgent in tmux and agent_collect reads result",
    acceptsSpawnAndCollect,
  );
  await runCase(
    "child terminal status is delivered as an event and external keys are idempotent",
    acceptsTerminalEventAndIdempotency,
  );
  await runCase(
    "child tmux pane inherits model environment from the parent process",
    acceptsInheritedModelEnvironment,
  );
  await runCase(
    "write-capable ImplementAgent auto-creates an isolated workspace",
    acceptsAutoWorktreeForImplement,
  );
  await runCase(
    "auto workspace snapshot excludes channel control-plane artifacts",
    acceptsAutoWorktreeExcludesControlPlaneArtifacts,
  );
  await runCase(
    "explicit worktreePath becomes the child workspace root",
    acceptsExplicitWorktreeWorkspaceRoot,
  );
  await runCase(
    "agent_list keeps failed child agents visible by default",
    acceptsFailedChildVisibleByDefault,
  );
  await runCase(
    "agent_collect marks vanished child panes failed",
    acceptsCollectMarksVanishedPaneFailed,
  );
  await runCase("agent_capture observes the tmux pane", acceptsCapture);
  await runCase("agent_send can interact with a child pane", acceptsSend);
  await runCase("agent_stop cleans up a running child", acceptsStop);
  await runCase("child timeout updates status", acceptsTimeout);
  await runCase("concurrency and write isolation are enforced", acceptsConcurrencyRules);
  console.log("Multi-agent acceptance passed");
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

async function acceptsDefaultChildAgentCommand() {
  const command = defaultChildAgentCommandTemplate();
  assert.match(command, /child-agent\.js/u);
  await stat(join(__dirname, "..", "dist", "child-agent.js"));
}

async function acceptsSpawnAndCollect() {
  const fixture = await createFixture();
  const spawn = await fixture.tools.executeTool({
    id: "spawn-review",
    name: "agent_spawn",
    input: {
      role: "review",
      task: "Review the current diff and summarize risks.",
      timeoutMs: 5000,
    },
  });
  assert.equal(spawn.ok, true, JSON.stringify(spawn, null, 2));
  assert.equal(spawn.output.role, "review");
  assert.equal(spawn.output.readOnly, false);
  assert.equal(typeof spawn.output.worktreePath, "string");
  assert.notEqual(spawn.output.worktreePath, fixture.workspaceRoot);
  assert.match(spawn.output.tmux.target, /^pibot-/u);

  const status = await waitForStatus(fixture.store, fixture.key, spawn.output.childRunId, [
    "completed",
    "failed",
    "timeout",
  ]);
  assert.equal(status.status, "completed");

  const collect = await fixture.tools.executeTool({
    id: "collect-review",
    name: "agent_collect",
    input: {
      childRunId: spawn.output.childRunId,
    },
  });
  assert.equal(collect.ok, true);
  assert.equal(collect.output.agent.status, "completed");
  assert.match(collect.output.result, /fake child result for review/u);
  assert.equal(collect.output.usage.toolCalls, 1);
  assert.match(
    await readFile(join(status.paths.runDir, "task.md"), "utf8"),
    /ReviewAgent/u,
  );
}

async function acceptsTerminalEventAndIdempotency() {
  const fixture = await createFixture();
  const first = await fixture.childAgents.spawnAgent({
    role: "explore",
    task: "sleep-short event-driven",
    readOnly: true,
    timeoutMs: 5000,
    externalKey: "task-attempt-1",
  });
  const duplicate = await fixture.childAgents.spawnAgent({
    role: "explore",
    task: "this duplicate must not start",
    readOnly: true,
    timeoutMs: 5000,
    externalKey: "task-attempt-1",
  });
  assert.equal(duplicate.childRunId, first.childRunId);
  const matching = (await fixture.store.listRuns(fixture.key, {
    parentRunId: first.parentRunId,
    includeCompleted: true,
  })).filter((run) => run.externalKey === "task-attempt-1");
  assert.equal(matching.length, 1);

  const terminal = await fixture.childAgents.waitForTerminal(first.childRunId);
  assert.equal(terminal.status, "completed");
  assert.match(
    await readFile(terminal.paths.resultFile, "utf8"),
    /fake child result after short sleep/u,
  );
}

async function acceptsInheritedModelEnvironment() {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "parent-env-test-key";
  try {
    const fixture = await createFixture();
    const spawn = await fixture.tools.executeTool({
      id: "spawn-env",
      name: "agent_spawn",
      input: {
        role: "explore",
        task: "env-openai-key",
        timeoutMs: 5000,
      },
    });
    assert.equal(spawn.ok, true, JSON.stringify(spawn, null, 2));
    const status = await waitForStatus(fixture.store, fixture.key, spawn.output.childRunId, [
      "completed",
      "failed",
      "timeout",
    ]);
    assert.equal(status.status, "completed");
    assert.match(
      await readFile(status.paths.resultFile, "utf8"),
      /openai-key:present/u,
    );
  } finally {
    if (previousKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousKey;
    }
  }
}

async function acceptsAutoWorktreeForImplement() {
  const fixture = await createFixture();
  const spawn = await fixture.tools.executeTool({
    id: "spawn-implement-auto-worktree",
    name: "agent_spawn",
    input: {
      role: "implement",
      readOnly: false,
      task: "env-workspace-root",
      timeoutMs: 5000,
    },
  });
  assert.equal(spawn.ok, true, JSON.stringify(spawn, null, 2));
  assert.equal(spawn.output.readOnly, false);
  assert.equal(typeof spawn.output.worktreePath, "string");
  assert.notEqual(spawn.output.worktreePath, fixture.workspaceRoot);

  const status = await waitForStatus(fixture.store, fixture.key, spawn.output.childRunId, [
    "completed",
    "failed",
    "timeout",
  ]);
  assert.equal(status.status, "completed");
  assert.equal(status.worktreePath, spawn.output.worktreePath);
  assert.match(
    await readFile(status.paths.resultFile, "utf8"),
    new RegExp(`workspace-root:${escapeRegExp(status.worktreePath)}`, "u"),
  );
}

async function acceptsAutoWorktreeExcludesControlPlaneArtifacts() {
  const fixture = await createFixture();
  await mkdir(join(fixture.workspaceRoot, "runs", "old"), { recursive: true });
  await mkdir(join(fixture.workspaceRoot, "approvals"), { recursive: true });
  await mkdir(join(fixture.workspaceRoot, ".pytest_cache"), { recursive: true });
  await mkdir(join(fixture.workspaceRoot, "src", "module", "__pycache__"), {
    recursive: true,
  });
  await writeFile(join(fixture.workspaceRoot, "runs", "old", "status.json"), "{}\n");
  await writeFile(join(fixture.workspaceRoot, "approvals", "pending.json"), "{}\n");
  await writeFile(join(fixture.workspaceRoot, "runtime-state.json"), "{}\n");
  await writeFile(join(fixture.workspaceRoot, "context.jsonl"), "{}\n");
  await writeFile(join(fixture.workspaceRoot, "tasks.json"), "{}\n");
  await writeFile(join(fixture.workspaceRoot, ".child-env.sh"), "SECRET=1\n");
  await writeFile(join(fixture.workspaceRoot, "stale.sock"), "not a socket\n");
  await writeFile(join(fixture.workspaceRoot, ".pytest_cache", "node"), "cache\n");
  await writeFile(join(fixture.workspaceRoot, "src", "keep.txt"), "keep\n");
  await writeFile(
    join(fixture.workspaceRoot, "src", "module", "__pycache__", "cache.pyc"),
    "cache\n",
  );

  const spawn = await fixture.tools.executeTool({
    id: "spawn-snapshot-filter",
    name: "agent_spawn",
    input: {
      role: "implement",
      task: "env-workspace-root",
      timeoutMs: 5000,
    },
  });
  assert.equal(spawn.ok, true, JSON.stringify(spawn, null, 2));

  const status = await waitForStatus(fixture.store, fixture.key, spawn.output.childRunId, [
    "completed",
    "failed",
    "timeout",
  ]);
  assert.equal(status.status, "completed");
  assert.equal(typeof status.worktreePath, "string");
  assert.equal(await pathExists(join(status.worktreePath, "fake-child.js")), true);
  assert.equal(await pathExists(join(status.worktreePath, "src", "keep.txt")), true);
  assert.equal(await pathExists(join(status.worktreePath, "runs")), false);
  assert.equal(await pathExists(join(status.worktreePath, "approvals")), false);
  assert.equal(await pathExists(join(status.worktreePath, "runtime-state.json")), false);
  assert.equal(await pathExists(join(status.worktreePath, "context.jsonl")), false);
  assert.equal(await pathExists(join(status.worktreePath, "tasks.json")), false);
  assert.equal(await pathExists(join(status.worktreePath, ".child-env.sh")), false);
  assert.equal(await pathExists(join(status.worktreePath, "stale.sock")), false);
  assert.equal(await pathExists(join(status.worktreePath, ".pytest_cache")), false);
  assert.equal(
    await pathExists(join(status.worktreePath, "src", "module", "__pycache__")),
    false,
  );
}

async function acceptsExplicitWorktreeWorkspaceRoot() {
  const fixture = await createFixture();
  const worktreePath = await mkdtemp(join(tmpdir(), "pibot-explicit-worktree-"));
  const spawn = await fixture.tools.executeTool({
    id: "spawn-explicit-worktree",
    name: "agent_spawn",
    input: {
      role: "implement",
      readOnly: false,
      worktreePath,
      task: "env-workspace-root",
      timeoutMs: 5000,
    },
  });
  assert.equal(spawn.ok, true, JSON.stringify(spawn, null, 2));
  assert.equal(spawn.output.worktreePath, worktreePath);

  const status = await waitForStatus(fixture.store, fixture.key, spawn.output.childRunId, [
    "completed",
    "failed",
    "timeout",
  ]);
  assert.equal(status.status, "completed");
  assert.match(
    await readFile(status.paths.resultFile, "utf8"),
    new RegExp(`workspace-root:${escapeRegExp(worktreePath)}`, "u"),
  );
}

async function acceptsFailedChildVisibleByDefault() {
  const fixture = await createFixture();
  const spawn = await fixture.tools.executeTool({
    id: "spawn-fail-fast",
    name: "agent_spawn",
    input: {
      role: "explore",
      task: "fail-fast",
      timeoutMs: 5000,
    },
  });
  assert.equal(spawn.ok, true, JSON.stringify(spawn, null, 2));
  const status = await waitForStatus(fixture.store, fixture.key, spawn.output.childRunId, [
    "failed",
    "completed",
    "timeout",
  ]);
  assert.equal(status.status, "failed");

  const list = await fixture.tools.executeTool({
    id: "list-default",
    name: "agent_list",
    input: {},
  });
  assert.equal(list.ok, true);
  assert.equal(
    list.output.agents.some((agent) => agent.childRunId === spawn.output.childRunId),
    true,
  );
}

async function acceptsCollectMarksVanishedPaneFailed() {
  const fixture = await createFixture();
  const spawn = await fixture.tools.executeTool({
    id: "spawn-vanish",
    name: "agent_spawn",
    input: {
      role: "explore",
      task: "sleep-long",
      timeoutMs: 10000,
    },
  });
  assert.equal(spawn.ok, true, JSON.stringify(spawn, null, 2));
  await wait(150);

  const before = await fixture.store.readRun(fixture.key, spawn.output.childRunId);
  assert.notEqual(before.tmux, undefined);
  await fixture.supervisor.stop(before.tmux);

  const collect = await fixture.tools.executeTool({
    id: "collect-vanished",
    name: "agent_collect",
    input: {
      childRunId: spawn.output.childRunId,
    },
  });
  assert.equal(collect.ok, true, JSON.stringify(collect, null, 2));
  assert.equal(collect.output.alive, false);
  assert.equal(collect.output.agent.status, "failed");
  assert.equal(
    collect.output.agent.stopReason,
    "tmux_pane_exited_before_status_update",
  );
}

async function acceptsCapture() {
  const fixture = await createFixture();
  const spawn = await fixture.tools.executeTool({
    id: "spawn-capture",
    name: "agent_spawn",
    input: {
      role: "explore",
      task: "sleep-short capture-visible",
      timeoutMs: 5000,
    },
  });
  assert.equal(spawn.ok, true, JSON.stringify(spawn, null, 2));
  await wait(150);

  const capture = await fixture.tools.executeTool({
    id: "capture-child",
    name: "agent_capture",
    input: {
      childRunId: spawn.output.childRunId,
      lines: 20,
    },
  });
  assert.equal(capture.ok, true);
  assert.match(capture.output.output, /pane-visible/u);
  await fixture.tools.executeTool({
    id: "stop-capture",
    name: "agent_stop",
    input: { childRunId: spawn.output.childRunId },
  });
}

async function acceptsSend() {
  const fixture = await createFixture();
  const spawn = await fixture.tools.executeTool({
    id: "spawn-send",
    name: "agent_spawn",
    input: {
      role: "explore",
      task: "wait-input",
      timeoutMs: 5000,
    },
  });
  assert.equal(spawn.ok, true, JSON.stringify(spawn, null, 2));
  await wait(150);

  const send = await fixture.tools.executeTool({
    id: "send-child",
    name: "agent_send",
    input: {
      childRunId: spawn.output.childRunId,
      text: "hello child",
      enter: true,
    },
  });
  assert.equal(send.ok, true);
  const status = await waitForStatus(fixture.store, fixture.key, spawn.output.childRunId, [
    "completed",
  ]);
  assert.equal(status.status, "completed");
  assert.match(
    await readFile(status.paths.resultFile, "utf8"),
    /input:hello child/u,
  );
}

async function acceptsStop() {
  const fixture = await createFixture();
  const spawn = await fixture.tools.executeTool({
    id: "spawn-stop",
    name: "agent_spawn",
    input: {
      role: "test",
      task: "sleep-long",
      timeoutMs: 10000,
    },
  });
  assert.equal(spawn.ok, true, JSON.stringify(spawn, null, 2));
  await wait(150);

  const stop = await fixture.tools.executeTool({
    id: "stop-child",
    name: "agent_stop",
    input: {
      childRunId: spawn.output.childRunId,
      reason: "acceptance cleanup",
    },
  });
  assert.equal(stop.ok, true);
  assert.equal(stop.output.status, "stopped");

  const collect = await fixture.tools.executeTool({
    id: "collect-stopped",
    name: "agent_collect",
    input: { childRunId: spawn.output.childRunId },
  });
  assert.equal(collect.ok, true);
  assert.equal(collect.output.alive, false);
}

async function acceptsTimeout() {
  const fixture = await createFixture();
  const spawn = await fixture.tools.executeTool({
    id: "spawn-timeout",
    name: "agent_spawn",
    input: {
      role: "test",
      task: "sleep-long",
      timeoutMs: 300,
    },
  });
  assert.equal(spawn.ok, true, JSON.stringify(spawn, null, 2));
  const status = await waitForStatus(fixture.store, fixture.key, spawn.output.childRunId, [
    "timeout",
    "completed",
    "failed",
  ]);
  assert.equal(status.status, "timeout");
}

async function acceptsConcurrencyRules() {
  const fixture = await createFixture({ maxConcurrent: 3 });
  const spawned = [];
  for (const role of ["explore", "review", "test"]) {
    const result = await fixture.tools.executeTool({
      id: `spawn-${role}`,
      name: "agent_spawn",
      input: {
        role,
        task: "sleep-long",
        timeoutMs: 10000,
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    spawned.push(result.output.childRunId);
  }

  const fourth = await fixture.tools.executeTool({
    id: "spawn-fourth",
    name: "agent_spawn",
    input: {
      role: "explore",
      task: "should exceed concurrency",
      timeoutMs: 10000,
    },
  });
  assert.equal(fourth.ok, false);
  assert.equal(fourth.error.code, "conflict");

  for (const childRunId of spawned) {
    await fixture.tools.executeTool({
      id: `stop-${childRunId}`,
      name: "agent_stop",
      input: { childRunId },
    });
  }

  const writeParentWorkspace = await fixture.tools.executeTool({
    id: "spawn-write-parent",
    name: "agent_spawn",
    input: {
      role: "implement",
      task: "write in parent workspace",
      readOnly: false,
      worktreePath: fixture.workspaceRoot,
      timeoutMs: 1000,
    },
  });
  assert.equal(writeParentWorkspace.ok, false);
  assert.equal(writeParentWorkspace.error.code, "permission_denied");
}

async function createFixture(options = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pibot-multi-agent-"));
  await writeFakeChildRunner(workspaceRoot);
  const storeRoot = join(workspaceRoot, ".pibot");
  const workspaceStore = new FileChannelWorkspaceStore({ rootDir: storeRoot });
  const childStore = new FileChildAgentRunStore({ store: workspaceStore });
  const key = {
    teamId: "T-multi",
    channelId: "C-multi",
  };
  const parentRunId = `parent-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const supervisor = new TmuxChildAgentSupervisor({
    tmuxPath: "tmux",
    socketPath: join(workspaceRoot, "tmux.sock"),
    commandTemplate: `${process.execPath} ${join(workspaceRoot, "fake-child.js")}`,
    defaultCaptureLines: 60,
    defaultCaptureMaxChars: 12000,
  });
  const childAgents = new ChildAgentRuntime({
    key,
    parentRunId,
    workspaceRoot,
    store: childStore,
    supervisor,
    maxConcurrent: options.maxConcurrent ?? 3,
    defaultTimeoutMs: 5000,
    maxTimeoutMs: 10000,
  });
  const tools = createCodingToolExecutor({
    workspaceRoot,
    childAgents,
    approvalGate: createToolApprovalGate("full-access"),
  });

  return {
    workspaceRoot,
    key,
    store: childStore,
    supervisor,
    childAgents,
    tools,
  };
}

async function writeFakeChildRunner(workspaceRoot) {
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(
    join(workspaceRoot, "fake-child.js"),
    `
const fs = require("node:fs");
const readline = require("node:readline");
const task = fs.readFileSync(process.env.PIBOT_TASK_FILE, "utf8");
console.log("pane-visible " + process.env.PIBOT_CHILD_ROLE);
fs.appendFileSync(process.env.PIBOT_TRANSCRIPT_FILE, JSON.stringify({
  ts: new Date().toISOString(),
  type: "fake_child.started"
}) + "\\n");
function finish(result) {
  fs.writeFileSync(process.env.PIBOT_RESULT_FILE, result + "\\n");
  fs.writeFileSync(process.env.PIBOT_USAGE_FILE, JSON.stringify({
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    toolCalls: 1,
    durationMs: 1
  }, null, 2) + "\\n");
}
if (task.includes("wait-input")) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });
  rl.once("line", (line) => {
    finish("input:" + line.trim());
    process.exit(0);
  });
  setInterval(() => {}, 1000);
} else if (task.includes("sleep-long")) {
  setTimeout(() => {
    finish("fake child result after sleep");
    process.exit(0);
  }, 5000);
} else if (task.includes("sleep-short")) {
  setTimeout(() => {
    finish("fake child result after short sleep");
    process.exit(0);
  }, 1200);
} else if (task.includes("env-openai-key")) {
  finish("openai-key:" + (process.env.OPENAI_API_KEY === "parent-env-test-key" ? "present" : "missing"));
} else if (task.includes("env-workspace-root")) {
  finish("workspace-root:" + process.env.PIBOT_WORKSPACE_ROOT);
} else if (task.includes("fail-fast")) {
  finish("failed child result");
  process.exit(1);
} else {
  finish("fake child result for " + process.env.PIBOT_CHILD_ROLE);
}
	`,
    "utf8",
  );
}

async function waitForStatus(store, key, childRunId, statuses) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const run = await store.readRun(key, childRunId);
    if (statuses.includes(run.status)) {
      return run;
    }
    await wait(100);
  }
  const run = await store.readRun(key, childRunId);
  throw new Error(`Timed out waiting for ${statuses.join(", ")}; got ${run.status}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pathExists(filePath) {
  return stat(filePath).then(
    () => true,
    () => false,
  );
}

async function canStartTmux() {
  const version = spawnSync("tmux", ["-V"], {
    encoding: "utf8",
  });
  if (version.status !== 0) {
    return false;
  }

  const tempDir = await mkdtemp(join(tmpdir(), "pibot-tmux-probe-"));
  const socketPath = join(tempDir, "tmux.sock");
  const session = `probe-${Date.now()}`;
  try {
    const result = spawnSync(
      "tmux",
      [
        "-S",
        socketPath,
        "new-session",
        "-d",
        "-s",
        session,
        "--",
        "true",
      ],
      { encoding: "utf8" },
    );
    return result.status === 0;
  } finally {
    spawnSync("tmux", ["-S", socketPath, "kill-session", "-t", session], {
      encoding: "utf8",
    });
    await rm(tempDir, { recursive: true, force: true });
  }
}

runAcceptance().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
