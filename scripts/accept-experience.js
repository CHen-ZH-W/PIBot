const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { MinimalAgentLoop } = require("../dist/agent/agent-loop");
const {
  isAgentStopCommand,
  PerChannelAgentRunner,
} = require("../dist/agent/runner");
const { OpenAICompatibleProviderAdapter } = require("../dist/agent/model");
const {
  createAgentRuntimeState,
  RuntimeModeHook,
} = require("../dist/runtime/mode");
const {
  createCodingToolExecutor,
  createToolApprovalGate,
  getCodingToolSchemas,
} = require("../dist/tools");
const { WorkspaceSessionStore } = require("../dist/workspace/session");
const { FileChannelWorkspaceStore } = require("../dist/workspace/store");
const {
  SLACK_TEXT_LIMIT,
  SLACK_UPDATE_TEXT_LIMIT,
} = require("../dist/slack/formatter");

async function runAcceptance() {
  await runCase("attach tool uploads a workspace file", acceptsAttachTool);
  await runCase("image attachments become multimodal user input", acceptsImageAttachmentInput);
  await runCase("OpenAI-compatible provider serializes image_url parts", acceptsProviderImageParts);
  await runCase("LSP tool returns diagnostics and definitions", acceptsLspTool);
  await runCase(
    "in-flight message enters the active run as steering",
    acceptsSteeringMessage,
  );
  await runCase(
    "localized stop cancels the active run and clears queued follow-ups",
    acceptsLocalizedStopCancellation,
  );
  await runCase(
    "reasoning deltas update the in-flight main message",
    acceptsReasoningProgressUpdates,
  );
  await runCase(
    "progress keeps earlier reasoning and interleaves tools",
    acceptsInterleavedProgressTimeline,
  );
  await runCase(
    "long unicode progress updates stay within Slack byte limits",
    acceptsLongUnicodeProgressByteLimit,
  );
  await runCase(
    "long final responses stay within Slack update limits and continue in thread",
    acceptsLongFinalResponseThreading,
  );
  await runCase(
    "progress clears old content and keeps latest updates",
    acceptsProgressClearsOldContent,
  );
  await runCase(
    "reasoning progress omits code and file content",
    acceptsReasoningProgressOmitsCode,
  );
  await runCase(
    "transient Slack progress update failures do not abort runs",
    acceptsSlackProgressUpdateFailureDoesNotAbort,
  );
  await runCase(
    "generated messages enter context while a run is active",
    acceptsRealtimeGeneratedContext,
  );
  await runCase("long-running runs refresh status", acceptsLongRunningStatus);
  console.log("Experience acceptance passed");
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

async function acceptsAttachTool() {
  const workspaceRoot = await createWorkspace("pibot-experience-attach-");
  await writeFile(join(workspaceRoot, "report.txt"), "hello attach\n", "utf8");
  const slack = new FakeSlackPublisher();
  const tools = createCodingToolExecutor({
    workspaceRoot,
    approvalGate: createToolApprovalGate("full-access"),
    attach: {
      publisher: slack,
      conversation: {
        teamId: "T-exp",
        channelId: "C-exp",
        threadTs: "1.000000",
      },
      maxFileBytes: 10000,
    },
  });

  const result = await tools.executeTool({
    id: "attach-1",
    name: "attach",
    input: {
      path: "report.txt",
      title: "Report",
      initialComment: "Generated report",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.output.uploaded, true);
  const upload = slack.events.find((event) => event.type === "file.upload");
  assert.notEqual(upload, undefined);
  assert.equal(upload.file.filename, "report.txt");
  assert.equal(upload.file.title, "Report");
  assert.equal(await readFile(upload.file.filePath, "utf8"), "hello attach\n");
}

async function acceptsImageAttachmentInput() {
  const workspaceRoot = await createWorkspace("pibot-experience-image-");
  const imagePath = join(workspaceRoot, "image.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield startEvent();
      const user = request.messages.find((message) => message.role === "user");
      assert.notEqual(user, undefined);
      assert.equal(
        user.contentParts.some((part) => part.type === "image_url"),
        true,
      );
      yield { type: "text_delta", text: "saw image" };
      yield { type: "done" };
    },
  };
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const sessions = new WorkspaceSessionStore({ store });
  const runner = new PerChannelAgentRunner({
    slack: new FakeSlackPublisher(),
    agentLoop: new MinimalAgentLoop({
      model,
      tools: createCodingToolExecutor({
        workspaceRoot,
        approvalGate: createToolApprovalGate("full-access"),
      }),
    }),
    createAgentLoopForWorkspace: () =>
      new MinimalAgentLoop({
        model,
        tools: createCodingToolExecutor({
          workspaceRoot,
          approvalGate: createToolApprovalGate("full-access"),
        }),
      }),
    resolveChannelWorkspaceRoot: async () => workspaceRoot,
    sessions,
    tools: getCodingToolSchemas(),
    maxSteps: 1,
    attachmentDownloader: {
      async downloadForEvent() {
        return {
          downloaded: [
            {
              fileId: "F-img",
              name: "image.png",
              path: "attachments/image.png",
              absolutePath: imagePath,
              mimetype: "image/png",
            },
          ],
          failures: [],
        };
      },
    },
  });

  await runner.handleSlackMessage({
    ...slackEvent("look at this image"),
    files: [
      {
        id: "F-img",
        name: "image.png",
        mimetype: "image/png",
        url: "https://files.slack.test/image.png",
      },
    ],
  });

  assert.equal(requests.length, 1);
}

async function acceptsProviderImageParts() {
  const previousFetch = global.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  let body;
  global.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  try {
    const adapter = new OpenAICompatibleProviderAdapter({
      defaultBaseUrl: "https://api.test",
      defaultModel: "vision-model",
    });
    for await (const _event of adapter.stream({
      messages: [
        { role: "system", content: "You see images." },
        {
          role: "user",
          content: "inspect",
          contentParts: [
            { type: "text", text: "inspect" },
            {
              type: "image_url",
              imageUrl: {
                url: "data:image/png;base64,AAAA",
                detail: "auto",
              },
            },
          ],
        },
      ],
      tools: [],
    })) {
      // drain stream
    }

    assert.equal(body.messages[1].content[1].type, "image_url");
    assert.equal(body.messages[1].content[1].image_url.url, "data:image/png;base64,AAAA");
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousKey;
    }
  }
}

async function acceptsLspTool() {
  const workspaceRoot = await createWorkspace("pibot-experience-lsp-");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "src", "lib.ts"),
    "export function add(left: number, right: number): number {\n  return left + right;\n}\n",
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, "src", "main.ts"),
    "import { add } from \"./lib\";\nconst value = add(1, 2);\nconst broken: number = \"no\";\n",
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "commonjs",
        target: "es2022",
      },
      include: ["src/**/*.ts"],
    }),
    "utf8",
  );
  const tools = createCodingToolExecutor({
    workspaceRoot,
    approvalGate: createToolApprovalGate("full-access"),
  });
  const definition = await tools.executeTool({
    id: "lsp-def",
    name: "lsp",
    input: {
      action: "definition",
      path: "src/main.ts",
      line: 1,
      character: 10,
    },
  });
  assert.equal(definition.ok, true);
  assert.equal(
    definition.output.locations.some((location) => location.path === "src/lib.ts"),
    true,
  );

  const diagnostics = await tools.executeTool({
    id: "lsp-diag",
    name: "lsp",
    input: {
      action: "diagnostics",
      path: "src/main.ts",
    },
  });
  assert.equal(diagnostics.ok, true);
  assert.equal(
    diagnostics.output.diagnostics.some((diagnostic) =>
      /not assignable/u.test(diagnostic.message)),
    true,
  );
}

