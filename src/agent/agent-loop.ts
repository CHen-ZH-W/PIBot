import type {
  LlmMessage,
  LlmMessageContentPart,
  LlmMessageToolCall,
  LlmToolSchema,
} from "../core/agent";
import type {
  ToolCall,
  ToolError,
  ToolResult,
  UnparsedToolCall,
} from "../core/tools";
import type { ToolExecutor } from "../ports/tools";
import { createAgentRunContext, type AgentRunContext } from "../runtime/context";
import {
  RuntimeHookRunner,
  type RuntimeHook,
  type RuntimeModelCallResult,
} from "../runtime/hooks";
import type {
  ModelClient,
  ModelRequest,
  ModelToolCall,
  ModelUsage,
} from "./model";
import type {
  AgentEndReason,
  AgentLoopError,
  AgentLoopEvent,
  AgentLoopEventHandler,
} from "./events";
import { modelErrorToAgentLoopError } from "./events";

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface MinimalAgentLoopDependencies {
  readonly model: ModelClient;
  readonly tools: ToolExecutor;
  readonly hooks?: readonly RuntimeHook[];
}

export interface MinimalAgentLoopInput {
  readonly userText: string;
  readonly userContentParts?: readonly LlmMessageContentPart[];
  readonly systemPrompt: string;
  readonly history: readonly LlmMessage[];
  readonly tools: readonly LlmToolSchema[];
  readonly hooks?: readonly RuntimeHook[];
  readonly maxTurns: number;
  readonly runContext?: AgentRunContext;
  readonly model?: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly onEvent?: AgentLoopEventHandler;
}

export interface AgentLoopResult {
  readonly reason: AgentEndReason;
  readonly messages: readonly LlmMessage[];
  readonly turns: number;
  readonly model?: string;
  readonly usage?: ModelUsage;
  readonly error?: AgentLoopError;
}

interface TurnModelResult extends RuntimeModelCallResult {
  readonly assistantText: string;
  readonly reasoningContent?: string;
  readonly toolCalls: readonly ModelToolCall[];
  readonly aborted: boolean;
}

interface ModelUsageAccumulator {
  model: string | undefined;
  usage: ModelUsage;
  complete: boolean;
}

export class MinimalAgentLoop {
  private readonly baseHooks: readonly RuntimeHook[];

  constructor(private readonly dependencies: MinimalAgentLoopDependencies) {
    this.baseHooks = dependencies.hooks ?? [];
  }

