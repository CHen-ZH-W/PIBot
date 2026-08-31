import type {
  ModelCredentialRequirement,
  ModelHeaderValue,
  ProviderProfile,
} from "./types";

export function resolveModelHeaders(
  headers: Readonly<Record<string, ModelHeaderValue>>,
  env: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      resolved[name] = value;
      continue;
    }
    const envValue = nonBlank(env[value.env]);
    if (envValue === undefined) {
      throw new Error(`Missing required model header environment variable: ${value.env}`);
    }
    resolved[name] = envValue;
  }
  return resolved;
}

export function modelCredentialRequirement(
  provider: ProviderProfile,
  env: NodeJS.ProcessEnv = process.env,
): ModelCredentialRequirement {
  const auth = provider.auth ?? "bearer";
  const apiKeyEnv = provider.apiKeyEnv;
  return {
    provider: provider.id,
    auth,
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    configured:
      auth === "none" ||
      (apiKeyEnv !== undefined && nonBlank(env[apiKeyEnv]) !== undefined),
  };
}

export function providerRequestHeaders(
  provider: ProviderProfile,
  headers: Readonly<Record<string, ModelHeaderValue>> = provider.headers,
  env: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const resolved = { ...resolveModelHeaders(headers, env) };
  if ((provider.auth ?? "bearer") === "bearer") {
    const envName = provider.apiKeyEnv;
    const apiKey = envName === undefined ? undefined : nonBlank(env[envName]);
    if (envName === undefined || apiKey === undefined) {
      throw new Error(
        `Missing required model credential: ${envName ?? `provider ${provider.id} apiKeyEnv`}`,
      );
    }
    if (!hasHeader(resolved, "authorization")) {
      resolved.authorization = `Bearer ${apiKey}`;
    }
  }
  return resolved;
}

function hasHeader(headers: Readonly<Record<string, string>>, name: string): boolean {
  const normalized = name.toLowerCase();
  return Object.keys(headers).some((header) => header.toLowerCase() === normalized);
}

function nonBlank(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
