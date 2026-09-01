import * as path from "node:path";
import { validateStartupConfig } from "./app/config";
import { ConsoleJsonLogger, errorFields } from "./app/logging";
import {
  calculateUsage,
  JsonlUsageRecorder,
  usagePricingForRuntimeModel,
} from "./app/usage";
import { MinimalAgentLoop } from "./agent/agent-loop";
import {
  isAgentStopCommand,
  PerChannelAgentRunner,
} from "./agent/runner";
import type { SlackUserId } from "./core/ids";
import type { SlackEvent } from "./core/slack";
import { SlackSocketModeAdapter } from "./slack/client";
import { SlackToolApprovalBroker } from "./slack/approval";
import { SlackAttachmentDownloader } from "./slack/attachments";
import { SlackHistoryBackfiller } from "./slack/backfill";
import { InMemoryChannelQueue } from "./slack/queue";
import {
  createCodingToolExecutor,
  FileToolApprovalRuleStore,
  createToolApprovalGate,
  getCodingToolSchemas,
  toolApprovalRulesForRun,
  type CodingToolExecutorOptions,
  type ToolApprovalMode,
} from "./tools";
import { createLlmSessionCompactor } from "./workspace/compaction";
import { ContextManager } from "./workspace/context-manager";
import { ChannelRepoWorkflow } from "./workspace/repo";
import {
  createSandboxExecutor,
  type SandboxExecutor,
} from "./workspace/sandbox";
import { WorkspaceSessionStore } from "./workspace/session";
import { MemoryCurationPipeline } from "./workspace/memory-curation";
import {
  FileChannelWorkspaceStore,
  type WorkspaceStoreWarning,
} from "./workspace/store";
import {
  createTraceApprovalObserver,
  JsonlTraceRecorder,
  TraceRuntimeHook,
} from "./runtime/trace";
import {
  configureAgentRuntimeState,
  createToolPlanApprovalRequester,
  RuntimeModeHook,
} from "./runtime/mode";
import { FileTaskStore } from "./workspace/tasks";
import { FileChildAgentRunStore } from "./workspace/child-agents";
import { ChildAgentRuntime } from "./runtime/child-agents";
import { FileChildAgentApprovalResponder } from "./runtime/child-agent-approvals";
import { createRuntimeWorldStateProvider } from "./runtime/world-state";
import {
  defaultChildAgentCommandTemplate,
  TmuxChildAgentSupervisor,
} from "./runtime/tmux-agents";
import { SessionEvolutionContextRecorder } from "./evolution/channel-context";
import { EvolutionController } from "./evolution/controller";
import { FileEvolutionStore } from "./evolution/store";
import { createRuntimeCodeActivationController } from "./evolution/runtime-activation";
import {
  resolveConversationTitleModelName,
  WebAgentRunner,
} from "./web/agent";
import { FileWebConversationStore } from "./web/conversations";
import { startWebUiServer } from "./web/server";
import { WorkflowOrchestrator } from "./workflow/orchestrator";
import {
  ChildWorkflowScheduler,
  childWorkflowExternalKeyPrefix,
  formatChildWorkflowParentResume,
} from "./workflow/child-scheduler";
import {
  formatTaskGraphParentResume,
  TaskGraphScheduler,
  taskGraphExternalKeyPrefix,
} from "./workflow/task-scheduler";
import { FileWorkflowStore } from "./workflow/store";
import { createConfiguredModelClient } from "./models/runtime";
import { formatModelRef } from "./models/types";
import { AgentRuntime } from "./runtime/agent-runtime";
import { FileDurableLifecycleAuthority } from "./runtime/durable-lifecycle";

