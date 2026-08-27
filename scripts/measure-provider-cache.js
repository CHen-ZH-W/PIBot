#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const {
  OpenAICompatibleProviderAdapter,
} = require("../dist/providers/openai-compatible");
const {
  calculateUsage,
  defaultUsagePricingForModel,
} = require("../dist/app/usage");

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for a real Provider measurement");
  }
  const model = process.env.OPENAI_MODEL;
  const turns = positiveInteger(process.env.PIBOT_CACHE_BENCHMARK_TURNS, 6);
  const stableChars = positiveInteger(
    process.env.PIBOT_CACHE_BENCHMARK_STABLE_CHARS,
    32_000,
  );
  const tailChars = positiveInteger(
    process.env.PIBOT_CACHE_BENCHMARK_TAIL_CHARS,
    1_000,
  );
  const pricing = pricingFromEnv(
    defaultUsagePricingForModel(model, process.env.OPENAI_BASE_URL),
  );
  const provider = new OpenAICompatibleProviderAdapter();
  const stablePrompt = [
    "Provider prompt-cache measurement. Reply with only OK.",
    deterministicText(stableChars),
  ].join("\n");
  const messages = [{ role: "system", content: stablePrompt }];
  const steps = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    messages.push({
      role: "user",
      content: `turn=${turn}\n${deterministicText(tailChars, turn)}`,
    });
    let assistantText = "";
    let usage;
    let error;
    const startedAt = Date.now();
    for await (const event of provider.stream({
      ...(model ? { model } : {}),
      messages,
      tools: [],
      maxOutputTokens: 16,
      temperature: 0,
    })) {
      if (event.type === "text_delta") assistantText += event.text;
      if (event.type === "done") usage = event.usage;
      if (event.type === "error") error = event.error;
    }
    if (error) {
      throw new Error(`Provider measurement failed: ${error.code}: ${error.message}`);
    }
    if (!usage) {
      throw new Error("Provider did not return usage; cache hit cannot be measured");
    }
    const calculated = calculateUsage(usage, pricing);
    steps.push({
      turn,
      durationMs: Date.now() - startedAt,
      ...usage,
      uncachedInputTokens: calculated.uncachedInputTokens,
      cacheHitRatio: calculated.cacheHitRatio,
      cost: calculated.cost,
      cacheSavings: calculated.cacheSavings,
      currency: calculated.currency,
    });
    messages.push({ role: "assistant", content: assistantText || "OK" });
  }
  const totals = aggregate(steps);
  const report = {
    type: "provider_prompt_cache_measurement",
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    provider: "openai_compatible",
    model: model || "provider_default",
    baseUrlConfigured: Boolean(process.env.OPENAI_BASE_URL),
    turns,
    stableChars,
    tailChars,
    pricingStrategy: pricing.strategy,
    steps,
    totals,
  };
  const outputPath = path.resolve(
    process.env.PIBOT_CACHE_BENCHMARK_OUTPUT ||
      path.join(".pibot", "measurements", "provider-cache-latest.json"),
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ outputPath, totals }, null, 2)}\n`);
}

function aggregate(steps) {
  const inputTokens = sum(steps, "inputTokens");
  const cachedInputTokens = sum(steps, "cachedInputTokens");
  return {
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: sum(steps, "uncachedInputTokens"),
    outputTokens: sum(steps, "outputTokens"),
    cacheHitRatio: inputTokens === 0 ? 0 : cachedInputTokens / inputTokens,
    cost: sum(steps, "cost"),
    cacheSavings: sum(steps, "cacheSavings"),
    durationMs: sum(steps, "durationMs"),
  };
}

function sum(values, key) {
  return values.reduce((total, value) => total + (Number(value[key]) || 0), 0);
}

function deterministicText(chars, seed = 0) {
  const unit = `pibot-stable-prefix-${seed.toString(36)}-`;
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

function positiveInteger(value, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }
  return parsed;
}

function pricingFromEnv(fallback) {
  return {
    ...fallback,
    ...(process.env.USAGE_COST_CURRENCY
      ? { currency: process.env.USAGE_COST_CURRENCY }
      : {}),
    inputCostPerMillionTokens: numberEnv(
      "USAGE_INPUT_COST_PER_1M_TOKENS",
      fallback.inputCostPerMillionTokens,
    ),
    cachedInputCostPerMillionTokens: numberEnv(
      "USAGE_CACHED_INPUT_COST_PER_1M_TOKENS",
      fallback.cachedInputCostPerMillionTokens,
    ),
    outputCostPerMillionTokens: numberEnv(
      "USAGE_OUTPUT_COST_PER_1M_TOKENS",
      fallback.outputCostPerMillionTokens,
    ),
  };
}

function numberEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
