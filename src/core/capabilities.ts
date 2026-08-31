import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { ToolCallId } from "./ids";

export type ToolCapabilityKind =
  | "filesystem.read"
  | "filesystem.write"
  | "process.exec"
  | "network.connect"
  | "external.side_effect"
  | "runtime.read"
  | "runtime.control";

export type ToolCapabilityRequirement =
  | {
      readonly capability: "filesystem.read";
      /** Workspace-relative paths. Each path grants access to itself and descendants. */
      readonly paths: readonly string[];
    }
  | {
      readonly capability: "filesystem.write";
      /** Workspace-relative paths. Each path grants access to itself and descendants. */
      readonly paths: readonly string[];
    }
  | {
      readonly capability: "process.exec";
      readonly commands?: readonly string[];
    }
  | {
      readonly capability: "network.connect";
      readonly hosts: readonly string[];
    }
  | {
      readonly capability: "external.side_effect";
      readonly resources: readonly string[];
    }
  | {
      readonly capability: "runtime.read";
      readonly resources: readonly string[];
    }
  | {
      readonly capability: "runtime.control";
      readonly resources: readonly string[];
    };

export interface ToolEffectHints {
  readonly destructive?: boolean;
  readonly openWorld?: boolean;
}

/** The least authority a single parsed tool call says it needs. */
export interface ToolCapabilityRequest {
  readonly requirements: readonly ToolCapabilityRequirement[];
  readonly effects?: ToolEffectHints;
}

/** The subset of a request that is not covered by the baseline policy. */
export interface ToolCapabilityDelta {
  readonly requirements: readonly ToolCapabilityRequirement[];
  readonly effects?: ToolEffectHints;
}

/** One-shot authority bound to one tool call and, when present, one runtime state version. */
export interface ToolCapabilityGrant {
  readonly grantId: string;
  readonly callId: ToolCallId;
  readonly callDigest: string;
  readonly request: ToolCapabilityRequest;
  readonly requestDigest: string;
  readonly policyVersion: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly source: "policy" | "runtime-control" | "runtime";
  readonly runtimeStateVersion?: number;
}

export interface ToolCapabilityGrantIssueRequest {
  readonly callId: ToolCallId;
  readonly toolName: string;
  readonly input: unknown;
  readonly request: ToolCapabilityRequest;
  readonly policyVersion: string;
  readonly ttlMs: number;
  readonly source: ToolCapabilityGrant["source"];
  readonly runtimeStateVersion?: number;
}

const activeGrants = new WeakSet<ToolCapabilityGrant>();

export type CapabilityDerivedRisk = "read-only" | "mutating" | "external";

export function capabilityRequestRisk(
  request: ToolCapabilityRequest,
): CapabilityDerivedRisk {
  if (
    request.effects?.openWorld === true ||
    request.requirements.some((item) =>
      item.capability === "network.connect" ||
      item.capability === "external.side_effect"
    )
  ) {
    return "external";
  }
  if (
    request.effects?.destructive === true ||
    request.requirements.some((item) =>
      item.capability === "filesystem.write" ||
      item.capability === "process.exec" ||
      item.capability === "runtime.control"
    )
  ) {
    return "mutating";
  }
  return "read-only";
}

export function legacyToolCapabilityRequest(
  toolName: string,
  risk: CapabilityDerivedRisk,
): ToolCapabilityRequest {
  if (risk === "read-only") {
    return {
      requirements: [{ capability: "runtime.read", resources: [`tool:${toolName}`] }],
    };
  }
  if (risk === "mutating") {
    return {
      requirements: [{ capability: "runtime.control", resources: [`tool:${toolName}`] }],
    };
  }
  return {
    requirements: [
      { capability: "external.side_effect", resources: [`tool:${toolName}`] },
    ],
    effects: { openWorld: true },
  };
}

