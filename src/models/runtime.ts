import type {
  ModelClient,
  ModelEvent,
  ModelProviderAdapter,
  ModelRequest,
} from "../agent/model";
import {
  OpenAICompatibleProviderAdapter,
  RetryingModelClient,
} from "../agent/model";
import { AnthropicMessagesProviderAdapter } from "../providers/anthropic-messages";
import { checkModelCatalogs, FileModelCatalogStore } from "./catalog";
import { loadModelRuntimeConfig } from "./config";
import {
  modelCredentialRequirement,
  resolveModelHeaders,
} from "./headers";
import type {
  CatalogModelSpec,
  ModelAdapterFactory,
  ModelApi,
  ModelCatalogCheckSummary,
  ModelCatalogStoreFile,
  ModelCredentialRequirement,
  ModelHeaderValue,
  ModelRef,
  ModelRequestCompatibility,
  ModelRuntimeConfig,
  ModelSpec,
  ProviderProfile,
  ResolvedModel,
} from "./types";
import { formatModelRef } from "./types";

export interface CreateModelRuntimeOptions {
  readonly storeRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly configPath?: string;
  readonly storePath?: string;
  readonly adapterRegistry?: ModelApiAdapterRegistry;
  readonly fetch?: typeof fetch;
}

export interface CreateConfiguredModelClientOptions extends CreateModelRuntimeOptions {
  readonly maxRetries?: number;
  readonly baseRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
}

export interface ConfiguredModelClient {
  readonly runtime: ModelRuntime;
  readonly client: RetryingModelClient;
}

export class ModelApiAdapterRegistry {
  private readonly factories = new Map<string, ModelAdapterFactory>();

  register(api: ModelApi, factory: ModelAdapterFactory): this {
    const normalized = requiredNonBlank(api, "model api");
    if (this.factories.has(normalized)) {
      throw new Error(`Model API adapter is already registered: ${normalized}`);
    }
    this.factories.set(normalized, factory);
    return this;
  }

  create(model: ResolvedModel): ModelProviderAdapter {
    const factory = this.factories.get(model.api);
    if (factory === undefined) {
      throw new Error(
        `No model API adapter registered for ${model.api} (${formatModelRef(model.ref)})`,
      );
    }
    return factory(model);
  }

  has(api: ModelApi): boolean {
    return this.factories.has(api);
  }
}

export function createDefaultModelApiAdapterRegistry(
  env: NodeJS.ProcessEnv = process.env,
): ModelApiAdapterRegistry {
  return new ModelApiAdapterRegistry().register(
    "openai-chat-completions",
    (model) => {
      const apiKey = model.apiKeyEnv === undefined
        ? undefined
        : env[model.apiKeyEnv];
      return new OpenAICompatibleProviderAdapter({
        providerId: model.ref.provider,
        auth: model.auth,
        ...(model.apiKeyEnv === undefined
          ? {}
          : { apiKeyEnvVar: model.apiKeyEnv }),
        ...(apiKey === undefined ? {} : { apiKey }),
        baseUrl: model.baseUrl,
        model: model.ref.model,
        developerRoleMode: model.developerRoleMode,
        headers: model.headers,
        request: model.request,
      });
    },
  ).register("anthropic-messages", (model) =>
    new AnthropicMessagesProviderAdapter({
      providerId: model.ref.provider,
      baseUrl: model.baseUrl,
      model: model.ref.model,
      headers: model.headers,
      developerRoleMode: model.developerRoleMode,
      ...(model.spec.maxOutputTokens === undefined
        ? {}
        : { defaultMaxOutputTokens: model.spec.maxOutputTokens }),
      request: model.request,
    })
  );
}

export class ModelRuntime implements ModelProviderAdapter {
  private activeRef: ModelRef;
  private storeFile: ModelCatalogStoreFile;

  private constructor(
    readonly config: ModelRuntimeConfig,
    private readonly catalogStore: FileModelCatalogStore,
    storeFile: ModelCatalogStoreFile,
    private readonly adapterRegistry: ModelApiAdapterRegistry,
    private readonly env: NodeJS.ProcessEnv,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.activeRef = config.defaultModel;
    this.storeFile = storeFile;
    for (const provider of config.providers) {
      if (!adapterRegistry.has(provider.api)) {
        throw new Error(
          `Provider ${provider.id} uses unsupported model API: ${provider.api}`,
        );
      }
      for (const model of provider.models) {
        if (model.api !== undefined && !adapterRegistry.has(model.api)) {
          throw new Error(
            `Model ${provider.id}/${model.id} uses unsupported model API: ${model.api}`,
          );
        }
      }
    }
    this.assertModelExists(this.activeRef);
  }

