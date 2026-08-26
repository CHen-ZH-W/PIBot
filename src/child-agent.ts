import { appendFile, readFile, writeFile } from "node:fs/promises";
import { MinimalAgentLoop } from "./agent/agent-loop";
import {
  OpenAICompatibleProviderAdapter,
  RetryingModelClient,
  type ModelUsage,
} from "./agent/model";
import type {
  AgentRunId,
  AgentId,
  SlackChannelId,
  SlackMessageTs,
  SlackTeamId,
  SlackUserId,
} from "./core/ids";
import type { LlmToolSchema } from "./core/agent";
import type { ToolApprovalContext } from "./core/tools";
import type { AgentLoopEvent } from "./agent/events";
import { createAgentRunContext } from "./runtime/context";
import { FileChildAgentApprovalPrompter } from "./runtime/child-agent-approvals";
import {
  createAgentRuntimeState,
  RuntimeModeHook,
} from "./runtime/mode";
import {
  createCodingToolExecutor,
  createToolApprovalGate,
  getCodingToolSchemas,
  type CodingToolExecutorOptions,
  type ToolApprovalMode,
} from "./tools";
import {
  createSandboxExecutor,
  type SandboxExecutor,
} from "./workspace/sandbox";

interface ChildAgentEnv {
  readonly childRunId: AgentRunId;
  readonly parentRunId: AgentRunId;
  readonly role: string;
  readonly agentId: AgentId;
  readonly readOnly: boolean;
  readonly runDir: string;
  readonly taskFile: string;
  readonly statusFile: string;
  readonly transcriptFile: string;
  readonly resultFile: string;
  readonly usageFile: string;
  readonly workspaceRoot: string;
  readonly maxToolCalls: number;
  readonly maxTokens: number;
  readonly approvalContext?: ToolApprovalContext;
}

interface ChildAgentStats {
  toolCalls: number;
  usage: ModelUsage | undefined;
}

