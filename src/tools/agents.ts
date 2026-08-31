import type { AgentRunId, ToolCallId } from "../core/ids";
import type { ChildAgentRole } from "../workspace/child-agents";
import type { CodingToolDefinition, ToolInputParseResult, ToolRunContext } from "./index";

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface AgentSpawnInput {
  readonly role: ChildAgentRole;
  readonly task: string;
  readonly readOnly?: boolean;
  readonly timeoutMs?: number;
  readonly maxToolCalls?: number;
  readonly maxTokens?: number;
  readonly worktreePath?: string;
}

export interface AgentListInput {
  readonly includeCompleted?: boolean;
}

export interface AgentCaptureInput {
  readonly childRunId: AgentRunId;
  readonly lines?: number;
  readonly maxChars?: number;
}

export interface AgentSendInput {
  readonly childRunId: AgentRunId;
  readonly text: string;
  readonly enter?: boolean;
}

export interface AgentStopInput {
  readonly childRunId: AgentRunId;
  readonly reason?: string;
}

export interface AgentCollectInput {
  readonly childRunId: AgentRunId;
}

export const agentSpawnTool: CodingToolDefinition<
  "agent_spawn",
  AgentSpawnInput,
  unknown
> = {
  name: "agent_spawn",
  riskLevel: "external",
  executionMode: "sequential",
  resolveCapabilities: (input) => ({
    requirements: [
      { capability: "process.exec", commands: ["child-agent"] },
      { capability: "runtime.control", resources: [`child-agent:${input.role}`] },
      { capability: "external.side_effect", resources: ["child-agent-runtime"] },
    ],
  }),
  description:
    "Schedule a child coding agent in a tmux window. Runtime maps the child to a durable Workflow attempt and pushes its terminal result back to the parent run.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      role: {
        type: "string",
        enum: ["explore", "review", "test", "implement"],
        description:
          "Coarse model-chosen coordination label. Runtime write permission is controlled by readOnly/worktree isolation, not by role.",
      },
      task: {
        type: "string",
        description:
          "Model-chosen child-agent objective and instructions. The child writes its result to result.md.",
      },
      readOnly: {
        type: "boolean",
        description: "Whether the child may only use read-only permissions. Defaults to false so the model can decide task hierarchy.",
      },
      timeoutMs: {
        type: "integer",
        minimum: 1,
      },
      maxToolCalls: {
        type: "integer",
        minimum: 1,
      },
      maxTokens: {
        type: "integer",
        minimum: 1,
      },
      worktreePath: {
        type: "string",
        description:
          "Optional isolated workspace for the child. Write-capable child agents auto-create one when omitted.",
      },
    },
    required: ["role", "task"],
  },
  parse: parseAgentSpawnInput,
  async execute(input, context) {
    const runtime = requireChildAgentRuntime(context);
    const run = context.childScheduler === undefined
      ? await runtime.spawnAgent(input)
      : await context.childScheduler.spawnAgent({
          ...input,
          toolCallId: requireToolCallId(context),
        });
    return {
      childRunId: run.childRunId,
      parentRunId: run.parentRunId,
      role: run.role,
      agentId: run.agentId,
      status: run.status,
      readOnly: run.readOnly,
      runDir: run.paths.runDir,
      taskFile: run.paths.taskFile,
      resultFile: run.paths.resultFile,
      statusFile: run.paths.statusFile,
      workspaceRoot: run.workspaceRoot,
      ...optionalString("worktreePath", run.worktreePath),
      tmux: run.tmux,
      budget: run.budget,
    };
  },
};

export const agentListTool: CodingToolDefinition<
  "agent_list",
  AgentListInput,
  unknown
> = {
  name: "agent_list",
  riskLevel: "read-only",
  executionMode: "parallel",
  resolveCapabilities: () => ({
    requirements: [{ capability: "runtime.read", resources: ["child-agents"] }],
  }),
  description:
    "List child agents for the current parent run, including their status and tmux target.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      includeCompleted: {
        type: "boolean",
      },
    },
  },
  parse(input) {
    return {
      ok: true,
      input: {
        includeCompleted: readBoolean(input, "includeCompleted") ?? false,
      },
    };
  },
  async execute(input, context) {
    const runtime = requireChildAgentRuntime(context);
    const runs = await runtime.listAgents({
      ...optionalBoolean("includeCompleted", input.includeCompleted),
    });
    return {
      agents: runs.map(summaryForRun),
    };
  },
};

export const agentCaptureTool: CodingToolDefinition<
  "agent_capture",
  AgentCaptureInput,
  unknown
