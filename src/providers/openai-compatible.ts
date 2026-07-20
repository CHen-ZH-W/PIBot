import type {
  LlmMessage,
  LlmMessageContentPart,
  LlmMessageToolCall,
  LlmToolSchema,
} from "../core/agent";
import type { ToolCallId } from "../core/ids";
import { repairToolCallMessageOrder } from "../core/llm-history";
import type {
  ModelError,
  ModelEvent,
  ModelProviderAdapter,
  ModelRequest,
  ModelToolCall,
  ModelUsage,
} from "../agent/model";

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface OpenAICompatibleModelClientConfig {
  readonly apiKeyEnvVar?: string;
  readonly baseUrlEnvVar?: string;
  readonly modelEnvVar?: string;
  readonly defaultBaseUrl?: string;
  readonly defaultModel?: string;
}

interface ResolvedConfig {
  readonly apiKeyEnvVar: string;
  readonly baseUrlEnvVar: string;
  readonly modelEnvVar: string;
  readonly defaultBaseUrl: string;
  readonly defaultModel: string;
}

type ProviderRole = "system" | "user" | "assistant" | "tool";

type ProviderMessage =
  | {
      readonly role: "system" | "user";
      readonly content: string | readonly ProviderContentPart[];
    }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly reasoning_content?: string;
      readonly tool_calls?: readonly ProviderAssistantToolCall[];
    }
  | {
      readonly role: "tool";
      readonly content: string;
      readonly tool_call_id: string;
    };

type ProviderContentPart =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "image_url";
      readonly image_url: {
        readonly url: string;
        readonly detail?: "auto" | "low" | "high";
      };
    };

interface ProviderAssistantToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

interface ProviderTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: UnknownRecord;
  };
}

interface ProviderRequestBody {
  readonly model: string;
  readonly stream: true;
  readonly stream_options: {
    readonly include_usage: true;
  };
  readonly messages: readonly ProviderMessage[];
  readonly tools?: readonly ProviderTool[];
  readonly temperature?: number;
  readonly max_tokens?: number;
}

interface ToolCallAccumulator {
  readonly index: number;
  readonly id: string | undefined;
  readonly name: string | undefined;
  readonly argumentsJson: string;
}

export class OpenAICompatibleProviderAdapter implements ModelProviderAdapter {
  private readonly config: ResolvedConfig;

  constructor(config: OpenAICompatibleModelClientConfig = {}) {
    this.config = {
      apiKeyEnvVar: config.apiKeyEnvVar ?? "OPENAI_API_KEY",
      baseUrlEnvVar: config.baseUrlEnvVar ?? "OPENAI_BASE_URL",
      modelEnvVar: config.modelEnvVar ?? "OPENAI_MODEL",
      defaultBaseUrl: config.defaultBaseUrl ?? "https://api.openai.com/v1",
      defaultModel: config.defaultModel ?? "gpt-4o-mini",
    };
  }

  async *stream(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    const model = this.resolveModel(request);
    yield {
      type: "start",
      provider: "openai_compatible",
      model,
    };

    try {
      const apiKey = readEnv(this.config.apiKeyEnvVar);
      if (apiKey === undefined) {
        yield {
          type: "error",
          error: {
            code: "missing_api_key",
            message: `Missing required environment variable: ${this.config.apiKeyEnvVar}`,
            retryable: false,
          },
        };
        return;
      }

      const response = await fetch(this.chatCompletionsUrl(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(
          toProviderRequestBody(
            request,
            model,
            shouldBackfillMissingReasoningContent(model, this.chatCompletionsUrl()),
          ),
        ),
        ...optionalSignal(signal),
      });

      if (!response.ok) {
        const details = await responseErrorDetails(response);
        yield {
          type: "error",
          error: httpModelError(
            response.status,
            details.message,
            details.providerCode,
          ),
        };
        return;
      }

      if (response.body === null) {
        yield {
          type: "error",
          error: {
            code: "provider_error",
            message: "Provider returned an empty streaming response body",
            retryable: true,
          },
        };
        return;
      }

      let finishReason: string | undefined;
      let usage: ModelUsage | undefined;
      const toolCalls = new Map<number, ToolCallAccumulator>();

      for await (const event of readServerSentEvents(response.body)) {
        const data = readSseData(event);
        if (data === null) {
          continue;
        }

        if (data === "[DONE]") {
          break;
        }

        const chunk = parseJsonObject(data);
        if (chunk === null) {
          yield {
            type: "error",
            error: {
              code: "stream_parse_error",
              message: "Provider returned a non-JSON stream chunk",
              retryable: true,
            },
          };
          return;
        }

        const providerError = readProviderError(chunk);
        if (providerError !== null) {
          yield {
            type: "error",
            error: providerError,
          };
          return;
        }

        usage = readModelUsage(chunk) ?? usage;
        for (const choice of readChoices(chunk)) {
          usage = readModelUsage(choice) ?? usage;
          const choiceFinishReason = readString(choice, "finish_reason");
          if (choiceFinishReason !== undefined) {
            finishReason = choiceFinishReason;
          }

          const delta = readRecord(choice, "delta");
          if (delta === undefined) {
            continue;
          }

          const text = readString(delta, "content");
          if (text !== undefined) {
            yield {
              type: "text_delta",
              text,
            };
          }

          const reasoningText =
            readString(delta, "reasoning_content") ??
            readString(delta, "reasoning");
          if (reasoningText !== undefined) {
            yield {
              type: "reasoning_delta",
              text: reasoningText,
            };
          }

          mergeToolCallDeltas(toolCalls, delta);
        }
      }

      for (const call of completeToolCalls(toolCalls)) {
        yield {
          type: "tool_call",
          call,
        };
      }

      yield {
        type: "done",
        ...optionalFinishReason(finishReason),
        ...optionalUsage(usage),
      };
    } catch (error: unknown) {
      yield {
        type: "error",
        error: toModelError(error),
      };
    }
  }

