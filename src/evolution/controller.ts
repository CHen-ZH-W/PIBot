import type { AgentRunId } from "../core/ids";
import type { EvolutionContextRecorder } from "./channel-context";
import {
  activateRuntimeCodeVersionArchive,
  captureRuntimeCodeVersionArchive,
  runtimeCodeArchiveRequiresActivationConfirmation,
  type RuntimeCodePublishReport,
} from "./runtime-code";
import type { FileEvolutionStore, EvolutionStoreSnapshot } from "./store";
import type {
  ActiveRuntimeCodeVersion,
  AgentSelfVersion,
  EvolutionApproval,
  EvolutionProposal,
  EvolutionRollout,
  EvolutionRunFailureInput,
  EvolutionRunFailureReporter,
  EvolutionScope,
  EvolutionSeverity,
  EvolutionSignal,
  EvolutionSignalSource,
  EvolutionSubmissionResult,
  EvolutionTarget,
  EvolutionTicket,
  EvolutionTicketStatus,
  EvolutionTimelineEvent,
  EvolutionValidationResult,
  PendingRuntimeCodeActivation,
  RuntimeCodeVersion,
} from "./types";

export interface EvolutionControllerOptions {
  readonly store: FileEvolutionStore;
  readonly publicBaseUrl?: string;
  readonly defaultActor?: string;
  readonly context?: EvolutionContextRecorder;
}

export interface ManualEvolutionSignalInput {
  readonly source?: EvolutionSignalSource;
  readonly severity?: EvolutionSeverity;
  readonly scope?: EvolutionScope;
  readonly target?: EvolutionTarget;
  readonly summary: string;
  readonly details?: string;
  readonly actor?: string;
}

export interface UpdateEvolutionProposalInput {
  readonly title?: string;
  readonly summary?: string;
  readonly diagnosis?: string;
  readonly versionTopic?: string;
  readonly proposedSelfInstructions?: string;
  readonly risk?: string;
  readonly rollbackPlan?: string;
  readonly actor?: string;
}

export interface RuntimeCodeVersionActivationResult {
  readonly version: RuntimeCodeVersion;
  readonly ticket?: EvolutionTicket;
  readonly active?: ActiveRuntimeCodeVersion;
  readonly pending?: PendingRuntimeCodeActivation;
  readonly publish: RuntimeCodePublishReport;
  readonly alreadyActive: boolean;
}

export interface RuntimeCodeVersionConfirmationResult {
  readonly version?: RuntimeCodeVersion;
  readonly ticket?: EvolutionTicket;
  readonly active?: ActiveRuntimeCodeVersion;
  readonly confirmed: boolean;
}

