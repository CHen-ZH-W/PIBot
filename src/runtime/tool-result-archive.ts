import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type {
  ToolCall,
  ToolResult,
  ToolResultArtifactRef,
} from "../core/tools";
import type {
  RuntimeAfterToolCallHookContext,
  RuntimeHook,
} from "./hooks";

export interface ToolResultArchiveHookOptions {
  readonly directory: string;
  readonly locatorRoot: string;
  readonly onError?: (error: unknown) => void;
  readonly clock?: () => Date;
}

/** Persists the exact executor result before it is admitted to model context. */
export class ToolResultArchiveHook implements RuntimeHook {
  private readonly directory: string;
  private readonly locatorRoot: string;
  private readonly clock: () => Date;

  constructor(private readonly options: ToolResultArchiveHookOptions) {
    this.directory = path.resolve(options.directory);
    this.locatorRoot = path.resolve(options.locatorRoot);
    this.clock = options.clock ?? (() => new Date());
  }

  afterToolCall(context: RuntimeAfterToolCallHookContext): Promise<ToolResult> {
    return this.archiveBestEffort(context);
  }

  onToolFailure(context: RuntimeAfterToolCallHookContext): Promise<ToolResult> {
    return this.archiveBestEffort(context);
  }

  private async archiveBestEffort(
    context: RuntimeAfterToolCallHookContext,
  ): Promise<ToolResult> {
    try {
      return await this.archive(context.call, context.result);
    } catch (error: unknown) {
      this.options.onError?.(error);
      return context.result;
    }
  }

  private async archive(call: ToolCall, result: ToolResult): Promise<ToolResult> {
    const rawResult = JSON.stringify(result);
    const sha256 = createHash("sha256").update(rawResult).digest("hex");
    const safeCallId = safeSegment(call.id);
    const fileName = `${safeCallId}-${sha256.slice(0, 16)}.json`;
    const filePath = path.join(this.directory, fileName);
    const record = JSON.stringify({
      type: "tool_result_blob",
      schemaVersion: 1,
      call: {
        id: call.id,
        name: call.name,
        input: call.input,
      },
      result,
      resultSha256: sha256,
      createdAt: this.clock().toISOString(),
    });
    await mkdir(this.directory, { recursive: true });
    try {
      await writeFile(filePath, `${record}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
    }
    const artifact: ToolResultArtifactRef = {
      kind: "tool_result_blob",
      path: path.relative(this.locatorRoot, filePath).split(path.sep).join("/"),
      sha256,
      bytes: Buffer.byteLength(rawResult, "utf8"),
      toolName: call.name,
      regenerable: isRegenerableResult(call, result),
    };
    return { ...result, artifact };
  }
}

function isRegenerableResult(call: ToolCall, result: ToolResult): boolean {
  return result.ok &&
    (call.name === "read" ||
      call.name === "read_skill" ||
      call.name === "grep");
}

function safeSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/gu, "-").slice(0, 120);
  return normalized.length === 0 ? "tool-result" : normalized;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
