import type { LlmMessage } from "../core/agent";
import { isStopCommandText } from "../core/commands";
import type { SlackEventId } from "../core/ids";
import type { ModelClient, ModelUsage } from "../agent/model";
import type { JsonObject } from "./store";
import { ContextManager } from "./context-manager";

type UnknownRecord = Readonly<Record<string, unknown>>;
const CONTEXT_TOKEN_ESTIMATOR = new ContextManager();
const EXACT_USER_INTENT_HEADER_ESTIMATED_TOKENS = 64;

export interface CompactableContextEntry {
  readonly lineNumber: number;
  readonly message: LlmMessage;
  readonly source: "slack_log" | "webui" | "agent" | "compaction";
  readonly eventId?: SlackEventId;
  readonly isCompactionSummary: boolean;
  readonly coveredThroughLineNumber?: number;
  readonly summaryFacts?: SessionSummaryFacts;
  readonly summaryHierarchy?: SessionSummaryHierarchy;
}

export interface SessionSummaryHierarchy {
  readonly level: number;
  readonly parentSummaryLineNumbers: readonly number[];
  readonly sourceSummaryCount: number;
  readonly sourceMessageCount: number;
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
  readonly estimatedHistoryTokensBefore: number;
  readonly additionalInputTokens: number;
  readonly protectedUserIntentTokensBefore: number;
  readonly protectedUserIntentTokensAfter?: number;
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
  readonly summaryHierarchy?: SessionSummaryHierarchy;
}

export interface SessionCompactionStart {
  readonly reason: SessionCompactionReason;
  readonly estimatedTokensBefore: number;
  readonly estimatedHistoryTokensBefore: number;
  readonly additionalInputTokens: number;
  readonly protectedUserIntentTokensBefore: number;
  readonly compactionTriggerTokens: number;
  readonly keepRecentTokens: number;
  readonly coveredThroughLineNumber: number;
}

export type SessionCompactionReason = "threshold" | "context_overflow";
export type SessionSummaryStrategy = "heuristic" | "llm" | "heuristic_fallback";

export interface SessionCompactionRequest {
  readonly force?: boolean;
  readonly reason?: SessionCompactionReason;
  /** System messages, tool schemas and other request payload outside history. */
  readonly additionalInputTokens?: number;
  /** Never compact this entry or later entries into the checkpoint. */
  readonly preserveFromLineNumber?: number;
  /** Model-surface history after reversible pruning such as Microcompact. */
  readonly estimatedHistoryTokens?: number;
  /** Verbatim user messages that Full Compact is not allowed to summarize away. */
  readonly protectedUserIntentTokens?: number;
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

export interface SessionSummaryFacts {
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly exactUserConstraints: readonly string[];
  readonly technicalContext: readonly string[];
  readonly progress: readonly string[];
  readonly currentWork: readonly string[];
  readonly pendingTasks: readonly string[];
  readonly decisions: readonly string[];
  readonly attemptedApproaches: readonly string[];
  readonly errorsAndFixes: readonly string[];
  readonly readFiles: readonly string[];
  readonly modifiedFiles: readonly string[];
  readonly fileOperations: readonly string[];
  readonly currentCodeState: readonly string[];
  readonly verificationState: readonly string[];
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
  readonly estimatedHistoryTokensBefore: number;
  readonly additionalInputTokens: number;
  readonly protectedUserIntentTokensBefore: number;
  readonly protectedUserIntentTokensAfter: number;
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
      extractSummaryFacts(plan.oldEntries),
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
        mergeGeneratedSummaryFacts(
          extractDurableSummaryFacts(plan.oldEntries),
          extractCurrentSummaryFacts(plan.oldEntries),
          generated.facts,
        ),
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
        extractSummaryFacts(plan.oldEntries),
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
  const estimatedHistoryTokensBefore =
    request.estimatedHistoryTokens ?? estimateContextTokens(entries);
  const additionalInputTokens = normalizeAdditionalInputTokens(request);
  const protectedUserIntentTokensBefore =
    normalizeProtectedUserIntentTokens(request);
  const estimatedTokensBefore =
    estimatedHistoryTokensBefore + additionalInputTokens;
  if (
    request.force !== true &&
    estimatedTokensBefore <= options.compactionTriggerTokens
  ) {
    return undefined;
  }

