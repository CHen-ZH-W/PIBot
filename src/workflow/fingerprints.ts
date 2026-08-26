import { createHash } from "node:crypto";

export function fingerprintCanonical(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

export function fingerprintError(input: {
  readonly stepKind: string;
  readonly errorCode?: string;
  readonly checkName?: string;
  readonly message: string;
}): string {
  return fingerprintCanonical({
    stepKind: input.stepKind,
    errorCode: input.errorCode ?? "unknown",
    checkName: input.checkName ?? "unknown",
    message: normalizeErrorText(input.message),
  });
}

export function fingerprintStrategy(
  strategy: Readonly<Record<string, unknown>>,
): string {
  return fingerprintCanonical(strategy);
}

export function fingerprintContext(input: {
  readonly workspaceRoot?: string;
  readonly baseRevision?: string;
  readonly workflowVersion?: string;
  readonly runtimeVersion?: string;
}): string {
  return fingerprintCanonical({
    workspaceRoot: input.workspaceRoot,
    baseRevision: input.baseRevision,
    workflowVersion: input.workflowVersion,
    runtimeVersion: input.runtimeVersion,
  });
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeErrorText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/giu, "<uuid>")
    .replace(/\b(?:run|attempt|sig|evo)_[a-z0-9_-]+\b/giu, "<id>")
    .replace(/\/[^\s:]+\.pibot-evolution-workspaces\/[^\s:]+/gu, "<workspace>")
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z\b/giu, "<timestamp>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 4000);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const nested = (value as Record<string, unknown>)[key];
    if (nested !== undefined) {
      result[key] = canonicalize(nested);
    }
  }
  return result;
}

