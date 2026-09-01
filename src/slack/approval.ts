import { randomUUID } from "node:crypto";
import type { SlackMessageTs, SlackUserId } from "../core/ids";
import type {
  SlackBlock,
  SlackConversationRef,
} from "../core/slack";
import type {
  ToolApprovalDecision,
  ToolApprovalPromptRequest,
  ToolCall,
} from "../core/tools";
import type { SlackEventPublisher, SlackInteractiveHandler } from "../ports/slack";
import type { ToolApprovalPrompter } from "../ports/tools";

type UnknownRecord = Readonly<Record<string, unknown>>;

export const TOOL_APPROVAL_ALLOW_ACTION = "pibot_tool_approval_allow";
export const TOOL_APPROVAL_DENY_ACTION = "pibot_tool_approval_deny";
export const TOOL_APPROVAL_ALLOW_RUN_ACTION = "pibot_tool_approval_allow_run";
export const TOOL_APPROVAL_DENY_RUN_ACTION = "pibot_tool_approval_deny_run";
export const TOOL_APPROVAL_ALLOW_SESSION_ACTION =
  "pibot_tool_approval_allow_session";
export const TOOL_APPROVAL_DENY_SESSION_ACTION =
  "pibot_tool_approval_deny_session";
export const TOOL_APPROVAL_ALLOW_REPO_ACTION = "pibot_tool_approval_allow_repo";
export const TOOL_APPROVAL_DENY_REPO_ACTION = "pibot_tool_approval_deny_repo";

type ApprovalScope = "once" | "run" | "session" | "repo";

interface PendingApproval {
  readonly request: ToolApprovalPromptRequest;
  readonly resolve: (decision: ToolApprovalDecision) => void;
  readonly timeout: NodeJS.Timeout;
  readonly abort: () => void;
  readonly signal?: AbortSignal;
  messageTs: SlackMessageTs | undefined;
  completionStatus: string | undefined;
  settled: boolean;
}

interface ParsedApprovalAction {
  readonly approvalId: string;
  readonly approved: boolean;
  readonly scope: ApprovalScope;
  readonly userId: SlackUserId;
}

/**
 * Posts Slack approval buttons and resolves the matching tool call.
 * Decisions are intentionally in-memory: a bot restart fails pending calls closed.
 */
