import { appendFile, mkdir, stat } from "node:fs/promises";
import * as path from "node:path";
import type { ModelUsage } from "../agent/model";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../core/tools";
import type { AgentRunContext } from "./context";
import type {
  RuntimeAfterModelCallHookContext,
  RuntimeAfterToolCallHookContext,
  RuntimeHook,
  RuntimeModelCallHookContext,
  RuntimeStopHookContext,
  RuntimeToolCallHookContext,
} from "./hooks";

export interface TraceEvent {
  readonly type: string;
  readonly ts?: string;
  readonly runId?: string;
  readonly parentRunId?: string;
  readonly agentId?: string;
  readonly [key: string]: unknown;
}

export interface TraceRecorder {
  record(event: TraceEvent): Promise<void>;
}

export class NoopTraceRecorder implements TraceRecorder {
  record(): Promise<void> {
    return Promise.resolve();
  }
}

export interface JsonlTraceRecorderOptions {
  readonly filePath: string;
  readonly maxFileBytes?: number;
}

export class JsonlTraceRecorder implements TraceRecorder {
  private readonly filePath: string;
  private readonly maxFileBytes: number;

  constructor(options: JsonlTraceRecorderOptions) {
    this.filePath = path.resolve(options.filePath);
    this.maxFileBytes = positiveInteger(
      options.maxFileBytes,
      20_000_000,
      "maxFileBytes",
    );
  }

  async record(event: TraceEvent): Promise<void> {
    const line = `${JSON.stringify({
      ts: event.ts ?? new Date().toISOString(),
      ...event,
    })}\n`;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const currentBytes = await fileSizeIfExists(this.filePath);
    if (currentBytes + Buffer.byteLength(line, "utf8") > this.maxFileBytes) {
      throw new Error(
        `Trace file exceeds maximum size of ${this.maxFileBytes} bytes: ${this.filePath}`,
      );
    }
    await appendFile(this.filePath, line, "utf8");
  }
}

export interface TraceRuntimeHookOptions {
  readonly recorder: TraceRecorder;
  readonly calculateCost?: (
    usage: ModelUsage,
  ) => {
    readonly cost: number;
    readonly currency: string;
  };
}

export class TraceRuntimeHook implements RuntimeHook {
  constructor(private readonly options: TraceRuntimeHookOptions) {}

  async beforeModelCall(context: RuntimeModelCallHookContext): Promise<void> {
    await this.record(withRun(context.run, {
      type: "model.started",
      step: context.step,
      stepId: context.stepContext.stepId,
      userTurnId: context.stepContext.userTurnId,
      stateVersion: context.stepContext.stateVersion,
      messageCount: context.request.messages.length,
      toolCount: context.request.tools.length,
      requestedModel: context.request.model,
    }));
  }

  async afterModelCall(context: RuntimeAfterModelCallHookContext): Promise<void> {
    const cost =
      context.result.usage === undefined ||
      this.options.calculateCost === undefined
        ? {}
        : this.options.calculateCost(context.result.usage);
    await this.record(withRun(context.run, {
      type: context.result.error === undefined
        ? "model.completed"
        : "model.failed",
      step: context.step,
      stepId: context.stepContext.stepId,
      provider: context.result.provider,
      model: context.result.model,
      finishReason: context.result.finishReason,
      usage: context.result.usage,
      retryCount: context.result.retryCount,
      durationMs: context.result.durationMs,
      error: context.result.error,
      ...cost,
    }));
  }

  async beforeToolCall(context: RuntimeToolCallHookContext): Promise<void> {
    await this.record(withRun(context.run, {
      type: "tool.started",
      step: context.step,
      stepId: context.stepContext.stepId,
      toolCallId: context.call.id,
      tool: context.call.name,
      args: sanitizeTraceValue(context.call.input),
      riskLevel: context.metadata?.riskLevel,
      executionMode: context.metadata?.executionMode,
    }));
  }

  async afterToolCall(context: RuntimeAfterToolCallHookContext): Promise<void> {
    await this.recordToolResult("tool.completed", context);
  }

  async onToolFailure(context: RuntimeAfterToolCallHookContext): Promise<void> {
    await this.recordToolResult("tool.failed", context);
  }

  async onStop(context: RuntimeStopHookContext): Promise<void> {
    await this.record(withRun(context.run, {
      type: "agent.stopped",
      reason: context.reason,
      steps: context.steps,
      error: context.error,
    }));
  }

  private async recordToolResult(
    type: string,
    context: RuntimeAfterToolCallHookContext,
  ): Promise<void> {
    await this.record(withRun(context.run, {
      type,
      step: context.step,
      stepId: context.stepContext.stepId,
      toolCallId: context.call.id,
      tool: context.call.name,
      durationMs: context.durationMs,
      result: sanitizeTraceValue(context.result),
    }));
  }

  private async record(event: TraceEvent): Promise<void> {
    await this.options.recorder.record(event).catch(() => undefined);
  }
}

export function createTraceApprovalObserver(
  recorder: TraceRecorder,
  run: AgentRunContext,
): (
  event: {
    readonly request: ToolApprovalRequest;
    readonly mode: string;
    readonly policy: string;
    readonly decision: ToolApprovalDecision;
  },
) => Promise<void> {
  return async (event) => {
    await recorder.record(withRun(run, {
      type: "approval.decided",
      toolCallId: event.request.call.id,
      tool: event.request.call.name,
      riskLevel: event.request.risk,
      mode: event.mode,
      policy: event.policy,
      approved: event.decision.approved,
      reason: event.decision.approved ? undefined : event.decision.reason,
    })).catch(() => undefined);
  };
}

export function withRun(
  run: AgentRunContext,
  event: TraceEvent,
): TraceEvent {
  return {
    ...event,
    runId: run.runId,
    userTurnId: run.userTurnId,
    ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
    agentId: run.agentId,
  };
}

function sanitizeTraceValue(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return "[truncated]";
  }
  if (typeof value === "string") {
    return value.length <= 4000 ? value : `${value.slice(0, 4000)}\n[truncated]`;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeTraceValue(item, depth + 1));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = isSensitiveKey(key)
      ? "[redacted]"
      : sanitizeTraceValue(nested, depth + 1);
  }
  return result;
}

function isSensitiveKey(key: string): boolean {
  return /(authorization|api[_-]?key|password|secret|token)/iu.test(key);
}

async function fileSizeIfExists(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return 0;
    }
    throw error;
  }
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
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
