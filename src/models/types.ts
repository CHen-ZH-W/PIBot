import type { DeveloperRoleMode, ModelProviderAdapter } from "../agent/model";

export type ModelApi = "openai-chat-completions" | (string & {});
export type ModelStatus = "active" | "deprecated" | "unknown";
export type ModelCatalogSource = "configured" | "provider" | "cache" | "legacy";

export interface ModelRef {
  readonly provider: string;
  readonly model: string;
}

export interface ModelPricing {
  readonly currency: "CNY" | "USD";
  readonly inputPerMillionTokens: number;
  readonly cachedInputPerMillionTokens?: number;
  readonly outputPerMillionTokens: number;
}

export interface ModelRequestCompatibility {
  readonly streamUsage?: boolean;
  readonly supportsTemperature?: boolean;
  readonly maxTokensField?: "max_tokens" | "max_completion_tokens";
  readonly extraBody?: Readonly<Record<string, unknown>>;
}

export interface ModelSpec {
  readonly id: string;
  readonly name?: string;
  readonly status?: ModelStatus;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly input?: readonly ("text" | "image")[];
  readonly reasoning?: boolean;
  readonly tools?: boolean;
  readonly pricing?: ModelPricing;
  readonly api?: ModelApi;
  readonly baseUrl?: string;
  readonly headers?: Readonly<Record<string, ModelHeaderValue>>;
  readonly developerRoleMode?: DeveloperRoleMode;
  readonly request?: ModelRequestCompatibility;
}

export type ModelHeaderValue = string | {
  readonly env: string;
};

export interface ProviderCatalogConfig {
  readonly type: "models-api" | "openai-models";
  readonly enabled?: boolean;
  readonly url?: string;
}

export interface ProviderProfile {
  readonly id: string;
  readonly api: ModelApi;
  readonly baseUrl: string;
  readonly apiKeyEnv?: string;
  readonly auth?: "bearer" | "none";
  readonly defaultModel: string;
  readonly developerRoleMode: DeveloperRoleMode;
  readonly headers: Readonly<Record<string, ModelHeaderValue>>;
  readonly request: ModelRequestCompatibility;
  readonly catalog?: ProviderCatalogConfig;
  readonly models: readonly ModelSpec[];
}

export interface ModelRuntimeConfig {
  readonly version: 1;
  readonly defaultModel: ModelRef;
  readonly fallbackModels: readonly ModelRef[];
  readonly providers: readonly ProviderProfile[];
  readonly configPath?: string;
  readonly storePath: string;
}

export interface ModelCatalogMetadata {
  readonly source: ModelCatalogSource;
  readonly checkedAt?: string;
  readonly fetchedAt?: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly lastError?: string;
}

export interface CatalogModelSpec extends ModelSpec {
  readonly provider: string;
  readonly source: ModelCatalogSource;
  readonly checkedAt?: string;
  readonly fetchedAt?: string;
}

export interface StoredProviderCatalog {
  readonly provider: string;
  readonly checkedAt: string;
  readonly fetchedAt?: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly lastError?: string;
  readonly models: readonly ModelSpec[];
}

export interface ModelCatalogStoreFile {
  readonly version: 1;
  readonly providers: Readonly<Record<string, StoredProviderCatalog>>;
}

export interface ResolvedModel {
  readonly ref: ModelRef;
  readonly api: ModelApi;
  readonly baseUrl: string;
  readonly apiKeyEnv?: string;
  readonly auth: "bearer" | "none";
  readonly headers: Readonly<Record<string, string>>;
  readonly developerRoleMode: DeveloperRoleMode;
  readonly request: ModelRequestCompatibility;
  readonly spec: CatalogModelSpec;
}

export type ModelAdapterFactory = (model: ResolvedModel) => ModelProviderAdapter;

export interface ProviderCatalogCheckResult {
  readonly provider: string;
  readonly status: "unchanged" | "changed" | "error" | "disabled";
  readonly checkedAt: string;
  readonly sourceUrl?: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly updated: readonly string[];
  readonly models: readonly ModelSpec[];
  readonly etag?: string;
  readonly lastModified?: string;
  readonly notModified?: boolean;
  readonly error?: string;
}

export interface ModelCatalogCheckSummary {
  readonly checkedAt: string;
  readonly synchronized: boolean;
  readonly results: readonly ProviderCatalogCheckResult[];
}

export interface ModelCredentialRequirement {
  readonly provider: string;
  readonly auth: "bearer" | "none";
  readonly apiKeyEnv?: string;
  readonly configured: boolean;
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

export function modelRefEquals(left: ModelRef, right: ModelRef): boolean {
  return left.provider === right.provider && left.model === right.model;
}