async function acceptsSteeringMessage() {
  const workspaceRoot = await createWorkspace("pibot-experience-steering-");
  let releaseTool;
  const toolMayFinish = new Promise((resolve) => {
    releaseTool = resolve;
  });
  let firstRequestSeen;
  const firstRequest = new Promise((resolve) => {
    firstRequestSeen = resolve;
  });
  const runtimeStates = [];
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield startEvent();
      if (requests.length === 1) {
        firstRequestSeen();
        yield toolCall("read-1", "read", { path: "README.md" });
      } else {
        assert.equal(
          request.messages.some(
            (message) =>
              message.role === "user" &&
              /use the newer requirement/u.test(message.content),
          ),
          true,
        );
        yield { type: "text_delta", text: "steered" };
      }
      yield { type: "done" };
    },
  };
  const tools = {
    listTools: () => ["read"],
    describeTool: () => ({
      name: "read",
      riskLevel: "read-only",
      executionMode: "parallel",
    }),
    async executeTool(call) {
      await toolMayFinish;
      return { ok: true, callId: call.id, output: { content: "ok" } };
    },
  };
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const sessions = new WorkspaceSessionStore({ store });
  const slack = new FakeSlackPublisher();
  const runner = new PerChannelAgentRunner({
    slack,
    agentLoop: new MinimalAgentLoop({ model, tools }),
    createAgentLoopForWorkspace: (_root, _approval, runContext) => {
      runtimeStates.push(runContext.state);
      return new MinimalAgentLoop({
        model,
        tools,
        hooks: [
          new RuntimeModeHook({
            state: runContext.state,
            describeTool: (name) => tools.describeTool(name),
          }),
        ],
      });
    },
    resolveChannelWorkspaceRoot: async () => workspaceRoot,
    sessions,
    tools: [{ name: "read", description: "read", inputSchemaJson: "{}" }],
    maxSteps: 3,
  });

  const activeRun = runner.handleSlackMessage(slackEvent("start long task"));
  await firstRequest;
  await runner.handleSlackMessage(slackEvent("use the newer requirement"));
  let contextMessages = await sessions.readContextMessages(experienceChannelKey());
  assert.equal(
    contextMessages.some(
      (message) =>
        message.role === "user" &&
        /use the newer requirement/u.test(message.content),
    ),
    false,
  );
  releaseTool();
  await activeRun;
  contextMessages = await sessions.readContextMessages(experienceChannelKey());

  assert.equal(requests.length, 2);
  assert.equal(
    contextMessages.some(
      (message) =>
        message.role === "user" &&
        /use the newer requirement/u.test(message.content),
    ),
    true,
  );
  assert.equal(runtimeStates[0].steering.messages.length, 0);
  assert.equal(
    slack.events.some(
      (event) =>
        event.type === "message.post" &&
        /Steering message received/u.test(event.draft.text),
    ),
    true,
  );
}

