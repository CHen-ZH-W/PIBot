const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, symlink, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
  buildCodingAgentSystemPrompt,
} = require("../dist/agent/system-prompt");
const { MinimalAgentLoop } = require("../dist/agent/agent-loop");
const { PerChannelAgentRunner } = require("../dist/agent/runner");
const {
  createCodingToolExecutor,
  createToolApprovalGate,
  getCodingToolSchemas,
} = require("../dist/tools");
const { WorkspaceSessionStore } = require("../dist/workspace/session");
const { FileChannelWorkspaceStore } = require("../dist/workspace/store");
const {
  importOpenAiSkillPackage,
  scanWorkspaceSkills,
  validateSkillMarkdown,
} = require("../dist/workspace/skills");

async function runAcceptance() {
  await runCase("skill scanner parses metadata and supports disabling names", acceptsSkillScan);
  await runCase("skill scanner rejects a symbolic-link root", acceptsSkillRootSymlinkRejection);
  await runCase("skill validation rejects malformed creation input", acceptsSkillValidation);
  await runCase("OpenAI-format skill import updates the pibot-wide index", acceptsOpenAiSkillImport);
  await runCase("system prompt frames pibot as a coding-agent runtime", acceptsRuntimeFramingPrompt);
  await runCase("runner injects pibot-wide skill index and model loads the body with read_skill", acceptsIndexedSkillRead);
  await runCase("system prompt guides the model to create a pibot-wide skill with write_skill", acceptsPromptGuidedSkillCreation);
  console.log("Skills acceptance passed");
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

async function acceptsSkillScan() {
  const workspaceRoot = await createWorkspace();
  await writePibotSkill(
    workspaceRoot,
    "pibot-wide-check",
    "Verify behavior shared by every pibot conversation.",
    "# Pibot Wide Check\n\nRun the shared workflow.",
  );
  await writeSkill(
    workspaceRoot,
    "release-check",
    "Verify release readiness before publishing.",
    "# Release Check\n\nRun the focused checks.",
  );
  await writeSkill(
    workspaceRoot,
    "disabled-skill",
    "A disabled manual.",
    "# Disabled\n\nDo not index this skill.",
  );
  await writeLegacySkill(
    workspaceRoot,
    "legacy-check",
    "Verify a legacy pibot skill layout.",
    "# Legacy Check\n\nRun the old layout.",
  );

  const result = await scanWorkspaceSkills(workspaceRoot, {
    disabledSkills: ["disabled-skill"],
  });

  assert.deepEqual(publicSkillFields(result.skills), [
    {
      name: "pibot-wide-check",
      description: "Verify behavior shared by every pibot conversation.",
      source: "pibot",
      location: ".pibot/skills/pibot-wide-check/SKILL.md",
      disableModelInvocation: false,
    },
    {
      name: "release-check",
      description: "Verify release readiness before publishing.",
      source: "workspace",
      location: ".agents/skills/release-check/SKILL.md",
      disableModelInvocation: false,
    },
    {
      name: "legacy-check",
      description: "Verify a legacy pibot skill layout.",
      source: "legacy",
      location: "skills/legacy-check/SKILL.md",
      disableModelInvocation: false,
    },
  ]);
  assert.deepEqual(result.disabledSkills, ["disabled-skill"]);
  assert.deepEqual(result.issues, []);
}

async function acceptsSkillValidation() {
  const missingDescription = validateSkillMarkdown(
    "---\nname: release-check\n---\n# Release Check\n",
    "release-check",
  );
  const mismatchedName = validateSkillMarkdown(
    "---\nname: another-name\ndescription: Shared skill name.\nmetadata:\n  author: pibot\ndisable-model-invocation: true\n---\n# Shared\n",
    "release-check",
  );

  assert.equal(missingDescription.ok, false);
  assert.equal(missingDescription.issue.code, "invalid_skill_description");
  assert.equal(mismatchedName.ok, true);
  assert.equal(mismatchedName.skill.name, "another-name");
  assert.equal(mismatchedName.skill.disableModelInvocation, true);
  assert.equal(mismatchedName.issues.length, 1);
  assert.equal(mismatchedName.issues[0].code, "invalid_skill_name");
}

async function acceptsSkillRootSymlinkRejection() {
  const workspaceRoot = await createWorkspace();
  const outsideRoot = await createWorkspace();
  await mkdir(join(outsideRoot, "outside-skill"), { recursive: true });
  await mkdir(join(workspaceRoot, ".pibot"), { recursive: true });
  await symlink(outsideRoot, join(workspaceRoot, ".pibot", "skills"));

  const result = await scanWorkspaceSkills(workspaceRoot);

  assert.deepEqual(result.skills, []);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, "invalid_skill_directory");
}