export class SlackToolApprovalBroker
  implements ToolApprovalPrompter, SlackInteractiveHandler
{
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly publisher: SlackEventPublisher) {}

  pendingApprovalCount(conversation?: SlackConversationRef): number {
    if (conversation === undefined) {
      return this.pending.size;
    }
    let count = 0;
    for (const pending of this.pending.values()) {
      const current = pending.request.context.conversation;
      if (
        current.teamId === conversation.teamId &&
        current.channelId === conversation.channelId &&
        current.threadTs === conversation.threadTs
      ) {
        count += 1;
      }
    }
    return count;
  }

  async requestToolApproval(
    request: ToolApprovalPromptRequest,
    signal?: AbortSignal,
  ): Promise<ToolApprovalDecision> {
    if (isAborted(signal)) {
      return deniedDecision("Tool approval was cancelled before it was requested");
    }

    const approvalId = randomUUID();
    let resolveDecision!: (decision: ToolApprovalDecision) => void;
    const decisionPromise = new Promise<ToolApprovalDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const abort = () => {
      void this.finishApproval(
        approvalId,
        deniedDecision("Tool approval was cancelled"),
        "Cancelled before execution.",
      );
    };
    const timeout = setTimeout(() => {
      void this.finishApproval(
        approvalId,
        deniedDecision("Tool approval timed out"),
        "Approval expired before execution.",
      );
    }, request.timeoutMs);
    const created: PendingApproval = {
      request,
      resolve: resolveDecision,
      timeout,
      abort,
      ...(signal === undefined ? {} : { signal }),
      messageTs: undefined,
      completionStatus: undefined,
      settled: false,
    };
    this.pending.set(approvalId, created);
    signal?.addEventListener("abort", abort, { once: true });

    const publishResult = await this.publisher
      .publishSlackEvent({
        type: "message.post",
        draft: {
          conversation: request.context.conversation,
          text: formatApprovalFallbackText(request),
          blocks: approvalBlocks(approvalId, request),
        },
      })
      .catch(() => undefined);
    if (publishResult === undefined || publishResult.messageTs === undefined) {
      await this.finishApproval(
        approvalId,
        deniedDecision("Unable to request Slack tool approval"),
        "Unable to request Slack tool approval.",
      );
      return decisionPromise;
    }

    created.messageTs = publishResult.messageTs;
    if (created.settled) {
      await this.updateApprovalMessage(
        request,
        publishResult.messageTs,
        created.completionStatus ?? "Tool approval completed.",
      );
      return decisionPromise;
    }

    if (isAborted(signal)) {
      await this.finishApproval(
        approvalId,
        deniedDecision("Tool approval was cancelled"),
        "Cancelled before execution.",
      );
    }

    return decisionPromise;
  }

  async handleSlackInteraction(body: UnknownRecord): Promise<boolean> {
    const action = parseApprovalAction(body);
    if (action === null) {
      return false;
    }

    const pending = this.pending.get(action.approvalId);
    if (pending === undefined) {
      return true;
    }

    if (action.userId !== pending.request.context.requestedByUserId) {
      return true;
    }

    await this.finishApproval(
      action.approvalId,
      action.approved
        ? (action.scope !== "once" &&
            approvalScopeAllowed(pending.request, action.scope)
            ? { approved: true, scope: action.scope }
            : { approved: true })
        : (action.scope !== "once" &&
            approvalScopeAllowed(pending.request, action.scope)
            ? {
                ...deniedDecision("Tool call was rejected in Slack"),
                scope: action.scope,
              }
            : deniedDecision("Tool call was rejected in Slack")),
      approvalDecisionStatus(
        pending.request.call,
        action.approved,
        action.userId,
        approvalScopeAllowed(pending.request, action.scope)
          ? action.scope
          : "once",
      ),
    );
    return true;
  }

  private async finishApproval(
    approvalId: string,
    decision: ToolApprovalDecision,
    status: string,
  ): Promise<void> {
    const pending = this.pending.get(approvalId);
    if (pending === undefined || pending.settled) {
      return;
    }

    pending.settled = true;
    pending.completionStatus = status;
    this.pending.delete(approvalId);
    clearTimeout(pending.timeout);
    pending.signal?.removeEventListener("abort", pending.abort);
    pending.resolve(decision);

    if (pending.messageTs === undefined) {
      return;
    }

    await this.updateApprovalMessage(
      pending.request,
      pending.messageTs,
      status,
    );
  }

  private async updateApprovalMessage(
    request: ToolApprovalPromptRequest,
    messageTs: SlackMessageTs,
    status: string,
  ): Promise<void> {
    await this.publisher
      .publishSlackEvent({
        type: "message.update",
        update: {
          conversation: request.context.conversation,
          messageTs,
          text: status,
          blocks: completedApprovalBlocks(request, status),
        },
      })
      .catch(() => undefined);
  }
}

