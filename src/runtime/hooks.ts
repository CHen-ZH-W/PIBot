import type {
  DeveloperRoleMode,
  ModelRequest,
  ModelUsage,
} from "../agent/model";
import type { AgentLoopError, AgentEndReason } from "../agent/events";
import type {
  ToolCall,
  ToolMetadata,
  ToolResult,
} from "../core/tools";
import type { AgentRunContext, AgentStepContext } from "./context";

export interface RuntimeModelCallResult {
  readonly model?: string;
  readonly provider?: string;
  readonly developerRoleMode?: DeveloperRoleMode;
  readonly authorityDegraded?: boolean;
  readonly finishReason?: string;
  readonly usage?: ModelUsage;
  readonly retryCount: number;
  readonly durationMs: number;
  readonly error?: AgentLoopError;
}

export interface RuntimeModelCallHookContext {
  readonly run: AgentRunContext;
  readonly step: number;
  readonly stepContext: AgentStepContext;
  readonly request: ModelRequest;
}

export interface RuntimeAfterModelCallHookContext
  extends RuntimeModelCallHookContext {
  readonly result: RuntimeModelCallResult;
}

export interface RuntimeToolCallHookContext {
  readonly run: AgentRunContext;
  readonly step: number;
  readonly stepContext: AgentStepContext;
  readonly call: ToolCall;
  readonly metadata?: ToolMetadata;
  readonly startedAtMs: number;
}

export interface RuntimeAfterToolCallHookContext
  extends RuntimeToolCallHookContext {
  readonly result: ToolResult;
  readonly durationMs: number;
}

export interface RuntimeStopHookContext {
  readonly run: AgentRunContext;
  readonly reason: AgentEndReason;
  readonly steps: number;
  readonly error?: AgentLoopError;
}

export type BeforeToolCallDecision =
  | {
      readonly allowed: true;
      readonly call?: ToolCall;
    }
  | {
      readonly allowed: false;
      readonly reason: string;
    };

export interface RuntimeHook {
  beforeModelCall?(
    context: RuntimeModelCallHookContext,
  ): Promise<ModelRequest | void> | ModelRequest | void;
  afterModelCall?(
    context: RuntimeAfterModelCallHookContext,
  ): Promise<void> | void;
  beforeToolCall?(
    context: RuntimeToolCallHookContext,
  ): Promise<BeforeToolCallDecision | void> | BeforeToolCallDecision | void;
  afterToolCall?(
    context: RuntimeAfterToolCallHookContext,
  ): Promise<ToolResult | void> | ToolResult | void;
  onToolFailure?(
    context: RuntimeAfterToolCallHookContext,
  ): Promise<ToolResult | void> | ToolResult | void;
  onStop?(context: RuntimeStopHookContext): Promise<void> | void;
}

export class RuntimeHookRunner {
  constructor(private readonly hooks: readonly RuntimeHook[] = []) {}

  async beforeModelCall(
    context: RuntimeModelCallHookContext,
  ): Promise<ModelRequest> {
    let request = context.request;
    for (const hook of this.hooks) {
      const next = await hook.beforeModelCall?.({
        ...context,
        request,
      });
      request = next ?? request;
    }

    return request;
  }

  async afterModelCall(context: RuntimeAfterModelCallHookContext): Promise<void> {
    for (const hook of this.hooks) {
      await hook.afterModelCall?.(context);
    }
  }

  async beforeToolCall(
    context: RuntimeToolCallHookContext,
  ): Promise<BeforeToolCallDecision> {
    let call = context.call;
    for (const hook of this.hooks) {
      const decision = await hook.beforeToolCall?.({
        ...context,
        call,
      });
      if (decision === undefined) {
        continue;
      }
      if (!decision.allowed) {
        return decision;
      }
      call = decision.call ?? call;
    }

    return {
      allowed: true,
      call,
    };
  }

  async afterToolCall(
    context: RuntimeAfterToolCallHookContext,
  ): Promise<ToolResult> {
    let result = context.result;
    for (const hook of this.hooks) {
      result = (await hook.afterToolCall?.({
        ...context,
        result,
      })) ?? result;
    }

    return result;
  }

  async onToolFailure(
    context: RuntimeAfterToolCallHookContext,
  ): Promise<ToolResult> {
    let result = context.result;
    for (const hook of this.hooks) {
      result = (await hook.onToolFailure?.({
        ...context,
        result,
      })) ?? result;
    }

    return result;
  }

  async onStop(context: RuntimeStopHookContext): Promise<void> {
    for (const hook of this.hooks) {
      await hook.onStop?.(context);
    }
  }
}