> = {
  name: "agent_capture",
  riskLevel: "read-only",
  executionMode: "parallel",
  resolveCapabilities: (input) => ({
    requirements: [{
      capability: "runtime.read",
      resources: [`child-agent:${input.childRunId}`],
    }],
  }),
  description:
    "Capture the tail of a child agent's tmux pane for observation without ingesting the full transcript.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      childRunId: { type: "string" },
      lines: { type: "integer", minimum: 1 },
      maxChars: { type: "integer", minimum: 1 },
    },
    required: ["childRunId"],
  },
  parse: parseAgentCaptureInput,
  async execute(input, context) {
    const runtime = requireChildAgentRuntime(context);
    return runtime.captureAgent(input);
  },
};

export const agentSendTool: CodingToolDefinition<
  "agent_send",
  AgentSendInput,
  unknown
> = {
  name: "agent_send",
  riskLevel: "external",
  executionMode: "sequential",
  resolveCapabilities: (input) => ({
    requirements: [
      {
        capability: "runtime.control",
        resources: [`child-agent:${input.childRunId}`],
      },
      { capability: "external.side_effect", resources: ["child-agent-runtime"] },
    ],
  }),
  description:
    "Send text to a running child agent's tmux pane, optionally pressing Enter.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      childRunId: { type: "string" },
      text: { type: "string" },
      enter: { type: "boolean" },
    },
    required: ["childRunId", "text"],
  },
  parse: parseAgentSendInput,
  async execute(input, context) {
    const runtime = requireChildAgentRuntime(context);
    return runtime.sendAgent(input);
  },
};

export const agentStopTool: CodingToolDefinition<
  "agent_stop",
  AgentStopInput,
  unknown
> = {
  name: "agent_stop",
  riskLevel: "external",
  executionMode: "sequential",
  resolveCapabilities: (input) => ({
    requirements: [
      {
        capability: "runtime.control",
        resources: [`child-agent:${input.childRunId}`],
      },
      { capability: "external.side_effect", resources: ["child-agent-runtime"] },
    ],
    effects: { destructive: true },
  }),
  description:
    "Stop a child agent by killing its tmux window and marking the child run stopped.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      childRunId: { type: "string" },
      reason: { type: "string" },
    },
    required: ["childRunId"],
  },
  parse: parseAgentStopInput,
  async execute(input, context) {
    const runtime = requireChildAgentRuntime(context);
    await context.childScheduler?.cancelChild(
      input.childRunId,
      input.reason ?? "stopped_by_parent_agent",
    );
    const run = await runtime.stopAgent(input);
    return summaryForRun(run);
  },
};

export const agentCollectTool: CodingToolDefinition<
  "agent_collect",
  AgentCollectInput,
  unknown
> = {
  name: "agent_collect",
  riskLevel: "read-only",
  executionMode: "parallel",
  resolveCapabilities: (input) => ({
    requirements: [{
      capability: "runtime.read",
      resources: [`child-agent:${input.childRunId}`],
    }],
  }),
  description:
    "Read a child agent's structured status, result.md and usage summary for diagnostics. Scheduled terminal results are pushed automatically, so polling is unnecessary.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      childRunId: { type: "string" },
    },
    required: ["childRunId"],
  },
  parse: parseAgentCollectInput,
  async execute(input, context) {
    const runtime = requireChildAgentRuntime(context);
    const collected = await runtime.collectAgent(input.childRunId);
    return {
      agent: summaryForRun(collected.run),
      alive: collected.alive,
      usage: collected.usage,
      ...(collected.result === undefined ? {} : { result: collected.result }),
      ...(collected.captureTail === undefined
        ? {}
        : { captureTail: collected.captureTail }),
    };
  },
};

function parseAgentSpawnInput(
  input: UnknownRecord,
): ToolInputParseResult<AgentSpawnInput> {
  const role = readString(input, "role");
  const task = readString(input, "task");
  if (!isChildAgentRole(role) || task === undefined) {
    return invalidInput("agent_spawn.role and agent_spawn.task are required");
  }
  return {
    ok: true,
    input: {
      role,
      task,
      ...optionalBoolean("readOnly", readBoolean(input, "readOnly")),
      ...optionalNumber("timeoutMs", readNumber(input, "timeoutMs")),
      ...optionalNumber("maxToolCalls", readNumber(input, "maxToolCalls")),
      ...optionalNumber("maxTokens", readNumber(input, "maxTokens")),
      ...optionalString("worktreePath", readString(input, "worktreePath")),
    },
  };
}

