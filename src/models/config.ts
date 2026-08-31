import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { DeveloperRoleMode } from "../agent/model";
import type {
  ModelHeaderValue,
  ModelRef,
  ModelRequestCompatibility,
  ModelRuntimeConfig,
  ModelSpec,
  ProviderCatalogConfig,
  ProviderProfile,
} from "./types";

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface LoadModelRuntimeConfigOptions {
  readonly storeRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly configPath?: string;
  readonly storePath?: string;
}

export async function loadModelRuntimeConfig(
  options: LoadModelRuntimeConfigOptions,
): Promise<ModelRuntimeConfig> {
  const env = options.env ?? process.env;
  const configPath = path.resolve(
    options.configPath ??
      nonBlank(env.PIBOT_MODELS_CONFIG) ??
      path.join(options.storeRoot, "models.json"),
  );
  const storePath = path.resolve(
    options.storePath ??
      nonBlank(env.PIBOT_MODELS_STORE) ??
      path.join(options.storeRoot, "models-store.json"),
  );
  const parsed = await readOptionalJson(configPath);
  if (parsed === undefined) {
    return legacyModelRuntimeConfig(env, storePath);
  }
  return parseModelRuntimeConfig(parsed, configPath, storePath, env);
}

function legacyModelRuntimeConfig(
  env: NodeJS.ProcessEnv,
  storePath: string,
): ModelRuntimeConfig {
  const provider: ProviderProfile = {
    id: "openai",
    api: "openai-chat-completions",
    baseUrl: nonBlank(env.OPENAI_BASE_URL) ?? "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    auth: "bearer",
    defaultModel: nonBlank(env.OPENAI_MODEL) ?? "gpt-4o-mini",
    developerRoleMode: developerRoleMode(
      nonBlank(env.OPENAI_DEVELOPER_ROLE_MODE),
      "OPENAI_DEVELOPER_ROLE_MODE",
    ),
    headers: {},
    request: {},
    catalog: { type: "models-api" },
    models: [],
  };
  const defaultModel = parseConfiguredModelRef(
    nonBlank(env.PIBOT_MODEL),
    provider.id,
    [provider],
  ) ?? { provider: provider.id, model: provider.defaultModel };
  return {
    version: 1,
    defaultModel,
    fallbackModels: parseFallbackModels(
      nonBlank(env.PIBOT_FALLBACK_MODELS) ??
        nonBlank(env.OPENAI_FALLBACK_MODELS),
      provider.id,
      [provider],
    ),
    providers: [provider],
    storePath,
  };
}

function parseModelRuntimeConfig(
  value: unknown,
  configPath: string,
  storePath: string,
  env: NodeJS.ProcessEnv,
): ModelRuntimeConfig {
  const root = record(value, "model config");
  const version = optionalNumber(root, "version") ?? 1;
  if (version !== 1) {
    throw new Error(`model config.version must be 1; received ${version}`);
  }
  const providersValue = record(root.providers, "model config.providers");
  const providers = Object.entries(providersValue).map(([id, raw]) =>
    parseProviderProfile(id, raw, env)
  );
  if (providers.length === 0) {
    throw new Error("model config.providers must contain at least one provider");
  }
  const providerIds = new Set(providers.map((provider) => provider.id));
  if (providerIds.size !== providers.length) {
    throw new Error("model config provider ids must be unique");
  }
  const defaultProvider = nonBlank(env.PIBOT_MODEL_PROVIDER) ??
    optionalString(root, "defaultProvider") ??
    providers[0]?.id;
  if (defaultProvider === undefined || !providerIds.has(defaultProvider)) {
    throw new Error(`Unknown default model provider: ${defaultProvider ?? "<empty>"}`);
  }
  const provider = providers.find((item) => item.id === defaultProvider);
  if (provider === undefined) {
    throw new Error(`Unknown default model provider: ${defaultProvider}`);
  }
  const configuredDefault =
    nonBlank(env.PIBOT_MODEL) ?? optionalString(root, "defaultModel");
  const defaultModel = parseConfiguredModelRef(
    configuredDefault,
    defaultProvider,
    providers,
  ) ?? { provider: defaultProvider, model: provider.defaultModel };
  const configuredFallbacks =
    nonBlank(env.PIBOT_FALLBACK_MODELS) ??
    nonBlank(env.OPENAI_FALLBACK_MODELS);
  const fallbackModels = configuredFallbacks === undefined
    ? parseModelRefArray(root.fallbackModels, defaultProvider, providers)
    : parseFallbackModels(configuredFallbacks, defaultProvider, providers);
  return {
    version: 1,
    defaultModel,
    fallbackModels,
    providers,
    configPath,
    storePath,
  };
}