  private resolveModel(request: ModelRequest): string {
    return (
      request.model ??
      readEnv(this.config.modelEnvVar) ??
      this.config.defaultModel
    );
  }

  private chatCompletionsUrl(): string {
    const baseUrl = removeTrailingSlash(
      readEnv(this.config.baseUrlEnvVar) ?? this.config.defaultBaseUrl,
    );
    return `${baseUrl}/chat/completions`;
  }
}

function toProviderRequestBody(
  request: ModelRequest,
  model: string,
  backfillMissingReasoningContent: boolean,
): ProviderRequestBody {
  return {
    model,
    stream: true,
    stream_options: {
      include_usage: true,
    },
    messages: repairToolCallMessageOrder(request.messages).map((message) =>
      toProviderMessage(message, backfillMissingReasoningContent),
    ),
    ...optionalTools(request.tools),
    ...optionalNumber("temperature", request.temperature),
    ...optionalNumber("max_tokens", request.maxOutputTokens),
  };
}

function toProviderMessage(
  message: LlmMessage,
  backfillMissingReasoningContent: boolean,
): ProviderMessage {
  if (message.role === "tool") {
    if (message.toolCallId === undefined) {
      throw new Error("Tool role messages require toolCallId");
    }

    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
    };
  }

  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      ...optionalProviderReasoningContent(
        message.reasoningContent,
        message.toolCalls,
        backfillMissingReasoningContent,
      ),
      ...optionalProviderToolCalls(message.toolCalls),
    };
  }

  return {
    role: message.role,
    content:
      message.contentParts === undefined || message.contentParts.length === 0
        ? message.content
        : message.contentParts.map(toProviderContentPart),
  };
}

function toProviderContentPart(
  part: LlmMessageContentPart,
): ProviderContentPart {
  switch (part.type) {
    case "text":
      return {
        type: "text",
        text: part.text,
      };
    case "image_url":
      return {
        type: "image_url",
        image_url: {
          url: part.imageUrl.url,
          ...optionalProviderImageDetail(part.imageUrl.detail),
        },
      };
  }
}

function optionalProviderImageDetail(
  detail: "auto" | "low" | "high" | undefined,
): { readonly detail: "auto" | "low" | "high" } | object {
  return detail === undefined ? {} : { detail };
}

function optionalProviderReasoningContent(
  reasoningContent: string | undefined,
  toolCalls: readonly LlmMessageToolCall[] | undefined,
  backfillMissingReasoningContent: boolean,
): { readonly reasoning_content: string } | object {
  if (reasoningContent !== undefined) {
    return { reasoning_content: reasoningContent };
  }

  if (
    backfillMissingReasoningContent &&
    toolCalls !== undefined &&
    toolCalls.length > 0
  ) {
    return { reasoning_content: "" };
  }

  return {};
}

function optionalProviderToolCalls(
  toolCalls: readonly LlmMessageToolCall[] | undefined,
): { readonly tool_calls: readonly ProviderAssistantToolCall[] } | object {
  if (toolCalls === undefined || toolCalls.length === 0) {
    return {};
  }

  return {
    tool_calls: toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: toolCall.argumentsJson,
      },
    })),
  };
}

