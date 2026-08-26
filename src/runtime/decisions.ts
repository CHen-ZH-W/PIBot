import type { AgentLoopError } from "../agent/events";

export type StepOutcome =
  | { readonly type: "model_completed"; readonly pendingSteering: boolean }
  | { readonly type: "tool_batch_completed"; readonly pendingSteering: boolean }
  | { readonly type: "aborted" }
  | { readonly type: "failed"; readonly error: AgentLoopError };

export type StepRuntimeDecision =
  | { readonly type: "continue_step"; readonly reason: "tool_calls" }
  | { readonly type: "continue_with_steering" }
  | { readonly type: "complete_user_turn" }
  | { readonly type: "abort_user_turn" }
  | { readonly type: "fail_user_turn"; readonly error: AgentLoopError };

export type RunRuntimeDecision =
  | { readonly type: "start_next_turn" }
  | { readonly type: "complete_run" }
  | { readonly type: "abort_run" }
  | { readonly type: "fail_run"; readonly error: AgentLoopError };

export function decideAfterStep(
  outcome: StepOutcome,
  hasRemainingStepBudget: boolean,
): StepRuntimeDecision {
  if (outcome.type === "aborted") {
    return { type: "abort_user_turn" };
  }
  if (outcome.type === "failed") {
    return { type: "fail_user_turn", error: outcome.error };
  }
  if (!hasRemainingStepBudget) {
    return { type: "complete_user_turn" };
  }
  if (outcome.pendingSteering) {
    return { type: "continue_with_steering" };
  }
  if (outcome.type === "tool_batch_completed") {
    return { type: "continue_step", reason: "tool_calls" };
  }
  return { type: "complete_user_turn" };
}

export function decideAfterUserTurn(input: {
  readonly cancelled: boolean;
  readonly hasQueuedFollowUp: boolean;
  readonly error?: AgentLoopError;
}): RunRuntimeDecision {
  if (input.cancelled) {
    return { type: "abort_run" };
  }
  if (input.error !== undefined) {
    return { type: "fail_run", error: input.error };
  }
  if (input.hasQueuedFollowUp) {
    return { type: "start_next_turn" };
  }
  return { type: "complete_run" };
}