export class EvolutionController implements EvolutionRunFailureReporter {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: EvolutionControllerOptions) {}

  async readSnapshot(): Promise<EvolutionStoreSnapshot> {
    const snapshot = await this.options.store.readSnapshot();
    return {
      ...snapshot,
      tickets: snapshot.tickets.map(refreshTicketValidation),
    };
  }

  readCurrentSelfInstructions(): Promise<string | undefined> {
    return this.options.store.readSelfInstructions();
  }

  async reportRunFailure(
    input: EvolutionRunFailureInput,
  ): Promise<EvolutionSubmissionResult | undefined> {
    if (!shouldCreateFailureSignal(input.reason, input.errorCode)) {
      return undefined;
    }
    return this.enqueue(() => this.submitRunFailureUnlocked(input));
  }

  submitManualSignal(
    input: ManualEvolutionSignalInput,
  ): Promise<EvolutionSubmissionResult> {
    return this.enqueue(() => this.submitManualSignalUnlocked(input));
  }

  updateProposal(
    ticketId: string,
    input: UpdateEvolutionProposalInput,
  ): Promise<EvolutionTicket> {
    return this.enqueue(async () => {
      const ticket = await this.requireTicket(ticketId);
      const now = new Date().toISOString();
      const proposedSelfInstructions =
        input.proposedSelfInstructions ?? ticket.proposal.proposedSelfInstructions;
      const versionTopic =
        normalizeOptionalText(input.versionTopic) ?? ticket.proposal.versionTopic;
      const proposal: EvolutionProposal = {
        summary: input.summary ?? ticket.proposal.summary,
        diagnosis: input.diagnosis ?? ticket.proposal.diagnosis,
        ...optionalString("versionTopic", versionTopic),
        ...(proposedSelfInstructions === undefined
          ? {}
          : { proposedSelfInstructions }),
        risk: input.risk ?? ticket.proposal.risk,
        rollbackPlan: input.rollbackPlan ?? ticket.proposal.rollbackPlan,
        validation: validateProposal(ticket.target, proposedSelfInstructions),
      };
      const status = statusAfterValidation(ticket.status, proposal.validation);
      const updated: EvolutionTicket = {
        ...ticket,
        title: input.title ?? ticket.title,
        status,
        proposal,
        updatedAt: now,
        timeline: [
          ...ticket.timeline,
          timeline("proposal.updated", "提案已更新。", input.actor),
        ],
      };
      await this.replaceTicket(updated);
      await this.recordContextMessage(updated.id, [
        `已更新提案 ${updated.id}：${updated.title}`,
        `主题：${proposal.versionTopic ?? updated.title}`,
        `状态：${updated.status}`,
      ].join("\n"));
      return updated;
    });
  }

  approveTicket(
    ticketId: string,
    input: {
      readonly actor?: string;
      readonly note?: string;
    },
  ): Promise<EvolutionTicket> {
    return this.enqueue(async () => {
      const ticket = await this.requireTicket(ticketId);
      const validation = validateProposal(
        ticket.target,
        ticket.proposal.proposedSelfInstructions,
      );
      if (validation.status !== "passed") {
        throw new Error("Cannot approve a proposal whose validation did not pass");
      }
      if (ticket.approval?.approved === true && ticket.status === "approved") {
        return {
          ...ticket,
          proposal: {
            ...ticket.proposal,
            validation,
          },
        };
      }
      if (ticket.status === "applying") {
        throw new Error("Cannot approve a proposal while implementation is running");
      }
      if (
        ticket.status === "applied" ||
        ticket.status === "rejected" ||
        ticket.status === "rolled_back"
      ) {
        throw new Error(`Cannot approve a ${ticket.status} proposal`);
      }
      const proposal: EvolutionProposal = {
        ...ticket.proposal,
        validation,
      };
      const approval: EvolutionApproval = {
        decidedAt: new Date().toISOString(),
        decidedBy: actor(input.actor, this.options.defaultActor),
        approved: true,
        ...(input.note === undefined ? {} : { note: input.note }),
      };
      const updated: EvolutionTicket = {
        ...ticket,
        status: "approved",
        proposal,
        approval,
        updatedAt: approval.decidedAt,
        timeline: [
          ...ticket.timeline,
          timeline("approval.approved", "提案已批准。", approval.decidedBy),
        ],
      };
      await this.replaceTicket(updated);
      await this.recordContextMessage(updated.id, [
        `已批准提案 ${updated.id}：${updated.title}`,
        `主题：${updated.proposal.versionTopic ?? updated.title}`,
        `批准人：${approval.decidedBy}`,
      ].join("\n"));
      return updated;
    });
  }

  rejectTicket(
    ticketId: string,
    input: {
      readonly actor?: string;
      readonly note?: string;
    },
  ): Promise<EvolutionTicket> {
    return this.enqueue(async () => {
      const ticket = await this.requireTicket(ticketId);
      if (ticket.approval?.approved === false && ticket.status === "rejected") {
        return ticket;
      }
      if (ticket.status === "applying") {
        throw new Error("Cannot reject a proposal while implementation is running");
      }
      if (ticket.status === "applied" || ticket.status === "rolled_back") {
        throw new Error(`Cannot reject a ${ticket.status} proposal`);
      }
      const approval: EvolutionApproval = {
        decidedAt: new Date().toISOString(),
        decidedBy: actor(input.actor, this.options.defaultActor),
        approved: false,
        ...(input.note === undefined ? {} : { note: input.note }),
      };
      const updated: EvolutionTicket = {
        ...ticket,
        status: "rejected",
        approval,
        updatedAt: approval.decidedAt,
        timeline: [
          ...ticket.timeline,
          timeline("approval.rejected", "提案已拒绝。", approval.decidedBy),
        ],
      };
      await this.replaceTicket(updated);
      await this.recordContextMessage(updated.id, [
        `已拒绝提案 ${updated.id}：${updated.title}`,
        `主题：${updated.proposal.versionTopic ?? updated.title}`,
        `拒绝人：${approval.decidedBy}`,
      ].join("\n"));
      return updated;
    });
  }

  beginImplementation(
    ticketId: string,
    input: {
      readonly actor?: string;
    },
  ): Promise<EvolutionTicket> {
    return this.enqueue(async () => {
      const ticket = await this.requireTicket(ticketId);
      if (ticket.status !== "approved" && ticket.status !== "failed") {
        throw new Error("Only approved or failed proposals can start implementation");
      }
      const updated = await this.updateTicketStatus(
        ticket,
        "applying",
        "implementation.started",
        "已启动自进化实现运行。",
        input.actor,
      );
      await this.options.store.appendAudit({
        ...timeline(
          "implementation.started",
          `已启动 ${ticket.id} 的实现。`,
          actor(input.actor, this.options.defaultActor),
        ),
        ticketId: ticket.id,
      });
      await this.recordContextMessage(updated.id, [
        `已启动实现 ${updated.id}：${updated.title}`,
        `主题：${updated.proposal.versionTopic ?? updated.title}`,
        `目标：${updated.target}`,
      ].join("\n"));
      return updated;
    });
  }

  finishImplementation(
    ticketId: string,
    input: {
      readonly actor?: string;
      readonly success: boolean;
      readonly summary?: string;
    },
  ): Promise<EvolutionTicket> {
    return this.enqueue(async () => {
      const ticket = await this.requireTicket(ticketId);
      const updated = await this.updateTicketStatus(
        ticket,
        input.success ? "applied" : "failed",
        input.success ? "implementation.completed" : "implementation.failed",
        implementationTimelineMessage(input.success, ticket.id),
        input.actor,
      );
      const topic = completionTopicFromSummary(
        input.summary,
        input.success,
      ) ?? updated.proposal.completionTopic;
      const completed: EvolutionTicket = topic === undefined
        ? updated
        : {
            ...updated,
            proposal: {
              ...updated.proposal,
              completionTopic: topic,
            },
          };
      if (completed !== updated) {
        await this.replaceTicket(completed);
      }
      await this.options.store.appendAudit({
        ...timeline(
          input.success ? "implementation.completed" : "implementation.failed",
          `${input.success ? "已完成" : "已失败"} ${ticket.id} 的实现。`,
          actor(input.actor, this.options.defaultActor),
        ),
        ticketId: ticket.id,
      });
      await this.recordContextMessage(completed.id, [
        `${input.success ? "实现已完成" : "实现已失败"} ${completed.id}：${completed.title}`,
        `主题：${evolutionTopicForTicket(completed)}`,
        ...(input.summary === undefined ? [] : [`摘要：${input.summary}`]),
      ].join("\n"));
      return completed;
    });
  }

  createRuntimeCodeVersionForTicket(
    ticketId: string,
    input: {
      readonly actor?: string;
      readonly workspaceRoot: string;
      readonly changedFiles?: readonly string[];
      readonly deletedFiles?: readonly string[];
    },
  ): Promise<EvolutionTicket> {
    return this.enqueue(async () => {
      const ticket = await this.requireTicket(ticketId);
      if (ticket.target === "self_instructions") {
        throw new Error("Self-instructions tickets use self-instruction versions");
      }
      if (ticket.status !== "applied") {
        throw new Error("Only applied runtime-code tickets can become versions");
      }
      if (ticket.rollout?.versionId !== undefined) {
        return ticket;
      }

      const versions = await this.options.store.readRuntimeVersions();
      const version = buildRuntimeCodeVersion({
        versions,
        ticket,
        createdBy: actor(input.actor, this.options.defaultActor),
        changedFiles: input.changedFiles ?? [],
        deletedFiles: input.deletedFiles ?? [],
      });
      await captureRuntimeCodeVersionArchive({
        sourceRoot: input.workspaceRoot,
        archiveRoot: this.options.store.getRuntimeCodeVersionArchiveRoot(
          version.id,
        ),
      });
      await this.options.store.writeRuntimeVersions([...versions, version]);

      const previousVersion = latestRuntimeVersion(versions);
      const rollout: EvolutionRollout = {
        appliedAt: version.createdAt,
        appliedBy: version.createdBy,
        versionId: version.id,
        ...(previousVersion === undefined
          ? {}
          : { previousVersionId: previousVersion.id }),
        target: ticket.target,
      };
      const updated: EvolutionTicket = {
        ...ticket,
        rollout,
        updatedAt: version.createdAt,
        timeline: [
          ...ticket.timeline,
          timeline(
            "runtime_version.created",
            `已创建运行时代码版本 ${runtimeVersionName(version)}。`,
            version.createdBy,
          ),
        ],
      };
      await this.replaceTicket(updated);
      await this.options.store.appendAudit({
        ...timeline(
          "runtime_code.version_created",
          `已从 ${ticket.id} 创建 ${runtimeVersionName(version)}。`,
          version.createdBy,
        ),
        ticketId: ticket.id,
      });
      await this.recordContextMessage(updated.id, [
        `已创建运行时代码版本：${runtimeVersionName(version)}`,
        `主题：${version.topic ?? version.label}`,
        `工单：${ticket.id}`,
        `创建人：${version.createdBy}`,
      ].join("\n"));
      return updated;
    });
  }

  createSelfInstructionsVersionForTicket(
    ticketId: string,
    input: {
      readonly actor?: string;
      readonly instructions: string;
    },
  ): Promise<EvolutionTicket> {
    return this.enqueue(async () => {
      const ticket = await this.requireTicket(ticketId);
      if (ticket.target !== "self_instructions") {
        throw new Error(`${ticket.target} tickets use runtime version snapshots`);
      }
      if (ticket.status !== "applied") {
        throw new Error("Only applied self-instructions tickets can become versions");
      }
      if (ticket.rollout?.versionId !== undefined) {
        return ticket;
      }
      const instructions = input.instructions.trim();
      if (instructions.length === 0) {
        throw new Error("Self-instructions implementation produced an empty file");
      }

      const previousVersion = latestVersion(await this.options.store.readSelfVersions());
      const versionTopic = evolutionTopicForTicket(ticket);
      const version = await this.options.store.writeSelfInstructionsVersion({
        instructions: `${instructions}\n`,
        label: ticket.title,
        topic: versionTopic,
        createdBy: actor(input.actor, this.options.defaultActor),
        sourceTicketId: ticket.id,
      });
      const rollout: EvolutionRollout = {
        appliedAt: version.createdAt,
        appliedBy: version.createdBy,
        versionId: version.id,
        ...(previousVersion === undefined
          ? {}
          : { previousVersionId: previousVersion.id }),
        target: "self_instructions",
      };
      const updated: EvolutionTicket = {
        ...ticket,
        rollout,
        updatedAt: version.createdAt,
        timeline: [
          ...ticket.timeline,
          timeline(
            "self_instructions.version_created",
            `已创建自定义指令版本 ${version.id}。`,
            version.createdBy,
          ),
        ],
      };
      await this.replaceTicket(updated);
      await this.options.store.appendAudit({
        ...timeline(
          "self_instructions.version_created",
          `已从 ${ticket.id} 创建 ${version.id}。`,
          version.createdBy,
        ),
        ticketId: ticket.id,
      });
      await this.recordContextMessage(updated.id, [
        `已创建自定义指令版本：${version.id}`,
        `主题：${version.topic ?? version.label}`,
        `工单：${ticket.id}`,
        `创建人：${version.createdBy}`,
      ].join("\n"));
      return updated;
    });
  }

  applyTicket(
    ticketId: string,
    input: {
      readonly actor?: string;
    },
  ): Promise<EvolutionTicket> {
    return this.enqueue(async () => {
      const ticket = await this.requireTicket(ticketId);
      if (ticket.status !== "approved") {
        throw new Error("Only approved proposals can be applied");
      }
      if (ticket.target !== "self_instructions") {
        throw new Error(`Applying ${ticket.target} is not implemented yet`);
      }
      const instructions = ticket.proposal.proposedSelfInstructions;
      if (instructions === undefined || instructions.trim().length === 0) {
        throw new Error("Proposal does not contain self instructions");
      }

      const applying = await this.updateTicketStatus(
        ticket,
        "applying",
        "rollout.started",
        "正在应用自定义指令版本。",
        input.actor,
      );
      const previousVersion = latestVersion(await this.options.store.readSelfVersions());
      const versionTopic = applying.proposal.versionTopic ?? applying.title;
      const version = await this.options.store.writeSelfInstructionsVersion({
        instructions,
        label: applying.title,
        topic: versionTopic,
        createdBy: actor(input.actor, this.options.defaultActor),
        sourceTicketId: applying.id,
      });
      const rollout: EvolutionRollout = {
        appliedAt: version.createdAt,
        appliedBy: version.createdBy,
        versionId: version.id,
        ...(previousVersion === undefined
          ? {}
          : { previousVersionId: previousVersion.id }),
        target: "self_instructions",
      };
      const updated: EvolutionTicket = {
        ...applying,
        status: "applied",
        proposal: {
          ...applying.proposal,
          completionTopic: `已应用自定义指令：${versionTopic}`,
        },
        rollout,
        updatedAt: version.createdAt,
        timeline: [
          ...applying.timeline,
          timeline(
            "rollout.applied",
            `已应用自定义指令版本 ${version.id}。`,
            version.createdBy,
          ),
        ],
      };
      await this.replaceTicket(updated);
      await this.options.store.appendAudit({
        ...timeline(
          "self_instructions.version_created",
          `已从 ${ticket.id} 创建 ${version.id}。`,
          version.createdBy,
        ),
        ticketId: ticket.id,
      });
      await this.recordContextMessage(updated.id, [
        `已应用自定义指令版本：${version.id}`,
        `主题：${evolutionTopicForTicket(updated)}`,
        `工单：${ticket.id}`,
        `应用人：${version.createdBy}`,
      ].join("\n"));
      return updated;
    });
  }

  requestRuntimeCodeActivation(
    ticketId: string,
    input: {
      readonly actor?: string;
      readonly commandLabel?: string;
      readonly workspaceRoot?: string;
    },
  ): Promise<EvolutionTicket> {
    return this.enqueue(async () => {
      const ticket = await this.requireTicket(ticketId);
      if (ticket.target === "self_instructions") {
        throw new Error("Self-instructions tickets do not require runtime activation");
      }
      if (ticket.status !== "applied") {
        throw new Error("Only applied self-evolution tickets can request runtime activation");
      }
      if (
        input.workspaceRoot !== undefined &&
        ticket.rollout?.versionId !== undefined
      ) {
        const result = await this.activateRuntimeCodeVersionUnlocked(
          ticket.rollout.versionId,
          {
            workspaceRoot: input.workspaceRoot,
            ...optionalString("actor", input.actor),
            ...optionalString("commandLabel", input.commandLabel),
          },
          ticket,
        );
        if (result.ticket === undefined) {
          throw new Error(`Runtime version ${ticket.rollout.versionId} has no source ticket`);
        }
        return result.ticket;
      }
      const requestedBy = actor(input.actor, this.options.defaultActor);
      const requestedAt = new Date().toISOString();
      const detail = input.commandLabel === undefined
        ? "已请求重启运行时以启用已发布代码。"
        : `已通过 ${input.commandLabel} 请求重启运行时。`;
      const updated: EvolutionTicket = {
        ...ticket,
        activation: {
          requestedAt,
          requestedBy,
          target: ticket.target,
          ...optionalString("versionId", ticket.rollout?.versionId),
          ...optionalString("commandLabel", input.commandLabel),
        },
        updatedAt: requestedAt,
        timeline: [
          ...ticket.timeline,
          timeline("runtime_activation.requested", detail, requestedBy),
        ],
      };
      await this.replaceTicket(updated);
      await this.options.store.appendAudit({
        ...timeline(
          "runtime_activation.requested",
          `已请求启用 ${ticket.id} 的运行时版本。`,
          requestedBy,
        ),
        ticketId: ticket.id,
      });
      await this.recordContextMessage(updated.id, [
        `已请求启用运行时版本 ${updated.id}：${updated.title}`,
        `主题：${evolutionTopicForTicket(updated)}`,
        `请求人：${requestedBy}`,
        ...(input.commandLabel === undefined ? [] : [`重启命令：${input.commandLabel}`]),
      ].join("\n"));
      return updated;
    });
  }

  activateRuntimeCodeVersionForTicket(
    ticketId: string,
    input: {
      readonly actor?: string;
      readonly commandLabel?: string;
      readonly workspaceRoot: string;
    },
  ): Promise<RuntimeCodeVersionActivationResult> {
    return this.enqueue(async () => {
      const ticket = await this.requireTicket(ticketId);
      if (ticket.target === "self_instructions") {
        throw new Error("Self-instructions tickets do not require runtime activation");
      }
      if (ticket.status !== "applied") {
        throw new Error("Only applied self-evolution tickets can activate runtime versions");
      }
      if (ticket.rollout?.versionId === undefined) {
        throw new Error("This ticket does not have a selectable runtime version");
      }
      return this.activateRuntimeCodeVersionUnlocked(
        ticket.rollout.versionId,
        input,
        ticket,
      );
    });
  }

  activateRuntimeCodeVersion(
    versionId: string,
    input: {
      readonly actor?: string;
      readonly commandLabel?: string;
      readonly confirmPending?: boolean;
      readonly workspaceRoot: string;
    },
  ): Promise<RuntimeCodeVersionActivationResult> {
    return this.enqueue(() =>
      this.activateRuntimeCodeVersionUnlocked(versionId, input)
    );
  }

  confirmPendingRuntimeActivation(input: {
    readonly actor?: string;
    readonly versionId?: string;
  }): Promise<ActiveRuntimeCodeVersion | undefined> {
    return this.enqueue(async () => {
      const result = await this.confirmPendingRuntimeActivationUnlocked(input);
      return result.active;
    });
  }

  confirmRuntimeCodeVersion(
    versionId: string,
    input: {
      readonly actor?: string;
    },
  ): Promise<RuntimeCodeVersionConfirmationResult> {
    return this.enqueue(() =>
      this.confirmPendingRuntimeActivationUnlocked({
        ...input,
        versionId,
      })
    );
  }

  rollbackSelfInstructions(input: {
    readonly versionId: string;
    readonly actor?: string;
    readonly note?: string;
  }): Promise<AgentSelfVersion> {
    return this.enqueue(async () => {
      const versions = await this.options.store.readSelfVersions();
      const target = versions.find((version) => version.id === input.versionId);
      if (target === undefined) {
        throw new Error(`Unknown self-instructions version: ${input.versionId}`);
      }
      const version = await this.options.store.writeSelfInstructionsVersion({
        instructions: target.instructions,
        label: `回滚到 ${target.id}`,
        topic: `回滚：${target.topic ?? target.label}`,
        createdBy: actor(input.actor, this.options.defaultActor),
      });
      await this.options.store.appendAudit({
        ...timeline(
          "self_instructions.rolled_back",
          input.note === undefined
            ? `已回滚到 ${target.id}。`
            : `已回滚到 ${target.id}。${input.note}`,
          version.createdBy,
        ),
      });
      await this.recordContextMessage(undefined, [
        `已应用自定义指令回滚：${version.id}`,
        `主题：${version.topic ?? version.label}`,
        `回滚到：${target.id}`,
        `应用人：${version.createdBy}`,
      ].join("\n"));
      return version;
    });
  }

  deleteTicket(
    ticketId: string,
    input: {
      readonly actor?: string;
    },
  ): Promise<{ deleted: boolean; ticketId: string }> {
    return this.enqueue(async () => {
      const tickets = await this.options.store.readTickets();
      const ticket = tickets.find((candidate) => candidate.id === ticketId);
      if (ticket === undefined) {
        throw new Error(`Unknown evolution ticket: ${ticketId}`);
      }
      if (ticket.status === "applying") {
        throw new Error(
          "Cannot delete a ticket while its implementation is running",
        );
      }
      const active = await this.options.store.readActiveRuntimeVersion();
      const pending = await this.options.store.readPendingRuntimeActivation();
      const versionId = ticket.rollout?.versionId;
      if (versionId !== undefined) {
        if (active?.versionId === versionId) {
          throw new Error(
            "Cannot delete this ticket because its runtime version is active",
          );
        }
        if (pending?.versionId === versionId) {
          throw new Error(
            "Cannot delete this ticket because its runtime version is pending activation",
          );
        }
        const deletedVersion =
          ticket.target === "self_instructions"
            ? await this.options.store.deleteSelfVersion(versionId)
            : await this.options.store.deleteRuntimeVersion(versionId);
        if (deletedVersion) {
          await this.options.store.appendAudit({
            ...timeline(
              "runtime_version.deleted",
              `已级联删除 ${ticket.id} 关联的版本 ${versionId}。`,
              actor(input.actor, this.options.defaultActor),
            ),
            ticketId: ticket.id,
          });
        }
      }
      await this.options.store.deleteTicket(ticketId);
      const deletedBy = actor(input.actor, this.options.defaultActor);
      await this.options.store.appendAudit({
        ...timeline(
          "ticket.deleted",
          `已删除工单 ${ticketId}：${ticket.title}。`,
          deletedBy,
        ),
        ticketId,
      });
      if (this.options.context !== undefined) {
        try {
          await this.options.context.deleteEvolutionContext(ticketId);
        } catch {
          // best-effort cleanup of ticket context storage
        }
      }
      return { deleted: true, ticketId };
    });
  }

  deleteRuntimeVersion(
    versionId: string,
    input: {
      readonly actor?: string;
    },
  ): Promise<{ deleted: boolean; versionId: string }> {
    return this.enqueue(async () => {
      const versions = await this.options.store.readRuntimeVersions();
      const version = versions.find((candidate) => candidate.id === versionId);
      if (version === undefined) {
        throw new Error(`Unknown runtime code version: ${versionId}`);
      }
      const active = await this.options.store.readActiveRuntimeVersion();
      const pending = await this.options.store.readPendingRuntimeActivation();
      if (active?.versionId === versionId) {
        throw new Error("Cannot delete the active runtime version");
      }
      if (pending?.versionId === versionId) {
        throw new Error(
          "Cannot delete a pending runtime version; confirm or cancel it first",
        );
      }
      await this.options.store.deleteRuntimeVersion(versionId);
      await this.detachTicketVersionReferences(versionId);
      await this.options.store.appendAudit({
        ...timeline(
          "runtime_code.version_deleted",
          `已删除运行时代码版本 ${runtimeVersionName(version)}。`,
          actor(input.actor, this.options.defaultActor),
        ),
        ...(version.sourceTicketId === undefined
          ? {}
          : { ticketId: version.sourceTicketId }),
      });
      return { deleted: true, versionId };
    });
  }

  deleteSelfVersion(
    versionId: string,
    input: {
      readonly actor?: string;
    },
  ): Promise<{ deleted: boolean; versionId: string }> {
    return this.enqueue(async () => {
      const versions = await this.options.store.readSelfVersions();
      const version = versions.find((candidate) => candidate.id === versionId);
      if (version === undefined) {
        throw new Error(`Unknown self-instructions version: ${versionId}`);
      }
      await this.options.store.deleteSelfVersion(versionId);
      await this.detachTicketVersionReferences(versionId);
      await this.options.store.appendAudit({
        ...timeline(
          "self_instructions.version_deleted",
          `已删除自定义指令版本 ${version.id}。`,
          actor(input.actor, this.options.defaultActor),
        ),
        ...(version.sourceTicketId === undefined
          ? {}
          : { ticketId: version.sourceTicketId }),
      });
      return { deleted: true, versionId };
    });
  }

  private async detachTicketVersionReferences(versionId: string): Promise<void> {
    const tickets = await this.options.store.readTickets();
    const affected = tickets.filter(
      (ticket) => ticket.rollout?.versionId === versionId,
    );
    if (affected.length === 0) {
      return;
    }
    const updatedAt = new Date().toISOString();
    await this.options.store.writeTickets(tickets.map((ticket) =>
      ticket.rollout?.versionId === versionId
        ? omitTicketRollout(ticket, {
            updatedAt,
            timeline: [
              ...ticket.timeline,
              timeline(
                "runtime_version.deleted",
                `已删除关联版本 ${versionId}，移除了该工单的版本引用。`,
              ),
            ],
          })
        : ticket,
    ));
  }

  ticketUrl(ticketId: string): string | undefined {
    if (this.options.publicBaseUrl === undefined) {
      return undefined;
    }
    return `${this.options.publicBaseUrl.replace(/\/+$/u, "")}/#ticket=${encodeURIComponent(ticketId)}`;
  }

  private async submitRunFailureUnlocked(
    input: EvolutionRunFailureInput,
  ): Promise<EvolutionSubmissionResult> {
    const summary = `运行 ${input.runId} 以 ${input.errorCode} 结束`;
    const source = input.source ?? (
      input.adapter === undefined || input.adapter === "slack"
        ? "slack_error"
        : "runtime_error"
    );
    const surface = surfaceLabel(input.adapter, source);
    const signal = createSignal(this.options.store.newId("sig"), {
      source,
      severity: severityForError(input.errorCode),
      scope: "global_agent",
      target: "self_instructions",
      summary,
      details:
        `${surface} 运行失败：reason=${input.reason}, errorCode=${input.errorCode}。` +
        "请评估 pibot 是否需要调整自身提示词、策略、工具或运行时行为。",
      signature: signatureFor("global_agent", "self_instructions", input.errorCode),
      run: {
        runId: input.runId,
        ...(input.channelId === undefined ? {} : { channelId: input.channelId }),
        ...(input.userId === undefined ? {} : { userId: input.userId }),
        ...(input.messageTs === undefined ? {} : { messageTs: input.messageTs }),
        reason: input.reason,
        errorCode: input.errorCode,
        durationMs: input.durationMs,
      },
    });
    return this.appendSignalAndTicket(signal);
  }

  private async submitManualSignalUnlocked(
    input: ManualEvolutionSignalInput,
  ): Promise<EvolutionSubmissionResult> {
    const inferenceText = [input.summary, input.details]
      .filter((value): value is string => value !== undefined)
      .join("\n");
    const target = input.target ?? inferManualEvolutionTarget(inferenceText);
    const scope = input.scope ?? inferManualEvolutionScope(inferenceText, target);
    const signal = createSignal(this.options.store.newId("sig"), {
      source: input.source ?? "webui_user",
      severity: input.severity ?? "warning",
      scope,
      target,
      summary: input.summary,
      ...(input.details === undefined ? {} : { details: input.details }),
      signature: signatureFor(scope, target, normalizeSignaturePart(input.summary)),
    });
    return this.appendSignalAndTicket(signal);
  }

  private async appendSignalAndTicket(
    signal: EvolutionSignal,
  ): Promise<EvolutionSubmissionResult> {
    await this.options.store.appendSignal(signal);
    const ticket = await this.createOrUpdateTicketForSignal(signal);
    await this.options.store.appendAudit({
      ...timeline("signal.recorded", `已记录信号 ${signal.id}。`),
      ticketId: ticket.id,
    });
    await this.recordContextMessage(ticket.id, contextMessageForSignal(signal, ticket));
    return {
      signal,
      ticket,
      ...optionalString("ticketUrl", this.ticketUrl(ticket.id)),
    };
  }

  private async createOrUpdateTicketForSignal(
    signal: EvolutionSignal,
  ): Promise<EvolutionTicket> {
    const tickets = await this.options.store.readTickets();
    const existing = tickets.find((ticket) =>
      ticket.signature === signal.signature &&
      !terminalStatus(ticket.status)
    );
    if (existing !== undefined) {
      const updated: EvolutionTicket = {
        ...existing,
        severity: maxSeverity(existing.severity, signal.severity),
        signalIds: unique([...existing.signalIds, signal.id]),
        updatedAt: signal.createdAt,
        timeline: [
          ...existing.timeline,
          timeline(
            "signal.linked",
            `已关联 ${signal.source} 信号 ${signal.id}。`,
          ),
        ],
      };
      await this.options.store.writeTickets(replaceById(tickets, updated));
      return updated;
    }

    const proposal = await this.buildDefaultProposal(signal);
    const ticket: EvolutionTicket = {
      id: this.options.store.newId("evo"),
      createdAt: signal.createdAt,
      updatedAt: signal.createdAt,
      status: statusAfterValidation("proposal_ready", proposal.validation),
      title: titleForSignal(signal),
      severity: signal.severity,
      scope: signal.scope,
      target: signal.target,
      signature: signal.signature,
      signalIds: [signal.id],
      proposal,
      timeline: [
        timeline("ticket.created", `已由信号 ${signal.id} 创建。`),
        timeline("proposal.created", "已生成初始提案。"),
      ],
    };
    await this.options.store.writeTickets([...tickets, ticket]);
    return ticket;
  }

  private async buildDefaultProposal(
    signal: EvolutionSignal,
  ): Promise<EvolutionProposal> {
    const currentInstructions = await this.options.store.readSelfInstructions();
    const proposedSelfInstructions =
      signal.target === "self_instructions"
        ? mergeSelfInstructionSection(currentInstructions, signal)
        : undefined;
    return {
      summary: proposalSummaryForSignal(signal),
      diagnosis: diagnosisForSignal(signal),
      versionTopic: versionTopicForSignal(signal),
      ...(proposedSelfInstructions === undefined
        ? {}
        : { proposedSelfInstructions }),
      risk: proposalRiskForSignal(signal),
      rollbackPlan: rollbackPlanForSignal(signal),
      validation: validateProposal(signal.target, proposedSelfInstructions),
    };
  }

  private async requireTicket(ticketId: string): Promise<EvolutionTicket> {
    const ticket = (await this.options.store.readTickets()).find(
      (candidate) => candidate.id === ticketId,
    );
    if (ticket === undefined) {
      throw new Error(`Unknown evolution ticket: ${ticketId}`);
    }
    return ticket;
  }

  private async replaceTicket(ticket: EvolutionTicket): Promise<void> {
    const tickets = await this.options.store.readTickets();
    await this.options.store.writeTickets(replaceById(tickets, ticket));
  }

  private async updateTicketStatus(
    ticket: EvolutionTicket,
    status: EvolutionTicketStatus,
    eventType: string,
    message: string,
    eventActor: string | undefined,
  ): Promise<EvolutionTicket> {
    const updated: EvolutionTicket = {
      ...ticket,
      status,
      updatedAt: new Date().toISOString(),
      timeline: [
        ...ticket.timeline,
        timeline(eventType, message, eventActor),
      ],
    };
    await this.replaceTicket(updated);
    return updated;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async recordContextMessage(
    ticketId: string | undefined,
    content: string,
  ): Promise<void> {
    if (this.options.context === undefined) {
      return;
    }
    try {
      await this.options.context.appendEvolutionContextMessage({
        role: "assistant",
        content,
        ...(ticketId === undefined ? {} : { ticketId }),
      });
    } catch {
      return;
    }
  }

  private async activateRuntimeCodeVersionUnlocked(
    versionId: string,
    input: {
      readonly actor?: string;
      readonly commandLabel?: string;
      readonly confirmPending?: boolean;
      readonly workspaceRoot: string;
    },
    sourceTicket?: EvolutionTicket,
  ): Promise<RuntimeCodeVersionActivationResult> {
    const versions = await this.options.store.readRuntimeVersions();
    const version = versions.find((candidate) => candidate.id === versionId);
    if (version === undefined) {
      throw new Error(`Unknown runtime code version: ${versionId}`);
    }
    const tickets = await this.options.store.readTickets();
    const ticket = sourceTicket ??
      tickets.find((candidate) => candidate.id === version.sourceTicketId);
    const currentActive = await this.options.store.readActiveRuntimeVersion();
    const currentPending = await this.options.store.readPendingRuntimeActivation();
    const emptyPublish: RuntimeCodePublishReport = {
      changedFiles: [],
      deletedFiles: [],
      conflicts: [],
    };
    if (currentActive?.versionId === version.id) {
      if (currentPending !== undefined) {
        const publish = await activateRuntimeCodeVersionArchive({
          archiveRoot: this.options.store.getRuntimeCodeVersionArchiveRoot(version.id),
          destinationRoot: input.workspaceRoot,
          currentActiveArchiveRoot:
            this.options.store.getRuntimeCodeVersionArchiveRoot(
              currentPending.versionId,
            ),
        });
        if (publish.conflicts.length > 0) {
          throw new Error(
            `Cannot restore ${runtimeVersionName(version)} because runtime files changed since the pending trial version: ${publish.conflicts.join(", ")}`,
          );
        }
        await this.options.store.clearPendingRuntimeActivation();
        const restoredBy = actor(input.actor, this.options.defaultActor);
        await this.options.store.appendAudit({
          ...timeline(
            "runtime_code.version_trial_cancelled",
            `已取消未确认试运行 ${currentPending.versionId}，恢复 ${runtimeVersionName(version)}。`,
            restoredBy,
          ),
          ...(ticket === undefined ? {} : { ticketId: ticket.id }),
        });
        return {
          version,
          ...(ticket === undefined ? {} : { ticket }),
          active: currentActive,
          publish,
          alreadyActive: false,
        };
      }
      return {
        version,
        ...(ticket === undefined ? {} : { ticket }),
        active: currentActive,
        publish: emptyPublish,
        alreadyActive: true,
      };
    }
    if (currentPending?.versionId === version.id) {
      if (input.confirmPending === true) {
        const confirmed = await this.confirmPendingRuntimeActivationUnlocked({
          ...(input.actor === undefined ? {} : { actor: input.actor }),
          versionId: version.id,
        });
        return {
          version,
          ...(confirmed.ticket === undefined ? {} : { ticket: confirmed.ticket }),
          ...(confirmed.active === undefined ? {} : { active: confirmed.active }),
          publish: emptyPublish,
          alreadyActive: true,
        };
      }
      return {
        version,
        ...(ticket === undefined ? {} : { ticket }),
        ...(currentActive === undefined ? {} : { active: currentActive }),
        pending: currentPending,
        publish: emptyPublish,
        alreadyActive: true,
      };
    }

    const archiveRoot = this.options.store.getRuntimeCodeVersionArchiveRoot(
      version.id,
    );
    await this.requireConfirmationCapableRuntimeArchive(version, archiveRoot);

    const publish = await activateRuntimeCodeVersionArchive({
      archiveRoot,
      destinationRoot: input.workspaceRoot,
      ...(currentActive === undefined
        ? {}
        : {
            currentActiveArchiveRoot:
              this.options.store.getRuntimeCodeVersionArchiveRoot(
                currentActive.versionId,
              ),
          }),
    });
    if (publish.conflicts.length > 0) {
      throw new Error(
        `Cannot activate ${runtimeVersionName(version)} because runtime files changed since the active version: ${publish.conflicts.join(", ")}`,
      );
    }

    const activatedBy = actor(input.actor, this.options.defaultActor);
    const pending: PendingRuntimeCodeActivation = {
      versionId: version.id,
      activatedAt: new Date().toISOString(),
      activatedBy,
      confirmationRequired: true,
      ...(currentActive === undefined
        ? {}
        : { previousVersionId: currentActive.versionId }),
      ...optionalString("commandLabel", input.commandLabel),
    };
    await this.options.store.writePendingRuntimeActivation(pending);

    const updatedTicket = ticket === undefined
      ? undefined
      : await this.markRuntimeVersionActivated(ticket, version, pending);
    await this.options.store.appendAudit({
      ...timeline(
        "runtime_code.version_trial_started",
        `已试运行 ${runtimeVersionName(version)}，等待确认后才会成为默认版本。`,
        activatedBy,
      ),
      ...(updatedTicket === undefined ? {} : { ticketId: updatedTicket.id }),
    });
    await this.recordContextMessage(updatedTicket?.id, [
      `已试运行运行时代码版本：${runtimeVersionName(version)}`,
      `主题：${version.topic ?? version.label}`,
      `试运行人：${activatedBy}`,
      "确认前重启会恢复到上一确认版本。",
      ...(pending.previousVersionId === undefined
        ? []
        : [`上一确认版本：${pending.previousVersionId}`]),
      ...(input.commandLabel === undefined
        ? []
        : [`应用命令：${input.commandLabel}`]),
    ].join("\n"));

    return {
      version,
      ...(updatedTicket === undefined ? {} : { ticket: updatedTicket }),
      ...(currentActive === undefined ? {} : { active: currentActive }),
      pending,
      publish,
      alreadyActive: false,
    };
  }

  private async requireConfirmationCapableRuntimeArchive(
    version: RuntimeCodeVersion,
    archiveRoot: string,
  ): Promise<void> {
    if (await runtimeCodeArchiveRequiresActivationConfirmation(archiveRoot)) {
      return;
    }
    throw new Error(
      `Cannot activate ${runtimeVersionName(version)} through normal WebUI activation because its archive predates the required pending confirmation protocol. Use scripts/rollback-runtime-version.js for an intentional emergency rollback.`,
    );
  }

  private async confirmPendingRuntimeActivationUnlocked(input: {
    readonly actor?: string;
    readonly versionId?: string;
  }): Promise<RuntimeCodeVersionConfirmationResult> {
    const pending = await this.options.store.readPendingRuntimeActivation();
    const versions = await this.options.store.readRuntimeVersions();
    const version = pending === undefined
      ? undefined
      : versions.find((candidate) => candidate.id === pending.versionId);
    if (input.versionId !== undefined) {
      if (pending === undefined || pending.versionId !== input.versionId) {
        throw new Error(`Runtime code version is not pending confirmation: ${input.versionId}`);
      }
    }
    if (pending === undefined) {
      return { confirmed: false };
    }
    if (version === undefined) {
      throw new Error(`Unknown runtime code version: ${pending.versionId}`);
    }

    const tickets = await this.options.store.readTickets();
    const ticket = tickets.find((candidate) =>
      candidate.id === version.sourceTicketId
    );
    const confirmedBy = actor(input.actor, this.options.defaultActor);
    const active = await this.options.store.confirmPendingRuntimeActivation({
      actor: confirmedBy,
    });
    if (active === undefined) {
      return { version, ...(ticket === undefined ? {} : { ticket }), confirmed: false };
    }

    await this.options.store.appendAudit({
      ...timeline(
        "runtime_code.version_confirmed",
        `已确认 ${runtimeVersionName(version)} 作为默认运行时版本。`,
        confirmedBy,
      ),
      ...(ticket === undefined ? {} : { ticketId: ticket.id }),
    });
    await this.recordContextMessage(ticket?.id, [
      `已确认运行时代码版本：${runtimeVersionName(version)}`,
      `确认人：${confirmedBy}`,
      ...(active.previousVersionId === undefined
        ? []
        : [`上一确认版本：${active.previousVersionId}`]),
    ].join("\n"));
    return { version, ...(ticket === undefined ? {} : { ticket }), active, confirmed: true };
  }

  private async markRuntimeVersionActivated(
    ticket: EvolutionTicket,
    version: RuntimeCodeVersion,
    active: ActiveRuntimeCodeVersion,
  ): Promise<EvolutionTicket> {
    const updated: EvolutionTicket = {
      ...ticket,
      activation: {
        requestedAt: active.activatedAt,
        requestedBy: active.activatedBy,
        target: version.target,
        versionId: version.id,
        ...optionalString("commandLabel", active.commandLabel),
      },
      updatedAt: active.activatedAt,
      timeline: [
        ...ticket.timeline,
        timeline(
          "runtime_version.trial_started",
          `已试运行 ${runtimeVersionName(version)}，确认前不会覆盖默认运行时版本。`,
          active.activatedBy,
        ),
      ],
    };
    await this.replaceTicket(updated);
    return updated;
  }
}

