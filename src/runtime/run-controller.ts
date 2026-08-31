import type { AgentLoopResult } from "../agent/agent-loop";
import type { AgentRunId, AgentUserTurnId } from "../core/ids";
import {
  agentNextStepInbox,
  createAgentRunContext,
  type AgentRunContext,
} from "./context";
import {
  NextTurnQueue,
  type RuntimeControlReceipt,
  type RuntimeControlSource,
} from "./control";
import {
  RunCancellation,
  type RuntimeCancellation,
  type RuntimeCancellationInput,
  type RuntimeCancellationReceipt,
} from "./cancellation";
import { bumpAgentRuntimeStateVersion } from "./mode";
import { decideAfterUserTurn } from "./decisions";
import {
  RuntimeLifecycleObserverPipeline,
  validateLifecyclePolicies,
  type RuntimeLifecycleObserver,
  type RuntimeLifecyclePolicies,
} from "./lifecycle";
import {
  applyModeSwitch,
  type ModeSwitchRequest,
} from "./run-control";
import {
  freezeRuntimeTransition,
  type RuntimeTransition,
} from "./transitions";
export type { RuntimeTransition } from "./transitions";

export interface AgentRunControllerOptions<FollowUp> {
  readonly runContext: AgentRunContext;
  readonly maxFollowUps: number;
  readonly maxFollowUpBytes?: number;
  readonly observers?: readonly RuntimeLifecycleObserver[];
  readonly onTransition?: (
    transition: RuntimeTransition,
  ) => Promise<void> | void;
}

export interface AgentRunExecutionOptions {
  readonly execute: () => Promise<AgentLoopResult>;
  readonly lifecycle?: RuntimeLifecyclePolicies;
}

export interface AgentUserTurnDriverOptions<FollowUp, Result> {
  readonly initial: FollowUp;
  readonly execute: (
    input: FollowUp,
    context: AgentRunContext,
  ) => Promise<Result>;
  readonly onFollowUpStart?: (
    input: FollowUp,
    context: AgentRunContext,
  ) => Promise<void> | void;
}

export interface AgentRunCompletionHold {
  readonly reason: string;
  release(): void;
}

type UserTurnTerminalTransition = Extract<RuntimeTransition, {
  readonly type:
    | "complete_user_turn"
    | "abort_user_turn"
    | "fail_user_turn";
}>;

/**
 * Owns transport-independent control state for one agent run. Slack/Web adapters
 * keep presentation and persistence concerns, but do not mutate mode, steering,
 * follow-up, or cancellation state directly.
 */
export class AgentRunController<FollowUp> {
  private currentRunContext: AgentRunContext;
  private readonly cancellationState = new RunCancellation();
  private readonly nextTurnQueue: NextTurnQueue<FollowUp>;
  private readonly observerPipeline: RuntimeLifecycleObserverPipeline;
  private readonly transitionHistory: RuntimeTransition[] = [];
  private readonly terminalUserTurns = new Map<
    AgentUserTurnId,
    UserTurnTerminalTransition
  >();
  private activeUserTurnExecution: AgentUserTurnId | undefined;
  private lastUserTurnTerminal: UserTurnTerminalTransition | undefined;
  private runTerminal:
    | Extract<RuntimeTransition, {
        readonly type: "complete_run" | "abort_run" | "fail_run";
      }>
    | undefined;
  private transitionWork: Promise<void> = Promise.resolve();
  private readonly completionHolds = new Map<symbol, string>();
  private runDecisionSignal = createRunDecisionSignal();

  constructor(private readonly options: AgentRunControllerOptions<FollowUp>) {
    if (!Number.isInteger(options.maxFollowUps) || options.maxFollowUps < 0) {
      throw new Error("maxFollowUps must be a non-negative integer");
    }
    this.nextTurnQueue = new NextTurnQueue({
      maxEntries: options.maxFollowUps,
      maxBytes: options.maxFollowUpBytes ?? 512 * 1024,
    });
    this.observerPipeline = new RuntimeLifecycleObserverPipeline([
      ...(options.runContext.onTransition === undefined
        ? []
        : [{ onEvent: options.runContext.onTransition }]),
      ...(options.observers ?? []),
      ...(options.onTransition === undefined
        ? []
        : [{ onEvent: options.onTransition }]),
    ]);
    const nextStepInbox = agentNextStepInbox(options.runContext);
    nextStepInbox.openUserTurn(options.runContext.userTurnId);
    this.currentRunContext = this.controlledContext({
      ...options.runContext,
      nextStepInbox,
    });
  }