function parseAgentCaptureInput(
  input: UnknownRecord,
): ToolInputParseResult<AgentCaptureInput> {
  const childRunId = readString(input, "childRunId");
  if (childRunId === undefined) {
    return invalidInput("agent_capture.childRunId must be a string");
  }
  return {
    ok: true,
    input: {
      childRunId: childRunId as AgentRunId,
      ...optionalNumber("lines", readNumber(input, "lines")),
      ...optionalNumber("maxChars", readNumber(input, "maxChars")),
    },
  };
}

function parseAgentSendInput(
  input: UnknownRecord,
): ToolInputParseResult<AgentSendInput> {
  const childRunId = readString(input, "childRunId");
  const text = readString(input, "text");
  if (childRunId === undefined || text === undefined) {
    return invalidInput("agent_send.childRunId and agent_send.text are required");
  }
  return {
    ok: true,
    input: {
      childRunId: childRunId as AgentRunId,
      text,
      ...optionalBoolean("enter", readBoolean(input, "enter")),
    },
  };
}

function parseAgentStopInput(
  input: UnknownRecord,
): ToolInputParseResult<AgentStopInput> {
  const childRunId = readString(input, "childRunId");
  if (childRunId === undefined) {
    return invalidInput("agent_stop.childRunId must be a string");
  }
  return {
    ok: true,
    input: {
      childRunId: childRunId as AgentRunId,
      ...optionalString("reason", readString(input, "reason")),
    },
  };
}

function parseAgentCollectInput(
  input: UnknownRecord,
): ToolInputParseResult<AgentCollectInput> {
  const childRunId = readString(input, "childRunId");
  if (childRunId === undefined) {
    return invalidInput("agent_collect.childRunId must be a string");
  }
  return {
    ok: true,
    input: {
      childRunId: childRunId as AgentRunId,
    },
  };
}

function requireChildAgentRuntime(context: ToolRunContext) {
  if (context.childAgents === undefined) {
    const error = new Error("ChildAgentRuntime is not available");
    error.name = "invalid_input";
    throw error;
  }
  return context.childAgents;
}

function requireToolCallId(context: ToolRunContext): ToolCallId {
  const callId = context.authorization?.callId;
  if (callId === undefined) {
    const error = new Error("Scheduled agent_spawn requires a tool call id");
    error.name = "invalid_input";
    throw error;
  }
  return callId;
}

function summaryForRun(run: {
  readonly childRunId: AgentRunId;
  readonly parentRunId: AgentRunId;
  readonly role: ChildAgentRole;
  readonly agentId: string;
  readonly status: string;
  readonly readOnly: boolean;
  readonly workspaceRoot: string;
  readonly worktreePath?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly stopReason?: string;
  readonly tmux?: { readonly target: string };
  readonly paths: {
    readonly runDir: string;
    readonly taskFile: string;
    readonly statusFile: string;
    readonly resultFile: string;
    readonly usageFile: string;
  };
}) {
  return {
    childRunId: run.childRunId,
    parentRunId: run.parentRunId,
    role: run.role,
    agentId: run.agentId,
    status: run.status,
    readOnly: run.readOnly,
    workspaceRoot: run.workspaceRoot,
    ...optionalString("worktreePath", run.worktreePath),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...optionalString("startedAt", run.startedAt),
    ...optionalString("endedAt", run.endedAt),
    ...optionalString("stopReason", run.stopReason),
    tmuxTarget: run.tmux?.target,
    runDir: run.paths.runDir,
    taskFile: run.paths.taskFile,
    statusFile: run.paths.statusFile,
    resultFile: run.paths.resultFile,
    usageFile: run.paths.usageFile,
  };
}

function isChildAgentRole(value: string | undefined): value is ChildAgentRole {
  return value === "explore" ||
    value === "review" ||
    value === "test" ||
    value === "implement";
}

function readString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: UnknownRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function readBoolean(record: UnknownRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function optionalString<Key extends string>(
  key: Key,
  value: string | undefined,
): { readonly [Property in Key]: string } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: string;
  };
}

function optionalNumber<Key extends string>(
  key: Key,
  value: number | undefined,
): { readonly [Property in Key]: number } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: number;
  };
}

function optionalBoolean<Key extends string>(
  key: Key,
  value: boolean | undefined,
): { readonly [Property in Key]: boolean } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: boolean;
  };
}

function invalidInput(message: string): { readonly ok: false; readonly message: string } {
  return { ok: false, message };
}