export function normalizeCapabilityRequest(
  request: ToolCapabilityRequest,
): ToolCapabilityRequest {
  if (request.requirements.length === 0) {
    throw capabilityError(
      "invalid_input",
      "Tool capability request must contain at least one requirement",
    );
  }
  const requirements = request.requirements.map((requirement) => {
    if (
      requirement.capability === "filesystem.read" ||
      requirement.capability === "filesystem.write"
    ) {
      return {
        capability: requirement.capability,
        paths: normalizeValues(requirement.paths, normalizeWorkspaceCapabilityPath),
      };
    }
    if (requirement.capability === "process.exec") {
      return {
        capability: requirement.capability,
        ...(requirement.commands === undefined
          ? {}
          : { commands: normalizeValues(requirement.commands, normalizeResource) }),
      };
    }
    if (requirement.capability === "network.connect") {
      return {
        capability: requirement.capability,
        hosts: normalizeValues(requirement.hosts, normalizeResource),
      };
    }
    return {
      capability: requirement.capability,
      resources: normalizeValues(requirement.resources, normalizeResource),
    };
  });

  return freezeCapabilityRequest({
    requirements,
    ...(request.effects === undefined ? {} : { effects: { ...request.effects } }),
  });
}

export function issueToolCapabilityGrant(
  input: ToolCapabilityGrantIssueRequest,
): ToolCapabilityGrant {
  if (!Number.isInteger(input.ttlMs) || input.ttlMs < 1) {
    throw new Error("Capability grant ttlMs must be a positive integer");
  }
  const request = normalizeCapabilityRequest(input.request);
  const issuedAtMs = Date.now();
  return Object.freeze({
    grantId: randomUUID(),
    callId: input.callId,
    callDigest: toolCapabilityCallDigest(
      input.callId,
      input.toolName,
      input.input,
    ),
    request,
    requestDigest: capabilityRequestDigest(request),
    policyVersion: normalizeResource(input.policyVersion),
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + input.ttlMs).toISOString(),
    source: input.source,
    ...(input.runtimeStateVersion === undefined
      ? {}
      : { runtimeStateVersion: input.runtimeStateVersion }),
  });
}

export async function withActiveToolCapabilityGrant<Output>(
  grant: ToolCapabilityGrant,
  execute: () => Promise<Output>,
): Promise<Output> {
  if (activeGrants.has(grant)) {
    throw capabilityError(
      "permission_denied",
      `Capability grant ${grant.grantId} is already active`,
    );
  }
  activeGrants.add(grant);
  try {
    validateToolCapabilityGrant(grant);
    return await execute();
  } finally {
    activeGrants.delete(grant);
  }
}

export function validateToolCapabilityGrant(
  grant: ToolCapabilityGrant,
  expected?: {
    readonly callId?: ToolCallId;
    readonly callDigest?: string;
    readonly policyVersion?: string;
  },
): void {
  if (grant === undefined || grant === null || typeof grant !== "object") {
    throw capabilityError("permission_denied", "An active capability grant is required");
  }
  if (!activeGrants.has(grant)) {
    throw capabilityError(
      "permission_denied",
      `Capability grant ${grant.grantId} is not active`,
    );
  }
  if (Date.parse(grant.expiresAt) <= Date.now()) {
    throw capabilityError(
      "permission_denied",
      `Capability grant ${grant.grantId} has expired`,
    );
  }
  if (grant.requestDigest !== capabilityRequestDigest(grant.request)) {
    throw capabilityError(
      "permission_denied",
      `Capability grant ${grant.grantId} request digest does not match`,
    );
  }
  if (expected?.callId !== undefined && grant.callId !== expected.callId) {
    throw capabilityError(
      "permission_denied",
      `Capability grant ${grant.grantId} is bound to another call`,
    );
  }
  if (
    expected?.callDigest !== undefined &&
    grant.callDigest !== expected.callDigest
  ) {
    throw capabilityError(
      "permission_denied",
      `Capability grant ${grant.grantId} call digest does not match`,
    );
  }
  if (
    expected?.policyVersion !== undefined &&
    grant.policyVersion !== expected.policyVersion
  ) {
    throw capabilityError(
      "permission_denied",
      `Capability grant ${grant.grantId} policy version is stale`,
    );
  }
}

export function toolCapabilityCallDigest(
  callId: ToolCallId,
  toolName: string,
  input: unknown,
): string {
  return sha256(stableSerialize({ callId, toolName, input }));
}

export function capabilityRequestDigest(request: ToolCapabilityRequest): string {
  const normalized = normalizeCapabilityRequestForDigest(request);
  return sha256(stableSerialize(normalized));
}

