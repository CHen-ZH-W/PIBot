import { basename } from "node:path";
import { stat } from "node:fs/promises";
import type { WorkspacePath } from "../core/ids";
import type { ToolError } from "../core/tools";
import {
  assertFileSize,
  resolveWorkspacePath,
} from "../workspace/path-boundary";
import type { CodingToolDefinition, ToolInputParseResult } from "./index";

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface AttachToolInput {
  readonly path: WorkspacePath;
  readonly title?: string;
  readonly initialComment?: string;
}

export interface AttachToolOutput {
  readonly path: WorkspacePath;
  readonly filename: string;
  readonly bytes: number;
  readonly uploaded: boolean;
}

export const attachTool: CodingToolDefinition<
  "attach",
  AttachToolInput,
  AttachToolOutput
> = {
  name: "attach",
  riskLevel: "external",
  executionMode: "sequential",
  description:
    "Upload a generated workspace file through the current attachment channel. Use for files the user should download or inspect directly.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        description: "Workspace-relative path of the file to upload.",
      },
      title: {
        type: "string",
        description: "Optional file title.",
      },
      initialComment: {
        type: "string",
        description: "Optional short message to post with the file.",
      },
    },
    required: ["path"],
  },
  parse: parseAttachInput,
  async execute(input, context) {
    if (context.attach === undefined) {
      throw toolError("invalid_input", "Attachment context is not available");
    }

    const filePath = await resolveWorkspacePath(context.workspaceRoot, input.path, {
      access: "read",
    });
    await assertFileSize(filePath, context.attach.maxFileBytes, "attach file");
    const fileStat = await stat(filePath);
    const filename = basename(input.path);
    await context.attach.publisher.publishSlackEvent({
      type: "file.upload",
      file: {
        conversation: context.attach.conversation,
        filePath,
        filename,
        ...optionalString("title", input.title),
        ...optionalString("initialComment", input.initialComment),
      },
    });

    return {
      path: input.path,
      filename,
      bytes: fileStat.size,
      uploaded: true,
    };
  },
};

function parseAttachInput(
  input: UnknownRecord,
): ToolInputParseResult<AttachToolInput> {
  const path = readString(input, "path");
  if (path === undefined) {
    return {
      ok: false,
      message: "attach.path must be a string",
    };
  }

  return {
    ok: true,
    input: {
      path: path as WorkspacePath,
      ...optionalString("title", readString(input, "title")),
      ...optionalString("initialComment", readString(input, "initialComment")),
    },
  };
}

function readString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function optionalString<Key extends string>(
  key: Key,
  value: string | undefined,
): { readonly [Property in Key]: string } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: string;
  };
}

function toolError(code: ToolError["code"], message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}
