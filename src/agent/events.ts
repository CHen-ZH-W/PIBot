import type { LlmMessage } from "../core/agent";
import type { ToolCall, ToolResult } from "../core/tools";
import type { ModelError } from "./model";

export type AgentEndReason = "completed" | "max_steps" | "aborted" | "error";
export type StepEndReason =
  | "completed"
  | "tool_calls"
  | "steering"
  | "aborted"
  | "error";

export interface AgentLoopError {
  readonly code:
    | "model_error"
    | "tool_not_found"
    | "invalid_tool_arguments"
    | "tool_execution_failed"
    | "context_overflow"
    | "max_steps_exceeded"
    | "aborted"
    | "unknown";
  readonly message: string;
  readonly retryable: boolean;
}

export type AgentLoopEvent =
  | {
      readonly type: "agent_start";
      readonly maxSteps: number;
    }
  | {
      readonly type: "step_start";
      readonly step: number;
    }
  | {
      readonly type: "message_delta";
      readonly step: number;
      readonly text: string;
    }
  | {
      readonly type: "reasoning_delta";
      readonly step: number;
      readonly text: string;
    }
  | {
      readonly type: "message_completed";
      readonly step: number;
      readonly message: LlmMessage;
    }
  | {
      readonly type: "tool_start";
      readonly step: number;
      readonly call: ToolCall;
    }
  | {
      readonly type: "tool_end";
      readonly step: number;
      readonly call: ToolCall;
      readonly result: ToolResult;
    }
  | {
      readonly type: "step_end";
      readonly step: number;
      readonly reason: StepEndReason;
      readonly assistantText: string;
    }
  | {
      readonly type: "agent_end";
      readonly reason: AgentEndReason;
      readonly messages: readonly LlmMessage[];
      readonly error?: AgentLoopError;
    };

export type AgentLoopEventHandler = (
  event: AgentLoopEvent,
) => void | Promise<void>;

export function modelErrorToAgentLoopError(error: ModelError): AgentLoopError {
  return {
    code:
      error.code === "aborted"
        ? "aborted"
        : error.code === "context_overflow"
          ? "context_overflow"
          : "model_error",
    message: error.message,
    retryable: error.retryable,
  };
}