export function grantAllowsCapability(
  grant: ToolCapabilityGrant,
  capability: ToolCapabilityKind,
  resource?: string,
): boolean {
  return grant.request.requirements.some((requirement) => {
    if (requirement.capability !== capability) {
      return false;
    }
    if (resource === undefined) {
      return true;
    }
    if (
      requirement.capability === "filesystem.read" ||
      requirement.capability === "filesystem.write"
    ) {
      const normalizedResource = normalizeWorkspaceCapabilityPath(resource);
      return requirement.paths.some((grantedPath) =>
        workspacePathCovers(grantedPath, normalizedResource)
      );
    }
    if (requirement.capability === "process.exec") {
      return requirement.commands === undefined ||
        requirement.commands.some((command) => resourceCovers(command, resource));
    }
    if (requirement.capability === "network.connect") {
      return requirement.hosts.some((host) => resourceCovers(host, resource));
    }
    return requirement.resources.some((item) => resourceCovers(item, resource));
  });
}

export function capabilityKinds(
  request: ToolCapabilityRequest,
): readonly ToolCapabilityKind[] {
  return [...new Set(request.requirements.map((item) => item.capability))];
}

export function normalizeWorkspaceCapabilityPath(value: string): string {
  const portable = value.trim().replace(/\\/gu, "/");
  if (portable.length === 0) {
    throw capabilityError("invalid_input", "Capability path must not be empty");
  }
  if (portable.startsWith("/")) {
    throw capabilityError(
      "permission_denied",
      `Capability path must be workspace-relative: ${value}`,
    );
  }
  const normalized = posix.normalize(portable);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw capabilityError(
      "permission_denied",
      `Capability path escapes workspace: ${value}`,
    );
  }
  return normalized;
}

function workspacePathCovers(granted: string, requested: string): boolean {
  return granted === "." || requested === granted || requested.startsWith(`${granted}/`);
}

function resourceCovers(granted: string, requested: string): boolean {
  return granted === "*" || granted === requested;
}

function normalizeResource(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("Capability resource must not be empty");
  }
  return normalized;
}

function freezeCapabilityRequest(
  request: ToolCapabilityRequest,
): ToolCapabilityRequest {
  for (const requirement of request.requirements) {
    if (
      requirement.capability === "filesystem.read" ||
      requirement.capability === "filesystem.write"
    ) {
      Object.freeze(requirement.paths);
    } else if (requirement.capability === "network.connect") {
      Object.freeze(requirement.hosts);
    } else if (requirement.capability === "process.exec") {
      if (requirement.commands !== undefined) {
        Object.freeze(requirement.commands);
      }
    } else {
      Object.freeze(requirement.resources);
    }
    Object.freeze(requirement);
  }
  Object.freeze(request.requirements);
  if (request.effects !== undefined) {
    Object.freeze(request.effects);
  }
  return Object.freeze(request);
}

function normalizeCapabilityRequestForDigest(
  request: ToolCapabilityRequest,
): ToolCapabilityRequest {
  const normalized = normalizeCapabilityRequest(request);
  const requirements = normalized.requirements
    .map((requirement) => {
      if (
        requirement.capability === "filesystem.read" ||
        requirement.capability === "filesystem.write"
      ) {
        return { ...requirement, paths: [...requirement.paths].sort() };
      }
      if (requirement.capability === "network.connect") {
        return { ...requirement, hosts: [...requirement.hosts].sort() };
      }
      if (requirement.capability === "process.exec") {
        return {
          ...requirement,
          ...(requirement.commands === undefined
            ? {}
            : { commands: [...requirement.commands].sort() }),
        };
      }
      return { ...requirement, resources: [...requirement.resources].sort() };
    })
    .sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)));
  return {
    requirements,
    ...(normalized.effects === undefined
      ? {}
      : { effects: { ...normalized.effects } }),
  };
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableSerialize(record[key])}`
  ).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeValues(
  values: readonly string[],
  normalize: (value: string) => string,
): readonly string[] {
  const normalized = [...new Set(values.map(normalize))];
  if (normalized.length === 0) {
    throw new Error("Capability resource list must not be empty");
  }
  return normalized;
}

function capabilityError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}