async function main(): Promise<void> {
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd();
  const storeRoot = process.env.PIBOT_STORE_ROOT ?? path.join(workspaceRoot, ".pibot");
  const persistentApprovalRules = new FileToolApprovalRuleStore({
    rootDir: storeRoot,
  });
  const pibotSkillsRoot = path.join(storeRoot, "skills");
  const configuredModelClient = await createConfiguredModelClient({ storeRoot });
  const modelRuntime = configuredModelClient.runtime;
  const model = configuredModelClient.client;
  const configuredModel = modelRuntime.activeModelRef().model;
  const titleModelName = resolveConversationTitleModelName(
    configuredModel,
    readOptionalEnv("PIBOT_TITLE_MODEL"),
  );
  const modelContextWindowTokens =
    readPositiveIntegerEnv("MODEL_CONTEXT_WINDOW_TOKENS") ??
    modelRuntime.minimumKnownContextWindow(defaultModelContextWindowTokens());
  const sessionCompactionReserveTokens =
    readPositiveIntegerEnv("SESSION_COMPACTION_RESERVE_TOKENS") ?? 32768;
  const contextManager = new ContextManager({
    toolResultAdmission: {
      thresholdChars:
        readPositiveIntegerEnv("TOOL_RESULT_CONTEXT_THRESHOLD_CHARS") ?? 8_192,
      headChars:
        readNonNegativeIntegerEnv("TOOL_RESULT_CONTEXT_HEAD_CHARS") ?? 4_096,
      tailChars:
        readNonNegativeIntegerEnv("TOOL_RESULT_CONTEXT_TAIL_CHARS") ?? 1_024,
    },
    ...((readBooleanEnv("SESSION_MICROCOMPACT_ENABLED") ?? true)
      ? {
          microcompact: {
            contextWindowTokens: modelContextWindowTokens,
            reserveTokens: sessionCompactionReserveTokens,
            protectRecentTokens:
              readNonNegativeIntegerEnv(
                "SESSION_MICROCOMPACT_PROTECT_RECENT_TOKENS",
              ) ?? 12_000,
            minReclaimTokens:
              readPositiveIntegerEnv("SESSION_MICROCOMPACT_MIN_RECLAIM_TOKENS") ??
              512,
            maxItems:
              readPositiveIntegerEnv("SESSION_MICROCOMPACT_MAX_ITEMS") ?? 12,
            warmCacheTtlMs:
              readPositiveIntegerEnv(
                "SESSION_MICROCOMPACT_WARM_CACHE_TTL_MS",
              ) ?? 300_000,
          },
        }
      : {}),
  });
  const sandbox = createSandboxExecutorFromEnv(workspaceRoot);
  const approvalMode = readToolApprovalModeEnv();
  const approvalTimeoutMs =
    readPositiveIntegerEnv("TOOL_APPROVAL_TIMEOUT_MS") ?? 300000;
  const codingToolLimits = codingToolLimitsFromEnv();
  const modelCredential = modelRuntime.credentialRequirement();
  await validateStartupConfig({
    slackAppToken: process.env.SLACK_APP_TOKEN,
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    modelApiKey: modelCredential.configured ? "configured" : undefined,
    modelApiKeyEnvVar:
      modelCredential.apiKeyEnv ?? `provider ${modelCredential.provider} credential`,
    workspaceRoot,
    sandboxLabel: sandbox.label,
  });

  const logger = new ConsoleJsonLogger();
  const webUiHost = readOptionalEnv("PIBOT_WEBUI_HOST") ?? "0.0.0.0";
  const webUiPort = readPositiveIntegerEnv("PIBOT_WEBUI_PORT") ?? 8787;
  const webUiPublicUrl =
    readOptionalEnv("PIBOT_WEBUI_PUBLIC_URL") ??
    browserUrlFor(webUiHost, webUiPort);
  const webUiEnabled = readBooleanEnv("PIBOT_WEBUI_ENABLED") === true;
  const slackBotToken = requiredEnv("SLACK_BOT_TOKEN");
  let shouldBypassQueue = (event: SlackEvent) =>
    isAgentStopCommand(event.text);
  const adapter = new SlackSocketModeAdapter(
    {
      appToken: requiredEnv("SLACK_APP_TOKEN"),
      botToken: slackBotToken,
      shouldBypassQueue: (event) => shouldBypassQueue(event),
      staleEventGraceMs: readNonNegativeIntegerEnv("SLACK_EVENT_GRACE_MS") ?? 5000,
      ...optionalBotUserId(process.env.SLACK_BOT_USER_ID),
    },
    new InMemoryChannelQueue(),
  );
  const approvalBroker = new SlackToolApprovalBroker(adapter);
  adapter.setInteractiveHandler(approvalBroker);
  const childAgentApprovalResponder = new FileChildAgentApprovalResponder({
    rootDir: storeRoot,
    prompter: approvalBroker,
    pollIntervalMs:
      readPositiveIntegerEnv("CHILD_AGENT_APPROVAL_POLL_INTERVAL_MS") ?? 1000,
    shouldHandleRequest: (request) =>
      request.context.conversation.teamId !== "webui",
    onError: (error) => {
      logger.warn("child_agent_approval_responder_failed", errorFields(error));
    },
  });
  childAgentApprovalResponder.start();
  const approvalGate = createToolApprovalGate(approvalMode);
  const workspaceStore = new FileChannelWorkspaceStore({
    rootDir: storeRoot,
    onWarning: logWorkspaceWarning,
    maxLogFileBytes:
      readPositiveIntegerEnv("SESSION_MAX_LOG_FILE_BYTES") ?? 2_000_000,
    maxContextFileBytes:
      readPositiveIntegerEnv("SESSION_MAX_CONTEXT_FILE_BYTES") ?? 10_000_000,
    maxMemoryFileBytes:
      readPositiveIntegerEnv("SESSION_MAX_MEMORY_FILE_BYTES") ?? 64_000,
    maxMemoryIndexFileBytes:
      readPositiveIntegerEnv("SESSION_MAX_MEMORY_INDEX_FILE_BYTES") ?? 8_000,
    maxMemoryAuditFileBytes:
      readPositiveIntegerEnv("SESSION_MAX_MEMORY_AUDIT_FILE_BYTES") ?? 2_000_000,
    maxMemoryUsageFileBytes:
      readPositiveIntegerEnv("SESSION_MAX_MEMORY_USAGE_FILE_BYTES") ?? 2_000_000,
    maxMemoryCurationJobFileBytes:
      readPositiveIntegerEnv("SESSION_MAX_MEMORY_CURATION_JOB_FILE_BYTES") ?? 256_000,
  });
  const memoryCurator =
    (readBooleanEnv("MEMORY_CURATION_ENABLED") ?? true)
      ? new MemoryCurationPipeline({
          store: workspaceStore,
          model,
          resolveModelRef: () => modelRuntime.activeModelRef(),
          maxOutputTokens:
            readPositiveIntegerEnv("MEMORY_CURATION_MAX_OUTPUT_TOKENS") ?? 5000,
          maxEvidenceChars:
            readPositiveIntegerEnv("MEMORY_CURATION_MAX_EVIDENCE_CHARS") ?? 30_000,
          requestTimeoutMs:
            readPositiveIntegerEnv("MEMORY_CURATION_TIMEOUT_MS") ?? 60_000,
        })
      : undefined;
  const recoveredMemoryCurationJobs = await memoryCurator?.recoverPending() ?? 0;
  if (recoveredMemoryCurationJobs > 0) {
    logger.info("memory_curation_jobs_recovered", {
      count: recoveredMemoryCurationJobs,
    });
  }
  const workflows = new WorkflowOrchestrator({
    store: new FileWorkflowStore({
      rootDir: path.join(storeRoot, "workflows"),
    }),
    defaultBudget: {
      maxTotalAttempts:
        readPositiveIntegerEnv("WORKFLOW_MAX_TOTAL_ATTEMPTS") ?? 4,
      maxAttemptsPerStep:
        readPositiveIntegerEnv("WORKFLOW_MAX_ATTEMPTS_PER_STEP") ?? 4,
      maxCallsPerEdge:
        readPositiveIntegerEnv("WORKFLOW_MAX_CALLS_PER_EDGE") ?? 3,
    },
    circuitThreshold:
      readPositiveIntegerEnv("WORKFLOW_CIRCUIT_THRESHOLD") ?? 3,
    circuitCooldownMs:
      readPositiveIntegerEnv("WORKFLOW_CIRCUIT_COOLDOWN_MS") ?? 300000,
  });
  const sessionStore = new WorkspaceSessionStore({
    store: workspaceStore,
    contextManager,
    ...(memoryCurator === undefined ? {} : { memoryCurator }),
    compactor: createLlmSessionCompactor({
      contextWindowTokens: modelContextWindowTokens,
      reserveTokens: sessionCompactionReserveTokens,
      keepRecentTokens:
        readPositiveIntegerEnv("SESSION_COMPACTION_KEEP_RECENT_TOKENS") ?? 20000,
      model,
    }),
  });
  const evolutionContext = new SessionEvolutionContextRecorder(sessionStore);
  const evolutionController = new EvolutionController({
    store: new FileEvolutionStore({
      rootDir: path.join(storeRoot, "evolution"),
    }),
    publicBaseUrl: webUiPublicUrl,
    context: evolutionContext,
  });
  const runtimeActivation = createRuntimeCodeActivationController({
    workspaceRoot,
    logger,
    enabled: readBooleanEnv("PIBOT_EVOLUTION_RESTART_ENABLED") ?? true,
    command: readOptionalEnv("PIBOT_EVOLUTION_RESTART_COMMAND"),
    terminalSupervisor:
      readBooleanEnv("PIBOT_WEBUI_TERMINAL_SUPERVISOR") === true,
    restartMarkerPath:
      readOptionalEnv("PIBOT_EVOLUTION_RESTART_MARKER") ??
      path.join(storeRoot, "runtime-activation", "restart-request.json"),
    label: readOptionalEnv("PIBOT_EVOLUTION_RESTART_LABEL"),
    delayMs: readNonNegativeIntegerEnv("PIBOT_EVOLUTION_RESTART_DELAY_MS"),
  });
  const repoWorkflow = new ChannelRepoWorkflow({
    workspaceRoot,
    store: workspaceStore,
    sandboxExecutor: sandbox.executor,
    maxCheckTimeoutMs: codingToolLimits.maxShellTimeoutMs,
    ...optionalRepoConfigFromEnv(),
  });
  const usageRecorder = new JsonlUsageRecorder({
    filePath: path.join(storeRoot, "usage.jsonl"),
  });
  const usagePricing = usagePricingForRuntimeModel(modelRuntime);
  const traceRecorder = new JsonlTraceRecorder({
    filePath: path.join(storeRoot, "trace.jsonl"),
    maxFileBytes:
      readPositiveIntegerEnv("PIBOT_TRACE_MAX_FILE_BYTES") ?? 20_000_000,
  });
  const traceHook = new TraceRuntimeHook({
    recorder: traceRecorder,
    contextBudget: {
      contextWindowTokens: modelContextWindowTokens,
      reserveTokens: sessionCompactionReserveTokens,
    },
    calculateCost: (usage, selected) => {
      const calculated = calculateUsage(
        usage,
        usagePricingForRuntimeModel(
          modelRuntime,
          selected.provider,
          selected.model,
        ),
      );
      return {
        cost: calculated.cost,
        currency: calculated.currency,
        cacheHitRatio: calculated.cacheHitRatio,
        cacheSavings: calculated.cacheSavings,
        uncachedInputCost: calculated.uncachedInputCost,
        cachedInputCost: calculated.cachedInputCost,
        outputCost: calculated.outputCost,
      };
    },
  });
  const attachmentDownloader = new SlackAttachmentDownloader({
    botToken: slackBotToken,
    store: workspaceStore,
    maxAttachmentBytes:
      readPositiveIntegerEnv("SLACK_MAX_ATTACHMENT_BYTES") ?? 5_000_000,
    downloadTimeoutMs:
      readPositiveIntegerEnv("SLACK_ATTACHMENT_DOWNLOAD_TIMEOUT_MS") ?? 30000,
  });
  const tools = createCodingToolExecutor({
    workspaceRoot,
    pibotSkillsRoot,
    sandboxExecutor: sandbox.executor,
    approvalGate,
    evolution: {
      submitManualSignal: (input) => evolutionController.submitManualSignal(input),
      source: "slack_user",
      actor: "slack",
    },
    ...codingToolLimits,
  });
  const childAgentStore = new FileChildAgentRunStore({
    store: workspaceStore,
  });
  const childAgentSupervisor = new TmuxChildAgentSupervisor({
    commandTemplate:
      readOptionalEnv("PIBOT_CHILD_AGENT_COMMAND") ??
      defaultChildAgentCommandTemplate(),
    ...optionalString("tmuxPath", readOptionalEnv("PIBOT_TMUX_PATH")),
    ...optionalString(
      "socketPath",
      readOptionalEnv("PIBOT_TMUX_SOCKET_PATH"),
    ),
    defaultCaptureLines:
      readPositiveIntegerEnv("CHILD_AGENT_CAPTURE_LINES") ?? 120,
    defaultCaptureMaxChars:
      readPositiveIntegerEnv("CHILD_AGENT_CAPTURE_MAX_CHARS") ?? 20000,
  });
  const durableLifecycle = new FileDurableLifecycleAuthority({
    rootDir: path.join(storeRoot, "runtime-lifecycle"),
  });
  const lifecycleRecovery = await durableLifecycle.recoverInterrupted();
  if (lifecycleRecovery.recoveredRuns > 0) {
    logger.warn("runtime_lifecycle_recovered", {
      recoveredRuns: lifecycleRecovery.recoveredRuns,
      interruptedTurns: lifecycleRecovery.interruptedTurns,
      interruptedSteps: lifecycleRecovery.interruptedSteps,
      interruptedTools: lifecycleRecovery.interruptedTools,
    });
  }
  const agentRuntime = new AgentRuntime({ durability: durableLifecycle });
  const handler = new PerChannelAgentRunner({
    runtime: agentRuntime,
    slack: adapter,
    agentLoop: new MinimalAgentLoop({
      model,
      tools,
      contextManager,
      hooks: [traceHook],
    }),
    createAgentLoopForWorkspace: (
      runWorkspaceRoot,
      approvalContext,
      runContext,
      workspaceSkills,
      runtimeControl,
    ) => {
      const taskStore = new FileTaskStore({
        workspaceRoot: runWorkspaceRoot,
      });
      configureAgentRuntimeState(runContext.state, {
        taskStore,
        planApproval: createToolPlanApprovalRequester({
          prompter: approvalBroker,
          context: approvalContext,
          timeoutMs: approvalTimeoutMs,
          onDecision: createTraceApprovalObserver(traceRecorder, runContext),
        }),
      });
      const childAgents = new ChildAgentRuntime({
        key: {
          teamId: approvalContext.conversation.teamId,
          channelId: approvalContext.conversation.channelId,
        },
        parentRunId: runContext.runId,
        workspaceRoot: runWorkspaceRoot,
        store: childAgentStore,
        supervisor: childAgentSupervisor,
        approvalContext,
        maxConcurrent:
          readPositiveIntegerEnv("CHILD_AGENT_MAX_CONCURRENT") ?? 20,
        defaultTimeoutMs:
          readPositiveIntegerEnv("CHILD_AGENT_DEFAULT_TIMEOUT_MS") ?? 900000,
        maxTimeoutMs:
          readPositiveIntegerEnv("CHILD_AGENT_MAX_TIMEOUT_MS") ?? 1800000,
        defaultMaxToolCalls:
          readPositiveIntegerEnv("CHILD_AGENT_MAX_TOOL_CALLS") ?? 40,
        defaultMaxTokens:
          readPositiveIntegerEnv("CHILD_AGENT_MAX_TOKENS") ?? 120000,
      });
      const conversationKey =
        `${approvalContext.conversation.teamId}:${approvalContext.conversation.channelId}`;
      const childScheduler = new ChildWorkflowScheduler({
        workflows,
        childAgents,
        parentAgentRunId: runContext.runId,
        externalKeyPrefix: childWorkflowExternalKeyPrefix({
          workspaceRoot: runWorkspaceRoot,
          conversationKey,
        }),
        metadata: {
          transport: "slack",
          teamId: approvalContext.conversation.teamId,
          channelId: approvalContext.conversation.channelId,
        },
        parentResume: {
          acquireHold: ({ workflowRunId }) =>
            runtimeControl.deferRunCompletion(
              `coordinator_child:${workflowRunId}`,
            ),
          enqueue: (event) =>
            runtimeControl.enqueueRuntimeFollowUp(
              formatChildWorkflowParentResume(event),
            ),
        },
      });
      const taskScheduler = new TaskGraphScheduler({
        taskStore,
        workflows,
        externalKeyPrefix: taskGraphExternalKeyPrefix({
          workspaceRoot: runWorkspaceRoot,
          conversationKey,
        }),
        metadata: {
          transport: "slack",
          teamId: approvalContext.conversation.teamId,
          channelId: approvalContext.conversation.channelId,
        },
        parentResume: {
          acquireHold: ({ graphVersion, tasksDigest }) =>
            runtimeControl.deferRunCompletion(
              `task_graph:v${graphVersion}:${tasksDigest}`,
            ),
          enqueue: (event) =>
            runtimeControl.enqueueRuntimeFollowUp(
              formatTaskGraphParentResume(event),
            ),
        },
        createChildRuntime: (workflowRunId) => new ChildAgentRuntime({
          key: {
            teamId: approvalContext.conversation.teamId,
            channelId: approvalContext.conversation.channelId,
          },
          parentRunId: workflowRunId,
          workspaceRoot: runWorkspaceRoot,
          store: childAgentStore,
          supervisor: childAgentSupervisor,
          approvalContext,
          maxConcurrent:
            readPositiveIntegerEnv("CHILD_AGENT_MAX_CONCURRENT") ?? 20,
          defaultTimeoutMs:
            readPositiveIntegerEnv("CHILD_AGENT_DEFAULT_TIMEOUT_MS") ?? 900000,
          maxTimeoutMs:
            readPositiveIntegerEnv("CHILD_AGENT_MAX_TIMEOUT_MS") ?? 1800000,
          defaultMaxToolCalls:
            readPositiveIntegerEnv("CHILD_AGENT_MAX_TOOL_CALLS") ?? 40,
          defaultMaxTokens:
            readPositiveIntegerEnv("CHILD_AGENT_MAX_TOKENS") ?? 120000,
        }),
      });
      const taskSchedulerReady = taskScheduler.resumeFrozenGraph().catch((error: unknown) => {
        logger.warn("task_graph_resume_failed", errorFields(error));
      });
      const runTools = createCodingToolExecutor({
        workspaceRoot: runWorkspaceRoot,
        pibotSkillsRoot,
        skills: workspaceSkills,
        sandboxExecutor: sandbox.executor,
        runtime: runContext.state,
        tasks: taskStore,
        childAgents,
        childScheduler,
        taskScheduler,
        attach: {
          publisher: adapter,
          conversation: approvalContext.conversation,
          maxFileBytes:
            readPositiveIntegerEnv("ATTACH_MAX_FILE_BYTES") ??
            codingToolLimits.maxFileBytes,
        },
        memory: {
          store: workspaceStore,
          key: {
            teamId: approvalContext.conversation.teamId,
            channelId: approvalContext.conversation.channelId,
          },
          source: {
            type: "agent_tool",
            runId: runContext.runId,
            userId: approvalContext.requestedByUserId,
          },
        },
        evolution: {
          submitManualSignal: (input) => evolutionController.submitManualSignal(input),
          source: "slack_user",
          actor: "slack",
        },
        approvalGate: createToolApprovalGate(approvalMode, {
          prompter: approvalBroker,
          context: approvalContext,
          rules: toolApprovalRulesForRun(runContext.state),
          persistentRules: persistentApprovalRules,
          workspaceRoot: runWorkspaceRoot,
          timeoutMs: approvalTimeoutMs,
          onDecision: createTraceApprovalObserver(traceRecorder, runContext),
        }),
        ...codingToolLimits,
      });
      return new MinimalAgentLoop({
        model,
        contextManager,
        hooks: [
          {
            beforeModelCall: async () => {
              await taskSchedulerReady;
            },
          },
          new RuntimeModeHook({
            state: runContext.state,
            describeTool: (name) => runTools.describeTool(name),
            worldState: createRuntimeWorldStateProvider({
              workspaceRoot: runWorkspaceRoot,
              sandboxLabel: sandbox.label,
              sandboxPolicy: sandbox.executor.policy,
              sandboxEnforcement: sandbox.executor.enforcement,
              approvalMode,
              pendingApprovalCount: () =>
                approvalBroker.pendingApprovalCount(approvalContext.conversation),
              childAgents,
            }),
          }),
          traceHook,
        ],
        tools: runTools,
      });
    },
    resolveChannelWorkspaceRoot: async (key) =>
      (await workspaceStore.ensureChannelDirectory(key)).channelDir,
    sessions: sessionStore,
    tools: getCodingToolSchemas(),
    maxSteps:
      readPositiveIntegerEnv("AGENT_MAX_STEPS") ??
      readPositiveIntegerEnv("AGENT_MAX_TURNS") ??
      80,
    maxParallelToolCalls:
      readPositiveIntegerEnv("AGENT_MAX_PARALLEL_TOOL_CALLS") ?? 8,
    resolveModelRef: () => modelRuntime.activeModelRef(),
    maxContextOverflowRetries:
      readNonNegativeIntegerEnv("SESSION_COMPACTION_MAX_OVERFLOW_RETRIES") ?? 1,
    longTaskStatusUpdateMs:
      readPositiveIntegerEnv("LONG_TASK_STATUS_UPDATE_MS") ?? 30000,
    disabledSkills: readCsvEnv("SKILLS_DISABLED"),
    maxSkills: readPositiveIntegerEnv("SKILLS_MAX_COUNT") ?? 100,
    maxSkillFileBytes:
      readPositiveIntegerEnv("SKILLS_MAX_FILE_BYTES") ?? 64_000,
    pibotSkillsRoot,
    reflection: {
      enabled: readBooleanEnv("REFLECTION_ENABLED") ?? false,
      maxFixAttempts:
        readNonNegativeIntegerEnv("REFLECTION_MAX_FIX_ATTEMPTS") ?? 2,
      maxSteps:
        readPositiveIntegerEnv("REFLECTION_MAX_STEPS") ??
        readPositiveIntegerEnv("REFLECTION_MAX_TURNS") ??
        readPositiveIntegerEnv("AGENT_MAX_STEPS") ??
        readPositiveIntegerEnv("AGENT_MAX_TURNS") ??
        80,
      verifyCommands: readCsvEnv("REFLECTION_VERIFY_COMMANDS"),
    },
    repoWorkflow,
    attachmentDownloader,
    logger,
    usageRecorder,
    usagePricing,
    resolveUsagePricing: (provider, selectedModel) =>
      usagePricingForRuntimeModel(
        modelRuntime,
        provider,
        selectedModel,
      ),
    traceRecorder,
    evolution: evolutionController,
    agentSelfInstructionsProvider: () =>
      evolutionController.readCurrentSelfInstructions(),
    thinkingLanguage: readOptionalEnv("PIBOT_THINKING_LANGUAGE") ?? "zh-CN",
  });
  if (webUiEnabled) {
    const conversations = new FileWebConversationStore(storeRoot);
    await startWebUiServer({
      host: webUiHost,
      port: webUiPort,
      publicUrl: webUiPublicUrl,
      workspaceRoot,
      logger,
      evolution: evolutionController,
      evolutionContext,
      runtimeActivation,
      conversations,
      models: modelRuntime,
      workflows,
      pibotSkillsRoot,
      disabledSkills: readCsvEnv("SKILLS_DISABLED"),
      maxSkills: readPositiveIntegerEnv("SKILLS_MAX_COUNT") ?? 100,
      maxSkillFileBytes:
        readPositiveIntegerEnv("SKILLS_MAX_FILE_BYTES") ?? 64_000,
      titleEmptyRetryMs:
        readPositiveIntegerEnv("PIBOT_TITLE_EMPTY_RETRY_MS") ?? 300_000,
      agent: new WebAgentRunner({
        contextManager,
        runtime: agentRuntime,
        conversations,
        workspaceRoot,
        store: workspaceStore,
        sessions: sessionStore,
        repoWorkflow: new ChannelRepoWorkflow({
          workspaceRoot,
          store: workspaceStore,
          sandboxExecutor: sandbox.executor,
          useGlobalConfig: false,
        }),
        model,
        tools: getCodingToolSchemas(),
        sandboxExecutor: sandbox.executor,
        sandboxLabel: sandbox.label,
        toolApprovalMode: approvalMode,
        approvalRules: persistentApprovalRules,
        toolLimits: codingToolLimits,
        childAgents: {
          store: childAgentStore,
          supervisor: childAgentSupervisor,
          approvalRootDir: storeRoot,
          approvalPollIntervalMs:
            readPositiveIntegerEnv("CHILD_AGENT_APPROVAL_POLL_INTERVAL_MS") ??
            1000,
          onApprovalError: (error) => {
            logger.warn("child_agent_approval_responder_failed", errorFields(error));
          },
          maxConcurrent:
            readPositiveIntegerEnv("CHILD_AGENT_MAX_CONCURRENT") ?? 20,
          defaultTimeoutMs:
            readPositiveIntegerEnv("CHILD_AGENT_DEFAULT_TIMEOUT_MS") ?? 900000,
          maxTimeoutMs:
            readPositiveIntegerEnv("CHILD_AGENT_MAX_TIMEOUT_MS") ?? 1800000,
          defaultMaxToolCalls:
            readPositiveIntegerEnv("CHILD_AGENT_MAX_TOOL_CALLS") ?? 40,
          defaultMaxTokens:
            readPositiveIntegerEnv("CHILD_AGENT_MAX_TOKENS") ?? 120000,
        },
        evolution: evolutionController,
        workflows,
        maxSteps:
          readPositiveIntegerEnv("AGENT_MAX_STEPS") ??
          readPositiveIntegerEnv("AGENT_MAX_TURNS") ??
          80,
        maxParallelToolCalls:
          readPositiveIntegerEnv("AGENT_MAX_PARALLEL_TOOL_CALLS") ?? 8,
        resolveModelRef: () => modelRuntime.activeModelRef(),
        runtimeHooks: [traceHook],
        disabledSkills: readCsvEnv("SKILLS_DISABLED"),
        maxSkills: readPositiveIntegerEnv("SKILLS_MAX_COUNT") ?? 100,
        maxSkillFileBytes:
          readPositiveIntegerEnv("SKILLS_MAX_FILE_BYTES") ?? 64_000,
        pibotSkillsRoot,
        ...(titleModelName === undefined ? {} : { titleModelName }),
      }),
    });
  }
  shouldBypassQueue = (event) => handler.shouldBypassSlackQueue(event);
  logger.info("startup_ready", {
    workspace: workspaceRoot,
    store: storeRoot,
    sandbox: sandbox.label,
    model: formatModelRef(modelRuntime.activeModelRef()),
    webui: webUiEnabled ? webUiPublicUrl : "disabled",
  });

  await runStartupBackfill({
    botToken: slackBotToken,
    sessions: sessionStore,
    logger,
  });

  await adapter.startSlackMessageSource(handler);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

function readCsvEnv(name: string): readonly string[] {
  return (readOptionalEnv(name) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function readBooleanEnv(name: string): boolean | undefined {
  const value = readOptionalEnv(name)?.toLowerCase();
  if (value === undefined) {
    return undefined;
  }
  if (value === "1" || value === "true" || value === "yes") {
    return true;
  }
  if (value === "0" || value === "false" || value === "no") {
    return false;
  }

  throw new Error(`${name} must be a boolean`);
}

function readPositiveIntegerEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function defaultModelContextWindowTokens(): number {
  return 262_144;
}

function readNonNegativeIntegerEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return parsed;
}

function codingToolLimitsFromEnv(): Required<Pick<
  CodingToolExecutorOptions,
  | "maxReadChars"
  | "maxFileBytes"
  | "maxCommandOutputChars"
  | "maxGrepMatches"
  | "maxGrepOutputChars"
  | "defaultShellTimeoutMs"
  | "maxShellTimeoutMs"
>> {
  return {
    maxReadChars: readPositiveIntegerEnv("TOOL_MAX_READ_CHARS") ?? 20000,
    maxFileBytes: readPositiveIntegerEnv("TOOL_MAX_FILE_BYTES") ?? 1_000_000,
    maxCommandOutputChars:
      readPositiveIntegerEnv("TOOL_MAX_COMMAND_OUTPUT_CHARS") ?? 20000,
    maxGrepMatches: readPositiveIntegerEnv("TOOL_MAX_GREP_MATCHES") ?? 200,
    maxGrepOutputChars:
      readPositiveIntegerEnv("TOOL_MAX_GREP_OUTPUT_CHARS") ?? 2_000_000,
    defaultShellTimeoutMs:
      readPositiveIntegerEnv("BASH_DEFAULT_TIMEOUT_MS") ?? 120000,
    maxShellTimeoutMs:
      readPositiveIntegerEnv("BASH_MAX_TIMEOUT_MS") ?? 600000,
  };
}

function readToolApprovalModeEnv(): ToolApprovalMode {
  const value = readOptionalEnv("TOOL_APPROVAL_MODE") ?? "read-only";
  if (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "approval-required" ||
    value === "full-access"
  ) {
    return value;
  }

  throw new Error(
    "TOOL_APPROVAL_MODE must be one of: read-only, workspace-write, approval-required, full-access",
  );
}

function optionalBotUserId(
  value: string | undefined,
): { readonly botUserId: SlackUserId } | object {
  if (value === undefined || value.length === 0) {
    return {};
  }

  return { botUserId: value as SlackUserId };
}

function optionalString<Key extends string>(
  key: Key,
  value: string | undefined,
): { readonly [Property in Key]: string } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: string;
  };
}