function optionalTools(
  tools: readonly LlmToolSchema[],
): { readonly tools: readonly ProviderTool[] } | object {
  if (tools.length === 0) {
    return {};
  }

  return {
    tools: tools.map(toProviderTool),
  };
}

function toProviderTool(tool: LlmToolSchema): ProviderTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: parseJsonObjectOrThrow(tool.inputSchemaJson),
    },
  };
}

function parseJsonObjectOrThrow(value: string): UnknownRecord {
  const parsed = parseJsonObject(value);
  if (parsed === null) {
    throw new Error("Tool inputSchemaJson must be a JSON object");
  }

  return parsed;
}

async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      buffer += decoder.decode(result.value, { stream: true });
      const events = splitCompleteSseEvents(buffer);
      buffer = events.remainder;

      for (const event of events.completeEvents) {
        yield event;
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      yield buffer;
    }
  } finally {
    reader.releaseLock();
  }
}

function splitCompleteSseEvents(buffer: string): {
  readonly completeEvents: readonly string[];
  readonly remainder: string;
} {
  const parts = buffer.split(/\r?\n\r?\n/u);
  const remainder = parts.pop() ?? "";
  return {
    completeEvents: parts,
    remainder,
  };
}

function readSseData(event: string): string | null {
  const dataLines = event
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());

  if (dataLines.length === 0) {
    return null;
  }

  return dataLines.join("\n");
}

function readChoices(chunk: UnknownRecord): readonly UnknownRecord[] {
  const choices = chunk.choices;
  if (!Array.isArray(choices)) {
    return [];
  }

  return choices.filter(isRecord);
}

function mergeToolCallDeltas(
  toolCalls: Map<number, ToolCallAccumulator>,
  delta: UnknownRecord,
): void {
  const deltas = delta.tool_calls;
  if (!Array.isArray(deltas)) {
    return;
  }

  for (const toolCallDelta of deltas) {
    if (!isRecord(toolCallDelta)) {
      continue;
    }

    const index = readNumber(toolCallDelta, "index");
    if (index === undefined) {
      continue;
    }

    const existing = toolCalls.get(index);
    const functionDelta = readRecord(toolCallDelta, "function");
    const next: ToolCallAccumulator = {
      index,
      id: readString(toolCallDelta, "id") ?? existing?.id,
      name: readString(functionDelta, "name") ?? existing?.name,
      argumentsJson:
        (existing?.argumentsJson ?? "") +
        (readString(functionDelta, "arguments") ?? ""),
    };

    toolCalls.set(index, next);
  }
}

function completeToolCalls(
  toolCalls: Map<number, ToolCallAccumulator>,
): readonly ModelToolCall[] {
  return [...toolCalls.values()]
    .sort((left, right) => left.index - right.index)
    .flatMap((toolCall): readonly ModelToolCall[] => {
      if (toolCall.name === undefined) {
        return [];
      }

      return [
        {
          id: (toolCall.id ?? `tool_call_${toolCall.index}`) as ToolCallId,
          name: toolCall.name,
          argumentsJson: toolCall.argumentsJson,
        },
      ];
    });
}

function readProviderError(chunk: UnknownRecord): ModelError | null {
  const error = readRecord(chunk, "error");
  if (error === undefined) {
    return null;
  }

  const message = readString(error, "message") ?? "Provider returned an error";
  return isContextOverflow(message, readString(error, "code"))
    ? {
        code: "context_overflow",
        message,
        retryable: false,
      }
    : {
        code: "provider_error",
        message,
        retryable: false,
      };
}

function readModelUsage(record: UnknownRecord): ModelUsage | undefined {
  const usage = readRecord(record, "usage");
  if (usage === undefined) {
    return undefined;
  }

  const inputTokens = readNonNegativeNumber(usage, "prompt_tokens");
  const outputTokens = readNonNegativeNumber(usage, "completion_tokens");
  const totalTokens = readNonNegativeNumber(usage, "total_tokens");
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    totalTokens === undefined
  ) {
    return undefined;
  }

  const promptDetails = readRecord(usage, "prompt_tokens_details");
  return {
    inputTokens,
    cachedInputTokens:
      readNonNegativeNumber(usage, "cached_tokens") ??
      readNonNegativeNumber(promptDetails, "cached_tokens") ??
      0,
    outputTokens,
    totalTokens,
  };
}

