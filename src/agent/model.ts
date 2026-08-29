import type { LlmRequest } from "../core/agent";
import type { ToolCallId } from "../core/ids";

export type ModelProvider = "openai_compatible";
export type DeveloperRoleMode = "native" | "system-fallback";

export interface ModelRequest extends LlmRequest {
  readonly model?: string;
}

export interface ModelToolCall {
  readonly id: ToolCallId;
  readonly name: string;
  readonly argumentsJson: string;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface ModelError {
  readonly code:
    | "missing_api_key"
    | "invalid_request"
    | "http_error"
    | "provider_error"
    | "stream_parse_error"
    | "context_overflow"
    | "aborted"
    | "network_error"
    | "unknown";
  readonly message: string;
  readonly retryable: boolean;
  readonly status?: number;
}

export type ModelEvent =
  | {
      readonly type: "start";
      readonly provider: ModelProvider;
      readonly model: string;
      readonly developerRoleMode?: DeveloperRoleMode;
      readonly authorityDegraded?: boolean;
    }
  | {
      readonly type: "retry";
      readonly error: ModelError;
      readonly retryCount: number;
      readonly delayMs: number;
      readonly fromModel?: string;
      readonly toModel?: string;
    }
  | {
      readonly type: "reasoning_delta";
      readonly text: string;
    }
  | {
      readonly type: "text_delta";
      readonly text: string;
    }
  | {
      readonly type: "tool_call";
      readonly call: ModelToolCall;
    }
  | {
      readonly type: "done";
      readonly finishReason?: string;
      readonly usage?: ModelUsage;
    }
  | {
      readonly type: "error";
      readonly error: ModelError;
    };

export interface ModelClient {
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
}

export interface ModelProviderAdapter extends ModelClient {}

export interface RetryingModelClientOptions {
  readonly maxRetries?: number;
  readonly fallbackModels?: readonly string[];
  readonly baseRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly random?: () => number;
}

export class RetryingModelClient implements ModelClient {
  private readonly maxRetries: number;
  private readonly fallbackModels: readonly string[];
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly random: () => number;

  constructor(
    private readonly adapter: ModelProviderAdapter,
    options: RetryingModelClientOptions = {},
  ) {
    this.maxRetries = nonNegativeInteger(options.maxRetries, 2, "maxRetries");
    this.fallbackModels = options.fallbackModels ?? [];
    this.baseRetryDelayMs = positiveInteger(
      options.baseRetryDelayMs,
      500,
      "baseRetryDelayMs",
    );
    this.maxRetryDelayMs = positiveInteger(
      options.maxRetryDelayMs,
      8000,
      "maxRetryDelayMs",
    );
    this.random = options.random ?? Math.random;
  }

  async *stream(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    const models = distinctModels(request.model, this.fallbackModels);
    let retryCount = 0;

    for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
      const requestedModel = models[modelIndex];
      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        let emittedContent = false;
        let activeModel = requestedModel;
        let failure: ModelError | undefined;

        for await (const event of this.adapter.stream(
          withRequestedModel(request, requestedModel),
          signal,
        )) {
          if (event.type === "error") {
            failure = event.error;
            break;
          }
          if (event.type === "start") {
            activeModel = event.model;
          } else if (
            event.type === "text_delta" ||
            event.type === "reasoning_delta" ||
            event.type === "tool_call"
          ) {
            emittedContent = true;
          }
          yield event;
        }

        if (failure === undefined) {
          return;
        }
        if (signal?.aborted === true || failure.code === "aborted") {
          yield { type: "error", error: failure };
          return;
        }

        const canRetry =
          !emittedContent &&
          failure.retryable &&
          attempt < this.maxRetries;
        const nextModel = models[modelIndex + 1];
        const canFallback =
          !emittedContent &&
          nextModel !== undefined &&
          (failure.retryable || failure.code === "context_overflow");
        if (!canRetry && !canFallback) {
          yield { type: "error", error: failure };
          return;
        }

        retryCount += 1;
        const delayMs = backoffDelay(
          this.baseRetryDelayMs,
          this.maxRetryDelayMs,
          retryCount,
          this.random,
        );
        yield {
          type: "retry",
          error: failure,
          retryCount,
          delayMs,
          ...optionalString("fromModel", activeModel),
          ...(canRetry ? {} : optionalString("toModel", nextModel)),
        };
        await sleep(delayMs, signal);
        if (!canRetry) {
          break;
        }
      }
    }
  }
}

function distinctModels(
  primary: string | undefined,
  fallbackModels: readonly string[],
): readonly (string | undefined)[] {
  const result: (string | undefined)[] = [primary];
  for (const fallback of fallbackModels) {
    if (fallback.length > 0 && !result.includes(fallback)) {
      result.push(fallback);
    }
  }
  return result;
}

function withRequestedModel(
  request: ModelRequest,
  model: string | undefined,
): ModelRequest {
  return model === undefined ? request : { ...request, model };
}

function backoffDelay(
  baseMs: number,
  maxMs: number,
  retryCount: number,
  random: () => number,
): number {
  const exponential = Math.min(maxMs, baseMs * (2 ** (retryCount - 1)));
  return Math.max(1, Math.round(exponential * (0.75 + random() * 0.5)));
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError());
      return;
    }
    const abort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function abortError(): DOMException {
  return new DOMException("Model retry was aborted", "AbortError");
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return resolved;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return resolved;
}

function optionalString<Key extends string>(
  key: Key,
  value: string | undefined,
): { readonly [Property in Key]: string } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: string;
  };
}

export {
  OpenAICompatibleModelClient,
  OpenAICompatibleProviderAdapter,
  type OpenAICompatibleModelClientConfig,
} from "../providers/openai-compatible";