function createSignal(
  id: string,
  input: Omit<EvolutionSignal, "id" | "createdAt">,
): EvolutionSignal {
  return {
    id,
    createdAt: new Date().toISOString(),
    ...input,
  };
}

function shouldCreateFailureSignal(reason: string, errorCode: string): boolean {
  if (reason === "cancelled" || errorCode === "aborted") {
    return false;
  }
  return errorCode.trim().length > 0;
}

function severityForError(errorCode: string): EvolutionSeverity {
  if (
    errorCode === "max_steps_exceeded" ||
    errorCode === "context_overflow" ||
    errorCode === "tool_execution_failed"
  ) {
    return "critical";
  }
  return "warning";
}

function surfaceLabel(
  adapter: EvolutionRunFailureInput["adapter"] | undefined,
  source: EvolutionSignalSource,
): string {
  if (adapter === "webui" || source === "webui_user") {
    return "WebUI";
  }
  if (adapter === "cli" || source === "cli_user") {
    return "CLI";
  }
  if (adapter === "runtime" || source === "runtime_error") {
    return "Runtime";
  }
  return "Slack";
}

function inferManualEvolutionScope(
  text: string,
  target: EvolutionTarget,
): EvolutionScope {
  if (/工单|ticket/iu.test(text)) {
    return "runtime";
  }
  if (/\bweb\s?ui\b|webui|slack|channel|adapter|会话|频道/iu.test(text)) {
    return "adapter";
  }
  if (
    target === "runtime_code" ||
    /runtime|运行时|sandbox|沙箱|tool|工具|工单|ticket|approval|审批|权限|边界|越界|版本|version|回退|rollback|activate|启用|自进化链路|agent[-\s]?evolution|self[-\s]?evaluation/iu.test(
      text,
    )
  ) {
    return "runtime";
  }
  return "global_agent";
}

