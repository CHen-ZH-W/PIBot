const assert = require("node:assert/strict");
const {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const vm = require("node:vm");
const {
  calculateUsage,
  defaultUsagePricingForModel,
  usagePricingFromEnv,
} = require("../dist/app/usage");
const { MinimalAgentLoop } = require("../dist/agent/agent-loop");
const {
  OpenAICompatibleModelClient,
} = require("../dist/agent/model");
const {
  buildCodingAgentSystemPrompt,
} = require("../dist/agent/system-prompt");
const {
  isSlackEventBefore,
  normalizeSlackEventFromRaw,
  parseSocketModeInteractiveEnvelope,
} = require("../dist/slack/client");
const {
  SlackToolApprovalBroker,
  TOOL_APPROVAL_ALLOW_ACTION,
  TOOL_APPROVAL_ALLOW_RUN_ACTION,
  TOOL_APPROVAL_DENY_ACTION,
} = require("../dist/slack/approval");
const {
  appendAttachmentPathsToText,
  SlackAttachmentDownloader,
} = require("../dist/slack/attachments");
const {
  createCodingToolExecutor,
  createToolApprovalGate,
  getCodingToolSchemas,
} = require("../dist/tools");
const {
  FileChildAgentApprovalPrompter,
  FileChildAgentApprovalResponder,
} = require("../dist/runtime/child-agent-approvals");
const {
  resolveChildAgentMaxSteps,
  resolveChildAgentToolApprovalMode,
} = require("../dist/child-agent");
const {
  FileChildAgentRunStore,
} = require("../dist/workspace/child-agents");
const { FileWorkflowStore } = require("../dist/workflow/store");
const { WorkflowOrchestrator } = require("../dist/workflow/orchestrator");
const { EvolutionController } = require("../dist/evolution/controller");
const { FileEvolutionStore } = require("../dist/evolution/store");
const {
  WorkspaceSessionStore,
} = require("../dist/workspace/session");
const {
  createSessionCompactor,
} = require("../dist/workspace/compaction");
const { FileChannelWorkspaceStore } = require("../dist/workspace/store");
const {
  createRuntimeCodeStagingWorkspace,
  publishRuntimeCodeWorkspace,
} = require("../dist/evolution/runtime-code");
const {
  createRuntimeCodeActivationController,
} = require("../dist/evolution/runtime-activation");
const {
  SessionEvolutionContextRecorder,
} = require("../dist/evolution/channel-context");
const {
  detectWebUiSelfEvolutionRequest,
  findOutsideWorkspacePathReference,
  resolveConversationTitleModelName,
  WebAgentRunner,
} = require("../dist/web/agent");
const {
  conversationTitleRetryReady,
  conversationTitleSource,
  FileWebConversationStore,
} = require("../dist/web/conversations");
const {
  startWebUiServer,
} = require("../dist/web/server");

async function runTests() {
  await runCase("Slack event filtering", testSlackEventFiltering);
  await runCase("Slack attachment download", testSlackAttachmentDownload);
  await runCase("Slack attachment size limit", testSlackAttachmentSizeLimit);
  await runCase("session sync", testSessionSync);
  await runCase(
    "session repairs interleaved tool-call history",
    testSessionRepairsInterleavedToolCallHistory,
  );
  await runCase(
    "session defers pending user sync while tool calls are open",
    testSessionDefersPendingUserSyncDuringOpenToolCalls,
  );
  await runCase("Slack duplicate event idempotence", testSlackDuplicateEventIdempotence);
  await runCase("session storage size limit", testSessionStorageSizeLimit);
  await runCase("tool path guard", testToolPathGuard);
  await runCase("tool symlink guard", testToolSymlinkGuard);
  await runCase("protected tool paths", testProtectedToolPaths);
  await runCase("runtime-code staging publish guard", testRuntimeCodeStagingPublishGuard);
  await runCase("runtime-code activation defaults", testRuntimeCodeActivationDefaults);
  await runCase("evolution approval idempotence", testEvolutionApprovalIdempotence);
  await runCase("runtime-code activation request", testRuntimeCodeActivationRequest);
  await runCase("WebUI self-evolution routing guard", testWebUiSelfEvolutionRouting);
  await runCase("self-evolution prompt guidance", testSelfEvolutionPromptGuidance);
  await runCase(
    "persistent memory candidate prompt guidance",
    testPersistentMemoryCandidatePromptGuidance,
  );
  await runCase(
    "self-evolution implementation Plan Mode guard",
    testSelfEvolutionImplementationPlanModeGuard,
  );
  await runCase(
    "WebUI self-evolution requests let the model classify the ticket",
    testWebUiSelfEvolutionModelClassification,
  );
  await runCase("WebUI active run accepts steering", testWebUiActiveRunSteering);
  await runCase("WebUI state defers full evolution context", testWebUiStateDefersEvolutionContext);
  await runCase(
    "WebUI title model follows ggbot fast-model selection",
    testWebUiTitleModelSelection,
  );
  await runCase(
    "WebUI model title generation reads channel context",
    testWebUiModelTitleGenerationReadsChannelContext,
  );
  await runCase(
    "WebUI message stream emits generated conversation title",
    testWebUiMessageStreamGeneratesConversationTitle,
  );
  await runCase(
    "WebUI title stream persists before completion and protects manual rename",
    testWebUiTitleStreamPersistsBeforeCompletion,
  );
  await runCase(
    "WebUI context overflow compacts and retries",
    testWebUiContextOverflowRetry,
  );
  await runCase(
    "WebUI Plan Mode approval resumes output",
    testWebUiPlanModeApproval,
  );
  await runCase(
    "WebUI Plan Mode persists across messages",
    testWebUiPlanModePersistsAcrossMessages,
  );
  await runCase(
    "WebUI child-agent runtime is available",
    testWebUiChildAgentRuntimeAvailable,
  );
  await runCase("WebUI tool approval resumes output", testWebUiToolApproval);
  await runCase("WebUI channel bash boundary guard", testWebUiChannelBashBoundary);
  await runCase("file tool size limit", testFileToolSizeLimit);
  await runCase("tool approval policy", testToolApprovalPolicy);
  await runCase("disabled tool policy", testDisabledToolPolicy);
  await runCase("Slack interactive tool approval", testSlackInteractiveToolApproval);
  await runCase("child agent approvals bridge through Slack", testChildAgentApprovalBridge);
  await runCase(
    "child agent approval modes preserve parent boundaries",
    testChildAgentWriteApprovalMode,
  );
  await runCase(
    "child agent step budget follows tool-call budget",
    testChildAgentStepBudget,
  );
  await runCase("Kimi K2.6 usage pricing", testKimiK26UsagePricing);
  await runCase("Kimi stream usage parsing", testKimiStreamUsageParsing);
  await runCase(
    "OpenAI-compatible provider uses native developer authority by default",
    testNativeDeveloperRole,
  );
  await runCase(
    "OpenAI-compatible provider only degrades developer authority explicitly",
    testExplicitDeveloperRoleFallback,
  );
  await runCase("SSE tool call argument fragments", testSseToolCallArgumentFragments);
  await runCase("WebUI browser script parses", testWebUiBrowserScriptParses);
  await runCase("WebUI shell smoke renders", testWebUiShellSmokeRender);
  await runCase(
    "WebUI Skill import survives render and action errors remain recoverable",
    testWebUiSkillImportAndActionErrorRecovery,
  );
  await runCase(
    "WebUI markdown table tolerates blank separator gap",
    testWebUiMarkdownTableRendering,
  );
  await runCase(
    "OpenAI-compatible provider repairs interleaved tool-call history",
    testProviderRepairsInterleavedToolCallHistory,
  );
  await runCase("agent loop tool-call flow", testAgentLoopToolCallFlow);
  console.log("Production tests passed");
}

async function testWebUiTitleModelSelection() {
  assert.equal(
    resolveConversationTitleModelName("deepseek-reasoner", undefined),
    "deepseek-chat",
  );
  assert.equal(
    resolveConversationTitleModelName("kimi-k2.6", undefined),
    undefined,
  );
  assert.equal(
    resolveConversationTitleModelName("deepseek-reasoner", "fast-title"),
    "fast-title",
  );

  const workspaceRoot = await createWorkspace("pibot-webui-title-source-test-");
  const conversations = new FileWebConversationStore(join(workspaceRoot, "store"));
  const conversation = await conversations.create("Web session");
  assert.equal(conversationTitleSource(conversation), "placeholder");
  assert.equal(conversationTitleRetryReady(conversation), true);

  const failed = await conversations.recordTitleGenerationFailure(conversation.id, 60_000);
  assert.equal(failed.titleFailureCount, 1);
  assert.equal(conversationTitleRetryReady(failed), false);

  const modelTitle = await conversations.rename(conversation.id, "模型标题", {
    source: "model",
  });
  assert.equal(conversationTitleSource(modelTitle), "model");
  assert.equal(modelTitle.titleFailureCount, undefined);
  assert.equal(modelTitle.titleRetryAfter, undefined);

  const manualTitle = await conversations.rename(conversation.id, "我的标题");
  const protectedTitle = await conversations.rename(conversation.id, "模型覆盖", {
    source: "model",
  });
  assert.equal(conversationTitleSource(manualTitle), "manual");
  assert.equal(protectedTitle.title, "我的标题");
  assert.equal(conversationTitleSource(protectedTitle), "manual");
}

async function testWebUiBrowserScriptParses() {
  const { WEBUI_CSS, WEBUI_SCRIPT } = require("../dist/web/static");
  const serverSource = await readFile(join(__dirname, "../dist/web/server.js"), "utf8");
  new vm.Script(WEBUI_SCRIPT, {
    filename: "WEBUI_SCRIPT.js",
  });
  assert.match(WEBUI_SCRIPT, /function shouldRenderRun\(conversationId\)/u);
  assert.match(WEBUI_SCRIPT, /function scheduleRunRender\(conversationId, options\)/u);
  assert.match(WEBUI_SCRIPT, /function mergeConversationForState\(existing, incoming\)/u);
  assert.match(WEBUI_SCRIPT, /existingMessages\.length > 0 && incomingMessages\.length === 0/u);
  assert.match(WEBUI_SCRIPT, /function improveConversationTitle\(conversationId, content\)/u);
  assert.match(WEBUI_SCRIPT, /function generatePibotIntentTitle\(content\)/u);
  assert.match(WEBUI_SCRIPT, /renameConversation\(conversationId, modelTitle, \{ select: false \}\)/u);
  assert.doesNotMatch(WEBUI_SCRIPT, /maybeAutoNameConversation\(conversationId, content\);/u);
  assert.match(serverSource, /generateAndPersistConversationTitle/u);
  assert.match(serverSource, /webui_title_generation_failed/u);
  assert.match(serverSource, /writeStreamEvent\(\{ type: "conversation", conversation \}\)/u);
  assert.match(serverSource, /shouldGenerateConversationTitle\(conversation/u);
  assert.doesNotMatch(WEBUI_SCRIPT, /applyImmediateConversationTitle/u);
  assert.doesNotMatch(WEBUI_SCRIPT, /renameConversation\(conversationId, heuristicTitle/u);
  assert.match(WEBUI_SCRIPT, /function fetchModelGeneratedTitle\(conversationId, content\)/u);
  assert.match(WEBUI_SCRIPT, /body: JSON\.stringify\(\{ content: content \}\)/u);
  assert.match(WEBUI_SCRIPT, /function shouldAutoGenerateConversationTitle\(conversation, content\)/u);
  assert.match(WEBUI_SCRIPT, /title === heuristicTitle/u);
  assert.match(WEBUI_SCRIPT, /function pendingRuntimeActivation\(\)/u);
  assert.match(WEBUI_SCRIPT, /data-action="confirm-runtime-version"/u);
  assert.match(WEBUI_SCRIPT, /\/runtime-code\/versions\/" \+ encodeURIComponent\(versionId\) \+ "\/confirm/u);
  assert.match(WEBUI_SCRIPT, /Confirm Version/u);
  assert.match(WEBUI_SCRIPT, /skillImportFiles: \[\]/u);
  assert.match(WEBUI_SCRIPT, /state\.skillImportFiles = files/u);
  assert.match(WEBUI_SCRIPT, /async function importSelectedSkill\(\)/u);
  assert.match(WEBUI_SCRIPT, /function renderActionError\(\)/u);
  assert.match(WEBUI_SCRIPT, /state\.actionError = errorMessage\(error\)/u);
  assert.doesNotMatch(WEBUI_SCRIPT, /importSkillFromInput/u);
  assert.match(WEBUI_SCRIPT, /evolutionPane: "tickets"/u);
  assert.match(WEBUI_SCRIPT, /function renderEvolutionTicketWorkspace\(ticket, tickets\)/u);
  assert.match(WEBUI_SCRIPT, /function renderEvolutionContextPage\(ticket\)/u);
  assert.match(WEBUI_SCRIPT, /renderTicketActions\(ticket, \{ showContextButton: false \}\)/u);
  assert.match(WEBUI_SCRIPT, /function requiresRuntimeActivation\(ticket\)/u);
  assert.match(WEBUI_SCRIPT, /state\.evolutionPane === "context"/u);
  assert.match(WEBUI_SCRIPT, /state\.evolutionPane = "tickets"/u);
  assert.match(WEBUI_SCRIPT, /function upsertConversation\(conversation, options\)/u);
  assert.match(WEBUI_SCRIPT, /if \(options && options\.select\)/u);
  assert.match(WEBUI_SCRIPT, /EVOLUTION_STREAM_RENDER_DELAY_MS = 90/u);
  assert.match(WEBUI_SCRIPT, /LIVE_STREAM_RENDER_DELAY_MS = 50/u);
  assert.match(WEBUI_SCRIPT, /LIVE_REASONING_RENDER_DELAY_MS = 70/u);
  assert.match(WEBUI_SCRIPT, /FOCUSED_INPUT_RENDER_DELAY_MS = 80/u);
  assert.match(WEBUI_SCRIPT, /MANUAL_SCROLL_RENDER_DELAY_MS = 80/u);
  assert.match(WEBUI_SCRIPT, /MANUAL_SCROLL_RENDER_WINDOW_MS = 140/u);
  assert.match(WEBUI_SCRIPT, /renderedMessageSequenceCache = new WeakMap/u);
  assert.match(WEBUI_SCRIPT, /renderedContextMessageSequenceCache = new WeakMap/u);
  assert.match(WEBUI_SCRIPT, /function markMainScrollActivity\(\)/u);
  assert.match(WEBUI_SCRIPT, /function recentMainScrollRenderDelayMs\(\)/u);
  assert.match(WEBUI_SCRIPT, /MANUAL_SCROLL_RENDER_WINDOW_MS - elapsed/u);
  assert.match(WEBUI_SCRIPT, /function scheduleLiveRender\(conversationId, options\)/u);
  assert.match(WEBUI_SCRIPT, /function renderLiveRunElement\(conversationId\)/u);
  assert.match(WEBUI_SCRIPT, /function cancelLiveRender\(conversationId\)/u);
  assert.match(WEBUI_SCRIPT, /function clearLiveRunElement\(conversationId\)/u);
  assert.match(WEBUI_SCRIPT, /function lastConversationMessageRole\(conversation\)/u);
  assert.match(WEBUI_SCRIPT, /data-live-conversation-id/u);
  assert.match(WEBUI_SCRIPT, /lastConversationMessageRole\(event\.conversation\) !== "user"/u);
  assert.match(WEBUI_SCRIPT, /cancelLiveRender\(conversationId\)/u);
  assert.match(WEBUI_SCRIPT, /scheduleLiveRender\(conversationId, \{ delayMs: LIVE_STREAM_RENDER_DELAY_MS \}\)/u);
  assert.match(WEBUI_SCRIPT, /scheduleLiveRender\(conversationId, \{ delayMs: LIVE_REASONING_RENDER_DELAY_MS \}\)/u);
  assert.match(WEBUI_SCRIPT, /function visibleLiveText\(value, maxChars\)/u);
  assert.match(WEBUI_SCRIPT, /function captureFocusedTextField\(\)/u);
  assert.match(WEBUI_SCRIPT, /function restoreFocusedTextField\(previous\)/u);
  assert.match(WEBUI_SCRIPT, /function shouldDeferRenderForComposition\(\)/u);
  assert.match(WEBUI_SCRIPT, /target\.id !== "session-message"/u);
  assert.match(WEBUI_SCRIPT, /event\.isComposing/u);
  assert.match(WEBUI_SCRIPT, /compositionstart/u);
  assert.match(WEBUI_SCRIPT, /compositionend/u);
  assert.match(WEBUI_SCRIPT, /function sendSessionControlMessage\(conversationId, content\)/u);
  assert.match(WEBUI_SCRIPT, /liveRunFor\(conversationId\) !== null/u);
  assert.match(WEBUI_SCRIPT, /function renderLiveApproval\(approval\)/u);
  assert.match(WEBUI_SCRIPT, /function renderRunBlocks\(blocks, options\)/u);
  assert.match(WEBUI_SCRIPT, /function renderMarkdown\(value\)/u);
  assert.match(WEBUI_SCRIPT, /function renderTable\(lines, startIndex\)/u);
  assert.match(WEBUI_SCRIPT, /function nextNonEmptyLineIndex\(lines, index\)/u);
  assert.match(WEBUI_SCRIPT, /nextNonEmptyLineIndex\(lines, startIndex \+ 1\)/u);
  assert.match(WEBUI_SCRIPT, /function isHorizontalRuleLine\(line\)/u);
  assert.match(WEBUI_SCRIPT, /String\.fromCharCode\(96, 96, 96\)/u);
  assert.match(WEBUI_SCRIPT, /function appendLiveTextBlock\(live, type, text\)/u);
  assert.match(WEBUI_SCRIPT, /function updateLiveToolBlock\(live, callId, resultSummary, isError\)/u);
  assert.match(WEBUI_SCRIPT, /function renderCachedMessageSequence\(messages\)/u);
  assert.match(WEBUI_SCRIPT, /function renderCachedContextMessageSequence\(entries, maxMessages\)/u);
  assert.match(WEBUI_SCRIPT, /renderCachedMessageSequence\(conversation\.messages\) \+ renderLiveMessage\(live, conversation\.id\)/u);
  assert.match(WEBUI_SCRIPT, /renderCachedContextMessageSequence\(contextMessages, 30\) \+ renderLiveMessage\(live, EVOLUTION_CONVERSATION_ID\)/u);
  assert.match(WEBUI_SCRIPT, /blocks: \[\]/u);
  assert.doesNotMatch(WEBUI_SCRIPT, /renderLiveApprovals\(live\) \+ toolChipsHtml/u);
  assert.match(WEBUI_SCRIPT, /function sendApprovalDecision\(approvalId, approved, scope\)/u);
  assert.match(WEBUI_SCRIPT, /data-approval-scope="run"/u);
  assert.match(WEBUI_SCRIPT, /Allow for run/u);
  assert.match(WEBUI_SCRIPT, /Deny for run/u);
  assert.match(WEBUI_SCRIPT, /data-approval-scope="session"/u);
  assert.match(WEBUI_SCRIPT, /Allow for session/u);
  assert.match(WEBUI_SCRIPT, /Deny for session/u);
  assert.match(WEBUI_SCRIPT, /data-approval-scope="repo"/u);
  assert.match(WEBUI_SCRIPT, /Allow for repo/u);
  assert.match(WEBUI_SCRIPT, /Deny for repo/u);
  assert.match(serverSource, /\/api\/approval-rules/u);
  assert.match(serverSource, /listApprovalRules/u);
  assert.match(serverSource, /revokeApprovalRule/u);
  assert.match(WEBUI_SCRIPT, /event\.type === "approval_requested"/u);
  assert.match(WEBUI_SCRIPT, /approve-web-approval/u);
  assert.match(WEBUI_SCRIPT, /function timelineMessageForDisplay\(event\)/u);
  assert.match(WEBUI_SCRIPT, /function renderReasoningDetails\(value, options\)/u);
  assert.match(WEBUI_SCRIPT, /reasoning-body/u);
  assert.match(WEBUI_SCRIPT, /function runtimeVersionForTicket\(ticket\)/u);
  assert.match(WEBUI_SCRIPT, /function renderRuntimeVersionsPanel\(snapshot\)/u);
  assert.match(WEBUI_SCRIPT, /Activate Version/u);
  assert.doesNotMatch(WEBUI_SCRIPT, /Restart Again/u);
  assert.match(WEBUI_SCRIPT, /event\.type === "implementation\.completed"/u);
  assert.match(WEBUI_SCRIPT, /ticket-workspace-content/u);
  assert.match(WEBUI_SCRIPT, /function mainScrollContainerForEventTarget\(value\)/u);
  assert.match(WEBUI_SCRIPT, /!mainScroll\.classList\.contains\("ticket-workspace-content"\)/u);
  assert.match(WEBUI_SCRIPT, /<div class="split ticket-workspace">/u);
  assert.match(WEBUI_SCRIPT, /<div class="topbar"><div class="topbar-left"><h1>Inspector<\/h1><\/div><div class="toolbar"><\/div><\/div>/u);
  assert.match(WEBUI_CSS, /--app-header-height: 50px;/u);
  assert.match(WEBUI_CSS, /\.brand,\n\.topbar \{[\s\S]*?height: var\(--app-header-height\);[\s\S]*?min-height: var\(--app-header-height\);[\s\S]*?flex: 0 0 var\(--app-header-height\);/u);
  assert.match(WEBUI_CSS, /\.ticket-row \.line \{[\s\S]*?align-items: flex-start;[\s\S]*?flex: 0 0 38px;/u);
  assert.match(WEBUI_CSS, /\.ticket-row \.line strong \{[\s\S]*?-webkit-line-clamp: 2;[\s\S]*?max-height: 38px;[\s\S]*?white-space: normal;[\s\S]*?line-height: 19px;/u);
  assert.match(WEBUI_CSS, /\.main > \.ticket-workspace-content/u);
  assert.match(WEBUI_CSS, /\.ticket-workspace \.stack/u);
  assert.match(WEBUI_CSS, /\.shell\.skills-shell \{[^}]*?grid-template-columns: 248px minmax\(0, 1fr\);/u);
  assert.match(WEBUI_CSS, /\.shell\.skills-shell \.inspector \{[^}]*?display: none;/u);
  assert.match(WEBUI_SCRIPT, /state\.view === "skills" \? "shell skills-shell"/u);
  assert.match(WEBUI_CSS, /position: sticky/u);
  assert.match(WEBUI_CSS, /contain: paint/u);
  assert.match(WEBUI_CSS, /\.reasoning:not\(\[open\]\) \.reasoning-body/u);
  assert.match(WEBUI_CSS, /\.assistant-text-block \.md-table-wrapper/u);
  assert.match(WEBUI_CSS, /\.assistant-text-block \.md-codeblock/u);
  assert.match(WEBUI_CSS, /\.assistant-text-block \.md-pre/u);
}

async function testWebUiMarkdownTableRendering() {
  const html = renderWebUiMarkdown([
    "| File | Action | Notes |",
    "",
    "|------|:--:|------|",
    "| webui/static/index.html | rewrite | 110 line AppShell |",
    "| webui/static/app.css | add | sidebar/drawer/papers/messages |",
  ].join("\n"));
  assert.match(html, /<table class="md-table">/u);
  assert.match(html, /webui\/static\/index\.html/u);
  assert.match(html, /style="text-align:center"/u);
  assert.doesNotMatch(html, /<p>\| File/u);
  assert.doesNotMatch(html, /<pre class="md-pre"><code>\|------\|:--:\|------\|/u);
}

async function testWebUiShellSmokeRender() {
  const { WEBUI_SCRIPT } = require("../dist/web/static");
  const appElement = {
    innerHTML: "",
    value: "",
    selectionStart: 0,
    selectionEnd: 0,
    classList: {
      contains() {
        return false;
      },
      add() {},
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const context = {
    AbortController,
    URL,
    console,
    fetch: async (path) => ({
      ok: true,
      statusText: "OK",
      async json() {
        if (path === "/api/state") {
          return {
            evolution: {
              tickets: [],
              signals: [],
              selfVersions: [],
              runtimeVersions: [],
              context: { messages: [], ticketContexts: [] },
            },
            runtime: { instanceId: "test-runtime" },
            conversations: [],
            skills: { skills: [], disabledSkills: [], issues: [] },
          };
        }
        return {};
      },
    }),
    document: {
      activeElement: null,
      getElementById(id) {
        return id === "app" ? appElement : null;
      },
      addEventListener() {},
    },
    window: {
      location: {
        hash: "",
        href: "http://127.0.0.1/",
      },
      addEventListener() {},
      requestAnimationFrame(callback) {
        callback();
      },
      setTimeout(callback) {
        callback();
        return 0;
      },
      clearTimeout() {},
      confirm() {
        return true;
      },
    },
  };
  vm.createContext(context);
  new vm.Script(WEBUI_SCRIPT, { filename: "WEBUI_SCRIPT.js" }).runInContext(
    context,
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.match(appElement.innerHTML, /<div class="shell sessions-shell">/u);
  assert.match(appElement.innerHTML, /<strong>PIBot<\/strong>/u);
  assert.match(appElement.innerHTML, /<h1(?: [^>]*)?>Sessions<\/h1>/u);
  assert.match(appElement.innerHTML, /<h1>Inspector<\/h1>/u);
}

async function testWebUiSkillImportAndActionErrorRecovery() {
  const { WEBUI_SCRIPT } = require("../dist/web/static");
  const context = createWebUiScriptContext();
  let importRequest;
  context.fetch = async (path, options) => {
    if (path === "/api/skills/import") {
      importRequest = JSON.parse(options.body);
      return {
        ok: true,
        statusText: "OK",
        async json() {
          return {
            skills: {
              skills: [{
                name: "grilling",
                description: "Stress-test a plan.",
                source: "pibot",
                location: ".pibot/skills/grilling/SKILL.md",
                disableModelInvocation: false,
              }],
              disabledSkills: [],
              issues: [],
            },
          };
        },
      };
    }
    throw new Error(`Unexpected WebUI request: ${path}`);
  };
  const script = WEBUI_SCRIPT.replace(
    /\nreadHash\(\);\nwindow\.addEventListener[\s\S]*?refresh\(\);\n?$/u,
    "\nthis.__state = state;\nthis.__render = render;\nthis.__withPending = withPending;\nthis.__importSelectedSkill = importSelectedSkill;\nthis.__handleAction = handleAction;",
  );
  vm.createContext(context);
  vm.runInContext(script, context, {
    filename: "WEBUI_SCRIPT.skillImport.js",
  });

  context.__state.loading = false;
  context.__state.view = "skills";
  context.__state.snapshot = {
    tickets: [],
    signals: [],
    context: { topics: [], ticketContexts: [] },
    runtimeVersions: [],
    selfVersions: [],
  };
  context.__state.skillImportFolderName = "grilling";
  context.__state.skillImportFiles = [
    {
      name: "SKILL.md",
      webkitRelativePath: "grilling/SKILL.md",
      async text() {
        return "---\nname: grilling\ndescription: Stress-test a plan.\n---\nAsk one question at a time.\n";
      },
    },
    {
      name: "openai.yaml",
      webkitRelativePath: "grilling/agents/openai.yaml",
      async text() {
        return "interface:\n  display_name: Grilling\n";
      },
    },
  ];

  await context.__withPending(
    "skill-import",
    "Importing...",
    context.__importSelectedSkill,
  );
  assert.deepEqual(importRequest, {
    files: [
      {
        path: "grilling/SKILL.md",
        content: "---\nname: grilling\ndescription: Stress-test a plan.\n---\nAsk one question at a time.\n",
      },
      {
        path: "grilling/agents/openai.yaml",
        content: "interface:\n  display_name: Grilling\n",
      },
    ],
    overwrite: false,
  });
  assert.equal(context.__state.skillImportFiles.length, 0);

  context.__state.actionError = "Select a Skill folder first.";
  context.__render();
  const appHtml = context.document.getElementById("app").innerHTML;
  assert.match(appHtml, /class="shell skills-shell"/u);
  assert.match(appHtml, /Select a Skill folder first\./u);
  assert.match(appHtml, /data-action="dismiss-action-error"/u);
  assert.match(appHtml, /data-action="import-skill"/u);

  await context.__handleAction({ dataset: { action: "dismiss-action-error" } });
  assert.equal(context.__state.actionError, null);
  assert.match(
    context.document.getElementById("app").innerHTML,
    /data-action="import-skill"/u,
  );
}

function renderWebUiMarkdown(markdown) {
  const context = createWebUiScriptContext();
  const { WEBUI_SCRIPT } = require("../dist/web/static");
  const script = WEBUI_SCRIPT.replace(
    /\nreadHash\(\);\nwindow\.addEventListener[\s\S]*?refresh\(\);\n?$/u,
    "\nthis.__renderMarkdown = renderMarkdown;",
  );
  vm.createContext(context);
  vm.runInContext(script, context, {
    filename: "WEBUI_SCRIPT.renderMarkdown.js",
  });
  return context.__renderMarkdown(markdown);
}

function createWebUiScriptContext() {
  const appElement = {
    innerHTML: "",
    value: "",
    selectionStart: 0,
    selectionEnd: 0,
    classList: {
      contains() {
        return false;
      },
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const context = {
    console,
    document: {
      activeElement: null,
      getElementById() {
        return appElement;
      },
      addEventListener() {},
    },
    window: {
      location: {
        hash: "",
        href: "http://127.0.0.1/",
      },
      addEventListener() {},
      requestAnimationFrame(callback) {
        callback();
      },
      setTimeout() {
        return 0;
      },
      clearTimeout() {},
      confirm() {
        return true;
      },
      prompt() {
        return null;
      },
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({
        evolution: {
          tickets: [],
          signals: [],
          context: {
            topics: [],
            ticketContexts: [],
          },
          runtimeVersions: [],
          selfVersions: [],
        },
        runtime: null,
        conversations: [],
      }),
    }),
  };
  return context;
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

async function testSlackEventFiltering() {
  const botUserId = "UBOT";
  const baseBody = {
    team_id: "T1",
    event_id: "E1",
  };

  assert.equal(
    normalizeSlackEventFromRaw(
      baseBody,
      {
        type: "message",
        channel_type: "channel",
        user: "U1",
        channel: "C1",
        ts: "1.1",
        text: "hello",
      },
      botUserId,
    ),
    null,
  );

  assert.equal(
    normalizeSlackEventFromRaw(
      baseBody,
      {
        type: "message",
        channel_type: "im",
        user: botUserId,
        channel: "D1",
        ts: "1.2",
        text: "loop",
      },
      botUserId,
    ),
    null,
  );

  assert.equal(
    normalizeSlackEventFromRaw(
      baseBody,
      {
        type: "message",
        subtype: "message_changed",
        channel_type: "im",
        user: "U1",
        channel: "D1",
        ts: "1.3",
        text: "edited",
      },
      botUserId,
    ),
    null,
  );

  const dm = normalizeSlackEventFromRaw(
    baseBody,
    {
      type: "message",
      channel_type: "im",
      user: "U1",
      channel: "D1",
      ts: "1.4",
      text: "hello dm",
    },
    botUserId,
  );
  assert.notEqual(dm, null);
  assert.equal(dm.type, "direct_message");
  assert.equal(dm.text, "hello dm");

  const attachmentOnlyDm = normalizeSlackEventFromRaw(
    baseBody,
    {
      type: "message",
      subtype: "file_share",
      channel_type: "im",
      user: "U1",
      channel: "D1",
      ts: "1.45",
      text: "",
      files: [
        {
          id: "F1",
          name: "notes.txt",
          mimetype: "text/plain",
          url_private: "https://files.slack.test/notes.txt",
        },
      ],
    },
    botUserId,
  );
  assert.notEqual(attachmentOnlyDm, null);
  assert.equal(
    attachmentOnlyDm.text,
    "[Slack message contains attachment(s)]",
  );
  assert.deepEqual(attachmentOnlyDm.files, [
    {
      id: "F1",
      name: "notes.txt",
      mimetype: "text/plain",
      url: "https://files.slack.test/notes.txt",
    },
  ]);

  const mention = normalizeSlackEventFromRaw(
    baseBody,
    {
      type: "app_mention",
      user: "U1",
      channel: "C1",
      ts: "1.5",
      text: "<@UBOT> hello channel",
    },
    botUserId,
  );
  assert.notEqual(mention, null);
  assert.equal(mention.type, "app_mention");
  assert.equal(mention.text, "hello channel");

  assert.equal(
    isSlackEventBefore("1000.000000", new Date(1001 * 1000)),
    true,
  );
  assert.equal(
    isSlackEventBefore("1002.000000", new Date(1001 * 1000)),
    false,
  );

  let acked = false;
  const interactiveEnvelope = parseSocketModeInteractiveEnvelope({
    ack() {
      acked = true;
    },
    body: { type: "block_actions" },
  });
  assert.notEqual(interactiveEnvelope, null);
  await interactiveEnvelope.ack();
  assert.equal(acked, true);
}

async function testSessionSync() {
  const workspaceRoot = await createWorkspace("pibot-session-test-");
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const sessions = new WorkspaceSessionStore({ store });
  const first = slackEvent("E1", "hello one", "1.1");
  const second = slackEvent("E2", "hello two", "1.2");

  await sessions.recordUserMessage(first);
  await sessions.recordUserMessage(second);
  const prepared = await sessions.prepareRun(second);

  assert.equal(prepared.syncedUserMessages, 2);
  assert.equal(
    prepared.history.some((message) => message.content === "hello one"),
    true,
  );
  assert.equal(
    prepared.history.some((message) => message.content === "hello two"),
    false,
  );
}

async function testSessionRepairsInterleavedToolCallHistory() {
  const workspaceRoot = await createWorkspace("pibot-session-repair-test-");
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const sessions = new WorkspaceSessionStore({ store });
  const key = sessionKey();

  await appendContext(store, {
    role: "user",
    source: "slack_log",
    eventId: "E-before",
    content: "please read the file",
  });
  await appendContext(store, {
    role: "assistant",
    source: "agent",
    content: "",
    toolCalls: [
      {
        id: "read:1",
        name: "read",
        argumentsJson: JSON.stringify({ path: "README.md" }),
      },
    ],
  });
  await appendContext(store, {
    role: "user",
    source: "slack_log",
    eventId: "E-interrupt",
    content: "actually never mind",
  });
  await appendContext(store, {
    role: "tool",
    source: "agent",
    toolCallId: "read:1",
    content: JSON.stringify({
      ok: true,
      callId: "read:1",
      output: { content: "README content" },
    }),
  });

  const messages = await sessions.readContextMessages(key);
  const assistantIndex = messages.findIndex(
    (message) =>
      message.role === "assistant" &&
      message.toolCalls?.some((call) => call.id === "read:1") === true,
  );

  assert.notEqual(assistantIndex, -1);
  assert.equal(messages[assistantIndex + 1].role, "tool");
  assert.equal(messages[assistantIndex + 1].toolCallId, "read:1");
  assert.equal(messages[assistantIndex + 2].role, "user");
  assert.equal(messages[assistantIndex + 2].content, "actually never mind");
}

async function testSessionDefersPendingUserSyncDuringOpenToolCalls() {
  const workspaceRoot = await createWorkspace("pibot-session-pending-test-");
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const sessions = new WorkspaceSessionStore({ store });
  const key = sessionKey();

  await appendContext(store, {
    role: "assistant",
    source: "agent",
    content: "",
    toolCalls: [
      {
        id: "read:open",
        name: "read",
        argumentsJson: JSON.stringify({ path: "README.md" }),
      },
    ],
  });
  await sessions.recordUserMessage(slackEvent("E-pending", "do not insert yet", "1.3"));

  const blockedSync = await sessions.syncPendingUserMessages(key);
  let messages = await sessions.readContextMessages(key);
  assert.equal(blockedSync.syncedUserMessages, 0);
  assert.equal(
    messages.some((message) => message.content === "do not insert yet"),
    false,
  );

  await appendContext(store, {
    role: "tool",
    source: "agent",
    toolCallId: "read:open",
    content: JSON.stringify({
      ok: true,
      callId: "read:open",
      output: { content: "README content" },
    }),
  });
  const completedSync = await sessions.syncPendingUserMessages(key);
  messages = await sessions.readContextMessages(key);

  assert.equal(completedSync.syncedUserMessages, 1);
  assert.equal(messages.at(-1).role, "user");
  assert.equal(messages.at(-1).content, "do not insert yet");
}

async function testSlackAttachmentDownload() {
  const workspaceRoot = await createWorkspace("pibot-attachment-test-");
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const previousFetch = global.fetch;
  global.fetch = async (url, init) => {
    assert.equal(url, "https://files.slack.test/notes.txt");
    assert.equal(init.headers.authorization, "Bearer xoxb-test");
    return new Response("hello attachment", {
      status: 200,
    });
  };

  try {
    const downloader = new SlackAttachmentDownloader({
      botToken: "xoxb-test",
      store,
    });
    const result = await downloader.downloadForEvent(
      {
        ...slackEvent("E-attachment", "[Slack message contains attachment(s)]", "1.45"),
        files: [
          {
            id: "F1",
            name: "notes.txt",
            mimetype: "text/plain",
            url: "https://files.slack.test/notes.txt",
          },
        ],
      },
      {
        teamId: "T1",
        channelId: "D1",
      },
    );

    assert.equal(result.failures.length, 0);
    assert.equal(result.downloaded.length, 1);
    assert.equal(result.downloaded[0].path, "attachments/1.45-F1-notes.txt");
    assert.equal(
      await readFile(result.downloaded[0].absolutePath, "utf8"),
      "hello attachment",
    );
    assert.match(
      appendAttachmentPathsToText("Review this file", result),
      /attachments\/1\.45-F1-notes\.txt \(notes\.txt\)/u,
    );
  } finally {
    global.fetch = previousFetch;
  }
}

async function testSlackAttachmentSizeLimit() {
  const workspaceRoot = await createWorkspace("pibot-attachment-limit-test-");
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const previousFetch = global.fetch;
  global.fetch = async () => new Response("123456", { status: 200 });

  try {
    const downloader = new SlackAttachmentDownloader({
      botToken: "xoxb-test",
      store,
      maxAttachmentBytes: 5,
    });
    const result = await downloader.downloadForEvent(
      {
        ...slackEvent("E-attachment-limit", "Review", "1.46"),
        files: [
          {
            id: "F-large",
            name: "large.txt",
            url: "https://files.slack.test/large.txt",
          },
        ],
      },
      {
        teamId: "T1",
        channelId: "D1",
      },
    );

    assert.equal(result.downloaded.length, 0);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].message, /maximum size of 5 bytes/u);
  } finally {
    global.fetch = previousFetch;
  }
}

async function testSlackDuplicateEventIdempotence() {
  const workspaceRoot = await createWorkspace("pibot-idempotence-test-");
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
  });
  const sessions = new WorkspaceSessionStore({ store });
  const event = slackEvent("E-duplicate", "only once", "1.5");

  assert.equal(await sessions.recordUserMessage(event), true);
  assert.equal(await sessions.recordUserMessage(event), false);
  assert.equal((await store.readLogEntries({
    teamId: "T1",
    channelId: "D1",
  })).length, 1);
}

async function testSessionStorageSizeLimit() {
  const workspaceRoot = await createWorkspace("pibot-session-limit-test-");
  const store = new FileChannelWorkspaceStore({
    rootDir: join(workspaceRoot, ".pibot"),
    maxLogFileBytes: 100,
  });
  const sessions = new WorkspaceSessionStore({ store });

  await assert.rejects(
    sessions.recordUserMessage(slackEvent("E-large", "x".repeat(200), "1.6")),
    /maximum size of 100 bytes/u,
  );
}

async function testToolPathGuard() {
  const workspaceRoot = await createWorkspace("pibot-path-test-");
  await writeFile(join(workspaceRoot, "inside.txt"), "inside", "utf8");
  const tools = createCodingToolExecutor({
    workspaceRoot,
    approvalGate: createToolApprovalGate("workspace-write"),
  });

  const readOutside = await tools.executeTool({
    id: "read-outside",
    name: "read",
    input: {
      path: "../outside.txt",
    },
  });
  assert.equal(readOutside.ok, false);
  assert.equal(readOutside.error.code, "permission_denied");

  const writeOutside = await tools.executeTool({
    id: "write-outside",
    name: "write",
    input: {
      path: "../outside.txt",
      content: "outside",
      overwrite: true,
    },
  });
  assert.equal(writeOutside.ok, false);
  assert.equal(writeOutside.error.code, "permission_denied");
}

async function testToolSymlinkGuard() {
  const workspaceRoot = await createWorkspace("pibot-symlink-test-");
  const outsideRoot = await createWorkspace("pibot-symlink-outside-");
  await writeFile(join(outsideRoot, "secret.txt"), "secret", "utf8");
  await symlink(join(outsideRoot, "secret.txt"), join(workspaceRoot, "secret-link.txt"));
  await symlink(outsideRoot, join(workspaceRoot, "outside-dir"));
  const tools = createCodingToolExecutor({
    workspaceRoot,
    approvalGate: createToolApprovalGate("workspace-write"),
  });

  for (const call of [
    {
      id: "read-symlink",
      name: "read",
      input: { path: "secret-link.txt" },
    },
    {
      id: "write-symlink-dir",
      name: "write",
      input: {
        path: "outside-dir/new.txt",
        content: "outside",
        overwrite: true,
      },
    },
    {
      id: "edit-symlink",
      name: "edit",
      input: {
        path: "secret-link.txt",
        replacements: [{ oldText: "secret", newText: "changed" }],
      },
    },
  ]) {
    const result = await tools.executeTool(call);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "permission_denied");
  }

  assert.equal(await readFile(join(outsideRoot, "secret.txt"), "utf8"), "secret");
}

async function testProtectedToolPaths() {
  const workspaceRoot = await createWorkspace("pibot-protected-path-test-");
  await mkdir(join(workspaceRoot, ".git"), { recursive: true });
  await mkdir(join(workspaceRoot, ".pibot"), { recursive: true });
  await writeFile(join(workspaceRoot, ".pibot", "secret.txt"), "needle-secret", "utf8");
  await writeFile(join(workspaceRoot, ".env"), "needle-secret", "utf8");
  const tools = createCodingToolExecutor({
    workspaceRoot,
    approvalGate: createToolApprovalGate("workspace-write"),
  });

  for (const path of [
    ".git/config",
    ".pibot-evolution-workspaces/evo/checkout/src/web/static.ts",
    ".env",
    ".env.local",
    ".npmrc",
    "instructions.md",
    "context.jsonl",
    "repo.json",
    "trace.jsonl",
    "usage.jsonl",
  ]) {
    const result = await tools.executeTool({
      id: `protected-${path}`,
      name: "write",
      input: {
        path,
        content: "blocked",
        overwrite: true,
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "permission_denied");
  }

  const grepResult = await tools.executeTool({
    id: "protected-grep",
    name: "grep",
    input: {
      pattern: "needle-secret",
      paths: [],
      caseSensitive: true,
      includeGlobs: ["**"],
      excludeGlobs: [],
    },
  });
  assert.equal(grepResult.ok, true);
  assert.deepEqual(grepResult.output.matches, []);
}

async function testRuntimeCodeStagingPublishGuard() {
  const sourceRoot = await createWorkspace("pibot-evolution-source-test-");
  await mkdir(join(sourceRoot, "src"), { recursive: true });
  await writeFile(join(sourceRoot, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await writeFile(join(sourceRoot, "README.md"), "before\n", "utf8");

  const staging = await createRuntimeCodeStagingWorkspace({
    sourceRoot,
    ticketId: "evo-test",
    runId: "run-test",
  });
  await writeFile(join(staging.root, "src", "a.ts"), "export const a = 2;\n", "utf8");
  await writeFile(join(staging.root, "src", "new.ts"), "export const b = 1;\n", "utf8");

  await writeFile(join(sourceRoot, "src", "a.ts"), "export const a = 99;\n", "utf8");
  const conflicted = await publishRuntimeCodeWorkspace({
    stagingRoot: staging.root,
    destinationRoot: sourceRoot,
    baseline: staging.baseline,
  });
  assert.deepEqual(conflicted.conflicts, ["src/a.ts"]);
  assert.deepEqual(conflicted.changedFiles, []);
  await assert.rejects(readFile(join(sourceRoot, "src", "new.ts"), "utf8"));

  await writeFile(join(sourceRoot, "src", "a.ts"), "export const a = 1;\n", "utf8");
  const published = await publishRuntimeCodeWorkspace({
    stagingRoot: staging.root,
    destinationRoot: sourceRoot,
    baseline: staging.baseline,
  });
  assert.deepEqual(published.conflicts, []);
  assert.deepEqual(published.changedFiles, ["src/a.ts", "src/new.ts"]);
  assert.equal(await readFile(join(sourceRoot, "src", "a.ts"), "utf8"), "export const a = 2;\n");
  assert.equal(await readFile(join(sourceRoot, "src", "new.ts"), "utf8"), "export const b = 1;\n");

  const deleteStage = await createRuntimeCodeStagingWorkspace({
    sourceRoot,
    ticketId: "evo-test-delete",
    runId: "run-test-delete",
  });
  await rm(join(deleteStage.root, "src", "new.ts"));
  const deleted = await publishRuntimeCodeWorkspace({
    stagingRoot: deleteStage.root,
    destinationRoot: sourceRoot,
    baseline: deleteStage.baseline,
  });
  assert.deepEqual(deleted.conflicts, []);
  assert.deepEqual(deleted.deletedFiles, ["src/new.ts"]);
  await assert.rejects(readFile(join(sourceRoot, "src", "new.ts"), "utf8"));
}

async function testRuntimeCodeActivationDefaults() {
  const workspaceRoot = await createWorkspace("pibot-runtime-activation-defaults-");
  const defaultActivation = createRuntimeCodeActivationController({
    workspaceRoot,
  });
  assert.notEqual(defaultActivation, undefined);
  assert.equal(defaultActivation.label, "terminal restart");
  assert.equal(defaultActivation.mode, "process_exit");

  const supervisedActivation = createRuntimeCodeActivationController({
    workspaceRoot,
    terminalSupervisor: true,
    restartMarkerPath: join(workspaceRoot, "restart-request.json"),
  });
  assert.notEqual(supervisedActivation, undefined);
  assert.equal(supervisedActivation.label, "terminal restart");
  assert.equal(supervisedActivation.mode, "terminal_supervisor");

  const disabledActivation = createRuntimeCodeActivationController({
    workspaceRoot,
    enabled: false,
  });
  assert.equal(disabledActivation, undefined);

  const commandActivation = createRuntimeCodeActivationController({
    workspaceRoot,
    command: "echo restart",
  });
  assert.notEqual(commandActivation, undefined);
  assert.equal(commandActivation.label, "configured restart command");
  assert.equal(commandActivation.mode, "command");
}

async function testEvolutionApprovalIdempotence() {
  const workspaceRoot = await createWorkspace("pibot-evolution-idempotence-test-");
  const controller = new EvolutionController({
    store: new FileEvolutionStore({
      rootDir: join(workspaceRoot, "evolution"),
    }),
    defaultActor: "test",
  });

  const approvedSubmission = await controller.submitManualSignal({
    summary: "Improve approval idempotence",
    actor: "test",
  });
  const approvedOnce = await controller.approveTicket(approvedSubmission.ticket.id, {
    actor: "test",
  });
  const approvedTwice = await controller.approveTicket(approvedSubmission.ticket.id, {
    actor: "test",
  });
  assert.equal(approvedTwice.status, "approved");
  assert.equal(
    approvedOnce.timeline.filter((event) => event.type === "approval.approved").length,
    1,
  );
  assert.equal(
    approvedTwice.timeline.filter((event) => event.type === "approval.approved").length,
    1,
  );

  const rejectedSubmission = await controller.submitManualSignal({
    summary: "Improve rejection idempotence",
    actor: "test",
  });
  const rejectedOnce = await controller.rejectTicket(rejectedSubmission.ticket.id, {
    actor: "test",
  });
  const rejectedTwice = await controller.rejectTicket(rejectedSubmission.ticket.id, {
    actor: "test",
  });
  assert.equal(rejectedTwice.status, "rejected");
  assert.equal(
    rejectedOnce.timeline.filter((event) => event.type === "approval.rejected").length,
    1,
  );
  assert.equal(
    rejectedTwice.timeline.filter((event) => event.type === "approval.rejected").length,
    1,
  );
}

async function testRuntimeCodeActivationRequest() {
  const workspaceRoot = await createWorkspace("pibot-runtime-activation-test-");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeRuntimeActivationProtocolMarker(workspaceRoot, { safe: true });
  await writeFile(join(workspaceRoot, "src", "app.ts"), "export const version = 'base';\n", "utf8");
  const controller = new EvolutionController({
    store: new FileEvolutionStore({
      rootDir: join(workspaceRoot, "evolution"),
    }),
    defaultActor: "test",
  });

  const inferredRuntimeCode = await controller.submitManualSignal({
    summary: "我对自进化链路的名字#self-evaluation的名字不满意，我希望改成self-evaluation",
    actor: "test",
  });
  assert.equal(inferredRuntimeCode.ticket.target, "runtime_code");
  assert.equal(inferredRuntimeCode.ticket.scope, "runtime");
  assert.equal(
    inferredRuntimeCode.ticket.proposal.validation.checks.some(
      (check) => check.name === "implementation_evidence",
    ),
    true,
  );

  const submission = await controller.submitManualSignal({
    summary: "Restart after published runtime-code change",
    target: "runtime_code",
    scope: "runtime",
    actor: "test",
  });
  await controller.approveTicket(submission.ticket.id, {
    actor: "test",
  });
  await assert.rejects(
    controller.requestRuntimeCodeActivation(submission.ticket.id, {
      actor: "test",
      commandLabel: "test restart",
    }),
    /Only applied self-evolution tickets/u,
  );
  await controller.beginImplementation(submission.ticket.id, {
    actor: "test",
  });
  await writeFile(join(workspaceRoot, "src", "app.ts"), "export const version = 'v1';\n", "utf8");
  const longImplementationSummary = [
    "published",
    "## Details",
    "x".repeat(500),
  ].join("\n");
  const completedSubmission = await controller.finishImplementation(submission.ticket.id, {
    actor: "test",
    success: true,
    summary: longImplementationSummary,
  });
  const completionEvent = completedSubmission.timeline.findLast(
    (event) => event.type === "implementation.completed",
  );
  assert.notEqual(completionEvent, undefined);
  assert.equal(
    completionEvent.message,
    `已完成 ${submission.ticket.id} 的实现。`,
  );
  assert.equal(completedSubmission.proposal.completionTopic, "已完成：published");

  const versionedSubmission = await controller.createRuntimeCodeVersionForTicket(
    submission.ticket.id,
    {
      actor: "test",
      workspaceRoot,
      changedFiles: ["src/app.ts"],
      deletedFiles: [],
    },
  );
  assert.match(versionedSubmission.rollout.versionId, /^runtime-v0001-/u);

  const activated = await controller.activateRuntimeCodeVersionForTicket(
    submission.ticket.id,
    {
      actor: "test",
      commandLabel: "test restart",
      workspaceRoot,
    },
  );
  assert.equal(activated.version.number, 1);
  assert.equal(activated.pending.versionId, versionedSubmission.rollout.versionId);
  assert.equal(activated.pending.confirmationRequired, true);
  assert.equal(activated.ticket.activation.target, "runtime_code");
  assert.equal(activated.ticket.activation.requestedBy, "test");
  assert.equal(activated.ticket.activation.commandLabel, "test restart");
  assert.equal(activated.ticket.activation.versionId, versionedSubmission.rollout.versionId);
  assert.equal(
    activated.ticket.timeline.some((event) => event.type === "runtime_version.trial_started"),
    true,
  );
  const audit = await readFile(join(workspaceRoot, "evolution", "audit.jsonl"), "utf8");
  assert.match(audit, /runtime_code\.version_created/u);
  assert.match(audit, /runtime_code\.version_trial_started/u);

  await assert.rejects(
    controller.confirmPendingRuntimeActivation({
      actor: "test",
      versionId: "runtime-v9999-missing",
    }),
    /Runtime code version is not pending confirmation/u,
  );

  const confirmed = await controller.confirmRuntimeCodeVersion(
    versionedSubmission.rollout.versionId,
    {
      actor: "test",
    },
  );
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.active.versionId, versionedSubmission.rollout.versionId);
  assert.equal(confirmed.version.id, versionedSubmission.rollout.versionId);

  const promptSubmission = await controller.submitManualSignal({
    summary: "Update system prompt through published source changes",
    target: "prompt",
    scope: "global_agent",
    actor: "test",
  });
  await controller.approveTicket(promptSubmission.ticket.id, {
    actor: "test",
  });
  await controller.beginImplementation(promptSubmission.ticket.id, {
    actor: "test",
  });
  await writeFile(join(workspaceRoot, "src", "app.ts"), "export const version = 'v2';\n", "utf8");
  await controller.finishImplementation(promptSubmission.ticket.id, {
    actor: "test",
    success: true,
    summary: "published prompt source change",
  });
  const versionedPrompt = await controller.createRuntimeCodeVersionForTicket(
    promptSubmission.ticket.id,
    {
      actor: "test",
      workspaceRoot,
      changedFiles: ["src/app.ts"],
      deletedFiles: [],
    },
  );
  assert.match(versionedPrompt.rollout.versionId, /^runtime-v0002-/u);
  const activatedPrompt = await controller.activateRuntimeCodeVersionForTicket(
    promptSubmission.ticket.id,
    {
      actor: "test",
      commandLabel: "test restart",
      workspaceRoot,
    },
  );
  assert.equal(activatedPrompt.version.number, 2);
  assert.equal(activatedPrompt.active.versionId, versionedSubmission.rollout.versionId);
  assert.equal(activatedPrompt.pending.versionId, versionedPrompt.rollout.versionId);
  assert.equal(activatedPrompt.ticket.activation.target, "prompt");
  assert.equal(await readFile(join(workspaceRoot, "src", "app.ts"), "utf8"), "export const version = 'v2';\n");

  const rollbackSelection = await controller.activateRuntimeCodeVersion(
    versionedSubmission.rollout.versionId,
    {
      actor: "test",
      commandLabel: "test restart",
      workspaceRoot,
    },
  );
  assert.equal(rollbackSelection.active.versionId, versionedSubmission.rollout.versionId);
  assert.equal(rollbackSelection.alreadyActive, false);
  assert.equal((await controller.readSnapshot()).pendingRuntimeActivation, undefined);
  assert.equal(await readFile(join(workspaceRoot, "src", "app.ts"), "utf8"), "export const version = 'v1';\n");

  const legacySubmission = await controller.submitManualSignal({
    summary: "Legacy runtime archive without pending confirmation",
    target: "runtime_code",
    scope: "runtime",
    actor: "test",
  });
  await controller.approveTicket(legacySubmission.ticket.id, {
    actor: "test",
  });
  await controller.beginImplementation(legacySubmission.ticket.id, {
    actor: "test",
  });
  await writeRuntimeActivationProtocolMarker(workspaceRoot, { safe: false });
  await writeFile(join(workspaceRoot, "src", "app.ts"), "export const version = 'legacy';\n", "utf8");
  await controller.finishImplementation(legacySubmission.ticket.id, {
    actor: "test",
    success: true,
    summary: "published legacy source change",
  });
  const legacyVersion = await controller.createRuntimeCodeVersionForTicket(
    legacySubmission.ticket.id,
    {
      actor: "test",
      workspaceRoot,
      changedFiles: ["src/app.ts"],
      deletedFiles: [],
    },
  );
  await assert.rejects(
    controller.activateRuntimeCodeVersionForTicket(legacySubmission.ticket.id, {
      actor: "test",
      commandLabel: "test restart",
      workspaceRoot,
    }),
    /predates the required pending confirmation protocol/u,
  );
  assert.equal(legacyVersion.rollout.versionId.startsWith("runtime-v0003-"), true);
  assert.equal((await controller.readSnapshot()).pendingRuntimeActivation, undefined);

  const runWebUiSource = await readFile(join(__dirname, "run-webui.js"), "utf8");
  assert.match(runWebUiSource, /restoreUnconfirmedRuntimeActivation/u);
  assert.match(runWebUiSource, /allowPendingTrial/u);
  assert.match(runWebUiSource, /restoring confirmed/u);
  assert.match(runWebUiSource, /Runtime version archive is missing/u);
  assert.match(runWebUiSource, /Runtime version archive is incomplete/u);
  assert.match(runWebUiSource, /requiredRuntimeRestoreEntries/u);

  const selfInstructionSubmission = await controller.submitManualSignal({
    summary: "Adjust behavior guidance",
    target: "self_instructions",
    scope: "global_agent",
    actor: "test",
  });
  await controller.approveTicket(selfInstructionSubmission.ticket.id, {
    actor: "test",
  });
  await controller.beginImplementation(selfInstructionSubmission.ticket.id, {
    actor: "test",
  });
  await controller.finishImplementation(selfInstructionSubmission.ticket.id, {
    actor: "test",
    success: true,
    summary: "published self-instruction update",
  });
  const versionedSelfInstructions = await controller.createSelfInstructionsVersionForTicket(
    selfInstructionSubmission.ticket.id,
    {
      actor: "test",
      instructions: "# pibot Self-Instructions\n\n- Prefer approved self-evolution tickets for recurring agent behavior changes.\n",
    },
  );
  assert.match(versionedSelfInstructions.rollout.versionId, /^self-/u);
  assert.equal(
    await readFile(join(workspaceRoot, "evolution", "agent-self", "self-instructions.md"), "utf8"),
    "# pibot Self-Instructions\n\n- Prefer approved self-evolution tickets for recurring agent behavior changes.\n",
  );
  const selfInstructionAudit = await readFile(join(workspaceRoot, "evolution", "audit.jsonl"), "utf8");
  assert.match(selfInstructionAudit, /self_instructions\.version_created/u);
  await assert.rejects(
    controller.requestRuntimeCodeActivation(selfInstructionSubmission.ticket.id, {
      actor: "test",
      commandLabel: "test restart",
    }),
    /Self-instructions tickets do not require runtime activation/u,
  );
}

async function testWebUiSelfEvolutionRouting() {
  const routed = detectWebUiSelfEvolutionRequest(
    "pibot当前webui存在问题，在我删除目标会话后，远程服务器仍然有文件残留，需要解决",
  );
  assert.notEqual(routed, undefined);
  assert.equal(routed.scope, "adapter");
  assert.equal(routed.target, "runtime_code");
  assert.equal(routed.severity, "warning");

  const boundaryIncident = detectWebUiSelfEvolutionRequest(
    "在最新的webui会话场景中，没有触发自进化，它直接改了，并且修改了工作区之外的代码",
  );
  assert.notEqual(boundaryIncident, undefined);
  assert.equal(boundaryIncident.scope, "adapter");
  assert.equal(boundaryIncident.target, "runtime_code");
  assert.equal(boundaryIncident.severity, "critical");

  const evolutionChannelDisplayIssue = detectWebUiSelfEvolutionRequest(
    "pibot的自进化channel的显示方面还有以下问题：1.自进化channel中不用显示topic，有点多余 2.timeline中implementation.completed附带的信息有点太长了，影响观感",
  );
  assert.notEqual(evolutionChannelDisplayIssue, undefined);
  assert.equal(evolutionChannelDisplayIssue.scope, "adapter");
  assert.equal(evolutionChannelDisplayIssue.target, "runtime_code");

  const evolutionChannelRename = detectWebUiSelfEvolutionRequest(
    "我对自进化链路的名字#self-evaluation的名字不满意，我希望改成self-evaluation",
  );
  assert.notEqual(evolutionChannelRename, undefined);
  assert.equal(evolutionChannelRename.scope, "runtime");
  assert.equal(evolutionChannelRename.target, "runtime_code");

  assert.equal(
    detectWebUiSelfEvolutionRequest("写一个把一个文件夹中的图片都变为灰度图的python脚本"),
    undefined,
  );
  assert.equal(
    detectWebUiSelfEvolutionRequest("总结这个会话里失败日志的原因"),
    undefined,
  );
  assert.equal(
    detectWebUiSelfEvolutionRequest("最新的会话中工单填写失败了"),
    undefined,
  );

  const ticketFailure = detectWebUiSelfEvolutionRequest(
    "pibot最新的自进化会话中工单填写失败了",
  );
  assert.notEqual(ticketFailure, undefined);
  assert.equal(ticketFailure.scope, "runtime");
  assert.equal(ticketFailure.target, "runtime_code");

  assert.equal(
    detectWebUiSelfEvolutionRequest(
      "这个项目的ticket选项下面信息太多了，不用类型、signal个数和context数量，有时间就行",
    ),
    undefined,
  );

  const denseTicketListRequest = detectWebUiSelfEvolutionRequest(
    "pibot的webui自进化channel的工单列表，每个ticket选项下面信息太多了，不用类型、signal个数和context数量，有时间就行",
  );
  assert.notEqual(denseTicketListRequest, undefined);
  assert.equal(denseTicketListRequest.scope, "runtime");
  assert.equal(denseTicketListRequest.target, "runtime_code");

  const weakPromptRequest = detectWebUiSelfEvolutionRequest(
    "自进化相关的systemprompt写明显了吗，很多时候都不会跳进去",
  );
  assert.notEqual(weakPromptRequest, undefined);
  assert.equal(weakPromptRequest.target, "prompt");
}

async function testSelfEvolutionPromptGuidance() {
  const prompt = buildCodingAgentSystemPrompt({
    tools: getCodingToolSchemas(),
    memories: {},
    workspaceSkills: [],
    repoPrompt: undefined,
    channelWorkspacePrompt: undefined,
    workspaceRoot: "/tmp/pibot",
    now: new Date("2026-07-01T00:00:00.000Z"),
  });

  assert.match(prompt, /Self-evolution routing:/u);
  assert.match(prompt, /first file a reviewable ticket with create_evolution_task/u);
  assert.match(prompt, /does not route\/jump into self-evolution/u);
  assert.match(prompt, /target=runtime_code/u);
  assert.match(prompt, /target=prompt/u);
  assert.match(prompt, /same validation error class or diagnosis repeats/u);
  assert.match(prompt, /embedded browser scripts, nested template literals, regex escaping/u);
}

async function testPersistentMemoryCandidatePromptGuidance() {
  const prompt = buildCodingAgentSystemPrompt({
    tools: getCodingToolSchemas(),
    memories: {},
    workspaceSkills: [],
    repoPrompt: undefined,
    channelWorkspacePrompt: undefined,
    workspaceRoot: "/tmp/pibot",
    now: new Date("2026-07-04T00:00:00.000Z"),
  });

  assert.match(
    prompt,
    /Before the final answer for non-trivial work, review whether the run produced durable memory candidates/u,
  );
  assert.match(
    prompt,
    /Runtime use: treat injected memory_summary\.md and MEMORY\.md content as compact routing indexes, not complete truth/u,
  );
  assert.match(
    prompt,
    /Durable candidates include stable user preferences, repo-specific source-of-truth paths, runtime entrypoints, validated workflows or commands, recurring failure modes/u,
  );
  assert.match(
    prompt,
    /Summarize memories as reusable triggers and guidance, not transcripts/u,
  );
  assert.match(
    prompt,
    /Persistent memory is a single Codex-like global store/u,
  );
  assert.match(
    prompt,
    /completed task recaps in rollout_summary documents, and uncertain candidate updates in extension_note documents/u,
  );
  assert.match(
    prompt,
    /runtime automatically records run-end recaps as rollout_summary documents/u,
  );
  assert.match(
    prompt,
    /extracts typed extension_note candidates from fuller run evidence, and uses a separate consolidation pass/u,
  );
  assert.match(
    prompt,
    /do not write current-run claims straight into accepted topic, MEMORY\.md, or memory_summary\.md/u,
  );
  assert.match(
    prompt,
    /Keep evidence, staged candidates, and accepted knowledge as distinct states/u,
  );
  assert.match(
    prompt,
    /claim-level source runs, and verified versus not-verified dimensions/u,
  );
  assert.match(prompt, /retrieval frequency is not validation/u);
  assert.match(
    prompt,
    /Do not store one-off task details, secrets, private data, raw transcripts, speculative conclusions/u,
  );
  assert.match(
    prompt,
    /If a memory candidate needs user judgment or a risky merge, mention the candidate in the final answer/u,
  );
}

async function testSelfEvolutionImplementationPlanModeGuard() {
  const source = await readFile(require.resolve("../dist/web/agent"), "utf8");

  assert.match(source, /EVOLUTION_IMPLEMENTATION_DISABLED_TOOLS/u);
  assert.match(source, /"enter_plan_mode"/u);
  assert.match(source, /"update_plan"/u);
  assert.match(source, /"exit_plan_mode"/u);
  assert.match(source, /disabledTools: EVOLUTION_IMPLEMENTATION_DISABLED_TOOLS/u);
  assert.match(source, /const runToolSchemas = evolutionImplementationToolSchemas/u);
  assert.match(source, /tools: runToolSchemas/u);
  assert.match(source, /不要进入 Plan Mode，不要写 PLAN\.md，也不要请求第二次计划审批/u);
  assert.match(source, /本次实现没有产生可发布的源码变更/u);
  assert.match(source, /runtimeCodePublishHasChanges\(publish\)/u);
  assert.match(source, /createSelfInstructionsStagingWorkspace/u);
  assert.match(source, /validateStagedSelfInstructions/u);
  assert.match(source, /createSelfInstructionsVersionForTicket/u);
  assert.match(source, /selfInstructionsFileName/u);
  assert.match(source, /控制面会版本化并发布该文件/u);
  assert.match(source, /computed CSS 级证据/u);
  assert.match(source, /不能只写 TypeScript、build 或 production tests 通过/u);
  assert.match(source, /source of truth/u);
  assert.match(source, /metadata 文件、context\.jsonl、runtime-state/u);
  assert.match(source, /API、存储文件或端到端证据/u);
  assert.match(source, /重复失败止损规则/u);
  assert.match(source, /同一类校验错误、同一异常信息或同一诊断连续出现/u);
  assert.match(source, /嵌套模板字符串、生成的浏览器脚本/u);
  assert.match(source, /当前工单已有 \$\{failedAttempts\} 次 implementation\.failed/u);
  assert.match(source, /isFailureCompletionTopic/u);
  assert.match(source, /startsWith\("已失败："\)/u);
  assert.match(source, /startsWith\("Failed:"\)/u);
  const runtimeCodeSource = await readFile(require.resolve("../dist/evolution/runtime-code"), "utf8");
  assert.match(runtimeCodeSource, /webui_static_layout_invariants/u);
  assert.match(runtimeCodeSource, /Inspector header does not use the shared topbar structure/u);
  assert.match(runtimeCodeSource, /webui_title_generation_context_invariants/u);
  assert.match(runtimeCodeSource, /channel-context-backed conversation/u);
}

async function testWebUiSelfEvolutionModelClassification() {
  const workspaceRoot = await createWorkspace("pibot-webui-model-route-test-");
  const storeRoot = join(workspaceRoot, "store");
  const store = new FileChannelWorkspaceStore({
    rootDir: storeRoot,
  });
  const sessions = new WorkspaceSessionStore({ store });
  const evolution = new EvolutionController({
    store: new FileEvolutionStore({
      rootDir: join(storeRoot, "evolution"),
    }),
    context: new SessionEvolutionContextRecorder(sessions),
    defaultActor: "test",
  });
  const conversations = new FileWebConversationStore(storeRoot);
  const conversation = await conversations.create("Web session");
  const modelRequests = [];
  const runner = new WebAgentRunner({
    conversations,
    workspaceRoot,
    store,
    sessions,
    model: {
      async *stream(request) {
        modelRequests.push(request);
        assert.deepEqual(
          request.tools.map((tool) => tool.name),
          ["create_evolution_task"],
        );
        yield {
          type: "start",
          provider: "openai_compatible",
          model: "fake",
        };

        if (modelRequests.length === 1) {
          const userMessage = [...request.messages]
            .reverse()
            .find((message) => message.role === "user");
          assert.notEqual(userMessage, undefined);
          assert.equal(userMessage.role, "user");
          assert.match(userMessage.content, /请求 pibot 自进化/u);
          assert.match(userMessage.content, /原始请求：/u);
          assert.equal(request.messages.at(-1), userMessage);
          const worldStateIndex = request.messages.findIndex((message) =>
            /\[pibot-context:world-state\]/u.test(message.content),
          );
          assert.equal(worldStateIndex >= 0, true);
          assert.equal(worldStateIndex < request.messages.length - 1, true);
          yield {
            type: "tool_call",
            call: {
              id: "create-evolution-ticket",
              name: "create_evolution_task",
              argumentsJson: JSON.stringify({
                summary: "Remove unclear WebUI labels",
                details:
                  "模型根据原始请求将它分类为 WebUI runtime_code 问题。",
                severity: "warning",
                scope: "adapter",
                target: "runtime_code",
              }),
            },
          };
        } else {
          const toolMessage = request.messages.find(
            (message) =>
              message.role === "tool" && message.content.includes("ticketId"),
          );
          assert.notEqual(toolMessage, undefined);
          yield {
            type: "text_delta",
            text: "已创建 runtime_code 自进化工单。",
          };
        }

        yield {
          type: "done",
        };
      },
    },
    tools: getCodingToolSchemas(),
    sandboxExecutor: {
      assertWorkspaceAccess() {},
    },
    toolApprovalMode: "read-only",
    toolLimits: {
      maxReadChars: 10_000,
      maxFileBytes: 10_000,
      maxCommandOutputChars: 10_000,
      maxGrepMatches: 10,
      maxGrepOutputChars: 10_000,
      defaultShellTimeoutMs: 1_000,
      maxShellTimeoutMs: 1_000,
    },
    evolution,
    maxSteps: 3,
  });
  const events = [];

  const result = await runner.runUserMessage(
    conversation.id,
    "pibot的webui的会话界面中，有语义不明的control和web字样用方框框起来，需要删除\n进行自进化",
    {
      onEvent: (event) => {
        events.push(event);
      },
    },
  );

  assert.equal(result.reason, "completed");
  assert.equal(modelRequests.length, 2);
  assert.equal(events.some((event) => event.type === "agent_event"), true);
  assert.equal(typeof result.evolutionTicketId, "string");
  const snapshot = await evolution.readSnapshot();
  assert.equal(snapshot.tickets.length, 1);
  assert.equal(snapshot.signals.length, 1);
  assert.equal(snapshot.tickets[0].id, result.evolutionTicketId);
  assert.equal(snapshot.tickets[0].status, "waiting_for_approval");
  assert.equal(snapshot.tickets[0].target, "runtime_code");
  assert.equal(snapshot.tickets[0].scope, "adapter");
  assert.match(
    snapshot.signals[0].details,
    /模型根据原始请求将它分类为 WebUI runtime_code 问题/u,
  );

  const conversationMessages = await sessions.readChannelContextMessages({
    teamId: "webui",
    channelId: conversation.id,
  });
  assert.deepEqual(
    conversationMessages.map((entry) => entry.message.role),
    ["user", "assistant", "tool", "assistant"],
  );
  assert.match(
    conversationMessages[3].message.content,
    /runtime_code 自进化工单/u,
  );

  const ticketMessages = await sessions.readChannelContextMessages({
    teamId: "webui",
    channelId: `self-evaluation--${result.evolutionTicketId}`,
  });
  assert.equal(ticketMessages.length, 1);
  assert.match(ticketMessages[0].message.content, /已记录自进化信号/u);
}

async function testWebUiActiveRunSteering() {
  const workspaceRoot = await createWorkspace("pibot-webui-steering-test-");
  await writeFile(join(workspaceRoot, "fixture.txt"), "tool-result", "utf8");
  const storeRoot = join(workspaceRoot, "store");
  const store = new FileChannelWorkspaceStore({
    rootDir: storeRoot,
  });
  const sessions = new WorkspaceSessionStore({ store });
  const evolution = new EvolutionController({
    store: new FileEvolutionStore({
      rootDir: join(storeRoot, "evolution"),
    }),
    context: new SessionEvolutionContextRecorder(sessions),
    defaultActor: "test",
  });
  const conversations = new FileWebConversationStore(storeRoot);
  const conversation = await conversations.create("Web session");
  const modelRequests = [];
  let markFirstRequestSeen;
  const firstRequestSeen = new Promise((resolve) => {
    markFirstRequestSeen = resolve;
  });
  let releaseFirstRequest;
  const firstRequestReleased = new Promise((resolve) => {
    releaseFirstRequest = resolve;
  });
  const runner = new WebAgentRunner({
    conversations,
    workspaceRoot,
    store,
    sessions,
    model: {
      async *stream(request) {
        modelRequests.push(request);
        yield {
          type: "start",
          provider: "openai_compatible",
          model: "fake",
        };

        if (modelRequests.length === 1) {
          markFirstRequestSeen();
          await firstRequestReleased;
          yield {
            type: "tool_call",
            call: {
              id: "read-fixture",
              name: "read",
              argumentsJson: JSON.stringify({
                path: "fixture.txt",
              }),
            },
          };
        } else {
          assert.equal(
            request.messages.some(
              (message) =>
                message.role === "user" &&
                /newer requirement/u.test(message.content),
            ),
            true,
          );
          yield {
            type: "text_delta",
            text: "Used the newer requirement.",
          };
        }

        yield {
          type: "done",
        };
      },
    },
    tools: getCodingToolSchemas(),
    sandboxExecutor: {
      assertWorkspaceAccess() {},
    },
    toolApprovalMode: "read-only",
    toolLimits: {
      maxReadChars: 10_000,
      maxFileBytes: 10_000,
      maxCommandOutputChars: 10_000,
      maxGrepMatches: 10,
      maxGrepOutputChars: 10_000,
      defaultShellTimeoutMs: 1_000,
      maxShellTimeoutMs: 1_000,
    },
    evolution,
    maxSteps: 3,
  });
  const events = [];

  const activeRun = runner.runUserMessage(conversation.id, "read fixture", {
    onEvent: (event) => {
      events.push(event);
    },
  });
  await firstRequestSeen;
  const controlResult = await runner.runUserMessage(
    conversation.id,
    "steer: use the newer requirement",
  );
  assert.equal(controlResult.reason, "steering");
  const immediateMessages = await sessions.readChannelContextMessages({
    teamId: "webui",
    channelId: conversation.id,
  });
  assert.deepEqual(
    immediateMessages.map((entry) => entry.message.role),
    ["user", "user"],
  );
  assert.match(
    immediateMessages[1].message.content,
    /steer: use the newer requirement/u,
  );
  releaseFirstRequest();
  const result = await activeRun;

  assert.equal(result.reason, "completed");
  assert.equal(modelRequests.length, 2);
  assert.equal(
    events.some(
      (event) =>
        event.type === "status" &&
        /Steering added to the active run/u.test(event.message),
    ),
    true,
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === "runtime_transition" &&
        event.transition.type === "continue_with_steering",
    ),
    true,
  );
  const conversationMessages = await sessions.readChannelContextMessages({
    teamId: "webui",
    channelId: conversation.id,
  });
  assert.deepEqual(
    conversationMessages.map((entry) => entry.message.role),
    ["user", "user", "assistant", "tool", "assistant"],
  );
  assert.match(
    conversationMessages[1].message.content,
    /steer: use the newer requirement/u,
  );
}

async function testWebUiStateDefersEvolutionContext() {
  const workspaceRoot = await createWorkspace("pibot-webui-light-state-test-");
  const storeRoot = join(workspaceRoot, "store");
  const store = new FileChannelWorkspaceStore({
    rootDir: storeRoot,
  });
  const sessions = new WorkspaceSessionStore({ store });
  const evolutionContext = new SessionEvolutionContextRecorder(sessions);
  const evolution = new EvolutionController({
    store: new FileEvolutionStore({
      rootDir: join(storeRoot, "evolution"),
    }),
    context: evolutionContext,
    defaultActor: "test",
  });
  const conversations = new FileWebConversationStore(storeRoot);
  const submission = await evolution.submitManualSignal({
    summary: "Large context should not block WebUI startup",
    target: "runtime_code",
    scope: "runtime",
    actor: "test",
  });
  await evolutionContext.appendEvolutionContextMessage({
    ticketId: submission.ticket.id,
    role: "assistant",
    content: "heavy context ".repeat(1000),
  });

  const started = await startWebUiServer({
    host: "127.0.0.1",
    port: 0,
    workspaceRoot,
    evolution,
    evolutionContext,
    conversations,
  });
  const address = started.server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const state = await (await fetch(`${baseUrl}/api/state`)).json();
    const lightweightTicketContext = state.evolution.context.ticketContexts.find(
      (context) => context.ticketId === submission.ticket.id,
    );
    assert.notEqual(lightweightTicketContext, undefined);
    assert.equal(lightweightTicketContext.messages.length, 0);

    const full = await (await fetch(`${baseUrl}/api/evolution/context`)).json();
    const fullTicketContext = full.context.ticketContexts.find(
      (context) => context.ticketId === submission.ticket.id,
    );
    assert.notEqual(fullTicketContext, undefined);
    assert.equal(fullTicketContext.messages.length > 0, true);
    const heavyContextMessage = fullTicketContext.messages.find((entry) =>
      /heavy context/u.test(entry.message.content)
    );
    assert.notEqual(heavyContextMessage, undefined);
    assert.match(
      heavyContextMessage.message.content,
      /heavy context/u,
    );
  } finally {
    await new Promise((resolve, reject) => {
      started.server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function testWebUiModelTitleGenerationReadsChannelContext() {
  const workspaceRoot = await createWorkspace("pibot-webui-title-context-test-");
  const storeRoot = join(workspaceRoot, "store");
  const store = new FileChannelWorkspaceStore({
    rootDir: storeRoot,
  });
  const sessions = new WorkspaceSessionStore({ store });
  const evolution = new EvolutionController({
    store: new FileEvolutionStore({
      rootDir: join(storeRoot, "evolution"),
    }),
    context: new SessionEvolutionContextRecorder(sessions),
    defaultActor: "test",
  });
  const conversations = new FileWebConversationStore(storeRoot);
  const firstUserMessage =
    "会话自己生成的标题效果很差，难道不应该走模型调用吗，现在看起来像是截取字段";
  const conversation = await conversations.create(firstUserMessage);
  assert.equal(conversation.messages.length, 0);
  await sessions.appendContextMessage({
    teamId: "webui",
    channelId: conversation.id,
  }, {
    message: {
      role: "user",
      content: firstUserMessage,
    },
    source: "webui",
  });

  const modelRequests = [];
  const modelSignals = [];
  const runner = new WebAgentRunner({
    conversations,
    workspaceRoot,
    store,
    sessions,
    model: {
      async *stream(request, signal) {
        modelRequests.push(request);
        modelSignals.push(signal);
        const prompt = request.messages.at(-1).content;
        yield {
          type: "start",
          provider: "openai_compatible",
          model: "fake",
        };
        const title = /保留完整语义标题/u.test(prompt)
          ? "A deliberately complete semantic title returned by the configured model"
          : (/模型返回占位标题/u.test(prompt)
            ? "Web session"
            : "模型生成会话标题");
        if (/标题模型尝试调用工具/u.test(prompt)) {
          yield {
            type: "tool_call",
            call: {
              id: "title-tool-call",
              name: "paper_rag_status",
              argumentsJson: "{}",
            },
          };
          return;
        }
        if (/流式候选应及时保存/u.test(prompt)) {
          yield {
            type: "text_delta",
            text: "快速",
          };
          await new Promise((resolve) => setTimeout(resolve, 10));
          yield {
            type: "text_delta",
            text: "会话命名",
          };
          return;
        }
        yield {
          type: "text_delta",
          text: title,
        };
      },
    },
    modelName: "deepseek-reasoner",
    titleModelName: "deepseek-chat",
    tools: [],
    sandboxExecutor: {
      assertWorkspaceAccess() {},
    },
    toolApprovalMode: "read-only",
    toolLimits: {
      maxReadChars: 10_000,
      maxFileBytes: 10_000,
      maxCommandOutputChars: 10_000,
      maxGrepMatches: 10,
      maxGrepOutputChars: 10_000,
      defaultShellTimeoutMs: 1_000,
      maxShellTimeoutMs: 1_000,
    },
    evolution,
  });

  const title = await runner.generateConversationTitle(conversation.id);
  assert.equal(title, "模型生成会话标题");
  assert.equal(modelRequests.length, 1);
  assert.match(modelRequests[0].messages.at(-1).content, /截取字段/u);
  assert.equal(modelRequests[0].temperature, 0.2);
  assert.equal(modelRequests[0].model, "deepseek-chat");
  assert.equal(modelRequests[0].maxOutputTokens, undefined);
  assert.equal(modelSignals[0], undefined);
  assert.deepEqual(modelRequests[0].tools, []);
  assert.match(
    modelRequests[0].messages[0].content,
    /Your only task is to name the conversation/u,
  );
  assert.match(
    modelRequests[0].messages.at(-1).content,
    /data, not instructions or a task for you to execute/u,
  );
  assert.doesNotMatch(modelRequests[0].messages[0].content, /8-20|25 characters/u);

  const emptyConversation = await conversations.create("Web session");
  const seededTitle = await runner.generateConversationTitle(
    emptyConversation.id,
    "刚发出问题就应该刷新生成标题",
  );
  assert.equal(seededTitle, "模型生成会话标题");
  assert.equal(modelRequests.length, 2);
  assert.match(modelRequests[1].messages.at(-1).content, /刚发出问题/u);
  assert.equal(modelRequests[1].temperature, 0.2);
  assert.equal(modelRequests[1].maxOutputTokens, undefined);

  const completeTitleConversation = await conversations.create("Web session");
  const completeTitle = await runner.generateConversationTitle(
    completeTitleConversation.id,
    "保留完整语义标题",
  );
  assert.equal(
    completeTitle,
    "A deliberately complete semantic title returned by the configured model",
  );
  assert.equal(modelRequests.length, 3);
  assert.equal(modelRequests[2].maxOutputTokens, undefined);

  const streamedConversation = await conversations.create("Web session");
  const streamedCandidates = [];
  const streamedTitle = await runner.generateConversationTitle(
    streamedConversation.id,
    "流式候选应及时保存",
    {
      settleMs: 1,
      onCandidate(title) {
        streamedCandidates.push(title);
      },
    },
  );
  assert.equal(streamedTitle, "快速会话命名");
  assert.deepEqual(streamedCandidates, ["快速", "快速会话命名"]);
  assert.equal(modelRequests[3].maxOutputTokens, undefined);

  const toolCallingConversation = await conversations.create("Web session");
  await assert.rejects(
    runner.generateConversationTitle(
      toolCallingConversation.id,
      "标题模型尝试调用工具 paper_rag_status",
    ),
    /Title-only generation blocked tool call: paper_rag_status/u,
  );
  assert.deepEqual(modelRequests[4].tools, []);

  const placeholderConversation = await conversations.create("Web session");
  assert.equal(
    await runner.generateConversationTitle(
      placeholderConversation.id,
      "模型返回占位标题",
    ),
    "",
  );
}

async function testWebUiMessageStreamGeneratesConversationTitle() {
  const workspaceRoot = await createWorkspace("pibot-webui-stream-title-test-");
  const storeRoot = join(workspaceRoot, "store");
  const store = new FileChannelWorkspaceStore({
    rootDir: storeRoot,
  });
  const sessions = new WorkspaceSessionStore({ store });
  const evolution = new EvolutionController({
    store: new FileEvolutionStore({
      rootDir: join(storeRoot, "evolution"),
    }),
    context: new SessionEvolutionContextRecorder(sessions),
    defaultActor: "test",
  });
  const conversations = new FileWebConversationStore(storeRoot);
  const conversation = await conversations.create("Web session");
  const alwaysEmptyConversation = await conversations.create("Web session");
  const modelRequests = [];
  const modelCallOrder = [];
  let emptyTitleAttempts = 0;
  let alwaysEmptyTitleAttempts = 0;
  const runner = new WebAgentRunner({
    conversations,
    workspaceRoot,
    store,
    sessions,
    model: {
      async *stream(request) {
        modelRequests.push(request);
        const prompt = request.messages.map((message) => message.content).join("\n");
        yield {
          type: "start",
          provider: "openai_compatible",
          model: "fake",
        };
        if (/dedicated conversation-title generator/u.test(prompt)) {
          if (/标题模型始终返回空结果/u.test(prompt)) {
            alwaysEmptyTitleAttempts += 1;
            modelCallOrder.push(`always-empty-title-${alwaysEmptyTitleAttempts}`);
            yield {
              type: "done",
              finishReason: "stop",
            };
            return;
          }
          emptyTitleAttempts += 1;
          modelCallOrder.push(`title-${emptyTitleAttempts}`);
          if (emptyTitleAttempts === 1) {
            yield {
              type: "done",
              finishReason: "stop",
            };
            return;
          }
          yield {
            type: "text_delta",
            text: "修复会话标题",
          };
          return;
        }
        modelCallOrder.push("answer");
        yield {
          type: "text_delta",
          text: "回答正文",
        };
      },
    },
    tools: [],
    sandboxExecutor: {
      assertWorkspaceAccess() {},
    },
    toolApprovalMode: "read-only",
    toolLimits: {
      maxReadChars: 10_000,
      maxFileBytes: 10_000,
      maxCommandOutputChars: 10_000,
      maxGrepMatches: 10,
      maxGrepOutputChars: 10_000,
      defaultShellTimeoutMs: 1_000,
      maxShellTimeoutMs: 1_000,
    },
    evolution,
  });

  const started = await startWebUiServer({
    host: "127.0.0.1",
    port: 0,
    workspaceRoot,
    evolution,
    evolutionContext: new SessionEvolutionContextRecorder(sessions),
    conversations,
    agent: runner,
  });
  const address = started.server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(
      `${baseUrl}/api/conversations/${encodeURIComponent(conversation.id)}/messages?stream=1`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "user",
          content: "我新建立的会话不该一直叫 Web session",
        }),
      },
    );
    assert.equal(response.ok, true);
    const events = (await response.text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.notEqual(
      events.find((event) =>
        event.type === "conversation" &&
        event.conversation.title === "修复会话标题"
      ),
      undefined,
    );
    assert.notEqual(events.find((event) => event.type === "done"), undefined);
    assert.equal((await conversations.get(conversation.id)).title, "修复会话标题");
    assert.equal(
      modelRequests.some((request) =>
        request.messages[0].content.includes("conversation-title generator") &&
        request.maxOutputTokens === undefined &&
        request.temperature === 0.2
      ),
      true,
    );
    assert.equal(emptyTitleAttempts, 2);
    assert.equal(
      modelCallOrder.indexOf("title-2") > modelCallOrder.indexOf("answer"),
      true,
    );
    const generatedConversation = await conversations.get(conversation.id);
    assert.equal(generatedConversation.titleSource, "model");
    assert.equal(generatedConversation.titleFailureCount, undefined);
    assert.equal(generatedConversation.titleRetryAfter, undefined);

    const emptyResponse = await fetch(
      `${baseUrl}/api/conversations/${encodeURIComponent(alwaysEmptyConversation.id)}/messages?stream=1`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "user",
          content: "标题模型始终返回空结果",
        }),
      },
    );
    assert.equal(emptyResponse.ok, true);
    await emptyResponse.text();
    const failedConversation = await conversations.get(alwaysEmptyConversation.id);
    assert.equal(failedConversation.title, "Web session");
    assert.equal(failedConversation.titleSource, "placeholder");
    assert.equal(failedConversation.titleFailureCount, 2);
    assert.equal(Date.parse(failedConversation.titleRetryAfter) > Date.now(), true);
    assert.equal(alwaysEmptyTitleAttempts, 2);

    const retryDuringCooldown = await fetch(
      `${baseUrl}/api/conversations/${encodeURIComponent(alwaysEmptyConversation.id)}/messages?stream=1`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "user",
          content: "冷却期间不应继续请求标题模型",
        }),
      },
    );
    assert.equal(retryDuringCooldown.ok, true);
    await retryDuringCooldown.text();
    assert.equal(alwaysEmptyTitleAttempts, 2);
  } finally {
    await new Promise((resolve, reject) => {
      started.server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function testWebUiTitleStreamPersistsBeforeCompletion() {
  const workspaceRoot = await createWorkspace("pibot-webui-quiet-title-test-");
  const storeRoot = join(workspaceRoot, "store");
  const store = new FileChannelWorkspaceStore({ rootDir: storeRoot });
  const sessions = new WorkspaceSessionStore({ store });
  const evolution = new EvolutionController({
    store: new FileEvolutionStore({ rootDir: join(storeRoot, "evolution") }),
    context: new SessionEvolutionContextRecorder(sessions),
    defaultActor: "test",
  });
  const conversations = new FileWebConversationStore(storeRoot);
  const hangingConversation = await conversations.create("Web session");
  const manualConversation = await conversations.create("Web session");
  const runner = new WebAgentRunner({
    conversations,
    workspaceRoot,
    store,
    sessions,
    model: {
      async *stream(request) {
        const prompt = request.messages.map((message) => message.content).join("\n");
        yield {
          type: "start",
          provider: "openai_compatible",
          model: "fake",
        };
        if (/dedicated conversation-title generator/u.test(prompt)) {
          assert.equal(request.maxOutputTokens, undefined);
          if (/标题流即使挂起也应保存/u.test(prompt)) {
            yield { type: "text_delta", text: "流式标题已保存" };
            await new Promise(() => {});
            return;
          }
          if (/手动标题不能被完整结果覆盖/u.test(prompt)) {
            yield { type: "text_delta", text: "模型临时标题" };
            await new Promise((resolve) => setTimeout(resolve, 600));
            yield { type: "text_delta", text: "应被拦截的完整标题" };
            return;
          }
        }
        yield { type: "text_delta", text: "回答正文" };
      },
    },
    tools: [],
    sandboxExecutor: { assertWorkspaceAccess() {} },
    toolApprovalMode: "read-only",
    toolLimits: {
      maxReadChars: 10_000,
      maxFileBytes: 10_000,
      maxCommandOutputChars: 10_000,
      maxGrepMatches: 10,
      maxGrepOutputChars: 10_000,
      defaultShellTimeoutMs: 1_000,
      maxShellTimeoutMs: 1_000,
    },
    evolution,
  });
  const started = await startWebUiServer({
    host: "127.0.0.1",
    port: 0,
    workspaceRoot,
    evolution,
    evolutionContext: new SessionEvolutionContextRecorder(sessions),
    conversations,
    agent: runner,
  });
  const address = started.server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const sendMessage = async (conversationId, content) => {
    const response = await fetch(
      `${baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/messages?stream=1`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "user", content }),
      },
    );
    assert.equal(response.ok, true);
    return (await response.text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
  try {
    const hangingEvents = await sendMessage(
      hangingConversation.id,
      "标题流即使挂起也应保存",
    );
    assert.notEqual(
      hangingEvents.find((event) =>
        event.type === "conversation" &&
        event.conversation.title === "流式标题已保存"
      ),
      undefined,
    );
    assert.equal(
      (await conversations.get(hangingConversation.id)).title,
      "流式标题已保存",
    );

    const manualRequest = sendMessage(
      manualConversation.id,
      "手动标题不能被完整结果覆盖",
    );
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if ((await conversations.get(manualConversation.id)).title === "模型临时标题") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      (await conversations.get(manualConversation.id)).title,
      "模型临时标题",
    );
    await conversations.rename(manualConversation.id, "我的手动标题");
    await manualRequest;
    const manuallyRenamed = await conversations.get(manualConversation.id);
    assert.equal(manuallyRenamed.title, "我的手动标题");
    assert.equal(manuallyRenamed.titleSource, "manual");
  } finally {
    await new Promise((resolve, reject) => {
      started.server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function testWebUiContextOverflowRetry() {
  const workspaceRoot = await createWorkspace("pibot-webui-overflow-test-");
  const storeRoot = join(workspaceRoot, "store");
  const store = new FileChannelWorkspaceStore({
    rootDir: storeRoot,
  });
  const sessions = new WorkspaceSessionStore({
    store,
    compactor: createSessionCompactor({
      // Keep proactive threshold compaction out of this fixture even as tool
      // schemas grow; this case specifically exercises Provider overflow retry.
      contextWindowTokens: 100_000,
      reserveTokens: 1_000,
      keepRecentTokens: 1,
    }),
  });
  const evolution = new EvolutionController({
    store: new FileEvolutionStore({
      rootDir: join(storeRoot, "evolution"),
    }),
    context: new SessionEvolutionContextRecorder(sessions),
    defaultActor: "test",
  });
  const conversations = new FileWebConversationStore(storeRoot);
  const conversation = await conversations.create("Web session");
  const key = {
    teamId: "webui",
    channelId: conversation.id,
  };
  await sessions.appendContextMessage(key, {
    message: {
      role: "user",
      content: "Build a PNG grayscale script. ".repeat(40),
    },
    source: "webui",
  });
  await sessions.appendContextMessage(key, {
    message: {
      role: "assistant",
      content: "I inspected image conversion requirements. ".repeat(20),
    },
    source: "agent",
  });
  const modelRequests = [];
  const runner = new WebAgentRunner({
    conversations,
    workspaceRoot,
    store,
    sessions,
    model: {
      async *stream(request) {
        modelRequests.push(request);
        yield {
          type: "start",
          provider: "openai_compatible",
          model: "fake",
        };
        if (modelRequests.length === 1) {
          yield {
            type: "error",
            error: {
              code: "context_overflow",
              message: "maximum context length reached",
              retryable: false,
            },
          };
          return;
        }
        assert.equal(
          request.messages.some((message) =>
            message.content.includes("[SESSION COMPACTION SUMMARY]")),
          true,
        );
        yield {
          type: "text_delta",
          text: "Recovered after compaction.",
        };
        yield {
          type: "done",
        };
      },
    },
    tools: getCodingToolSchemas(),
    sandboxExecutor: {
      assertWorkspaceAccess() {},
    },
    toolApprovalMode: "read-only",
    toolLimits: {
      maxReadChars: 10_000,
      maxFileBytes: 10_000,
      maxCommandOutputChars: 10_000,
      maxGrepMatches: 10,
      maxGrepOutputChars: 10_000,
      defaultShellTimeoutMs: 1_000,
      maxShellTimeoutMs: 1_000,
    },
    evolution,
    maxSteps: 2,
  });
  const events = [];

  const result = await runner.runUserMessage(conversation.id, "Continue task", {
    onEvent: (event) => {
      events.push(event);
    },
  });
  const records = await store.readContextEntries(key);
  const summary = records
    .map((entry) => entry.record)
    .find((record) => record.source === "compaction");

  assert.equal(result.reason, "completed");
  assert.equal(modelRequests.length, 2);
  assert.notEqual(summary, undefined);
  assert.equal(summary.compactionReason, "context_overflow");
  assert.equal(
    events.some(
      (event) =>
        event.type === "status" &&
        /Context compacted\. Retrying the run/u.test(event.message),
    ),
    true,
  );
}

async function testWebUiPlanModeApproval() {
  const workspaceRoot = await createWorkspace("pibot-webui-plan-approval-test-");
  const storeRoot = join(workspaceRoot, "store");
  const store = new FileChannelWorkspaceStore({
    rootDir: storeRoot,
  });
  const sessions = new WorkspaceSessionStore({ store });
  const evolution = new EvolutionController({
    store: new FileEvolutionStore({
      rootDir: join(storeRoot, "evolution"),
    }),
    context: new SessionEvolutionContextRecorder(sessions),
    defaultActor: "test",
  });
  const conversations = new FileWebConversationStore(storeRoot);
  const conversation = await conversations.create("Web session");
  const childStore = new FileChildAgentRunStore({ store });
  const childKey = {
    teamId: "webui",
    channelId: conversation.id,
  };
  const spawnedChildren = [];
  const childCompletionErrors = [];
  const workflows = new WorkflowOrchestrator({
    store: new FileWorkflowStore({ rootDir: join(storeRoot, "workflows") }),
  });
  const modelRequests = [];
  const runner = new WebAgentRunner({
    conversations,
    workspaceRoot,
    store,
    sessions,
    model: {
      async *stream(request) {
        modelRequests.push(request);
        yield {
          type: "start",
          provider: "openai_compatible",
          model: "fake",
        };
        if (modelRequests.length === 1) {
          yield {
            type: "tool_call",
            call: {
              id: "enter-plan",
              name: "enter_plan_mode",
              argumentsJson: JSON.stringify({
                goal: "Plan before editing",
              }),
            },
          };
        } else if (modelRequests.length === 2) {
          yield {
            type: "tool_call",
            call: {
              id: "update-plan",
              name: "update_plan",
              argumentsJson: JSON.stringify({
                content: "# Plan\n\n1. Inspect.\n2. Edit after approval.\n",
                tasks: [
                  { id: "inspect", title: "Inspect current code" },
                  {
                    id: "edit",
                    title: "Edit after plan approval",
                    dependencies: ["inspect"],
                  },
                ],
                reason: "test plan",
              }),
            },
          };
        } else if (modelRequests.length === 3) {
          yield {
            type: "tool_call",
            call: {
              id: "exit-plan",
              name: "exit_plan_mode",
              argumentsJson: JSON.stringify({
                summary: "Approve the saved plan.",
              }),
            },
          };
        } else {
          if (modelRequests.length === 5) {
            const runtimeMessage = request.messages.findLast((message) =>
              message.role === "user");
            assert.notEqual(runtimeMessage, undefined);
            assert.match(runtimeMessage.content, /Runtime TaskGraph completion event/u);
            assert.match(runtimeMessage.content, /is succeeded/u);
          }
          yield {
            type: "text_delta",
            text: "Execution after approval complete.",
          };
        }
        yield {
          type: "done",
        };
      },
    },
    childAgents: {
      store: childStore,
      supervisor: {
        async spawn(record) {
          spawnedChildren.push(record);
          setTimeout(() => {
            void (async () => {
              await writeFile(
                record.paths.resultFile,
                `${record.task.includes("inspect") ? "Inspection" : "Edit"} evidence`,
                "utf8",
              );
              await childStore.updateRun(childKey, record.childRunId, {
                status: "completed",
                endedAt: new Date().toISOString(),
              });
            })().catch((error) => {
              childCompletionErrors.push(error);
            });
          }, 40);
          return {
            session: "webui-task-graph-resume",
            window: record.childRunId,
            target: `webui-task-graph-resume:${record.childRunId}`,
          };
        },
        async capture() {
          return "";
        },
        async send() {},
        async stop() {},
        async isAlive() {
          return true;
        },
      },
      maxConcurrent: 4,
    },
    workflows,
    tools: getCodingToolSchemas(),
    sandboxExecutor: {
      assertWorkspaceAccess() {},
    },
    toolApprovalMode: "read-only",
    approvalTimeoutMs: 5_000,
    toolLimits: {
      maxReadChars: 10_000,
      maxFileBytes: 10_000,
      maxCommandOutputChars: 10_000,
      maxGrepMatches: 10,
      maxGrepOutputChars: 10_000,
      defaultShellTimeoutMs: 1_000,
      maxShellTimeoutMs: 1_000,
    },
    evolution,
    maxSteps: 6,
  });
  const events = [];
  const run = runner.runUserMessage(conversation.id, "Plan this first", {
    onEvent: (event) => {
      events.push(event);
    },
  });

  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "approval_requested" &&
        event.approval.toolName === "enter_plan_mode",
    )
  );
  const enterApproval = events.find(
    (event) =>
      event.type === "approval_requested" &&
      event.approval.toolName === "enter_plan_mode",
  ).approval;
  assert.match(enterApproval.title, /Enter Plan Mode/u);
  assert.equal(
    (await runner.decideApproval(enterApproval.id, true)).ok,
    true,
  );

  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "approval_requested" &&
        event.approval.toolName === "exit_plan_mode",
    )
  );
  const exitApproval = events.find(
    (event) =>
      event.type === "approval_requested" &&
      event.approval.toolName === "exit_plan_mode",
  ).approval;
  assert.match(exitApproval.title, /Approve Plan/u);
  assert.equal(
    exitApproval.details.some((detail) => /Plan excerpt: \d+ bytes/u.test(detail)),
    true,
  );
  assert.equal(
    (await runner.decideApproval(exitApproval.id, true)).ok,
    true,
  );

  const result = await run;
  assert.equal(result.reason, "completed");
  assert.equal(modelRequests.length, 5);
  assert.equal(spawnedChildren.length, 2);
  assert.deepEqual(childCompletionErrors, []);
  const channelDir = store.getPaths({
    teamId: "webui",
    channelId: conversation.id,
  }).channelDir;
  assert.match(await readFile(join(channelDir, "PLAN.md"), "utf8"), /# Plan/u);
  const tasks = JSON.parse(await readFile(join(channelDir, "tasks.json"), "utf8"));
  assert.equal(tasks.tasks.length, 2);
  assert.equal(tasks.tasks.every((task) => task.status === "completed"), true);
  assert.equal(events.filter((event) =>
    event.type === "runtime_transition" &&
    event.transition.type === "start_followup_turn").length, 1);
  assert.equal(
    events.some(
      (event) =>
        event.type === "approval_resolved" &&
        event.approval.toolName === "exit_plan_mode" &&
        event.approval.status === "approved",
    ),
    true,
  );
}

async function testWebUiPlanModePersistsAcrossMessages() {
  const workspaceRoot = await createWorkspace("pibot-webui-plan-persist-test-");
  const storeRoot = join(workspaceRoot, "store");
  const store = new FileChannelWorkspaceStore({
    rootDir: storeRoot,
  });
  const sessions = new WorkspaceSessionStore({ store });
  const evolution = new EvolutionController({
    store: new FileEvolutionStore({
      rootDir: join(storeRoot, "evolution"),
    }),
    context: new SessionEvolutionContextRecorder(sessions),
    defaultActor: "test",
  });
  const conversations = new FileWebConversationStore(storeRoot);
  const conversation = await conversations.create("Web session");
  const modelRequests = [];
  const runner = new WebAgentRunner({
    conversations,
    workspaceRoot,
    store,
    sessions,
    model: {
      async *stream(request) {
        modelRequests.push(request);
        yield {
          type: "start",
          provider: "openai_compatible",
          model: "fake",
        };
        if (modelRequests.length === 1) {
          yield {
            type: "tool_call",
            call: {
              id: "enter-plan",
              name: "enter_plan_mode",
              argumentsJson: JSON.stringify({
                goal: "Plan before editing",
              }),
            },
          };
        } else if (modelRequests.length === 2) {
          yield {
            type: "text_delta",
            text: "Plan Mode is active. Tell me any constraints before I write the plan.",
          };
        } else if (modelRequests.length === 3) {
          const toolNames = request.tools.map((tool) => tool.name);
          assert.equal(toolNames.includes("update_plan"), true);
          assert.equal(toolNames.includes("exit_plan_mode"), true);
          assert.equal(toolNames.includes("write"), false);
          assert.equal(toolNames.includes("bash"), false);
          yield {
            type: "tool_call",
            call: {
              id: "update-plan",
              name: "update_plan",
              argumentsJson: JSON.stringify({
                content: "# Plan\n\n1. Inspect.\n2. Edit after approval.\n",
                tasks: [
                  { id: "inspect", title: "Inspect current code" },
                  {
                    id: "edit",
                    title: "Edit after plan approval",
                    dependencies: ["inspect"],
                  },
                ],
                reason: "persisted plan mode",
              }),
            },
          };
        } else if (modelRequests.length === 4) {
          yield {
            type: "tool_call",
            call: {
              id: "exit-plan",
              name: "exit_plan_mode",
              argumentsJson: JSON.stringify({
                summary: "Approve the persisted plan.",
              }),
            },
          };
        } else {
          yield {
            type: "text_delta",
            text: "Execution after approval complete.",
          };
        }
        yield {
          type: "done",
        };
      },
    },
    tools: getCodingToolSchemas(),
    sandboxExecutor: {
      assertWorkspaceAccess() {},
    },
    toolApprovalMode: "read-only",
    approvalTimeoutMs: 5_000,
    toolLimits: {
      maxReadChars: 10_000,
      maxFileBytes: 10_000,
      maxCommandOutputChars: 10_000,
      maxGrepMatches: 10,
      maxGrepOutputChars: 10_000,
      defaultShellTimeoutMs: 1_000,
      maxShellTimeoutMs: 1_000,
    },
    evolution,
    maxSteps: 6,
  });

  const firstEvents = [];
  const firstRun = runner.runUserMessage(conversation.id, "Plan this first", {
    onEvent: (event) => {
      firstEvents.push(event);
    },
  });
  await waitFor(() =>
    firstEvents.some(
      (event) =>
        event.type === "approval_requested" &&
        event.approval.toolName === "enter_plan_mode",
    )
  );
  const enterApproval = firstEvents.find(
    (event) =>
      event.type === "approval_requested" &&
      event.approval.toolName === "enter_plan_mode",
  ).approval;
  assert.equal(
    (await runner.decideApproval(enterApproval.id, true)).ok,
    true,
  );
  assert.equal((await firstRun).reason, "completed");

  const channelDir = store.getPaths({
    teamId: "webui",
    channelId: conversation.id,
  }).channelDir;
  const persistedPlanState = JSON.parse(
    await readFile(join(channelDir, "runtime-state.json"), "utf8"),
  );
  assert.equal(persistedPlanState.state.mode, "plan");
  await rm(join(channelDir, "runtime-state.json"), { force: true });

  const secondEvents = [];
  const secondRun = runner.runUserMessage(conversation.id, "No changes needed", {
    onEvent: (event) => {
      secondEvents.push(event);
    },
  });
  await waitFor(() =>
    secondEvents.some(
      (event) =>
        event.type === "approval_requested" &&
        event.approval.toolName === "exit_plan_mode",
    )
  );
  const exitApproval = secondEvents.find(
    (event) =>
      event.type === "approval_requested" &&
      event.approval.toolName === "exit_plan_mode",
  ).approval;
  assert.equal(
    (await runner.decideApproval(exitApproval.id, true)).ok,
    true,
  );
  assert.equal((await secondRun).reason, "completed");
  assert.match(await readFile(join(channelDir, "PLAN.md"), "utf8"), /# Plan/u);
  const tasks = JSON.parse(await readFile(join(channelDir, "tasks.json"), "utf8"));
  assert.equal(tasks.tasks.length, 2);
  const persistedExecuteState = JSON.parse(
    await readFile(join(channelDir, "runtime-state.json"), "utf8"),
  );
  assert.equal(persistedExecuteState.state.mode, "execute");
}

async function testWebUiChildAgentRuntimeAvailable() {
  const workspaceRoot = await createWorkspace("pibot-webui-child-agent-test-");
  const storeRoot = join(workspaceRoot, "store");
  const store = new FileChannelWorkspaceStore({
    rootDir: storeRoot,
  });
  const sessions = new WorkspaceSessionStore({ store });
  const evolution = new EvolutionController({
    store: new FileEvolutionStore({
      rootDir: join(storeRoot, "evolution"),
    }),
    context: new SessionEvolutionContextRecorder(sessions),
    defaultActor: "test",
  });
  const conversations = new FileWebConversationStore(storeRoot);
  const conversation = await conversations.create("Web child agent session");
  const childStore = new FileChildAgentRunStore({ store });
  const childKey = {
    teamId: "webui",
    channelId: conversation.id,
  };
  const workflows = new WorkflowOrchestrator({
    store: new FileWorkflowStore({ rootDir: join(storeRoot, "workflows") }),
  });
  const spawned = [];
  const childCompletionErrors = [];
  const modelRequests = [];
  const runner = new WebAgentRunner({
    conversations,
    workspaceRoot,
    store,
    sessions,
    model: {
      async *stream(request) {
        modelRequests.push(request);
        yield {
          type: "start",
          provider: "openai_compatible",
          model: "fake",
        };
        if (modelRequests.length === 1) {
          assert.equal(
            request.tools.some((tool) => tool.name === "agent_spawn"),
            true,
          );
          yield {
            type: "tool_call",
            call: {
              id: "spawn-child",
              name: "agent_spawn",
              argumentsJson: JSON.stringify({
                role: "explore",
                task:
                  "Use the model-chosen objective from this task text and report a concise finding.",
                timeoutMs: 1000,
              }),
            },
          };
        } else if (modelRequests.length === 2) {
          assert.equal(
            request.messages.some(
              (message) =>
                message.role === "tool" &&
                /childRunId/u.test(message.content),
            ),
            true,
          );
          yield {
            type: "text_delta",
            text: "Child agent scheduled.",
          };
        } else {
          const runtimeMessage = request.messages.findLast((message) =>
            message.role === "user");
          assert.notEqual(runtimeMessage, undefined);
          assert.match(runtimeMessage.content, /Runtime child completion event/u);
          assert.match(runtimeMessage.content, /child evidence/u);
          yield {
            type: "text_delta",
            text: "Child evidence integrated.",
          };
        }
        yield {
          type: "done",
        };
      },
    },
    tools: getCodingToolSchemas(),
    sandboxExecutor: {
      assertWorkspaceAccess() {},
    },
    toolApprovalMode: "full-access",
    approvalTimeoutMs: 5_000,
    toolLimits: {
      maxReadChars: 10_000,
      maxFileBytes: 10_000,
      maxCommandOutputChars: 10_000,
      maxGrepMatches: 10,
      maxGrepOutputChars: 10_000,
      defaultShellTimeoutMs: 1_000,
      maxShellTimeoutMs: 1_000,
    },
    childAgents: {
      store: childStore,
      supervisor: {
        async spawn(record) {
          spawned.push(record);
          setTimeout(() => {
            void (async () => {
              await writeFile(record.paths.resultFile, "child evidence", "utf8");
              await childStore.updateRun(childKey, record.childRunId, {
                status: "completed",
                endedAt: new Date().toISOString(),
              });
            })().catch((error) => {
              childCompletionErrors.push(error);
            });
          }, 40);
          return {
            session: "webui-child-agent-test",
            window: "child",
            target: "webui-child-agent-test:child",
          };
        },
        async capture() {
          return "";
        },
        async send() {},
        async stop() {},
        async isAlive() {
          return true;
        },
      },
      maxConcurrent: 20,
    },
    workflows,
    evolution,
    maxSteps: 3,
  });

  const result = await runner.runUserMessage(
    conversation.id,
    "Use a child agent from WebUI",
  );

  assert.equal(result.reason, "completed");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].parentRunId, result.runId);
  assert.equal(spawned[0].readOnly, false);
  assert.equal(typeof spawned[0].worktreePath, "string");
  assert.notEqual(spawned[0].worktreePath, workspaceRoot);
  assert.equal(spawned[0].budget.timeoutMs, 1000);
  assert.equal(modelRequests.length, 3);
  assert.deepEqual(childCompletionErrors, []);
  const workflowRuns = await workflows.store.listRuns();
  assert.equal(workflowRuns.length, 1);
  assert.equal(workflowRuns[0].kind, "coordinator_child");
  assert.equal(workflowRuns[0].status, "succeeded");
  const attempts = await workflows.store.readAttempts(workflowRuns[0].runId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "succeeded");
}

async function testWebUiToolApproval() {
  const workspaceRoot = await createWorkspace("pibot-webui-tool-approval-test-");
  const storeRoot = join(workspaceRoot, "store");
  const store = new FileChannelWorkspaceStore({
    rootDir: storeRoot,
  });
  const sessions = new WorkspaceSessionStore({ store });
  const evolution = new EvolutionController({
    store: new FileEvolutionStore({
      rootDir: join(storeRoot, "evolution"),
    }),
    context: new SessionEvolutionContextRecorder(sessions),
    defaultActor: "test",
  });
  const conversations = new FileWebConversationStore(storeRoot);
  const conversation = await conversations.create("Web session");
  const modelRequests = [];
  const runner = new WebAgentRunner({
    conversations,
    workspaceRoot,
    store,
    sessions,
    model: {
      async *stream(request) {
        modelRequests.push(request);
        yield {
          type: "start",
          provider: "openai_compatible",
          model: "fake",
        };
        if (modelRequests.length === 1) {
          yield {
            type: "tool_call",
            call: {
              id: "write-approved",
              name: "write",
              argumentsJson: JSON.stringify({
                path: "approved.txt",
                content: "approved",
                overwrite: true,
              }),
            },
          };
        } else {
          assert.equal(
            request.messages.some(
              (message) =>
                message.role === "tool" &&
                /approved\.txt/u.test(message.content),
            ),
            true,
          );
          yield {
            type: "text_delta",
            text: "Write completed.",
          };
        }
        yield {
          type: "done",
        };
      },
    },
    tools: getCodingToolSchemas(),
    sandboxExecutor: {
      assertWorkspaceAccess() {},
    },
    toolApprovalMode: "approval-required",
    approvalTimeoutMs: 5_000,
    toolLimits: {
      maxReadChars: 10_000,
      maxFileBytes: 10_000,
      maxCommandOutputChars: 10_000,
      maxGrepMatches: 10,
      maxGrepOutputChars: 10_000,
      defaultShellTimeoutMs: 1_000,
      maxShellTimeoutMs: 1_000,
    },
    evolution,
    maxSteps: 3,
  });
  const events = [];
  const run = runner.runUserMessage(conversation.id, "Write approved file", {
    onEvent: (event) => {
      events.push(event);
    },
  });

  await waitFor(() =>
    events.some(
      (event) =>
        event.type === "approval_requested" &&
        event.approval.toolName === "write",
    )
  );
  const approval = events.find(
    (event) =>
      event.type === "approval_requested" &&
      event.approval.toolName === "write",
  ).approval;
  assert.match(approval.title, /Approve write/u);
  assert.equal(approval.runScopeAllowed, true);
  assert.equal(
    approval.details.some((detail) => /approved\.txt/u.test(detail)),
    true,
  );
  assert.equal(
    approval.details.some((detail) => /Escalation: filesystem\.write/u.test(detail)),
    true,
  );
  assert.equal(
    approval.details.some((detail) => /Escalation: filesystem\.read/u.test(detail)),
    false,
  );
  assert.equal((await runner.decideApproval(approval.id, true, "run")).ok, true);

  const result = await run;
  assert.equal(result.reason, "completed");
  assert.equal(modelRequests.length, 2);
  assert.equal(
    await readFile(
      join(
        store.getPaths({
          teamId: "webui",
          channelId: conversation.id,
        }).channelDir,
        "approved.txt",
      ),
      "utf8",
    ),
    "approved",
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === "approval_resolved" &&
        event.approval.toolName === "write" &&
        event.approval.status === "approved",
    ),
    true,
  );
}

async function testWebUiChannelBashBoundary() {
  const workspaceRoot = join(tmpdir(), "pibot-webui-channel");
  assert.equal(
    findOutsideWorkspacePathReference(
      "cat /home/chenzhengwei/code/agent/pibot/src/web/agent.ts",
      workspaceRoot,
    ),
    "/home/chenzhengwei/code/agent/pibot/src/web/agent.ts",
  );
  assert.equal(
    findOutsideWorkspacePathReference(
      `cat ${join(workspaceRoot, "grayscale_converter.py")}`,
      workspaceRoot,
    ),
    undefined,
  );
  assert.equal(
    findOutsideWorkspacePathReference("python grayscale_converter.py ./images", workspaceRoot),
    undefined,
  );
  assert.equal(
    findOutsideWorkspacePathReference("/bin/cat grayscale_converter.py", workspaceRoot),
    undefined,
  );
  assert.equal(
    findOutsideWorkspacePathReference("cat /etc/passwd", workspaceRoot),
    "/etc/passwd",
  );
}

async function testFileToolSizeLimit() {
  const workspaceRoot = await createWorkspace("pibot-file-limit-test-");
  await writeFile(join(workspaceRoot, "large.txt"), "123456", "utf8");
  const tools = createCodingToolExecutor({
    workspaceRoot,
    approvalGate: createToolApprovalGate("workspace-write"),
    maxFileBytes: 5,
  });

  const readResult = await tools.executeTool({
    id: "read-large",
    name: "read",
    input: { path: "large.txt" },
  });
  assert.equal(readResult.ok, false);
  assert.equal(readResult.error.code, "invalid_input");

  const writeResult = await tools.executeTool({
    id: "write-large",
    name: "write",
    input: {
      path: "new-large.txt",
      content: "123456",
      overwrite: true,
    },
  });
  assert.equal(writeResult.ok, false);
  assert.equal(writeResult.error.code, "invalid_input");
}

async function testToolApprovalPolicy() {
  const workspaceRoot = await createWorkspace("pibot-approval-test-");
  const tools = createCodingToolExecutor({ workspaceRoot });
  const result = await tools.executeTool({
    id: "write-denied",
    name: "write",
    input: {
      path: "blocked.txt",
      content: "blocked",
      overwrite: true,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "permission_denied");
  assert.match(result.error.message, /TOOL_APPROVAL_MODE=read-only/u);
}

async function testDisabledToolPolicy() {
  const workspaceRoot = await createWorkspace("pibot-disabled-tools-test-");
  const tools = createCodingToolExecutor({
    workspaceRoot,
    disabledTools: ["enter_plan_mode", "update_plan", "exit_plan_mode"],
  });

  assert.equal(tools.listTools().includes("enter_plan_mode"), false);
  assert.equal(tools.describeTool("enter_plan_mode"), undefined);

  const parsed = tools.parseToolCall({
    id: "enter-plan",
    name: "enter_plan_mode",
    argumentsJson: JSON.stringify({ goal: "Plan anyway" }),
  });
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /disabled in this run/u);

  const result = await tools.executeTool({
    id: "enter-plan",
    name: "enter_plan_mode",
    input: {
      goal: "Plan anyway",
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "permission_denied");
  assert.match(result.error.message, /disabled in this run/u);
}

async function testSlackInteractiveToolApproval() {
  const slack = new FakeSlackApprovalPublisher();
  const broker = new SlackToolApprovalBroker(slack);
  const context = {
    conversation: {
      teamId: "T1",
      channelId: "D1",
    },
    requestedByUserId: "U-requester",
  };
  const gate = createToolApprovalGate("approval-required", {
    prompter: broker,
    context,
    timeoutMs: 1000,
  });
  const approvalRequest = {
    call: {
      id: "bash-approval",
      name: "bash",
      input: {
        command: "npm test",
      },
    },
    risk: "high",
    explanation: "test approval",
  };
  const decisionPromise = gate.reviewToolCall(approvalRequest);
  await waitFor(() => slack.events.length === 1);

  const approvalId = readApprovalId(slack.events[0]);
  assert.equal(
    await broker.handleSlackInteraction(
      approvalAction(approvalId, TOOL_APPROVAL_ALLOW_ACTION, "U-other"),
    ),
    true,
  );
  assert.equal(await isSettled(decisionPromise), false);

  assert.equal(
    await broker.handleSlackInteraction(
      approvalAction(approvalId, TOOL_APPROVAL_ALLOW_RUN_ACTION, "U-requester"),
    ),
    true,
  );
  const approvedDecision = await decisionPromise;
  assert.deepEqual(approvedDecision, { approved: true, scope: "run" });
  await gate.commitToolApproval(approvalRequest, approvedDecision);
  assert.equal(slack.events.length, 2);
  assert.equal(slack.events[1].type, "message.update");
  assert.equal(
    slack.events[1].update.blocks.some((block) => block.type === "actions"),
    false,
  );
  assert.deepEqual(
    await gate.reviewToolCall({
      call: {
        id: "bash-approval-reused",
        name: "bash",
        input: { command: "npm test" },
      },
      risk: "high",
      explanation: "test approval reuse",
    }),
    { approved: true, scope: "run" },
  );
  assert.equal(slack.events.length, 2);

  const deniedPromise = gate.reviewToolCall({
    call: {
      id: "edit-rejected",
      name: "edit",
      input: {
        path: "rejected.txt",
        replacements: [{ oldText: "before", newText: "after" }],
      },
    },
    risk: "medium",
    explanation: "test rejection",
  });
  await waitFor(() => slack.events.length === 3);
  const deniedApprovalId = readApprovalId(slack.events[2]);
  await broker.handleSlackInteraction(
    approvalAction(deniedApprovalId, TOOL_APPROVAL_DENY_ACTION, "U-requester"),
  );
  const deniedDecision = await deniedPromise;
  assert.equal(deniedDecision.approved, false);
  assert.match(deniedDecision.reason, /rejected/u);

  const abortController = new AbortController();
  const cancelledPromise = gate.reviewToolCall(
    {
      call: {
        id: "write-cancelled",
        name: "write",
        input: {
          path: "cancelled.txt",
          content: "blocked",
          overwrite: true,
        },
      },
      risk: "medium",
      explanation: "test cancellation",
    },
    abortController.signal,
  );
  await waitFor(() => slack.events.length === 5);
  abortController.abort();
  const cancelledDecision = await cancelledPromise;
  assert.equal(cancelledDecision.approved, false);
  assert.match(cancelledDecision.reason, /cancelled/u);

  const beforeEnterPlanApprovalEvents = slack.events.length;
  const enterPlanDecisionPromise = broker.requestToolApproval({
    call: {
      id: "enter-plan-approval",
      name: "enter_plan_mode",
      input: {
        goal: "Inspect the workspace before editing.",
      },
    },
    risk: "mutating",
    explanation: "test enter plan approval",
    context,
    timeoutMs: 1000,
  });
  await waitFor(() => slack.events.length === beforeEnterPlanApprovalEvents + 1);
  const enterPlanPost = slack.events.at(-1);
  assert.equal(enterPlanPost.type, "message.post");
  assert.match(blockText(enterPlanPost.draft.blocks), /enter Plan Mode/u);
  assert.match(blockText(enterPlanPost.draft.blocks), /Goal:/u);

  const enterPlanApprovalId = readApprovalId(enterPlanPost);
  await broker.handleSlackInteraction(
    approvalAction(enterPlanApprovalId, TOOL_APPROVAL_ALLOW_ACTION, "U-requester"),
  );
  assert.deepEqual(await enterPlanDecisionPromise, { approved: true });
  const enterPlanUpdate = slack.events.at(-1);
  assert.equal(enterPlanUpdate.type, "message.update");
  assert.match(enterPlanUpdate.update.text, /Plan Mode approved/u);
  assert.match(blockText(enterPlanUpdate.update.blocks), /Plan approval completed/u);
  assert.equal(
    enterPlanUpdate.update.blocks.some((block) => block.type === "actions"),
    false,
  );

  const beforeExitPlanApprovalEvents = slack.events.length;
  const exitPlanDecisionPromise = broker.requestToolApproval({
    call: {
      id: "exit-plan-approval",
      name: "exit_plan_mode",
      input: {
        summary: "Approve the saved plan.",
        planPath: "PLAN.md",
        planExcerpt: "SHOULD_NOT_REPEAT_IN_SLACK ".repeat(200),
      },
    },
    risk: "mutating",
    explanation: "test plan approval",
    context,
    timeoutMs: 1000,
  });
  await waitFor(() => slack.events.length === beforeExitPlanApprovalEvents + 1);
  const exitPlanPost = slack.events.at(-1);
  assert.equal(exitPlanPost.type, "message.post");
  assert.match(blockText(exitPlanPost.draft.blocks), /Plan approval required/u);
  assert.equal(/SHOULD_NOT_REPEAT_IN_SLACK/u.test(blockText(exitPlanPost.draft.blocks)), false);

  const planApprovalId = readApprovalId(exitPlanPost);
  await broker.handleSlackInteraction(
    approvalAction(planApprovalId, TOOL_APPROVAL_ALLOW_ACTION, "U-requester"),
  );
  assert.deepEqual(await exitPlanDecisionPromise, { approved: true });
  const planUpdate = slack.events.at(-1);
  assert.equal(planUpdate.type, "message.update");
  assert.match(planUpdate.update.text, /Plan approved/u);
  assert.match(blockText(planUpdate.update.blocks), /Plan approval completed/u);
  assert.match(blockText(planUpdate.update.blocks), /Plan approved/u);
  assert.equal(
    planUpdate.update.blocks.some((block) => block.type === "actions"),
    false,
  );
  assert.equal(/SHOULD_NOT_REPEAT_IN_SLACK/u.test(blockText(planUpdate.update.blocks)), false);

  const timeoutSlack = new FakeSlackApprovalPublisher();
  const timeoutBroker = new SlackToolApprovalBroker(timeoutSlack);
  const timeoutGate = createToolApprovalGate("approval-required", {
    prompter: timeoutBroker,
    context,
    timeoutMs: 10,
  });
  const timeoutDecision = await timeoutGate.reviewToolCall({
    call: {
      id: "write-timeout",
      name: "write",
      input: {
        path: "timeout.txt",
        content: "blocked",
        overwrite: true,
      },
    },
    risk: "medium",
    explanation: "test timeout",
  });
  assert.equal(timeoutDecision.approved, false);
  assert.match(timeoutDecision.reason, /timed out/u);

  const workspaceWriteWithoutSlack = createToolApprovalGate("workspace-write");
  const deniedWithoutPrompter = await workspaceWriteWithoutSlack.reviewToolCall({
    call: {
      id: "bash-no-prompter",
      name: "bash",
      input: { command: "npm test" },
    },
    risk: "high",
    explanation: "test fail closed",
  });
  assert.equal(deniedWithoutPrompter.approved, false);
  assert.match(deniedWithoutPrompter.reason, /no approval prompter/u);
}

async function testChildAgentApprovalBridge() {
  const workspaceRoot = await createWorkspace("pibot-child-approval-test-");
  const runDir = join(
    workspaceRoot,
    ".pibot",
    "channels",
    "T1",
    "D1",
    "runs",
    "child-1",
  );
  await mkdir(runDir, { recursive: true });
  const slack = new FakeSlackApprovalPublisher();
  const broker = new SlackToolApprovalBroker(slack);
  const responder = new FileChildAgentApprovalResponder({
    rootDir: join(workspaceRoot, ".pibot"),
    prompter: broker,
    pollIntervalMs: 1,
  });
  responder.start();

  try {
    const prompter = new FileChildAgentApprovalPrompter({
      runDir,
      pollIntervalMs: 1,
    });
    const decisionPromise = prompter.requestToolApproval({
      call: {
        id: "child-bash-approval",
        name: "bash",
        input: {
          command: "npm test",
        },
      },
      risk: "external",
      explanation: "child agent wants to run tests",
      context: {
        conversation: {
          teamId: "T1",
          channelId: "D1",
        },
        requestedByUserId: "U-requester",
      },
      timeoutMs: 5000,
    });
    await waitForAsync(
      async () => (await childApprovalRequestFiles(runDir)).length === 1,
      {
        attempts: 500,
        delayMs: 5,
      },
    );
    void responder.poll();
    await waitFor(() => slack.events.length >= 1, {
      attempts: 500,
      delayMs: 5,
    });

    const approvalId = readApprovalId(slack.events[0]);
    await broker.handleSlackInteraction(
      approvalAction(approvalId, TOOL_APPROVAL_ALLOW_ACTION, "U-requester"),
    );

    assert.deepEqual(await decisionPromise, { approved: true });
    assert.equal(slack.events.length, 2);
    assert.equal(slack.events[1].type, "message.update");
  } finally {
    responder.stop();
  }
}

function testChildAgentWriteApprovalMode() {
  assert.equal(
    resolveChildAgentToolApprovalMode({
      readOnly: false,
      hasApprovalContext: true,
    }),
    "approval-required",
  );
  assert.equal(
    resolveChildAgentToolApprovalMode({
      readOnly: true,
      hasApprovalContext: true,
    }),
    "approval-required",
  );
  assert.equal(
    resolveChildAgentToolApprovalMode({
      readOnly: false,
      hasApprovalContext: true,
      configuredMode: "approval-required",
    }),
    "approval-required",
  );
  assert.equal(
    resolveChildAgentToolApprovalMode({
      readOnly: true,
      allowBash: true,
    }),
    "workspace-write",
  );
  assert.equal(
    resolveChildAgentToolApprovalMode({
      readOnly: false,
    }),
    "workspace-write",
  );
}

function testChildAgentStepBudget() {
  assert.equal(
    resolveChildAgentMaxSteps({
      maxToolCalls: 80,
    }),
    80,
  );
  assert.equal(
    resolveChildAgentMaxSteps({
      configuredMaxSteps: 12,
      maxToolCalls: 80,
    }),
    12,
  );
}

function testKimiK26UsagePricing() {
  const chinaPricing = defaultUsagePricingForModel(
    "kimi-k2.6",
    "https://api.moonshot.cn/v1",
  );
  const usage = calculateUsage(
    {
      inputTokens: 1_000_000,
      cachedInputTokens: 400_000,
      outputTokens: 200_000,
      totalTokens: 1_200_000,
    },
    chinaPricing,
  );

  assert.equal(chinaPricing.strategy, "kimi-k2.6-cn");
  assert.equal(usage.uncachedInputTokens, 600_000);
  assert.equal(usage.cacheHitRatio, 0.4);
  assert.ok(Math.abs(usage.uncachedInputCost - 3.9) < 1e-12);
  assert.ok(Math.abs(usage.cachedInputCost - 0.44) < 1e-12);
  assert.ok(Math.abs(usage.outputCost - 5.4) < 1e-12);
  assert.ok(Math.abs(usage.cacheSavings - 2.16) < 1e-12);
  assert.equal(usage.currency, "CNY");
  assert.ok(Math.abs(usage.cost - 9.74) < 1e-12);

  const globalPricing = defaultUsagePricingForModel(
    "kimi-k2.6",
    "https://api.moonshot.ai/v1",
  );
  assert.equal(globalPricing.strategy, "kimi-k2.6-global");
  assert.equal(globalPricing.currency, "USD");

  const overridden = usagePricingFromEnv(globalPricing, {
    USAGE_COST_CURRENCY: "CNY",
    USAGE_INPUT_COST_PER_1M_TOKENS: "2.5",
    USAGE_CACHED_INPUT_COST_PER_1M_TOKENS: "0.5",
    USAGE_OUTPUT_COST_PER_1M_TOKENS: "8",
  });
  assert.equal(overridden.strategy, "kimi-k2.6-global+env");
  assert.equal(overridden.currency, "CNY");
  assert.equal(overridden.inputCostPerMillionTokens, 2.5);
  assert.equal(overridden.cachedInputCostPerMillionTokens, 0.5);
  assert.equal(overridden.outputCostPerMillionTokens, 8);
}

async function testKimiStreamUsageParsing() {
  const previousApiKey = process.env.PIBOT_TEST_API_KEY;
  const previousFetch = global.fetch;
  let requestBody;
  process.env.PIBOT_TEST_API_KEY = "test-key";
  global.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(
      [
        'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop","usage":{"prompt_tokens":120,"cached_tokens":80,"completion_tokens":30,"total_tokens":150}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
      {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
        },
      },
    );
  };

  try {
    const model = new OpenAICompatibleModelClient({
      apiKeyEnvVar: "PIBOT_TEST_API_KEY",
      defaultBaseUrl: "https://api.moonshot.cn/v1",
      defaultModel: "kimi-k2.6",
    });
    const events = [];
    for await (const event of model.stream({
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    })) {
      events.push(event);
    }

    assert.deepEqual(requestBody.stream_options, {
      include_usage: true,
    });
    assert.deepEqual(events.at(-1), {
      type: "done",
      finishReason: "stop",
      usage: {
        inputTokens: 120,
        cachedInputTokens: 80,
        outputTokens: 30,
        totalTokens: 150,
      },
    });
  } finally {
    global.fetch = previousFetch;
    if (previousApiKey === undefined) {
      delete process.env.PIBOT_TEST_API_KEY;
    } else {
      process.env.PIBOT_TEST_API_KEY = previousApiKey;
    }
  }
}

async function testNativeDeveloperRole() {
  const previousApiKey = process.env.PIBOT_TEST_API_KEY;
  const previousMode = process.env.PIBOT_TEST_DEVELOPER_ROLE_MODE;
  const previousFetch = global.fetch;
  let requestBody;
  process.env.PIBOT_TEST_API_KEY = "test-key";
  delete process.env.PIBOT_TEST_DEVELOPER_ROLE_MODE;
  global.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return providerDoneResponse();
  };

  try {
    const model = new OpenAICompatibleModelClient({
      apiKeyEnvVar: "PIBOT_TEST_API_KEY",
      developerRoleModeEnvVar: "PIBOT_TEST_DEVELOPER_ROLE_MODE",
      defaultBaseUrl: "https://api.openai.test/v1",
      defaultModel: "fake-model",
    });
    const events = [];
    for await (const event of model.stream({
      messages: [
        { role: "system", content: "runtime boundary" },
        {
          role: "developer",
          content: "application instruction",
          contextLane: {
            id: "provider-test",
            kind: "instruction",
            placement: "stable_prefix",
          },
        },
        { role: "user", content: "current request" },
      ],
      tools: [],
    })) {
      events.push(event);
    }

    assert.deepEqual(
      requestBody.messages.map((message) => message.role),
      ["system", "developer", "user"],
    );
    assert.equal("contextLane" in requestBody.messages[1], false);
    assert.deepEqual(events[0], {
      type: "start",
      provider: "openai_compatible",
      model: "fake-model",
      developerRoleMode: "native",
      authorityDegraded: false,
    });
  } finally {
    global.fetch = previousFetch;
    restoreEnvironment("PIBOT_TEST_API_KEY", previousApiKey);
    restoreEnvironment("PIBOT_TEST_DEVELOPER_ROLE_MODE", previousMode);
  }
}

async function testExplicitDeveloperRoleFallback() {
  const previousApiKey = process.env.PIBOT_TEST_API_KEY;
  const previousMode = process.env.PIBOT_TEST_DEVELOPER_ROLE_MODE;
  const previousFetch = global.fetch;
  let requestBody;
  process.env.PIBOT_TEST_API_KEY = "test-key";
  process.env.PIBOT_TEST_DEVELOPER_ROLE_MODE = "system-fallback";
  global.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return providerDoneResponse();
  };

  try {
    const model = new OpenAICompatibleModelClient({
      apiKeyEnvVar: "PIBOT_TEST_API_KEY",
      developerRoleModeEnvVar: "PIBOT_TEST_DEVELOPER_ROLE_MODE",
      defaultBaseUrl: "https://api.openai.test/v1",
      defaultModel: "fake-model",
    });
    const events = [];
    for await (const event of model.stream({
      messages: [
        { role: "system", content: "runtime boundary" },
        { role: "developer", content: "application instruction" },
        { role: "user", content: "current request" },
      ],
      tools: [],
    })) {
      events.push(event);
    }

    assert.deepEqual(
      requestBody.messages.map((message) => message.role),
      ["system", "system", "user"],
    );
    assert.deepEqual(events[0], {
      type: "start",
      provider: "openai_compatible",
      model: "fake-model",
      developerRoleMode: "system-fallback",
      authorityDegraded: true,
    });
  } finally {
    global.fetch = previousFetch;
    restoreEnvironment("PIBOT_TEST_API_KEY", previousApiKey);
    restoreEnvironment("PIBOT_TEST_DEVELOPER_ROLE_MODE", previousMode);
  }
}

function providerDoneResponse() {
  return new Response(
    [
      'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n"),
    { status: 200 },
  );
}

function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function testSseToolCallArgumentFragments() {
  const previousApiKey = process.env.PIBOT_TEST_API_KEY;
  const previousFetch = global.fetch;
  process.env.PIBOT_TEST_API_KEY = "test-key";
  global.fetch = async () =>
    new Response(
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read","arguments":"{\\"pa"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"fixture.txt\\"}"}}]},"finish_reason":"tool_calls"}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
      { status: 200 },
    );

  try {
    const model = new OpenAICompatibleModelClient({
      apiKeyEnvVar: "PIBOT_TEST_API_KEY",
      defaultBaseUrl: "https://api.openai.test/v1",
      defaultModel: "fake-model",
    });
    const events = [];
    for await (const event of model.stream({
      messages: [{ role: "user", content: "read fixture" }],
      tools: [],
    })) {
      events.push(event);
    }

    assert.deepEqual(
      events.find((event) => event.type === "tool_call"),
      {
        type: "tool_call",
        call: {
          id: "call-1",
          name: "read",
          argumentsJson: '{"path":"fixture.txt"}',
        },
      },
    );
  } finally {
    global.fetch = previousFetch;
    if (previousApiKey === undefined) {
      delete process.env.PIBOT_TEST_API_KEY;
    } else {
      process.env.PIBOT_TEST_API_KEY = previousApiKey;
    }
  }
}

async function testProviderRepairsInterleavedToolCallHistory() {
  const previousApiKey = process.env.PIBOT_TEST_API_KEY;
  const previousFetch = global.fetch;
  let requestBody;
  process.env.PIBOT_TEST_API_KEY = "test-key";
  global.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(
      [
        'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
      { status: 200 },
    );
  };

  try {
    const model = new OpenAICompatibleModelClient({
      apiKeyEnvVar: "PIBOT_TEST_API_KEY",
      defaultBaseUrl: "https://api.openai.test/v1",
      defaultModel: "fake-model",
    });
    for await (const _event of model.stream({
      messages: [
        { role: "user", content: "read then adjust" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-read-1",
              name: "read",
              argumentsJson: JSON.stringify({ path: "README.md" }),
            },
          ],
        },
        { role: "user", content: "new message arrived mid-tool" },
        {
          role: "tool",
          content: JSON.stringify({
            ok: true,
            callId: "call-read-1",
            output: { content: "README content" },
          }),
          toolCallId: "call-read-1",
        },
      ],
      tools: [],
    })) {
      // Consume the stream so the request is sent.
    }

    const roles = requestBody.messages.map((message) => message.role);
    assert.deepEqual(roles, ["user", "assistant", "tool", "user"]);
    assert.equal(requestBody.messages[2].tool_call_id, "call-read-1");
    assert.equal(requestBody.messages[3].content, "new message arrived mid-tool");
  } finally {
    global.fetch = previousFetch;
    if (previousApiKey === undefined) {
      delete process.env.PIBOT_TEST_API_KEY;
    } else {
      process.env.PIBOT_TEST_API_KEY = previousApiKey;
    }
  }
}

async function testAgentLoopToolCallFlow() {
  const workspaceRoot = await createWorkspace("pibot-loop-test-");
  await writeFile(join(workspaceRoot, "fixture.txt"), "tool-flow", "utf8");
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield {
        type: "start",
        provider: "openai_compatible",
        model: "fake",
      };

      if (requests.length === 1) {
        yield {
          type: "tool_call",
          call: {
            id: "read-call",
            name: "read",
            argumentsJson: JSON.stringify({
              path: "fixture.txt",
            }),
          },
        };
      } else {
        const toolMessage = request.messages.find(
          (message) =>
            message.role === "tool" && message.content.includes("tool-flow"),
        );
        assert.notEqual(toolMessage, undefined);
        yield {
          type: "text_delta",
          text: "saw tool-flow",
        };
      }

      yield {
        type: "done",
      };
    },
  };
  const loop = new MinimalAgentLoop({
    model,
    tools: createCodingToolExecutor({
      workspaceRoot,
    }),
  });

  const result = await loop.run({
    userText: "read fixture",
    systemPrompt: "Use tools.",
    history: [],
    tools: getCodingToolSchemas(),
    maxSteps: 3,
  });

  assert.equal(result.reason, "completed");
  assert.equal(requests.length, 2);
}