  async run(
    input: MinimalAgentLoopInput,
    signal?: AbortSignal,
  ): Promise<AgentLoopResult> {
    const maxTurns = Math.max(1, input.maxTurns);
    const run = input.runContext ?? createAgentRunContext();
    const hooks = new RuntimeHookRunner([
      ...(input.hooks ?? []),
      ...this.baseHooks,
    ]);
    let messages = initialMessages(input);
    let completedTurns = 0;
    const usage = createModelUsageAccumulator();

    await emit(input.onEvent, {
      type: "agent_start",
      maxTurns,
    });

    if (isSignalAborted(signal)) {
      return this.end(
        hooks,
        run,
        input.onEvent,
        "aborted",
        messages,
        0,
        usage,
        abortedError(),
      );
    }

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      completedTurns = turn;
      await emit(input.onEvent, {
        type: "turn_start",
        turn,
      });

      const modelResult = await this.runModelTurn(
        hooks,
        run,
        input,
        messages,
        turn,
        signal,
      );
      addModelTurnUsage(usage, modelResult);
      const assistantMessage = toAssistantMessage(
        modelResult.assistantText,
        modelResult.reasoningContent,
        modelResult.toolCalls,
      );
      messages = [...messages, assistantMessage];
      await emit(input.onEvent, {
        type: "message_completed",
        turn,
        message: assistantMessage,
      });

      if (modelResult.aborted) {
        await emitTurnEnd(input.onEvent, turn, "aborted", modelResult.assistantText);
        return this.end(
          hooks,
          run,
          input.onEvent,
          "aborted",
          messages,
          completedTurns,
          usage,
          abortedError(),
        );
      }

      if (modelResult.error !== undefined) {
        await emitTurnEnd(input.onEvent, turn, "error", modelResult.assistantText);
        return this.end(
          hooks,
          run,
          input.onEvent,
          "error",
          messages,
          completedTurns,
          usage,
          modelResult.error,
        );
      }

      if (modelResult.toolCalls.length === 0) {
        await emitTurnEnd(input.onEvent, turn, "completed", modelResult.assistantText);
        return this.end(
          hooks,
          run,
          input.onEvent,
          "completed",
          messages,
          completedTurns,
          usage,
        );
      }

      const calls = modelResult.toolCalls.map((call) =>
        this.toExecutableToolCall(input, call));
      const results = await this.executeToolCalls(
        hooks,
        run,
        calls,
        turn,
        input.onEvent,
        signal,
      );
      const toolMessages = results.map(toolResultMessage);
      messages = [...messages, ...toolMessages];
      for (const message of toolMessages) {
        await emit(input.onEvent, {
          type: "message_completed",
          turn,
          message,
        });
      }

      if (isSignalAborted(signal)) {
        await emitTurnEnd(input.onEvent, turn, "aborted", modelResult.assistantText);
        return this.end(
          hooks,
          run,
          input.onEvent,
          "aborted",
          messages,
          completedTurns,
          usage,
          abortedError(),
        );
      }

      await emitTurnEnd(input.onEvent, turn, "tool_calls", modelResult.assistantText);
    }

