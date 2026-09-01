import type { ToolCall, ToolError, ToolResult } from "../core/tools";
import type { ToolExecutor } from "../ports/tools";
import type {
  AgentLoopEvent,
  AgentLoopEventHandler,
} from "../agent/events";
import type { AgentRunContext, AgentStepContext } from "./context";
import { RuntimeHookRunner } from "./hooks";
import type { RuntimeTransition } from "./transitions";

export interface ToolBatchScheduleInput {
  readonly run: AgentRunContext;
  readonly stepContext: AgentStepContext;
  readonly calls: readonly ToolCall[];
  readonly signal?: AbortSignal;
  readonly onEvent?: AgentLoopEventHandler;
}

export type ToolStreamScheduleInput = Omit<ToolBatchScheduleInput, "calls">;

export interface ToolScheduleSession {
  /** Submits one complete tool call as soon as the provider closes its block. */
  submit(call: ToolCall): Promise<ToolResult>;
  /** Seals this Step and resolves all results in model call order. */
  close(): Promise<readonly ToolResult[]>;
}

export interface ToolScheduler {
  begin(input: ToolStreamScheduleInput): ToolScheduleSession;
  schedule(input: ToolBatchScheduleInput): Promise<readonly ToolResult[]>;
}

export interface BoundedToolSchedulerOptions {
  readonly tools: ToolExecutor;
  readonly hooks: RuntimeHookRunner;
  readonly maxParallelToolCalls: number;
}

/**
 * Preserves serial barriers and model call order while applying bounded
 * backpressure to parallel-safe calls. Every input call produces one result.
 */
export class BoundedToolScheduler implements ToolScheduler {
  constructor(private readonly options: BoundedToolSchedulerOptions) {
    if (
      !Number.isInteger(options.maxParallelToolCalls) ||
      options.maxParallelToolCalls < 1
    ) {
      throw new Error("maxParallelToolCalls must be a positive integer");
    }
  }

  begin(input: ToolStreamScheduleInput): ToolScheduleSession {
    return new BoundedToolScheduleSession(this, input);
  }

  async schedule(
    input: ToolBatchScheduleInput,
  ): Promise<readonly ToolResult[]> {
    const session = this.begin(input);
    for (const call of input.calls) {
      void session.submit(call);
    }
    return session.close();
  }

  isParallel(call: ToolCall): boolean {
    return !isInvalidToolCall(call) &&
      isParallelToolCall(this.options.tools, call);
  }

  get parallelLimit(): number {
    return this.options.maxParallelToolCalls;
  }

  async executeCall(
    originalCall: ToolCall,
    input: ToolStreamScheduleInput,
  ): Promise<ToolResult> {
    const startedAtMs = Date.now();
    let metadata: ReturnType<NonNullable<ToolExecutor["describeTool"]>>;
    let durablePrepared = false;
    const abortedBeforeDispatch = isSignalAborted(input.signal);

    let call = originalCall;
    let result: ToolResult;
    try {
      metadata = this.options.tools.describeTool?.(originalCall.name);
      if (input.run.durability !== undefined) {
        await input.run.durability.prepareTool({
          context: input.stepContext,
          call: originalCall,
          ...optionalMetadata(metadata),
        });
        durablePrepared = true;
      }
      if (!abortedBeforeDispatch) {
        await safeEmit(input.onEvent, {
          type: "tool_start",
          step: input.stepContext.step,
          call: originalCall,
        });
      }
      if (abortedBeforeDispatch || isSignalAborted(input.signal)) {
        result = abortedToolResult(call);
      } else {
        const decision = await this.options.hooks.beforeToolCall({
          run: input.run,
          step: input.stepContext.step,
          stepContext: input.stepContext,
          call,
          ...optionalMetadata(metadata),
          startedAtMs,
        });
        if (!decision.allowed) {
          result = deniedToolResult(call, decision.reason);
        } else {
          call = decision.call ?? call;
          if (isSignalAborted(input.signal)) {
            result = abortedToolResult(call);
          } else if (isInvalidToolCall(call)) {
            result = invalidToolResult(call);
          } else {
            if (call !== originalCall && input.run.durability !== undefined) {
              await input.run.durability.prepareTool({
                context: input.stepContext,
                call: { ...call, id: originalCall.id },
                ...optionalMetadata(metadata),
              });
            }
            await input.run.durability?.markToolDispatched({
              context: input.stepContext,
              call: originalCall,
            });
            recordTransition(input.run, toolTransition(
              "dispatch_tool_call",
              input.stepContext,
              originalCall,
            ));
            result = await safelyExecuteTool(
              this.options.tools,
              call,
              input.signal,
              stepExecutionSnapshot(
                input.stepContext,
                this.options.tools,
              ),
            );
          }
        }
      }
    } catch (error: unknown) {
      result = failedToolResult(call, error);
    }

    const hookContext = {
      run: input.run,
      step: input.stepContext.step,
      stepContext: input.stepContext,
      call,
      ...optionalMetadata(metadata),
      startedAtMs,
      result,
      durationMs: Date.now() - startedAtMs,
    };
    try {
      result = result.ok
        ? await this.options.hooks.afterToolCall(hookContext)
        : await this.options.hooks.onToolFailure(hookContext);
    } catch (error: unknown) {
      result = failedToolResult(call, error);
    }

    result = result.callId === originalCall.id
      ? result
      : { ...result, callId: originalCall.id };
    if (durablePrepared) {
      try {
        await input.run.durability?.finishTool({
          context: input.stepContext,
          call: originalCall,
          result,
        });
      } catch (error: unknown) {
        result = durabilityFailureToolResult(originalCall, error);
      }
    }
    await safeEmit(input.onEvent, {
      type: "tool_end",
      step: input.stepContext.step,
      call,
      result,
    });
    recordTransition(
      input.run,
      result.ok || result.error.code !== "aborted"
        ? {
            ...toolTransition(
              "complete_tool_call",
              input.stepContext,
              originalCall,
            ),
            outcome: result.ok ? "success" : "error",
          }
        : {
            ...toolTransition(
              "abort_tool_call",
              input.stepContext,
              originalCall,
            ),
            phase: abortedBeforeDispatch ? "queued" : "executing",
          },
    );
    return result;
  }
}

