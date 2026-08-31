import type {
  ToolApprovalContext,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolApprovalRisk,
} from "../core/tools";
import type {
  ToolCapabilityDelta,
  ToolCapabilityKind,
  ToolCapabilityRequest,
  ToolCapabilityRequirement,
} from "../core/capabilities";
import { capabilityRequestDigest } from "../core/capabilities";
import type { ToolApprovalGate, ToolApprovalPrompter } from "../ports/tools";

export type ToolApprovalMode =
  | "read-only"
  | "workspace-write"
  | "approval-required"
  | "full-access";

export interface ToolApprovalGateOptions {
  readonly prompter?: ToolApprovalPrompter;
  readonly context?: ToolApprovalContext;
  readonly rules?: ToolApprovalRuleStore;
  readonly timeoutMs?: number;
  readonly onDecision?: (event: {
    readonly request: ToolApprovalRequest;
    readonly mode: ToolApprovalMode;
    readonly policy: ApprovalPolicy;
    readonly decision: ToolApprovalDecision;
  }) => Promise<void> | void;
}

/**
 * Runtime policy gate for automatic, denied and interactive decisions.
 */
export class PolicyToolApprovalGate implements ToolApprovalGate {
  private readonly timeoutMs: number;
  private readonly rules: ToolApprovalRuleStore;

  constructor(
    private readonly mode: ToolApprovalMode = "read-only",
    private readonly options: ToolApprovalGateOptions = {},
  ) {
    this.timeoutMs = positiveInteger(options.timeoutMs, 300000, "timeoutMs");
    this.rules = options.rules ?? createToolApprovalRuleStore();
  }