    return this.end(
      hooks,
      run,
      input.onEvent,
      "max_turns",
      messages,
      completedTurns,
      usage,
      {
        code: "max_turns_exceeded",
        message: `Agent stopped after reaching maxTurns=${maxTurns}`,
        retryable: false,
      },
    );
  }

  private async runModelTurn(
    hooks: RuntimeHookRunner,
    run: AgentRunContext,
    input: MinimalAgentLoopInput,
    messages: readonly LlmMessage[],
    turn: number,
    signal: AbortSignal | undefined,
  ): Promise<TurnModelResult> {
    let assistantText = "";
    let reasoningContent = "";
    let model: string | undefined;
    let provider: string | undefined;
    let finishReason: string | undefined;
    let usage: ModelUsage | undefined;
    let retryCount = 0;
    const toolCalls: ModelToolCall[] = [];
    const startedAtMs = Date.now();
    const baseRequest: ModelRequest = {
      messages,
      tools: input.tools,
      ...optionalString("model", input.model),
      ...optionalNumber("temperature", input.temperature),
      ...optionalNumber("maxOutputTokens", input.maxOutputTokens),
    };
    let request = baseRequest;

    try {
      request = await hooks.beforeModelCall({
        run,
        turn,
        request: baseRequest,
      });
      for await (const modelEvent of this.dependencies.model.stream(request, signal)) {
        switch (modelEvent.type) {
          case "start":
            provider = modelEvent.provider;
            model = modelEvent.model;
            break;
          case "retry":
            retryCount += 1;
            break;
          case "reasoning_delta":
            reasoningContent += modelEvent.text;
            await emit(input.onEvent, {
              type: "reasoning_delta",
              turn,
              text: modelEvent.text,
            });
            break;
          case "text_delta":
            assistantText += modelEvent.text;
            await emit(input.onEvent, {
              type: "message_delta",
              turn,
              text: modelEvent.text,
            });
            break;
          case "tool_call":
            toolCalls.push(modelEvent.call);
            break;
          case "done":
            finishReason = modelEvent.finishReason;
            usage = modelEvent.usage ?? usage;
            break;
          case "error": {
            const error = modelErrorToAgentLoopError(modelEvent.error);
            const result = modelTurnResult({
              assistantText,
              reasoningContent,
              toolCalls,
              model,
              provider,
              finishReason,
              usage,
              retryCount,
              startedAtMs,
              error,
            });
            await this.afterModelCall(hooks, run, turn, request, result);
            return result;
          }
        }
      }
    } catch (error: unknown) {
      const agentError = unknownToAgentLoopError(error);
      const result = modelTurnResult({
        assistantText,
        reasoningContent,
        toolCalls,
        model,
        provider,
        finishReason,
        usage,
        retryCount,
        startedAtMs,
        error: agentError,
      });
      await this.afterModelCall(hooks, run, turn, request, result);
      return result;
    }

    const result = modelTurnResult({
      assistantText,
      reasoningContent,
      toolCalls,
      model,
      provider,
      finishReason,
      usage,
      retryCount,
      startedAtMs,
    });
    await this.afterModelCall(hooks, run, turn, request, result);
    return result;
  }

  private async afterModelCall(
    hooks: RuntimeHookRunner,
    run: AgentRunContext,
    turn: number,
    request: ModelRequest,
    result: TurnModelResult,
  ): Promise<void> {
    await hooks.afterModelCall({
      run,
      turn,
      request,
      result,
    });
  }

  private toExecutableToolCall(
    input: MinimalAgentLoopInput,
    modelToolCall: ModelToolCall,
  ): ToolCall {
    const availableToolNames = new Set(input.tools.map((tool) => tool.name));
    if (
      !availableToolNames.has(modelToolCall.name) ||
      !this.dependencies.tools.listTools().includes(modelToolCall.name)
    ) {
      return invalidToolCall(modelToolCall, `Tool "${modelToolCall.name}" is not available`);
    }

    if (this.dependencies.tools.parseToolCall !== undefined) {
      return this.dependencies.tools.parseToolCall(modelToolCall).call;
    }

    const parsedArguments = parseJsonObject(modelToolCall.argumentsJson);
    return parsedArguments === null
      ? invalidToolCall(
          modelToolCall,
          `Tool "${modelToolCall.name}" arguments must be a JSON object`,
        )
      : {
          id: modelToolCall.id,
          name: modelToolCall.name,
          input: parsedArguments,
        };
  }

  private async executeToolCalls(
    hooks: RuntimeHookRunner,
    run: AgentRunContext,
    calls: readonly ToolCall[],
    turn: number,
    onEvent: AgentLoopEventHandler | undefined,
    signal: AbortSignal | undefined,
  ): Promise<readonly ToolResult[]> {
    const results: ToolResult[] = [];
    let pending: Promise<void>[] = [];
    const flush = async () => {
      await Promise.all(pending);
      pending = [];
    };

    for (const [index, call] of calls.entries()) {
      const execute = async () => {
        results[index] = await this.executeToolCall(
          hooks,
          run,
          call,
          turn,
          onEvent,
          signal,
        );
      };
      if (
        !isInvalidToolCall(call) &&
        this.dependencies.tools.describeTool?.(call.name)?.executionMode === "parallel"
      ) {
        pending.push(execute());
        continue;
      }
      await flush();
      await execute();
    }
    await flush();
    return results;
  }

  private async executeToolCall(
    hooks: RuntimeHookRunner,
    run: AgentRunContext,
    originalCall: ToolCall,
    turn: number,
    onEvent: AgentLoopEventHandler | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ToolResult> {
    const startedAtMs = Date.now();
    const metadata = this.dependencies.tools.describeTool?.(originalCall.name);
    await emit(onEvent, {
      type: "tool_start",
      turn,
      call: originalCall,
    });

    let call = originalCall;
    let result: ToolResult;
    try {
      const decision = await hooks.beforeToolCall({
        run,
        turn,
        call,
        ...optionalMetadata(metadata),
        startedAtMs,
      });
      if (!decision.allowed) {
        result = deniedToolResult(call, decision.reason);
      } else {
        call = decision.call ?? call;
        result = isInvalidToolCall(call)
          ? invalidToolResult(call)
          : await safelyExecuteTool(this.dependencies.tools, call, signal);
      }
    } catch (error: unknown) {
      result = {
        ok: false,
        callId: call.id,
        error: toToolError(error),
      };
    }

    const hookContext = {
      run,
      turn,
      call,
      ...optionalMetadata(metadata),
      startedAtMs,
      result,
      durationMs: Date.now() - startedAtMs,
    };
    result = result.ok
      ? await hooks.afterToolCall(hookContext)
      : await hooks.onToolFailure(hookContext);

    await emit(onEvent, {
      type: "tool_end",
      turn,
      call,
      result,
    });
    return result;
  }

  private async end(
    hooks: RuntimeHookRunner,
    run: AgentRunContext,
    onEvent: AgentLoopEventHandler | undefined,
    reason: AgentEndReason,
    messages: readonly LlmMessage[],
    turns: number,
    usage: ModelUsageAccumulator,
    error?: AgentLoopError,
  ): Promise<AgentLoopResult> {
    await hooks.onStop({
      run,
      reason,
      turns,
      ...optionalAgentError(error),
    });
    await emit(onEvent, {
      type: "agent_end",
      reason,
      messages,
      ...optionalAgentError(error),
    });
    return {
      reason,
      messages,
      turns,
      ...optionalString("model", usage.model),
      ...optionalCompleteModelUsage(usage),
      ...optionalAgentError(error),
    };
  }
}