function optionalRepoConfigFromEnv():
  | { readonly defaultConfig: { readonly repoPath: string; readonly checkCommand?: string } }
  | object {
  const repoPath = process.env.REPO_PATH;
  if (repoPath === undefined || repoPath.length === 0) {
    return {};
  }

  const checkCommand = process.env.REPO_CHECK_COMMAND;
  return {
    defaultConfig: {
      repoPath,
      ...(checkCommand !== undefined && checkCommand.length > 0
        ? { checkCommand }
        : {}),
    },
  };
}

async function runStartupBackfill(options: {
  readonly botToken: string;
  readonly sessions: WorkspaceSessionStore;
  readonly logger: ConsoleJsonLogger;
}): Promise<void> {
  if (isFalseyEnv(process.env.SLACK_BACKFILL_ENABLED)) {
    options.logger.info("slack_backfill_skipped", {
      reason: "disabled",
    });
    return;
  }

  try {
    const backfiller = new SlackHistoryBackfiller({
      botToken: options.botToken,
      ...optionalBotUserId(process.env.SLACK_BOT_USER_ID),
      sessions: options.sessions,
      maxChannels: readPositiveIntegerEnv("SLACK_BACKFILL_MAX_CHANNELS") ?? 20,
      maxMessagesPerChannel:
        readPositiveIntegerEnv("SLACK_BACKFILL_MAX_MESSAGES_PER_CHANNEL") ?? 50,
      channelTypes:
        process.env.SLACK_BACKFILL_CHANNEL_TYPES ??
        "public_channel,private_channel,im",
    });
    const result = await backfiller.run();
    options.logger.info("slack_backfill_completed", {
      channelsScanned: result.channelsScanned,
      messagesScanned: result.messagesScanned,
      recordedUserMessages: result.recordedUserMessages,
      skippedUserMessages: result.skippedUserMessages,
      syncedUserMessages: result.syncedUserMessages,
    });
  } catch (error: unknown) {
    options.logger.warn("slack_backfill_failed", errorFields(error));
  }
}

