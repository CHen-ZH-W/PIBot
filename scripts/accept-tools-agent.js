const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { MinimalAgentLoop } = require("../dist/agent/agent-loop");
const {
  createCodingToolExecutor,
  createToolApprovalGate,
  getCodingToolSchemas,
} = require("../dist/tools");
const { createSandboxExecutor } = require("../dist/workspace/sandbox");

async function runAcceptance() {
  await runCase("model can grep and read files", acceptsSearchAndRead);
  await runCase("model can edit a test fixture", acceptsEditFixture);
  await runCase("bash timeout kills the command", acceptsBashTimeout);
  await runCase("outside workspace path fails", acceptsOutsidePathFailure);
  console.log("Tools + AgentLoop acceptance passed");
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

async function acceptsSearchAndRead() {
  const workspaceRoot = await createWorkspace();
  await writeFile(
    join(workspaceRoot, "fixture.txt"),
    ["alpha", "needle line", "omega"].join("\n"),
    "utf8",
  );

  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield startEvent();

      if (requests.length === 1) {
        yield toolCall("grep-call", "grep", {
          pattern: "needle",
          paths: ["."],
          caseSensitive: true,
          includeGlobs: [],
          excludeGlobs: [],
        });
      } else if (requests.length === 2) {
        assertToolPayload(request, {
          ok: true,
          contains: "fixture.txt",
        });
        yield toolCall("read-call", "read", {
          path: "fixture.txt",
          offset: 1,
          limit: 1,
        });
      } else {
        assertToolPayload(request, {
          ok: true,
          contains: "needle line",
        });
        yield { type: "text_delta", text: "searched and read fixture" };
      }

      yield { type: "done" };
    },
  };

  const result = await runLoop(workspaceRoot, model, "Find needle and read it");

  assert.equal(result.reason, "completed");
  assert.equal(requests.length, 3);
  assert.equal(
    result.messages.some(
      (message) => message.role === "tool" && message.content.includes("needle line"),
    ),
    true,
  );
}

async function acceptsEditFixture() {
  const workspaceRoot = await createWorkspace();
  const filePath = join(workspaceRoot, "edit-fixture.txt");
  await writeFile(filePath, "color=red\n", "utf8");

  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield startEvent();

      if (requests.length === 1) {
        yield toolCall("edit-call", "edit", {
          path: "edit-fixture.txt",
          replacements: [
            {
              oldText: "color=red",
              newText: "color=blue",
            },
          ],
        });
      } else {
        assertToolPayload(request, {
          ok: true,
          contains: "replacementsApplied",
        });
        yield { type: "text_delta", text: "edited fixture" };
      }

      yield { type: "done" };
    },
  };

  const result = await runLoop(workspaceRoot, model, "Change red to blue");
  const content = await readFile(filePath, "utf8");

  assert.equal(result.reason, "completed");
  assert.equal(content, "color=blue\n");
}

async function acceptsBashTimeout() {
  const workspaceRoot = await createWorkspace();
  const requests = [];
  const events = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield startEvent();

      if (requests.length === 1) {
        yield toolCall("bash-call", "bash", {
          command: "sleep 2",
          timeoutMs: 100,
        });
      } else {
        const payload = assertToolPayload(request, {
          ok: true,
          contains: "timedOut",
        });
        assert.equal(payload.output.timedOut, true);
        yield { type: "text_delta", text: "timeout observed" };
      }

      yield { type: "done" };
    },
  };

  const result = await runLoop(
    workspaceRoot,
    model,
    "Run a command that times out",
    events,
  );
  const bashToolEnd = events.find(
    (event) => event.type === "tool_end" && event.call.name === "bash",
  );

  assert.equal(result.reason, "completed");
  assert.notEqual(bashToolEnd, undefined);
  assert.equal(bashToolEnd.result.ok, true);
  assert.equal(bashToolEnd.result.output.timedOut, true);
}

async function acceptsOutsidePathFailure() {
  const workspaceRoot = await createWorkspace();
  const requests = [];
  const events = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield startEvent();

      if (requests.length === 1) {
        yield toolCall("outside-read-call", "read", {
          path: "../outside.txt",
        });
      } else {
        const payload = assertToolPayload(request, {
          ok: false,
          contains: "permission_denied",
        });
        assert.equal(payload.error.code, "permission_denied");
        yield { type: "text_delta", text: "outside path failed" };
      }

      yield { type: "done" };
    },
  };

  const result = await runLoop(
    workspaceRoot,
    model,
    "Try to read outside workspace",
    events,
  );
  const readToolEnd = events.find(
    (event) => event.type === "tool_end" && event.call.name === "read",
  );

  assert.equal(result.reason, "completed");
  assert.notEqual(readToolEnd, undefined);
  assert.equal(readToolEnd.result.ok, false);
  assert.equal(readToolEnd.result.error.code, "permission_denied");
}

async function runLoop(workspaceRoot, model, userText, events = []) {
  const loop = new MinimalAgentLoop({
    model,
    tools: createCodingToolExecutor({
      workspaceRoot,
      sandboxExecutor: createSandboxExecutor({
        kind: "host",
        enabled: true,
      }),
      approvalGate: createToolApprovalGate("full-access"),
      maxCommandOutputChars: 1000,
    }),
  });

  return loop.run({
    userText,
    systemPrompt: "Use tools to inspect and edit the workspace.",
    history: [],
    tools: getCodingToolSchemas(),
    maxSteps: 5,
    onEvent: (event) => {
      events.push(event);
    },
  });
}

async function createWorkspace() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pibot-tools-agent-"));
  await mkdir(workspaceRoot, { recursive: true });
  return workspaceRoot;
}

function startEvent() {
  return {
    type: "start",
    provider: "openai_compatible",
    model: "fake-model",
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

function assertToolPayload(request, expectation) {
  const toolMessage = [...request.messages]
    .reverse()
    .find((message) => message.role === "tool");

  assert.notEqual(toolMessage, undefined);
  assert.equal(toolMessage.content.includes(expectation.contains), true);

  const payload = JSON.parse(toolMessage.content);
  assert.equal(payload.ok, expectation.ok);
  return payload;
}

runAcceptance().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