async function acceptsLocalizedStopCancellation() {
  const workspaceRoot = await createWorkspace("pibot-experience-stop-");
  let toolStarted;
  const toolStartedPromise = new Promise((resolve) => {
    toolStarted = resolve;
  });
  let toolAborted = false;
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield startEvent();
      yield toolCall("read-blocking", "read", { path: "README.md" });
      yield { type: "done" };
    },
  };
  const tools = {
    listTools: () => ["read"],
    describeTool: () => ({
      name: "read",
      riskLevel: "read-only",
      executionMode: "sequential",
    }),
    async executeTool(call, signal) {
      toolStarted();
      await new Promise((resolve) => {
        const abort = () => {
          toolAborted = true;
          resolve();
        };
        if (signal?.aborted === true) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
      });
      return {
        ok: false,
        callId: call.id,
        error: {
          code: "aborted",
          message: "Tool was aborted",
          retryable: false,
        },
      };
    },
  };
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const sessions = new WorkspaceSessionStore({ store });
  const slack = new FakeSlackPublisher();
  const runner = new PerChannelAgentRunner({
    slack,
    agentLoop: new MinimalAgentLoop({ model, tools }),
    createAgentLoopForWorkspace: () =>
      new MinimalAgentLoop({
        model,
        tools,
      }),
    resolveChannelWorkspaceRoot: async () => workspaceRoot,
    sessions,
    tools: [{ name: "read", description: "read", inputSchemaJson: "{}" }],
    maxSteps: 3,
  });

  const activeRun = runner.handleSlackMessage(slackEvent("start long task"));
  await toolStartedPromise;
  await runner.handleSlackMessage(slackEvent("queued follow-up"));
  await runner.handleSlackMessage(slackEvent("停止"));
  await activeRun;

  assert.equal(isAgentStopCommand("停止。"), true);
  assert.equal(toolAborted, true);
  assert.equal(requests.length, 1);
  assert.equal(
    slack.events.some(
      (event) =>
        event.type === "message.update" &&
        /Cancelled/u.test(event.update.text),
    ),
    true,
  );
}

