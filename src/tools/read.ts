import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { WorkspacePath } from "../core/ids";
import type { ReadToolInput, ReadToolOutput } from "../core/tools";
import {
  assertFileSize,
  resolveWorkspacePath,
} from "../workspace/path-boundary";
import {
  assertToolCapability,
  type CodingToolDefinition,
  type ToolRunContext,
} from "./index";
import { parseReadInput } from "./parsers";

const defaultLineLimit = 200;

export const readTool: CodingToolDefinition<"read", ReadToolInput, ReadToolOutput> = {
  name: "read",
  riskLevel: "read-only",
  executionMode: "parallel",
  resolveCapabilities: (input) => ({
    requirements: [{ capability: "filesystem.read", paths: [input.path] }],
  }),
  parse: parseReadInput,
  description:
    "Read a UTF-8 text file inside the workspace. Supports zero-based line offset and line limit. Output is truncated when too long.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        description: "Path to a file inside the workspace.",
      },
      offset: {
        type: "integer",
        minimum: 0,
        description: "Zero-based line offset. Defaults to 0.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        description: "Maximum number of lines to read. Defaults to 200.",
      },
    },
    required: ["path"],
  },
  async execute(input, context) {
    assertToolCapability(context, "filesystem.read", input.path);
    const filePath = await resolveWorkspacePath(context.workspaceRoot, input.path, {
      access: "read",
      policy: context.sandboxExecutor.policy,
    });
    await assertFileSize(filePath, context.maxFileBytes, "read file");
    const content = await readFile(filePath, "utf8");
    const lines = splitLines(content);
    const offset = normalizeOffset(input);
    const limit = normalizeLimit(input);
    const selected = lines.slice(offset, offset + limit);
    const selectedText = selected.join("\n");
    const truncatedContent = truncateText(selectedText, context.maxReadChars);
    const endLine = selected.length === 0 ? offset : offset + selected.length;

    return {
      path: input.path,
      content: truncatedContent.text,
      startLine: selected.length === 0 ? offset + 1 : offset + 1,
      endLine,
      totalLines: lines.length,
      truncated:
        truncatedContent.truncated || offset + selected.length < lines.length,
      sha256: sha256(content),
    };
  },
};

function normalizeOffset(input: ReadToolInput): number {
  if (input.offset !== undefined) {
    return assertNonNegativeInteger(input.offset, "read.offset");
  }

  if (input.startLine !== undefined) {
    return Math.max(0, assertNonNegativeInteger(input.startLine, "read.startLine") - 1);
  }

  return 0;
}

function normalizeLimit(input: ReadToolInput): number {
  if (input.limit !== undefined) {
    return assertPositiveInteger(input.limit, "read.limit");
  }

  if (input.startLine !== undefined && input.endLine !== undefined) {
    const startLine = assertNonNegativeInteger(input.startLine, "read.startLine");
    const endLine = assertNonNegativeInteger(input.endLine, "read.endLine");
    return Math.max(1, endLine - startLine + 1);
  }

  return defaultLineLimit;
}

function splitLines(content: string): readonly string[] {
  if (content.length === 0) {
    return [];
  }

  return content.replace(/\r\n/gu, "\n").split("\n");
}

function truncateText(
  text: string,
  maxChars: number,
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= maxChars) {
    return {
      text,
      truncated: false,
    };
  }

  return {
    text: `${text.slice(0, maxChars)}\n[truncated]`,
    truncated: true,
  };
}

function assertNonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw toolError("invalid_input", `${name} must be a non-negative integer`);
  }

  return value;
}

function assertPositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw toolError("invalid_input", `${name} must be a positive integer`);
  }

  return value;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function toolError(code: "invalid_input", message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}