function inferManualEvolutionTarget(text: string): EvolutionTarget {
  if (/prompt|提示词|system prompt/iu.test(text)) {
    return "prompt";
  }
  if (
    /runtime[_\s-]?code|源码|代码|web\s?ui|webui|server|删除|残留|sandbox|沙箱|tool|工具|工单|ticket|bash|channel|频道|显示|界面|页面|按钮|timeline|时间线|topic|版本|version|回退|rollback|样式|布局|换行|交互|体验|刷新|重启|启用|activate|自进化链路|agent[-\s]?evolution|self[-\s]?evaluation|命名|重命名|名字|名称|rename|label|title/iu.test(
      text,
    )
  ) {
    return "runtime_code";
  }
  if (/policy|策略|审批|approval|权限|边界|越界|工作区之外/iu.test(text)) {
    return "policy";
  }
  return "self_instructions";
}

function titleForSignal(signal: EvolutionSignal): string {
  if (signal.run?.errorCode !== undefined) {
    return `改进 ${signal.run.errorCode} 的处理`;
  }
  return signal.summary.length <= 25
    ? signal.summary
    : `${signal.summary.slice(0, 22)}...`;
}

function versionTopicForSignal(signal: EvolutionSignal): string {
  if (signal.run?.errorCode !== undefined) {
    return `${signal.target}: ${signal.run.errorCode}`;
  }
  return `${signal.target}: ${titleForSignal(signal)}`;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function evolutionTopicForTicket(ticket: EvolutionTicket): string {
  return ticket.proposal.completionTopic ??
    ticket.proposal.versionTopic ??
    ticket.title;
}

function completionTopicFromSummary(
  summary: string | undefined,
  success: boolean,
): string | undefined {
  const firstLine = summary
    ?.split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) {
    return undefined;
  }
  const normalized = firstLine
    .replace(/^[-*]\s+/u, "")
    .replace(/^#+\s+/u, "")
    .replace(/^Summary:\s*/iu, "")
    .replace(/^摘要：\s*/u, "")
    .trim();
  if (normalized.length === 0) {
    return undefined;
  }
  const prefix = success ? "已完成：" : "已失败：";
  return `${prefix}${truncateTopic(normalized, 180)}`;
}

function implementationTimelineMessage(success: boolean, ticketId: string): string {
  return `${success ? "已完成" : "已失败"} ${ticketId} 的实现。`;
}

function truncateTopic(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function contextMessageForSignal(
  signal: EvolutionSignal,
  ticket: EvolutionTicket,
): string {
  return [
    `已记录自进化信号：${signal.summary}`,
    `工单：${ticket.id}（${ticket.status}）`,
    `主题：${ticket.proposal.versionTopic ?? ticket.title}`,
    `来源：${signal.source}`,
    `范围/目标：${signal.scope}/${signal.target}`,
    ...(signal.details === undefined ? [] : [`详情：${signal.details}`]),
  ].join("\n");
}

function diagnosisForSignal(signal: EvolutionSignal): string {
  if (signal.run !== undefined) {
    return [
      `本次运行以 reason=${signal.run.reason ?? "unknown"}、errorCode=${signal.run.errorCode ?? "unknown"} 结束。`,
      "这会被视为 agent 层面的维护信号，不是要求修改用户工作区。",
      signal.target === "self_instructions"
        ? "改进目标是 self_instructions，因为它可版本化、可回滚，并且能影响未来行为而无需修改运行时代码。"
        : `改进目标是 ${signal.target}；发布前需要在专用自进化流程里验证。`,
    ].join(" ");
  }
  return [
    "维护者明确请求进行 agent 自进化评审。",
    signal.target === "self_instructions"
      ? "该请求按 self_instructions 处理，因为它涉及 agent 未来的运行指导。"
      : `该请求按 ${signal.target} 处理，因为它涉及运行时/控制面行为，而不只是未来提示词指导。`,
  ].join(" ");
}

function proposalSummaryForSignal(signal: EvolutionSignal): string {
  if (signal.target === "runtime_code") {
    return "通过隔离的自进化实现流程修改 pibot 运行时/WebUI 代码。";
  }
  if (signal.target === "self_instructions") {
    return "针对这个重复出现或明确提出的 agent 层面问题，调整 pibot 自身运行指令。";
  }
  return `为 pibot 准备一个可评审的 ${signal.target} 自进化变更。`;
}

function proposalRiskForSignal(signal: EvolutionSignal): string {
  if (signal.target === "runtime_code") {
    return "该变更可能影响线上 WebUI 或运行时行为。保持补丁范围收窄，在隔离工作区验证，并且只在检查通过后发布。";
  }
  if (signal.target === "self_instructions") {
    return "该变更可能影响共享同一全局 agent profile 的多个入口。保持措辞收窄；如果增加阻力或掩盖有用错误，应回滚。";
  }
  return "该变更可能影响共享 agent 行为。保持提案范围收窄，并在发布前验证受影响表面。";
}

function rollbackPlanForSignal(signal: EvolutionSignal): string {
  if (signal.target === "runtime_code") {
    return "使用 WebUI 的 Runtime Versions 面板启用更早的运行时版本。如果版本启用报告冲突，检查工单历史，并提交一个范围收窄的后续 runtime_code 工单。";
  }
  if (signal.target === "self_instructions") {
    return "使用 WebUI 的 Versions 面板恢复上一个自定义指令版本。";
  }
  return "使用 WebUI 自进化工单历史，为受影响表面提交一个范围收窄的后续回滚。";
}

function mergeSelfInstructionSection(
  currentInstructions: string | undefined,
  signal: EvolutionSignal,
): string {
  const current = currentInstructions?.trim();
  const heading = `## ${titleForSignal(signal)}`;
  const section = [
    heading,
    "",
    `主题：${versionTopicForSignal(signal)}`,
    `信号摘要：${signal.summary}`,
    "",
    "- 遇到类似未来失败时，先把它视为可能的 agent 层面问题，再判断是否是用户工作区问题。",
    "- 保持正常任务边界：不要把修改用户工作区文件作为自进化的一部分。",
    "- 在提出运行时代码变更前，优先给出范围收窄的诊断、可回滚的自定义指令变更和验证说明。",
    "- 当 WebUI 自进化工单已经存在时，提及该工单，而不是从头重启分析。",
  ].join("\n");

  if (current === undefined || current.length === 0) {
    return [
      "# pibot Self-Instructions",
      "",
      "这些指令由 WebUI 自进化控制面维护，并会注入未来的 pibot 运行。",
      "",
      section,
      "",
    ].join("\n");
  }

  if (current.includes(heading)) {
    return current;
  }

  return `${current}\n\n${section}\n`;
}

function validateProposal(
  target: EvolutionTarget,
  proposedSelfInstructions: string | undefined,
): EvolutionValidationResult {
  const checks: {
    readonly name: string;
    readonly passed: boolean;
    readonly message: string;
  }[] = [];
  if (target !== "self_instructions") {
    checks.push({
      name: "approval_target",
      passed: true,
      message: target === "runtime_code"
        ? "runtime_code 可以在隔离工作区中实现，并在验证后发布。"
        : `${target} 可以作为自进化任务批准，并由人工实现。`,
    });
    if (target === "runtime_code") {
      checks.push({
        name: "implementation_evidence",
        passed: true,
        message: "WebUI、UI、视觉、布局、样式、交互、API 或持久化数据源类 runtime_code 工单在完成前必须提供对应证据：浏览器、截图、DOM、computed CSS、API 调用、存储文件或端到端行为验证；编译通过本身不能证明问题已修复。",
      });
    }
  } else {
    checks.push({
      name: "supported_target",
      passed: true,
      message: "self_instructions 可以实现、版本化并回滚。",
    });
  }

  const text = proposedSelfInstructions?.trim() ?? "";
  checks.push({
    name: "size_limit",
    passed: Buffer.byteLength(text, "utf8") <= 64_000,
    message: target === "self_instructions"
      ? "自定义指令必须保持在 64 KB 以内。"
      : "任何附带的自定义指令草稿都必须保持在 64 KB 以内。",
  });

  const passed = checks.every((check) => check.passed);
  return {
    status: passed ? "passed" : "failed",
    checkedAt: new Date().toISOString(),
    checks,
  };
}

function refreshTicketValidation(ticket: EvolutionTicket): EvolutionTicket {
  const validation = validateProposal(
    ticket.target,
    ticket.proposal.proposedSelfInstructions,
  );
  return {
    ...ticket,
    status: statusAfterValidation(ticket.status, validation),
    proposal: {
      ...ticket.proposal,
      validation,
    },
  };
}

function statusAfterValidation(
  current: EvolutionTicketStatus,
  validation: EvolutionValidationResult,
): EvolutionTicketStatus {
  if (current === "approved" || current === "applying" || terminalStatus(current)) {
    return current;
  }
  return validation.status === "passed" ? "waiting_for_approval" : "proposal_ready";
}

function terminalStatus(status: EvolutionTicketStatus): boolean {
  return (
    status === "rejected" ||
    status === "applied" ||
    status === "failed" ||
    status === "rolled_back"
  );
}

function timeline(
  type: string,
  message: string,
  eventActor?: string,
): EvolutionTimelineEvent {
  return {
    ts: new Date().toISOString(),
    type,
    message,
    ...(eventActor === undefined ? {} : { actor: eventActor }),
  };
}

function replaceById(
  tickets: readonly EvolutionTicket[],
  ticket: EvolutionTicket,
): readonly EvolutionTicket[] {
  return tickets.map((candidate) =>
    candidate.id === ticket.id ? ticket : candidate
  );
}

function omitTicketRollout(
  ticket: EvolutionTicket,
  patch: {
    readonly updatedAt: string;
    readonly timeline: readonly EvolutionTimelineEvent[];
  },
): EvolutionTicket {
  const { rollout: _removedRollout, ...rest } = ticket;
  return {
    ...rest,
    ...patch,
  };
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function maxSeverity(
  left: EvolutionSeverity,
  right: EvolutionSeverity,
): EvolutionSeverity {
  const order: Record<EvolutionSeverity, number> = {
    info: 0,
    warning: 1,
    critical: 2,
  };
  return order[right] > order[left] ? right : left;
}

function signatureFor(
  scope: EvolutionScope,
  target: EvolutionTarget,
  cause: string,
): string {
  return `${scope}:${target}:${normalizeSignaturePart(cause)}`;
}

function normalizeSignaturePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_ -]+/gu, "")
    .trim()
    .replace(/\s+/gu, "_")
    .slice(0, 80);
}