async function acceptsReasoningProgressUpdates() {
  const workspaceRoot = await createWorkspace("pibot-experience-reasoning-");
  const model = {
    async *stream() {
      yield startEvent();
      yield {
        type: "reasoning_delta",
        text: "Checking the workspace and choosing the next step.",
      };
      yield { type: "text_delta", text: "Done." };
      yield { type: "done" };
    },
  };
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const sessions = new WorkspaceSessionStore({ store });
  const slack = new FakeSlackPublisher();
  const runner = new PerChannelAgentRunner({
    slack,
    agentLoop: new MinimalAgentLoop({
      model,
      tools: createCodingToolExecutor({
        workspaceRoot,
        approvalGate: createToolApprovalGate("full-access"),
      }),
    }),
    createAgentLoopForWorkspace: () =>
      new MinimalAgentLoop({
        model,
        tools: createCodingToolExecutor({
          workspaceRoot,
          approvalGate: createToolApprovalGate("full-access"),
        }),
      }),
    resolveChannelWorkspaceRoot: async () => workspaceRoot,
    sessions,
    tools: getCodingToolSchemas(),
    maxSteps: 1,
  });

  await runner.handleSlackMessage(slackEvent("show progress"));

  assert.equal(
    slack.events.some(
      (event) =>
        event.type === "message.update" &&
        /Checking the workspace/u.test(event.update.text),
    ),
    true,
  );
}

async function acceptsInterleavedProgressTimeline() {
  const workspaceRoot = await createWorkspace("pibot-experience-timeline-");
  let requestCount = 0;
  const model = {
    async *stream() {
      requestCount += 1;
      yield startEvent();
      if (requestCount === 1) {
        yield {
          type: "reasoning_delta",
          text: "First thought before reading.",
        };
        yield toolCall("tool-call-read-1", "read", { path: "README.md" });
        yield { type: "done" };
        return;
      }

      yield {
        type: "reasoning_delta",
        text: "Second thought after reading.",
      };
      yield { type: "text_delta", text: "Done." };
      yield { type: "done" };
    },
  };
  const tools = {
    listTools: () => ["read"],
    describeTool: () => ({
      name: "read",
      riskLevel: "read-only",
      executionMode: "sequential",
    }),
    async executeTool(call) {
      return {
        ok: true,
        callId: call.id,
        output: {
          path: call.input.path,
          content: "README content",
        },
      };
    },
  };
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const sessions = new WorkspaceSessionStore({ store });
  const slack = new FakeSlackPublisher();
  const runner = new PerChannelAgentRunner({
    slack,
    agentLoop: new MinimalAgentLoop({ model, tools }),
    createAgentLoopForWorkspace: () =>
      new MinimalAgentLoop({
        model,
        tools,
      }),
    resolveChannelWorkspaceRoot: async () => workspaceRoot,
    sessions,
    tools: [{ name: "read", description: "read", inputSchemaJson: "{}" }],
    maxSteps: 2,
    updateThrottleMs: 0,
    updateMinChars: 0,
  });

  await runner.handleSlackMessage(slackEvent("read then think"));

  const timelineText = slack.events
    .filter((event) => event.type === "message.update")
    .map((event) => event.update.text)
    .find(
      (text) =>
        text.includes("First thought before reading.") &&
        text.includes("Using tool `read`") &&
        text.includes("Tool `read` completed") &&
        text.includes("Second thought after reading."),
    );
  assert.notEqual(timelineText, undefined);
  assert.equal(
    indexesAreIncreasing(timelineText, [
      "First thought before reading.",
      "Using tool `read`",
      "Tool `read` completed",
      "Second thought after reading.",
    ]),
    true,
  );
}

