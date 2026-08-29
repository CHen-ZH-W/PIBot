import type { ModelRequest } from "../agent/model";
import type { LlmMessage, LlmMessageToolCall } from "../core/agent";

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface MicrocompactContextItem {
  readonly lineNumber: number;
  readonly message: LlmMessage;
}

export interface MicrocompactPolicyOptions {
  readonly contextWindowTokens: number;
  readonly reserveTokens: number;
  readonly triggerRatio?: number;
  readonly targetRatio?: number;
  readonly criticalRatio?: number;
  readonly protectedPrefixRatio?: number;
  readonly protectRecentTokens?: number;
  readonly minReclaimTokens?: number;
  readonly maxItems?: number;
  readonly highCacheHitRatio?: number;
  /** How long an observed prompt-cache hit protects the existing prefix. */
  readonly warmCacheTtlMs?: number;
  /** Prefix retained after the observed cache has expired. */
  readonly coldProtectedPrefixRatio?: number;
}

export interface MicrocompactProjectionRequest {
  readonly modelRequest: ModelRequest;
  /** Stable System/Developer + Tool-schema tokens before durable history. */
  readonly stablePrefixTokens?: number;
  readonly preserveFromLineNumber?: number;
  readonly recentCacheHitRatio?: number;
  readonly cacheAgeMs?: number;
  readonly cacheEpoch?: number;
}

export type MicrocompactPressure = "moderate" | "critical";
export type PromptCachePolicyState = "warm_conservative" | "cold";

export interface MicrocompactedItem {
  readonly lineNumber: number;
  readonly toolName: string;
  readonly originalTokens: number;
  readonly projectedTokens: number;
  readonly reclaimedTokens: number;
  readonly stablePrefixTokens: number;
  readonly invalidatedSuffixTokens: number;
}

export interface MicrocompactResult {
  readonly triggered: boolean;
  readonly reason:
    | "below_trigger"
    | "target_reached"
    | "partial_reclaim"
    | "no_eligible_items";
  readonly pressure: MicrocompactPressure;
  readonly estimatedTokensBefore: number;
  readonly estimatedTokensAfter: number;
  readonly estimatedHistoryTokensBefore: number;
  readonly estimatedHistoryTokensAfter: number;
  readonly reclaimedTokens: number;
  readonly inputLimitTokens: number;
  readonly triggerTokens: number;
  readonly targetTokens: number;
  readonly protectedPrefixTokens: number;
  readonly estimatedInvalidatedSuffixTokens: number;
  readonly recentCacheHitRatio?: number;
  readonly cacheAgeMs?: number;
  readonly cacheEpoch: number;
  readonly cacheState: PromptCachePolicyState;
  readonly compactedItems: readonly MicrocompactedItem[];
}

export interface MicrocompactProjectionResult {
  readonly messages: readonly LlmMessage[];
  readonly result: MicrocompactResult;
}

interface NormalizedMicrocompactPolicy {
  readonly contextWindowTokens: number;
  readonly reserveTokens: number;
  readonly inputLimitTokens: number;
  readonly triggerRatio: number;
  readonly targetRatio: number;
  readonly criticalRatio: number;
  readonly protectedPrefixRatio: number;
  readonly protectRecentTokens: number;
  readonly minReclaimTokens: number;
  readonly maxItems: number;
  readonly highCacheHitRatio: number;
  readonly warmCacheTtlMs: number;
  readonly coldProtectedPrefixRatio: number;
}

interface MicrocompactCandidate {
  readonly index: number;
  readonly lineNumber: number;
  readonly toolName: string;
  readonly replacement: LlmMessage;
  readonly originalTokens: number;
  readonly projectedTokens: number;
  readonly reclaimedTokens: number;
  readonly stablePrefixTokens: number;
  readonly invalidatedSuffixTokens: number;
  readonly benefitRatio: number;
}