  const { oldEntries, recentEntries } = splitEntriesForCompaction(
    entries,
    options.keepRecentTokens,
    request.preserveFromLineNumber,
  );
  const newlyCoveredEntries = oldEntries.filter(
    (entry) => !entry.isCompactionSummary,
  );
  const previousCoveredThroughLineNumber = Math.max(
    0,
    ...oldEntries
      .filter((entry) => entry.isCompactionSummary)
      .map((entry) => entry.coveredThroughLineNumber ?? 0),
  );
  const coveredThroughLineNumber = Math.max(
    previousCoveredThroughLineNumber,
    ...newlyCoveredEntries.map((entry) => entry.lineNumber),
  );
  if (
    coveredThroughLineNumber <= 0 ||
    (newlyCoveredEntries.length === 0 && request.force !== true)
  ) {
    return undefined;
  }
  const newlyProtectedUserTokens = estimateMessagesTokens(
    newlyCoveredEntries
      .filter((entry) => entry.message.role === "user")
      .map((entry) => entry.message),
  );
  const protectedUserIntentTokensAfter =
    protectedUserIntentTokensBefore +
    newlyProtectedUserTokens +
    (protectedUserIntentTokensBefore === 0 && newlyProtectedUserTokens > 0
      ? EXACT_USER_INTENT_HEADER_ESTIMATED_TOKENS
      : 0);