async function createWorkspace(prefix) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(workspaceRoot, { recursive: true });
  return workspaceRoot;
}

async function writeRuntimeActivationProtocolMarker(workspaceRoot, options) {
  const controllerPath = join(workspaceRoot, "src", "evolution", "controller.ts");
  await mkdir(join(workspaceRoot, "src", "evolution"), { recursive: true });
  const source = options.safe
    ? [
        "export const marker = 'confirmPendingRuntimeActivation';",
        "export const pending = { confirmationRequired: true };",
        "export const audit = 'runtime_code.version_trial_started';",
      ].join("\n")
    : [
        "export const audit = 'runtime_code.version_activated';",
        "export function writeActiveRuntimeVersion() {}",
      ].join("\n");
  await writeFile(controllerPath, `${source}\n`, "utf8");
}

function slackEvent(eventId, text, messageTs) {
  return {
    type: "direct_message",
    eventId,
    conversation: sessionKey(),
    senderUserId: "U1",
    text,
    messageTs,
    files: [],
    receivedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function sessionKey() {
  return {
    teamId: "T1",
    channelId: "D1",
  };
}

async function appendContext(store, record) {
  await store.appendContextRecord(sessionKey(), {
    type: "context_message",
    schemaVersion: 1,
    createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    ...record,
  });
}

class FakeSlackApprovalPublisher {
  constructor() {
    this.events = [];
    this.nextTs = 1;
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

    return {
      conversation: event.reaction.conversation,
      messageTs: event.reaction.messageTs,
    };
  }
}

function readApprovalId(event) {
  assert.equal(event.type, "message.post");
  const actions = event.draft.blocks.find((block) => block.type === "actions");
  assert.notEqual(actions, undefined);
  return actions.elements[0].value;
}

function approvalAction(approvalId, actionId, userId) {
  return {
    type: "block_actions",
    user: { id: userId },
    actions: [
      {
        action_id: actionId,
        value: approvalId,
      },
    ],
  };
}

function blockText(blocks) {
  return blocks
    .flatMap((block) => {
      if (block.text?.text !== undefined) {
        return [block.text.text];
      }
      if (Array.isArray(block.elements)) {
        return block.elements
          .map((element) => element.text)
          .filter((text) => typeof text === "string");
      }
      return [];
    })
    .join("\n");
}

async function isSettled(promise) {
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 10)),
  ]);
}

async function waitFor(predicate, options = {}) {
  const attempts = options.attempts ?? 100;
  const delayMs = options.delayMs ?? 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error("Timed out waiting for condition");
}

async function waitForAsync(predicate, options = {}) {
  const attempts = options.attempts ?? 100;
  const delayMs = options.delayMs ?? 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error("Timed out waiting for async condition");
}

async function childApprovalRequestFiles(runDir) {
  return readdir(join(runDir, "approvals")).then(
    (entries) => entries.filter((entry) => entry.endsWith(".request.json")),
    () => [],
  );
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