  static async create(options: CreateModelRuntimeOptions): Promise<ModelRuntime> {
    const env = options.env ?? process.env;
    const config = await loadModelRuntimeConfig({
      storeRoot: options.storeRoot,
      env,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.storePath === undefined ? {} : { storePath: options.storePath }),
    });
    const catalogStore = new FileModelCatalogStore(config.storePath);
    const storeFile = await catalogStore.read();
    return new ModelRuntime(
      config,
      catalogStore,
      storeFile,
      options.adapterRegistry ?? createDefaultModelApiAdapterRegistry(env),
      env,
      options.fetch ?? fetch,
    );
  }

  async *stream(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    let resolved: ResolvedModel;
    try {
      resolved = this.resolveRequest(request);
    } catch (error: unknown) {
      yield {
        type: "error",
        error: {
          code: "invalid_request",
          message: errorMessage(error),
          retryable: false,
        },
      };
      return;
    }
    const adapter = this.adapterRegistry.create(resolved);
    const { modelRef: _modelRef, ...adapterRequest } = request;
    yield* adapter.stream(
      { ...adapterRequest, model: resolved.ref.model },
      signal,
    );
  }

  activeModel(): ResolvedModel {
    return this.resolve(this.activeRef);
  }

  activeModelRef(): ModelRef {
    return this.activeRef;
  }

  resolveModel(ref: ModelRef): ResolvedModel {
    return this.resolve(ref);
  }

  selectModel(selection: string | ModelRef): ResolvedModel {
    const ref = typeof selection === "string"
      ? this.parseModelRef(selection)
      : normalizeModelRef(selection);
    const resolved = this.resolve(ref);
    this.activeRef = ref;
    return resolved;
  }

  parseModelRef(value: string): ModelRef {
    const normalized = requiredNonBlank(value, "model ref");
    const slash = normalized.indexOf("/");
    if (slash < 1) {
      return {
        provider: this.activeRef.provider,
        model: normalized,
      };
    }
    return normalizeModelRef({
      provider: normalized.slice(0, slash),
      model: normalized.slice(slash + 1),
    });
  }

  fallbackModels(): readonly ModelRef[] {
    return this.config.fallbackModels;
  }

  providers(): readonly ProviderProfile[] {
    return this.config.providers;
  }

  listModels(): readonly CatalogModelSpec[] {
    return this.config.providers.flatMap((provider) =>
      this.providerModels(provider)
    );
  }

  minimumKnownContextWindow(fallback: number): number {
    const values = this.listModels()
      .map((model) => model.contextWindow)
      .filter((value): value is number => value !== undefined);
    return values.length === 0 ? fallback : Math.min(...values);
  }

  credentialRequirement(
    ref: ModelRef = this.activeRef,
  ): ModelCredentialRequirement {
    const provider = this.provider(ref.provider);
    const base = modelCredentialRequirement(provider, this.env);
    const spec = this.modelSpec(provider, ref.model);
    const headers = { ...provider.headers, ...(spec.headers ?? {}) };
    const headerCredentialsConfigured = Object.values(headers).every((value) =>
      typeof value === "string" || nonBlank(this.env[value.env]) !== undefined
    );
    return {
      ...base,
      configured: base.configured && headerCredentialsConfigured,
    };
  }

  async checkCatalogs(signal?: AbortSignal): Promise<ModelCatalogCheckSummary> {
    return checkModelCatalogs({
      providers: this.config.providers,
      store: this.catalogStore,
      env: this.env,
      fetch: this.fetchImpl,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async syncCatalogs(signal?: AbortSignal): Promise<ModelCatalogCheckSummary> {
    const result = await checkModelCatalogs({
      providers: this.config.providers,
      store: this.catalogStore,
      env: this.env,
      fetch: this.fetchImpl,
      write: true,
      ...(signal === undefined ? {} : { signal }),
    });
    this.storeFile = await this.catalogStore.read();
    return result;
  }

  private resolveRequest(request: ModelRequest): ResolvedModel {
    if (request.modelRef !== undefined) {
      return this.resolve(request.modelRef);
    }
    if (request.model !== undefined) {
      return this.resolve({
        provider: this.activeRef.provider,
        model: request.model,
      });
    }
    return this.resolve(this.activeRef);
  }

  private resolve(refValue: ModelRef): ResolvedModel {
    const ref = normalizeModelRef(refValue);
    const provider = this.provider(ref.provider);
    const merged = this.modelSpec(provider, ref.model);
    const headers = {
      ...provider.headers,
      ...(merged.headers ?? {}),
    };
    const request = mergeRequestCompatibility(provider.request, merged.request);
    return {
      ref,
      api: merged.api ?? provider.api,
      baseUrl: removeTrailingSlash(merged.baseUrl ?? provider.baseUrl),
      ...(provider.apiKeyEnv === undefined
        ? {}
        : { apiKeyEnv: provider.apiKeyEnv }),
      auth: provider.auth ?? "bearer",
      headers: resolveModelHeaders(headers, this.env),
      developerRoleMode:
        merged.developerRoleMode ?? provider.developerRoleMode,
      request,
      spec: merged,
    };
  }

  private provider(id: string): ProviderProfile {
    const provider = this.config.providers.find((item) => item.id === id);
    if (provider === undefined) {
      throw new Error(`Unknown model provider: ${id}`);
    }
    return provider;
  }

  private assertModelExists(refValue: ModelRef): void {
    const ref = normalizeModelRef(refValue);
    const provider = this.provider(ref.provider);
    this.modelSpec(provider, ref.model);
  }

  private providerModels(provider: ProviderProfile): readonly CatalogModelSpec[] {
    const cachedProvider = this.storeFile.providers[provider.id];
    const ids = new Set<string>([
      provider.defaultModel,
      ...provider.models.map((model) => model.id),
      ...(cachedProvider?.models.map((model) => model.id) ?? []),
    ]);
    return [...ids]
      .sort((left, right) => left.localeCompare(right))
      .map((model) => this.modelSpec(provider, model));
  }

  private modelSpec(provider: ProviderProfile, model: string): CatalogModelSpec {
    const configured = provider.models.find((item) => item.id === model);
    const cachedProvider = this.storeFile.providers[provider.id];
    const cached = cachedProvider?.models.find((item) => item.id === model);
    const merged = mergeModelSpecs(cached, configured, model);
    const source = configured !== undefined
      ? "configured"
      : cached !== undefined
        ? "cache"
        : this.config.configPath === undefined
          ? "legacy"
          : "configured";
    return {
      ...merged,
      provider: provider.id,
      source,
      ...(cachedProvider?.checkedAt === undefined
        ? {}
        : { checkedAt: cachedProvider.checkedAt }),
      ...(cachedProvider?.fetchedAt === undefined
        ? {}
        : { fetchedAt: cachedProvider.fetchedAt }),
    };
  }
}

export async function createConfiguredModelClient(
  options: CreateConfiguredModelClientOptions,
): Promise<ConfiguredModelClient> {
  const runtime = await ModelRuntime.create(options);
  const env = options.env ?? process.env;
  const client = new RetryingModelClient(runtime, {
    maxRetries:
      options.maxRetries ?? readNonNegativeInteger(env.MODEL_MAX_RETRIES, 2),
    fallbackModels: runtime.fallbackModels(),
    baseRetryDelayMs:
      options.baseRetryDelayMs ??
      readPositiveInteger(env.MODEL_RETRY_BASE_DELAY_MS, 500),
    maxRetryDelayMs:
      options.maxRetryDelayMs ??
      readPositiveInteger(env.MODEL_RETRY_MAX_DELAY_MS, 8000),
  });
  return { runtime, client };
}

function mergeModelSpecs(
  cached: ModelSpec | undefined,
  configured: ModelSpec | undefined,
  id: string,
): ModelSpec {
  return {
    id,
    ...(cached ?? {}),
    ...(configured ?? {}),
    status: configured?.status ??
      (configured === undefined ? cached?.status ?? "unknown" : "active"),
    ...mergeOptionalHeaders(cached?.headers, configured?.headers),
    ...mergeOptionalRequest(cached?.request, configured?.request),
  };
}

function mergeRequestCompatibility(
  base: ModelRequestCompatibility,
  override: ModelRequestCompatibility | undefined,
): ModelRequestCompatibility {
  return {
    ...base,
    ...(override ?? {}),
    ...((base.extraBody === undefined && override?.extraBody === undefined)
      ? {}
      : {
          extraBody: {
            ...(base.extraBody ?? {}),
            ...(override?.extraBody ?? {}),
          },
        }),
  };
}

function mergeOptionalHeaders(
  base: Readonly<Record<string, ModelHeaderValue>> | undefined,
  override: Readonly<Record<string, ModelHeaderValue>> | undefined,
): { readonly headers: Readonly<Record<string, ModelHeaderValue>> } | object {
  if (base === undefined && override === undefined) {
    return {};
  }
  return { headers: { ...(base ?? {}), ...(override ?? {}) } };
}

function mergeOptionalRequest(
  base: ModelRequestCompatibility | undefined,
  override: ModelRequestCompatibility | undefined,
): { readonly request: ModelRequestCompatibility } | object {
  if (base === undefined && override === undefined) {
    return {};
  }
  return { request: mergeRequestCompatibility(base ?? {}, override) };
}

function normalizeModelRef(ref: ModelRef): ModelRef {
  return {
    provider: requiredNonBlank(ref.provider, "model provider"),
    model: requiredNonBlank(ref.model, "model id"),
  };
}

function requiredNonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

function removeTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function nonBlank(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function readNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value.trim()) {
    throw new Error("MODEL_MAX_RETRIES must be a non-negative integer");
  }
  return parsed;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value.trim()) {
    throw new Error("Model retry delay must be a positive integer");
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type RuntimeModelClient = ModelClient & {
  readonly runtime?: ModelRuntime;
};