export function normalizeMicrocompactPolicy(
  options: MicrocompactPolicyOptions,
): NormalizedMicrocompactPolicy {
  const contextWindowTokens = positiveInteger(
    options.contextWindowTokens,
    "contextWindowTokens",
  );
  const reserveTokens = nonNegativeInteger(
    options.reserveTokens,
    "reserveTokens",
  );
  if (reserveTokens >= contextWindowTokens) {
    throw new Error("reserveTokens must be less than contextWindowTokens");
  }
  const triggerRatio = ratio(options.triggerRatio, 0.8, "triggerRatio");
  const targetRatio = ratio(options.targetRatio, 0.72, "targetRatio");
  const criticalRatio = ratio(options.criticalRatio, 0.95, "criticalRatio");
  if (targetRatio >= triggerRatio) {
    throw new Error("targetRatio must be less than triggerRatio");
  }
  if (criticalRatio <= triggerRatio) {
    throw new Error("criticalRatio must be greater than triggerRatio");
  }
  return {
    contextWindowTokens,
    reserveTokens,
    inputLimitTokens: contextWindowTokens - reserveTokens,
    triggerRatio,
    targetRatio,
    criticalRatio,
    protectedPrefixRatio: ratio(
      options.protectedPrefixRatio,
      0.65,
      "protectedPrefixRatio",
    ),
    protectRecentTokens: nonNegativeInteger(
      options.protectRecentTokens ?? 12_000,
      "protectRecentTokens",
    ),
    minReclaimTokens: positiveInteger(
      options.minReclaimTokens ?? 512,
      "minReclaimTokens",
    ),
    maxItems: positiveInteger(options.maxItems ?? 12, "maxItems"),
    highCacheHitRatio: ratio(
      options.highCacheHitRatio,
      0.5,
      "highCacheHitRatio",
    ),
    warmCacheTtlMs: positiveInteger(
      options.warmCacheTtlMs ?? 300_000,
      "warmCacheTtlMs",
    ),
    coldProtectedPrefixRatio: ratio(
      options.coldProtectedPrefixRatio,
      0.15,
      "coldProtectedPrefixRatio",
    ),
  };
}

