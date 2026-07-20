import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type {
  EditToolInput,
  FileMutationOutput,
  FileMutationSummary,
  TextReplacement,
  ToolError,
} from "../core/tools";
import {
  assertContentSize,
  assertFileSize,
  resolveWorkspacePath,
} from "../workspace/path-boundary";
import type { CodingToolDefinition } from "./index";
import { parseEditInput } from "./parsers";

export const editTool: CodingToolDefinition<"edit", EditToolInput, FileMutationOutput> = {
  name: "edit",
  riskLevel: "mutating",
  executionMode: "sequential",
  parse: parseEditInput,
  concurrencyKey: (input) => `file:${input.path}`,
  description:
    "Edit a UTF-8 file inside the workspace using exact oldText/newText replacements. No fuzzy matching is performed.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        description: "Path to edit inside the workspace.",
      },
      replacements: {
        type: "array",
        description:
          "Exact replacements. If occurrence is omitted, oldText must appear exactly once.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            oldText: { type: "string" },
            newText: { type: "string" },
            occurrence: {
              type: "integer",
              minimum: 1,
              description: "1-based occurrence of oldText to replace.",
            },
          },
          required: ["oldText", "newText"],
        },
      },
      expectedSha256: {
        type: "string",
        description: "Optional expected hash of the existing file.",
      },
    },
    required: ["path", "replacements"],
  },
  async execute(input, context) {
    const filePath = await resolveWorkspacePath(context.workspaceRoot, input.path, {
      access: "mutate",
    });
    await assertFileSize(filePath, context.maxFileBytes, "edit file");
    const before = await readFile(filePath, "utf8");

    if (
      input.expectedSha256 !== undefined &&
      sha256(before) !== input.expectedSha256
    ) {
      throw toolError("conflict", `File hash mismatch: ${input.path}`);
    }

    const editResult = applyReplacements(before, input.replacements);
    assertContentSize(editResult.content, context.maxFileBytes, "edited content");
    await resolveWorkspacePath(context.workspaceRoot, input.path, {
      access: "mutate",
    });
    await writeFile(filePath, editResult.content, "utf8");

    return {
      path: input.path,
      beforeSha256: sha256(before),
      afterSha256: sha256(editResult.content),
      summary: mutationSummary(before, editResult.content, editResult.applied),
    };
  },
};

function applyReplacements(
  content: string,
  replacements: readonly TextReplacement[],
): { readonly content: string; readonly applied: number } {
  if (replacements.length === 0) {
    throw toolError("invalid_input", "edit.replacements must not be empty");
  }

  let nextContent = content;
  let applied = 0;

  for (const replacement of replacements) {
    validateReplacement(replacement);
    const result = applyReplacement(nextContent, replacement);
    nextContent = result.content;
    applied += 1;
  }

  return {
    content: nextContent,
    applied,
  };
}

function applyReplacement(
  content: string,
  replacement: TextReplacement,
): { readonly content: string } {
  if (replacement.occurrence !== undefined) {
    const index = findOccurrence(content, replacement.oldText, replacement.occurrence);
    if (index === -1) {
      throw toolError(
        "conflict",
        `oldText occurrence ${replacement.occurrence} was not found`,
      );
    }

    return {
      content: replaceAt(content, index, replacement.oldText, replacement.newText),
    };
  }

  const occurrences = countOccurrences(content, replacement.oldText);
  if (occurrences === 0) {
    throw toolError("conflict", "oldText was not found");
  }

  if (occurrences > 1) {
    throw toolError(
      "conflict",
      "oldText appeared more than once; provide occurrence",
    );
  }

  return {
    content: content.replace(replacement.oldText, replacement.newText),
  };
}

function validateReplacement(replacement: TextReplacement): void {
  if (replacement.oldText.length === 0) {
    throw toolError("invalid_input", "edit.oldText must not be empty");
  }

  if (
    replacement.occurrence !== undefined &&
    (!Number.isInteger(replacement.occurrence) || replacement.occurrence < 1)
  ) {
    throw toolError("invalid_input", "edit.occurrence must be a positive integer");
  }
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let from = 0;

  while (true) {
    const index = content.indexOf(needle, from);
    if (index === -1) {
      return count;
    }

    count += 1;
    from = index + needle.length;
  }
}

function findOccurrence(
  content: string,
  needle: string,
  occurrence: number,
): number {
  let count = 0;
  let from = 0;

  while (true) {
    const index = content.indexOf(needle, from);
    if (index === -1) {
      return -1;
    }

    count += 1;
    if (count === occurrence) {
      return index;
    }

    from = index + needle.length;
  }
}

function replaceAt(
  content: string,
  index: number,
  oldText: string,
  newText: string,
): string {
  return `${content.slice(0, index)}${newText}${content.slice(index + oldText.length)}`;
}

function mutationSummary(
  before: string,
  after: string,
  replacementsApplied: number,
): FileMutationSummary {
  const beforeLines = countLines(before);
  const afterLines = countLines(after);
  const lineDelta = afterLines - beforeLines;

  return {
    changed: before !== after,
    beforeBytes: Buffer.byteLength(before, "utf8"),
    afterBytes: Buffer.byteLength(after, "utf8"),
    addedLines: Math.max(0, lineDelta),
    removedLines: Math.max(0, -lineDelta),
    replacementsApplied,
    description: `edit: applied ${replacementsApplied} exact replacement(s)`,
  };
}

function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }

  return content.replace(/\r\n/gu, "\n").split("\n").length;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function toolError(code: ToolError["code"], message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}