interface PendingToolCall {
  readonly index: number;
  readonly call: ToolCall;
  readonly parallel: boolean;
  readonly resolve: (result: ToolResult) => void;
}

/**
 * A rolling Step-local intake queue. Parallel calls start immediately up to the
 * bound; sequential calls are strict barriers for calls before and after them.
 */
class BoundedToolScheduleSession implements ToolScheduleSession {
  private readonly pending: PendingToolCall[] = [];
  private readonly results: ToolResult[] = [];
  private active = 0;
  private nextIndex = 0;
  private sequentialActive = false;
  private sealed = false;
  private settled = false;
  private readonly completion: Promise<readonly ToolResult[]>;
  private resolveCompletion: (results: readonly ToolResult[]) => void = () => {};
  private readonly onAbort = (): void => this.pump();

  constructor(
    private readonly scheduler: BoundedToolScheduler,
    private readonly input: ToolStreamScheduleInput,
  ) {
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
    input.signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  submit(call: ToolCall): Promise<ToolResult> {
    if (this.sealed) {
      throw new Error("Tool schedule session is already sealed");
    }
    let resolveResult: (result: ToolResult) => void = () => {};
    const result = new Promise<ToolResult>((resolve) => {
      resolveResult = resolve;
    });
    this.pending.push({
      index: this.nextIndex,
      call,
      parallel: this.scheduler.isParallel(call),
      resolve: resolveResult,
    });
    this.nextIndex += 1;
    recordTransition(this.input.run, toolTransition(
      "queue_tool_call",
      this.input.stepContext,
      call,
    ));
    this.pump();
    return result;
  }

  close(): Promise<readonly ToolResult[]> {
    if (!this.sealed) {
      this.sealed = true;
      this.pump();
    }
    return this.completion;
  }

  private pump(): void {
    if (this.settled || this.sequentialActive) {
      return;
    }

    while (this.active < this.scheduler.parallelLimit) {
      const next = this.pending[0];
      if (next === undefined) {
        this.finishIfReady();
        return;
      }
      if (!next.parallel) {
        if (this.active > 0) {
          return;
        }
        this.pending.shift();
        this.sequentialActive = true;
        this.launch(next);
        return;
      }
      this.pending.shift();
      this.launch(next);
    }
  }

  private launch(entry: PendingToolCall): void {
    this.active += 1;
    void this.scheduler.executeCall(entry.call, this.input).then((result) => {
      this.results[entry.index] = result;
      entry.resolve(result);
    }).finally(() => {
      this.active -= 1;
      if (!entry.parallel) {
        this.sequentialActive = false;
      }
      this.pump();
      this.finishIfReady();
    });
  }

  private finishIfReady(): void {
    if (
      this.settled ||
      !this.sealed ||
      this.pending.length > 0 ||
      this.active > 0
    ) {
      return;
    }
    this.settled = true;
    this.input.signal?.removeEventListener("abort", this.onAbort);
    this.resolveCompletion(Object.freeze([...this.results]));
  }
}

function toolTransition<
  Type extends
    | "queue_tool_call"
    | "dispatch_tool_call"
    | "complete_tool_call"
    | "abort_tool_call",
>(
  type: Type,
  stepContext: AgentStepContext,
  call: ToolCall,
): {
  readonly type: Type;
  readonly runId: AgentStepContext["runId"];
  readonly userTurnId: AgentStepContext["userTurnId"];
  readonly stepId: AgentStepContext["stepId"];
  readonly callId: ToolCall["id"];
  readonly tool: string;
} {
  return {
    type,
    runId: stepContext.runId,
    userTurnId: stepContext.userTurnId,
    stepId: stepContext.stepId,
    callId: call.id,
    tool: call.name,
  };
}

function recordTransition(
  run: AgentRunContext,
  transition: RuntimeTransition,
): void {
  try {
    const observation = run.onTransition?.(transition);
    void Promise.resolve(observation).catch(() => undefined);
  } catch {
    // Runtime observers are fail-open and cannot alter scheduler state.
  }
}

export function isInvalidToolCall(call: ToolCall): boolean {
  return call.reason?.startsWith("invalid_tool_call:") === true;
}

function isParallelToolCall(tools: ToolExecutor, call: ToolCall): boolean {
  try {
    return tools.describeTool?.(call.name)?.executionMode === "parallel";
  } catch {
    return false;
  }
}

function stepExecutionSnapshot(
  stepContext: AgentStepContext,
  tools: ToolExecutor,
): AgentStepContext["snapshot"]["execution"] {
  const captured = (stepContext as Partial<AgentStepContext>).snapshot?.execution ??
    tools.captureExecutionSnapshot?.();
  return captured ?? {
    schemaVersion: 1,
    authorityVersion: "unversioned",
    availableTools: tools.listTools(),
  };
}

function invalidToolResult(call: ToolCall): ToolResult {
  return {
    ok: false,
    callId: call.id,
    error: {
      code: "invalid_input",
      message:
        call.reason?.replace(/^invalid_tool_call:/u, "") ?? "Invalid tool call",
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

function abortedToolResult(call: ToolCall): ToolResult {
  return {
    ok: false,
    callId: call.id,
    error: {
      code: "aborted",
      message:
        "Tool call was not started because the agent run was aborted before dispatch",
      retryable: false,
    },
  };
}

async function safelyExecuteTool(
  tools: ToolExecutor,
  call: ToolCall,
  signal: AbortSignal | undefined,
  snapshot: AgentStepContext["snapshot"]["execution"],
): Promise<ToolResult> {
  try {
    return await tools.executeTool(call, signal, snapshot);
  } catch (error: unknown) {
    return failedToolResult(call, error);
  }
}

function failedToolResult(call: ToolCall, error: unknown): ToolResult {
  return {
    ok: false,
    callId: call.id,
    error: toToolError(error),
  };
}

function durabilityFailureToolResult(
  call: ToolCall,
  error: unknown,
): ToolResult {
  return {
    ok: false,
    callId: call.id,
    error: {
      code: "execution_failed",
      message:
        `Tool lifecycle commit failed; do not retry before reconciliation: ${
          error instanceof Error ? error.message : "unknown durability error"
        }`,
      retryable: false,
    },
  };
}

function toToolError(error: unknown): ToolError {
  if (isAbortError(error)) {
    return {
      code: "aborted",
      message: "Tool execution was aborted",
      retryable: false,
    };
  }
  return {
    code: "execution_failed",
    message: error instanceof Error ? error.message : "Unknown tool execution error",
    retryable: false,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function safeEmit(
  handler: AgentLoopEventHandler | undefined,
  event: AgentLoopEvent,
): Promise<void> {
  try {
    await handler?.(event);
  } catch {
    // Presentation observers cannot break tool-call/result pairing.
  }
}

function optionalMetadata(
  metadata: ReturnType<NonNullable<ToolExecutor["describeTool"]>>,
): { readonly metadata: NonNullable<typeof metadata> } | object {
  return metadata === undefined ? {} : { metadata };
}
