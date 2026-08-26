import { randomUUID } from "node:crypto";
import type { LlmMessage, LlmToolSchema } from "../core/agent";
import type {
  ToolCallId,
} from "../core/ids";
import type {
  ToolApprovalContext,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolCall,
  ToolMetadata,
} from "../core/tools";
import type { ToolApprovalPrompter } from "../ports/tools";
import type { TaskStore } from "../workspace/tasks";
import type { RuntimeHook, RuntimeModelCallHookContext } from "./hooks";

export type AgentMode = "execute" | "plan" | "coordinator";

export interface PlanModeApprovalRequest {
  readonly summary?: string;
  readonly planMarkdown?: string;
  readonly planPath?: string;
}

export interface PlanModeApprovalRequester {
  requestEnterPlanMode?(
    request: { readonly goal?: string },
    signal?: AbortSignal,
  ): Promise<ToolApprovalDecision>;
  requestExitPlanMode(
    request: PlanModeApprovalRequest,
    signal?: AbortSignal,
  ): Promise<ToolApprovalDecision>;
}

export interface AgentRuntimeState {
  version: number;
  mode: AgentMode;
  readonly modeTransitions: Array<{
    readonly version: number;
    readonly mode: AgentMode;
  }>;
  readonly plan: {
    enteredAt?: string;
    updatedAt?: string;
    approvedAt?: string;
    approvalSummary?: string;
    planPath: string;
    approval?: PlanModeApprovalRequester;
  };
  readonly workflow: {
    taskStore?: TaskStore;
  };
  readonly coordinator: {
    enteredAt?: string;
    exitedAt?: string;
    goal?: string;
  };
  readonly steering: {
    messages: string[];
  };
}

export interface AgentRuntimeStateSnapshot {
  readonly version?: number;
  readonly mode: AgentMode;
  readonly plan?: {
    readonly enteredAt?: string;
    readonly updatedAt?: string;
    readonly approvedAt?: string;
    readonly approvalSummary?: string;
    readonly planPath?: string;
  };
  readonly coordinator?: {
    readonly enteredAt?: string;
    readonly exitedAt?: string;
    readonly goal?: string;
  };
}

export interface CreateAgentRuntimeStateOptions {
  readonly mode?: AgentMode;
  readonly planPath?: string;
  readonly planApproval?: PlanModeApprovalRequester;
  readonly taskStore?: TaskStore;
}

export function createAgentRuntimeStateFromSnapshot(
  snapshot: AgentRuntimeStateSnapshot | undefined,
): AgentRuntimeState {
  if (snapshot === undefined) {
    return createAgentRuntimeState();
  }
  const state = createAgentRuntimeState({
    mode: snapshot.mode,
    ...(snapshot.plan?.planPath === undefined
      ? {}
      : { planPath: snapshot.plan.planPath }),
  });
  state.version = snapshot.version ?? 0;
  copyOptionalString(snapshot.plan?.enteredAt, (value) => {
    state.plan.enteredAt = value;
  });
  copyOptionalString(snapshot.plan?.updatedAt, (value) => {
    state.plan.updatedAt = value;
  });
  copyOptionalString(snapshot.plan?.approvedAt, (value) => {
    state.plan.approvedAt = value;
  });
  copyOptionalString(snapshot.plan?.approvalSummary, (value) => {
    state.plan.approvalSummary = value;
  });
  copyOptionalString(snapshot.coordinator?.enteredAt, (value) => {
    state.coordinator.enteredAt = value;
  });
  copyOptionalString(snapshot.coordinator?.exitedAt, (value) => {
    state.coordinator.exitedAt = value;
  });
  copyOptionalString(snapshot.coordinator?.goal, (value) => {
    state.coordinator.goal = value;
  });
  return state;
}

