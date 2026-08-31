import type { ToolResult } from "../core/tools";

const DEFAULT_THRESHOLD_CHARS = 8_192;
const DEFAULT_HEAD_CHARS = 4_096;
const DEFAULT_TAIL_CHARS = 1_024;

export interface ToolResultPrunerOptions {
  /** Serialized size above which one Tool Result is pruned for model context. */
  readonly thresholdChars?: number;
  readonly headChars?: number;
  readonly tailChars?: number;
}

export interface ToolResultAdmissionMetadata {
  readonly truncated: true;
  readonly strategy: "head_tail";
  readonly originalResultChars: number;
  readonly originalResultBytes: number;
  readonly originalPayloadChars: number;
  readonly omittedPayloadChars: number;
  readonly retainedHeadChars: number;
  readonly retainedTailChars: number;
  readonly artifactPath?: string;
  readonly artifactSha256?: string;
}

/**
 * Bounds one Tool Result at the final context-admission boundary. The executor
 * result is expected to have been archived before this projection is applied.
 */
export class ToolResultPruner {
  private readonly thresholdChars: number;
  private readonly headChars: number;
  private readonly tailChars: number;

  constructor(options: ToolResultPrunerOptions = {}) {
    this.thresholdChars = positiveInteger(
      options.thresholdChars,
      DEFAULT_THRESHOLD_CHARS,
      "thresholdChars",
    );
    this.headChars = nonNegativeInteger(
      options.headChars,
      DEFAULT_HEAD_CHARS,
      "headChars",
    );
    this.tailChars = nonNegativeInteger(
      options.tailChars,
      DEFAULT_TAIL_CHARS,
      "tailChars",
    );
    if (this.headChars + this.tailChars >= this.thresholdChars) {
      throw new Error("headChars + tailChars must be less than thresholdChars");
    }
  }

  prune(result: ToolResult): ToolResult {
    const serialized = JSON.stringify(result);
    if (serialized.length <= this.thresholdChars) {
      return result;
    }
    return result.ok
      ? this.pruneSuccess(result)
      : this.pruneFailure(result);
  }

  private pruneSuccess(result: Extract<ToolResult, { readonly ok: true }>): ToolResult {
    const source = JSON.stringify(result.output);
    const originalResult = JSON.stringify(result);
    const retained = retainHeadAndTail(source, this.headChars, this.tailChars);
    return {
      ...result,
      output: {
        contextAdmission: admissionMetadata(
          source,
          originalResult,
          retained.head.length,
          retained.tail.length,
          result.artifact,
        ),
        head: retained.head,
        tail: retained.tail,
      },
    };
  }

  private pruneFailure(result: Extract<ToolResult, { readonly ok: false }>): ToolResult {
    const source = result.error.message;
    const retained = retainHeadAndTail(source, this.headChars, this.tailChars);
    return {
      ...result,
      error: {
        ...result.error,
        message: [
          retained.head,
          `[tool result middle omitted by context admission; ${
            Math.max(0, source.length - retained.visibleChars)
          } chars omitted]`,
          retained.tail,
        ].filter((value) => value.length > 0).join("\n"),
      },
    };
  }
}

function admissionMetadata(
  source: string,
  originalResult: string,
  retainedHeadChars: number,
  retainedTailChars: number,
  artifact: ToolResult["artifact"],
): ToolResultAdmissionMetadata {
  return {
    truncated: true,
    strategy: "head_tail",
    originalResultChars: originalResult.length,
    originalResultBytes: Buffer.byteLength(originalResult, "utf8"),
    originalPayloadChars: source.length,
    omittedPayloadChars: Math.max(
      0,
      source.length - retainedHeadChars - retainedTailChars,
    ),
    retainedHeadChars,
    retainedTailChars,
    ...(artifact === undefined ? {} : {
      artifactPath: artifact.path,
      artifactSha256: artifact.sha256,
    }),
  };
}

function retainHeadAndTail(
  source: string,
  headChars: number,
  tailChars: number,
): { readonly head: string; readonly tail: string; readonly visibleChars: number } {
  const head = source.slice(0, headChars);
  const remainingChars = Math.max(0, source.length - head.length);
  const retainedTailChars = Math.min(tailChars, remainingChars);
  const tail = retainedTailChars === 0 ? "" : source.slice(-retainedTailChars);
  return { head, tail, visibleChars: head.length + tail.length };
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 1_024) {
    throw new Error(`${label} must be an integer greater than or equal to 1024`);
  }
  return normalized;
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return normalized;
}