export function microcompactContext(
  items: readonly MicrocompactContextItem[],
  options: MicrocompactPolicyOptions,
  request: MicrocompactProjectionRequest,
  estimateMessages: (messages: readonly LlmMessage[]) => number,
  estimateRequest: (request: ModelRequest) => number,
  projectRequest: (
    messages: readonly LlmMessage[],
  ) => ModelRequest = (messages) =>
    withProjectedMessages(request.modelRequest, messages),
): MicrocompactProjectionResult {
  const policy = normalizeMicrocompactPolicy(options);
  const messages = items.map((item) => item.message);
  const fullRequest = projectRequest(messages);
  const estimatedTokensBefore = estimateRequest(fullRequest);
  const estimatedHistoryTokensBefore = estimateMessages(messages);
  const nonHistoryTokens = Math.max(
    0,
    estimatedTokensBefore - estimatedHistoryTokensBefore,
  );
  const stablePrefixTokens = Math.min(
    nonHistoryTokens,
    Math.max(0, request.stablePrefixTokens ?? nonHistoryTokens),
  );
  const triggerTokens = Math.floor(
    policy.inputLimitTokens * policy.triggerRatio,
  );
  const targetTokens = Math.floor(policy.inputLimitTokens * policy.targetRatio);
  const pressure: MicrocompactPressure =
    estimatedTokensBefore >= policy.inputLimitTokens * policy.criticalRatio
      ? "critical"
      : "moderate";
  const cacheState = promptCachePolicyState(policy, request);
  const protectedPrefixTokens = cacheProtectedPrefixTokens(
    policy,
    stablePrefixTokens,
    estimatedHistoryTokensBefore,
    cacheState,
    request.recentCacheHitRatio,
    pressure,
  );
  if (estimatedTokensBefore < triggerTokens) {
    return {
      messages,
      result: emptyResult({
        reason: "below_trigger",
        pressure,
        estimatedTokensBefore,
        estimatedHistoryTokensBefore,
        inputLimitTokens: policy.inputLimitTokens,
        triggerTokens,
        targetTokens,
        protectedPrefixTokens,
        cacheState,
        cacheEpoch: request.cacheEpoch ?? 0,
        ...(request.cacheAgeMs === undefined
          ? {}
          : { cacheAgeMs: request.cacheAgeMs }),
        ...(request.recentCacheHitRatio === undefined
          ? {}
          : { recentCacheHitRatio: request.recentCacheHitRatio }),
      }),
    };
  }

  const candidates = collectCandidates(
    items,
    policy,
    request,
    pressure,
    cacheState,
    protectedPrefixTokens,
    stablePrefixTokens,
    estimatedTokensBefore,
    estimateMessages,
  );
  const selected: MicrocompactCandidate[] = [];
  let reclaimedTokens = 0;
  for (const candidate of candidates) {
    if (selected.length >= policy.maxItems) {
      break;
    }
    selected.push(candidate);
    reclaimedTokens += candidate.reclaimedTokens;
    if (estimatedTokensBefore - reclaimedTokens <= targetTokens) {
      break;
    }
  }
  if (selected.length === 0) {
    return {
      messages,
      result: emptyResult({
        reason: "no_eligible_items",
        pressure,
        estimatedTokensBefore,
        estimatedHistoryTokensBefore,
        inputLimitTokens: policy.inputLimitTokens,
        triggerTokens,
        targetTokens,
        protectedPrefixTokens,
        cacheState,
        cacheEpoch: request.cacheEpoch ?? 0,
        ...(request.cacheAgeMs === undefined
          ? {}
          : { cacheAgeMs: request.cacheAgeMs }),
        ...(request.recentCacheHitRatio === undefined
          ? {}
          : { recentCacheHitRatio: request.recentCacheHitRatio }),
      }),
    };
  }

  const replacements = new Map(
    selected.map((candidate) => [candidate.index, candidate.replacement]),
  );
  const projectedMessages = messages.map(
    (message, index) => replacements.get(index) ?? message,
  );
  const estimatedHistoryTokensAfter = estimateMessages(projectedMessages);
  const estimatedTokensAfter = estimateRequest(
    projectRequest(projectedMessages),
  );
  const earliestPrefix = Math.min(
    ...selected.map((candidate) => candidate.stablePrefixTokens),
  );
  return {
    messages: projectedMessages,
    result: {
      triggered: true,
      reason: estimatedTokensAfter <= targetTokens
        ? "target_reached"
        : "partial_reclaim",
      pressure,
      estimatedTokensBefore,
      estimatedTokensAfter,
      estimatedHistoryTokensBefore,
      estimatedHistoryTokensAfter,
      reclaimedTokens: Math.max(0, estimatedTokensBefore - estimatedTokensAfter),
      inputLimitTokens: policy.inputLimitTokens,
      triggerTokens,
      targetTokens,
      protectedPrefixTokens,
      cacheState,
      cacheEpoch: request.cacheEpoch ?? 0,
      estimatedInvalidatedSuffixTokens: Math.max(
        0,
        estimatedTokensBefore - earliestPrefix,
      ),
      ...(request.recentCacheHitRatio === undefined
        ? {}
        : { recentCacheHitRatio: request.recentCacheHitRatio }),
      ...(request.cacheAgeMs === undefined
        ? {}
        : { cacheAgeMs: request.cacheAgeMs }),
      compactedItems: selected.map((candidate) => ({
        lineNumber: candidate.lineNumber,
        toolName: candidate.toolName,
        originalTokens: candidate.originalTokens,
        projectedTokens: candidate.projectedTokens,
        reclaimedTokens: candidate.reclaimedTokens,
        stablePrefixTokens: candidate.stablePrefixTokens,
        invalidatedSuffixTokens: candidate.invalidatedSuffixTokens,
      })),
    },
  };
}