async function acceptsLongUnicodeProgressByteLimit() {
  const workspaceRoot = await createWorkspace("pibot-experience-long-progress-");
  const model = {
    async *stream() {
      yield startEvent();
      yield {
        type: "reasoning_delta",
        text: "我正在检查上下文和工具调用顺序。".repeat(5000),
      };
      yield { type: "text_delta", text: "完成。" };
      yield { type: "done" };
    },
  };
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const sessions = new WorkspaceSessionStore({ store });
  const slack = new ByteLimitSlackPublisher();
  const runner = new PerChannelAgentRunner({
    slack,
    agentLoop: new MinimalAgentLoop({
      model,
      tools: createCodingToolExecutor({
        workspaceRoot,
        approvalGate: createToolApprovalGate("full-access"),
      }),
    }),
    createAgentLoopForWorkspace: () =>
      new MinimalAgentLoop({
        model,
        tools: createCodingToolExecutor({
          workspaceRoot,
          approvalGate: createToolApprovalGate("full-access"),
        }),
      }),
    resolveChannelWorkspaceRoot: async () => workspaceRoot,
    sessions,
    tools: getCodingToolSchemas(),
    maxSteps: 1,
    updateThrottleMs: 0,
    updateMinChars: 0,
  });

  await runner.handleSlackMessage(slackEvent("show long progress"));

  const updateTexts = slack.events
    .filter((event) => event.type === "message.update")
    .map((event) => event.update.text);
  assert.equal(updateTexts.length > 0, true);
  assert.equal(
    updateTexts.every(
      (text) => Buffer.byteLength(text, "utf8") <= SLACK_UPDATE_TEXT_LIMIT,
    ),
    true,
  );
  assert.equal(updateTexts.some((text) => /完成/u.test(text)), true);
}

async function acceptsLongFinalResponseThreading() {
  const workspaceRoot = await createWorkspace("pibot-experience-long-final-");
  const finalText = [
    "Final response start.",
    "Long final detail. ".repeat(260),
    "tail-marker-final-response",
  ].join("\n");
  const model = {
    async *stream() {
      yield startEvent();
      yield { type: "text_delta", text: finalText };
      yield { type: "done" };
    },
  };
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const sessions = new WorkspaceSessionStore({ store });
  const slack = new ByteLimitSlackPublisher();
  const runner = new PerChannelAgentRunner({
    slack,
    agentLoop: new MinimalAgentLoop({
      model,
      tools: createCodingToolExecutor({
        workspaceRoot,
        approvalGate: createToolApprovalGate("full-access"),
      }),
    }),
    createAgentLoopForWorkspace: () =>
      new MinimalAgentLoop({
        model,
        tools: createCodingToolExecutor({
          workspaceRoot,
          approvalGate: createToolApprovalGate("full-access"),
        }),
      }),
    resolveChannelWorkspaceRoot: async () => workspaceRoot,
    sessions,
    tools: getCodingToolSchemas(),
    maxSteps: 1,
    updateThrottleMs: 0,
    updateMinChars: 0,
  });

  await runner.handleSlackMessage(slackEvent("show long final"));

  const updateTexts = slack.events
    .filter((event) => event.type === "message.update")
    .map((event) => event.update.text);
  assert.equal(updateTexts.length > 0, true);
  assert.equal(
    updateTexts.every(
      (text) => Buffer.byteLength(text, "utf8") <= SLACK_UPDATE_TEXT_LIMIT,
    ),
    true,
  );
  assert.equal(updateTexts.at(-1).includes("tail-marker-final-response"), false);
  assert.match(updateTexts.at(-1), /continue in thread/u);

  const threadText = slack.events
    .filter(
      (event) =>
        event.type === "message.post" &&
        event.draft.conversation.threadTs !== undefined,
    )
    .map((event) => event.draft.text)
    .join("\n");
  assert.match(threadText, /Full response/u);
  assert.match(threadText, /tail-marker-final-response/u);
}