function parseProviderProfile(
  id: string,
  value: unknown,
  env: NodeJS.ProcessEnv,
): ProviderProfile {
  const input = record(value, `provider ${id}`);
  const normalizedId = requiredNonBlank(id, "provider id");
  const baseUrlEnv = optionalString(input, "baseUrlEnv");
  const configuredBaseUrl = baseUrlEnv === undefined
    ? undefined
    : nonBlank(env[baseUrlEnv]);
  const baseUrl = configuredBaseUrl ?? optionalString(input, "baseUrl");
  if (baseUrl === undefined) {
    throw new Error(
      `provider ${id}.baseUrl is required when ${baseUrlEnv ?? "baseUrlEnv"} is not configured`,
    );
  }
  const auth = optionalString(input, "auth") ?? "bearer";
  if (auth !== "bearer" && auth !== "none") {
    throw new Error(`provider ${id}.auth must be bearer or none`);
  }
  const apiKeyEnv = optionalString(input, "apiKeyEnv");
  if (auth === "bearer" && apiKeyEnv === undefined) {
    throw new Error(`provider ${id}.apiKeyEnv is required for bearer auth`);
  }
  const defaultModel = optionalString(input, "defaultModel");
  if (defaultModel === undefined) {
    throw new Error(`provider ${id}.defaultModel is required`);
  }
  return {
    id: normalizedId,
    api: optionalString(input, "api") ?? "openai-chat-completions",
    baseUrl: removeTrailingSlash(baseUrl),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    auth,
    defaultModel,
    developerRoleMode: developerRoleMode(
      optionalString(input, "developerRoleMode"),
      `provider ${id}.developerRoleMode`,
    ),
    headers: parseHeaders(input.headers, `provider ${id}.headers`),
    request: parseRequestCompatibility(
      input.request,
      `provider ${id}.request`,
    ),
    ...optionalCatalog("catalog", parseCatalog(input.catalog, id)),
    models: parseModels(input.models, id),
  };
}

function parseModels(value: unknown, provider: string): readonly ModelSpec[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`provider ${provider}.models must be an array`);
  }
  const models = value.map((item, index) => {
    if (typeof item === "string") {
      return { id: requiredNonBlank(item, `provider ${provider}.models[${index}]`) };
    }
    const model = record(item, `provider ${provider}.models[${index}]`);
    const id = optionalString(model, "id");
    if (id === undefined) {
      throw new Error(`provider ${provider}.models[${index}].id is required`);
    }
    const status = optionalString(model, "status");
    if (status !== undefined && !["active", "deprecated", "unknown"].includes(status)) {
      throw new Error(`provider ${provider} model ${id}.status is invalid`);
    }
    const input = optionalStringArray(model.input, `provider ${provider} model ${id}.input`);
    if (input?.some((kind) => kind !== "text" && kind !== "image") === true) {
      throw new Error(`provider ${provider} model ${id}.input supports text or image`);
    }
    return {
      id,
      ...optionalStringProperty("name", optionalString(model, "name")),
      ...optionalStringProperty("status", status as ModelSpec["status"]),
      ...optionalPositiveInteger("contextWindow", model.contextWindow, provider, id),
      ...optionalPositiveInteger("maxOutputTokens", model.maxOutputTokens, provider, id),
      ...(input === undefined ? {} : { input: input as readonly ("text" | "image")[] }),
      ...optionalBooleanProperty("reasoning", optionalBoolean(model, "reasoning")),
      ...optionalBooleanProperty("tools", optionalBoolean(model, "tools")),
      ...optionalPricing(model.pricing, provider, id),
      ...optionalStringProperty("api", optionalString(model, "api")),
      ...optionalStringProperty("baseUrl", optionalString(model, "baseUrl")),
      ...optionalHeaders("headers", parseHeaders(model.headers, `provider ${provider} model ${id}.headers`)),
      ...optionalDeveloperRoleMode(
        "developerRoleMode",
        model.developerRoleMode,
        `provider ${provider} model ${id}.developerRoleMode`,
      ),
      ...optionalRequest(
        "request",
        parseRequestCompatibility(model.request, `provider ${provider} model ${id}.request`),
      ),
    } satisfies ModelSpec;
  });
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) {
      throw new Error(`provider ${provider} contains duplicate model ${model.id}`);
    }
    ids.add(model.id);
  }
  return models;
}

