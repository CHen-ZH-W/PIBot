const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { FileWorkflowStore } = require("../dist/workflow/store");
const { WorkflowOrchestrator } = require("../dist/workflow/orchestrator");
const { FileWebConversationStore } = require("../dist/web/conversations");
const { startWebUiServer } = require("../dist/web/server");

async function runAcceptance() {
  await runCase(
    "workflow persists attempts and blocks duplicate error plus strategy",
    acceptsPersistentDuplicateGuard,
  );
  await runCase(
    "workflow enforces edge budgets and global circuit breaker",
    acceptsBudgetsAndCircuitBreaker,
  );
  await runCase(
    "detached HTTP run survives subscriber disconnect and replays SSE events",
    acceptsDetachedRunReplay,
  );
  console.log("Durable workflow acceptance passed");
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

async function acceptsPersistentDuplicateGuard() {
  const root = await mkdtemp(join(tmpdir(), "pibot-durable-workflow-"));
  try {
    const store = new FileWorkflowStore({ rootDir: root });
    const workflows = new WorkflowOrchestrator({
      store,
      defaultBudget: {
        maxTotalAttempts: 4,
        maxAttemptsPerStep: 4,
        maxCallsPerEdge: 3,
      },
    });
    const run = await workflows.ensureRun({
      externalKey: "ticket:1",
      kind: "evolution_implementation",
      lifecycle: "detached",
      versions: {
        workflowVersion: "workflow-v1",
        runtimeVersion: "runtime-v3",
        agentVersion: "agent-v2",
        modelName: "model-v4",
      },
    });
    await workflows.ensureStep({
      runId: run.runId,
      stepId: "implementation",
      kind: "agent_implementation",
    });
    const strategyA = { type: "patch", diagnosis: "stale lock" };
    const first = await workflows.beginAttempt({
      runId: run.runId,
      stepId: "implementation",
      strategy: strategyA,
    });
    assert.equal(first.allowed, true);
    const errorFingerprint = "error-same";
    const diffFingerprint = "diff-same";
    await workflows.finishAttempt({
      runId: run.runId,
      attemptId: first.attempt.attemptId,
      success: false,
      resultErrorFingerprint: errorFingerprint,
      diffFingerprint,
      contextFingerprint: "context-v1",
      summary: "CI conflict remained after applying the lock cleanup.",
    });

    const duplicate = await workflows.beginAttempt({
      runId: run.runId,
      stepId: "implementation",
      strategy: strategyA,
      triggerErrorFingerprint: errorFingerprint,
      edgeKey: "implementation.retry",
    });
    assert.equal(duplicate.allowed, false);
    assert.equal(duplicate.reason, "duplicate_error_and_strategy");
    assert.equal((await store.readAttempts(run.runId)).length, 1);

    const changed = await workflows.beginAttempt({
      runId: run.runId,
      stepId: "implementation",
      strategy: { type: "rebase_then_patch", diagnosis: "stale lock" },
      triggerErrorFingerprint: errorFingerprint,
      edgeKey: "implementation.retry",
    });
    assert.equal(changed.allowed, true);
    assert.equal(changed.run.terminalReason, undefined);
    assert.equal(changed.step.terminalReason, undefined);
    await workflows.finishAttempt({
      runId: run.runId,
      attemptId: changed.attempt.attemptId,
      success: false,
      resultErrorFingerprint: errorFingerprint,
      diffFingerprint,
      contextFingerprint: "context-v1",
      summary: "The changed strategy produced the same failing diff.",
    });
    const blocked = await store.readRun(run.runId);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.terminalReason, "duplicate_error_and_diff");

    const experiences = await store.readFailureExperiences();
    assert.equal(experiences.length, 2);
    assert.equal(experiences[0].versions.runtimeVersion, "runtime-v3");
    assert.equal(experiences[0].strategyFingerprint.length, 64);
    assert.equal(experiences[0].diffFingerprint, diffFingerprint);
    const experienceText = await readFile(
      join(root, "experience", "failures.jsonl"),
      "utf8",
    );
    assert.match(experienceText, /CI conflict remained/u);
    await assert.rejects(readFile(join(root, "MEMORY.md"), "utf8"), /ENOENT/u);

    const events = await store.readEvents(run.runId);
    assert.deepEqual(
      events.map((event) => event.seq),
      events.map((_event, index) => index + 1),
    );
    assert.deepEqual(
      (await store.readEvents(run.runId, events.at(-2).seq)).map((event) => event.seq),
      [events.at(-1).seq],
    );

    const orphanedRun = await workflows.ensureRun({
      kind: "restart_recovery",
      lifecycle: "detached",
      versions: { agentVersion: "agent-before-restart" },
    });
    await workflows.ensureStep({
      runId: orphanedRun.runId,
      stepId: "agent_run",
      kind: "agent_conversation",
    });
    const orphanedAttempt = await workflows.beginAttempt({
      runId: orphanedRun.runId,
      stepId: "agent_run",
      strategy: { type: "long_task" },
    });
    await workflows.recordStepCheckpoint({
      runId: orphanedRun.runId,
      stepId: "agent_run",
      checkpoint: { completedToolCallFingerprints: ["completed-before-restart"] },
    });
    assert.equal(await workflows.recoverInterruptedRuns(), 1);
    assert.equal((await store.readRun(orphanedRun.runId)).status, "interrupted");
    const interruptedAttempt = (await store.readAttempts(orphanedRun.runId))
      .find((attempt) => attempt.attemptId === orphanedAttempt.attempt.attemptId);
    assert.equal(interruptedAttempt.status, "interrupted");
    assert.equal(typeof interruptedAttempt.resultErrorFingerprint, "string");
    assert.equal((await store.readFailureExperiences()).length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function acceptsBudgetsAndCircuitBreaker() {
  const root = await mkdtemp(join(tmpdir(), "pibot-durable-budget-"));
  try {
    const store = new FileWorkflowStore({ rootDir: root });
    const workflows = new WorkflowOrchestrator({
      store,
      defaultBudget: {
        maxTotalAttempts: 4,
        maxAttemptsPerStep: 4,
        maxCallsPerEdge: 1,
      },
      circuitThreshold: 1,
      circuitCooldownMs: 60_000,
    });
    const run = await workflows.ensureRun({
      kind: "edge_budget",
      lifecycle: "detached",
    });
    await workflows.ensureStep({ runId: run.runId, stepId: "step", kind: "test" });
    const first = await workflows.beginAttempt({
      runId: run.runId,
      stepId: "step",
      strategy: { type: "first" },
      edgeKey: "retry",
    });
    await workflows.finishAttempt({
      runId: run.runId,
      attemptId: first.attempt.attemptId,
      success: false,
      resultErrorFingerprint: "edge-error",
      summary: "first edge failure",
    });
    const edgeRejected = await workflows.beginAttempt({
      runId: run.runId,
      stepId: "step",
      strategy: { type: "second" },
      triggerErrorFingerprint: "different-error",
      edgeKey: "retry",
    });
    assert.equal(edgeRejected.allowed, false);
    assert.equal(edgeRejected.reason, "edge_budget_exhausted:retry");

    const circuitRun = await workflows.ensureRun({
      kind: "circuit_source",
      lifecycle: "detached",
    });
    await workflows.ensureStep({
      runId: circuitRun.runId,
      stepId: "step",
      kind: "test",
    });
    const circuitAttempt = await workflows.beginAttempt({
      runId: circuitRun.runId,
      stepId: "step",
      strategy: { type: "probe" },
      circuitKey: "provider:model-a",
    });
    await workflows.finishAttempt({
      runId: circuitRun.runId,
      attemptId: circuitAttempt.attempt.attemptId,
      success: false,
      resultErrorFingerprint: "provider-down",
      summary: "provider unavailable",
    });
    const nextRun = await workflows.ensureRun({
      kind: "circuit_consumer",
      lifecycle: "detached",
    });
    await workflows.ensureStep({
      runId: nextRun.runId,
      stepId: "step",
      kind: "test",
    });
    const circuitRejected = await workflows.beginAttempt({
      runId: nextRun.runId,
      stepId: "step",
      strategy: { type: "new-agent" },
      circuitKey: "provider:model-a",
    });
    assert.equal(circuitRejected.allowed, false);
    assert.equal(circuitRejected.reason, "circuit_open:provider:model-a");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function acceptsDetachedRunReplay() {
  const root = await mkdtemp(join(tmpdir(), "pibot-detached-http-"));
  let releaseAgent;
  let observedSignal;
  const agentGate = new Promise((resolve) => {
    releaseAgent = resolve;
  });
  const agent = {
    async runUserMessage(conversationId, _content, options) {
      observedSignal = options.signal;
      await options.onEvent({
        type: "run_start",
        conversationId,
        runId: "agent-run-1",
      });
      await options.onEvent({
        type: "agent_event",
        conversationId,
        runId: "agent-run-1",
        event: {
          type: "tool_end",
          step: 1,
          call: {
            id: "tool-1",
            name: "read",
            fingerprint: "tool-fingerprint-1",
          },
          result: { ok: true, summary: "read complete" },
        },
      });
      await agentGate;
      return {
        conversationId,
        runId: "agent-run-1",
        reason: "completed",
      };
    },
    async getConversation(conversationId) {
      return {
        id: conversationId,
        title: "Detached",
        messages: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
    },
  };
  const evolution = {
    async readSnapshot() {
      return { tickets: [] };
    },
  };
  let started;
  try {
    const store = new FileWorkflowStore({ rootDir: join(root, "workflows") });
    const workflows = new WorkflowOrchestrator({ store });
    const conversations = new FileWebConversationStore(root);
    started = await startWebUiServer({
      host: "127.0.0.1",
      port: 0,
      workspaceRoot: root,
      evolution,
      conversations,
      agent,
      workflows,
    });
    const address = started.server.address();
    assert.equal(typeof address, "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const submitted = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "conversation",
        conversationId: "conversation-1",
        content: "perform a long task",
      }),
    });
    assert.equal(submitted.status, 202);
    const accepted = await submitted.json();
    assert.equal(typeof accepted.runId, "string");

    const firstStream = await fetch(`${baseUrl}${accepted.eventsUrl}`, {
      headers: { "Last-Event-ID": `${accepted.runId}:${accepted.eventCursor}` },
    });
    const firstReader = firstStream.body.getReader();
    await firstReader.read();
    await firstReader.cancel();
    await waitFor(() => observedSignal !== undefined);
    assert.equal(observedSignal.aborted, false);

    releaseAgent();
    await waitFor(async () =>
      (await store.readRun(accepted.runId)).status === "succeeded");
    assert.equal(observedSignal.aborted, false);

    const replay = await fetch(`${baseUrl}${accepted.eventsUrl}`, {
      headers: { "Last-Event-ID": `${accepted.runId}:${accepted.eventCursor}` },
    });
    const replayText = await replay.text();
    assert.match(replayText, new RegExp(`id: ${accepted.runId}:\\d+`, "u"));
    assert.match(replayText, /"type":"done"/u);
    const persistedEvents = await store.readEvents(accepted.runId);
    const checkpoint = (await store.readSteps(accepted.runId))[0].checkpoint;
    assert.deepEqual(checkpoint.completedToolCallFingerprints, ["tool-fingerprint-1"]);
    assert.equal(
      persistedEvents.every((event, index) => event.seq === index + 1),
      true,
    );
  } finally {
    if (started !== undefined) {
      await new Promise((resolve, reject) =>
        started.server.close((error) => error ? reject(error) : resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

runAcceptance().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
