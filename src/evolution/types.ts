import type {
  AgentRunId,
  SlackChannelId,
  SlackMessageTs,
  SlackUserId,
} from "../core/ids";

export const EVOLUTION_CHANNEL_NAME = "self-evaluation";

export type EvolutionSignalSource =
  | "slack_error"
  | "slack_user"
  | "webui_user"
  | "cli_user"
  | "runtime_error";

export type EvolutionSeverity = "info" | "warning" | "critical";

export type EvolutionScope =
  | "global_agent"
  | "profile"
  | "adapter"
  | "runtime";

export type EvolutionTarget =
  | "self_instructions"
  | "prompt"
  | "policy"
  | "skill"
  | "tool"
  | "runtime_code";

export type EvolutionRuntimeActivationTarget = Exclude<
  EvolutionTarget,
  "self_instructions"
>;

export type EvolutionTicketStatus =
  | "diagnosing"
  | "proposal_ready"
  | "waiting_for_approval"
  | "approved"
  | "rejected"
  | "applying"
  | "applied"
  | "failed"
  | "rolled_back";

export interface EvolutionSignalRunRef {
  readonly runId: AgentRunId;
  readonly channelId?: SlackChannelId;
  readonly userId?: SlackUserId;
  readonly messageTs?: SlackMessageTs;
  readonly reason?: string;
  readonly errorCode?: string;
  readonly durationMs?: number;
}

export interface EvolutionSignal {
  readonly id: string;
  readonly createdAt: string;
  readonly source: EvolutionSignalSource;
  readonly severity: EvolutionSeverity;
  readonly scope: EvolutionScope;
  readonly target: EvolutionTarget;
  readonly summary: string;
  readonly details?: string;
  readonly signature: string;
  readonly run?: EvolutionSignalRunRef;
}

export interface EvolutionValidationResult {
  readonly status: "passed" | "failed" | "not_run";
  readonly checkedAt?: string;
  readonly checks: readonly {
    readonly name: string;
    readonly passed: boolean;
    readonly message: string;
  }[];
}

export interface EvolutionProposal {
  readonly summary: string;
  readonly diagnosis: string;
  readonly versionTopic?: string;
  readonly completionTopic?: string;
  readonly proposedSelfInstructions?: string;
  readonly risk: string;
  readonly rollbackPlan: string;
  readonly validation: EvolutionValidationResult;
}

export interface EvolutionApproval {
  readonly decidedAt: string;
  readonly decidedBy: string;
  readonly approved: boolean;
  readonly note?: string;
}

export interface EvolutionRollout {
  readonly appliedAt: string;
  readonly appliedBy: string;
  readonly versionId: string;
  readonly previousVersionId?: string;
  readonly target: EvolutionTarget;
}

export interface EvolutionRuntimeActivation {
  readonly requestedAt: string;
  readonly requestedBy: string;
  readonly target: EvolutionRuntimeActivationTarget;
  readonly versionId?: string;
  readonly commandLabel?: string;
}

export interface EvolutionTimelineEvent {
  readonly ts: string;
  readonly type: string;
  readonly message: string;
  readonly actor?: string;
}

export interface EvolutionTicket {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: EvolutionTicketStatus;
  readonly title: string;
  readonly severity: EvolutionSeverity;
  readonly scope: EvolutionScope;
  readonly target: EvolutionTarget;
  readonly signature: string;
  readonly signalIds: readonly string[];
  readonly proposal: EvolutionProposal;
  readonly approval?: EvolutionApproval;
  readonly rollout?: EvolutionRollout;
  readonly activation?: EvolutionRuntimeActivation;
  readonly timeline: readonly EvolutionTimelineEvent[];
}

export interface AgentSelfVersion {
  readonly id: string;
  readonly createdAt: string;
  readonly label: string;
  readonly topic?: string;
  readonly instructions: string;
  readonly sourceTicketId?: string;
  readonly createdBy: string;
}

export interface RuntimeCodeVersion {
  readonly id: string;
  readonly number: number;
  readonly createdAt: string;
  readonly label: string;
  readonly topic?: string;
  readonly target: EvolutionRuntimeActivationTarget;
  readonly sourceTicketId: string;
  readonly createdBy: string;
  readonly changedFiles: readonly string[];
  readonly deletedFiles: readonly string[];
}

export interface ActiveRuntimeCodeVersion {
  readonly versionId: string;
  readonly activatedAt: string;
  readonly activatedBy: string;
  readonly previousVersionId?: string;
  readonly commandLabel?: string;
}

export interface EvolutionRunFailureInput {
  readonly runId: AgentRunId;
  readonly channelId?: SlackChannelId;
  readonly userId?: SlackUserId;
  readonly messageTs?: SlackMessageTs;
  readonly reason: string;
  readonly errorCode: string;
  readonly durationMs: number;
  readonly source?: EvolutionSignalSource;
  readonly adapter?: "slack" | "webui" | "cli" | "runtime";
}

export interface EvolutionSubmissionResult {
  readonly signal: EvolutionSignal;
  readonly ticket: EvolutionTicket;
  readonly ticketUrl?: string;
}

export interface EvolutionRunFailureReporter {
  reportRunFailure(
    input: EvolutionRunFailureInput,
  ): Promise<EvolutionSubmissionResult | undefined>;
}
