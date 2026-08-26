import type { AgentLoopError } from "../agent/events";
import type { AgentRunId, AgentUserTurnId } from "../core/ids";
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
      readonly type: "start_followup_turn";
      readonly userTurnId: AgentUserTurnId;
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