export function snapshotAgentRuntimeState(
  state: AgentRuntimeState,
): AgentRuntimeStateSnapshot {
  return {
    version: state.version,
    mode: state.mode,
    plan: {
      planPath: state.plan.planPath,
      ...(state.plan.enteredAt === undefined
        ? {}
        : { enteredAt: state.plan.enteredAt }),
      ...(state.plan.updatedAt === undefined
        ? {}
        : { updatedAt: state.plan.updatedAt }),
      ...(state.plan.approvedAt === undefined
        ? {}
        : { approvedAt: state.plan.approvedAt }),
      ...(state.plan.approvalSummary === undefined
        ? {}
        : { approvalSummary: state.plan.approvalSummary }),
    },
    coordinator: {
      ...(state.coordinator.enteredAt === undefined
        ? {}
        : { enteredAt: state.coordinator.enteredAt }),
      ...(state.coordinator.exitedAt === undefined
        ? {}
        : { exitedAt: state.coordinator.exitedAt }),
      ...(state.coordinator.goal === undefined
        ? {}
        : { goal: state.coordinator.goal }),
    },
  };
}

export function createAgentRuntimeState(
  options: CreateAgentRuntimeStateOptions = {},
): AgentRuntimeState {
  return {
    version: 0,
    mode: options.mode ?? "execute",
    modeTransitions: [],
    plan: {
      planPath: options.planPath ?? "PLAN.md",
      ...(options.planApproval === undefined
        ? {}
        : { approval: options.planApproval }),
    },
    workflow: {
      ...(options.taskStore === undefined ? {} : { taskStore: options.taskStore }),
    },
    coordinator: {},
    steering: {
      messages: [],
    },
  };
}

function copyOptionalString(
  value: string | undefined,
  assign: (value: string) => void,
): void {
  if (value !== undefined) {
    assign(value);
  }
}

export function configureAgentRuntimeState(
  state: AgentRuntimeState,
  options: {
    readonly planApproval?: PlanModeApprovalRequester;
    readonly taskStore?: TaskStore;
  },
): void {
  if (options.planApproval !== undefined) {
    state.plan.approval = options.planApproval;
  }
  if (options.taskStore !== undefined) {
    state.workflow.taskStore = options.taskStore;
  }
}

export function enterPlanMode(state: AgentRuntimeState): void {
  setAgentRuntimeMode(state, "plan");
  state.plan.enteredAt = new Date().toISOString();
  delete state.plan.approvedAt;
}

export function markPlanUpdated(state: AgentRuntimeState): void {
  bumpAgentRuntimeStateVersion(state);
  state.plan.updatedAt = new Date().toISOString();
  delete state.plan.approvedAt;
}

export function exitPlanMode(
  state: AgentRuntimeState,
  summary: string | undefined,
): void {
  setAgentRuntimeMode(state, "execute");
  state.plan.approvedAt = new Date().toISOString();
  if (summary === undefined) {
    delete state.plan.approvalSummary;
  } else {
    state.plan.approvalSummary = summary;
  }
}

export function enterCoordinatorMode(
  state: AgentRuntimeState,
  goal: string | undefined,
): void {
  setAgentRuntimeMode(state, "coordinator");
  state.coordinator.enteredAt = new Date().toISOString();
  delete state.coordinator.exitedAt;
  if (goal === undefined || goal.trim().length === 0) {
    delete state.coordinator.goal;
  } else {
    state.coordinator.goal = goal.trim();
  }
}

export function exitCoordinatorMode(state: AgentRuntimeState): void {
  setAgentRuntimeMode(state, "execute");
  state.coordinator.exitedAt = new Date().toISOString();
}

export function addSteeringMessage(
  state: AgentRuntimeState,
  message: string,
): void {
  bumpAgentRuntimeStateVersion(state);
  state.steering.messages.push(message);
}

export function bumpAgentRuntimeStateVersion(state: AgentRuntimeState): void {
  state.version += 1;
}

export function setAgentRuntimeMode(
  state: AgentRuntimeState,
  mode: AgentMode,
): void {
  bumpAgentRuntimeStateVersion(state);
  state.mode = mode;
  state.modeTransitions.push({
    version: state.version,
    mode,
  });
}

export function isPlanControlTool(name: string): boolean {
  return PLAN_CONTROL_TOOL_NAMES.has(name);
}

export function isCoordinatorControlTool(name: string): boolean {
  return COORDINATOR_CONTROL_TOOL_NAMES.has(name);
}

