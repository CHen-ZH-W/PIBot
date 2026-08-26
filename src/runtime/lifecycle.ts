import type { AgentLoopResult } from "../agent/agent-loop";
import type { RuntimeTransition } from "./transitions";

export interface ContextRecoveryLifecyclePolicy {
  readonly maxAttempts: number;
  shouldRecover(result: AgentLoopResult): boolean;
  recover(attempt: number, result: AgentLoopResult): Promise<boolean>;
}

export interface ReflectionLifecyclePolicy {
  run(result: AgentLoopResult): Promise<AgentLoopResult>;
}

export interface RuntimeLifecyclePolicies {
  readonly contextRecovery?: ContextRecoveryLifecyclePolicy;
  readonly reflection?: ReflectionLifecyclePolicy;
}

/** Observers receive immutable events and cannot influence runtime decisions. */
export interface RuntimeLifecycleObserver {
  onEvent(event: RuntimeTransition): Promise<void> | void;
}

export class RuntimeLifecycleObserverPipeline {
  constructor(private readonly observers: readonly RuntimeLifecycleObserver[]) {}

  async emit(event: RuntimeTransition): Promise<void> {
    for (const observer of this.observers) {
      try {
        await observer.onEvent(event);
      } catch {
        // Diagnostic observers are fail-open by contract.
      }
    }
  }
}

export function validateLifecyclePolicies(
  policies: RuntimeLifecyclePolicies | undefined,
): void {
  const maxAttempts = policies?.contextRecovery?.maxAttempts;
  if (
    maxAttempts !== undefined &&
    (!Number.isInteger(maxAttempts) || maxAttempts < 0)
  ) {
    throw new Error("contextRecovery.maxAttempts must be a non-negative integer");
  }
}