function browserUrlFor(host: string, port: number): string {
  if (host === "0.0.0.0" || host === "::") {
    return `http://127.0.0.1:${port}`;
  }
  return `http://${host}:${port}`;
}

function createSandboxExecutorFromEnv(workspaceRoot: string): {
  readonly executor: SandboxExecutor;
  readonly label: string;
} {
  const executorKind = process.env.SANDBOX_EXECUTOR;
  if (executorKind === undefined || executorKind.length === 0) {
    return {
      executor: createSandboxExecutor(),
      label: "host(disabled)",
    };
  }

  if (executorKind === "host") {
    const enabled = isTruthyEnv(process.env.SANDBOX_HOST_ENABLED);
    return {
      executor: createSandboxExecutor({
        kind: "host",
        enabled,
      }),
      label: enabled ? "host(enabled)" : "host(disabled)",
    };
  }

  if (executorKind === "docker") {
    const containerName = requiredEnv("SANDBOX_DOCKER_CONTAINER");
    const containerWorkspaceRoot =
      process.env.SANDBOX_DOCKER_WORKSPACE_ROOT ?? workspaceRoot;
    const dockerPath = process.env.SANDBOX_DOCKER_PATH;

    return {
      executor: createSandboxExecutor({
        kind: "docker",
        containerName,
        hostWorkspaceRoot: workspaceRoot,
        containerWorkspaceRoot,
        ...(dockerPath !== undefined && dockerPath.length > 0 ? { dockerPath } : {}),
      }),
      label: `docker(${containerName}:${containerWorkspaceRoot})`,
    };
  }

  if (executorKind === "linux-native") {
    const launcherPath = readOptionalEnv("SANDBOX_LINUX_LAUNCHER_PATH");
    return {
      executor: createSandboxExecutor({
        kind: "linux-native",
        ...(launcherPath === undefined ? {} : { launcherPath }),
        ...optionalLinuxNativeSandboxLimitsFromEnv(),
      }),
      label: `linux-native(${launcherPath ?? "default-launcher"})`,
    };
  }

  throw new Error("SANDBOX_EXECUTOR must be one of: host, docker, linux-native");
}

