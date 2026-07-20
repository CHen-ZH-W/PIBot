import type { LlmMessage } from "../core/agent";
import { isStopCommandText } from "../core/commands";
import type { SlackEventId } from "../core/ids";
import type { ModelClient, ModelUsage } from "../agent/model";
import type { JsonObject } from "./store";

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface CompactableContextEntry {
  readonly lineNumber: number;
  readonly message: LlmMessage;
  readonly source: "slack_log" | "webui" | "agent" | "compaction";
  readonly eventId?: SlackEventId;
  readonly isCompactionSummary: boolean;
  readonly coveredThroughLineNumber?: number;
}

export interface SessionCompactionOptions {
  readonly contextWindowTokens: number;
  readonly reserveTokens: number;
  readonly keepRecentTokens: number;
}

export interface SessionCompactionResult {
  readonly triggered: boolean;
  readonly reason: SessionCompactionReason;
  readonly estimatedTokensBefore: number;
  readonly estimatedTokensAfter?: number;
  readonly compactionTriggerTokens: number;
  readonly keepRecentTokens: number;
  readonly keptRecentTokens?: number;
  readonly keptRecentMessages?: number;
  readonly coveredThroughLineNumber?: number;
  readonly summaryStrategy?: SessionSummaryStrategy;
  readonly summaryUsage?: ModelUsage;
  readonly fallbackReason?: string;
  readonly summaryRecord?: JsonObject;
}

export interface SessionCompactionStart {
  readonly reason: SessionCompactionReason;
  readonly estimatedTokensBefore: number;
  readonly compactionTriggerTokens: number;
  readonly keepRecentTokens: number;
  readonly coveredThroughLineNumber: number;
}

export type SessionCompactionReason = "threshold" | "context_overflow";
export type SessionSummaryStrategy = "heuristic" | "llm" | "heuristic_fallback";

export interface SessionCompactionRequest {
  readonly force?: boolean;
  readonly reason?: SessionCompactionReason;
  readonly signal?: AbortSignal;
  readonly onCompactionStart?: (
    event: SessionCompactionStart,
  ) => Promise<void> | void;
}

export interface SessionCompactor {
  maybeCompact(
    entries: readonly CompactableContextEntry[],
    createdAt: Date,
    request?: SessionCompactionRequest,
  ): SessionCompactionResult | Promise<SessionCompactionResult>;
}

interface SummaryFacts {
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly progress: readonly string[];
  readonly decisions: readonly string[];
  readonly readFiles: readonly string[];
  readonly modifiedFiles: readonly string[];
  readonly fileOperations: readonly string[];
  readonly nextSteps: readonly string[];
}

interface NormalizedSessionCompactionOptions {
  readonly contextWindowTokens: number;
  readonly reserveTokens: number;
  readonly compactionTriggerTokens: number;
  readonly keepRecentTokens: number;
}

interface SessionCompactionPlan {
  readonly reason: SessionCompactionReason;
  readonly estimatedTokensBefore: number;
  readonly coveredThroughLineNumber: number;
  readonly oldEntries: readonly CompactableContextEntry[];
  readonly recentEntries: readonly CompactableContextEntry[];
}

/**
 * 职责：基于已有 context 估算 token，并在超过阈值时生成 append-only summary record。
 * 不应承担：读写 JSONL、调用模型、删除旧消息、实现 session tree/fork。
 */
export class HeuristicSessionCompactor implements SessionCompactor {
  private readonly options: NormalizedSessionCompactionOptions;

  constructor(options: SessionCompactionOptions) {
    this.options = normalizeCompactionOptions(options);
  }

  async maybeCompact(
    entries: readonly CompactableContextEntry[],
    createdAt: Date,
    request: SessionCompactionRequest = {},
  ): Promise<SessionCompactionResult> {
    const plan = createCompactionPlan(entries, this.options, request);
    if (plan === undefined) {
      return noCompactionResult(entries, this.options, request);
    }

    await notifyCompactionStart(plan, this.options, request);
    return buildCompactionResult(
      plan,
      this.options,
      renderSummary(extractSummaryFacts(plan.oldEntries)),
      createdAt,
      { strategy: "heuristic" },
    );
  }
}

