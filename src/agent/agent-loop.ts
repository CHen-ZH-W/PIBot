import type {
  LlmMessage,
  LlmMessageContentPart,
  LlmMessageToolCall,
  LlmToolSchema,
} from "../core/agent";
import type {
  ToolCall,
  ToolResult,
  UnparsedToolCall,
} from "../core/tools";
import type { ToolExecutor } from "../ports/tools";
import {
  captureAgentStepContext,
  createAgentRunContext,
  agentNextStepInbox,
  withAdvertisedStepTools,
  type AgentRunContext,
  type AgentStepContext,
} from "../runtime/context";
import {
  RuntimeHookRunner,
  type RuntimeHook,
  type RuntimeModelCallResult,
} from "../runtime/hooks";
import {
  BoundedToolScheduler,
  type ToolScheduler,
} from "../runtime/tool-scheduler";
import { decideAfterStep } from "../runtime/decisions";
import type {
  ModelClient,
  DeveloperRoleMode,
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
import type { ModelRef } from "../models/types";
import { modelErrorToAgentLoopError } from "./events";
import {
  ContextManager,
  ContextLanesHook,
  type ContextLane,
} from "../workspace/context-manager";

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface MinimalAgentLoopDependencies {
  readonly model: ModelClient;
  readonly tools: ToolExecutor;
  readonly contextManager?: ContextManager;
  readonly hooks?: readonly RuntimeHook[];
  readonly maxParallelToolCalls?: number;
  readonly toolScheduler?: ToolScheduler;
}

export interface MinimalAgentLoopInput {
  readonly userText: string;
  readonly userContentParts?: readonly LlmMessageContentPart[];
  readonly systemPrompt: string;
  readonly contextLanes?: readonly ContextLane[];
  readonly history: readonly LlmMessage[];
  readonly tools: readonly LlmToolSchema[];
  readonly hooks?: readonly RuntimeHook[];
  /** Runs after loop-level hooks, once runtime/world-state projection is final. */
  readonly postHooks?: readonly RuntimeHook[];
  readonly maxSteps: number;
  readonly maxParallelToolCalls?: number;
  readonly runContext?: AgentRunContext;
  readonly model?: string;
  readonly modelRef?: ModelRef;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly onEvent?: AgentLoopEventHandler;
}

export interface AgentLoopResult {
  readonly reason: AgentEndReason;
  readonly messages: readonly LlmMessage[];
  readonly steps: number;
  readonly model?: string;
  readonly provider?: string;
  readonly usage?: ModelUsage;
  readonly error?: AgentLoopError;
}

interface StepModelResult extends RuntimeModelCallResult {
  readonly stepContext: AgentStepContext;
  readonly assistantText: string;
  readonly reasoningContent?: string;
  readonly toolCalls: readonly ModelToolCall[];
  readonly toolResults: Promise<readonly ToolResult[]>;
  readonly aborted: boolean;
}

interface ModelUsageAccumulator {
  model: string | undefined;
  provider: string | undefined;
  usage: ModelUsage;
  complete: boolean;
}

export class MinimalAgentLoop {
  private readonly baseHooks: readonly RuntimeHook[];
  private readonly contextManager: ContextManager;

  constructor(private readonly dependencies: MinimalAgentLoopDependencies) {
    this.baseHooks = dependencies.hooks ?? [];
    this.contextManager = dependencies.contextManager ?? new ContextManager();
  }

  async run(
    input: MinimalAgentLoopInput,
    signal?: AbortSignal,
  ): Promise<AgentLoopResult> {
    const maxSteps = positiveInteger(input.maxSteps, 1, "maxSteps");
    const maxParallelToolCalls = positiveInteger(
      input.maxParallelToolCalls ?? this.dependencies.maxParallelToolCalls,
      8,
      "maxParallelToolCalls",
    );
    const run = input.runContext ?? createAgentRunContext();
    const hooks = new RuntimeHookRunner([
      ...(input.contextLanes === undefined || input.contextLanes.length === 0
        ? []
        : [new ContextLanesHook(input.contextLanes, this.contextManager)]),
      ...(input.hooks ?? []),
      ...this.baseHooks,
      ...(input.postHooks ?? []),
    ]);
    const toolScheduler = this.dependencies.toolScheduler ?? new BoundedToolScheduler({
      tools: this.dependencies.tools,
      hooks,
      maxParallelToolCalls,
    });
    let messages = initialMessages(input);
    let completedSteps = 0;
    const usage = createModelUsageAccumulator();

    await emit(input.onEvent, {
      type: "agent_start",
      maxSteps,
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

    for (let attemptStep = 1; attemptStep <= maxSteps; attemptStep += 1) {
      completedSteps = attemptStep;
      const stepContext = captureAgentStepContext(
        run,
        input.model,
        captureToolExecutionSnapshot(this.dependencies.tools, run),
      );
      await emit(input.onEvent, {
        type: "step_start",
        step: stepContext.step,
      });

      const modelResult = await this.runModelStep(
        hooks,
        run,
        input,
        messages,
        stepContext,
        toolScheduler,
        signal,
      );
      addModelStepUsage(usage, modelResult);
      const assistantMessage = toAssistantMessage(
        modelResult.assistantText,
        modelResult.reasoningContent,
        modelResult.toolCalls,
      );
      messages = [...messages, assistantMessage];
      await emit(input.onEvent, {
        type: "message_completed",
        step: modelResult.stepContext.step,
        message: assistantMessage,
      });
      const toolMessages = (await modelResult.toolResults).map((result) =>
        toolResultMessage(this.contextManager.admitToolResult(result)));
      messages = [...messages, ...toolMessages];
      for (const message of toolMessages) {
        await emit(input.onEvent, {
          type: "message_completed",
          step: modelResult.stepContext.step,
          message,
        });
      }

      if (modelResult.aborted || isSignalAborted(signal)) {
        await finishStepDurably(
          run,
          modelResult.stepContext,
          "cancelled",
          "agent_step_aborted",
        );
        await emitStepEnd(
          input.onEvent,
          modelResult.stepContext.step,
          "aborted",
          modelResult.assistantText,
        );
        return this.end(
          hooks,
          run,
          input.onEvent,
          "aborted",
          messages,
          completedSteps,
          usage,
          abortedError(),
        );
      }

      if (modelResult.error !== undefined) {
        await finishStepDurably(
          run,
          modelResult.stepContext,
          "failed",
          modelResult.error.message,
        );
        await emitStepEnd(
          input.onEvent,
          modelResult.stepContext.step,
          "error",
          modelResult.assistantText,
        );
        return this.end(
          hooks,
          run,
          input.onEvent,
          "error",
          messages,
          completedSteps,
          usage,
          modelResult.error,
        );
      }

      if (modelResult.toolCalls.length === 0) {
        const decision = decideAfterStep(
          {
            type: "model_completed",
            pendingSteering: hasPendingSteering(run),
          },
          attemptStep < maxSteps,
        );
        if (decision.type === "continue_with_steering") {
          emitTransition(run, decision);
          await finishStepDurably(
            run,
            modelResult.stepContext,
            "completed",
            "steering_pending",
          );
          await emitStepEnd(
            input.onEvent,
            modelResult.stepContext.step,
            "steering",
            modelResult.assistantText,
          );
          continue;
        }
        await finishStepDurably(
          run,
          modelResult.stepContext,
          "completed",
          "model_completed",
        );
        await emitStepEnd(
          input.onEvent,
          modelResult.stepContext.step,
          "completed",
          modelResult.assistantText,
        );
        if (attemptStep < maxSteps && hasPendingSteering(run)) {
          emitTransition(run, { type: "continue_with_steering" });
          continue;
        }
        return this.end(
          hooks,
          run,
          input.onEvent,
          "completed",
          messages,
          completedSteps,
          usage,
        );
      }

      if (isSignalAborted(signal)) {
        await finishStepDurably(
          run,
          modelResult.stepContext,
          "cancelled",
          "agent_step_aborted",
        );
        await emitStepEnd(
          input.onEvent,
          modelResult.stepContext.step,
          "aborted",
          modelResult.assistantText,
        );
        return this.end(
          hooks,
          run,
          input.onEvent,
          "aborted",
          messages,
          completedSteps,
          usage,
          abortedError(),
        );
      }

      if (attemptStep < maxSteps) {
        const decision = decideAfterStep(
          {
            type: "tool_batch_completed",
            pendingSteering: hasPendingSteering(run),
          },
          true,
        );
        if (decision.type === "continue_step") {
          emitTransition(run, {
            ...decision,
            step: modelResult.stepContext.step,
          });
        } else if (decision.type === "continue_with_steering") {
          emitTransition(run, decision);
        }
      }
      await finishStepDurably(
        run,
        modelResult.stepContext,
        "completed",
        "tool_batch_completed",
      );
      await emitStepEnd(
        input.onEvent,
        modelResult.stepContext.step,
        "tool_calls",
        modelResult.assistantText,
      );
    }

    return this.end(
      hooks,
      run,
      input.onEvent,
      "max_steps",
      messages,
      completedSteps,
      usage,
      {
        code: "max_steps_exceeded",
        message: `Agent stopped after reaching maxSteps=${maxSteps}`,
        retryable: false,
      },
    );
  }

  private async runModelStep(
    hooks: RuntimeHookRunner,
    run: AgentRunContext,
    input: MinimalAgentLoopInput,
    messages: readonly LlmMessage[],
    initialStepContext: AgentStepContext,
    toolScheduler: ToolScheduler,
    signal: AbortSignal | undefined,
  ): Promise<StepModelResult> {
    let assistantText = "";
    let reasoningContent = "";
    let model: string | undefined;
    let provider: string | undefined;
    let developerRoleMode: DeveloperRoleMode | undefined;
    let authorityDegraded: boolean | undefined;
    let finishReason: string | undefined;
    let usage: ModelUsage | undefined;
    let retryCount = 0;
    const toolCalls: ModelToolCall[] = [];
    let toolResults: Promise<readonly ToolResult[]> = Promise.resolve([]);
    let toolSession: ReturnType<ToolScheduler["begin"]> | undefined;
    const startedAtMs = Date.now();
    const baseRequest: ModelRequest = {
      messages: withStepControlMessages(messages, initialStepContext),
      tools: input.tools,
      ...optionalString("model", input.model),
      ...(input.modelRef === undefined ? {} : { modelRef: input.modelRef }),
      ...optionalNumber("temperature", input.temperature),
      ...optionalNumber("maxOutputTokens", input.maxOutputTokens),
    };
    let request = baseRequest;
    let stepContext = initialStepContext;

    try {
      stepContext = await hooks.captureStepContext({
        run,
        step: initialStepContext.step,
        stepContext: initialStepContext,
      });
      request = await hooks.beforeModelCall({
        run,
        step: stepContext.step,
        stepContext,
        request: baseRequest,
      });
      stepContext = withAdvertisedStepTools(
        stepContext,
        request.tools.map((tool) => tool.name),
      );
      await run.durability?.openStep(stepContext);
      toolSession = toolScheduler.begin({
        run,
        stepContext,
        ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
        ...(signal === undefined ? {} : { signal }),
      });
      for await (const modelEvent of this.dependencies.model.stream(request, signal)) {
        switch (modelEvent.type) {
          case "start":
            provider = modelEvent.provider;
            model = modelEvent.model;
            developerRoleMode = modelEvent.developerRoleMode;
            authorityDegraded = modelEvent.authorityDegraded;
            break;
          case "retry":
            retryCount += 1;
            emitTransition(run, {
              type: "retry_model",
              step: stepContext.step,
              attempt: retryCount,
            });
            break;
          case "reasoning_delta":
            reasoningContent += modelEvent.text;
            await emit(input.onEvent, {
              type: "reasoning_delta",
              step: stepContext.step,
              text: modelEvent.text,
            });
            break;
          case "text_delta":
            assistantText += modelEvent.text;
            await emit(input.onEvent, {
              type: "message_delta",
              step: stepContext.step,
              text: modelEvent.text,
            });
            break;
          case "tool_call":
            toolCalls.push(modelEvent.call);
            void toolSession.submit(
              this.toExecutableToolCall(stepContext, modelEvent.call),
            );
            break;
          case "done":
            finishReason = modelEvent.finishReason;
            usage = modelEvent.usage ?? usage;
            break;
          case "error": {
            const error = modelErrorToAgentLoopError(modelEvent.error);
            toolResults = toolSession.close();
            const result = modelStepResult({
              stepContext,
              assistantText,
              reasoningContent,
              toolCalls,
              toolResults,
              model,
              provider,
              developerRoleMode,
              authorityDegraded,
              finishReason,
              usage,
              retryCount,
              startedAtMs,
              error,
            });
            await this.afterModelCall(hooks, run, stepContext, request, result);
            return result;
          }
        }
      }
    } catch (error: unknown) {
      const agentError = unknownToAgentLoopError(error);
      toolResults = toolSession === undefined
        ? Promise.resolve([])
        : toolSession.close();
      const result = modelStepResult({
        stepContext,
        assistantText,
        reasoningContent,
        toolCalls,
        toolResults,
        model,
        provider,
        developerRoleMode,
        authorityDegraded,
        finishReason,
        usage,
        retryCount,
        startedAtMs,
        error: agentError,
      });
      await this.afterModelCall(hooks, run, stepContext, request, result);
      return result;
    }

    toolResults = toolSession === undefined
      ? Promise.resolve([])
      : toolSession.close();
    const result = modelStepResult({
      stepContext,
      assistantText,
      reasoningContent,
      toolCalls,
      toolResults,
      model,
      provider,
      developerRoleMode,
      authorityDegraded,
      finishReason,
      usage,
      retryCount,
      startedAtMs,
    });
    await this.afterModelCall(hooks, run, stepContext, request, result);
    return result;
  }

  private async afterModelCall(
    hooks: RuntimeHookRunner,
    run: AgentRunContext,
    stepContext: AgentStepContext,
    request: ModelRequest,
    result: StepModelResult,
  ): Promise<void> {
    await hooks.afterModelCall({
      run,
      step: stepContext.step,
      stepContext,
      request,
      result,
    });
  }

  private toExecutableToolCall(
    stepContext: AgentStepContext,
    modelToolCall: ModelToolCall,
  ): ToolCall {
    const availableToolNames = new Set(stepContext.advertisedTools);
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

  private async end(
    hooks: RuntimeHookRunner,
    run: AgentRunContext,
    onEvent: AgentLoopEventHandler | undefined,
    reason: AgentEndReason,
    messages: readonly LlmMessage[],
    steps: number,
    usage: ModelUsageAccumulator,
    error?: AgentLoopError,
  ): Promise<AgentLoopResult> {
    await hooks.onStop({
      run,
      reason,
      steps,
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
      steps,
      ...optionalString("model", usage.model),
      ...optionalString("provider", usage.provider),
      ...optionalCompleteModelUsage(usage),
      ...optionalAgentError(error),
    };
  }
}

function modelStepResult(input: {
  readonly stepContext: AgentStepContext;
  readonly assistantText: string;
  readonly reasoningContent: string;
  readonly toolCalls: readonly ModelToolCall[];
  readonly toolResults: Promise<readonly ToolResult[]>;
  readonly model?: string | undefined;
  readonly provider?: string | undefined;
  readonly developerRoleMode?: DeveloperRoleMode | undefined;
  readonly authorityDegraded?: boolean | undefined;
  readonly finishReason?: string | undefined;
  readonly usage?: ModelUsage | undefined;
  readonly retryCount: number;
  readonly startedAtMs: number;
  readonly error?: AgentLoopError | undefined;
}): StepModelResult {
  return {
    stepContext: input.stepContext,
    assistantText: input.assistantText,
    ...optionalNonEmptyString("reasoningContent", input.reasoningContent),
    toolCalls: input.toolCalls,
    toolResults: input.toolResults,
    ...optionalString("model", input.model),
    ...optionalString("provider", input.provider),
    ...(input.developerRoleMode === undefined
      ? {}
      : { developerRoleMode: input.developerRoleMode }),
    ...(input.authorityDegraded === undefined
      ? {}
      : { authorityDegraded: input.authorityDegraded }),
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
    provider: undefined,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    complete: true,
  };
}

function addModelStepUsage(accumulator: ModelUsageAccumulator, step: StepModelResult): void {
  accumulator.model = step.model ?? accumulator.model;
  accumulator.provider = step.provider ?? accumulator.provider;
  if (step.usage === undefined) {
    accumulator.complete = false;
    return;
  }
  accumulator.usage = {
    inputTokens: accumulator.usage.inputTokens + step.usage.inputTokens,
    cachedInputTokens:
      accumulator.usage.cachedInputTokens + step.usage.cachedInputTokens,
    outputTokens: accumulator.usage.outputTokens + step.usage.outputTokens,
    totalTokens: accumulator.usage.totalTokens + step.usage.totalTokens,
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
  return error instanceof Error && error.name === "AbortError";
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function hasPendingSteering(run: AgentRunContext): boolean {
  return (
    agentNextStepInbox(run).hasPending(run.userTurnId) ||
    run.state.steering.messages.length > 0
  );
}

function withStepControlMessages(
  messages: readonly LlmMessage[],
  stepContext: AgentStepContext,
): readonly LlmMessage[] {
  if (stepContext.steeringMessages.length === 0) {
    return messages;
  }
  return [
    ...messages,
    ...stepContext.steeringMessages.map(
      (message): LlmMessage => ({
        role: "user",
        content: `Steering message received during this run:\n${message}`,
      }),
    ),
  ];
}

function emitTransition(
  run: AgentRunContext,
  transition: Parameters<NonNullable<AgentRunContext["onTransition"]>>[0],
): void {
  try {
    const observation = run.onTransition?.(transition);
    void Promise.resolve(observation).catch(() => undefined);
  } catch {
    // Transition observers are diagnostic and must not change run behavior.
  }
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

async function emitStepEnd(
  handler: AgentLoopEventHandler | undefined,
  step: number,
  reason: "completed" | "tool_calls" | "steering" | "aborted" | "error",
  assistantText: string,
): Promise<void> {
  await emit(handler, { type: "step_end", step, reason, assistantText });
}

async function finishStepDurably(
  run: AgentRunContext,
  stepContext: AgentStepContext,
  status: "completed" | "failed" | "cancelled",
  reason: string,
): Promise<void> {
  await run.durability?.finishStep({
    runId: stepContext.runId,
    userTurnId: stepContext.userTurnId,
    stepId: stepContext.stepId,
    status,
    reason,
  });
}

async function emit(
  handler: AgentLoopEventHandler | undefined,
  event: AgentLoopEvent,
): Promise<void> {
  await handler?.(event);
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
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

function captureToolExecutionSnapshot(
  tools: ToolExecutor,
  run: AgentRunContext,
) {
  const captured = tools.captureExecutionSnapshot?.();
  if (captured !== undefined) {
    return Object.freeze({
      ...captured,
      availableTools: Object.freeze([...captured.availableTools]),
    });
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    authorityVersion: "unversioned",
    availableTools: Object.freeze([...tools.listTools()]),
    runtimeStateVersion: run.state.version,
    mode: run.state.mode,
  });
}
