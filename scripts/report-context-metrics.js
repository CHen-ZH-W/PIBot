#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const storeRoot = path.resolve(process.env.PIBOT_STORE_ROOT || ".pibot");
const usage = readJsonl(path.join(storeRoot, "usage.jsonl"));
const trace = readJsonl(path.join(storeRoot, "trace.jsonl"));
const realUsage = usage.filter((record) => record.estimated === false);
const inputTokens = sum(realUsage, "inputTokens");
const cachedInputTokens = sum(realUsage, "cachedInputTokens");
const usageWithCacheSavings = realUsage.filter(hasFiniteCacheSavings);
const completedModelCalls = trace.filter((event) =>
  event.type === "model.completed");
const modelCallsWithUsage = completedModelCalls.filter(hasProviderUsage);
const modelCallsWithCost = modelCallsWithUsage.filter((event) =>
  hasFiniteField(event, "cost"));
const modelCallsWithCacheSavings = modelCallsWithUsage.filter((event) =>
  hasFiniteField(event, "cacheSavings"));
const providerCallInputTokens = sumNested(
  modelCallsWithUsage,
  "usage",
  "inputTokens",
);
const providerCallCachedInputTokens = sumNested(
  modelCallsWithUsage,
  "usage",
  "cachedInputTokens",
);
const report = {
  type: "context_metrics_report",
  schemaVersion: 3,
  generatedAt: new Date().toISOString(),
  storeRoot,
  providerReportedRuns: realUsage.length,
  estimatedRuns: usage.length - realUsage.length,
  inputTokens,
  cachedInputTokens,
  uncachedInputTokens: sum(realUsage, "uncachedInputTokens"),
  cacheHitRatio: inputTokens === 0 ? 0 : cachedInputTokens / inputTokens,
  cost: sum(realUsage, "cost"),
  cacheSavings: usageWithCacheSavings.length === 0
    ? null
    : sum(usageWithCacheSavings, "cacheSavings"),
  cacheSavingsRecordedRuns: usageWithCacheSavings.length,
  compactions: trace.filter((event) => event.type === "session.compacted").length,
  microcompactions: trace.filter((event) =>
    event.type === "session.microcompacted").length,
  modelCalls: completedModelCalls.length,
  providerCalls: {
    completed: completedModelCalls.length,
    withProviderUsage: modelCallsWithUsage.length,
    inputTokens: providerCallInputTokens,
    cachedInputTokens: providerCallCachedInputTokens,
    uncachedInputTokens:
      providerCallInputTokens - providerCallCachedInputTokens,
    outputTokens: sumNested(modelCallsWithUsage, "usage", "outputTokens"),
    cacheHitRatio: providerCallInputTokens === 0
      ? 0
      : providerCallCachedInputTokens / providerCallInputTokens,
    cost: modelCallsWithCost.length === 0
      ? null
      : sum(modelCallsWithCost, "cost"),
    costRecordedCalls: modelCallsWithCost.length,
    cacheSavings: modelCallsWithCacheSavings.length === 0
      ? null
      : sum(modelCallsWithCacheSavings, "cacheSavings"),
    cacheSavingsRecordedCalls: modelCallsWithCacheSavings.length,
    firstAt: firstTimestamp(modelCallsWithUsage),
    lastAt: lastTimestamp(modelCallsWithUsage),
  },
  channels: aggregateChannels(realUsage),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function readJsonl(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/u)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          return parsed && typeof parsed === "object" ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

function aggregateChannels(records) {
  const groups = new Map();
  for (const record of records) {
    const key = String(record.channelId || "unknown");
    const current = groups.get(key) || {
      channelId: key,
      runs: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cost: 0,
      cacheSavings: 0,
      cacheSavingsRecordedRuns: 0,
    };
    current.runs += 1;
    current.inputTokens += Number(record.inputTokens) || 0;
    current.cachedInputTokens += Number(record.cachedInputTokens) || 0;
    current.cost += Number(record.cost) || 0;
    if (hasFiniteCacheSavings(record)) {
      current.cacheSavings += Number(record.cacheSavings);
      current.cacheSavingsRecordedRuns += 1;
    }
    groups.set(key, current);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    cacheSavings: group.cacheSavingsRecordedRuns === 0
      ? null
      : group.cacheSavings,
    cacheHitRatio: group.inputTokens === 0
      ? 0
      : group.cachedInputTokens / group.inputTokens,
  }));
}

function hasFiniteCacheSavings(record) {
  return hasFiniteField(record, "cacheSavings");
}

function hasProviderUsage(event) {
  return event.usage !== null &&
    typeof event.usage === "object" &&
    event.usage.inputTokens !== null &&
    event.usage.inputTokens !== undefined &&
    Number.isFinite(Number(event.usage.inputTokens));
}

function hasFiniteField(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key) &&
    record[key] !== null &&
    record[key] !== "" &&
    Number.isFinite(Number(record[key]));
}

function sumNested(values, parentKey, key) {
  return values.reduce(
    (total, value) => total + (Number(value[parentKey]?.[key]) || 0),
    0,
  );
}

function firstTimestamp(values) {
  return sortedTimestamps(values).at(0) ?? null;
}

function lastTimestamp(values) {
  return sortedTimestamps(values).at(-1) ?? null;
}

function sortedTimestamps(values) {
  return values
    .map((value) => value.ts)
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort();
}

function sum(values, key) {
  return values.reduce((total, value) => total + (Number(value[key]) || 0), 0);
}