export interface LlmSessionCompactionOptions extends SessionCompactionOptions {
  readonly model: ModelClient;
  readonly modelName?: string;
}

export class LlmSessionCompactor implements SessionCompactor {
  private readonly options: NormalizedSessionCompactionOptions;
  private readonly maxOutputTokens: number;

  constructor(private readonly llmOptions: LlmSessionCompactionOptions) {
    this.options = normalizeCompactionOptions(llmOptions);
    this.maxOutputTokens = maxSummaryOutputTokens(this.options.reserveTokens);
  }

  async maybeCompact(
    entries: readonly CompactableContextEntry[],
    createdAt: Date,
    request: SessionCompactionRequest = {},
  ): Promise<SessionCompactionResult> {
    const plan = createCompactionPlan(entries, this.options, request);
    if (plan === undefined) {
      return noCompactionResult(entries, this.options, request);
    }

    await notifyCompactionStart(plan, this.options, request);
    try {
      const generated = await generateLlmSummary(
        this.llmOptions.model,
        this.llmOptions.modelName,
        this.maxOutputTokens,
        plan.oldEntries,
        this.options.compactionTriggerTokens * 4,
        request.signal,
      );
      return buildCompactionResult(
        plan,
        this.options,
        renderSummary(generated.facts),
        createdAt,
        {
          strategy: "llm",
          ...(generated.usage === undefined ? {} : { usage: generated.usage }),
        },
      );
    } catch (error: unknown) {
      return buildCompactionResult(
        plan,
        this.options,
        renderSummary(extractSummaryFacts(plan.oldEntries)),
        createdAt,
        {
          strategy: "heuristic_fallback",
          fallbackReason:
            error instanceof Error ? error.message : "Unknown LLM compaction failure",
        },
      );
    }
  }
}

export function createSessionCompactor(
  options: SessionCompactionOptions,
): SessionCompactor {
  return new HeuristicSessionCompactor(options);
}

export function createLlmSessionCompactor(
  options: LlmSessionCompactionOptions,
): SessionCompactor {
  return new LlmSessionCompactor(options);
}

function normalizeCompactionOptions(
  options: SessionCompactionOptions,
): NormalizedSessionCompactionOptions {
  const contextWindowTokens = positiveInteger(
    options.contextWindowTokens,
    "contextWindowTokens",
  );
  const reserveTokens = nonNegativeInteger(options.reserveTokens, "reserveTokens");
  if (reserveTokens >= contextWindowTokens) {
    throw new Error("reserveTokens must be less than contextWindowTokens");
  }

  const compactionTriggerTokens = contextWindowTokens - reserveTokens;
  const keepRecentTokens = positiveInteger(
    options.keepRecentTokens,
    "keepRecentTokens",
  );
  if (keepRecentTokens >= compactionTriggerTokens) {
    throw new Error("keepRecentTokens must be less than compaction trigger tokens");
  }

  return {
    contextWindowTokens,
    reserveTokens,
    compactionTriggerTokens,
    keepRecentTokens,
  };
}

function maxSummaryOutputTokens(reserveTokens: number): number {
  return positiveInteger(
    Math.floor(reserveTokens * 0.8),
    "summary max output tokens",
  );
}

function createCompactionPlan(
  entries: readonly CompactableContextEntry[],
  options: NormalizedSessionCompactionOptions,
  request: SessionCompactionRequest,
): SessionCompactionPlan | undefined {
  const estimatedTokensBefore = estimateContextTokens(entries);
  if (
    request.force !== true &&
    estimatedTokensBefore <= options.compactionTriggerTokens
  ) {
    return undefined;
  }

  const { oldEntries, recentEntries } = splitEntriesForCompaction(
    entries,
    options.keepRecentTokens,
  );
  const coveredThroughLineNumber =
    oldEntries[oldEntries.length - 1]?.lineNumber;
  if (coveredThroughLineNumber === undefined) {
    return undefined;
  }

  return {
    reason: request.reason ?? "threshold",
    estimatedTokensBefore,
    coveredThroughLineNumber,
    oldEntries,
    recentEntries,
  };
}