async function acceptsOpenAiSkillImport() {
  const workspaceRoot = await createWorkspace();
  const channelRoot = join(workspaceRoot, ".pibot", "channels", "T-skills", "D-skills");
  const pibotSkillsRoot = join(workspaceRoot, ".pibot", "skills");
  const before = await scanWorkspaceSkills(channelRoot, { pibotSkillsRoot });
  assert.deepEqual(before.skills, []);

  const imported = await importOpenAiSkillPackage({
    pibotSkillsRoot,
    files: [
      {
        path: "release-check/SKILL.md",
        content:
          "---\n" +
          "name: imported-release\n" +
          "description: Verify an imported OpenAI-format release workflow.\n" +
          "---\n" +
          "# Imported Release\n\nRead the checklist before publishing.\n",
      },
      {
        path: "release-check/agents/openai.yaml",
        content: "policy:\n  allow_implicit_invocation: true\n",
      },
      {
        path: "release-check/references/checklist.md",
        content: "# Checklist\n\n- Run tests.\n",
      },
      {
        path: "release-check/ignored.txt",
        content: "ignored",
      },
    ],
  });

  assert.equal(imported.skill.name, "imported-release");
  assert.deepEqual(imported.writtenFiles.sort(), [
    ".pibot/skills/imported-release/SKILL.md",
    ".pibot/skills/imported-release/agents/openai.yaml",
    ".pibot/skills/imported-release/references/checklist.md",
  ]);
  assert.equal(
    await readFile(join(pibotSkillsRoot, "imported-release", "references", "checklist.md"), "utf8"),
    "# Checklist\n\n- Run tests.\n",
  );

  const after = await scanWorkspaceSkills(channelRoot, { pibotSkillsRoot });
  assert.deepEqual(publicSkillFields(after.skills), [
    {
      name: "imported-release",
      description: "Verify an imported OpenAI-format release workflow.",
      source: "pibot",
      location: ".pibot/skills/imported-release/SKILL.md",
      disableModelInvocation: false,
    },
  ]);
}

async function acceptsRuntimeFramingPrompt() {
  const systemPrompt = buildCodingAgentSystemPrompt({
    tools: getCodingToolSchemas(),
    memories: {},
    workspaceSkills: [],
    repoPrompt: undefined,
    channelWorkspacePrompt: undefined,
    workspaceRoot: "/tmp/pibot-runtime-framing",
    now: new Date("2026-06-29T00:00:00.000Z"),
  });

  assert.match(systemPrompt, /pibot, a coding-agent runtime/u);
  assert.match(systemPrompt, /current interface as a transport adapter/u);
  assert.match(
    systemPrompt,
    /Runtime use: treat injected memory_summary\.md and MEMORY\.md content as compact routing indexes/u,
  );
  assert.match(
    systemPrompt,
    /Before the final answer for non-trivial work, review whether the run produced durable memory candidates/u,
  );
  assert.match(systemPrompt, /Durable candidates include stable user preferences/u);
  assert.match(systemPrompt, /Summarize memories as reusable triggers and guidance/u);
  assert.match(systemPrompt, /Persistent memory is a single Codex-like global store/u);
  assert.match(systemPrompt, /completed task recaps in rollout_summary documents/u);
  assert.match(systemPrompt, /runtime automatically records run-end recaps as rollout_summary documents/u);
  assert.match(systemPrompt, /Do not store one-off task details, secrets, private data/u);
  assert.doesNotMatch(systemPrompt, /Slack coding agent harness/u);
  assert.doesNotMatch(systemPrompt, /Slack/u);
  assert.doesNotMatch(systemPrompt, /\bIM\b/u);
}

