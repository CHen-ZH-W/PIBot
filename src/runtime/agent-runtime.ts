import type { AgentRunId } from "../core/ids";
import type {
  RuntimeCancellationInput,
  RuntimeCancellationReceipt,
} from "./cancellation";
import type { AgentRunContext } from "./context";
import type {
  RuntimeControlReceipt,
  RuntimeControlSource,
} from "./control";
import {
  AgentRunController,
  type AgentRunCompletionHold,
  type AgentRunControllerOptions,
  type AgentUserTurnDriverOptions,
} from "./run-controller";
import type { ModeSwitchRequest } from "./run-control";
import type { DurableLifecycleAuthority } from "./durable-lifecycle";

export interface AgentRuntimeOptions {
  readonly durability?: DurableLifecycleAuthority;
}

export interface AgentRuntimeCreateRunOptions<FollowUp>
  extends AgentRunControllerOptions<FollowUp> {
  /** Transport-neutral uniqueness boundary, for example conversation/channel ID. */
  readonly scope: string;
}

export interface ActiveAgentRun {
  readonly runId: AgentRunId;
  readonly scope: string;
  readonly runContext: AgentRunContext;
  readonly cancelled: boolean;
  readonly queuedFollowUps: number;
  readonly awaitingFollowUp: boolean;
}

interface RegisteredRun {
  readonly scope: string;
  readonly controller: AgentRunController<unknown>;
}

/**
 * Process-local owner for active Run controllers. Transports own presentation
 * sessions only; creation, lookup, driving, control routing, and release of a
 * Run all pass through this registry.
 */
export class AgentRuntime {
  private readonly runs = new Map<AgentRunId, RegisteredRun>();
  private readonly runIdByScope = new Map<string, AgentRunId>();

  constructor(private readonly options: AgentRuntimeOptions = {}) {}

  createRun<FollowUp>(
    options: AgentRuntimeCreateRunOptions<FollowUp>,
  ): AgentRunController<FollowUp> {
    const scope = normalizeScope(options.scope);
    if (this.runIdByScope.has(scope)) {
      throw new Error(`Agent Runtime scope "${scope}" already has an active Run`);
    }
    if (this.runs.has(options.runContext.runId)) {
      throw new Error(`Agent Run ${options.runContext.runId} is already registered`);
    }
    const controller = new AgentRunController<FollowUp>({
      runContext: {
        ...options.runContext,
        durableScope: scope,
        ...(options.runContext.durability === undefined &&
            this.options.durability !== undefined
          ? { durability: this.options.durability }
          : {}),
      },
      maxFollowUps: options.maxFollowUps,
      ...(options.maxFollowUpBytes === undefined
        ? {}
        : { maxFollowUpBytes: options.maxFollowUpBytes }),
      ...(options.observers === undefined ? {} : { observers: options.observers }),
      ...(options.onTransition === undefined
        ? {}
        : { onTransition: options.onTransition }),
    });
    this.runs.set(controller.runId, {
      scope,
      controller: controller as AgentRunController<unknown>,
    });
    this.runIdByScope.set(scope, controller.runId);
    return controller;
  }

  async runUserTurns<FollowUp, Result>(
    controller: AgentRunController<FollowUp>,
    options: AgentUserTurnDriverOptions<FollowUp, Result>,
  ): Promise<Result> {
    this.requireRegistered(controller);
    try {
      return await controller.runUserTurns(options);
    } finally {
      this.releaseRun(controller);
    }
  }

  runForScope<FollowUp>(scope: string): AgentRunController<FollowUp> | undefined {
    const runId = this.runIdByScope.get(normalizeScope(scope));
    return runId === undefined ? undefined : this.run<FollowUp>(runId);
  }

  run<FollowUp>(runId: AgentRunId): AgentRunController<FollowUp> | undefined {
    return this.runs.get(runId)?.controller as
      | AgentRunController<FollowUp>
      | undefined;
  }

  activeRuns(): readonly ActiveAgentRun[] {
    return [...this.runs.entries()].map(([runId, registered]) => ({
      runId,
      scope: registered.scope,
      runContext: registered.controller.runContext,
      cancelled: registered.controller.cancelled,
      queuedFollowUps: registered.controller.queuedFollowUps,
      awaitingFollowUp: registered.controller.awaitingFollowUp,
    }));
  }

  steer(
    runId: AgentRunId,
    message: string,
    source: RuntimeControlSource = "runtime",
  ): RuntimeControlReceipt<"steer"> {
    return this.requireRun(runId).steer(message, source);
  }

  changeMode(
    runId: AgentRunId,
    request: ModeSwitchRequest,
    steeringMessage: string,
    source: RuntimeControlSource = "runtime",
  ): RuntimeControlReceipt<"steer"> {
    return this.requireRun(runId).changeMode(request, steeringMessage, source);
  }

  enqueueFollowUp<FollowUp>(
    runId: AgentRunId,
    followUp: FollowUp,
    options: {
      readonly text?: string;
      readonly source?: RuntimeControlSource;
      readonly reserveCapacity?: boolean;
    } = {},
  ): RuntimeControlReceipt<"follow_up"> {
    return this.requireRun<FollowUp>(runId).enqueueFollowUp(followUp, options);
  }

  deferRunCompletion(
    runId: AgentRunId,
    reason: string,
  ): AgentRunCompletionHold | undefined {
    return this.requireRun(runId).deferRunCompletion(reason);
  }

  cancel(
    runId: AgentRunId,
    input?: RuntimeCancellationInput,
  ): RuntimeCancellationReceipt {
    return this.requireRun(runId).cancel(input);
  }

  releaseRun<FollowUp>(controller: AgentRunController<FollowUp>): boolean {
    const registered = this.runs.get(controller.runId);
    if (registered?.controller !== controller) {
      return false;
    }
    this.runs.delete(controller.runId);
    if (this.runIdByScope.get(registered.scope) === controller.runId) {
      this.runIdByScope.delete(registered.scope);
    }
    return true;
  }

  private requireRegistered<FollowUp>(
    controller: AgentRunController<FollowUp>,
  ): void {
    if (this.runs.get(controller.runId)?.controller !== controller) {
      throw new Error(`Agent Run ${controller.runId} is not owned by this Runtime`);
    }
  }

  private requireRun<FollowUp>(runId: AgentRunId): AgentRunController<FollowUp> {
    const controller = this.run<FollowUp>(runId);
    if (controller === undefined) {
      throw new Error(`Agent Run ${runId} is not active in this Runtime`);
    }
    return controller;
  }
}

function normalizeScope(scope: string): string {
  const normalized = scope.trim();
  if (normalized.length === 0) {
    throw new Error("Agent Runtime scope must not be empty");
  }
  return normalized;
}