function modelTurnResult(input: {
  readonly assistantText: string;
  readonly reasoningContent: string;
  readonly toolCalls: readonly ModelToolCall[];
  readonly model?: string | undefined;
  readonly provider?: string | undefined;
  readonly finishReason?: string | undefined;
  readonly usage?: ModelUsage | undefined;
  readonly retryCount: number;
  readonly startedAtMs: number;
  readonly error?: AgentLoopError | undefined;
}): TurnModelResult {
  return {
    assistantText: input.assistantText,
    ...optionalNonEmptyString("reasoningContent", input.reasoningContent),
    toolCalls: input.toolCalls,
    ...optionalString("model", input.model),
    ...optionalString("provider", input.provider),
    ...optionalString("finishReason", input.finishReason),
    ...optionalModelUsage(input.usage),
    retryCount: input.retryCount,
    durationMs: Date.now() - input.startedAtMs,
    ...optionalAgentError(input.error),
    aborted: input.error?.code === "aborted",
  };
}

function createModelUsageAccumulator(): ModelUsageAccumulator {
  return {
    model: undefined,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    complete: true,
  };
}

function addModelTurnUsage(accumulator: ModelUsageAccumulator, turn: TurnModelResult): void {
  accumulator.model = turn.model ?? accumulator.model;
  if (turn.usage === undefined) {
    accumulator.complete = false;
    return;
  }
  accumulator.usage = {
    inputTokens: accumulator.usage.inputTokens + turn.usage.inputTokens,
    cachedInputTokens:
      accumulator.usage.cachedInputTokens + turn.usage.cachedInputTokens,
    outputTokens: accumulator.usage.outputTokens + turn.usage.outputTokens,
    totalTokens: accumulator.usage.totalTokens + turn.usage.totalTokens,
  };
}

function initialMessages(input: MinimalAgentLoopInput): readonly LlmMessage[] {
  return [
    { role: "system", content: input.systemPrompt },
    ...input.history,
    {
      role: "user",
      content: input.userText,
      ...optionalContentParts(input.userText, input.userContentParts),
    },
  ];
}

function optionalContentParts(
  userText: string,
  parts: readonly LlmMessageContentPart[] | undefined,
): { readonly contentParts: readonly LlmMessageContentPart[] } | object {
  if (parts === undefined || parts.length === 0) {
    return {};
  }

  return {
    contentParts: [
      {
        type: "text",
        text: userText,
      },
      ...parts,
    ],
  };
}

function toAssistantMessage(
  assistantText: string,
  reasoningContent: string | undefined,
  toolCalls: readonly ModelToolCall[],
): LlmMessage {
  return {
    role: "assistant",
    content: assistantText,
    ...optionalNonEmptyString("reasoningContent", reasoningContent),
    ...(toolCalls.length === 0
      ? {}
      : {
          toolCalls: toolCalls.map((toolCall): LlmMessageToolCall => ({
            id: toolCall.id,
            name: toolCall.name,
            argumentsJson: toolCall.argumentsJson,
          })),
        }),
  };
}