async function acceptsProgressClearsOldContent() {
  const workspaceRoot = await createWorkspace("pibot-experience-progress-clear-");
  const model = {
    async *stream() {
      yield startEvent();
      for (let index = 0; index < 20; index += 1) {
        yield {
          type: "reasoning_delta",
          text: `progress-${index} ${"details ".repeat(20)}\n`,
        };
      }
      yield {
        type: "reasoning_delta",
        text: "latest-important-progress\n",
      };
      yield { type: "text_delta", text: "Done." };
      yield { type: "done" };
    },
  };
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const sessions = new WorkspaceSessionStore({ store });
  const slack = new FakeSlackPublisher();
  const runner = new PerChannelAgentRunner({
    slack,
    agentLoop: new MinimalAgentLoop({
      model,
      tools: createCodingToolExecutor({
        workspaceRoot,
        approvalGate: createToolApprovalGate("full-access"),
      }),
    }),
    createAgentLoopForWorkspace: () =>
      new MinimalAgentLoop({
        model,
        tools: createCodingToolExecutor({
          workspaceRoot,
          approvalGate: createToolApprovalGate("full-access"),
        }),
      }),
    resolveChannelWorkspaceRoot: async () => workspaceRoot,
    sessions,
    tools: getCodingToolSchemas(),
    maxSteps: 1,
    updateThrottleMs: 0,
    updateMinChars: 0,
  });

  await runner.handleSlackMessage(slackEvent("show rolling progress"));

  const latestUpdate = slack.events
    .filter((event) => event.type === "message.update")
    .map((event) => event.update.text)
    .find((text) => text.includes("latest-important-progress"));
  assert.notEqual(latestUpdate, undefined);
  assert.match(latestUpdate, /Earlier progress cleared/u);
  assert.equal(latestUpdate.includes("progress-0"), false);
}

async function acceptsReasoningProgressOmitsCode() {
  const workspaceRoot = await createWorkspace("pibot-experience-progress-code-");
  const model = {
    async *stream() {
      yield startEvent();
      yield {
        type: "reasoning_delta",
        text: [
          "I need to inspect the implementation.",
          "```python",
          "def should_not_be_sent_to_slack():",
          "    return 'full source code'",
          "```",
          "Now I can continue with a concise status.",
        ].join("\n"),
      };
      yield { type: "text_delta", text: "Done." };
      yield { type: "done" };
    },
  };
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const sessions = new WorkspaceSessionStore({ store });
  const slack = new FakeSlackPublisher();
  const runner = new PerChannelAgentRunner({
    slack,
    agentLoop: new MinimalAgentLoop({
      model,
      tools: createCodingToolExecutor({
        workspaceRoot,
        approvalGate: createToolApprovalGate("full-access"),
      }),
    }),
    createAgentLoopForWorkspace: () =>
      new MinimalAgentLoop({
        model,
        tools: createCodingToolExecutor({
          workspaceRoot,
          approvalGate: createToolApprovalGate("full-access"),
        }),
      }),
    resolveChannelWorkspaceRoot: async () => workspaceRoot,
    sessions,
    tools: getCodingToolSchemas(),
    maxSteps: 1,
    updateThrottleMs: 0,
    updateMinChars: 0,
  });

  await runner.handleSlackMessage(slackEvent("omit code from progress"));

  const progressUpdate = slack.events.find(
    (event) =>
      event.type === "message.update" &&
      /I need to inspect/u.test(event.update.text),
  );
  assert.notEqual(progressUpdate, undefined);
  assert.match(progressUpdate.update.text, /\[code\/content omitted\]/u);
  assert.equal(/should_not_be_sent_to_slack/u.test(progressUpdate.update.text), false);
}