  get runId(): AgentRunId {
    return this.currentRunContext.runId;
  }

  get runContext(): AgentRunContext {
    return this.currentRunContext;
  }

  get signal(): AbortSignal {
    return this.cancellationState.signal;
  }

  get cancelled(): boolean {
    return this.cancellationState.cancelled;
  }

  get cancellation(): RuntimeCancellation | undefined {
    return this.cancellationState.value;
  }

  get queuedFollowUps(): number {
    return this.nextTurnQueue.size;
  }

  get pendingCompletionHolds(): number {
    return this.completionHolds.size;
  }

  get awaitingFollowUp(): boolean {
    return this.runTerminal === undefined &&
      !this.cancelled &&
      this.completionHolds.size > 0 &&
      this.terminalUserTurns.has(this.currentRunContext.userTurnId);
  }

  get transitions(): readonly RuntimeTransition[] {
    return [...this.transitionHistory];
  }

  steer(
    message: string,
    source: RuntimeControlSource = "runtime",
  ): RuntimeControlReceipt<"steer"> {
    const receipt = this.currentRunContext.nextStepInbox.enqueue({
      runId: this.currentRunContext.runId,
      userTurnId: this.currentRunContext.userTurnId,
      text: message,
      source,
    });
    if (receipt.accepted) {
      bumpAgentRuntimeStateVersion(this.currentRunContext.state);
    }
    return receipt;
  }

  changeMode(
    request: ModeSwitchRequest,
    steeringMessage: string,
    source: RuntimeControlSource = "runtime",
  ): RuntimeControlReceipt<"steer"> {
    const receipt = this.steer(steeringMessage, source);
    if (receipt.accepted) {
      applyModeSwitch(this.currentRunContext.state, request);
    }
    return receipt;
  }

  enqueueFollowUp(
    followUp: FollowUp,
    options: {
      readonly text?: string;
      readonly source?: RuntimeControlSource;
      readonly reserveCapacity?: boolean;
    } = {},
  ): RuntimeControlReceipt<"follow_up"> {
    const receipt = this.nextTurnQueue.enqueue(followUp, {
      runId: this.currentRunContext.runId,
      userTurnId: this.currentRunContext.userTurnId,
      text: options.text ?? describeFollowUp(followUp),
      source: options.source ?? "runtime",
    }, {
      reserveCapacity: options.reserveCapacity === true,
    });
    if (receipt.accepted) {
      this.wakeRunDecision();
    }
    return receipt;
  }

  /** Keeps a successful Run open while a runtime-owned async source may enqueue a follow-up. */
  deferRunCompletion(reason: string): AgentRunCompletionHold | undefined {
    const normalizedReason = reason.trim();
    if (
      normalizedReason.length === 0 ||
      this.cancelled ||
      this.runTerminal !== undefined
    ) {
      return undefined;
    }
    const id = Symbol(normalizedReason);
    this.completionHolds.set(id, normalizedReason);
    this.recordTransition({
      type: "defer_run_completion",
      reason: normalizedReason,
      holds: this.completionHolds.size,
    });
    let released = false;
    return Object.freeze({
      reason: normalizedReason,
      release: () => {
        if (released) return;
        released = true;
        if (!this.completionHolds.delete(id)) return;
        this.recordTransition({
          type: "release_run_completion",
          reason: normalizedReason,
          holds: this.completionHolds.size,
        });
        this.wakeRunDecision();
      },
    });
  }

  /** Compatibility helper for callers that only need the queue position. */
  followUp(
    followUp: FollowUp,
    options: {
      readonly text?: string;
      readonly source?: RuntimeControlSource;
      readonly reserveCapacity?: boolean;
    } = {},
  ): number | undefined {
    if (this.cancelled) {
      return undefined;
    }
    const receipt = this.enqueueFollowUp(followUp, options);
    return receipt.accepted ? receipt.position : undefined;
  }

