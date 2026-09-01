import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  FileMutationOutput,
  FileMutationSummary,
  ToolError,
  WriteToolInput,
} from "../core/tools";
import {
  assertContentSize,
  assertFileSize,
  resolveWorkspacePath,
} from "../workspace/path-boundary";
import { assertToolCapability, type CodingToolDefinition } from "./index";
import { parseWriteInput } from "./parsers";

export const writeTool: CodingToolDefinition<"write", WriteToolInput, FileMutationOutput> = {
  name: "write",
  riskLevel: "mutating",
  executionMode: "sequential",
  resolveCapabilities: (input) => ({
    requirements: [
      { capability: "filesystem.read", paths: [input.path] },
      { capability: "filesystem.write", paths: [input.path] },
    ],
  }),
  async preflightAuthorization(input, context) {
    assertContentSize(input.content, context.maxFileBytes, "write content");
    await resolveWorkspacePath(context.workspaceRoot, input.path, {
      access: "mutate",
      allowMissing: true,
      policy: context.sandboxExecutor.policy,
    });
    return undefined;
  },
  parse: parseWriteInput,
  concurrencyKey: (input) => `file:${input.path}`,
  description:
    "Write a UTF-8 file inside the workspace. Creates parent directories. Refuses to overwrite unless overwrite is true.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        description: "Path to write inside the workspace.",
      },
      content: {
        type: "string",
        description: "Complete file content to write.",
      },
      overwrite: {
        type: "boolean",
        description: "Whether an existing file may be overwritten.",
      },
      expectedSha256: {
        type: "string",
        description: "Optional expected hash of the existing file.",
      },
    },
    required: ["path", "content", "overwrite"],
  },
  async execute(input, context) {
    assertToolCapability(context, "filesystem.read", input.path);
    assertToolCapability(context, "filesystem.write", input.path);
    assertContentSize(input.content, context.maxFileBytes, "write content");
    let filePath = await resolveWorkspacePath(context.workspaceRoot, input.path, {
      access: "mutate",
      allowMissing: true,
      policy: context.sandboxExecutor.policy,
    });
    const before = await readOptionalFile(filePath, context.maxFileBytes);

    if (before !== undefined && !input.overwrite) {
      throw toolError("conflict", `File already exists: ${input.path}`);
    }

    if (
      input.expectedSha256 !== undefined &&
      before !== undefined &&
      sha256(before) !== input.expectedSha256
    ) {
      throw toolError("conflict", `File hash mismatch: ${input.path}`);
    }

    await mkdir(dirname(filePath), { recursive: true });
    filePath = await resolveWorkspacePath(context.workspaceRoot, input.path, {
      access: "mutate",
      allowMissing: true,
      policy: context.sandboxExecutor.policy,
    });
    await writeFile(filePath, input.content, "utf8");

    return {
      path: input.path,
      ...optionalBeforeSha(before),
      afterSha256: sha256(input.content),
      summary: mutationSummary(before, input.content, "write"),
    };
  },
};

async function readOptionalFile(
  filePath: string,
  maxFileBytes: number,
): Promise<string | undefined> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw toolError("invalid_input", `Path is not a file: ${filePath}`);
    }

    await assertFileSize(filePath, maxFileBytes, "existing write file");
    return await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

function mutationSummary(
  before: string | undefined,
  after: string,
  operation: string,
): FileMutationSummary {
  const beforeLines = before === undefined ? 0 : countLines(before);
  const afterLines = countLines(after);
  const lineDelta = afterLines - beforeLines;

  return {
    changed: before !== after,
    ...optionalBeforeBytes(before),
    afterBytes: Buffer.byteLength(after, "utf8"),
    addedLines: Math.max(0, lineDelta),
    removedLines: Math.max(0, -lineDelta),
    description:
      before === undefined
        ? `${operation}: created file`
        : `${operation}: replaced file content`,
  };
}

function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }

  return content.replace(/\r\n/gu, "\n").split("\n").length;
}

function optionalBeforeSha(
  before: string | undefined,
): { readonly beforeSha256: string } | object {
  return before === undefined ? {} : { beforeSha256: sha256(before) };
}

function optionalBeforeBytes(
  before: string | undefined,
): { readonly beforeBytes: number } | object {
  return before === undefined ? {} : { beforeBytes: Buffer.byteLength(before, "utf8") };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function toolError(code: ToolError["code"], message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
