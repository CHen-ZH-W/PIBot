import type { LlmMessage } from "../core/agent";
import type { ToolCall, ToolResult } from "../core/tools";
import type { ModelError } from "./model";

export type AgentEndReason = "completed" | "max_turns" | "aborted" | "error";
export type TurnEndReason = "completed" | "tool_calls" | "aborted" | "error";

export interface AgentLoopError {
  readonly code:
    | "model_error"
    | "tool_not_found"
    | "invalid_tool_arguments"
    | "tool_execution_failed"
    | "context_overflow"
    | "max_turns_exceeded"
    | "aborted"
    | "unknown";
  readonly message: string;
  readonly retryable: boolean;
}

export type AgentLoopEvent =
  | {
      readonly type: "agent_start";
      readonly maxTurns: number;
    }
  | {
      readonly type: "turn_start";
      readonly turn: number;
    }
  | {
      readonly type: "message_delta";
      readonly turn: number;
      readonly text: string;
    }
  | {
      readonly type: "reasoning_delta";
      readonly turn: number;
      readonly text: string;
    }
  | {
      readonly type: "message_completed";
      readonly turn: number;
      readonly message: LlmMessage;
    }
  | {
      readonly type: "tool_start";
      readonly turn: number;
      readonly call: ToolCall;
    }
  | {
      readonly type: "tool_end";
      readonly turn: number;
      readonly call: ToolCall;
      readonly result: ToolResult;
    }
  | {
      readonly type: "turn_end";
      readonly turn: number;
      readonly reason: TurnEndReason;
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
