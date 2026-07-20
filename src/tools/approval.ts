import type {
  ToolApprovalContext,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolApprovalRisk,
} from "../core/tools";
import type { ToolApprovalGate, ToolApprovalPrompter } from "../ports/tools";

export type ToolApprovalMode =
  | "read-only"
  | "workspace-write"
  | "approval-required"
  | "full-access";

export interface ToolApprovalGateOptions {
  readonly prompter?: ToolApprovalPrompter;
  readonly context?: ToolApprovalContext;
  readonly timeoutMs?: number;
  readonly onDecision?: (event: {
    readonly request: ToolApprovalRequest;
    readonly mode: ToolApprovalMode;
    readonly policy: ApprovalPolicy;
    readonly decision: ToolApprovalDecision;
  }) => Promise<void> | void;
}

/**
 * Runtime policy gate for automatic, denied and one-shot interactive decisions.
 */
export class PolicyToolApprovalGate implements ToolApprovalGate {
  private readonly timeoutMs: number;

  constructor(
    private readonly mode: ToolApprovalMode = "read-only",
    private readonly options: ToolApprovalGateOptions = {},
  ) {
    this.timeoutMs = positiveInteger(options.timeoutMs, 300000, "timeoutMs");
  }

  async reviewToolCall(
    request: ToolApprovalRequest,
    signal?: AbortSignal,
  ): Promise<ToolApprovalDecision> {
    const policy = approvalPolicy(this.mode, request.risk);
    if (policy === "allow") {
      return this.recordDecision(request, policy, { approved: true });
    }

    if (policy === "prompt") {
      if (this.options.prompter !== undefined && this.options.context !== undefined) {
        const decision = await this.options.prompter.requestToolApproval(
          {
            ...request,
            context: this.options.context,
            timeoutMs: this.timeoutMs,
          },
          signal,
        );
        return this.recordDecision(request, policy, decision);
      }

      return this.recordDecision(request, policy, {
        approved: false,
        reason:
          `Tool "${request.call.name}" is ${request.risk} risk and requires ` +
          `interactive approval, but no approval prompter is available`,
      });
    }

    return this.recordDecision(request, policy, {
      approved: false,
      reason:
        `Tool "${request.call.name}" is ${request.risk} risk and is denied ` +
        `by TOOL_APPROVAL_MODE=${this.mode}`,
    });
  }

  private async recordDecision(
    request: ToolApprovalRequest,
    policy: ApprovalPolicy,
    decision: ToolApprovalDecision,
  ): Promise<ToolApprovalDecision> {
    await this.options.onDecision?.({
      request,
      mode: this.mode,
      policy,
      decision,
    });
    return decision;
  }
}

export function createToolApprovalGate(
  mode: ToolApprovalMode = "read-only",
  options: ToolApprovalGateOptions = {},
): ToolApprovalGate {
  return new PolicyToolApprovalGate(mode, options);
}

type ApprovalPolicy = "allow" | "deny" | "prompt";

function approvalPolicy(
  mode: ToolApprovalMode,
  risk: ToolApprovalRisk,
): ApprovalPolicy {
  const normalizedRisk = normalizeRisk(risk);
  if (normalizedRisk === "read-only") {
    return "allow";
  }

  if (mode === "full-access") {
    return "allow";
  }

  if (mode === "approval-required") {
    return "prompt";
  }

  if (mode === "workspace-write") {
    return normalizedRisk === "mutating" ? "allow" : "prompt";
  }

  return "deny";
}

function normalizeRisk(risk: ToolApprovalRisk): "read-only" | "mutating" | "external" {
  switch (risk) {
    case "low":
      return "read-only";
    case "medium":
      return "mutating";
    case "high":
      return "external";
    default:
      return risk;
  }
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${label} must be a positive integer`);
  }

  return resolved;
}