async function main(): Promise<void> {
  const env = readChildAgentEnv();
  const startedAt = Date.now();
  const stats: ChildAgentStats = {
    toolCalls: 0,
    usage: undefined,
  };
  await appendTranscript(env, {
    type: "builtin_child_agent.started",
    role: env.role,
    readOnly: env.readOnly,
  });

  try {
    const task = await readFile(env.taskFile, "utf8");
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
    const tools = createCodingToolExecutor({
      workspaceRoot: env.workspaceRoot,
      sandboxExecutor: sandboxExecutorFromEnv(env.workspaceRoot),
      approvalGate: createToolApprovalGate(
        childToolApprovalMode(env),
        childToolApprovalGateOptions(env),
      ),
      ...codingToolLimitsFromEnv(),
    });
    const runtime = createAgentRunContext({
      runId: env.childRunId,
      parentRunId: env.parentRunId,
      agentId: env.agentId,
      state: createAgentRuntimeState(),
    });
    const loop = new MinimalAgentLoop({
      model,
      tools,
      hooks: [
        new RuntimeModeHook({
          state: runtime.state,
          describeTool: (name) => tools.describeTool(name),
        }),
      ],
    });

    const result = await loop.run({
      userText: task,
      systemPrompt: childSystemPrompt(env),
      history: [],
      tools: childToolSchemas(env),
      maxSteps: childMaxSteps(env),
      runContext: runtime,
      ...optionalString("model", readOptionalEnv("OPENAI_MODEL")),
      ...optionalNumber("maxOutputTokens", env.maxTokens),
      onEvent: async (event) => {
        await handleChildAgentEvent(env, stats, event);
      },
    });
    stats.usage = result.usage;

    const finalText = finalAssistantText(result.messages);
    const resultMarkdown = [
      `# ${env.agentId} Result`,
      "",
      `- status: ${result.error === undefined ? result.reason : "error"}`,
      `- role: ${env.role}`,
      `- childRunId: ${env.childRunId}`,
      `- parentRunId: ${env.parentRunId}`,
      "",
      "## Summary",
      "",
      finalText.trim().length === 0 ? "(no final assistant text)" : finalText.trim(),
      ...(result.error === undefined
        ? []
        : [
            "",
            "## Error",
            "",
            `- code: ${result.error.code}`,
            `- message: ${result.error.message}`,
          ]),
    ].join("\n");
    await writeFile(env.resultFile, `${resultMarkdown}\n`, "utf8");
    await writeUsage(env, stats, Date.now() - startedAt);
    await appendTranscript(env, {
      type: "builtin_child_agent.finished",
      reason: result.reason,
      ...(result.error === undefined ? {} : { errorCode: result.error.code }),
    });

    if (result.error !== undefined) {
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    await writeFile(
      env.resultFile,
      [
        `# ${env.agentId} Result`,
        "",
        "## Error",
        "",
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        "",
      ].join("\n"),
      "utf8",
    );
    await writeUsage(env, stats, Date.now() - startedAt);
    await appendTranscript(env, {
      type: "builtin_child_agent.failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function childSystemPrompt(env: ChildAgentEnv): string {
  return [
    `You are ${env.agentId}, a focused child coding agent spawned by pibot.`,
    `Role: ${env.role}. Parent run: ${env.parentRunId}.`,
    `Workspace root: ${env.workspaceRoot}.`,
    env.readOnly
      ? "Permission: read-only by default. Inspect files and report findings. Shell commands require parent approval."
      : "Permission: elevated child execution. Stay within the assigned task and workspace boundaries.",
    "Treat the assigned task text as authoritative. The role is a coarse execution label, not a fixed functional objective.",
    "Write a concise final result with findings, evidence, risks, and recommended next steps.",
    "Do not mention internal environment variables unless they are directly relevant to debugging.",
  ].join("\n");
}

function childToolSchemas(env: ChildAgentEnv): readonly LlmToolSchema[] {
  const allowed = new Set(["read", "grep", "lsp"]);
  if (
    env.approvalContext !== undefined ||
    !env.readOnly ||
    readBooleanEnv("CHILD_AGENT_ALLOW_BASH") === true
  ) {
    allowed.add("bash");
  }
  if (!env.readOnly) {
    allowed.add("edit");
    allowed.add("write");
  }
  return getCodingToolSchemas().filter((tool) => allowed.has(tool.name));
}

export interface ChildAgentToolApprovalModeOptions {
  readonly readOnly: boolean;
  readonly hasApprovalContext?: boolean;
  readonly allowBash?: boolean;
  readonly configuredMode?: string;
}

export function resolveChildAgentToolApprovalMode(
  options: ChildAgentToolApprovalModeOptions,
): ToolApprovalMode {
  if (options.configuredMode !== undefined) {
    return parseToolApprovalMode(
      options.configuredMode,
      "CHILD_AGENT_TOOL_APPROVAL_MODE",
    );
  }
  if (!options.readOnly) {
    return "full-access";
  }
  if (options.hasApprovalContext === true) {
    return "approval-required";
  }
  if (options.allowBash === true) {
    return "full-access";
  }
  return "read-only";
}

function childToolApprovalMode(env: ChildAgentEnv): ToolApprovalMode {
  const configuredMode = readOptionalEnv("CHILD_AGENT_TOOL_APPROVAL_MODE");
  return resolveChildAgentToolApprovalMode({
    readOnly: env.readOnly,
    hasApprovalContext: env.approvalContext !== undefined,
    allowBash: readBooleanEnv("CHILD_AGENT_ALLOW_BASH") === true,
    ...optionalString("configuredMode", configuredMode),
  });
}

function childToolApprovalGateOptions(env: ChildAgentEnv) {
  if (env.approvalContext === undefined) {
    return {};
  }
  return {
    prompter: new FileChildAgentApprovalPrompter({
      runDir: env.runDir,
      pollIntervalMs:
        readPositiveIntegerEnv("CHILD_AGENT_APPROVAL_POLL_INTERVAL_MS") ?? 500,
    }),
    context: env.approvalContext,
    timeoutMs:
      readPositiveIntegerEnv("CHILD_AGENT_TOOL_APPROVAL_TIMEOUT_MS") ??
      readPositiveIntegerEnv("TOOL_APPROVAL_TIMEOUT_MS") ??
      300000,
  };
}

function childMaxSteps(env: ChildAgentEnv): number {
  return resolveChildAgentMaxSteps({
    ...optionalNumber(
      "configuredMaxSteps",
      readPositiveIntegerEnv("CHILD_AGENT_MAX_STEPS") ??
        readPositiveIntegerEnv("CHILD_AGENT_MAX_TURNS"),
    ),
    maxToolCalls: env.maxToolCalls,
  });
}

export function resolveChildAgentMaxSteps(options: {
  readonly configuredMaxSteps?: number;
  readonly maxToolCalls: number;
}): number {
  if (options.configuredMaxSteps !== undefined) {
    return Math.max(1, Math.floor(options.configuredMaxSteps));
  }
  return Math.max(1, Math.floor(options.maxToolCalls));
}

async function handleChildAgentEvent(
  env: ChildAgentEnv,
  stats: ChildAgentStats,
  event: AgentLoopEvent,
): Promise<void> {
  if (event.type === "message_delta") {
    process.stdout.write(event.text);
    return;
  }
  if (event.type === "tool_start") {
    stats.toolCalls += 1;
    console.log(`\n[${env.agentId}] tool_start ${event.call.name}`);
    await appendTranscript(env, {
      type: "tool_start",
      tool: event.call.name,
      callId: event.call.id,
    });
    return;
  }
  if (event.type === "tool_end") {
    console.log(`[${env.agentId}] tool_end ${event.call.name} ok=${event.result.ok}`);
    await appendTranscript(env, {
      type: "tool_end",
      tool: event.call.name,
      callId: event.call.id,
      ok: event.result.ok,
    });
    return;
  }
  if (event.type === "agent_end") {
    await appendTranscript(env, {
      type: "agent_end",
      reason: event.reason,
    });
  }
}

async function writeUsage(
  env: ChildAgentEnv,
  stats: ChildAgentStats,
  durationMs: number,
): Promise<void> {
  const usage = stats.usage;
  await writeFile(
    env.usageFile,
    `${JSON.stringify({
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
      toolCalls: stats.toolCalls,
      durationMs,
    }, null, 2)}\n`,
    "utf8",
  );
}

async function appendTranscript(
  env: ChildAgentEnv,
  event: Readonly<Record<string, unknown>>,
): Promise<void> {
  await appendFile(
    env.transcriptFile,
    `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`,
    "utf8",
  );
  await touchChildStatus(env);
}

async function touchChildStatus(env: ChildAgentEnv): Promise<void> {
  try {
    const current = JSON.parse(await readFile(env.statusFile, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      env.statusFile,
      `${JSON.stringify({
        ...current,
        updatedAt: new Date().toISOString(),
      }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // Status freshness is best-effort; transcript/result files remain canonical
    // for child output if the status file is temporarily unavailable.
  }
}

function finalAssistantText(messages: readonly { readonly role: string; readonly content: string }[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      return message.content;
    }
  }
  return "";
}

function readChildAgentEnv(): ChildAgentEnv {
  return {
    childRunId: requiredEnv("PIBOT_CHILD_RUN_ID") as AgentRunId,
    parentRunId: requiredEnv("PIBOT_PARENT_RUN_ID") as AgentRunId,
    role: requiredEnv("PIBOT_CHILD_ROLE"),
    agentId: requiredEnv("PIBOT_CHILD_AGENT_ID") as AgentId,
    readOnly: requiredEnv("PIBOT_CHILD_READ_ONLY") === "1",
    runDir: requiredEnv("PIBOT_CHILD_RUN_DIR"),
    taskFile: requiredEnv("PIBOT_TASK_FILE"),
    statusFile: requiredEnv("PIBOT_STATUS_FILE"),
    transcriptFile: requiredEnv("PIBOT_TRANSCRIPT_FILE"),
    resultFile: requiredEnv("PIBOT_RESULT_FILE"),
    usageFile: requiredEnv("PIBOT_USAGE_FILE"),
    workspaceRoot: requiredEnv("PIBOT_WORKSPACE_ROOT"),
    maxToolCalls:
      readPositiveIntegerEnv("PIBOT_CHILD_MAX_TOOL_CALLS") ?? 40,
    maxTokens:
      readPositiveIntegerEnv("PIBOT_CHILD_MAX_TOKENS") ?? 120000,
    ...optionalApprovalContext("approvalContext", readApprovalContextEnv()),
  };
}

function readApprovalContextEnv(): ToolApprovalContext | undefined {
  const teamId = readOptionalEnv("PIBOT_APPROVAL_TEAM_ID");
  const channelId = readOptionalEnv("PIBOT_APPROVAL_CHANNEL_ID");
  const requestedByUserId = readOptionalEnv("PIBOT_APPROVAL_REQUESTED_BY_USER_ID");
  if (
    teamId === undefined ||
    channelId === undefined ||
    requestedByUserId === undefined
  ) {
    return undefined;
  }
  return {
    conversation: {
      teamId: teamId as SlackTeamId,
      channelId: channelId as SlackChannelId,
      ...optionalThreadTs(readOptionalEnv("PIBOT_APPROVAL_THREAD_TS")),
    },
    requestedByUserId: requestedByUserId as SlackUserId,
  };
}

function sandboxExecutorFromEnv(workspaceRoot: string): SandboxExecutor {
  const kind = readOptionalEnv("CHILD_AGENT_SANDBOX_EXECUTOR") ??
    readOptionalEnv("SANDBOX_EXECUTOR") ??
    "disabled";
  if (kind === "disabled") {
    return createSandboxExecutor({ kind: "disabled" });
  }
  if (kind === "host") {
    return createSandboxExecutor({
      kind: "host",
      enabled:
        readBooleanEnv("CHILD_AGENT_SANDBOX_HOST_ENABLED") ??
        readBooleanEnv("SANDBOX_HOST_ENABLED") ??
        false,
    });
  }
  if (kind === "linux-native") {
    return createSandboxExecutor({
      kind: "linux-native",
      ...optionalString(
        "launcherPath",
        readOptionalEnv("SANDBOX_LINUX_LAUNCHER_PATH"),
      ),
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
    });
  }
  if (kind === "docker") {
    return createSandboxExecutor({
      kind: "docker",
      containerName: requiredEnv("SANDBOX_DOCKER_CONTAINER"),
      hostWorkspaceRoot: workspaceRoot,
      containerWorkspaceRoot:
        readOptionalEnv("SANDBOX_DOCKER_WORKSPACE_ROOT") ?? "/workspace",
      ...optionalString("dockerPath", readOptionalEnv("DOCKER_PATH")),
    });
  }
  throw new Error(
    "CHILD_AGENT_SANDBOX_EXECUTOR/SANDBOX_EXECUTOR must be one of: disabled, host, linux-native, docker",
  );
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

function parseToolApprovalMode(value: string, envName: string): ToolApprovalMode {
  if (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "approval-required" ||
    value === "full-access"
  ) {
    return value;
  }
  throw new Error(
    `${envName} must be one of: read-only, workspace-write, approval-required, full-access`,
  );
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

function optionalNumber<Key extends string>(
  key: Key,
  value: number | undefined,
): { readonly [Property in Key]: number } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: number;
  };
}

function optionalApprovalContext<Key extends string>(
  key: Key,
  value: ToolApprovalContext | undefined,
): { readonly [Property in Key]: ToolApprovalContext } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: ToolApprovalContext;
  };
}

function optionalThreadTs(
  value: string | undefined,
): { readonly threadTs: SlackMessageTs } | object {
  return value === undefined ? {} : { threadTs: value as SlackMessageTs };
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