function collectCandidates(
  items: readonly MicrocompactContextItem[],
  policy: NormalizedMicrocompactPolicy,
  request: MicrocompactProjectionRequest,
  pressure: MicrocompactPressure,
  cacheState: PromptCachePolicyState,
  protectedPrefixTokens: number,
  stableRequestPrefixTokens: number,
  estimatedTokensBefore: number,
  estimateMessages: (messages: readonly LlmMessage[]) => number,
): readonly MicrocompactCandidate[] {
  const calls = collectToolCalls(items);
  const suffixTokens = messageSuffixTokens(items, estimateMessages);
  let prefixTokens = stableRequestPrefixTokens;
  const candidates: MicrocompactCandidate[] = [];
  for (const [index, item] of items.entries()) {
    const messageTokens = estimateMessages([item.message]);
    const call = item.message.toolCallId === undefined
      ? undefined
      : calls.get(item.message.toolCallId);
    const replacement = call === undefined
      ? undefined
      : microcompactReplacement(item, call);
    if (
      call !== undefined &&
      replacement !== undefined &&
      (request.preserveFromLineNumber === undefined ||
        item.lineNumber < request.preserveFromLineNumber) &&
      (suffixTokens[index] ?? 0) > policy.protectRecentTokens
    ) {
      const projectedTokens = estimateMessages([replacement]);
      const reclaimedTokens = messageTokens - projectedTokens;
      const stablePrefixTokens = prefixTokens;
      const invalidatedSuffixTokens = Math.max(
        1,
        estimatedTokensBefore - stablePrefixTokens,
      );
      const benefitRatio = reclaimedTokens / invalidatedSuffixTokens;
      const minimumBenefitRatio = minimumCacheBenefitRatio(
        cacheState,
        pressure,
      );
      if (
        reclaimedTokens >= policy.minReclaimTokens &&
        stablePrefixTokens >= protectedPrefixTokens &&
        benefitRatio >= minimumBenefitRatio
      ) {
        candidates.push({
          index,
          lineNumber: item.lineNumber,
          toolName: call.name,
          replacement,
          originalTokens: messageTokens,
          projectedTokens,
          reclaimedTokens,
          stablePrefixTokens,
          invalidatedSuffixTokens,
          benefitRatio,
        });
      }
    }
    prefixTokens += messageTokens;
  }

  return candidates.sort((left, right) => {
    if (cacheState === "cold" && left.index !== right.index) {
      return left.index - right.index;
    }
    const scoreDifference = right.benefitRatio - left.benefitRatio;
    if (Math.abs(scoreDifference) > 0.0001) {
      return scoreDifference;
    }
    return right.index - left.index;
  });
}

function collectToolCalls(
  items: readonly MicrocompactContextItem[],
): ReadonlyMap<string, LlmMessageToolCall> {
  const calls = new Map<string, LlmMessageToolCall>();
  for (const item of items) {
    for (const call of item.message.toolCalls ?? []) {
      calls.set(call.id, call);
    }
  }
  return calls;
}

function microcompactReplacement(
  item: MicrocompactContextItem,
  call: LlmMessageToolCall,
): LlmMessage | undefined {
  if (item.message.role !== "tool" || item.message.toolCallId === undefined) {
    return undefined;
  }
  const payload = parseJsonObject(item.message.content);
  if (payload === undefined || payload.ok !== true) {
    return undefined;
  }
  const output = readRecord(payload, "output");
  if (output === undefined) {
    return undefined;
  }
  const input = parseJsonObject(call.argumentsJson) ?? {};
  const retained = retainedToolResult(call.name, input, output);
  if (retained === undefined) {
    return undefined;
  }
  return {
    role: "tool",
    toolCallId: item.message.toolCallId,
    content: JSON.stringify({
      ok: true,
      callId: item.message.toolCallId,
      output: {
        microcompacted: true,
        tool: call.name,
        durableContextLine: item.lineNumber,
        instruction:
          "The original successful result is preserved in durable history but omitted from the model surface. Re-run only when current data is needed and the operation remains safe.",
        ...retained,
      },
      ...(payload.artifact === undefined ? {} : { artifact: payload.artifact }),
    }),
  };
}