  /** Drives the initial user turn and every queued follow-up for this run. */
  async runUserTurns<Result>(
    options: AgentUserTurnDriverOptions<FollowUp, Result>,
  ): Promise<Result> {
    try {
      let input = options.initial;
      while (true) {
        this.lastUserTurnTerminal = undefined;
        const result = await options.execute(input, this.currentRunContext);
        if (this.lastUserTurnTerminal === undefined) {
          const terminal: Extract<RuntimeTransition, {
            type: "complete_user_turn";
          }> = {
            type: "complete_user_turn",
            userTurnId: this.currentRunContext.userTurnId,
          };
          this.recordUserTurnTerminal(terminal);
        }
        this.currentRunContext.nextStepInbox.closeUserTurn(
          this.currentRunContext.userTurnId,
        );
        let runDecision = decideAfterUserTurn({
          cancelled: this.cancelled,
          hasQueuedFollowUp: this.nextTurnQueue.size > 0,
          ...optionalUserTurnError(this.lastUserTurnTerminal),
        });
        if (
          runDecision.type === "complete_run" &&
          this.completionHolds.size > 0
        ) {
          await this.waitForRunDecisionOpportunity();
          runDecision = decideAfterUserTurn({
            cancelled: this.cancelled,
            hasQueuedFollowUp: this.nextTurnQueue.size > 0,
            ...optionalUserTurnError(this.lastUserTurnTerminal),
          });
        }
        if (runDecision.type === "abort_run") {
          this.recordRunTerminal({
            type: "abort_run",
            runId: this.runId,
            cancellation: this.ensureCancellation(),
          });
          await this.flushTransitions();
          return result;
        }
        if (runDecision.type === "complete_run") {
          this.recordRunTerminal({ type: "complete_run", runId: this.runId });
          await this.flushTransitions();
          return result;
        }
        if (runDecision.type === "fail_run") {
          this.recordRunTerminal({
            type: "fail_run",
            runId: this.runId,
            error: runDecision.error,
          });
          await this.flushTransitions();
          return result;
        }
        const next = this.startNextFollowUp();
        if (next === undefined) {
          this.recordRunTerminal({ type: "complete_run", runId: this.runId });
          await this.flushTransitions();
          return result;
        }
        await this.flushTransitions();
        await options.onFollowUpStart?.(next, this.currentRunContext);
        input = next;
      }
    } catch (error: unknown) {
      if (this.lastUserTurnTerminal === undefined) {
        const terminal: Extract<RuntimeTransition, {
          type: "fail_user_turn";
        }> = {
          type: "fail_user_turn",
          userTurnId: this.currentRunContext.userTurnId,
          error: unknownRunError(error),
        };
        this.recordUserTurnTerminal(terminal);
        this.currentRunContext.nextStepInbox.closeUserTurn(
          this.currentRunContext.userTurnId,
          "user_turn_failed",
        );
      }
      this.recordRunTerminal({
        type: "fail_run",
        runId: this.runId,
        error: unknownRunError(error),
      });
      await this.flushTransitions();
      throw error;
    }
  }