function noCompactionResult(
  entries: readonly CompactableContextEntry[],
  options: NormalizedSessionCompactionOptions,
  request: SessionCompactionRequest,
): SessionCompactionResult {
  return {
    triggered: false,
    reason: request.reason ?? "threshold",
    estimatedTokensBefore: estimateContextTokens(entries),
    compactionTriggerTokens: options.compactionTriggerTokens,
    keepRecentTokens: options.keepRecentTokens,
  };
}

async function notifyCompactionStart(
  plan: SessionCompactionPlan,
  options: NormalizedSessionCompactionOptions,
  request: SessionCompactionRequest,
): Promise<void> {
  try {
    await request.onCompactionStart?.({
      reason: plan.reason,
      estimatedTokensBefore: plan.estimatedTokensBefore,
      compactionTriggerTokens: options.compactionTriggerTokens,
      keepRecentTokens: options.keepRecentTokens,
      coveredThroughLineNumber: plan.coveredThroughLineNumber,
    });
  } catch {
    // UI progress callbacks are best-effort; compaction itself should continue.
  }
}

function buildCompactionResult(
  plan: SessionCompactionPlan,
  options: NormalizedSessionCompactionOptions,
  rawSummaryContent: string,
  createdAt: Date,
  summary: {
    readonly strategy: SessionSummaryStrategy;
    readonly usage?: ModelUsage;
    readonly fallbackReason?: string;
  },
): SessionCompactionResult {
  const summaryContent = rawSummaryContent;
  const estimatedTokensAfter = estimateMessagesTokens([
    {
      role: "user",
      content: summaryContent,
    },
    ...plan.recentEntries.map((entry) => entry.message),
  ]);
  const keptRecentTokens = estimateContextTokens(plan.recentEntries);
  return {
    triggered: true,
    reason: plan.reason,
    estimatedTokensBefore: plan.estimatedTokensBefore,
    estimatedTokensAfter,
    compactionTriggerTokens: options.compactionTriggerTokens,
    keepRecentTokens: options.keepRecentTokens,
    keptRecentTokens,
    keptRecentMessages: plan.recentEntries.length,
    coveredThroughLineNumber: plan.coveredThroughLineNumber,
    summaryStrategy: summary.strategy,
    ...(summary.usage === undefined ? {} : { summaryUsage: summary.usage }),
    ...(summary.fallbackReason === undefined
      ? {}
      : { fallbackReason: summary.fallbackReason }),
    summaryRecord: {
      type: "context_message",
      schemaVersion: 1,
      role: "user",
      content: summaryContent,
      source: "compaction",
      compactionKind: "session_summary",
      compactionReason: plan.reason,
      summaryStrategy: summary.strategy,
      ...(summary.usage === undefined
        ? {}
        : { summaryUsage: modelUsageToJson(summary.usage) }),
      ...(summary.fallbackReason === undefined
        ? {}
        : { fallbackReason: truncateLine(summary.fallbackReason, 500) }),
      coveredThroughLineNumber: plan.coveredThroughLineNumber,
      originalMessageCount: plan.oldEntries.length,
      contextWindowTokens: options.contextWindowTokens,
      reserveTokens: options.reserveTokens,
      compactionTriggerTokens: options.compactionTriggerTokens,
      keepRecentTokens: options.keepRecentTokens,
      keptRecentTokens,
      keptRecentMessages: plan.recentEntries.length,
      estimatedTokensBefore: plan.estimatedTokensBefore,
      estimatedTokensAfter,
      createdAt: createdAt.toISOString(),
    },
  };
}

