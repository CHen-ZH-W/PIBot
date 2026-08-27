import * as path from "node:path";
import { ConsoleJsonLogger, errorFields } from "./app/logging";
import {
  calculateUsage,
  defaultUsagePricingForModel,
  usagePricingFromEnv,
} from "./app/usage";
import {
  OpenAICompatibleProviderAdapter,
  RetryingModelClient,
} from "./agent/model";
import { SessionEvolutionContextRecorder } from "./evolution/channel-context";
import { EvolutionController } from "./evolution/controller";
import { createRuntimeCodeActivationController } from "./evolution/runtime-activation";
import { FileEvolutionStore } from "./evolution/store";
import {
  defaultChildAgentCommandTemplate,
  TmuxChildAgentSupervisor,
} from "./runtime/tmux-agents";
import { JsonlTraceRecorder, TraceRuntimeHook } from "./runtime/trace";
import { createCodingToolExecutor, getCodingToolSchemas, type CodingToolExecutorOptions, type ToolApprovalMode } from "./tools";
import { FileChildAgentRunStore } from "./workspace/child-agents";
import { createLlmSessionCompactor } from "./workspace/compaction";
import { ContextManager } from "./workspace/context-manager";
import { ChannelRepoWorkflow } from "./workspace/repo";
import { createSandboxExecutor, type SandboxExecutor } from "./workspace/sandbox";
import { WorkspaceSessionStore } from "./workspace/session";
import { FileChannelWorkspaceStore } from "./workspace/store";
import {
  resolveConversationTitleModelName,
  WebAgentRunner,
} from "./web/agent";
import { FileWebConversationStore } from "./web/conversations";
import { startWebUiServer } from "./web/server";
import { WorkflowOrchestrator } from "./workflow/orchestrator";
import { FileWorkflowStore } from "./workflow/store";