function latestVersion(
  versions: readonly AgentSelfVersion[],
): AgentSelfVersion | undefined {
  return versions[versions.length - 1];
}

function latestRuntimeVersion(
  versions: readonly RuntimeCodeVersion[],
): RuntimeCodeVersion | undefined {
  return versions[versions.length - 1];
}

function buildRuntimeCodeVersion(input: {
  readonly versions: readonly RuntimeCodeVersion[];
  readonly ticket: EvolutionTicket;
  readonly createdBy: string;
  readonly changedFiles: readonly string[];
  readonly deletedFiles: readonly string[];
}): RuntimeCodeVersion {
  if (input.ticket.target === "self_instructions") {
    throw new Error("Self-instructions tickets use self-instruction versions");
  }
  const createdAt = new Date().toISOString();
  const number = nextRuntimeVersionNumber(input.versions);
  const id = `runtime-v${padVersionNumber(number)}-${compactTimestampForId(createdAt)}`;
  return {
    id,
    number,
    createdAt,
    label: `v${padVersionNumber(number)} ${input.ticket.title}`,
    topic: evolutionTopicForTicket(input.ticket),
    target: input.ticket.target,
    sourceTicketId: input.ticket.id,
    createdBy: input.createdBy,
    changedFiles: input.changedFiles,
    deletedFiles: input.deletedFiles,
  };
}

function nextRuntimeVersionNumber(
  versions: readonly RuntimeCodeVersion[],
): number {
  return versions.reduce(
    (max, version) => Math.max(max, version.number),
    0,
  ) + 1;
}

function runtimeVersionName(version: RuntimeCodeVersion): string {
  return `v${padVersionNumber(version.number)} (${version.id})`;
}

function padVersionNumber(value: number): string {
  return String(value).padStart(4, "0");
}

function compactTimestampForId(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value.replace(/[^0-9A-Za-z_-]+/gu, "").slice(0, 15) || "unknown";
  }
  const pad = (part: number) => String(part).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "-",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
}

function actor(value: string | undefined, fallback: string | undefined): string {
  const resolved = value ?? fallback ?? "webui";
  return resolved.trim().length === 0 ? "webui" : resolved;
}

function optionalString<Key extends string>(
  key: Key,
  value: string | undefined,
): { readonly [Property in Key]: string } | object {
  if (value === undefined) {
    return {};
  }
  return { [key]: value } as { readonly [Property in Key]: string };
}
