import type { WorkspacePath } from "../core/ids";
import type { BashToolInput, BashToolOutput, ToolError } from "../core/tools";
import { resolveWorkspacePath } from "../workspace/path-boundary";
import type { CodingToolDefinition, ToolRunContext } from "./index";
import { parseBashInput } from "./parsers";

export const bashTool: CodingToolDefinition<"bash", BashToolInput, BashToolOutput> = {
  name: "bash",
  riskLevel: "external",
  executionMode: "sequential",
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
    },
    required: ["command"],
  },
  async execute(input, context, signal) {
    const cwd = await resolveWorkspacePath(
      context.workspaceRoot,
      input.cwd ?? ("." as WorkspacePath),
      {
        access: "cwd",
        allowWorkspaceRoot: true,
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
      },
      signal,
    );
  },
};

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