async function main(): Promise<void> {
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd();
  const storeRoot = process.env.PIBOT_STORE_ROOT ?? path.join(workspaceRoot, ".pibot");
  const pibotSkillsRoot = path.join(storeRoot, "skills");
  const host = process.env.PIBOT_WEBUI_HOST ?? "0.0.0.0";
  const port = readPositiveIntegerEnv("PIBOT_WEBUI_PORT") ?? 8787;
  const logger = new ConsoleJsonLogger();
  const configuredModel = readOptionalEnv("OPENAI_MODEL");
  const modelContextWindowTokens =
    readPositiveIntegerEnv("MODEL_CONTEXT_WINDOW_TOKENS") ??
    defaultModelContextWindowTokens();
  const sessionCompactionReserveTokens =
    readPositiveIntegerEnv("SESSION_COMPACTION_RESERVE_TOKENS") ?? 32768;
  const contextManager = new ContextManager({
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
  const titleModelName = resolveConversationTitleModelName(
    configuredModel,
    readOptionalEnv("PIBOT_TITLE_MODEL"),
  );
  const publicBaseUrl =
    process.env.PIBOT_WEBUI_PUBLIC_URL ?? browserUrlFor(host, port);
  const approvalTimeoutMs =
    readPositiveIntegerEnv("TOOL_APPROVAL_TIMEOUT_MS") ?? 300000;
  const sandbox = createSandboxExecutorFromEnv(workspaceRoot);
  const workspaceStore = new FileChannelWorkspaceStore({
    rootDir: storeRoot,
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
  });
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
  const conversations = new FileWebConversationStore(storeRoot);
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
  const model = new RetryingModelClient(
    new OpenAICompatibleProviderAdapter(),
    {
      maxRetries: readNonNegativeIntegerEnv("MODEL_MAX_RETRIES") ?? 2,
      fallbackModels: readCsvEnv("OPENAI_FALLBACK_MODELS"),
      baseRetryDelayMs:
        readPositiveIntegerEnv("MODEL_RETRY_BASE_DELAY_MS") ?? 500,
      maxRetryDelayMs:
        readPositiveIntegerEnv("MODEL_RETRY_MAX_DELAY_MS") ?? 8000,
    },
  );
  const sessionStore = new WorkspaceSessionStore({
    store: workspaceStore,
    contextManager,
    compactor: createLlmSessionCompactor({
      contextWindowTokens: modelContextWindowTokens,
      reserveTokens: sessionCompactionReserveTokens,
      keepRecentTokens:
        readPositiveIntegerEnv("SESSION_COMPACTION_KEEP_RECENT_TOKENS") ?? 20000,
      model,
      ...(process.env.OPENAI_MODEL === undefined ||
        process.env.OPENAI_MODEL.length === 0
        ? {}
        : { modelName: process.env.OPENAI_MODEL }),
    }),
  });
  const usagePricing = usagePricingFromEnv(
    defaultUsagePricingForModel(configuredModel, process.env.OPENAI_BASE_URL),
  );
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
    calculateCost: (usage) => {
      const calculated = calculateUsage(usage, usagePricing);
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
  const evolutionContext = new SessionEvolutionContextRecorder(sessionStore);
  const evolution = new EvolutionController({
    store: new FileEvolutionStore({
      rootDir: path.join(storeRoot, "evolution"),
    }),
    publicBaseUrl,
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
  await startWebUiServer({
    host,
    port,
    publicUrl: publicBaseUrl,
    workspaceRoot,
    logger,
    evolution,
    evolutionContext,
    runtimeActivation,
    conversations,
    workflows,
    pibotSkillsRoot,
    disabledSkills: readCsvEnv("SKILLS_DISABLED"),
    maxSkills: readPositiveIntegerEnv("SKILLS_MAX_COUNT") ?? 100,
    maxSkillFileBytes:
      readPositiveIntegerEnv("SKILLS_MAX_FILE_BYTES") ?? 64_000,
    titleEmptyRetryMs:
      readPositiveIntegerEnv("PIBOT_TITLE_EMPTY_RETRY_MS") ?? 300_000,
    agent: new WebAgentRunner({
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
      toolApprovalMode: readToolApprovalModeEnv(),
      approvalTimeoutMs,
      toolLimits: codingToolLimitsFromEnv(),
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
      evolution,
      workflows,
      maxSteps:
        readPositiveIntegerEnv("AGENT_MAX_STEPS") ??
        readPositiveIntegerEnv("AGENT_MAX_TURNS") ??
        80,
      maxParallelToolCalls:
        readPositiveIntegerEnv("AGENT_MAX_PARALLEL_TOOL_CALLS") ?? 8,
      runtimeHooks: [traceHook],
      disabledSkills: readCsvEnv("SKILLS_DISABLED"),
      maxSkills: readPositiveIntegerEnv("SKILLS_MAX_COUNT") ?? 100,
      maxSkillFileBytes:
        readPositiveIntegerEnv("SKILLS_MAX_FILE_BYTES") ?? 64_000,
      pibotSkillsRoot,
      thinkingLanguage: readOptionalEnv("PIBOT_THINKING_LANGUAGE") ?? "zh-CN",
      ...(configuredModel === undefined ? {} : { modelName: configuredModel }),
      ...(titleModelName === undefined ? {} : { titleModelName }),
    }),
  });
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

function optionalString<Key extends string>(
  key: Key,
  value: string | undefined,
): { readonly [Property in Key]: string } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: string;
  };
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

function defaultModelContextWindowTokens(): number {
  return 262144;
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
        ...optionalNumber(
          "maxProcesses",
          readPositiveIntegerEnv("SANDBOX_LINUX_MAX_PROCESSES"),
        ),
        ...optionalNumber(
          "maxOpenFiles",
          readPositiveIntegerEnv("SANDBOX_LINUX_MAX_OPEN_FILES"),
        ),
        ...optionalNumber(
          "maxFileSizeBytes",
          readPositiveIntegerEnv("SANDBOX_LINUX_MAX_FILE_SIZE_BYTES"),
        ),
        ...optionalNumber(
          "maxMemoryBytes",
          readPositiveIntegerEnv("SANDBOX_LINUX_MAX_MEMORY_BYTES"),
        ),
      }),
      label: "linux-native",
    };
  }

  throw new Error(
    "SANDBOX_EXECUTOR must be one of: linux-native, docker, host",
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return ["1", "true", "yes"].includes(value.toLowerCase());
}

function optionalNumber<Key extends string>(
  key: Key,
  value: number | undefined,
): { readonly [Property in Key]: number } | object {
  if (value === undefined) {
    return {};
  }

  return { [key]: value } as { readonly [Property in Key]: number };
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
