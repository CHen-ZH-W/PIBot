import type { AgentLoopError } from "../agent/events";
import type {
  AgentRunId,
  AgentStepId,
  AgentUserTurnId,
  ToolCallId,
} from "../core/ids";
import type { RuntimeCancellation } from "./cancellation";

export type RuntimeTransition =
  | {
      readonly type: "continue_step";
      readonly step: number;
      readonly reason: "tool_calls";
    }
  | { readonly type: "continue_with_steering" }
  | { readonly type: "retry_model"; readonly step: number; readonly attempt: number }
  | { readonly type: "recover_context"; readonly attempt: number }
  | {
      readonly type: "queue_tool_call";
      readonly runId: AgentRunId;
      readonly userTurnId: AgentUserTurnId;
      readonly stepId: AgentStepId;
      readonly callId: ToolCallId;
      readonly tool: string;
    }
  | {
      readonly type: "dispatch_tool_call";
      readonly runId: AgentRunId;
      readonly userTurnId: AgentUserTurnId;
      readonly stepId: AgentStepId;
      readonly callId: ToolCallId;
      readonly tool: string;
    }
  | {
      readonly type: "complete_tool_call";
      readonly runId: AgentRunId;
      readonly userTurnId: AgentUserTurnId;
      readonly stepId: AgentStepId;
      readonly callId: ToolCallId;
      readonly tool: string;
      readonly outcome: "success" | "error";
    }
  | {
      readonly type: "abort_tool_call";
      readonly runId: AgentRunId;
      readonly userTurnId: AgentUserTurnId;
      readonly stepId: AgentStepId;
      readonly callId: ToolCallId;
      readonly tool: string;
      readonly phase: "queued" | "executing";
    }
  | {
      readonly type: "start_followup_turn";
      readonly userTurnId: AgentUserTurnId;
    }
  | {
      readonly type: "defer_run_completion";
      readonly reason: string;
      readonly holds: number;
    }
  | {
      readonly type: "release_run_completion";
      readonly reason: string;
      readonly holds: number;
    }
  | { readonly type: "start_reflection"; readonly attempt: number }
  | {
      readonly type: "complete_user_turn";
      readonly userTurnId: AgentUserTurnId;
    }
  | {
      readonly type: "abort_user_turn";
      readonly userTurnId: AgentUserTurnId;
      readonly cancellation?: RuntimeCancellation;
    }
  | {
      readonly type: "fail_user_turn";
      readonly userTurnId: AgentUserTurnId;
      readonly error: AgentLoopError;
    }
  | { readonly type: "cancel_requested"; readonly cancellation: RuntimeCancellation }
  | { readonly type: "complete_run"; readonly runId: AgentRunId }
  | {
      readonly type: "abort_run";
      readonly runId: AgentRunId;
      readonly cancellation: RuntimeCancellation;
    }
  | {
      readonly type: "fail_run";
      readonly runId: AgentRunId;
      readonly error: AgentLoopError;
    };

export function freezeRuntimeTransition(
  transition: RuntimeTransition,
): RuntimeTransition {
  if ("error" in transition) {
    return Object.freeze({
      ...transition,
      error: Object.freeze({ ...transition.error }),
    });
  }
  return Object.freeze({ ...transition });
}