async function acceptsSlackProgressUpdateFailureDoesNotAbort() {
  const workspaceRoot = await createWorkspace("pibot-experience-slack-fail-");
  const model = {
    async *stream() {
      yield startEvent();
      yield {
        type: "reasoning_delta",
        text: "This progress update will fail once.",
      };
      yield { type: "text_delta", text: "Still finished." };
      yield { type: "done" };
    },
  };
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const sessions = new WorkspaceSessionStore({ store });
  const slack = new OneUpdateFailureSlackPublisher();
  const runner = new PerChannelAgentRunner({
    slack,
    agentLoop: new MinimalAgentLoop({
      model,
      tools: createCodingToolExecutor({
        workspaceRoot,
        approvalGate: createToolApprovalGate("full-access"),
      }),
    }),
    createAgentLoopForWorkspace: () =>
      new MinimalAgentLoop({
        model,
        tools: createCodingToolExecutor({
          workspaceRoot,
          approvalGate: createToolApprovalGate("full-access"),
        }),
      }),
    resolveChannelWorkspaceRoot: async () => workspaceRoot,
    sessions,
    tools: getCodingToolSchemas(),
    maxSteps: 1,
    updateThrottleMs: 0,
    updateMinChars: 0,
  });

  await runner.handleSlackMessage(slackEvent("survive Slack update failure"));

  assert.equal(
    slack.events.some(
      (event) =>
        event.type === "message.update" &&
        /Still finished/u.test(event.update.text),
    ),
    true,
  );
  assert.equal(
    slack.events.some(
      (event) =>
        event.type === "message.update" &&
        /Agent error/u.test(event.update.text),
    ),
    false,
  );
}

async function acceptsRealtimeGeneratedContext() {
  const workspaceRoot = await createWorkspace("pibot-experience-context-");
  let requestCount = 0;
  let toolStarted;
  const toolStartedPromise = new Promise((resolve) => {
    toolStarted = resolve;
  });
  let finishTool = () => {};
  const finishToolPromise = new Promise((resolve) => {
    finishTool = resolve;
  });
  let secondTurnStarted;
  const secondTurnStartedPromise = new Promise((resolve) => {
    secondTurnStarted = resolve;
  });
  let finishFinalTurn = () => {};
  const finishFinalTurnPromise = new Promise((resolve) => {
    finishFinalTurn = resolve;
  });
  const model = {
    async *stream() {
      requestCount += 1;
      yield startEvent();
      if (requestCount === 1) {
        yield toolCall("tool-call-read-1", "read", { path: "README.md" });
        yield { type: "done" };
        return;
      }

      secondTurnStarted();
      await finishFinalTurnPromise;
      yield { type: "text_delta", text: "Read complete." };
      yield { type: "done" };
    },
  };
  const tools = {
    listTools: () => ["read"],
    describeTool: () => ({
      name: "read",
      riskLevel: "read-only",
      executionMode: "sequential",
    }),
    async executeTool(call) {
      toolStarted();
      await finishToolPromise;
      return {
        ok: true,
        callId: call.id,
        output: {
          path: call.input.path,
          content: "README content",
        },
      };
    },
  };
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const sessions = new WorkspaceSessionStore({ store });
  const runner = new PerChannelAgentRunner({
    slack: new FakeSlackPublisher(),
    agentLoop: new MinimalAgentLoop({ model, tools }),
    createAgentLoopForWorkspace: () =>
      new MinimalAgentLoop({
        model,
        tools,
      }),
    resolveChannelWorkspaceRoot: async () => workspaceRoot,
    sessions,
    tools: [{ name: "read", description: "read", inputSchemaJson: "{}" }],
    maxSteps: 2,
  });

  const activeRun = runner.handleSlackMessage(slackEvent("read README"));
  try {
    await toolStartedPromise;
    let contextMessages = await sessions.readContextMessages(experienceChannelKey());
    assert.equal(
      contextMessages.some(
        (message) =>
          message.role === "assistant" &&
          message.toolCalls?.some(
            (call) => call.id === "tool-call-read-1" && call.name === "read",
          ) === true,
      ),
      true,
    );

    finishTool();
    await secondTurnStartedPromise;
    contextMessages = await sessions.readContextMessages(experienceChannelKey());
    assert.equal(
      contextMessages.some(
        (message) =>
          message.role === "tool" &&
          message.toolCallId === "tool-call-read-1" &&
          /README content/u.test(message.content),
      ),
      true,
    );

    finishFinalTurn();
    await activeRun;
  } finally {
    finishTool();
    finishFinalTurn();
    await activeRun.catch(() => {});
  }

  assert.equal(requestCount, 2);
}