async function generateLlmSummary(
  model: ModelClient,
  modelName: string | undefined,
  maxOutputTokens: number,
  entries: readonly CompactableContextEntry[],
  maxSourceChars: number,
  signal: AbortSignal | undefined,
): Promise<{ readonly facts: SummaryFacts; readonly usage?: ModelUsage }> {
  const transcript = truncateMiddle(renderCompactionTranscript(entries), maxSourceChars);
  let content = "";
  let usage: ModelUsage | undefined;
  for await (const event of model.stream(
    {
      ...(modelName === undefined ? {} : { model: modelName }),
      maxOutputTokens,
      tools: [],
      messages: [
        {
          role: "system",
          content: [
            "Summarize an agent transcript as strict JSON only.",
            "Preserve durable facts and unresolved work. Do not invent facts.",
            "Return an object with exactly these fields:",
            '{"goal":"string","constraints":["string"],"progress":["string"],"decisions":["string"],"nextSteps":["string"],"readFiles":["string"],"modifiedFiles":["string"],"fileOperations":["string"]}',
          ].join("\n"),
        },
        {
          role: "user",
          content: transcript,
        },
      ],
    },
    signal,
  )) {
    if (event.type === "text_delta") {
      content += event.text;
    } else if (event.type === "done") {
      usage = event.usage ?? usage;
    } else if (event.type === "error") {
      throw new Error(`LLM compaction failed: ${event.error.message}`);
    } else if (event.type === "tool_call") {
      throw new Error("LLM compaction returned an unexpected tool call");
    }
  }
  return {
    facts: parseLlmSummaryFacts(content),
    ...(usage === undefined ? {} : { usage }),
  };
}

function renderCompactionTranscript(
  entries: readonly CompactableContextEntry[],
): string {
  return entries.map((entry) => {
    const toolCalls =
      entry.message.toolCalls === undefined
        ? ""
        : `\ntoolCalls=${JSON.stringify(entry.message.toolCalls)}`;
    return `[line=${entry.lineNumber} role=${entry.message.role}]\n${entry.message.content}${toolCalls}`;
  }).join("\n\n");
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const marker = "\n\n[older transcript middle truncated]\n\n";
  const sideChars = Math.max(0, Math.floor((maxChars - marker.length) / 2));
  return `${value.slice(0, sideChars)}${marker}${value.slice(-sideChars)}`;
}

function parseLlmSummaryFacts(content: string): SummaryFacts {
  const normalized = content
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  const parsed = parseJsonObject(normalized);
  if (parsed === null) {
    throw new Error("LLM compaction response must be a JSON object");
  }
  const goal = readString(parsed, "goal");
  if (goal === undefined || goal.trim().length === 0) {
    throw new Error("LLM compaction response needs a non-empty goal");
  }
  return {
    goal: truncateLine(goal, 500),
    constraints: readSummaryList(parsed, "constraints", 8),
    progress: readSummaryList(parsed, "progress", 12),
    decisions: readSummaryList(parsed, "decisions", 12),
    nextSteps: readSummaryList(parsed, "nextSteps", 8),
    readFiles: readSummaryList(parsed, "readFiles", 30),
    modifiedFiles: readSummaryList(parsed, "modifiedFiles", 30),
    fileOperations: readSummaryList(parsed, "fileOperations", 40),
  };
}

function readSummaryList(
  record: UnknownRecord,
  key: string,
  maxItems: number,
): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`LLM compaction response needs ${key}[]`);
  }
  return uniqueList(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => truncateLine(item, 500)),
  ).slice(0, maxItems);
}