  async run(options: AgentRunExecutionOptions): Promise<AgentLoopResult> {
    validateLifecyclePolicies(options.lifecycle);
    const executionUserTurnId = this.currentRunContext.userTurnId;
    if (this.terminalUserTurns.has(executionUserTurnId)) {
      throw new Error(`UserTurn ${executionUserTurnId} is already terminal`);
    }
    if (this.activeUserTurnExecution !== undefined) {
      throw new Error(
        `UserTurn ${this.activeUserTurnExecution} is already executing`,
      );
    }
    this.activeUserTurnExecution = executionUserTurnId;
    try {
      let attemptedSteps = 0;
      const recovery = options.lifecycle?.contextRecovery;
      let result = await driveWithContextRecovery(this, {
        maxAttempts: recovery?.maxAttempts ?? 0,
        execute: async () => {
          const attemptResult = await options.execute();
          attemptedSteps += attemptResult.steps;
          return attemptResult;
        },
        needsRecovery: (attemptResult) =>
          recovery?.shouldRecover(attemptResult) ?? false,
        recover: (attempt, attemptResult) =>
          recovery?.recover(attempt, attemptResult) ?? Promise.resolve(false),
      });
      if (!this.cancelled && options.lifecycle?.reflection !== undefined) {
        const recoveredAttemptSteps = attemptedSteps - result.steps;
        result = await options.lifecycle.reflection.run(result);
        if (recoveredAttemptSteps > 0) {
          result = {
            ...result,
            steps: result.steps + recoveredAttemptSteps,
          };
        }
      } else if (attemptedSteps > result.steps) {
        result = {
          ...result,
          steps: attemptedSteps,
        };
      }
      if (result.reason === "aborted" && !this.cancelled) {
        this.cancel({ reason: "runtime_abort", source: "runtime" });
      }
      const terminal = terminalUserTurnTransition(
        result,
        this.currentRunContext,
        this.cancellation,
      );
      this.recordUserTurnTerminal(terminal);
      this.currentRunContext.nextStepInbox.closeUserTurn(
        this.currentRunContext.userTurnId,
      );
      await this.flushTransitions();
      return result;
    } catch (error: unknown) {
      const terminal: Extract<RuntimeTransition, { type: "fail_user_turn" }> = {
        type: "fail_user_turn",
        userTurnId: this.currentRunContext.userTurnId,
        error: unknownRunError(error),
      };
      this.recordUserTurnTerminal(terminal);
      this.currentRunContext.nextStepInbox.closeUserTurn(
        this.currentRunContext.userTurnId,
        "user_turn_failed",
      );
      await this.flushTransitions();
      throw error;
    } finally {
      if (this.activeUserTurnExecution === executionUserTurnId) {
        this.activeUserTurnExecution = undefined;
      }
    }
  }

  startNextFollowUp(): FollowUp | undefined {
    if (this.cancelled) {
      return undefined;
    }
    const next = this.nextTurnQueue.dequeue();
    if (next === undefined) {
      return undefined;
    }
    this.currentRunContext.nextStepInbox.closeUserTurn(
      this.currentRunContext.userTurnId,
    );
    this.currentRunContext = this.controlledContext(
      createAgentRunContext({
        runId: this.currentRunContext.runId,
        ...(this.currentRunContext.parentRunId === undefined
          ? {}
          : { parentRunId: this.currentRunContext.parentRunId }),
        agentId: this.currentRunContext.agentId,
        state: this.currentRunContext.state,
        nextStepInbox: this.currentRunContext.nextStepInbox,
      }),
    );
    this.lastUserTurnTerminal = undefined;
    this.recordTransition({
      type: "start_followup_turn",
      userTurnId: this.currentRunContext.userTurnId,
    });
    return next.payload;
  }

  cancel(input: RuntimeCancellationInput = {
    reason: "runtime_abort",
    source: "runtime",
  }): RuntimeCancellationReceipt {
    if (this.runTerminal !== undefined) {
      return {
        accepted: false,
        ...(this.cancellation === undefined
          ? {}
          : { cancellation: this.cancellation }),
        reason: "run_already_terminal",
      };
    }
    if (this.cancelled) {
      return {
        accepted: false,
        cancellation: this.ensureCancellation(),
        reason: "already_cancelled",
      };
    }
    const cancellation = this.cancellationState.request(input);
    this.currentRunContext.nextStepInbox.close("run_cancelled");
    this.nextTurnQueue.close("run_cancelled");
    this.wakeRunDecision();
    this.recordTransition({ type: "cancel_requested", cancellation });
    return { accepted: true, cancellation };
  }

  recordTransition(transition: RuntimeTransition): void {
    const event = freezeRuntimeTransition(transition);
    this.transitionHistory.push(event);
    this.transitionWork = this.transitionWork
      .then(() => this.observerPipeline.emit(event))
      .catch(() => undefined);
  }

  async flushTransitions(): Promise<void> {
    await this.transitionWork;
  }

  private controlledContext(context: AgentRunContext): AgentRunContext {
    return {
      ...context,
      onTransition: (transition) => {
        this.recordTransition(transition);
      },
    };
  }

  private ensureCancellation(): RuntimeCancellation {
    return this.cancellation ?? this.cancellationState.request({
      reason: "runtime_abort",
      source: "runtime",
    });
  }

