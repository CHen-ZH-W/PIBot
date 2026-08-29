import { appendFile, mkdir } from "node:fs/promises";
import * as path from "node:path";
import type { LlmMessage } from "../core/agent";
import type { ContextLane } from "../workspace/context-manager";
import type {
  AgentRunId,
  SlackChannelId,
  SlackUserId,
} from "../core/ids";

export interface UsagePricing {
  readonly strategy: string;
  readonly currency: UsageCurrency;
  readonly inputCostPerMillionTokens: number;
  readonly cachedInputCostPerMillionTokens: number;
  readonly outputCostPerMillionTokens: number;
}

export type UsageCurrency = "CNY" | "USD";

export interface UsageTokenCounts {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface CalculatedUsage extends UsageTokenCounts {
  readonly uncachedInputTokens: number;
  readonly cacheHitRatio: number;
  readonly uncachedInputCost: number;
  readonly cachedInputCost: number;
  readonly outputCost: number;
  readonly cacheSavings: number;
  readonly cost: number;
  readonly currency: UsageCurrency;
}

export interface UsageRecord {
  readonly runId: AgentRunId;
  readonly channelId: SlackChannelId;
  readonly userId: SlackUserId;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly model?: string;
  readonly reason: string;
  readonly errorCode?: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly uncachedInputTokens: number;
  readonly cacheHitRatio: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly pricingStrategy: string;
  readonly cost: number;
  readonly cacheSavings: number;
  readonly currency: UsageCurrency;
  readonly estimated: boolean;
}

export interface UsageRecorder {
  recordUsage(record: UsageRecord): Promise<void>;
}

export interface JsonlUsageRecorderOptions {
  readonly filePath: string;
}

export class JsonlUsageRecorder implements UsageRecorder {
  private readonly filePath: string;

  constructor(options: JsonlUsageRecorderOptions) {
    this.filePath = path.resolve(options.filePath);
  }

  async recordUsage(record: UsageRecord): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
  }
}

export class NoopUsageRecorder implements UsageRecorder {
  recordUsage(): Promise<void> {
    return Promise.resolve();
  }
}

export function estimateRunUsage(input: {
  readonly systemPrompt: string;
  readonly contextLanes?: readonly ContextLane[];
  readonly history: readonly LlmMessage[];
  readonly userText: string;
  readonly generatedMessages: readonly LlmMessage[];
  readonly pricing: UsagePricing;
}): CalculatedUsage {
  const inputTokens = estimateTokenCount(
    [
      input.systemPrompt,
      ...(input.contextLanes ?? []).map((lane) => lane.content),
      input.userText,
      ...input.history.map((message) => message.content),
    ].join("\n"),
  );
  const outputTokens = estimateTokenCount(
    input.generatedMessages.map((message) => message.content).join("\n"),
  );

  return calculateUsage(
    {
      inputTokens,
      cachedInputTokens: 0,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
    input.pricing,
  );
}

export function calculateUsage(
  counts: UsageTokenCounts,
  pricing: UsagePricing,
): CalculatedUsage {
  const inputTokens = nonNegative(counts.inputTokens);
  const cachedInputTokens = Math.min(
    inputTokens,
    nonNegative(counts.cachedInputTokens),
  );
  const uncachedInputTokens = inputTokens - cachedInputTokens;
  const outputTokens = nonNegative(counts.outputTokens);
  const totalTokens = nonNegative(counts.totalTokens);
  const cost =
    (uncachedInputTokens * pricing.inputCostPerMillionTokens +
      cachedInputTokens * pricing.cachedInputCostPerMillionTokens +
      outputTokens * pricing.outputCostPerMillionTokens) /
    1_000_000;
  const uncachedInputCost =
    uncachedInputTokens * pricing.inputCostPerMillionTokens / 1_000_000;
  const cachedInputCost =
    cachedInputTokens * pricing.cachedInputCostPerMillionTokens / 1_000_000;
  const outputCost =
    outputTokens * pricing.outputCostPerMillionTokens / 1_000_000;
  const cacheSavings =
    cachedInputTokens * Math.max(
      0,
      pricing.inputCostPerMillionTokens -
        pricing.cachedInputCostPerMillionTokens,
    ) / 1_000_000;

  return {
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    cacheHitRatio: inputTokens === 0 ? 0 : cachedInputTokens / inputTokens,
    outputTokens,
    totalTokens,
    uncachedInputCost,
    cachedInputCost,
    outputCost,
    cacheSavings,
    cost,
    currency: pricing.currency,
  };
}

export function defaultUsagePricingForModel(
  model: string | undefined,
  baseUrl: string | undefined,
): UsagePricing {
  if (model?.trim().toLowerCase() !== "kimi-k2.6") {
    return zeroUsdPricing();
  }

  if (baseUrl?.toLowerCase().includes("moonshot.ai") === true) {
    return {
      strategy: "kimi-k2.6-global",
      currency: "USD",
      cachedInputCostPerMillionTokens: 0.16,
      inputCostPerMillionTokens: 0.95,
      outputCostPerMillionTokens: 4,
    };
  }

  return {
    strategy: "kimi-k2.6-cn",
    currency: "CNY",
    cachedInputCostPerMillionTokens: 1.1,
    inputCostPerMillionTokens: 6.5,
    outputCostPerMillionTokens: 27,
  };
}

export function usagePricingFromEnv(
  defaults: UsagePricing,
  env: NodeJS.ProcessEnv = process.env,
): UsagePricing {
  const currency = readUsageCurrency(env.USAGE_COST_CURRENCY);
  const inputCost = readNonNegativeNumber(
    "USAGE_INPUT_COST_PER_1M_TOKENS",
    env.USAGE_INPUT_COST_PER_1M_TOKENS,
  );
  const cachedInputCost = readNonNegativeNumber(
    "USAGE_CACHED_INPUT_COST_PER_1M_TOKENS",
    env.USAGE_CACHED_INPUT_COST_PER_1M_TOKENS,
  );
  const outputCost = readNonNegativeNumber(
    "USAGE_OUTPUT_COST_PER_1M_TOKENS",
    env.USAGE_OUTPUT_COST_PER_1M_TOKENS,
  );
  const overridden =
    currency !== undefined ||
    inputCost !== undefined ||
    cachedInputCost !== undefined ||
    outputCost !== undefined;

  return {
    strategy: overridden ? `${defaults.strategy}+env` : defaults.strategy,
    currency: currency ?? defaults.currency,
    inputCostPerMillionTokens:
      inputCost ?? defaults.inputCostPerMillionTokens,
    cachedInputCostPerMillionTokens:
      cachedInputCost ?? defaults.cachedInputCostPerMillionTokens,
    outputCostPerMillionTokens:
      outputCost ?? defaults.outputCostPerMillionTokens,
  };
}

export function estimateTokenCount(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  return Math.ceil(text.length / 4);
}

function zeroUsdPricing(): UsagePricing {
  return {
    strategy: "unconfigured",
    currency: "USD",
    inputCostPerMillionTokens: 0,
    cachedInputCostPerMillionTokens: 0,
    outputCostPerMillionTokens: 0,
  };
}

function readUsageCurrency(value: string | undefined): UsageCurrency | undefined {
  const normalized = value?.trim().toUpperCase();
  if (normalized === undefined || normalized.length === 0) {
    return undefined;
  }
  if (normalized === "CNY" || normalized === "USD") {
    return normalized;
  }
  throw new Error("USAGE_COST_CURRENCY must be one of: CNY, USD");
}

function readNonNegativeNumber(
  name: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function nonNegative(value: number): number {
  return Math.max(0, value);
}