function modelUsageToJson(usage: ModelUsage): JsonObject {
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

export function estimateContextTokens(
  entries: readonly CompactableContextEntry[],
): number {
  return estimateMessagesTokens(entries.map((entry) => entry.message));
}

export function estimateMessagesTokens(messages: readonly LlmMessage[]): number {
  const chars = messages.reduce(
    (total, message) =>
      total +
      message.role.length +
      message.content.length +
      (message.reasoningContent?.length ?? 0) +
      (message.toolCallId?.length ?? 0) +
      JSON.stringify(message.toolCalls ?? []).length,
    0,
  );

  return Math.ceil(chars / 4);
}

function extractSummaryFacts(
  entries: readonly CompactableContextEntry[],
): SummaryFacts {
  const userMessages = entries
    .filter((entry) => entry.message.role === "user")
    .map((entry) => entry.message.content)
    .filter((content) => !isCompactionSummaryContent(content));
  const assistantMessages = entries
    .filter((entry) => entry.message.role === "assistant")
    .map((entry) => entry.message.content)
    .filter((content) => content.trim().length > 0);

  return {
    goal: pickGoal(userMessages),
    constraints: uniqueList(userMessages.flatMap(extractConstraintLines)).slice(0, 8),
    progress: uniqueList(assistantMessages.slice(-8).map((message) =>
      truncateLine(message, 500))).slice(0, 8),
    decisions: uniqueList(
      [...userMessages, ...assistantMessages].flatMap(extractDecisionLines),
    ).slice(0, 8),
    readFiles: uniqueList(entries.flatMap(extractReadFiles)).slice(0, 30),
    modifiedFiles: uniqueList(entries.flatMap(extractModifiedFiles)).slice(0, 30),
    fileOperations: uniqueList(entries.flatMap(extractFileOperations)).slice(0, 40),
    nextSteps: pickNextSteps(userMessages, assistantMessages),
  };
}

function splitEntriesForCompaction(
  entries: readonly CompactableContextEntry[],
  keepRecentTokens: number,
): {
  readonly oldEntries: readonly CompactableContextEntry[];
  readonly recentEntries: readonly CompactableContextEntry[];
} {
  let startIndex = entries.length;
  let recentTokens = 0;
  while (startIndex > 0 && recentTokens < keepRecentTokens) {
    startIndex -= 1;
    const entry = entries[startIndex];
    if (entry !== undefined) {
      recentTokens += estimateMessagesTokens([entry.message]);
    }
  }

  let changed = true;

  while (changed) {
    changed = false;
    const requiredAssistantToolCallIds = new Set<string>();
    for (const entry of entries.slice(startIndex)) {
      if (entry.message.role === "tool" && entry.message.toolCallId !== undefined) {
        requiredAssistantToolCallIds.add(entry.message.toolCallId);
      }
    }

    for (let index = startIndex - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry === undefined || entry.message.role !== "assistant") {
        continue;
      }

      const containsRequiredToolCall =
        entry.message.toolCalls?.some((toolCall) =>
          requiredAssistantToolCallIds.has(toolCall.id),
        ) === true;
      if (containsRequiredToolCall) {
        startIndex = index;
        changed = true;
        break;
      }
    }
  }

  return {
    oldEntries: entries.slice(0, startIndex),
    recentEntries: entries.slice(startIndex),
  };
}

function renderSummary(facts: SummaryFacts): string {
  return [
    "[SESSION COMPACTION SUMMARY]",
    "",
    "目标:",
    `- ${facts.goal}`,
    "",
    "约束:",
    ...renderList(facts.constraints, "未捕获明确约束。"),
    "",
    "进度:",
    ...renderList(facts.progress, "未捕获明确进度。"),
    "",
    "决策:",
    ...renderList(facts.decisions, "未捕获明确决策。"),
    "",
    "已读文件:",
    ...renderList(facts.readFiles, "未记录已读文件。"),
    "",
    "已改文件:",
    ...renderList(facts.modifiedFiles, "未记录已改文件。"),
    "",
    "文件操作:",
    ...renderList(facts.fileOperations, "未记录文件操作。"),
    "",
    "下一步:",
    ...renderList(facts.nextSteps, "继续根据最新用户消息推进。"),
  ].join("\n");
}

function renderList(values: readonly string[], emptyText: string): readonly string[] {
  if (values.length === 0) {
    return [`- ${emptyText}`];
  }

  return values.map((value) => `- ${value}`);
}

function pickGoal(userMessages: readonly string[]): string {
  const latest = [...userMessages].reverse().find((message) => {
    const trimmed = message.trim();
    return trimmed.length > 0 && !isLikelyStopCommand(trimmed);
  });

  return truncateLine(latest ?? "继续完成当前 coding task。", 500);
}

function extractConstraintLines(message: string): readonly string[] {
  return message
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) =>
      /(?:要求|必须|不要|不能|只|默认|需要|约束|范围|验收|must|should|do not|don't|only|require)/iu.test(
        line,
      ),
    )
    .map((line) => truncateLine(line, 300));
}

function extractDecisionLines(message: string): readonly string[] {
  return message
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) =>
      /(?:决定|选择|采用|结论|原因|decision|decide|choose|chosen|because)/iu.test(line))
    .map((line) => truncateLine(line, 500));
}