function approvalBlocks(
  approvalId: string,
  request: ToolApprovalPromptRequest,
): readonly SlackBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: formatApprovalSummary(request),
      },
    },
    {
      type: "actions",
      blockId: `pibot_tool_approval_${approvalId}`,
      elements: [
        {
          type: "button",
          actionId: TOOL_APPROVAL_ALLOW_ACTION,
          text: { type: "plain_text", text: "Allow once" },
          value: approvalId,
          style: "primary",
        },
        ...(request.runScopeAllowed === true ? [{
          type: "button",
          actionId: TOOL_APPROVAL_ALLOW_RUN_ACTION,
          text: { type: "plain_text", text: "Allow for run" },
          value: approvalId,
        } as const] : []),
        ...(request.sessionScopeAllowed === true ? [{
          type: "button",
          actionId: TOOL_APPROVAL_ALLOW_SESSION_ACTION,
          text: { type: "plain_text", text: "Allow for session" },
          value: approvalId,
        } as const] : []),
        ...(request.repoScopeAllowed === true ? [{
          type: "button",
          actionId: TOOL_APPROVAL_ALLOW_REPO_ACTION,
          text: { type: "plain_text", text: "Allow for repo" },
          value: approvalId,
        } as const] : []),
      ],
    },
    {
      type: "actions",
      blockId: `pibot_tool_approval_deny_${approvalId}`,
      elements: [
        {
          type: "button",
          actionId: TOOL_APPROVAL_DENY_ACTION,
          text: { type: "plain_text", text: "Reject once" },
          value: approvalId,
          style: "danger",
        },
        ...(request.runScopeAllowed === true ? [{
          type: "button",
          actionId: TOOL_APPROVAL_DENY_RUN_ACTION,
          text: { type: "plain_text", text: "Deny for run" },
          value: approvalId,
        } as const] : []),
        ...(request.sessionScopeAllowed === true ? [{
          type: "button",
          actionId: TOOL_APPROVAL_DENY_SESSION_ACTION,
          text: { type: "plain_text", text: "Deny for session" },
          value: approvalId,
        } as const] : []),
        ...(request.repoScopeAllowed === true ? [{
          type: "button",
          actionId: TOOL_APPROVAL_DENY_REPO_ACTION,
          text: { type: "plain_text", text: "Deny for repo" },
          value: approvalId,
        } as const] : []),
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Only <@${request.context.requestedByUserId}> can decide. Expires in ${Math.ceil(request.timeoutMs / 1000)} seconds.`,
        },
      ],
    },
  ];
}

function completedApprovalBlocks(
  request: ToolApprovalPromptRequest,
  status: string,
): readonly SlackBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: formatCompletedApprovalSummary(request, status),
      },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: status }],
    },
  ];
}

function formatApprovalFallbackText(request: ToolApprovalPromptRequest): string {
  if (request.call.name === "enter_plan_mode") {
    return "Plan approval required to enter Plan Mode";
  }
  if (request.call.name === "exit_plan_mode") {
    return "Plan approval required to exit Plan Mode";
  }

  return `Approval required for tool ${request.call.name}`;
}

function formatApprovalSummary(request: ToolApprovalPromptRequest): string {
  if (request.call.name === "enter_plan_mode") {
    return [
      "*Plan approval required*",
      "Approve this to enter Plan Mode and switch pibot into read-only planning.",
      formatToolDetails(request.call),
    ].join("\n");
  }
  if (request.call.name === "exit_plan_mode") {
    return [
      "*Plan approval required*",
      "Approve this to leave Plan Mode, freeze the saved plan and TaskGraph, then start runtime scheduling.",
      `Risk: *${request.risk}*`,
      ...formatCapabilityDetails(request),
      formatToolDetails(request.call),
    ].join("\n");
  }

  return [
    `*Tool approval required*: \`${inlineCode(request.call.name)}\``,
    `Risk: *${request.risk}*`,
    ...formatCapabilityDetails(request),
    formatToolDetails(request.call),
  ].join("\n");
}

function formatCapabilityDetails(
  request: ToolApprovalPromptRequest,
): readonly string[] {
  if (request.capabilities === undefined) {
    return [];
  }
  const requested = request.escalation ?? request.capabilities;
  if (requested === undefined) {
    return [];
  }
  const details = requested.requirements.map((requirement) => {
    if (
      requirement.capability === "filesystem.read" ||
      requirement.capability === "filesystem.write"
    ) {
      return `Escalation: \`${inlineCode(requirement.capability)}(${inlineCode(requirement.paths.join(", "))})\``;
    }
    if (requirement.capability === "network.connect") {
      return `Escalation: \`${inlineCode(requirement.capability)}(${inlineCode(requirement.hosts.join(", "))})\``;
    }
    if (requirement.capability === "process.exec") {
      return `Escalation: \`${inlineCode(requirement.capability)}\``;
    }
    return `Escalation: \`${inlineCode(requirement.capability)}(${inlineCode(requirement.resources.join(", "))})\``;
  });
  if (request.sandbox !== undefined) {
    details.unshift(
      `Sandbox: \`${inlineCode(request.sandbox.backend)}\`; filesystem=\`${inlineCode(request.sandbox.filesystemEnforcement)}\`; network=\`${inlineCode(request.sandbox.networkEnforcement)}\`; policy=\`${inlineCode(request.sandbox.policyVersion)}\``,
    );
  }
  if (requested.effects?.destructive === true) {
    details.push("Escalation effect: `destructive`");
  }
  if (requested.effects?.openWorld === true) {
    details.push("Escalation effect: `openWorld`");
  }
  return details;
}