  return {
    reason: request.reason ?? "threshold",
    estimatedTokensBefore,
    estimatedHistoryTokensBefore,
    additionalInputTokens,
    protectedUserIntentTokensBefore,
    protectedUserIntentTokensAfter,
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
  const estimatedHistoryTokensBefore =
    request.estimatedHistoryTokens ?? estimateContextTokens(entries);
  const additionalInputTokens = normalizeAdditionalInputTokens(request);
  const protectedUserIntentTokensBefore =
    normalizeProtectedUserIntentTokens(request);
  return {
    triggered: false,
    reason: request.reason ?? "threshold",
    estimatedTokensBefore:
      estimatedHistoryTokensBefore + additionalInputTokens,
    estimatedHistoryTokensBefore,
    additionalInputTokens,
    protectedUserIntentTokensBefore,
    protectedUserIntentTokensAfter: protectedUserIntentTokensBefore,
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
      estimatedHistoryTokensBefore: plan.estimatedHistoryTokensBefore,
      additionalInputTokens: plan.additionalInputTokens,
      protectedUserIntentTokensBefore:
        plan.protectedUserIntentTokensBefore,
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
  facts: SessionSummaryFacts,
  createdAt: Date,
  summary: {
    readonly strategy: SessionSummaryStrategy;
    readonly usage?: ModelUsage;
    readonly fallbackReason?: string;
  },
): SessionCompactionResult {
  const summaryContent = renderSummary(facts);
  const hierarchy = createSummaryHierarchy(plan.oldEntries);
  const estimatedTokensAfter =
    estimateMessagesTokens([
      {
        role: "user",
        content: summaryContent,
      },
      ...plan.recentEntries.map((entry) => entry.message),
    ]) +
    plan.additionalInputTokens +
    plan.protectedUserIntentTokensAfter;
  const keptRecentTokens = estimateContextTokens(plan.recentEntries);
  return {
    triggered: true,
    reason: plan.reason,
    estimatedTokensBefore: plan.estimatedTokensBefore,
    estimatedHistoryTokensBefore: plan.estimatedHistoryTokensBefore,
    additionalInputTokens: plan.additionalInputTokens,
    protectedUserIntentTokensBefore: plan.protectedUserIntentTokensBefore,
    protectedUserIntentTokensAfter: plan.protectedUserIntentTokensAfter,
    estimatedTokensAfter,
    compactionTriggerTokens: options.compactionTriggerTokens,
    keepRecentTokens: options.keepRecentTokens,
    keptRecentTokens,
    keptRecentMessages: plan.recentEntries.length,
    coveredThroughLineNumber: plan.coveredThroughLineNumber,
    summaryStrategy: summary.strategy,
    summaryHierarchy: hierarchy,
    ...(summary.usage === undefined ? {} : { summaryUsage: summary.usage }),
    ...(summary.fallbackReason === undefined
      ? {}
      : { fallbackReason: summary.fallbackReason }),
    summaryRecord: {
      type: "context_message",
      schemaVersion: 2,
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
      estimatedHistoryTokensBefore: plan.estimatedHistoryTokensBefore,
      additionalInputTokens: plan.additionalInputTokens,
      protectedUserIntentTokensBefore: plan.protectedUserIntentTokensBefore,
      protectedUserIntentTokensAfter: plan.protectedUserIntentTokensAfter,
      estimatedTokensAfter,
      summaryFacts: summaryFactsToJson(facts),
      summaryHierarchy: summaryHierarchyToJson(hierarchy),
      createdAt: createdAt.toISOString(),
    },
  };
}

function createSummaryHierarchy(
  entries: readonly CompactableContextEntry[],
): SessionSummaryHierarchy {
  const parents = entries.filter((entry) => entry.isCompactionSummary);
  const parentLevels = parents.map((entry) => entry.summaryHierarchy?.level ?? 1);
  return {
    level: parentLevels.length === 0 ? 1 : Math.max(...parentLevels) + 1,
    parentSummaryLineNumbers: parents.map((entry) => entry.lineNumber),
    sourceSummaryCount: parents.length,
    sourceMessageCount: entries.length - parents.length,
  };
}

function normalizeAdditionalInputTokens(
  request: SessionCompactionRequest,
): number {
  return nonNegativeInteger(
    request.additionalInputTokens ?? 0,
    "additionalInputTokens",
  );
}

function normalizeProtectedUserIntentTokens(
  request: SessionCompactionRequest,
): number {
  return nonNegativeInteger(
    request.protectedUserIntentTokens ?? 0,
    "protectedUserIntentTokens",
  );
}

async function generateLlmSummary(
  model: ModelClient,
  modelName: string | undefined,
  maxOutputTokens: number,
  entries: readonly CompactableContextEntry[],
  maxSourceChars: number,
  signal: AbortSignal | undefined,
): Promise<{ readonly facts: SessionSummaryFacts; readonly usage?: ModelUsage }> {
  const transcript = renderCompactionTranscript(entries, maxSourceChars);
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
            "Previous checkpoint summaries are parent nodes. Recursively merge their durable facts with newer source regions instead of expanding old transcripts.",
            "Treat exactUserConstraints as verbatim user wording; do not paraphrase it.",
            "Keep failed attempts, current work and verification state distinct from completed progress.",
            "Return an object with exactly these fields:",
            '{"goal":"string","constraints":["string"],"exactUserConstraints":["string"],"technicalContext":["string"],"progress":["string"],"currentWork":["string"],"pendingTasks":["string"],"decisions":["string"],"attemptedApproaches":["string"],"errorsAndFixes":["string"],"nextSteps":["string"],"readFiles":["string"],"modifiedFiles":["string"],"fileOperations":["string"],"currentCodeState":["string"],"verificationState":["string"]}',
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
  maxChars: number,
): string {
  const regions = groupCompactionRegions(entries);
  const rendered = regions.map((region) => renderCompactionRegion(region));
  const complete = rendered.join("\n\n");
  if (complete.length <= maxChars) {
    return complete;
  }

  const markerBudget = 120;
  const firstBudget = Math.max(256, Math.floor((maxChars - markerBudget) * 0.4));
  const selected = new Map<number, string>();
  const first = rendered[0];
  if (first !== undefined) {
    selected.set(0, fitCompactionRegion(regions[0] ?? [], first, firstBudget));
  }

  let usedChars = [...selected.values()].reduce(
    (total, value) => total + value.length,
    0,
  );
  for (let index = regions.length - 1; index > 0; index -= 1) {
    const region = regions[index] ?? [];
    const value = rendered[index] ?? "";
    const remaining = maxChars - markerBudget - usedChars;
    if (remaining < 128) {
      break;
    }
    if (value.length <= remaining) {
      selected.set(index, value);
      usedChars += value.length;
      continue;
    }
    if (![...selected.keys()].some((selectedIndex) => selectedIndex > 0)) {
      const fitted = fitCompactionRegion(region, value, remaining);
      selected.set(index, fitted);
      usedChars += fitted.length;
    }
    break;
  }

  const projected = renderSelectedCompactionRegions(regions, selected);
  return projected.length <= maxChars
    ? projected
    : renderCompactionRegionLocator(entries, maxChars);
}

function groupCompactionRegions(
  entries: readonly CompactableContextEntry[],
): readonly (readonly CompactableContextEntry[])[] {
  const regions: CompactableContextEntry[][] = [];
  const consumed = new Set<number>();
  for (let index = 0; index < entries.length; index += 1) {
    if (consumed.has(index)) {
      continue;
    }
    const entry = entries[index];
    if (entry === undefined) {
      continue;
    }
    if (entry.message.role !== "assistant" || entry.message.toolCalls === undefined) {
      regions.push([entry]);
      continue;
    }

    const expected = new Set(entry.message.toolCalls.map((toolCall) => toolCall.id));
    const region = [entry];
    for (
      let candidateIndex = index + 1;
      candidateIndex < entries.length && expected.size > 0;
      candidateIndex += 1
    ) {
      const candidate = entries[candidateIndex];
      if (candidate === undefined) {
        continue;
      }
      if (
        candidate.message.role === "assistant" &&
        (candidate.message.toolCalls?.length ?? 0) > 0
      ) {
        break;
      }
      if (
        candidate.message.role !== "tool" ||
        candidate.message.toolCallId === undefined ||
        !expected.has(candidate.message.toolCallId)
      ) {
        continue;
      }
      region.push(candidate);
      expected.delete(candidate.message.toolCallId);
      consumed.add(candidateIndex);
    }
    regions.push(region);
  }
  return regions;
}

function renderCompactionRegion(
  entries: readonly CompactableContextEntry[],
  maxContentChars?: number,
): string {
  const contentBudget = maxContentChars ?? Number.POSITIVE_INFINITY;
  return entries.map((entry) => renderCompactionEntry(entry, contentBudget)).join("\n\n");
}

function renderCompactionEntry(
  entry: CompactableContextEntry,
  maxContentChars: number,
): string {
  const toolCalls = entry.message.toolCalls === undefined
    ? ""
    : `\ntoolCalls=${truncateStructuredField(
      JSON.stringify(entry.message.toolCalls),
      maxContentChars,
      "tool call arguments",
    )}`;
  return [
    `[line=${entry.lineNumber} role=${entry.message.role}` +
      `${entry.isCompactionSummary
        ? ` checkpointLevel=${entry.summaryHierarchy?.level ?? 1}`
        : ""}]`,
    truncateStructuredField(
      entry.message.content,
      maxContentChars,
      entry.message.role === "tool" ? "tool result" : "message",
    ),
  ].join("\n") + toolCalls;
}

function fitCompactionRegion(
  entries: readonly CompactableContextEntry[],
  rendered: string,
  maxChars: number,
): string {
  if (rendered.length <= maxChars) {
    return rendered;
  }
  const perEntryBudget = Math.max(
    64,
    Math.floor((maxChars - entries.length * 48) / Math.max(1, entries.length * 2)),
  );
  const fitted = renderCompactionRegion(entries, perEntryBudget);
  return fitted.length <= maxChars
    ? fitted
    : renderCompactionRegionLocator(entries, maxChars);
}

function renderCompactionRegionLocator(
  entries: readonly CompactableContextEntry[],
  maxChars: number,
): string {
  const firstLine = entries[0]?.lineNumber;
  const lastLine = entries[entries.length - 1]?.lineNumber;
  const roles = uniqueList(entries.map((entry) => entry.message.role)).join(",");
  const locator =
    `[complete context region omitted from summary input; durable lines ` +
    `${firstLine ?? "unknown"}-${lastLine ?? "unknown"}; roles=${roles || "unknown"}]`;
  return locator.slice(0, Math.max(0, maxChars));
}

function renderSelectedCompactionRegions(
  regions: readonly (readonly CompactableContextEntry[])[],
  selected: ReadonlyMap<number, string>,
): string {
  const output: string[] = [];
  let previousIndex = -1;
  for (const [index, value] of [...selected.entries()].sort((left, right) =>
    left[0] - right[0])) {
    if (index > previousIndex + 1) {
      const omitted = regions.slice(previousIndex + 1, index).flat();
      const firstLine = omitted[0]?.lineNumber;
      const lastLine = omitted[omitted.length - 1]?.lineNumber;
      output.push(
        `[${index - previousIndex - 1} complete context region(s) omitted` +
        `${firstLine === undefined ? "" : `; durable lines ${firstLine}-${lastLine}`}]`,
      );
    }
    output.push(value);
    previousIndex = index;
  }
  if (previousIndex < regions.length - 1) {
    const omitted = regions.slice(previousIndex + 1).flat();
    output.push(
      `[${regions.length - previousIndex - 1} complete context region(s) omitted` +
      `${omitted[0] === undefined
        ? ""
        : `; durable lines ${omitted[0].lineNumber}-${omitted[omitted.length - 1]?.lineNumber}`}]`,
    );
  }
  return output.join("\n\n");
}

function truncateStructuredField(
  value: string,
  maxChars: number,
  label: string,
): string {
  if (value.length <= maxChars) {
    return value;
  }
  const marker = `\n[${label} middle omitted; full value remains in durable session]\n`;
  const sideChars = Math.max(0, Math.floor((maxChars - marker.length) / 2));
  return `${value.slice(0, sideChars)}${marker}${value.slice(-sideChars)}`;
}

function parseLlmSummaryFacts(content: string): SessionSummaryFacts {
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
    exactUserConstraints: readOptionalSummaryList(parsed, "exactUserConstraints", 24),
    technicalContext: readOptionalSummaryList(parsed, "technicalContext", 12),
    progress: readSummaryList(parsed, "progress", 12),
    currentWork: readOptionalSummaryList(parsed, "currentWork", 8),
    pendingTasks: readOptionalSummaryList(parsed, "pendingTasks", 12),
    decisions: readSummaryList(parsed, "decisions", 12),
    attemptedApproaches: readOptionalSummaryList(parsed, "attemptedApproaches", 12),
    errorsAndFixes: readOptionalSummaryList(parsed, "errorsAndFixes", 12),
    nextSteps: readSummaryList(parsed, "nextSteps", 8),
    readFiles: readSummaryList(parsed, "readFiles", 30),
    modifiedFiles: readSummaryList(parsed, "modifiedFiles", 30),
    fileOperations: readSummaryList(parsed, "fileOperations", 40),
    currentCodeState: readOptionalSummaryList(parsed, "currentCodeState", 30),
    verificationState: readOptionalSummaryList(parsed, "verificationState", 20),
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

function readOptionalSummaryList(
  record: UnknownRecord,
  key: string,
  maxItems: number,
): readonly string[] {
  return record[key] === undefined ? [] : readSummaryList(record, key, maxItems);
}

function modelUsageToJson(usage: ModelUsage): JsonObject {
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

function summaryFactsToJson(facts: SessionSummaryFacts): JsonObject {
  return {
    goal: facts.goal,
    constraints: facts.constraints,
    exactUserConstraints: facts.exactUserConstraints,
    technicalContext: facts.technicalContext,
    progress: facts.progress,
    currentWork: facts.currentWork,
    pendingTasks: facts.pendingTasks,
    decisions: facts.decisions,
    attemptedApproaches: facts.attemptedApproaches,
    errorsAndFixes: facts.errorsAndFixes,
    readFiles: facts.readFiles,
    modifiedFiles: facts.modifiedFiles,
    fileOperations: facts.fileOperations,
    currentCodeState: facts.currentCodeState,
    verificationState: facts.verificationState,
    nextSteps: facts.nextSteps,
  };
}

function summaryHierarchyToJson(
  hierarchy: SessionSummaryHierarchy,
): JsonObject {
  return {
    level: hierarchy.level,
    parentSummaryLineNumbers: hierarchy.parentSummaryLineNumbers,
    sourceSummaryCount: hierarchy.sourceSummaryCount,
    sourceMessageCount: hierarchy.sourceMessageCount,
  };
}

export function parseSessionSummaryHierarchy(
  value: unknown,
): SessionSummaryHierarchy | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const level = readFiniteNumber(value, "level");
  const sourceSummaryCount = readFiniteNumber(value, "sourceSummaryCount");
  const sourceMessageCount = readFiniteNumber(value, "sourceMessageCount");
  const parents = value.parentSummaryLineNumbers;
  if (
    level === undefined || level < 1 ||
    sourceSummaryCount === undefined || sourceSummaryCount < 0 ||
    sourceMessageCount === undefined || sourceMessageCount < 0 ||
    !Array.isArray(parents)
  ) {
    return undefined;
  }
  const parentSummaryLineNumbers = parents.filter(
    (item): item is number =>
      typeof item === "number" && Number.isSafeInteger(item) && item > 0,
  );
  return {
    level: Math.floor(level),
    parentSummaryLineNumbers,
    sourceSummaryCount: Math.floor(sourceSummaryCount),
    sourceMessageCount: Math.floor(sourceMessageCount),
  };
}

export function parseSessionSummaryFacts(
  value: unknown,
): SessionSummaryFacts | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const goal = readString(value, "goal");
  if (goal === undefined || goal.trim().length === 0) {
    return undefined;
  }
  try {
    return {
      goal,
      constraints: readOptionalSummaryList(value, "constraints", 8),
      exactUserConstraints: readStoredSummaryList(
        value,
        "exactUserConstraints",
        24,
      ),
      technicalContext: readOptionalSummaryList(value, "technicalContext", 12),
      progress: readOptionalSummaryList(value, "progress", 12),
      currentWork: readOptionalSummaryList(value, "currentWork", 8),
      pendingTasks: readOptionalSummaryList(value, "pendingTasks", 12),
      decisions: readOptionalSummaryList(value, "decisions", 12),
      attemptedApproaches: readOptionalSummaryList(
        value,
        "attemptedApproaches",
        12,
      ),
      errorsAndFixes: readOptionalSummaryList(value, "errorsAndFixes", 12),
      readFiles: readOptionalSummaryList(value, "readFiles", 30),
      modifiedFiles: readOptionalSummaryList(value, "modifiedFiles", 30),
      fileOperations: readOptionalSummaryList(value, "fileOperations", 40),
      currentCodeState: readOptionalSummaryList(value, "currentCodeState", 30),
      verificationState: readOptionalSummaryList(value, "verificationState", 20),
      nextSteps: readOptionalSummaryList(value, "nextSteps", 8),
    };
  } catch {
    return undefined;
  }
}

function readStoredSummaryList(
  record: UnknownRecord,
  key: string,
  maxItems: number,
): readonly string[] {
  const value = record[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Stored compaction summary needs ${key}[]`);
  }
  return uniqueList(
    value.filter((item): item is string => typeof item === "string"),
  ).slice(-maxItems);
}

export function estimateContextTokens(
  entries: readonly CompactableContextEntry[],
): number {
  return estimateMessagesTokens(entries.map((entry) => entry.message));
}

export function estimateMessagesTokens(messages: readonly LlmMessage[]): number {
  return CONTEXT_TOKEN_ESTIMATOR.estimateMessages(messages);
}

function extractSummaryFacts(
  entries: readonly CompactableContextEntry[],
): SessionSummaryFacts {
  return mergeSummaryFacts(
    extractDurableSummaryFacts(entries),
    extractCurrentSummaryFacts(entries),
  );
}

function extractCurrentSummaryFacts(
  entries: readonly CompactableContextEntry[],
): SessionSummaryFacts {
  const userMessages = entries
    .filter((entry) => entry.message.role === "user")
    .map((entry) => entry.message.content)
    .filter((content) => !isCompactionSummaryContent(content));
  const assistantMessages = entries
    .filter((entry) => entry.message.role === "assistant")
    .map((entry) => entry.message.content)
    .filter((content) => content.trim().length > 0);
  const allMessages = [...userMessages, ...assistantMessages];
  const readFiles = uniqueList(entries.flatMap(extractReadFiles)).slice(0, 30);
  const modifiedFiles = uniqueList(entries.flatMap(extractModifiedFiles)).slice(0, 30);
  const fileOperations = uniqueList(entries.flatMap(extractFileOperations)).slice(0, 40);

  return {
    goal: pickGoal(userMessages),
    constraints: uniqueList(userMessages.flatMap(extractConstraintLines)).slice(0, 8),
    exactUserConstraints: uniqueList(
      userMessages.flatMap(extractExactConstraintLines),
    ).slice(-24),
    technicalContext: extractMatchingLines(
      allMessages,
      /(?:架构|设计|invariant|约定|策略|边界|architecture|design|policy|contract)/iu,
      12,
    ),
    progress: uniqueList(assistantMessages.slice(-8).map((message) =>
      truncateLine(message, 500))).slice(0, 8),
    currentWork: assistantMessages.length === 0
      ? []
      : [truncateLine(assistantMessages[assistantMessages.length - 1] ?? "", 500)],
    pendingTasks: extractMatchingLines(
      allMessages,
      /(?:待办|未完成|下一步|pending|todo|next step|remain)/iu,
      12,
    ),
    decisions: uniqueList(
      allMessages.flatMap(extractDecisionLines),
    ).slice(0, 8),
    attemptedApproaches: extractMatchingLines(
      allMessages,
      /(?:尝试|方案|失败|未奏效|attempt|approach|failed|did not work)/iu,
      12,
    ),
    errorsAndFixes: extractMatchingLines(
      allMessages,
      /(?:错误|报错|异常|根因|修复|error|exception|root cause|fix)/iu,
      12,
    ),
    readFiles,
    modifiedFiles,
    fileOperations,
    currentCodeState: uniqueList([
      ...modifiedFiles.map((file) => `modified: ${file}`),
      ...fileOperations
        .filter((operation) => /^(?:edit|write):/u.test(operation))
        .slice(-12),
    ]).slice(-30),
    verificationState: extractMatchingLines(
      assistantMessages,
      /(?:测试|验证|检查|通过|失败|typecheck|build|test|verified|pass|fail)/iu,
      20,
    ),
    nextSteps: pickNextSteps(userMessages, assistantMessages),
  };
}

function extractDurableSummaryFacts(
  entries: readonly CompactableContextEntry[],
): SessionSummaryFacts {
  const summary = [...entries].reverse().find((entry) => entry.isCompactionSummary);
  return summary?.summaryFacts ??
    parseRenderedSummaryFacts(summary?.message.content) ??
    emptySummaryFacts();
}

function emptySummaryFacts(
  goal = "继续完成当前 coding task。",
): SessionSummaryFacts {
  return {
    goal,
    constraints: [],
    exactUserConstraints: [],
    technicalContext: [],
    progress: [],
    currentWork: [],
    pendingTasks: [],
    decisions: [],
    attemptedApproaches: [],
    errorsAndFixes: [],
    readFiles: [],
    modifiedFiles: [],
    fileOperations: [],
    currentCodeState: [],
    verificationState: [],
    nextSteps: [],
  };
}

function mergeSummaryFacts(
  ...facts: readonly SessionSummaryFacts[]
): SessionSummaryFacts {
  const latestGoal = [...facts]
    .reverse()
    .map((item) => item.goal.trim())
    .find(
      (goal) =>
        goal.length > 0 && goal !== "继续完成当前 coding task。",
    ) ?? "继续完成当前 coding task。";
  return {
    goal: truncateLine(latestGoal, 500),
    constraints: mergeSummaryLists(facts, "constraints", 8),
    exactUserConstraints: mergeSummaryLists(facts, "exactUserConstraints", 24),
    technicalContext: mergeSummaryLists(facts, "technicalContext", 12),
    progress: mergeSummaryLists(facts, "progress", 12),
    currentWork: mergeSummaryLists(facts, "currentWork", 8),
    pendingTasks: mergeSummaryLists(facts, "pendingTasks", 12),
    decisions: mergeSummaryLists(facts, "decisions", 12),
    attemptedApproaches: mergeSummaryLists(facts, "attemptedApproaches", 12),
    errorsAndFixes: mergeSummaryLists(facts, "errorsAndFixes", 12),
    readFiles: mergeSummaryLists(facts, "readFiles", 30),
    modifiedFiles: mergeSummaryLists(facts, "modifiedFiles", 30),
    fileOperations: mergeSummaryLists(facts, "fileOperations", 40),
    currentCodeState: mergeSummaryLists(facts, "currentCodeState", 30),
    verificationState: mergeSummaryLists(facts, "verificationState", 20),
    nextSteps: mergeSummaryLists(facts, "nextSteps", 8),
  };
}

function mergeGeneratedSummaryFacts(
  durable: SessionSummaryFacts,
  deterministic: SessionSummaryFacts,
  generated: SessionSummaryFacts,
): SessionSummaryFacts {
  return {
    ...mergeSummaryFacts(durable, deterministic, generated),
    // This lane is source-derived so model paraphrases cannot replace user wording.
    exactUserConstraints: mergeSummaryLists(
      [durable, deterministic],
      "exactUserConstraints",
      24,
    ),
  };
}

function mergeSummaryLists(
  facts: readonly SessionSummaryFacts[],
  key: Exclude<keyof SessionSummaryFacts, "goal">,
  maxItems: number,
): readonly string[] {
  return uniqueList(facts.flatMap((item) => item[key])).slice(-maxItems);
}

function splitEntriesForCompaction(
  entries: readonly CompactableContextEntry[],
  keepRecentTokens: number,
  preserveFromLineNumber: number | undefined,
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

  if (preserveFromLineNumber !== undefined) {
    const protectedIndex = entries.findIndex(
      (entry) => entry.lineNumber === preserveFromLineNumber,
    );
    if (protectedIndex >= 0) {
      startIndex = Math.min(startIndex, protectedIndex);
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

function renderSummary(facts: SessionSummaryFacts): string {
  return [
    "[SESSION COMPACTION SUMMARY]",
    "",
    "目标:",
    `- ${facts.goal}`,
    "",
    "约束:",
    ...renderList(facts.constraints, "未捕获明确约束。"),
    "",
    "用户原始约束:",
    ...renderList(facts.exactUserConstraints, "未捕获需要逐字保留的用户约束。"),
    "",
    "技术上下文:",
    ...renderList(facts.technicalContext, "未记录关键技术上下文。"),
    "",
    "进度:",
    ...renderList(facts.progress, "未捕获明确进度。"),
    "",
    "当前工作:",
    ...renderList(facts.currentWork, "未记录压缩时正在进行的工作。"),
    "",
    "待办任务:",
    ...renderList(facts.pendingTasks, "未记录独立待办任务。"),
    "",
    "决策:",
    ...renderList(facts.decisions, "未捕获明确决策。"),
    "",
    "已尝试方案:",
    ...renderList(facts.attemptedApproaches, "未记录已尝试方案。"),
    "",
    "错误与修复:",
    ...renderList(facts.errorsAndFixes, "未记录错误与修复。"),
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
    "当前代码状态:",
    ...renderList(facts.currentCodeState, "未记录当前代码状态。"),
    "",
    "验证状态:",
    ...renderList(facts.verificationState, "未记录验证状态。"),
    "",
    "下一步:",
    ...renderList(facts.nextSteps, "继续根据最新用户消息推进。"),
  ].join("\n");
}

export function parseRenderedSummaryFacts(
  content: string | undefined,
): SessionSummaryFacts | undefined {
  if (content === undefined || !isCompactionSummaryContent(content)) {
    return undefined;
  }
  const sections = new Map<string, string[]>();
  let currentSection: string | undefined;
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.endsWith(":")) {
      currentSection = line.slice(0, -1);
      sections.set(currentSection, []);
      continue;
    }
    if (currentSection !== undefined && line.startsWith("- ")) {
      sections.get(currentSection)?.push(line.slice(2));
    }
  }
  const goal = sections.get("目标")?.[0];
  if (goal === undefined || goal.length === 0) {
    return undefined;
  }
  return {
    goal,
    constraints: meaningfulSummaryValues(sections.get("约束")),
    exactUserConstraints: meaningfulSummaryValues(sections.get("用户原始约束")),
    technicalContext: meaningfulSummaryValues(sections.get("技术上下文")),
    progress: meaningfulSummaryValues(sections.get("进度")),
    currentWork: meaningfulSummaryValues(sections.get("当前工作")),
    pendingTasks: meaningfulSummaryValues(sections.get("待办任务")),
    decisions: meaningfulSummaryValues(sections.get("决策")),
    attemptedApproaches: meaningfulSummaryValues(sections.get("已尝试方案")),
    errorsAndFixes: meaningfulSummaryValues(sections.get("错误与修复")),
    readFiles: meaningfulSummaryValues(sections.get("已读文件")),
    modifiedFiles: meaningfulSummaryValues(sections.get("已改文件")),
    fileOperations: meaningfulSummaryValues(sections.get("文件操作")),
    currentCodeState: meaningfulSummaryValues(sections.get("当前代码状态")),
    verificationState: meaningfulSummaryValues(sections.get("验证状态")),
    nextSteps: meaningfulSummaryValues(sections.get("下一步")),
  };
}

function meaningfulSummaryValues(
  values: readonly string[] | undefined,
): readonly string[] {
  return (values ?? []).filter(
    (value) =>
      !/^(?:未捕获|未记录|继续根据最新用户消息推进)/u.test(value),
  );
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

function extractExactConstraintLines(message: string): readonly string[] {
  return (message.match(/[^。！？.!?;；\r\n]+[。！？.!?;；]?/gu) ?? [])
    .map((segment) => segment.trim())
    .filter(
      (segment) =>
        segment.length > 0 &&
        /(?:要求|必须|不要|不能|只|默认|需要|约束|范围|验收|must|should|do not|don't|only|require)/iu.test(
          segment,
        ),
    )
    .map((segment) =>
      truncateStructuredField(segment, 2_000, "user constraint"));
}

function extractMatchingLines(
  messages: readonly string[],
  pattern: RegExp,
  maxItems: number,
): readonly string[] {
  return uniqueList(
    messages.flatMap((message) =>
      message
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && pattern.test(line))
        .map((line) => truncateLine(line, 500))),
  ).slice(-maxItems);
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

function readFiniteNumber(
  record: UnknownRecord,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
