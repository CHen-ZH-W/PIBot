import * as path from "node:path";
import type { ChannelSessionKey } from "./core/session";
import { createConfiguredModelClient } from "./models/runtime";
import { MemoryCurationPipeline } from "./workspace/memory-curation";
import {
  FileChannelWorkspaceStore,
  type WorkspaceStoreWarning,
} from "./workspace/store";

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "backfill") {
    throw new Error(
      "Usage: node dist/memory-cli.js backfill [--limit N] [--json]",
    );
  }
  const workspaceRoot = path.resolve(process.env.WORKSPACE_ROOT ?? process.cwd());
  const storeRoot = path.resolve(
    process.env.PIBOT_STORE_ROOT ?? path.join(workspaceRoot, ".pibot"),
  );
  const configured = await createConfiguredModelClient({ storeRoot });
  const store = new FileChannelWorkspaceStore({
    rootDir: storeRoot,
    onWarning: printWarning,
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
  const curator = new MemoryCurationPipeline({
    store,
    model: configured.client,
    resolveModelRef: () => configured.runtime.activeModelRef(),
    maxOutputTokens:
      readPositiveIntegerEnv("MEMORY_CURATION_MAX_OUTPUT_TOKENS") ?? 5000,
    maxEvidenceChars:
      readPositiveIntegerEnv("MEMORY_CURATION_MAX_EVIDENCE_CHARS") ?? 30_000,
    requestTimeoutMs:
      readPositiveIntegerEnv("MEMORY_CURATION_TIMEOUT_MS") ?? 60_000,
  });
  const key = {
    teamId: process.env.MEMORY_BACKFILL_TEAM_ID ?? "memory-maintenance",
    channelId: process.env.MEMORY_BACKFILL_CHANNEL_ID ?? "historical-backfill",
  } as ChannelSessionKey;
  const recovered = await curator.recoverPending();
  const result = await curator.backfillRolloutSummaries(
    key,
    readLimit(process.argv),
  );
  await curator.waitForIdle();
  const output = { recovered, ...result };
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  console.log(
    [
      `Recovered pending jobs: ${output.recovered}`,
      `Scanned rollout summaries: ${output.scanned}`,
      `Enqueued for curation: ${output.enqueued}`,
      `Skipped completed: ${output.skippedCompleted}`,
      `Skipped pending: ${output.skippedPending}`,
      `Skipped invalid: ${output.skippedInvalid}`,
    ].join("\n"),
  );
}

function readLimit(args: readonly string[]): number {
  const index = args.indexOf("--limit");
  if (index < 0) return 10;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("--limit must be an integer between 1 and 100");
  }
  return value;
}

function readPositiveIntegerEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function printWarning(warning: WorkspaceStoreWarning): void {
  console.warn(
    `[pibot] ${warning.code} at ${warning.filePath}: ${warning.message}`,
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
