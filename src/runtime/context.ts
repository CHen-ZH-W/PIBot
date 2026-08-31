import { randomUUID } from "node:crypto";
import type {
  AgentId,
  AgentRunId,
  AgentStepId,
  AgentUserTurnId,
} from "../core/ids";
import type { ToolExecutionSnapshot } from "../core/tools";
import type { AgentMode } from "./mode";
import {
  NextStepInbox,
  type RuntimeControlMessage,
} from "./control";
import type { RuntimeTransition } from "./transitions";
import {
  createAgentRuntimeState,
  type AgentRuntimeState,
} from "./mode";

export interface AgentRunContext {
  readonly runId: AgentRunId;
  readonly userTurnId: AgentUserTurnId;
  readonly parentRunId?: AgentRunId;
  readonly agentId: AgentId;
  readonly state: AgentRuntimeState;
  readonly nextStepInbox: NextStepInbox;
  readonly stepSequence?: { nextStep: number };
  readonly onTransition?: (
    transition: RuntimeTransition,
  ) => Promise<void> | void;
}

export function createAgentRunContext(options: {
  readonly runId?: AgentRunId;
  readonly userTurnId?: AgentUserTurnId;
  readonly parentRunId?: AgentRunId;
  readonly agentId?: AgentId;
  readonly state?: AgentRuntimeState;
  readonly nextStepInbox?: NextStepInbox;
  readonly stepSequence?: { nextStep: number };
  readonly onTransition?: (
    transition: RuntimeTransition,
  ) => Promise<void> | void;
} = {}): AgentRunContext {
  const runId = options.runId ?? (randomUUID() as AgentRunId);
  const userTurnId = options.userTurnId ?? (randomUUID() as AgentUserTurnId);
  const nextStepInbox = options.nextStepInbox ?? new NextStepInbox();
  nextStepInbox.openUserTurn(userTurnId);
  return {
    runId,
    userTurnId,
    ...(options.parentRunId === undefined
      ? {}
      : { parentRunId: options.parentRunId }),
    agentId: options.agentId ?? ("coding-agent" as AgentId),
    state: options.state ?? createAgentRuntimeState(),
    nextStepInbox,
    stepSequence: options.stepSequence ?? { nextStep: 1 },
    ...(options.onTransition === undefined
      ? {}
      : { onTransition: options.onTransition }),
  };
}

export interface AgentStepContext {
  readonly runId: AgentRunId;
  readonly userTurnId: AgentUserTurnId;
  readonly stepId: AgentStepId;
  readonly step: number;
  readonly mode: AgentMode;
  readonly stateVersion: number;
  readonly controlMessages: readonly RuntimeControlMessage<"steer">[];
  readonly steeringMessages: readonly string[];
  readonly advertisedTools: readonly string[];
  readonly coordinatorGoal?: string;
  readonly model?: string;
  readonly snapshot: AgentStepSnapshot;
}

export interface AgentStepSnapshot {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly runtime: {
    readonly version: number;
    readonly mode: AgentMode;
    readonly coordinatorGoal?: string;
  };
  readonly execution: ToolExecutionSnapshot;
  readonly worldState: Readonly<Record<string, unknown>>;
}

const legacyStepSequences = new WeakMap<object, { nextStep: number }>();
const legacyStepInboxes = new WeakMap<object, NextStepInbox>();

export function captureAgentStepContext(
  run: AgentRunContext,
  model: string | undefined,
  executionSnapshot?: ToolExecutionSnapshot,
): AgentStepContext {
  const stepSequence = run.stepSequence ?? legacyStepSequence(run);
  const step = stepSequence.nextStep;
  stepSequence.nextStep += 1;
  const stepId = `${run.userTurnId}:${step}` as AgentStepId;
  const nextStepInbox = run.nextStepInbox ?? legacyStepInbox(run);
  const controlMessages = nextStepInbox.drain(run.userTurnId, stepId);
  const legacySteeringMessages = run.state.steering.messages.splice(
    0,
    run.state.steering.messages.length,
  );
  const steeringMessages = [
    ...controlMessages.map((message) => message.text),
    ...legacySteeringMessages,
  ];
  const execution = executionSnapshot ?? Object.freeze({
    schemaVersion: 1 as const,
    authorityVersion: "unversioned",
    availableTools: Object.freeze([] as string[]),
    runtimeStateVersion: run.state.version,
    mode: run.state.mode,
  });
  const runtimeSnapshot = Object.freeze({
    version: run.state.version,
    mode: run.state.mode,
    ...(run.state.coordinator.goal === undefined
      ? {}
      : { coordinatorGoal: run.state.coordinator.goal }),
  });
  return Object.freeze({
    runId: run.runId,
    userTurnId: run.userTurnId,
    stepId,
    step,
    mode: run.state.mode,
    stateVersion: run.state.version,
    controlMessages: Object.freeze([...controlMessages]),
    steeringMessages: Object.freeze(steeringMessages),
    advertisedTools: Object.freeze([] as string[]),
    ...(run.state.coordinator.goal === undefined
      ? {}
      : { coordinatorGoal: run.state.coordinator.goal }),
    ...(model === undefined ? {} : { model }),
    snapshot: Object.freeze({
      schemaVersion: 1 as const,
      capturedAt: new Date().toISOString(),
      runtime: runtimeSnapshot,
      execution,
      worldState: Object.freeze({}),
    }),
  });
}

export function agentNextStepInbox(run: AgentRunContext): NextStepInbox {
  return run.nextStepInbox ?? legacyStepInbox(run);
}

function legacyStepSequence(run: AgentRunContext): { nextStep: number } {
  const existing = legacyStepSequences.get(run);
  if (existing !== undefined) {
    return existing;
  }
  const created = { nextStep: 1 };
  legacyStepSequences.set(run, created);
  return created;
}

function legacyStepInbox(run: AgentRunContext): NextStepInbox {
  const existing = legacyStepInboxes.get(run);
  if (existing !== undefined) {
    return existing;
  }
  const created = new NextStepInbox();
  created.openUserTurn(run.userTurnId);
  legacyStepInboxes.set(run, created);
  return created;
}

export function withAdvertisedStepTools(
  context: AgentStepContext,
  tools: readonly string[],
): AgentStepContext {
  const advertisedTools = Object.freeze([...tools]);
  return Object.freeze({
    ...context,
    advertisedTools,
    snapshot: Object.freeze({
      ...context.snapshot,
      execution: Object.freeze({
        ...context.snapshot.execution,
        availableTools: advertisedTools,
      }),
    }),
  });
}

export function withStepWorldState(
  context: AgentStepContext,
  worldState: Readonly<Record<string, unknown>>,
): AgentStepContext {
  return Object.freeze({
    ...context,
    snapshot: Object.freeze({
      ...context.snapshot,
      worldState: deepFreezeRecord(worldState),
    }),
  });
}

function deepFreezeRecord(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return deepFreezeValue({ ...value }) as Readonly<Record<string, unknown>>;
}

function deepFreezeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(deepFreezeValue));
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, deepFreezeValue(item)] as const);
    return Object.freeze(Object.fromEntries(entries));
  }
  return value;
}
