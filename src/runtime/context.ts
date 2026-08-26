import { randomUUID } from "node:crypto";
import type {
  AgentId,
  AgentRunId,
  AgentStepId,
  AgentUserTurnId,
} from "../core/ids";
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
}

const legacyStepSequences = new WeakMap<object, { nextStep: number }>();
const legacyStepInboxes = new WeakMap<object, NextStepInbox>();

export function captureAgentStepContext(
  run: AgentRunContext,
  model: string | undefined,
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
  return Object.freeze({
    ...context,
    advertisedTools: Object.freeze([...tools]),
  });
}