function parseCatalog(
  value: unknown,
  provider: string,
): ProviderCatalogConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  const input = record(value, `provider ${provider}.catalog`);
  const type = optionalString(input, "type") ?? "models-api";
  if (type !== "models-api" && type !== "openai-models") {
    throw new Error(`provider ${provider}.catalog.type must be models-api`);
  }
  return {
    type,
    ...optionalBooleanProperty("enabled", optionalBoolean(input, "enabled")),
    ...optionalStringProperty("url", optionalString(input, "url")),
  };
}

function parseRequestCompatibility(
  value: unknown,
  label: string,
): ModelRequestCompatibility {
  if (value === undefined) {
    return {};
  }
  const input = record(value, label);
  const maxTokensField = optionalString(input, "maxTokensField");
  if (
    maxTokensField !== undefined &&
    maxTokensField !== "max_tokens" &&
    maxTokensField !== "max_completion_tokens"
  ) {
    throw new Error(`${label}.maxTokensField is invalid`);
  }
  const extraBody = input.extraBody === undefined
    ? undefined
    : record(input.extraBody, `${label}.extraBody`);
  return {
    ...optionalBooleanProperty("streamUsage", optionalBoolean(input, "streamUsage")),
    ...optionalBooleanProperty(
      "supportsTemperature",
      optionalBoolean(input, "supportsTemperature"),
    ),
    ...optionalStringProperty("maxTokensField", maxTokensField as ModelRequestCompatibility["maxTokensField"]),
    ...(extraBody === undefined ? {} : { extraBody }),
  };
}

function parseHeaders(
  value: unknown,
  label: string,
): Readonly<Record<string, ModelHeaderValue>> {
  if (value === undefined) {
    return {};
  }
  const input = record(value, label);
  const output: Record<string, ModelHeaderValue> = {};
  for (const [name, raw] of Object.entries(input)) {
    const normalizedName = requiredNonBlank(name, `${label} header name`);
    if (typeof raw === "string") {
      output[normalizedName] = raw;
      continue;
    }
    const envRef = record(raw, `${label}.${name}`);
    const envName = optionalString(envRef, "env");
    if (envName === undefined || Object.keys(envRef).length !== 1) {
      throw new Error(`${label}.${name} must be a string or { "env": "NAME" }`);
    }
    output[normalizedName] = { env: envName };
  }
  return output;
}

function parseConfiguredModelRef(
  value: string | undefined,
  defaultProvider: string,
  providers: readonly ProviderProfile[],
): ModelRef | undefined {
  if (value === undefined) {
    return undefined;
  }
  const slash = value.indexOf("/");
  if (slash < 1) {
    return { provider: defaultProvider, model: requiredNonBlank(value, "model") };
  }
  const provider = value.slice(0, slash);
  const model = value.slice(slash + 1);
  if (!providers.some((item) => item.id === provider)) {
    throw new Error(`Unknown model provider in ${value}: ${provider}`);
  }
  return {
    provider,
    model: requiredNonBlank(model, `model ref ${value}`),
  };
}

function parseModelRefArray(
  value: unknown,
  defaultProvider: string,
  providers: readonly ProviderProfile[],
): readonly ModelRef[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("model config.fallbackModels must be an array of strings");
  }
  return distinctRefs(
    value.map((item) => parseConfiguredModelRef(item, defaultProvider, providers)),
  );
}

function parseFallbackModels(
  value: string | undefined,
  defaultProvider: string,
  providers: readonly ProviderProfile[],
): readonly ModelRef[] {
  if (value === undefined) {
    return [];
  }
  return distinctRefs(
    value.split(",").map((item) =>
      parseConfiguredModelRef(nonBlank(item), defaultProvider, providers)
    ),
  );
}