function retainedToolResult(
  toolName: string,
  input: UnknownRecord,
  output: UnknownRecord,
): UnknownRecord | undefined {
  if (toolName === "read") {
    return {
      regenerable: true,
      request: selectFields(input, ["path", "offset", "limit", "startLine", "endLine"]),
      result: selectFields(output, [
        "path",
        "startLine",
        "endLine",
        "totalLines",
        "truncated",
        "sha256",
      ]),
    };
  }
  if (toolName === "read_skill") {
    return {
      regenerable: true,
      request: selectFields(input, ["location", "path", "offset", "limit"]),
      result: selectFields(output, [
        "location",
        "path",
        "startLine",
        "endLine",
        "totalLines",
        "truncated",
        "sha256",
      ]),
    };
  }
  if (toolName === "grep") {
    const matches = Array.isArray(output.matches) ? output.matches : [];
    return {
      regenerable: true,
      request: selectFields(input, [
        "pattern",
        "paths",
        "caseSensitive",
        "includeGlobs",
        "excludeGlobs",
      ]),
      result: {
        matchCount: matches.length,
        ...selectFields(output, ["truncated"]),
      },
    };
  }
  if (toolName === "bash") {
    const command = readString(input, "command");
    const exitCode = readNumber(output, "exitCode");
    if (
      command === undefined ||
      !isObservationCommand(command) ||
      exitCode !== 0 ||
      output.timedOut === true ||
      output.aborted === true
    ) {
      return undefined;
    }
    return {
      regenerable: false,
      request: selectFields(input, ["command", "cwd", "timeoutMs"]),
      result: {
        exitCode,
        stdoutTail: tail(readString(output, "stdout"), 500),
        stderrTail: tail(readString(output, "stderr"), 500),
        ...selectFields(output, [
          "stdoutTruncated",
          "stderrTruncated",
        ]),
      },
    };
  }
  return undefined;
}

function isObservationCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/gu, " ");
  if (/[;&|><`$]/u.test(normalized)) {
    return false;
  }
  return /^(?:pwd|ls(?:\s|$)|find(?:\s|$)|rg(?:\s|$)|grep(?:\s|$)|git (?:status|diff|log|show)(?:\s|$)|npm (?:test|run (?:test|typecheck|build))(?:\s|$)|pnpm (?:test|run (?:test|typecheck|build))(?:\s|$)|yarn (?:test|run (?:test|typecheck|build))(?:\s|$)|pytest(?:\s|$)|python -m pytest(?:\s|$)|cargo (?:test|check)(?:\s|$)|go test(?:\s|$))/u.test(
    normalized,
  );
}

function messageSuffixTokens(
  items: readonly MicrocompactContextItem[],
  estimateMessages: (messages: readonly LlmMessage[]) => number,
): readonly number[] {
  const suffix = new Array<number>(items.length).fill(0);
  let tokens = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined) {
      tokens += estimateMessages([item.message]);
    }
    suffix[index] = tokens;
  }
  return suffix;
}

function cacheProtectedPrefixTokens(
  policy: NormalizedMicrocompactPolicy,
  stableRequestPrefixTokens: number,
  estimatedHistoryTokensBefore: number,
  cacheState: PromptCachePolicyState,
  recentCacheHitRatio: number | undefined,
  pressure: MicrocompactPressure,
): number {
  let protectedRatio = cacheState === "cold"
    ? policy.coldProtectedPrefixRatio
    : policy.protectedPrefixRatio;
  if (
    cacheState === "warm_conservative" &&
    recentCacheHitRatio !== undefined &&
    recentCacheHitRatio >= policy.highCacheHitRatio
  ) {
    protectedRatio = Math.min(0.9, protectedRatio + 0.15);
  }
  if (pressure === "critical") {
    protectedRatio = Math.max(
      cacheState === "cold" ? 0.05 : 0.25,
      protectedRatio - 0.3,
    );
  }
  return stableRequestPrefixTokens + Math.floor(
    estimatedHistoryTokensBefore * protectedRatio,
  );
}

function promptCachePolicyState(
  policy: NormalizedMicrocompactPolicy,
  request: MicrocompactProjectionRequest,
): PromptCachePolicyState {
  const hasObservedHit =
    request.recentCacheHitRatio !== undefined &&
    request.recentCacheHitRatio > 0;
  const withinTtl =
    request.cacheAgeMs === undefined ||
    request.cacheAgeMs <= policy.warmCacheTtlMs;
  if (!hasObservedHit || !withinTtl) {
    return "cold";
  }
  return "warm_conservative";
}

function minimumCacheBenefitRatio(
  cacheState: PromptCachePolicyState,
  pressure: MicrocompactPressure,
): number {
  if (cacheState === "cold") {
    return 0;
  }
  return pressure === "critical" ? 0.04 : 0.12;
}

function withProjectedMessages(
  request: ModelRequest,
  messages: readonly LlmMessage[],
): ModelRequest {
  return {
    ...request,
    messages: [...leadingAuthorityMessages(request.messages), ...messages],
  };
}

function leadingAuthorityMessages(
  messages: readonly LlmMessage[],
): readonly LlmMessage[] {
  const leading: LlmMessage[] = [];
  for (const message of messages) {
    if (message.role !== "system" && message.role !== "developer") {
      break;
    }
    leading.push(message);
  }
  return leading;
}

function emptyResult(input: {
  readonly reason: MicrocompactResult["reason"];
  readonly pressure: MicrocompactPressure;
  readonly estimatedTokensBefore: number;
  readonly estimatedHistoryTokensBefore: number;
  readonly inputLimitTokens: number;
  readonly triggerTokens: number;
  readonly targetTokens: number;
  readonly protectedPrefixTokens: number;
  readonly recentCacheHitRatio?: number;
  readonly cacheAgeMs?: number;
  readonly cacheEpoch: number;
  readonly cacheState: PromptCachePolicyState;
}): MicrocompactResult {
  return {
    triggered: false,
    reason: input.reason,
    pressure: input.pressure,
    estimatedTokensBefore: input.estimatedTokensBefore,
    estimatedTokensAfter: input.estimatedTokensBefore,
    estimatedHistoryTokensBefore: input.estimatedHistoryTokensBefore,
    estimatedHistoryTokensAfter: input.estimatedHistoryTokensBefore,
    reclaimedTokens: 0,
    inputLimitTokens: input.inputLimitTokens,
    triggerTokens: input.triggerTokens,
    targetTokens: input.targetTokens,
    protectedPrefixTokens: input.protectedPrefixTokens,
    cacheEpoch: input.cacheEpoch,
    cacheState: input.cacheState,
    estimatedInvalidatedSuffixTokens: 0,
    ...(input.recentCacheHitRatio === undefined
      ? {}
      : { recentCacheHitRatio: input.recentCacheHitRatio }),
    ...(input.cacheAgeMs === undefined
      ? {}
      : { cacheAgeMs: input.cacheAgeMs }),
    compactedItems: [],
  };
}

function selectFields(
  record: UnknownRecord,
  keys: readonly string[],
): UnknownRecord {
  const selected: Record<string, unknown> = {};
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined) {
      selected[key] = value;
    }
  }
  return selected;
}

function parseJsonObject(value: string): UnknownRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
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

function readNumber(
  record: UnknownRecord,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function tail(value: string | undefined, maxChars: number): string {
  if (value === undefined || value.length <= maxChars) {
    return value ?? "";
  }
  return `...[tail]${value.slice(-maxChars)}`;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ratio(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized <= 0 || normalized >= 1) {
    throw new Error(`${label} must be greater than 0 and less than 1`);
  }
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}
