const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { appendFile, mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { MinimalAgentLoop } = require("../dist/agent/agent-loop");
const { AgentRuntime } = require("../dist/runtime/agent-runtime");
const {
  captureAgentStepContext,
  createAgentRunContext,
} = require("../dist/runtime/context");
const {
  FileDurableLifecycleAuthority,
} = require("../dist/runtime/durable-lifecycle");
const { RuntimeHookRunner } = require("../dist/runtime/hooks");
const { BoundedToolScheduler } = require("../dist/runtime/tool-scheduler");

async function runAcceptance() {
  await runCase(
    "runtime durably orders Run Turn Step and Tool boundaries",
    acceptsOrderedLifecycle,
  );
  await runCase(
    "restart recovery classifies open tools without replaying them",
    acceptsInterruptedRecoveryClassification,
  );
  await runCase(
    "a truncated journal tail is repaired before the next append",
    acceptsTruncatedTailRepair,
  );
  await runCase(
    "SIGKILL leaves fsynced lifecycle state recoverable",
    acceptsProcessKillRecovery,
  );
  await runCase(
    "durability failures stop dispatch or require reconciliation",
    acceptsDurabilityBoundaryFailures,
  );
}

async function runCase(name, test) {
  const outcome = await test();
  if (outcome?.skipped !== undefined) {
    console.log(`skip - ${name}: ${outcome.skipped}`);
    return;
  }
  console.log(`ok - ${name}`);
}

async function acceptsOrderedLifecycle() {
  const root = await mkdtemp(join(tmpdir(), "pibot-lifecycle-order-"));
  try {
    const durability = new FileDurableLifecycleAuthority({ rootDir: root });
    const runtime = new AgentRuntime({ durability });
    const runContext = createAgentRunContext();
    const controller = runtime.createRun({
      scope: "acceptance:ordered",
      runContext,
      maxFollowUps: 0,
    });
    let modelStep = 0;
    const model = {
      async *stream() {
        modelStep += 1;
        yield { type: "start", provider: "fake", model: "fake-model" };
        if (modelStep === 1) {
          yield {
            type: "tool_call",
            call: {
              id: "call-1",
              name: "read_state",
              argumentsJson: JSON.stringify({ key: "version" }),
            },
          };
          yield { type: "done", finishReason: "tool_calls" };
        } else {
          yield { type: "text_delta", text: "done" };
          yield { type: "done", finishReason: "stop" };
        }
      },
    };
    const tools = {
      listTools: () => ["read_state"],
      describeTool: () => ({
        name: "read_state",
        riskLevel: "read-only",
        executionMode: "parallel",
      }),
      async executeTool(call) {
        return { ok: true, callId: call.id, output: { version: 1 } };
      },
    };
    const loop = new MinimalAgentLoop({ model, tools });
    await runtime.runUserTurns(controller, {
      initial: undefined,
      execute: () => controller.run({
        execute: () => loop.run({
          userText: "inspect",
          systemPrompt: "test",
          history: [],
          tools: [{
            name: "read_state",
            description: "read",
            inputSchema: { type: "object" },
          }],
          maxSteps: 2,
          runContext: controller.runContext,
        }),
      }),
    });

    const events = await durability.readEvents(runContext.runId);
    assert.equal(events.every((event, index) => event.seq === index + 1), true);
    assertOrdered(events, [
      "run.opened",
      "turn.opened",
      "step.opened",
      "tool.prepared",
      "tool.dispatched",
      "tool.completed",
      "step.completed",
      "turn.completed",
      "run.completed",
    ]);
    const prepared = events.find((event) => event.type === "tool.prepared");
    assert.equal(prepared.payload.recoveryPolicy, "retry-safe");
    assert.equal(typeof prepared.payload.callFingerprint, "string");
    assert.equal(JSON.stringify(events).includes("version\":1"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function acceptsInterruptedRecoveryClassification() {
  const root = await mkdtemp(join(tmpdir(), "pibot-lifecycle-recover-"));
  try {
    const authority = new FileDurableLifecycleAuthority({ rootDir: root });
    const cases = [
      { name: "prepared", riskLevel: "mutating", dispatch: false, expected: "retry-safe" },
      { name: "read", riskLevel: "read-only", dispatch: true, expected: "retry-safe" },
      { name: "child", riskLevel: "external", recoveryPolicy: "resumable", dispatch: true, expected: "resumable" },
      { name: "write", riskLevel: "mutating", dispatch: true, expected: "needs-reconciliation" },
      { name: "orphan", riskLevel: "mutating", dispatch: true, closeParents: true, expected: "needs-reconciliation" },
    ];
    for (const item of cases) {
      const run = createAgentRunContext({ durability: authority });
      const step = captureAgentStepContext(run);
      const call = { id: `call-${item.name}`, name: item.name, input: { secret: item.name } };
      await authority.openRun({
        runId: run.runId,
        scope: `case:${item.name}`,
        agentId: run.agentId,
      });
      await authority.openUserTurn({ runId: run.runId, userTurnId: run.userTurnId });
      await authority.openStep(step);
      await authority.prepareTool({
        context: step,
        call,
        metadata: {
          name: item.name,
          riskLevel: item.riskLevel,
          executionMode: "sequential",
          ...(item.recoveryPolicy === undefined
            ? {}
            : { recoveryPolicy: item.recoveryPolicy }),
        },
      });
      if (item.dispatch) {
        await authority.markToolDispatched({ context: step, call });
      }
      if (item.closeParents) {
        await authority.finishStep({
          runId: run.runId,
          userTurnId: run.userTurnId,
          stepId: step.stepId,
          status: "completed",
        });
        await authority.finishUserTurn({
          runId: run.runId,
          userTurnId: run.userTurnId,
          status: "completed",
        });
        await authority.finishRun({ runId: run.runId, status: "completed" });
      }
      item.runId = run.runId;
    }

    const restarted = new FileDurableLifecycleAuthority({ rootDir: root });
    const report = await restarted.recoverInterrupted("acceptance_restart");
    assert.equal(report.recoveredRuns, cases.length);
    assert.equal(report.interruptedTurns, cases.length);
    assert.equal(report.interruptedSteps, cases.length);
    assert.equal(report.interruptedTools, cases.length);
    for (const item of cases) {
      const tool = report.entities.find((entity) =>
        entity.runId === item.runId && entity.callId === `call-${item.name}`);
      assert.equal(tool.disposition, item.expected);
      const events = await restarted.readEvents(item.runId);
      assert.equal(events.at(-1).type, "run.interrupted");
      assert.equal(
        events.some((event) =>
          event.type === "tool.completed" || event.type === "tool.failed"),
        false,
      );
    }
    assert.equal((await restarted.recoverInterrupted()).recoveredRuns, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function acceptsProcessKillRecovery() {
  if (process.env.PIBOT_RUN_SIGKILL_ACCEPTANCE !== "1") {
    return {
      skipped: "set PIBOT_RUN_SIGKILL_ACCEPTANCE=1 on a host that permits signals",
    };
  }
  const root = await mkdtemp(join(tmpdir(), "pibot-lifecycle-kill-"));
  let child;
  try {
    child = spawn(process.execPath, [__filename, "--crash-fixture", root], {
      stdio: ["ignore", "pipe", "inherit", "ipc"],
    });
    const exitState = waitForChildExit(child).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    const lineState = firstLine(child.stdout).then(
      (line) => ({ ok: true, line }),
      (error) => ({ ok: false, error }),
    );
    const ready = await Promise.race([
      lineState.then((state) => ({ kind: "line", state })),
      exitState.then((state) => ({ kind: "exit", state })),
    ]);
    if (ready.kind === "exit") {
      if (!ready.state.ok) throw ready.state.error;
      throw new Error("Crash fixture exited before publishing its lifecycle state");
    }
    if (!ready.state.ok) {
      const exitedEarly = await exitState;
      if (!exitedEarly.ok) throw exitedEarly.error;
      throw ready.state.error;
    }
    const fixture = JSON.parse(ready.state.line);
    child.send("kill");
    const exited = await exitState;
    if (!exited.ok) throw exited.error;
    const authority = new FileDurableLifecycleAuthority({ rootDir: root });
    const report = await authority.recoverInterrupted("sigkill_acceptance");
    assert.equal(report.recoveredRuns, 1);
    assert.equal(report.interruptedTools, 1);
    const tool = report.entities.find((entity) => entity.callId === "kill-call");
    assert.equal(tool.disposition, "needs-reconciliation");
    const events = await authority.readEvents(fixture.runId);
    assert.equal(events.at(-1).type, "run.interrupted");
  } catch (error) {
    if (error?.code === "SIGKILL_UNAVAILABLE") {
      return { skipped: "host sandbox does not deliver SIGKILL" };
    }
    throw error;
  } finally {
    if (child?.exitCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}

async function acceptsTruncatedTailRepair() {
  const root = await mkdtemp(join(tmpdir(), "pibot-lifecycle-tail-"));
  try {
    const authority = new FileDurableLifecycleAuthority({ rootDir: root });
    const run = createAgentRunContext();
    await authority.openRun({
      runId: run.runId,
      scope: "acceptance:tail",
      agentId: run.agentId,
    });
    const journal = join(
      root,
      "runs",
      encodeURIComponent(run.runId),
      "lifecycle.jsonl",
    );
    await appendFile(journal, '{"schemaVersion":1,"type":"turn.opened"', "utf8");
    const restarted = new FileDurableLifecycleAuthority({ rootDir: root });
    await restarted.openUserTurn({
      runId: run.runId,
      userTurnId: run.userTurnId,
    });
    const events = await restarted.readEvents(run.runId);
    assert.deepEqual(events.map((event) => event.type), [
      "run.opened",
      "turn.opened",
    ]);
    const text = await readFile(journal, "utf8");
    assert.equal(text.includes('"type":"turn.opened"{"schemaVersion"'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runCrashFixture(root) {
  const authority = new FileDurableLifecycleAuthority({ rootDir: root });
  const run = createAgentRunContext({ durability: authority });
  const step = captureAgentStepContext(run);
  const call = { id: "kill-call", name: "write_state", input: { value: 1 } };
  await authority.openRun({
    runId: run.runId,
    scope: "acceptance:sigkill",
    agentId: run.agentId,
  });
  await authority.openUserTurn({ runId: run.runId, userTurnId: run.userTurnId });
  await authority.openStep(step);
  await authority.prepareTool({
    context: step,
    call,
    metadata: {
      name: call.name,
      riskLevel: "mutating",
      executionMode: "sequential",
    },
  });
  await authority.markToolDispatched({ context: step, call });
  const hold = setInterval(() => {}, 1_000);
  const killSignal = new Promise((resolve) => process.once("message", resolve));
  await new Promise((resolve, reject) => {
    process.stdout.write(
      `${JSON.stringify({ runId: run.runId })}\n`,
      (error) => error ? reject(error) : resolve(),
    );
  });
  await killSignal;
  clearInterval(hold);
  const watchdog = setTimeout(() => process.exit(75), 1_000);
  try {
    process.kill(process.pid, "SIGKILL");
  } catch {
    clearTimeout(watchdog);
    process.exit(75);
  }
}

async function acceptsDurabilityBoundaryFailures() {
  let dispatched = 0;
  const prepareFailure = lifecycleDouble({
    async prepareTool() {
      throw new Error("journal unavailable");
    },
  });
  const first = await scheduleOne(prepareFailure, async (call) => {
    dispatched += 1;
    return { ok: true, callId: call.id, output: "unexpected" };
  });
  assert.equal(dispatched, 0);
  assert.equal(first.ok, false);
  assert.match(first.error.message, /journal unavailable/u);

  const commitFailure = lifecycleDouble({
    async finishTool() {
      throw new Error("commit unavailable");
    },
  });
  const second = await scheduleOne(commitFailure, async (call) => {
    dispatched += 1;
    return { ok: true, callId: call.id, output: "side effect happened" };
  });
  assert.equal(dispatched, 1);
  assert.equal(second.ok, false);
  assert.equal(second.error.retryable, false);
  assert.match(second.error.message, /do not retry before reconciliation/u);
}

async function scheduleOne(durability, executeTool) {
  const run = createAgentRunContext({ durability });
  const stepContext = captureAgentStepContext(run);
  const scheduler = new BoundedToolScheduler({
    maxParallelToolCalls: 1,
    hooks: new RuntimeHookRunner(),
    tools: {
      listTools: () => ["mutate"],
      describeTool: () => ({
        name: "mutate",
        riskLevel: "mutating",
        executionMode: "sequential",
      }),
      executeTool,
    },
  });
  const [result] = await scheduler.schedule({
    run,
    stepContext,
    calls: [{ id: "call-mutate", name: "mutate", input: {} }],
  });
  return result;
}

function lifecycleDouble(overrides) {
  return {
    async openRun() {},
    async finishRun() {},
    async openUserTurn() {},
    async finishUserTurn() {},
    async openStep() {},
    async finishStep() {},
    async prepareTool() {},
    async markToolDispatched() {},
    async finishTool() {},
    ...overrides,
  };
}

function assertOrdered(events, types) {
  let cursor = -1;
  for (const type of types) {
    const next = events.findIndex((event, index) => index > cursor && event.type === type);
    assert.notEqual(next, -1, `missing ordered lifecycle event ${type}`);
    cursor = next;
  }
}

function firstLine(stream) {
  return new Promise((resolve, reject) => {
    let text = "";
    const timeout = setTimeout(
      () => reject(new Error("Crash fixture did not become ready")),
      10_000,
    );
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      text += chunk;
      const newline = text.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timeout);
        resolve(text.slice(0, newline));
      }
    });
    stream.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    stream.once("end", () => {
      if (!text.includes("\n")) {
        clearTimeout(timeout);
        reject(new Error("Crash fixture exited before ready"));
      }
    });
  });
}

function waitForChildExit(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Crash fixture did not terminate after SIGKILL")),
      10_000,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 75) {
        const error = new Error("Host did not deliver SIGKILL to crash fixture");
        error.code = "SIGKILL_UNAVAILABLE";
        reject(error);
        return;
      }
      if (signal !== "SIGKILL") {
        reject(new Error(`Crash fixture exited without SIGKILL: ${signal ?? "none"}`));
        return;
      }
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

const entry = process.argv[2] === "--crash-fixture"
  ? runCrashFixture(process.argv[3])
  : runAcceptance();

entry.catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