function optionalLinuxNativeSandboxLimitsFromEnv(): {
  readonly maxProcesses?: number;
  readonly maxOpenFiles?: number;
  readonly maxFileSizeBytes?: number;
  readonly maxMemoryBytes?: number;
} {
  const maxProcesses = readPositiveIntegerEnv("SANDBOX_LINUX_MAX_PROCESSES");
  const maxOpenFiles = readPositiveIntegerEnv("SANDBOX_LINUX_MAX_OPEN_FILES");
  const maxFileSizeBytes = readPositiveIntegerEnv(
    "SANDBOX_LINUX_MAX_FILE_SIZE_BYTES",
  );
  const maxMemoryBytes = readPositiveIntegerEnv("SANDBOX_LINUX_MAX_MEMORY_BYTES");

  return {
    ...(maxProcesses === undefined ? {} : { maxProcesses }),
    ...(maxOpenFiles === undefined ? {} : { maxOpenFiles }),
    ...(maxFileSizeBytes === undefined ? {} : { maxFileSizeBytes }),
    ...(maxMemoryBytes === undefined ? {} : { maxMemoryBytes }),
  };
}

function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  return value === "1" || value.toLowerCase() === "true" || value === "yes";
}

function isFalseyEnv(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  return value === "0" || value.toLowerCase() === "false" || value === "no";
}

function logWorkspaceWarning(warning: WorkspaceStoreWarning): void {
  const location =
    warning.lineNumber === undefined
      ? warning.filePath
      : `${warning.filePath}:${warning.lineNumber}`;
  console.warn(
    `[pibot] workspace warning ${warning.code} at ${location}: ${warning.message}`,
  );
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(String(error));
  }

  process.exitCode = 1;
});