export function isChildAgentControlTool(name: string): boolean {
  return CHILD_AGENT_CONTROL_TOOL_NAMES.has(name);
}

export function isTaskControlTool(name: string): boolean {
  return TASK_CONTROL_TOOL_NAMES.has(name);
}

export function isToolAllowedInMode(
  mode: AgentMode,
  toolName: string,
  metadata: ToolMetadata | undefined,
): boolean {
  if (mode === "execute") {
    return true;
  }

  if (mode === "plan") {
    return isPlanControlTool(toolName) || metadata?.riskLevel === "read-only";
  }

  return metadata?.riskLevel === "read-only" ||
    isCoordinatorControlTool(toolName) ||
    isChildAgentControlTool(toolName) ||
    isTaskControlTool(toolName);
}

export interface RuntimeModeHookOptions {
  readonly state: AgentRuntimeState;
  readonly describeTool?: (name: string) => ToolMetadata | undefined;
}

export class RuntimeModeHook implements RuntimeHook {
  constructor(private readonly options: RuntimeModeHookOptions) {}

  beforeModelCall(context: RuntimeModelCallHookContext) {
    const request = withRuntimeMessages(context.request, context.stepContext);
    if (context.stepContext.mode === "execute") {
      return request;
    }

    return {
      ...request,
      tools: request.tools.filter((tool) =>
        isToolAllowedInMode(
          context.stepContext.mode,
          tool.name,
          this.options.describeTool?.(tool.name),
        )),
    };
  }

  beforeToolCall(context: {
    readonly call: ToolCall;
    readonly metadata?: ToolMetadata;
    readonly stepContext: RuntimeModelCallHookContext["stepContext"];
  }) {
    if (!context.stepContext.advertisedTools.includes(context.call.name)) {
      return {
        allowed: false as const,
        reason: `Tool ${context.call.name} was not advertised for step ${context.stepContext.stepId}`,
      };
    }
    const tightening = this.options.state.modeTransitions.find(
      (transition) =>
        transition.version > context.stepContext.stateVersion &&
        !isToolAllowedInMode(
          transition.mode,
          context.call.name,
          context.metadata,
        ),
    );
    if (tightening !== undefined) {
      return {
        allowed: false as const,
        reason: modeDeniedReason(tightening.mode, context.call.name),
      };
    }
    if (
      isToolAllowedInMode(
        this.options.state.mode,
        context.call.name,
        context.metadata,
      )
    ) {
      return undefined;
    }

    return {
      allowed: false as const,
      reason: modeDeniedReason(this.options.state.mode, context.call.name),
    };
  }
}

export interface ToolPlanApprovalRequesterOptions {
  readonly prompter: ToolApprovalPrompter;
  readonly context: ToolApprovalContext;
  readonly timeoutMs: number;
  readonly onDecision?: (event: {
    readonly request: ToolApprovalRequest;
    readonly mode: "plan";
    readonly policy: "prompt";
    readonly decision: ToolApprovalDecision;
  }) => Promise<void> | void;
}

export function createToolPlanApprovalRequester(
  options: ToolPlanApprovalRequesterOptions,
): PlanModeApprovalRequester {
  return {
    async requestEnterPlanMode(request, signal) {
      const approvalRequest: ToolApprovalRequest = {
        call: {
          id: `enter-plan-${randomUUID()}` as ToolCallId,
          name: "enter_plan_mode",
          input: {
            goal: request.goal ?? "",
          },
        },
        risk: "mutating",
        explanation:
          "Enter Plan Mode and restrict pibot to read-only planning until the saved plan is approved.",
      };
      const decision = await options.prompter.requestToolApproval(
        {
          ...approvalRequest,
          context: options.context,
          timeoutMs: options.timeoutMs,
        },
        signal,
      );
      await options.onDecision?.({
        request: approvalRequest,
        mode: "plan",
        policy: "prompt",
        decision,
      });
      return decision;
    },
    async requestExitPlanMode(request, signal) {
      const approvalRequest: ToolApprovalRequest = {
        call: {
          id: `exit-plan-${randomUUID()}` as ToolCallId,
          name: "exit_plan_mode",
          input: {
            summary: request.summary ?? "",
            planPath: request.planPath ?? "PLAN.md",
            planExcerpt: truncateForApproval(request.planMarkdown ?? "", 2400),
          },
        },
        risk: "mutating",
        explanation:
          "Exit Plan Mode and allow pibot to start executing the approved plan.",
      };
      const decision = await options.prompter.requestToolApproval(
        {
          ...approvalRequest,
          context: options.context,
          timeoutMs: options.timeoutMs,
        },
        signal,
      );
      await options.onDecision?.({
        request: approvalRequest,
        mode: "plan",
        policy: "prompt",
        decision,
      });
      return decision;
    },
  };
}