  async reviewToolCall(
    request: ToolApprovalRequest,
    signal?: AbortSignal,
  ): Promise<ToolApprovalDecision> {
    const evaluation = approvalEvaluation(
      this.mode,
      request.risk,
      request.capabilities,
    );
    const policy = evaluation.policy;
    if (policy === "allow") {
      return this.recordDecision(request, policy, { approved: true });
    }

    if (policy === "prompt") {
      const ruleKey = approvalRuleKey(this.mode, request);
      if (this.rules.denied.has(ruleKey)) {
        return this.recordDecision(request, policy, {
          approved: false,
          scope: "run",
          reason: `Tool "${request.call.name}" is denied by a run-scoped approval rule`,
        });
      }
      if (this.rules.allowed.has(ruleKey)) {
        return this.recordDecision(request, policy, {
          approved: true,
          scope: "run",
        });
      }
      if (this.options.prompter !== undefined && this.options.context !== undefined) {
        const promptRequest: ToolApprovalRequest = {
          ...request,
          ...(evaluation.escalation === undefined
            ? {}
            : { escalation: evaluation.escalation }),
          runScopeAllowed: true,
        };
        const decision = await this.options.prompter.requestToolApproval(
          {
            ...promptRequest,
            context: this.options.context,
            timeoutMs: this.timeoutMs,
          },
          signal,
        );
        if (decision.scope === "run") {
          if (decision.approved) {
            this.rules.allowed.add(ruleKey);
            this.rules.denied.delete(ruleKey);
          } else {
            this.rules.denied.add(ruleKey);
            this.rules.allowed.delete(ruleKey);
          }
        }
        return this.recordDecision(promptRequest, policy, decision);
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

export interface ToolApprovalRuleStore {
  readonly allowed: Set<string>;
  readonly denied: Set<string>;
}

const rulesByRunState = new WeakMap<object, ToolApprovalRuleStore>();

export function createToolApprovalRuleStore(): ToolApprovalRuleStore {
  return {
    allowed: new Set<string>(),
    denied: new Set<string>(),
  };
}

export function toolApprovalRulesForRun(
  runtimeState: object,
): ToolApprovalRuleStore {
  const existing = rulesByRunState.get(runtimeState);
  if (existing !== undefined) {
    return existing;
  }
  const created = createToolApprovalRuleStore();
  rulesByRunState.set(runtimeState, created);
  return created;
}

export function createToolApprovalGate(
  mode: ToolApprovalMode = "read-only",
  options: ToolApprovalGateOptions = {},
): ToolApprovalGate {
  return new PolicyToolApprovalGate(mode, options);
}

type ApprovalPolicy = "allow" | "deny" | "prompt";

interface ApprovalEvaluation {
  readonly policy: ApprovalPolicy;
  readonly escalation?: ToolCapabilityDelta;
}

function approvalEvaluation(
  mode: ToolApprovalMode,
  risk: ToolApprovalRisk,
  capabilities?: ToolCapabilityRequest,
): ApprovalEvaluation {
  if (capabilities !== undefined) {
    return capabilityApprovalEvaluation(mode, capabilities);
  }
  const normalizedRisk = normalizeRisk(risk);
  if (normalizedRisk === "read-only") {
    return { policy: "allow" };
  }

  if (mode === "full-access") {
    return { policy: "allow" };
  }

  if (mode === "approval-required") {
    return { policy: "prompt" };
  }

  if (mode === "workspace-write") {
    return { policy: normalizedRisk === "mutating" ? "allow" : "prompt" };
  }

  return { policy: "deny" };
}

function capabilityApprovalEvaluation(
  mode: ToolApprovalMode,
  request: ToolCapabilityRequest,
): ApprovalEvaluation {
  let resolved: ApprovalPolicy = "allow";
  const escalationRequirements: ToolCapabilityRequirement[] = [];
  for (const requirement of request.requirements) {
    const policy = capabilityRequirementPolicy(mode, requirement);
    if (policy === "deny") {
      return { policy: "deny" };
    }
    if (policy === "prompt") {
      resolved = "prompt";
      escalationRequirements.push(requirement);
    }
  }
  let escalatesOpenWorld = false;
  if (request.effects?.openWorld === true) {
    const policy = capabilityPolicy(mode, "network.connect");
    if (policy === "deny") {
      return { policy: "deny" };
    }
    if (policy === "prompt") {
      resolved = "prompt";
      escalatesOpenWorld = true;
    }
  }
  let escalatesDestructive = false;
  if (request.effects?.destructive === true) {
    const policy = destructiveEffectPolicy(mode);
    if (policy === "deny") {
      return { policy: "deny" };
    }
    if (policy === "prompt") {
      resolved = "prompt";
      escalatesDestructive = true;
    }
  }
  return {
    policy: resolved,
    ...(resolved !== "prompt"
      ? {}
      : {
          escalation: {
            requirements: escalationRequirements,
            ...(!escalatesOpenWorld && !escalatesDestructive
              ? {}
              : {
                  effects: {
                    ...(escalatesOpenWorld ? { openWorld: true } : {}),
                    ...(escalatesDestructive ? { destructive: true } : {}),
                  },
                }),
          },
        }),
  };
}

function approvalRuleKey(
  mode: ToolApprovalMode,
  request: ToolApprovalRequest,
): string {
  return request.capabilities === undefined
    ? `${mode}:${request.call.name}:${JSON.stringify(request.call.input)}`
    : `${mode}:${request.call.name}:${capabilityRequestDigest(request.capabilities)}`;
}

function destructiveEffectPolicy(mode: ToolApprovalMode): ApprovalPolicy {
  if (mode === "full-access") {
    return "allow";
  }
  return mode === "read-only" ? "deny" : "prompt";
}

function capabilityRequirementPolicy(
  mode: ToolApprovalMode,
  requirement: ToolCapabilityRequirement,
): ApprovalPolicy {
  if (
    requirement.capability === "runtime.control" &&
    requirement.resources.every((resource) => resource === "self-evolution:ticket")
  ) {
    return "allow";
  }
  return capabilityPolicy(mode, requirement.capability);
}

function capabilityPolicy(
  mode: ToolApprovalMode,
  capability: ToolCapabilityKind,
): ApprovalPolicy {
  if (mode === "full-access") {
    return "allow";
  }
  const readOnly = capability === "filesystem.read" || capability === "runtime.read";
  if (readOnly) {
    return "allow";
  }
  if (mode === "read-only") {
    return "deny";
  }
  if (mode === "approval-required") {
    return "prompt";
  }
  return capability === "network.connect" || capability === "external.side_effect"
    ? "prompt"
    : "allow";
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
