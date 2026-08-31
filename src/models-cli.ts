import * as path from "node:path";
import { ModelRuntime } from "./models/runtime";
import type {
  ModelCatalogCheckSummary,
  ProviderCatalogCheckResult,
} from "./models/types";
import { formatModelRef } from "./models/types";

type ModelsCommand = "list" | "check" | "sync" | "diff";

async function main(): Promise<void> {
  const command = parseCommand(process.argv[2]);
  const json = process.argv.includes("--json");
  const workspaceRoot = path.resolve(process.env.WORKSPACE_ROOT ?? process.cwd());
  const storeRoot = path.resolve(
    process.env.PIBOT_STORE_ROOT ?? path.join(workspaceRoot, ".pibot"),
  );
  const runtime = await ModelRuntime.create({ storeRoot });
  if (command === "list") {
    const output = {
      active: formatModelRef(runtime.activeModelRef()),
      configPath: runtime.config.configPath,
      storePath: runtime.config.storePath,
      credential: runtime.credentialRequirement(),
      models: runtime.listModels().map((model) => ({
        ref: `${model.provider}/${model.id}`,
        name: model.name,
        status: model.status,
        source: model.source,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        checkedAt: model.checkedAt,
        fetchedAt: model.fetchedAt,
      })),
    };
    if (json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    console.log(`Active: ${output.active}`);
    console.log(`Config: ${output.configPath ?? "legacy OPENAI_* environment"}`);
    console.log(`Catalog store: ${output.storePath}`);
    for (const model of output.models) {
      const details = [
        model.status,
        model.source,
        model.contextWindow === undefined
          ? undefined
          : `context=${model.contextWindow}`,
        model.checkedAt === undefined ? undefined : `checked=${model.checkedAt}`,
      ].filter((value): value is string => value !== undefined);
      console.log(`${model.ref}  ${details.join("  ")}`);
    }
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const result = command === "sync"
      ? await runtime.syncCatalogs(controller.signal)
      : await runtime.checkCatalogs(controller.signal);
    if (json) {
      console.log(JSON.stringify({ command, applied: command === "sync", ...result }, null, 2));
    } else {
      printCatalogSummary(command, result);
    }
    if (result.results.some((item) => item.status === "error")) {
      process.exitCode = 1;
    } else if (command !== "sync" && !result.synchronized) {
      process.exitCode = 2;
    }
  } finally {
    clearTimeout(timeout);
  }
}

function printCatalogSummary(
  command: ModelsCommand,
  summary: ModelCatalogCheckSummary,
): void {
  console.log(`Model catalog ${command} at ${summary.checkedAt}`);
  for (const result of summary.results) {
    console.log(formatProviderResult(result));
    if (result.added.length > 0) {
      console.log(`  added: ${result.added.join(", ")}`);
    }
    if (result.removed.length > 0) {
      console.log(`  removed: ${result.removed.join(", ")}`);
    }
    if (result.updated.length > 0) {
      console.log(`  updated: ${result.updated.join(", ")}`);
    }
  }
  if (command === "sync") {
    console.log("Catalog results were written atomically; failed providers kept their last-known-good models.");
  } else if (summary.results.some((result) => result.status === "error")) {
    console.log("Catalog check is incomplete because one or more providers failed.");
  } else {
    console.log(summary.synchronized ? "Catalog is synchronized." : "Catalog differs from the provider source.");
  }
}

function formatProviderResult(result: ProviderCatalogCheckResult): string {
  const detail = result.error ??
    `${result.models.length} models${result.notModified === true ? ", HTTP 304" : ""}`;
  return `${result.provider}: ${result.status} (${detail})`;
}

function parseCommand(value: string | undefined): ModelsCommand {
  const command = value ?? "list";
  if (command === "list" || command === "check" || command === "sync" || command === "diff") {
    return command;
  }
  throw new Error("Usage: node dist/models-cli.js <list|check|sync|diff> [--json]");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