function formatCompletedApprovalSummary(
  request: ToolApprovalPromptRequest,
  status: string,
): string {
  if (isPlanModeApprovalTool(request.call.name)) {
    return [
      "*Plan approval completed*",
      status,
      formatToolDetails(request.call),
    ].join("\n");
  }

  return [
    `*Tool approval completed*: \`${inlineCode(request.call.name)}\``,
    status,
    formatToolDetails(request.call),
  ].join("\n");
}

function formatToolDetails(call: ToolCall): string {
  const input = readToolInput(call.input);
  switch (call.name) {
    case "enter_plan_mode": {
      const goal = readInputString(input, "goal");
      return goal.length === 0
        ? "Goal: not specified."
        : `Goal: ${inlineCode(codeFence(goal, 240))}`;
    }
    case "exit_plan_mode": {
      const summary = readInputString(input, "summary");
      const planPath = readInputString(input, "planPath") || "PLAN.md";
      const planExcerpt = readInputString(input, "planExcerpt");
      const tasksPath = readInputString(input, "tasksPath") || "tasks.json";
      const graphVersion = readInputNumber(input, "graphVersion");
      const taskCount = readInputNumber(input, "taskCount");
      const writeTaskCount = readInputNumber(input, "writeTaskCount");
      const tasksDigest = readInputString(input, "tasksDigest");
      return [
        `Plan: \`${inlineCode(planPath)}\``,
        `TaskGraph: \`${inlineCode(tasksPath)}\` v${graphVersion ?? "?"} (${taskCount ?? 0} tasks, ${writeTaskCount ?? 0} write-capable)`,
        ...(tasksDigest.length === 0
          ? []
          : [`TaskGraph digest: \`${inlineCode(tasksDigest)}\``]),
        ...(summary.length === 0
          ? []
          : [`Summary: ${inlineCode(codeFence(summary, 240))}`]),
        ...(planExcerpt.length === 0
          ? []
          : [`Plan excerpt: ${Buffer.byteLength(planExcerpt, "utf8")} bytes stored in ${inlineCode(planPath)}.`]),
      ].join("\n");
    }
    case "bash":
      return `Command:\n\`\`\`\n${codeFence(readInputString(input, "command"), 1200)}\n\`\`\``;
    case "write":
      return `Write path: \`${inlineCode(readInputString(input, "path"))}\` (${Buffer.byteLength(readInputString(input, "content"), "utf8")} bytes)`;
    case "edit":
      return `Edit path: \`${inlineCode(readInputString(input, "path"))}\` (${readInputArray(input, "replacements").length} replacement(s))`;
    case "read":
      return `Read path: \`${inlineCode(readInputString(input, "path"))}\``;
    case "grep":
      return `Search pattern: \`${inlineCode(readInputString(input, "pattern"))}\``;
    default:
      return `Arguments: \`${inlineCode(codeFence(JSON.stringify(call.input), 1000))}\``;
  }
}

function approvalDecisionStatus(
  call: ToolCall,
  approved: boolean,
  userId: SlackUserId,
  scope: ApprovalScope = "once",
): string {
  if (call.name === "enter_plan_mode") {
    return approved
      ? `Plan Mode approved by <@${userId}>. Entering Plan Mode.`
      : `Plan Mode rejected by <@${userId}>.`;
  }
  if (call.name === "exit_plan_mode") {
    return approved
      ? `Plan approved by <@${userId}>. Continuing execution.`
      : `Plan rejected by <@${userId}>.`;
  }

  const suffix = approvalScopeSuffix(scope);
  return approved
    ? `Approved${suffix} by <@${userId}>.`
    : `Rejected${suffix} by <@${userId}>.`;
}