const PLAN_CONTROL_TOOL_NAMES = new Set([
  "enter_plan_mode",
  "update_plan",
  "exit_plan_mode",
  "enter_coordinator_mode",
  "exit_coordinator_mode",
  "tasks_read",
  "tasks_update",
  "task_update",
]);

const COORDINATOR_CONTROL_TOOL_NAMES = new Set([
  "enter_coordinator_mode",
  "exit_coordinator_mode",
]);

const CHILD_AGENT_CONTROL_TOOL_NAMES = new Set([
  "agent_spawn",
  "agent_list",
  "agent_capture",
  "agent_send",
  "agent_stop",
  "agent_collect",
]);

const TASK_CONTROL_TOOL_NAMES = new Set([
  "tasks_read",
  "tasks_update",
  "task_update",
]);

function withRuntimeMessages(
  request: RuntimeModelCallHookContext["request"],
  stepContext: RuntimeModelCallHookContext["stepContext"],
): RuntimeModelCallHookContext["request"] {
  const modeMessage: LlmMessage = {
    role: "system",
    content: renderRuntimeModeMessage(
      stepContext.mode,
      stepContext.coordinatorGoal,
    ),
  };
  const [first, ...rest] = request.messages;
  if (first?.role === "system") {
    return {
      ...request,
      messages: [first, modeMessage, ...rest],
    };
  }

  return {
    ...request,
    messages: [modeMessage, ...request.messages],
  };
}

function renderRuntimeModeMessage(
  mode: AgentMode,
  coordinatorGoal: string | undefined,
): string {
  if (mode === "plan") {
    return [
      "Runtime mode: plan.",
      "Use only read-only exploration tools plus update_plan/tasks_update/task_update.",
      "Keep PLAN.md and tasks.json current for executable work. Call exit_plan_mode when the plan is ready; do not ask for plan approval in plain text.",
    ].join(" ");
  }

  if (mode === "coordinator") {
    return [
      "Runtime mode: coordinator.",
      "Act as a coordinator: decompose work, spawn focused read-only child agents, observe tmux panes, collect structured results, and summarize.",
      "Do not directly edit files or run shell commands in the main agent while coordinating; use child-agent control tools plus read-only inspection and task control tools.",
      "Collect terminal child agents before retrying; failed, stopped, or timed-out children should be summarized or replaced deliberately instead of polled repeatedly.",
      ...(coordinatorGoal === undefined
        ? []
        : [`Coordinator goal: ${coordinatorGoal}`]),
    ].join(" ");
  }

  return [
    "Runtime mode: execute.",
    "You may execute approved changes. For complex or ambiguous work, enter Plan Mode before editing.",
  ].join(" ");
}

function modeDeniedReason(mode: AgentMode, toolName: string): string {
  if (mode === "plan") {
    return (
      `Tool "${toolName}" is not allowed while AgentMode=plan. ` +
      "Plan Mode only allows read-only tools and plan/task control tools."
    );
  }

  if (mode === "coordinator") {
    return (
      `Tool "${toolName}" is not allowed while AgentMode=coordinator. ` +
      "Coordinator Mode allows read-only tools, child-agent control tools, " +
      "and task control tools; the main agent should not directly mutate files or run shell commands."
    );
  }

  return `Tool "${toolName}" is not allowed while AgentMode=${mode}.`;
}

function truncateForApproval(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}\n[truncated]`;
}
