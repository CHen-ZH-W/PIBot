const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { promisify } = require("node:util");
const { MinimalAgentLoop } = require("../dist/agent/agent-loop");
const { PerChannelAgentRunner } = require("../dist/agent/runner");
const {
  createCodingToolExecutor,
  createToolApprovalGate,
  getCodingToolSchemas,
} = require("../dist/tools");
const { ChannelRepoWorkflow } = require("../dist/workspace/repo");
const { createSandboxExecutor } = require("../dist/workspace/sandbox");
const { WorkspaceSessionStore } = require("../dist/workspace/session");
const { FileChannelWorkspaceStore } = require("../dist/workspace/store");

const execFileAsync = promisify(execFile);

async function runAcceptance() {
  await runCase("bot modifies files in the configured repo", acceptsRepoEdit);
  await runCase("final reply includes diff summary", acceptsDiffSummary);
  await runCase("check failure is reported with reason", acceptsCheckFailure);
  await runCase("repo check uses SandboxExecutor", acceptsSandboxedRepoCheck);
  await runCase("missing repo config writes to channel directory", acceptsChannelDirectoryFallback);
  console.log("Repo workflow acceptance passed");
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

async function acceptsRepoEdit() {
  const fixture = await createFixture({ checkCommand: "node -e \"process.exit(0)\"" });
  const model = createEditModel();
  const slack = new FakeSlackPublisher();
  const runner = createRunner(fixture, model, slack);

  await runner.handleSlackMessage(slackEvent("Change color to blue"));

  const content = await readFile(join(fixture.repoRoot, "fixture.txt"), "utf8");
  assert.equal(content, "color=blue\n");
  assert.equal(model.requestCount(), 2);
}

async function acceptsDiffSummary() {
  const fixture = await createFixture({ checkCommand: "node -e \"process.exit(0)\"" });
  const model = createEditModel();
  const slack = new FakeSlackPublisher();
  const runner = createRunner(fixture, model, slack);

  await runner.handleSlackMessage(slackEvent("Change color to blue"));

  const finalText = slack.finalMainText();
  assert.match(finalText, /Diff summary:/u);
  assert.match(finalText, /fixture\.txt/u);
  assert.match(finalText, /Changed files:/u);
}

async function acceptsCheckFailure() {
  const fixture = await createFixture({
    checkCommand: "node -e \"console.error('intentional failure'); process.exit(2)\"",
  });
  const model = createEditModel();
  const slack = new FakeSlackPublisher();
  const runner = createRunner(fixture, model, slack);

  await runner.handleSlackMessage(slackEvent("Change color to blue"));

  const finalText = slack.finalMainText();
  assert.match(finalText, /Check result: failed with exit 2/u);
  assert.match(finalText, /intentional failure/u);
  assert.match(finalText, /Remaining risks: check failed/u);
}

async function acceptsChannelDirectoryFallback() {
  const fixture = await createFixtureWithoutRepoConfig();
  const model = createChannelWriteModel();
  const slack = new FakeSlackPublisher();
  const runner = createRunner(fixture, model, slack);

  await runner.handleSlackMessage(slackEvent("Create a helper file"));

  const content = await readFile(join(fixture.channelDir, "helper.txt"), "utf8");
  assert.equal(content, "hello from channel\n");
  assert.equal(model.requestCount(), 2);
  assert.doesNotMatch(slack.finalMainText(), /Repo workflow is not configured/u);
}

async function acceptsSandboxedRepoCheck() {
  const fixture = await createFixture({ checkCommand: "printf sandbox-check" });
  const requests = [];
  const sandboxExecutor = {
    assertWorkspaceAccess() {},
    async execute(request) {
      requests.push(request);
      return {
        exitCode: 0,
        stdout: "sandboxed",
        stderr: "",
        timedOut: false,
        aborted: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    },
  };
  const workflow = new ChannelRepoWorkflow({
    workspaceRoot: fixture.workspaceRoot,
    store: fixture.store,
    sandboxExecutor,
  });

  const result = await workflow.run_check(channelKey());

  assert.equal(requests.length, 1);
  assert.equal(requests[0].command, "printf sandbox-check");
  assert.equal(requests[0].workspaceRoot, fixture.repoRoot);
  assert.equal(requests[0].cwd, fixture.repoRoot);
  assert.equal(result.stdout, "sandboxed");
}

function createEditModel() {
  let requests = 0;

  return {
    requestCount() {
      return requests;
    },
    async *stream(request) {
      requests += 1;
      yield startEvent();

      if (requests === 1) {
        assert.match(request.messages[0].content, /Repo workflow:/u);
        yield toolCall("edit-call", "edit", {
          path: "fixture.txt",
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
        yield {
          type: "text_delta",
          text: "Edited fixture.",
        };
      }

      yield { type: "done" };
    },
  };
}

function createChannelWriteModel() {
  let requests = 0;

  return {
    requestCount() {
      return requests;
    },
    async *stream(request) {
      requests += 1;
      yield startEvent();

      if (requests === 1) {
        assert.match(request.messages[0].content, /No repo is configured/u);
        yield toolCall("write-call", "write", {
          path: "helper.txt",
          content: "hello from channel\n",
          overwrite: true,
        });
      } else {
        assertToolPayload(request, {
          ok: true,
          contains: "write",
        });
        yield {
          type: "text_delta",
          text: "Created helper file.",
        };
      }

      yield { type: "done" };
    },
  };
}

function createRunner(fixture, model, slack) {
  const sandboxExecutor = createSandboxExecutor({
    kind: "host",
    enabled: true,
  });
  const approvalGate = createToolApprovalGate("workspace-write");
  const fallbackTools = createCodingToolExecutor({
    workspaceRoot: fixture.workspaceRoot,
    approvalGate,
    maxCommandOutputChars: 1000,
  });

  return new PerChannelAgentRunner({
    slack,
    agentLoop: new MinimalAgentLoop({
      model,
      tools: fallbackTools,
    }),
    createAgentLoopForWorkspace: (workspaceRoot) =>
      new MinimalAgentLoop({
        model,
        tools: createCodingToolExecutor({
          workspaceRoot,
          approvalGate,
          maxCommandOutputChars: 1000,
        }),
      }),
    sessions: new WorkspaceSessionStore({ store: fixture.store }),
    tools: getCodingToolSchemas(),
    maxSteps: 4,
    repoWorkflow: new ChannelRepoWorkflow({
      workspaceRoot: fixture.workspaceRoot,
      store: fixture.store,
      sandboxExecutor,
    }),
    resolveChannelWorkspaceRoot: async () => fixture.channelDir,
    updateThrottleMs: 0,
    updateMinChars: 0,
  });
}

async function createFixture(repoConfig) {
  const fixture = await createFixtureWithoutRepoConfig();
  await writeFile(
    join(fixture.channelDir, "repo.json"),
    JSON.stringify(
      {
        repoPath: "repo",
        checkCommand: repoConfig.checkCommand,
      },
      null,
      2,
    ),
    "utf8",
  );

  return fixture;
}

async function createFixtureWithoutRepoConfig() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pibot-repo-workflow-"));
  const storeRoot = join(workspaceRoot, ".pibot");
  const repoRoot = join(workspaceRoot, "repo");
  await mkdir(repoRoot, { recursive: true });
  await writeFile(join(repoRoot, "fixture.txt"), "color=red\n", "utf8");
  await git(["init"], repoRoot);
  await git(["add", "fixture.txt"], repoRoot);
  await git(
    [
      "-c",
      "user.email=pibot@example.test",
      "-c",
      "user.name=Pi Bot",
      "commit",
      "-m",
      "initial fixture",
    ],
    repoRoot,
  );

  const store = new FileChannelWorkspaceStore({ rootDir: storeRoot });
  const channelDir = (await store.ensureChannelDirectory(channelKey())).channelDir;

  return {
    workspaceRoot,
    storeRoot,
    repoRoot,
    store,
    channelDir,
  };
}

async function git(args, cwd) {
  await execFileAsync("git", args, { cwd });
}

class FakeSlackPublisher {
  constructor() {
    this.events = [];
    this.nextTs = 1;
  }

  async publishSlackEvent(event) {
    this.events.push(event);

    if (event.type === "message.post") {
      const messageTs = `${this.nextTs}.000000`;
      this.nextTs += 1;
      return {
        conversation: event.draft.conversation,
        messageTs,
      };
    }

    if (event.type === "message.update") {
      return {
        conversation: event.update.conversation,
        messageTs: event.update.messageTs,
      };
    }

    return {
      conversation: event.reaction.conversation,
      messageTs: event.reaction.messageTs,
    };
  }

  finalMainText() {
    const updates = this.events.filter((event) => event.type === "message.update");
    const lastUpdate = updates.at(-1);
    if (lastUpdate !== undefined) {
      return lastUpdate.update.text;
    }

    const posts = this.events.filter((event) => event.type === "message.post");
    return posts.at(-1)?.draft.text ?? "";
  }
}

function slackEvent(text) {
  return {
    type: "direct_message",
    eventId: `Ev-${Date.now()}-${Math.random()}`,
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
