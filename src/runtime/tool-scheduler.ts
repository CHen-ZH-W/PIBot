import type { ToolCall, ToolError, ToolResult } from "../core/tools";
import type { ToolExecutor } from "../ports/tools";
import type {
  AgentLoopEvent,
  AgentLoopEventHandler,
} from "../agent/events";
import type { AgentRunContext, AgentStepContext } from "./context";
import { RuntimeHookRunner } from "./hooks";

export interface ToolBatchScheduleInput {
  readonly run: AgentRunContext;
  readonly stepContext: AgentStepContext;
  readonly calls: readonly ToolCall[];
  readonly signal?: AbortSignal;
  readonly onEvent?: AgentLoopEventHandler;
}

export interface ToolScheduler {
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

  async schedule(
    input: ToolBatchScheduleInput,
  ): Promise<readonly ToolResult[]> {
    const results: ToolResult[] = [];
    let pending: Array<{ readonly index: number; readonly call: ToolCall }> = [];
    const flush = async (): Promise<void> => {
      const batch = pending;
      pending = [];
      let next = 0;
      const worker = async (): Promise<void> => {
        while (true) {
          const queued = batch[next];
          next += 1;
          if (queued === undefined) {
            return;
          }
          results[queued.index] = await this.execute(queued.call, input);
        }
      };
      await Promise.all(
        Array.from(
          {
            length: Math.min(
              this.options.maxParallelToolCalls,
              batch.length,
            ),
          },
          () => worker(),
        ),
      );
    };

    for (const [index, call] of input.calls.entries()) {
      if (
        !isInvalidToolCall(call) &&
        isParallelToolCall(this.options.tools, call)
      ) {
        pending.push({ index, call });
        continue;
      }
      await flush();
      results[index] = await this.execute(call, input);
    }
    await flush();
    return results;
  }

  private async execute(
    originalCall: ToolCall,
    input: ToolBatchScheduleInput,
  ): Promise<ToolResult> {
    const startedAtMs = Date.now();
    let metadata: ReturnType<NonNullable<ToolExecutor["describeTool"]>>;
    const abortedBeforeDispatch = isSignalAborted(input.signal);
    if (!abortedBeforeDispatch) {
      await safeEmit(input.onEvent, {
        type: "tool_start",
        step: input.stepContext.step,
        call: originalCall,
      });
    }

    let call = originalCall;
    let result: ToolResult;
    try {
      metadata = this.options.tools.describeTool?.(originalCall.name);
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
          result = isSignalAborted(input.signal)
            ? abortedToolResult(call)
            : isInvalidToolCall(call)
              ? invalidToolResult(call)
              : await safelyExecuteTool(this.options.tools, call, input.signal);
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
    await safeEmit(input.onEvent, {
      type: "tool_end",
      step: input.stepContext.step,
      call,
      result,
    });
    return result;
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
): Promise<ToolResult> {
  try {
    return await tools.executeTool(call, signal);
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