function isPlanModeApprovalTool(toolName: string): boolean {
  return toolName === "enter_plan_mode" || toolName === "exit_plan_mode";
}

function readToolInput(input: unknown): UnknownRecord {
  return isRecord(input) ? input : {};
}

function readInputString(input: UnknownRecord, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

function readInputNumber(input: UnknownRecord, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readInputArray(input: UnknownRecord, key: string): readonly unknown[] {
  const value = input[key];
  return Array.isArray(value) ? value : [];
}

function parseApprovalAction(body: UnknownRecord): ParsedApprovalAction | null {
  if (readString(body, "type") !== "block_actions") {
    return null;
  }

  const user = readRecord(body, "user");
  const userId = readString(user, "id");
  const actions = body.actions;
  if (userId === undefined || !Array.isArray(actions) || actions.length === 0) {
    return null;
  }

  const action = actions[0];
  if (!isRecord(action)) {
    return null;
  }

  const actionId = readString(action, "action_id");
  const approvalId = readString(action, "value");
  if (
    approvalId === undefined ||
    (actionId !== TOOL_APPROVAL_ALLOW_ACTION &&
      actionId !== TOOL_APPROVAL_DENY_ACTION &&
      actionId !== TOOL_APPROVAL_ALLOW_RUN_ACTION &&
      actionId !== TOOL_APPROVAL_DENY_RUN_ACTION &&
      actionId !== TOOL_APPROVAL_ALLOW_SESSION_ACTION &&
      actionId !== TOOL_APPROVAL_DENY_SESSION_ACTION &&
      actionId !== TOOL_APPROVAL_ALLOW_REPO_ACTION &&
      actionId !== TOOL_APPROVAL_DENY_REPO_ACTION)
  ) {
    return null;
  }

  return {
    approvalId,
    approved:
      actionId === TOOL_APPROVAL_ALLOW_ACTION ||
      actionId === TOOL_APPROVAL_ALLOW_RUN_ACTION ||
      actionId === TOOL_APPROVAL_ALLOW_SESSION_ACTION ||
      actionId === TOOL_APPROVAL_ALLOW_REPO_ACTION,
    scope: approvalScopeForAction(actionId),
    userId: userId as SlackUserId,
  };
}

function approvalScopeAllowed(
  request: ToolApprovalPromptRequest,
  scope: ApprovalScope,
): boolean {
  if (scope === "once") {
    return true;
  }
  if (scope === "run") {
    return request.runScopeAllowed === true;
  }
  if (scope === "session") {
    return request.sessionScopeAllowed === true;
  }
  return request.repoScopeAllowed === true;
}

function approvalScopeForAction(actionId: string): ApprovalScope {
  if (
    actionId === TOOL_APPROVAL_ALLOW_RUN_ACTION ||
    actionId === TOOL_APPROVAL_DENY_RUN_ACTION
  ) {
    return "run";
  }
  if (
    actionId === TOOL_APPROVAL_ALLOW_SESSION_ACTION ||
    actionId === TOOL_APPROVAL_DENY_SESSION_ACTION
  ) {
    return "session";
  }
  if (
    actionId === TOOL_APPROVAL_ALLOW_REPO_ACTION ||
    actionId === TOOL_APPROVAL_DENY_REPO_ACTION
  ) {
    return "repo";
  }
  return "once";
}

function approvalScopeSuffix(scope: ApprovalScope): string {
  if (scope === "run") {
    return " for this run";
  }
  if (scope === "session") {
    return " for this session";
  }
  if (scope === "repo") {
    return " for this repo";
  }
  return " once";
}

function deniedDecision(reason: string): ToolApprovalDecision {
  return {
    approved: false,
    reason,
  };
}

function readRecord(record: UnknownRecord, key: string): UnknownRecord {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function readString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function inlineCode(value: string): string {
  return value.replace(/`/gu, "'");
}

function codeFence(value: string, limit: number): string {
  const sanitized = value.replace(/```/gu, "` ` `");
  return sanitized.length <= limit
    ? sanitized
    : `${sanitized.slice(0, limit)}\n[truncated]`;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