async function responseErrorDetails(response: Response): Promise<{
  readonly message: string;
  readonly providerCode?: string;
}> {
  const text = await readResponseText(response);
  if (text === undefined) {
    return { message: `Provider returned HTTP ${response.status}` };
  }

  const parsed = parseJsonObject(text);
  const error = parsed === null ? undefined : readRecord(parsed, "error");
  const providerMessage =
    error === undefined ? undefined : readString(error, "message");
  const providerCode =
    error === undefined ? undefined : readString(error, "code");
  return {
    message: providerMessage ?? text,
    ...(providerCode === undefined ? {} : { providerCode }),
  };
}

async function readResponseText(
  response: Response,
): Promise<string | undefined> {
  try {
    const text = await response.text();
    return text.length > 0 ? text : undefined;
  } catch (_error: unknown) {
    return undefined;
  }
}

function toModelError(error: unknown): ModelError {
  if (isAbortError(error)) {
    return {
      code: "aborted",
      message: "Model request was aborted",
      retryable: false,
    };
  }

  if (error instanceof TypeError) {
    return {
      code: "network_error",
      message: error.message,
      retryable: true,
    };
  }

  if (error instanceof Error) {
    return {
      code: "invalid_request",
      message: error.message,
      retryable: false,
    };
  }

  return {
    code: "unknown",
    message: "Unknown model provider error",
    retryable: false,
  };
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    error.name === "AbortError"
  );
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function httpModelError(
  status: number,
  message: string,
  providerCode?: string,
): ModelError {
  return isContextOverflow(message, providerCode)
    ? {
        code: "context_overflow",
        message,
        retryable: false,
        status,
      }
    : {
        code: "http_error",
        message,
        retryable: isRetryableHttpStatus(status),
        status,
      };
}

function isContextOverflow(message: string, providerCode?: string): boolean {
  const value = `${providerCode ?? ""} ${message}`.toLowerCase();
  return (
    value.includes("context_length_exceeded") ||
    value.includes("maximum context length") ||
    value.includes("context window") ||
    /too many tokens|context.{0,30}(?:too long|length|limit|overflow)/u.test(value)
  );
}

function parseJsonObject(value: string): UnknownRecord | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch (_error: unknown) {
    return null;
  }
}

function readRecord(
  record: UnknownRecord | undefined,
  key: string,
): UnknownRecord | undefined {
  if (record === undefined) {
    return undefined;
  }

  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function readString(
  record: UnknownRecord | undefined,
  key: string,
): string | undefined {
  if (record === undefined) {
    return undefined;
  }

  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(
  record: UnknownRecord,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function readNonNegativeNumber(
  record: UnknownRecord | undefined,
  key: string,
): number | undefined {
  if (record === undefined) {
    return undefined;
  }

  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function optionalNumber<Key extends string>(
  key: Key,
  value: number | undefined,
): { readonly [Property in Key]: number } | object {
  if (value === undefined) {
    return {};
  }

  return { [key]: value } as { readonly [Property in Key]: number };
}

function optionalSignal(
  signal: AbortSignal | undefined,
): { readonly signal: AbortSignal } | object {
  if (signal === undefined) {
    return {};
  }

  return { signal };
}

function optionalFinishReason(
  finishReason: string | undefined,
): { readonly finishReason: string } | object {
  if (finishReason === undefined) {
    return {};
  }

  return { finishReason };
}

function optionalUsage(
  usage: ModelUsage | undefined,
): { readonly usage: ModelUsage } | object {
  if (usage === undefined) {
    return {};
  }

  return { usage };
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

function removeTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function shouldBackfillMissingReasoningContent(
  model: string,
  chatCompletionsUrl: string,
): boolean {
  const explicit = readBooleanEnv("OPENAI_REASONING_CONTENT_COMPAT");
  if (explicit !== undefined) {
    return explicit;
  }

  const normalizedModel = model.toLowerCase();
  const normalizedUrl = chatCompletionsUrl.toLowerCase();
  return normalizedModel.includes("kimi") || normalizedUrl.includes("moonshot");
}

function readBooleanEnv(name: string): boolean | undefined {
  const value = readEnv(name)?.toLowerCase();
  if (value === undefined) {
    return undefined;
  }

  if (value === "1" || value === "true" || value === "yes" || value === "on") {
    return true;
  }

  if (value === "0" || value === "false" || value === "no" || value === "off") {
    return false;
  }

  return undefined;
}

export class OpenAICompatibleModelClient extends OpenAICompatibleProviderAdapter {}
