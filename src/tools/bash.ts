import type { WorkspacePath } from "../core/ids";
import type { BashToolInput, BashToolOutput, ToolError } from "../core/tools";
import { resolveWorkspacePath } from "../workspace/path-boundary";
import { preflightEffectiveSandboxCallPolicy } from "../workspace/sandbox";
import {
  assertToolCapability,
  type CodingToolDefinition,
  type ToolRunContext,
} from "./index";
import { parseBashInput } from "./parsers";

export const bashTool: CodingToolDefinition<"bash", BashToolInput, BashToolOutput> = {
  name: "bash",
  riskLevel: "external",
  executionMode: "sequential",
  resolveCapabilities(input) {
    const permissions = bashPermissions(input);
    return {
      requirements: [
        { capability: "process.exec", commands: [input.command] },
        ...(permissions.readPaths.length === 0
          ? []
          : [{
              capability: "filesystem.read" as const,
              paths: permissions.readPaths,
            }]),
        ...(permissions.writePaths.length === 0
          ? []
          : [{
              capability: "filesystem.write" as const,
              paths: permissions.writePaths,
            }]),
        ...(permissions.network
          ? [{ capability: "network.connect" as const, hosts: ["*"] }]
          : []),
        ...(permissions.externalSideEffect
          ? [{
              capability: "external.side_effect" as const,
              resources: ["*"],
            }]
          : []),
      ],
      effects: {
        destructive: permissions.destructive,
        openWorld: permissions.network || permissions.externalSideEffect,
      },
    };
  },
  async preflightAuthorization(input, context, capabilities) {
    await resolveWorkspacePath(
      context.workspaceRoot,
      input.cwd ?? ("." as WorkspacePath),
      {
        access: "cwd",
        allowWorkspaceRoot: true,
        policy: context.sandboxExecutor.policy,
      },
    );
    const effective = preflightEffectiveSandboxCallPolicy(
      capabilities,
      input.command,
      context.sandboxExecutor.policy,
      context.sandboxExecutor.enforcement,
      context.workspaceRoot,
    );
    return Object.freeze({
      policyVersion: effective.policyVersion,
      backend: effective.enforcement.backend,
      filesystemEnforcement: effective.enforcement.filesystem,
      networkEnforcement: effective.enforcement.network,
      readPaths: effective.filesystem.readPaths,
      writePaths: effective.filesystem.writePaths,
      networkEnabled: effective.network.enabled,
    });
  },
  parse: parseBashInput,
  description:
    "Run a shell command inside the workspace. Supports timeout, abort, and stdout/stderr truncation.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute.",
      },
      cwd: {
        type: "string",
        description: "Optional working directory inside the workspace.",
      },
      timeoutMs: {
        type: "integer",
        minimum: 1,
        description: "Maximum runtime in milliseconds. Defaults to 120000.",
      },
      permissions: {
        type: "object",
        additionalProperties: false,
        description:
          "Least authority required by this command. If omitted, PIBot uses the conservative legacy profile: workspace write, no network, external side effect.",
        properties: {
          filesystem: {
            oneOf: [
              {
                type: "string",
                enum: ["read", "write"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  read: {
                    type: "array",
                    items: { type: "string" },
                    maxItems: 128,
                  },
                  write: {
                    type: "array",
                    items: { type: "string" },
                    maxItems: 128,
                  },
                },
                required: ["read", "write"],
              },
            ],
            description:
              "Whole-workspace read/write, or exact workspace-relative read/write path scopes. A directory path covers descendants.",
          },
          network: {
            type: "boolean",
            description: "Whether outbound network sockets are required.",
          },
          externalSideEffect: {
            type: "boolean",
            description:
              "Whether the command publishes or mutates state outside the workspace, such as git push.",
          },
          destructive: {
            type: "boolean",
            description: "Whether the command may delete or irreversibly replace data.",
          },
        },
        required: [
          "filesystem",
          "network",
          "externalSideEffect",
          "destructive",
        ],
      },
    },
    required: ["command"],
  },
  async execute(input, context, signal) {
    const permissions = bashPermissions(input);
    assertToolCapability(context, "process.exec", input.command);
    for (const readPath of permissions.readPaths) {
      assertToolCapability(context, "filesystem.read", readPath);
    }
    for (const writePath of permissions.writePaths) {
      assertToolCapability(context, "filesystem.write", writePath);
    }
    if (permissions.network) {
      assertToolCapability(context, "network.connect", "*");
    }
    if (permissions.externalSideEffect) {
      assertToolCapability(context, "external.side_effect", "*");
    }
    const authorization = context.authorization?.grant;
    if (authorization === undefined) {
      throw toolError("permission_denied", "bash requires an active capability grant");
    }
    const cwd = await resolveWorkspacePath(
      context.workspaceRoot,
      input.cwd ?? ("." as WorkspacePath),
      {
        access: "cwd",
        allowWorkspaceRoot: true,
        policy: context.sandboxExecutor.policy,
      },
    );
    const timeoutMs = normalizeTimeout(input.timeoutMs, context);

    return context.sandboxExecutor.execute(
      {
        command: input.command,
        workspaceRoot: context.workspaceRoot,
        cwd,
        timeoutMs,
        maxOutputChars: context.maxCommandOutputChars,
        authorization,
      },
      signal,
    );
  },
};

function bashPermissions(
  input: BashToolInput,
): {
  readonly readPaths: readonly string[];
  readonly writePaths: readonly string[];
  readonly network: boolean;
  readonly externalSideEffect: boolean;
  readonly destructive: boolean;
} {
  const permissions = input.permissions ?? {
    filesystem: "write" as const,
    network: false,
    externalSideEffect: true,
    destructive: false,
  };
  const filesystem = permissions.filesystem;
  return {
    readPaths: typeof filesystem === "string" ? ["."] : filesystem.read,
    writePaths: filesystem === "write"
      ? ["."]
      : typeof filesystem === "string"
        ? []
        : filesystem.write,
    network: permissions.network,
    externalSideEffect: permissions.externalSideEffect,
    destructive: permissions.destructive,
  };
}

function normalizeTimeout(
  timeoutMs: number | undefined,
  context: ToolRunContext,
): number {
  if (timeoutMs === undefined) {
    return context.defaultShellTimeoutMs;
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw toolError("invalid_input", "bash.timeoutMs must be a positive integer");
  }

  if (timeoutMs > context.maxShellTimeoutMs) {
    throw toolError(
      "invalid_input",
      `bash.timeoutMs must not exceed ${context.maxShellTimeoutMs}`,
    );
  }

  return timeoutMs;
}

function toolError(code: ToolError["code"], message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}
