import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { providerRequestHeaders } from "./headers";
import type {
  ModelCatalogCheckSummary,
  ModelCatalogStoreFile,
  ModelSpec,
  ProviderCatalogCheckResult,
  ProviderProfile,
  StoredProviderCatalog,
} from "./types";

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface CheckModelCatalogsOptions {
  readonly providers: readonly ProviderProfile[];
  readonly store: FileModelCatalogStore;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly write?: boolean;
  readonly now?: () => Date;
}

export class FileModelCatalogStore {
  constructor(readonly filePath: string) {}

  async read(): Promise<ModelCatalogStoreFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      return parseStoreFile(parsed, this.filePath);
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        return emptyStore();
      }
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in model catalog store ${this.filePath}: ${error.message}`);
      }
      throw error;
    }
  }

  async write(store: ModelCatalogStoreFile): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}

export async function checkModelCatalogs(
  options: CheckModelCatalogsOptions,
): Promise<ModelCatalogCheckSummary> {
  const fetchImpl = options.fetch ?? fetch;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const storeFile = await options.store.read();
  const checkedAt = now().toISOString();
  const results = await Promise.all(
    options.providers.map((provider) =>
      checkProviderCatalog({
        provider,
        ...optionalStoredCatalog("cached", storeFile.providers[provider.id]),
        checkedAt,
        env,
        fetch: fetchImpl,
        ...optionalSignal(options.signal),
      })
    ),
  );
  if (options.write === true) {
    await options.store.write(
      updatedStoreFile(storeFile, options.providers, results, checkedAt),
    );
  }
  return {
    checkedAt,
    synchronized: results.every((result) =>
      result.status === "unchanged" || result.status === "disabled"
    ),
    results,
  };
}

async function checkProviderCatalog(options: {
  readonly provider: ProviderProfile;
  readonly cached?: StoredProviderCatalog;
  readonly checkedAt: string;
  readonly env: NodeJS.ProcessEnv;
  readonly fetch: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<ProviderCatalogCheckResult> {
  const { provider, cached, checkedAt } = options;
  if (provider.catalog === undefined || provider.catalog.enabled === false) {
    return emptyResult(provider.id, checkedAt, "disabled");
  }
  const sourceUrl = provider.catalog.url ?? `${removeTrailingSlash(provider.baseUrl)}/models`;
  try {
    const headers: Record<string, string> = {
      ...providerRequestHeaders(provider, provider.headers, options.env),
      accept: "application/json",
    };
    if (cached?.etag !== undefined) {
      headers["if-none-match"] = cached.etag;
    }
    if (cached?.lastModified !== undefined) {
      headers["if-modified-since"] = cached.lastModified;
    }
    let response = await options.fetch(sourceUrl, {
      method: "GET",
      headers,
      ...optionalSignal(options.signal),
    });
    if (response.status === 304 && cached !== undefined) {
      return {
        provider: provider.id,
        status: "unchanged",
        checkedAt,
        sourceUrl,
        added: [],
        removed: [],
        updated: [],
        models: cached.models,
        ...optionalString("etag", response.headers.get("etag") ?? cached.etag),
        ...optionalString(
          "lastModified",
          response.headers.get("last-modified") ?? cached.lastModified,
        ),
        notModified: true,
      };
    }
    if (!response.ok) {
      const body = (await response.text()).trim().slice(0, 500);
      throw new Error(
        `HTTP ${response.status}${body.length === 0 ? "" : `: ${body}`}`,
      );
    }
    const etag = response.headers.get("etag") ?? undefined;
    const lastModified = response.headers.get("last-modified") ?? undefined;
    let payload = await response.json() as unknown;
    const discovered = new Map<string, ModelSpec>();
    for (let page = 0; page < 100; page += 1) {
      for (const model of parseProviderModels(payload, provider.id)) {
        discovered.set(model.id, model);
      }
      const cursor = nextModelPageCursor(payload);
      if (cursor === undefined) {
        break;
      }
      const nextUrl = new URL(sourceUrl);
      nextUrl.searchParams.set("after_id", cursor);
      response = await options.fetch(nextUrl, {
        method: "GET",
        headers: {
          ...providerRequestHeaders(provider, provider.headers, options.env),
          accept: "application/json",
        },
        ...optionalSignal(options.signal),
      });
      if (!response.ok) {
        const body = (await response.text()).trim().slice(0, 500);
        throw new Error(
          `HTTP ${response.status} while reading catalog page after ${cursor}${
            body.length === 0 ? "" : `: ${body}`
          }`,
        );
      }
      payload = await response.json() as unknown;
      if (page === 99 && nextModelPageCursor(payload) !== undefined) {
        throw new Error(`provider ${provider.id} catalog exceeded 100 pages`);
      }
    }
    const models = [...discovered.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    );
    const comparison = compareModels(cached?.models ?? [], models);
    return {
      provider: provider.id,
      status: comparison.changed ? "changed" : "unchanged",
      checkedAt,
      sourceUrl,
      added: comparison.added,
      removed: comparison.removed,
      updated: comparison.updated,
      models,
      ...optionalString("etag", etag),
      ...optionalString("lastModified", lastModified),
    };
  } catch (error: unknown) {
    return {
      ...emptyResult(provider.id, checkedAt, "error"),
      sourceUrl,
      models: cached?.models ?? [],
      error: errorMessage(error),
    };
  }
}

function updatedStoreFile(
  current: ModelCatalogStoreFile,
  providers: readonly ProviderProfile[],
  results: readonly ProviderCatalogCheckResult[],
  checkedAt: string,
): ModelCatalogStoreFile {
  const next: Record<string, StoredProviderCatalog> = { ...current.providers };
  for (const provider of providers) {
    const result = results.find((item) => item.provider === provider.id);
    if (result === undefined || result.status === "disabled") {
      continue;
    }
    const previous = current.providers[provider.id];
    if (result.status === "error") {
      next[provider.id] = {
        provider: provider.id,
        checkedAt,
        ...(previous?.fetchedAt === undefined ? {} : { fetchedAt: previous.fetchedAt }),
        ...(previous?.etag === undefined ? {} : { etag: previous.etag }),
        ...(previous?.lastModified === undefined
          ? {}
          : { lastModified: previous.lastModified }),
        lastError: result.error ?? "Unknown catalog refresh error",
        models: previous?.models ?? [],
      };
      continue;
    }
    next[provider.id] = {
      provider: provider.id,
      checkedAt,
      fetchedAt: result.notModified === true
        ? previous?.fetchedAt ?? checkedAt
        : checkedAt,
      ...optionalString("etag", result.etag),
      ...optionalString("lastModified", result.lastModified),
      models: result.models,
    };
  }
  return { version: 1, providers: next };
}

function parseProviderModels(value: unknown, provider: string): readonly ModelSpec[] {
  const items = modelArray(value, provider);
  const models = new Map<string, ModelSpec>();
  for (const [index, item] of items.entries()) {
    if (typeof item === "string") {
      const id = item.trim();
      if (id.length > 0) {
        models.set(id, { id, status: "unknown" });
      }
      continue;
    }
    const model = record(item, `provider ${provider} catalog model[${index}]`);
    const idValue = model.id;
    if (typeof idValue !== "string" || idValue.trim().length === 0) {
      continue;
    }
    const id = idValue.trim();
    const rawName = typeof model.name === "string"
      ? model.name
      : typeof model.display_name === "string"
        ? model.display_name
        : undefined;
    const name = rawName?.trim().length === 0 ? undefined : rawName?.trim();
    models.set(id, {
      id,
      status: "unknown",
      ...optionalString("name", name),
    });
  }
  return [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function modelArray(value: unknown, provider: string): readonly unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  const root = record(value, `provider ${provider} catalog response`);
  if (Array.isArray(root.data)) {
    return root.data;
  }
  if (Array.isArray(root.models)) {
    return root.models;
  }
  throw new Error(`provider ${provider} catalog response must contain data[] or models[]`);
}

function nextModelPageCursor(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const root = value as UnknownRecord;
  if (root.has_more !== true) {
    return undefined;
  }
  return typeof root.last_id === "string" && root.last_id.length > 0
    ? root.last_id
    : undefined;
}

function compareModels(
  previous: readonly ModelSpec[],
  current: readonly ModelSpec[],
): {
  readonly changed: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly updated: readonly string[];
} {
  const previousById = new Map(previous.map((model) => [model.id, model]));
  const currentById = new Map(current.map((model) => [model.id, model]));
  const added = [...currentById.keys()].filter((id) => !previousById.has(id)).sort();
  const removed = [...previousById.keys()].filter((id) => !currentById.has(id)).sort();
  const updated = [...currentById.entries()]
    .filter(([id, model]) => {
      const old = previousById.get(id);
      return old !== undefined && stableModelJson(old) !== stableModelJson(model);
    })
    .map(([id]) => id)
    .sort();
  return {
    changed: added.length > 0 || removed.length > 0 || updated.length > 0,
    added,
    removed,
    updated,
  };
}

function stableModelJson(model: ModelSpec): string {
  return JSON.stringify(model, Object.keys(model).sort());
}

function parseStoreFile(value: unknown, filePath: string): ModelCatalogStoreFile {
  const root = record(value, `model catalog store ${filePath}`);
  if (root.version !== 1) {
    throw new Error(`model catalog store ${filePath}.version must be 1`);
  }
  const providers = record(root.providers, `model catalog store ${filePath}.providers`);
  const parsed: Record<string, StoredProviderCatalog> = {};
  for (const [id, raw] of Object.entries(providers)) {
    const provider = record(raw, `stored provider ${id}`);
    const checkedAt = requiredString(provider.checkedAt, `stored provider ${id}.checkedAt`);
    parsed[id] = {
      provider: id,
      checkedAt,
      ...optionalString("fetchedAt", stringValue(provider.fetchedAt)),
      ...optionalString("etag", stringValue(provider.etag)),
      ...optionalString("lastModified", stringValue(provider.lastModified)),
      ...optionalString("lastError", stringValue(provider.lastError)),
      models: parseStoredModels(provider.models, id),
    };
  }
  return { version: 1, providers: parsed };
}

function parseStoredModels(value: unknown, provider: string): readonly ModelSpec[] {
  if (!Array.isArray(value)) {
    throw new Error(`stored provider ${provider}.models must be an array`);
  }
  return value.map((item, index) => {
    const model = record(item, `stored provider ${provider}.models[${index}]`);
    const id = requiredString(model.id, `stored provider ${provider}.models[${index}].id`);
    return { ...model, id } as ModelSpec;
  });
}

function emptyStore(): ModelCatalogStoreFile {
  return { version: 1, providers: {} };
}

function emptyResult(
  provider: string,
  checkedAt: string,
  status: ProviderCatalogCheckResult["status"],
): ProviderCatalogCheckResult {
  return {
    provider,
    status,
    checkedAt,
    added: [],
    removed: [],
    updated: [],
    models: [],
  };
}

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown, label: string): string {
  const resolved = stringValue(value);
  if (resolved === undefined) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return resolved;
}

function optionalString<Key extends string>(
  key: Key,
  value: string | undefined,
): { readonly [Property in Key]: string } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: string;
  };
}

function optionalSignal(signal: AbortSignal | undefined): { readonly signal: AbortSignal } | object {
  return signal === undefined ? {} : { signal };
}

function optionalStoredCatalog<Key extends string>(
  key: Key,
  value: StoredProviderCatalog | undefined,
): { readonly [Property in Key]: StoredProviderCatalog } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: StoredProviderCatalog;
  };
}

function removeTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