function distinctRefs(refs: readonly (ModelRef | undefined)[]): readonly ModelRef[] {
  const result: ModelRef[] = [];
  for (const ref of refs) {
    if (
      ref !== undefined &&
      !result.some((item) => item.provider === ref.provider && item.model === ref.model)
    ) {
      result.push(ref);
    }
  }
  return result;
}

async function readOptionalJson(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in model config ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function optionalString(input: UnknownRecord, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalNumber(input: UnknownRecord, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number`);
  }
  return value;
}

function optionalBoolean(input: UnknownRecord, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function optionalStringArray(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function optionalPositiveInteger(
  key: "contextWindow" | "maxOutputTokens",
  value: unknown,
  provider: string,
  model: string,
): Readonly<Record<string, number>> | object {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`provider ${provider} model ${model}.${key} must be a positive integer`);
  }
  return { [key]: value };
}

function optionalPricing(
  value: unknown,
  provider: string,
  model: string,
): { readonly pricing: NonNullable<ModelSpec["pricing"]> } | object {
  if (value === undefined) {
    return {};
  }
  const input = record(value, `provider ${provider} model ${model}.pricing`);
  const currency = optionalString(input, "currency");
  const inputCost = finiteNonNegativeNumber(input.inputPerMillionTokens);
  const outputCost = finiteNonNegativeNumber(input.outputPerMillionTokens);
  const cachedCost = finiteNonNegativeNumber(input.cachedInputPerMillionTokens, true);
  if (
    (currency !== "CNY" && currency !== "USD") ||
    inputCost === undefined ||
    outputCost === undefined
  ) {
    throw new Error(`provider ${provider} model ${model}.pricing is incomplete`);
  }
  return {
    pricing: {
      currency,
      inputPerMillionTokens: inputCost,
      outputPerMillionTokens: outputCost,
      ...(cachedCost === undefined ? {} : { cachedInputPerMillionTokens: cachedCost }),
    },
  };
}

function finiteNonNegativeNumber(value: unknown, optional = false): number | undefined {
  if (value === undefined && optional) {
    return undefined;
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function developerRoleMode(
  value: string | undefined,
  label: string,
): DeveloperRoleMode {
  const resolved = value ?? "native";
  if (resolved !== "native" && resolved !== "system-fallback") {
    throw new Error(`${label} must be native or system-fallback`);
  }
  return resolved;
}

function optionalDeveloperRoleMode<Key extends string>(
  key: Key,
  value: unknown,
  label: string,
): { readonly [Property in Key]: DeveloperRoleMode } | object {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be native or system-fallback`);
  }
  return { [key]: developerRoleMode(value, label) } as {
    readonly [Property in Key]: DeveloperRoleMode;
  };
}

function optionalStringProperty<Key extends string, Value extends string>(
  key: Key,
  value: Value | undefined,
): { readonly [Property in Key]: Value } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: Value;
  };
}

function optionalBooleanProperty<Key extends string>(
  key: Key,
  value: boolean | undefined,
): { readonly [Property in Key]: boolean } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: boolean;
  };
}

function optionalHeaders<Key extends string>(
  key: Key,
  value: Readonly<Record<string, ModelHeaderValue>>,
): { readonly [Property in Key]: Readonly<Record<string, ModelHeaderValue>> } | object {
  return Object.keys(value).length === 0 ? {} : { [key]: value } as {
    readonly [Property in Key]: Readonly<Record<string, ModelHeaderValue>>;
  };
}

function optionalRequest<Key extends string>(
  key: Key,
  value: ModelRequestCompatibility,
): { readonly [Property in Key]: ModelRequestCompatibility } | object {
  return Object.keys(value).length === 0 ? {} : { [key]: value } as {
    readonly [Property in Key]: ModelRequestCompatibility;
  };
}

function optionalCatalog<Key extends string>(
  key: Key,
  value: ProviderCatalogConfig | undefined,
): { readonly [Property in Key]: ProviderCatalogConfig } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: ProviderCatalogConfig;
  };
}

function requiredNonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

function nonBlank(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function removeTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
