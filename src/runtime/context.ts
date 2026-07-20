import { randomUUID } from "node:crypto";
import type { AgentId, AgentRunId } from "../core/ids";
import {
  createAgentRuntimeState,
  type AgentRuntimeState,
} from "./mode";

export interface AgentRunContext {
  readonly runId: AgentRunId;
  readonly parentRunId?: AgentRunId;
  readonly agentId: AgentId;
  readonly state: AgentRuntimeState;
}

export function createAgentRunContext(options: {
  readonly runId?: AgentRunId;
  readonly parentRunId?: AgentRunId;
  readonly agentId?: AgentId;
  readonly state?: AgentRuntimeState;
} = {}): AgentRunContext {
  return {
    runId: options.runId ?? (randomUUID() as AgentRunId),
    ...(options.parentRunId === undefined
      ? {}
      : { parentRunId: options.parentRunId }),
    agentId: options.agentId ?? ("coding-agent" as AgentId),
    state: options.state ?? createAgentRuntimeState(),
  };
}