async function acceptsLongRunningStatus() {
  const workspaceRoot = await createWorkspace("pibot-experience-status-");
  const model = {
    async *stream() {
      yield startEvent();
      await wait(80);
      yield { type: "text_delta", text: "done" };
      yield { type: "done" };
    },
  };
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const sessions = new WorkspaceSessionStore({ store });
  const slack = new FakeSlackPublisher();
  const runner = new PerChannelAgentRunner({
    slack,
    agentLoop: new MinimalAgentLoop({
      model,
      tools: createCodingToolExecutor({
        workspaceRoot,
        approvalGate: createToolApprovalGate("full-access"),
      }),
    }),
    createAgentLoopForWorkspace: () =>
      new MinimalAgentLoop({
        model,
        tools: createCodingToolExecutor({
          workspaceRoot,
          approvalGate: createToolApprovalGate("full-access"),
        }),
      }),
    resolveChannelWorkspaceRoot: async () => workspaceRoot,
    sessions,
    tools: getCodingToolSchemas(),
    maxSteps: 1,
    longTaskStatusUpdateMs: 20,
  });

  await runner.handleSlackMessage(slackEvent("take a while"));

  assert.equal(
    slack.events.some(
      (event) =>
        event.type === "message.update" &&
        /Still working/u.test(event.update.text),
    ),
    true,
  );
}

async function createWorkspace(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

function slackEvent(text) {
  return {
    type: "direct_message",
    eventId: `E-${Date.now()}-${Math.random()}`,
    conversation: {
      teamId: "T-exp",
      channelId: "D-exp",
    },
    senderUserId: "U-exp",
    text,
    messageTs: `${Date.now()}.000000`,
    files: [],
    receivedAt: new Date(),
  };
}

function experienceChannelKey() {
  return {
    teamId: "T-exp",
    channelId: "D-exp",
  };
}

function indexesAreIncreasing(text, fragments) {
  let previous = -1;
  for (const fragment of fragments) {
    const index = text.indexOf(fragment);
    if (index <= previous) {
      return false;
    }
    previous = index;
  }

  return true;
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

function startEvent() {
  return {
    type: "start",
    provider: "openai_compatible",
    model: "fake-model",
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    if (event.type === "message.update") {
      return {
        conversation: event.update.conversation,
        messageTs: event.update.messageTs,
      };
    }
    if (event.type === "file.upload") {
      return {
        conversation: event.file.conversation,
      };
    }
    return {
      conversation: event.reaction.conversation,
      messageTs: event.reaction.messageTs,
    };
  }
}

class ByteLimitSlackPublisher extends FakeSlackPublisher {
  async publishSlackEvent(event) {
    const text =
      event.type === "message.post"
        ? event.draft.text
        : event.type === "message.update"
          ? event.update.text
          : undefined;
    const limit =
      event.type === "message.update" ? SLACK_UPDATE_TEXT_LIMIT : SLACK_TEXT_LIMIT;
    if (text !== undefined && Buffer.byteLength(text, "utf8") > limit) {
      throw new Error("An API error occurred: msg_too_long");
    }

    return super.publishSlackEvent(event);
  }
}

class OneUpdateFailureSlackPublisher extends FakeSlackPublisher {
  constructor() {
    super();
    this.failed = false;
  }

  async publishSlackEvent(event) {
    if (event.type === "message.update" && !this.failed) {
      this.failed = true;
      throw new Error("An API error occurred: msg_too_long");
    }

    return super.publishSlackEvent(event);
  }
}

runAcceptance().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
