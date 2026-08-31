export interface SandboxResourceLimits {
  readonly maxProcesses: number;
  readonly maxOpenFiles: number;
  readonly maxFileSizeBytes: number;
  readonly maxMemoryBytes: number;
}

export interface SandboxPolicy {
  readonly version: string;
  readonly filesystem: {
    readonly protectedDirectoryNames: readonly string[];
    readonly protectedFileNames: readonly string[];
    readonly protectedFilePrefixes: readonly string[];
    readonly protectedNameExceptions: readonly string[];
    readonly scratch: "private-write";
  };
  readonly network: {
    readonly default: "deny";
    readonly granularity: "all-or-none";
  };
  readonly process: {
    readonly enabled: true;
  };
  readonly resourceLimits: SandboxResourceLimits;
}

export const defaultSandboxPolicy: SandboxPolicy = Object.freeze({
  version: "sandbox-policy-v1",
  filesystem: Object.freeze({
    protectedDirectoryNames: Object.freeze([
      ".git",
      ".pibot",
      ".pibot-evolution-workspaces",
    ]),
    protectedFileNames: Object.freeze([
      ".gitconfig",
      ".netrc",
      ".npmrc",
      ".pibotignore",
      ".env",
      "instructions.md",
      "context.jsonl",
      "log.jsonl",
      "MEMORY.md",
      "repo.json",
      "runtime-state.json",
      "trace.jsonl",
      "usage.jsonl",
    ]),
    protectedFilePrefixes: Object.freeze([".env."]),
    protectedNameExceptions: Object.freeze([".env.example"]),
    scratch: "private-write" as const,
  }),
  network: Object.freeze({
    default: "deny" as const,
    granularity: "all-or-none" as const,
  }),
  process: Object.freeze({ enabled: true as const }),
  resourceLimits: Object.freeze({
    maxProcesses: 256,
    maxOpenFiles: 256,
    maxFileSizeBytes: 64_000_000,
    maxMemoryBytes: 17_179_869_184,
  }),
});

export function isSandboxProtectedName(
  name: string,
  policy: SandboxPolicy = defaultSandboxPolicy,
): boolean {
  if (policy.filesystem.protectedNameExceptions.includes(name)) {
    return false;
  }
  return policy.filesystem.protectedDirectoryNames.includes(name) ||
    policy.filesystem.protectedFileNames.includes(name) ||
    policy.filesystem.protectedFilePrefixes.some((prefix) => name.startsWith(prefix));
}

export function sandboxProtectedNames(
  policy: SandboxPolicy = defaultSandboxPolicy,
): readonly string[] {
  return [
    ...policy.filesystem.protectedDirectoryNames,
    ...policy.filesystem.protectedFileNames,
  ];
}

export function sandboxPolicyWithResourceLimits(
  policy: SandboxPolicy,
  resourceLimits: SandboxResourceLimits,
): SandboxPolicy {
  const limits = Object.freeze({ ...resourceLimits });
  return Object.freeze({
    ...policy,
    version: [
      policy.version,
      limits.maxProcesses,
      limits.maxOpenFiles,
      limits.maxFileSizeBytes,
      limits.maxMemoryBytes,
    ].join(":"),
    resourceLimits: limits,
  });
}