async function acceptsIndexedSkillRead() {
  const workspaceRoot = await createWorkspace();
  const channelRoot = join(workspaceRoot, ".pibot", "channels", "T-skills", "D-skills");
  const pibotSkillsRoot = join(workspaceRoot, ".pibot", "skills");
  const skillBody =
    "# Release Check\n\nINTERNAL RELEASE PROCEDURE BODY\n\nRun `npm test` before publishing.";
  await writePibotSkill(
    workspaceRoot,
    "release-check",
    "Verify release readiness before publishing.",
    skillBody,
  );
  await writePibotSkill(
    workspaceRoot,
    "disabled-skill",
    "This should stay out of the prompt.",
    "# Disabled\n\nDo not load.",
  );
  await writePibotSkill(
    workspaceRoot,
    "manual-only",
    "This requires an explicit read request.",
    "# Manual Only\n\nDo not disclose automatically.",
    "disable-model-invocation: true",
  );
  await writePibotSkill(
    workspaceRoot,
    "openai-manual",
    "This is hidden through OpenAI skill metadata.",
    "# OpenAI Manual\n\nDo not disclose automatically.",
  );
  await writeOpenAiSkillPolicy(pibotSkillsRoot, "openai-manual", false);

  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield startEvent();
      if (requests.length === 1) {
        const systemPrompt = request.messages.find((message) =>
          message.role === "developer" &&
          message.content.includes("<available_skills>"))?.content;
        assert.notEqual(systemPrompt, undefined);
        assert.match(systemPrompt, /<available_skills>/u);
        assert.match(systemPrompt, /<name>release-check<\/name>/u);
        assert.match(systemPrompt, /<description>Verify release readiness/u);
        assert.match(systemPrompt, /<source>pibot<\/source>/u);
        assert.match(systemPrompt, /<location>\.pibot\/skills\/release-check\/SKILL\.md<\/location>/u);
        assert.doesNotMatch(systemPrompt, /INTERNAL RELEASE PROCEDURE BODY/u);
        assert.doesNotMatch(systemPrompt, /disabled-skill/u);
        assert.doesNotMatch(systemPrompt, /manual-only/u);
        assert.doesNotMatch(systemPrompt, /openai-manual/u);
        yield toolCall("read-skill", "read_skill", {
          location: ".pibot/skills/release-check/SKILL.md",
        });
      } else {
        const toolPayload = JSON.parse(
          request.messages.find((message) => message.role === "tool").content,
        );
        assert.equal(toolPayload.ok, true);
        assert.match(toolPayload.output.content, /INTERNAL RELEASE PROCEDURE BODY/u);
        yield { type: "text_delta", text: "Loaded the matching skill with read_skill." };
      }
      yield { type: "done" };
    },
  };
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const sessions = new WorkspaceSessionStore({ store });
  const toolsForWorkspace = () =>
    createCodingToolExecutor({
      workspaceRoot: channelRoot,
      pibotSkillsRoot,
      approvalGate: createToolApprovalGate("read-only"),
    });
  const runner = new PerChannelAgentRunner({
    slack: new FakeSlackPublisher(),
    agentLoop: new MinimalAgentLoop({
      model,
      tools: toolsForWorkspace(),
    }),
    createAgentLoopForWorkspace: (_workspaceRoot, _approvalContext, _runContext, workspaceSkills) =>
      new MinimalAgentLoop({
        model,
        tools: createCodingToolExecutor({
          workspaceRoot: channelRoot,
          pibotSkillsRoot,
          skills: workspaceSkills,
          approvalGate: createToolApprovalGate("read-only"),
        }),
      }),
    resolveChannelWorkspaceRoot: async () => channelRoot,
    sessions,
    tools: getCodingToolSchemas(),
    disabledSkills: ["disabled-skill"],
    pibotSkillsRoot,
    maxSteps: 3,
  });

  await runner.handleSlackMessage(slackEvent("Check whether this release is ready"));

  assert.equal(requests.length, 2);
}

