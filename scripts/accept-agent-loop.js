const assert = require("node:assert/strict");
const { MinimalAgentLoop } = require("../dist/agent/agent-loop");

const readToolSchema = {
  name: "read",
  description: "Read a file from the workspace.",
  inputSchemaJson: JSON.stringify({
    type: "object",
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
  }),
};

async function runAcceptance() {
  await runCase(
    "tool call result enters next model context",
    acceptsToolResultInNextModelStep,
  );
  await runCase("unknown tool returns tool error", acceptsUnknownToolAsToolError);
  await runCase("invalid tool arguments return tool error", acceptsInvalidToolArguments);
  await runCase("maxSteps stops the loop", acceptsMaxStepsStop);
  await runCase(
    "reasoning and completed messages are emitted",
    acceptsReasoningAndCompletedMessageEvents,
  );
  console.log("AgentLoop acceptance passed");
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

async function acceptsToolResultInNextModelStep() {
  const events = [];
  const requests = [];
  const model = createScriptedModel([
    [
      {
        type: "tool_call",
        call: {
          id: "tool-call-read-1",
          name: "read",
          argumentsJson: JSON.stringify({ path: "README.md" }),
        },
      },
    ],
    [
      {
        type: "text_delta",
        text: "I saw the tool result.",
      },
    ],
  ], requests, [
    {
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 10,
      totalTokens: 110,
    },
    {
      inputTokens: 150,
      cachedInputTokens: 50,
      outputTokens: 20,
      totalTokens: 170,
    },
  ]);
  const loop = new MinimalAgentLoop({
    model,
    tools: createReadToolExecutor(),
  });

  const result = await loop.run({
    userText: "Read README.md",
    systemPrompt: "Use tools when useful.",
    history: [],
    tools: [readToolSchema],
    maxSteps: 3,
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.reason, "completed");
  assert.deepEqual(result.usage, {
    inputTokens: 250,
    cachedInputTokens: 70,
    outputTokens: 30,
    totalTokens: 280,
  });
  assert.equal(requests.length, 2);
  assert.equal(hasToolMessage(requests[1]), true);
  assert.equal(
    requests[1].messages.some(
      (message) =>
        message.role === "tool" &&
        message.toolCallId === "tool-call-read-1" &&
        message.content.includes("README content"),
    ),
    true,
  );
  assert.equal(events.some((event) => event.type === "tool_start"), true);
  assert.equal(events.some((event) => event.type === "tool_end"), true);
}

async function acceptsUnknownToolAsToolError() {
  const events = [];
  const requests = [];
  const model = createScriptedModel([
    [
      {
        type: "tool_call",
        call: {
          id: "tool-call-missing-1",
          name: "missing_tool",
          argumentsJson: JSON.stringify({ path: "README.md" }),
        },
      },
    ],
    [
      {
        type: "text_delta",
        text: "The missing tool error was handled.",
      },
    ],
  ], requests);
  const loop = new MinimalAgentLoop({
    model,
    tools: createReadToolExecutor(),
  });

  const result = await loop.run({
    userText: "Use a missing tool",
    systemPrompt: "Use tools when useful.",
    history: [],
    tools: [readToolSchema],
    maxSteps: 3,
    onEvent: (event) => {
      events.push(event);
    },
  });
  const toolEnd = events.find((event) => event.type === "tool_end");

  assert.equal(result.reason, "completed");
  assert.notEqual(toolEnd, undefined);
  assert.equal(toolEnd.result.ok, false);
  assert.equal(toolEnd.result.error.code, "invalid_input");
  assert.equal(hasToolMessage(requests[1]), true);
  assert.equal(
    requests[1].messages.some(
      (message) =>
        message.role === "tool" &&
        message.toolCallId === "tool-call-missing-1" &&
        message.content.includes("not available"),
    ),
    true,
  );
}

async function acceptsMaxStepsStop() {
  const events = [];
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield {
        type: "start",
        provider: "openai_compatible",
        model: "fake-model",
      };
      yield {
        type: "tool_call",
        call: {
          id: `tool-call-read-${requests.length}`,
          name: "read",
          argumentsJson: JSON.stringify({ path: "README.md" }),
        },
      };
      yield { type: "done" };
    },
  };
  const loop = new MinimalAgentLoop({
    model,
    tools: createReadToolExecutor(),
  });

  const result = await loop.run({
    userText: "Keep using tools",
    systemPrompt: "Use tools forever.",
    history: [],
    tools: [readToolSchema],
    maxSteps: 1,
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.reason, "max_steps");
  assert.equal(result.error.code, "max_steps_exceeded");
  assert.equal(requests.length, 1);
  assert.equal(
    events.some(
      (event) => event.type === "agent_end" && event.reason === "max_steps",
    ),
    true,
  );
}

async function acceptsReasoningAndCompletedMessageEvents() {
  const events = [];
  const requests = [];
  const model = createScriptedModel([
    [
      {
        type: "reasoning_delta",
        text: "Inspecting the request.",
      },
      {
        type: "text_delta",
        text: "Done.",
      },
    ],
  ], requests);
  const loop = new MinimalAgentLoop({
    model,
    tools: createReadToolExecutor(),
  });

  const result = await loop.run({
    userText: "say done",
    systemPrompt: "Answer briefly.",
    history: [],
    tools: [],
    maxSteps: 1,
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.reason, "completed");
  assert.deepEqual(
    events.find((event) => event.type === "reasoning_delta"),
    {
      type: "reasoning_delta",
      step: 1,
      text: "Inspecting the request.",
    },
  );
  const completed = events.find((event) => event.type === "message_completed");
  assert.notEqual(completed, undefined);
  assert.equal(completed.message.role, "assistant");
  assert.equal(completed.message.content, "Done.");
  assert.equal(completed.message.reasoningContent, "Inspecting the request.");
}

async function acceptsInvalidToolArguments() {
  const requests = [];
  const model = createScriptedModel([
    [
      {
        type: "tool_call",
        call: {
          id: "tool-call-invalid-1",
          name: "read",
          argumentsJson: "[]",
        },
      },
    ],
    [
      {
        type: "text_delta",
        text: "The invalid arguments were handled.",
      },
    ],
  ], requests);
  const loop = new MinimalAgentLoop({
    model,
    tools: createReadToolExecutor(),
  });

  const result = await loop.run({
    userText: "Use invalid arguments",
    systemPrompt: "Use tools when useful.",
    history: [],
    tools: [readToolSchema],
    maxSteps: 3,
  });
  const payload = JSON.parse(
    requests[1].messages.find((message) => message.role === "tool").content,
  );

  assert.equal(result.reason, "completed");
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "invalid_input");
  assert.match(payload.error.message, /arguments must be a JSON object/u);
}

function createScriptedModel(steps, requests, usages = []) {
  let index = 0;

  return {
    async *stream(request) {
      requests.push(request);
      yield {
        type: "start",
        provider: "openai_compatible",
        model: "fake-model",
      };

      const scriptedEvents = steps[index] ?? [];
      index += 1;

      for (const event of scriptedEvents) {
        yield event;
      }

      const usage = usages[index - 1];
      yield {
        type: "done",
        ...(usage === undefined ? {} : { usage }),
      };
    },
  };
}

function createReadToolExecutor() {
  return {
    listTools() {
      return ["read"];
    },
    async executeTool(call) {
      return {
        ok: true,
        callId: call.id,
        output: {
          path: call.input.path,
          content: "README content",
          startLine: 1,
          endLine: 1,
        },
      };
    },
  };
}

function hasToolMessage(request) {
  return request.messages.some((message) => message.role === "tool");
}

runAcceptance().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
