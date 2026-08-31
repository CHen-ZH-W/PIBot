import type {
  LlmMessage,
  LlmMessageContentPart,
  LlmToolSchema,
} from "../core/agent";
import type { ToolCallId } from "../core/ids";
import type {
  DeveloperRoleMode,
  ModelError,
  ModelEvent,
  ModelProviderAdapter,
  ModelRequest,
  ModelUsage,
} from "../agent/model";
import type { ModelRequestCompatibility } from "../models/types";

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface AnthropicMessagesAdapterConfig {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly developerRoleMode: DeveloperRoleMode;
  readonly defaultMaxOutputTokens?: number;
  readonly request?: ModelRequestCompatibility;
}

interface AnthropicToolAccumulator {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  argumentsJson: string;
  emitted: boolean;
}

export class AnthropicMessagesProviderAdapter implements ModelProviderAdapter {
  constructor(private readonly config: AnthropicMessagesAdapterConfig) {}

  async *stream(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    const model = request.model ?? this.config.model;
    yield {
      type: "start",
      provider: this.config.providerId,
      model,
      developerRoleMode: this.config.developerRoleMode,
      authorityDegraded: this.config.developerRoleMode === "system-fallback",
    };
    let providerRequest: UnknownRecord;
    try {
      providerRequest = toAnthropicRequest(
        request,
        model,
        this.config.developerRoleMode,
        this.config.defaultMaxOutputTokens ?? 4096,
        this.config.request ?? {},
      );
    } catch (error: unknown) {
      yield { type: "error", error: invalidRequest(error) };
      return;
    }

    try {
      const response = await fetch(`${removeTrailingSlash(this.config.baseUrl)}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          ...this.config.headers,
        },
        body: JSON.stringify(providerRequest),
        ...optionalSignal(signal),
      });
      if (!response.ok) {
        const details = await responseErrorDetails(response);
        yield {
          type: "error",
          error: anthropicHttpError(response.status, details),
        };
        return;
      }
      if (response.body === null) {
        yield {
          type: "error",
          error: {
            code: "provider_error",
            message: "Anthropic returned an empty streaming response body",
            retryable: true,
          },
        };
        return;
      }

      let finishReason: string | undefined;
      let inputTokens = 0;
      let cachedInputTokens = 0;
      let cacheCreationInputTokens = 0;
      let outputTokens = 0;
      const tools = new Map<number, AnthropicToolAccumulator>();
      for await (const event of readServerSentEvents(response.body)) {
        const data = readSseData(event);
        if (data === null || data === "[DONE]") {
          continue;
        }
        const payload = parseJsonRecord(data);
        if (payload === undefined) {
          yield {
            type: "error",
            error: {
              code: "stream_parse_error",
              message: "Anthropic returned a non-JSON stream event",
              retryable: true,
            },
          };
          return;
        }
        const type = readString(payload, "type");
        if (type === "error") {
          const error = readRecord(payload, "error");
          yield {
            type: "error",
            error: providerStreamError(error),
          };
          return;
        }
        if (type === "message_start") {
          const message = readRecord(payload, "message");
          const usage = readRecord(message, "usage");
          inputTokens = readNumber(usage, "input_tokens") ?? inputTokens;
          cachedInputTokens =
            readNumber(usage, "cache_read_input_tokens") ?? cachedInputTokens;
          cacheCreationInputTokens =
            readNumber(usage, "cache_creation_input_tokens") ??
            cacheCreationInputTokens;
          outputTokens = readNumber(usage, "output_tokens") ?? outputTokens;
          continue;
        }
        if (type === "content_block_start") {
          const index = readNumber(payload, "index");
          const block = readRecord(payload, "content_block");
          if (
            index !== undefined &&
            readString(block, "type") === "tool_use"
          ) {
            const id = readString(block, "id");
            const name = readString(block, "name");
            if (id !== undefined && name !== undefined) {
              tools.set(index, {
                index,
                id,
                name,
                argumentsJson: initialToolArguments(block),
                emitted: false,
              });
            }
          }
          continue;
        }
        if (type === "content_block_delta") {
          const delta = readRecord(payload, "delta");
          const deltaType = readString(delta, "type");
          if (deltaType === "text_delta") {
            const text = readString(delta, "text");
            if (text !== undefined) {
              yield { type: "text_delta", text };
            }
          } else if (deltaType === "thinking_delta") {
            const text = readString(delta, "thinking");
            if (text !== undefined) {
              yield { type: "reasoning_delta", text };
            }
          } else if (deltaType === "input_json_delta") {
            const index = readNumber(payload, "index");
            const partial = readString(delta, "partial_json");
            const tool = index === undefined ? undefined : tools.get(index);
            if (tool !== undefined && partial !== undefined) {
              tool.argumentsJson += partial;
            }
          }
          continue;
        }
        if (type === "content_block_stop") {
          const index = readNumber(payload, "index");
          const tool = index === undefined ? undefined : tools.get(index);
          if (tool !== undefined && !tool.emitted) {
            tool.emitted = true;
            yield {
              type: "tool_call",
              call: {
                id: tool.id as ToolCallId,
                name: tool.name,
                argumentsJson: normalizedToolArguments(tool.argumentsJson),
              },
            };
          }
          continue;
        }
        if (type === "message_delta") {
          const delta = readRecord(payload, "delta");
          finishReason = readString(delta, "stop_reason") ?? finishReason;
          const usage = readRecord(payload, "usage");
          outputTokens = readNumber(usage, "output_tokens") ?? outputTokens;
        }
      }
      yield {
        type: "done",
        ...optionalString("finishReason", finishReason),
        usage: modelUsage(
          inputTokens + cachedInputTokens + cacheCreationInputTokens,
          cachedInputTokens,
          outputTokens,
        ),
      };
    } catch (error: unknown) {
      yield { type: "error", error: unknownModelError(error) };
    }
  }
}

function toAnthropicRequest(
  request: ModelRequest,
  model: string,
  developerRoleMode: DeveloperRoleMode,
  defaultMaxOutputTokens: number,
  compatibility: ModelRequestCompatibility,
): UnknownRecord {
  const system: string[] = [];
  const messages: UnknownRecord[] = [];
  for (const message of request.messages) {
    if (message.role === "system") {
      system.push(message.content);
      continue;
    }
    if (message.role === "developer") {
      if (developerRoleMode !== "system-fallback") {
        throw new Error(
          "Anthropic Messages does not support developer messages; configure developerRoleMode=system-fallback explicitly",
        );
      }
      system.push(message.content);
      continue;
    }
    messages.push(toAnthropicMessage(message));
  }
  const tools = request.tools.length === 0
    ? undefined
    : request.tools.map(toAnthropicTool);
  return {
    ...(compatibility.extraBody ?? {}),
    model,
    max_tokens: request.maxOutputTokens ?? defaultMaxOutputTokens,
    stream: true,
    ...(system.length === 0 ? {} : { system: system.join("\n\n") }),
    messages,
    ...(tools === undefined ? {} : { tools }),
    ...(compatibility.supportsTemperature === false
      ? {}
      : optionalNumber("temperature", request.temperature)),
  };
}

function toAnthropicMessage(message: LlmMessage): UnknownRecord {
  if (message.role === "tool") {
    if (message.toolCallId === undefined) {
      throw new Error("Tool role messages require toolCallId");
    }
    return {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
      }],
    };
  }
  if (message.role === "assistant") {
    const content: UnknownRecord[] = [];
    if (message.content.length > 0) {
      content.push({ type: "text", text: message.content });
    }
    for (const call of message.toolCalls ?? []) {
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: parseToolInput(call.argumentsJson),
      });
    }
    return {
      role: "assistant",
      content: content.length === 0 ? [{ type: "text", text: "" }] : content,
    };
  }
  return {
    role: "user",
    content: message.contentParts === undefined || message.contentParts.length === 0
      ? message.content
      : message.contentParts.map(toAnthropicContentPart),
  };
}

function toAnthropicContentPart(part: LlmMessageContentPart): UnknownRecord {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  const data = parseDataUrl(part.imageUrl.url);
  if (data !== undefined) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: data.mediaType,
        data: data.data,
      },
    };
  }
  return {
    type: "image",
    source: { type: "url", url: part.imageUrl.url },
  };
}

function toAnthropicTool(tool: LlmToolSchema): UnknownRecord {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: parseToolInput(tool.inputSchemaJson),
  };
}

function parseToolInput(value: string): UnknownRecord {
  const parsed = parseJsonRecord(value);
  return parsed ?? {};
}

function initialToolArguments(block: UnknownRecord | undefined): string {
  const input = readRecord(block, "input");
  return input === undefined || Object.keys(input).length === 0
    ? ""
    : JSON.stringify(input);
}

function normalizedToolArguments(value: string): string {
  return value.trim().length === 0 ? "{}" : value;
}

function modelUsage(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
): ModelUsage {
  return {
    inputTokens,
    cachedInputTokens: Math.min(inputTokens, cachedInputTokens),
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      while (true) {
        const boundary = eventBoundary(buffer);
        if (boundary === undefined) {
          break;
        }
        yield buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
      }
    }
    if (buffer.trim().length > 0) {
      yield buffer;
    }
  } finally {
    reader.releaseLock();
  }
}

function eventBoundary(value: string): { readonly index: number; readonly length: number } | undefined {
  const unix = value.indexOf("\n\n");
  const windows = value.indexOf("\r\n\r\n");
  if (unix < 0 && windows < 0) return undefined;
  if (unix < 0) return { index: windows, length: 4 };
  if (windows < 0) return { index: unix, length: 2 };
  return unix < windows
    ? { index: unix, length: 2 }
    : { index: windows, length: 4 };
}

function readSseData(event: string): string | null {
  const lines = event.split(/\r?\n/u);
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  return data.length === 0 ? null : data.join("\n");
}

async function responseErrorDetails(response: Response): Promise<string> {
  const text = (await response.text()).trim();
  if (text.length === 0) {
    return response.statusText || "Anthropic request failed";
  }
  const parsed = parseJsonRecord(text);
  const error = readRecord(parsed, "error");
  return readString(error, "message") ?? text.slice(0, 1000);
}

function anthropicHttpError(status: number, message: string): ModelError {
  const contextOverflow = /context|too many tokens|prompt is too long/iu.test(message);
  return {
    code: contextOverflow
      ? "context_overflow"
      : status === 400 || status === 404 || status === 422
        ? "invalid_request"
        : "http_error",
    message: `Anthropic HTTP ${status}: ${message}`,
    retryable:
      contextOverflow || status === 408 || status === 409 || status === 429 || status >= 500,
    status,
  };
}

function providerStreamError(error: UnknownRecord | undefined): ModelError {
  const type = readString(error, "type");
  const message = readString(error, "message") ?? "Anthropic streaming error";
  return {
    code: "provider_error",
    message: type === undefined ? message : `${type}: ${message}`,
    retryable: type === "overloaded_error" || type === "rate_limit_error",
  };
}

function invalidRequest(error: unknown): ModelError {
  return {
    code: "invalid_request",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

function unknownModelError(error: unknown): ModelError {
  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "aborted", message: error.message, retryable: false };
  }
  if (error instanceof TypeError) {
    return { code: "network_error", message: error.message, retryable: true };
  }
  return {
    code: "unknown",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

function parseDataUrl(value: string): { readonly mediaType: string; readonly data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(value);
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { mediaType: match[1], data: match[2] };
}

function parseJsonRecord(value: string): UnknownRecord | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as UnknownRecord
      : undefined;
  } catch {
    return undefined;
  }
}

function readRecord(
  value: UnknownRecord | undefined,
  key: string,
): UnknownRecord | undefined {
  const item = value?.[key];
  return typeof item === "object" && item !== null && !Array.isArray(item)
    ? item as UnknownRecord
    : undefined;
}

function readString(
  value: UnknownRecord | undefined,
  key: string,
): string | undefined {
  const item = value?.[key];
  return typeof item === "string" ? item : undefined;
}

function readNumber(
  value: UnknownRecord | undefined,
  key: string,
): number | undefined {
  const item = value?.[key];
  return typeof item === "number" && Number.isFinite(item) ? item : undefined;
}

function optionalString<Key extends string>(
  key: Key,
  value: string | undefined,
): { readonly [Property in Key]: string } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: string;
  };
}

function optionalNumber<Key extends string>(
  key: Key,
  value: number | undefined,
): { readonly [Property in Key]: number } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: number;
  };
}

function optionalSignal(signal: AbortSignal | undefined): { readonly signal: AbortSignal } | object {
  return signal === undefined ? {} : { signal };
}

function removeTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}