function pickNextSteps(
  userMessages: readonly string[],
  assistantMessages: readonly string[],
): readonly string[] {
  const steps: string[] = [];
  const latestUser = userMessages[userMessages.length - 1];
  if (latestUser !== undefined) {
    steps.push(`继续处理用户最近目标: ${truncateLine(latestUser, 300)}`);
  }

  const latestAssistant = assistantMessages[assistantMessages.length - 1];
  if (latestAssistant !== undefined) {
    steps.push(`参考最近 assistant 结论: ${truncateLine(latestAssistant, 300)}`);
  }

  steps.push("如需修改代码，先读相关文件，再使用精确 edit/write。");
  return uniqueList(steps).slice(0, 5);
}

function extractReadFiles(entry: CompactableContextEntry): readonly string[] {
  const files: string[] = [];

  if (entry.message.role === "assistant") {
    for (const toolCall of entry.message.toolCalls ?? []) {
      const input = parseJsonObject(toolCall.argumentsJson);
      if (input === null) {
        continue;
      }

      if (toolCall.name === "read") {
        pushStringField(files, input, "path");
      } else if (toolCall.name === "grep") {
        pushStringArrayField(files, input, "paths");
      }
    }
  }

  const toolPayload = parseToolPayload(entry.message);
  if (toolPayload !== null && toolPayload.ok === true) {
    const output = readRecord(toolPayload, "output");
    if (output !== undefined) {
      if (readString(output, "content") !== undefined) {
        pushStringField(files, output, "path");
      }

      const matches = output.matches;
      if (Array.isArray(matches)) {
        for (const match of matches) {
          if (isRecord(match)) {
            pushStringField(files, match, "path");
          }
        }
      }
    }
  }

  return files;
}

function extractModifiedFiles(entry: CompactableContextEntry): readonly string[] {
  const files: string[] = [];

  if (entry.message.role === "assistant") {
    for (const toolCall of entry.message.toolCalls ?? []) {
      const input = parseJsonObject(toolCall.argumentsJson);
      if (input === null) {
        continue;
      }

      if (toolCall.name === "edit" || toolCall.name === "write") {
        pushStringField(files, input, "path");
      }
    }
  }

  const toolPayload = parseToolPayload(entry.message);
  if (toolPayload !== null && toolPayload.ok === true) {
    const output = readRecord(toolPayload, "output");
    if (
      output !== undefined &&
      (readString(output, "beforeSha256") !== undefined ||
        readString(output, "afterSha256") !== undefined)
    ) {
      pushStringField(files, output, "path");
    }
  }

  return files;
}

function extractFileOperations(entry: CompactableContextEntry): readonly string[] {
  if (entry.message.role !== "assistant") {
    return [];
  }
  return (entry.message.toolCalls ?? []).flatMap((toolCall) => {
    const input = parseJsonObject(toolCall.argumentsJson);
    const path = input === null ? undefined : readString(input, "path");
    if (
      path === undefined ||
      !["read", "grep", "edit", "write"].includes(toolCall.name)
    ) {
      return [];
    }
    return [`${toolCall.name}: ${path}`];
  });
}

function parseToolPayload(message: LlmMessage): UnknownRecord | null {
  if (message.role !== "tool") {
    return null;
  }

  return parseJsonObject(message.content);
}

function truncateLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 14))} [truncated]`;
}

function uniqueList(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

function isCompactionSummaryContent(content: string): boolean {
  return content.startsWith("[SESSION COMPACTION SUMMARY]");
}

function isLikelyStopCommand(content: string): boolean {
  return isStopCommandText(content);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return value;
}

function pushStringField(
  values: string[],
  record: UnknownRecord,
  key: string,
): void {
  const value = readString(record, key);
  if (value !== undefined) {
    values.push(value);
  }
}

function pushStringArrayField(
  values: string[],
  record: UnknownRecord,
  key: string,
): void {
  const value = record[key];
  if (!Array.isArray(value)) {
    return;
  }

  for (const item of value) {
    if (typeof item === "string") {
      values.push(item);
    }
  }
}

function parseJsonObject(value: string): UnknownRecord | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch (_error: unknown) {
    return null;
  }
}

function readRecord(
  record: UnknownRecord,
  key: string,
): UnknownRecord | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function readString(
  record: UnknownRecord,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