  private recordRunTerminal(
    transition: Extract<RuntimeTransition, {
      type: "complete_run" | "abort_run" | "fail_run";
    }>,
  ): void {
    if (this.runTerminal !== undefined) {
      return;
    }
    this.runTerminal = transition;
    const reason = transition.type === "complete_run"
      ? "run_completed"
      : transition.type === "abort_run"
        ? "run_cancelled"
        : "run_failed";
    this.currentRunContext.nextStepInbox.close(
      reason,
      transition.type === "abort_run" ? "cancelled" : "expired",
    );
    this.nextTurnQueue.close(
      reason,
      transition.type === "abort_run" ? "cancelled" : "expired",
    );
    this.completionHolds.clear();
    this.wakeRunDecision();
    this.recordTransition(transition);
  }

  private async waitForRunDecisionOpportunity(): Promise<void> {
    while (
      !this.cancelled &&
      this.nextTurnQueue.size === 0 &&
      this.completionHolds.size > 0
    ) {
      const signal = this.runDecisionSignal.promise;
      if (
        this.cancelled ||
        this.nextTurnQueue.size > 0 ||
        this.completionHolds.size === 0
      ) {
        continue;
      }
      await signal;
    }
  }

  private wakeRunDecision(): void {
    const current = this.runDecisionSignal;
    this.runDecisionSignal = createRunDecisionSignal();
    current.resolve();
  }

  private recordUserTurnTerminal(
    transition: UserTurnTerminalTransition,
  ): UserTurnTerminalTransition {
    const existing = this.terminalUserTurns.get(transition.userTurnId);
    if (existing !== undefined) {
      this.lastUserTurnTerminal = existing;
      return existing;
    }
    this.terminalUserTurns.set(transition.userTurnId, transition);
    this.lastUserTurnTerminal = transition;
    this.recordTransition(transition);
    return transition;
  }
}

export interface ContextRecoveryDriverOptions<Result> {
  readonly maxAttempts: number;
  readonly execute: () => Promise<Result>;
  readonly needsRecovery: (result: Result) => boolean;
  readonly recover: (attempt: number, result: Result) => Promise<boolean>;
}

/** Drives the shared execute -> recover_context -> execute transition. */
export async function driveWithContextRecovery<Result, FollowUp>(
  controller: AgentRunController<FollowUp>,
  options: ContextRecoveryDriverOptions<Result>,
): Promise<Result> {
  let attempts = 0;
  while (true) {
    const result = await options.execute();
    if (
      controller.cancelled ||
      !options.needsRecovery(result) ||
      attempts >= options.maxAttempts
    ) {
      return result;
    }
    const attempt = attempts + 1;
    controller.recordTransition({ type: "recover_context", attempt });
    if (!await options.recover(attempt, result)) {
      return result;
    }
    attempts = attempt;
  }
}

export function terminalUserTurnTransition(
  result: AgentLoopResult,
  context: AgentRunContext,
  cancellation: RuntimeCancellation | undefined,
): Extract<RuntimeTransition, {
  type: "complete_user_turn" | "abort_user_turn" | "fail_user_turn";
}> {
  if (result.reason === "aborted") {
    return {
      type: "abort_user_turn",
      userTurnId: context.userTurnId,
      ...(cancellation === undefined ? {} : { cancellation }),
    };
  }
  if (result.error !== undefined) {
    return {
      type: "fail_user_turn",
      userTurnId: context.userTurnId,
      error: result.error,
    };
  }
  return { type: "complete_user_turn", userTurnId: context.userTurnId };
}

function unknownRunError(error: unknown) {
  return {
    code: "unknown" as const,
    message: error instanceof Error ? error.message : "Unknown run error",
    retryable: false,
  };
}

function describeFollowUp(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof value.text === "string"
  ) {
    return value.text;
  }
  return "Queued follow-up";
}

function optionalUserTurnError(
  transition:
    | UserTurnTerminalTransition
    | undefined,
): { readonly error: AgentLoopResult["error"] & object } | object {
  return transition?.type === "fail_user_turn"
    ? { error: transition.error }
    : {};
}

function createRunDecisionSignal(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve = () => {};
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