async function acceptsPromptGuidedSkillCreation() {
  const workspaceRoot = await createWorkspace();
  const channelRoot = join(workspaceRoot, ".pibot", "channels", "T-skills", "D-skills");
  const pibotSkillsRoot = join(workspaceRoot, ".pibot", "skills");
  const createdSkill =
    "---\n" +
    "name: focused-test\n" +
    "description: Run the focused TypeScript check. Use when validating a narrow TypeScript change.\n" +
    "---\n" +
    "# Focused Test\n\n" +
    "Run the relevant TypeScript test before reporting completion.\n";
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield startEvent();
      if (requests.length === 1) {
        const systemPrompt = request.messages.find((message) =>
          message.role === "developer" &&
          message.content.includes("stable-developer-instructions")).content;
        assert.match(systemPrompt, /You may create or improve a reusable Skill/u);
        assert.match(systemPrompt, /\.pibot\/skills\/<skill-name>\/SKILL\.md/u);
        assert.match(systemPrompt, /Available tools:/u);
        assert.match(systemPrompt, /- write_skill:/u);
        yield toolCall("write-skill", "write_skill", {
          name: "focused-test",
          content: createdSkill,
          overwrite: false,
        });
      } else {
        const toolPayload = JSON.parse(
          request.messages.find((message) => message.role === "tool").content,
        );
        assert.equal(toolPayload.ok, true);
        yield { type: "text_delta", text: "Created .pibot/skills/focused-test/SKILL.md." };
      }
      yield { type: "done" };
    },
  };
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const sessions = new WorkspaceSessionStore({ store });
  const toolsForWorkspace = () =>
    createCodingToolExecutor({
      workspaceRoot: channelRoot,
      pibotSkillsRoot,
      approvalGate: createToolApprovalGate("full-access"),
    });
  const runner = new PerChannelAgentRunner({
    slack: new FakeSlackPublisher(),
    agentLoop: new MinimalAgentLoop({
      model,
      tools: toolsForWorkspace(),
    }),
    createAgentLoopForWorkspace: (_workspaceRoot, _approvalContext, _runContext, workspaceSkills) =>
      new MinimalAgentLoop({
        model,
        tools: createCodingToolExecutor({
          workspaceRoot: channelRoot,
          pibotSkillsRoot,
          skills: workspaceSkills,
          approvalGate: createToolApprovalGate("full-access"),
        }),
      }),
    resolveChannelWorkspaceRoot: async () => channelRoot,
    sessions,
    tools: getCodingToolSchemas(),
    pibotSkillsRoot,
    maxSteps: 3,
  });

  await runner.handleSlackMessage(slackEvent("Create a reusable focused-test skill"));

  assert.equal(
    await readFile(join(pibotSkillsRoot, "focused-test", "SKILL.md"), "utf8"),
    createdSkill,
  );
  assert.deepEqual(
    (await scanWorkspaceSkills(channelRoot, { pibotSkillsRoot })).skills.map((skill) => skill.name),
    ["focused-test"],
  );
}

async function createWorkspace() {
  return mkdtemp(join(tmpdir(), "pibot-skills-"));
}

function publicSkillFields(skills) {
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    source: skill.source,
    location: skill.location,
    disableModelInvocation: skill.disableModelInvocation,
  }));
}

async function writePibotSkill(workspaceRoot, name, description, body, extraFrontmatter = "") {
  const directory = join(workspaceRoot, ".pibot", "skills", name);
  await writeSkillAt(directory, name, description, body, extraFrontmatter);
}

async function writeSkill(workspaceRoot, name, description, body, extraFrontmatter = "") {
  const directory = join(workspaceRoot, ".agents", "skills", name);
  await writeSkillAt(directory, name, description, body, extraFrontmatter);
}

async function writeOpenAiSkillPolicy(skillsRoot, name, allowImplicitInvocation) {
  const directory = join(skillsRoot, name, "agents");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "openai.yaml"),
    `policy:\n  allow_implicit_invocation: ${allowImplicitInvocation ? "true" : "false"}\n`,
    "utf8",
  );
}

async function writeLegacySkill(workspaceRoot, name, description, body, extraFrontmatter = "") {
  const directory = join(workspaceRoot, "skills", name);
  await writeSkillAt(directory, name, description, body, extraFrontmatter);
}

async function writeSkillAt(directory, name, description, body, extraFrontmatter = "") {
  await mkdir(directory, { recursive: true });
  const optionalExtraFrontmatter =
    extraFrontmatter.length === 0 ? "" : `${extraFrontmatter}\n`;
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n${optionalExtraFrontmatter}---\n${body}\n`,
    "utf8",
  );
}

function slackEvent(text) {
  return {
    type: "direct_message",
    eventId: "E-skills",
    conversation: {
      teamId: "T-skills",
      channelId: "D-skills",
    },
    senderUserId: "U-skills",
    text,
    messageTs: `${Date.now()}.000000`,
    files: [],
    receivedAt: new Date(),
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
  }

  async publishSlackEvent(event) {
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

runAcceptance().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