function toolResultMessage(result: ToolResult): LlmMessage {
  return {
    role: "tool",
    content: JSON.stringify(result),
    toolCallId: result.callId,
  };
}

function invalidToolCall(call: UnparsedToolCall, message: string): ToolCall {
  return {
    id: call.id,
    name: call.name,
    input: {},
    reason: `invalid_tool_call:${message}`,
  };
}

function isInvalidToolCall(call: ToolCall): boolean {
  return call.reason?.startsWith("invalid_tool_call:") === true;
}

function invalidToolResult(call: ToolCall): ToolResult {
  return {
    ok: false,
    callId: call.id,
    error: {
      code: "invalid_input",
      message: call.reason?.replace(/^invalid_tool_call:/u, "") ?? "Invalid tool call",
      retryable: false,
    },
  };
}

function deniedToolResult(call: ToolCall, message: string): ToolResult {
  return {
    ok: false,
    callId: call.id,
    error: {
      code: "permission_denied",
      message,
      retryable: false,
    },
  };
}

async function safelyExecuteTool(
  tools: ToolExecutor,
  call: ToolCall,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  try {
    return await tools.executeTool(call, signal);
  } catch (error: unknown) {
    return {
      ok: false,
      callId: call.id,
      error: toToolError(error),
    };
  }
}

function toToolError(error: unknown): ToolError {
  return {
    code: "execution_failed",
    message:
      error instanceof Error
        ? error.message
        : "Unknown tool execution error",
    retryable: false,
  };
}

function parseJsonObject(value: string): UnknownRecord | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function unknownToAgentLoopError(error: unknown): AgentLoopError {
  if (isAbortError(error)) {
    return abortedError();
  }
  return {
    code: "unknown",
    message: error instanceof Error ? error.message : "Unknown agent loop error",
    retryable: false,
  };
}

function abortedError(): AgentLoopError {
  return {
    code: "aborted",
    message: "Agent loop was aborted",
    retryable: false,
  };
}

async function emitTurnEnd(
  handler: AgentLoopEventHandler | undefined,
  turn: number,
  reason: "completed" | "tool_calls" | "aborted" | "error",
  assistantText: string,
): Promise<void> {
  await emit(handler, { type: "turn_end", turn, reason, assistantText });
}

async function emit(
  handler: AgentLoopEventHandler | undefined,
  event: AgentLoopEvent,
): Promise<void> {
  await handler?.(event);
}

function optionalNumber<Key extends string>(
  key: Key,
  value: number | undefined,
): { readonly [Property in Key]: number } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: number;
  };
}

function optionalString<Key extends string>(
  key: Key,
  value: string | undefined,
): { readonly [Property in Key]: string } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: string;
  };
}

function optionalNonEmptyString<Key extends string>(
  key: Key,
  value: string | undefined,
): { readonly [Property in Key]: string } | object {
  return value === undefined || value.length === 0
    ? {}
    : { [key]: value } as { readonly [Property in Key]: string };
}

function optionalModelUsage(
  usage: ModelUsage | undefined,
): { readonly usage: ModelUsage } | object {
  return usage === undefined ? {} : { usage };
}

function optionalCompleteModelUsage(
  accumulator: ModelUsageAccumulator,
): { readonly usage: ModelUsage } | object {
  return accumulator.complete ? { usage: accumulator.usage } : {};
}

function optionalAgentError(
  error: AgentLoopError | undefined,
): { readonly error: AgentLoopError } | object {
  return error === undefined ? {} : { error };
}

function optionalMetadata(
  metadata: ReturnType<NonNullable<ToolExecutor["describeTool"]>>,
): { readonly metadata: NonNullable<typeof metadata> } | object {
  return metadata === undefined ? {} : { metadata };
}
