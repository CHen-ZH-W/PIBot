import type { AgentRunId } from "../core/ids";
import type { EvolutionContextRecorder } from "./channel-context";
import {
  activateRuntimeCodeVersionArchive,
  captureRuntimeCodeVersionArchive,
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
  readonly active: ActiveRuntimeCodeVersion;
  readonly publish: RuntimeCodePublishReport;
  readonly alreadyActive: boolean;
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
          timeline("proposal.updated", "Proposal updated.", input.actor),
        ],
      };
      await this.replaceTicket(updated);
      await this.recordContextMessage(updated.id, [
        `Proposal updated for ${updated.id}: ${updated.title}`,
        `Topic: ${proposal.versionTopic ?? updated.title}`,
        `Status: ${updated.status}`,
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
          timeline("approval.approved", "Proposal approved.", approval.decidedBy),
        ],
      };
      await this.replaceTicket(updated);
      await this.recordContextMessage(updated.id, [
        `Proposal approved for ${updated.id}: ${updated.title}`,
        `Topic: ${updated.proposal.versionTopic ?? updated.title}`,
        `Approved by: ${approval.decidedBy}`,
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
          timeline("approval.rejected", "Proposal rejected.", approval.decidedBy),
        ],
      };
      await this.replaceTicket(updated);
      await this.recordContextMessage(updated.id, [
        `Proposal rejected for ${updated.id}: ${updated.title}`,
        `Topic: ${updated.proposal.versionTopic ?? updated.title}`,
        `Rejected by: ${approval.decidedBy}`,
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
        "Started self-evolution implementation run.",
        input.actor,
      );
      await this.options.store.appendAudit({
        ...timeline(
          "implementation.started",
          `Started implementation for ${ticket.id}.`,
          actor(input.actor, this.options.defaultActor),
        ),
        ticketId: ticket.id,
      });
      await this.recordContextMessage(updated.id, [
        `Implementation started for ${updated.id}: ${updated.title}`,
        `Topic: ${updated.proposal.versionTopic ?? updated.title}`,
        `Target: ${updated.target}`,
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
          `${input.success ? "Completed" : "Failed"} implementation for ${ticket.id}.`,
          actor(input.actor, this.options.defaultActor),
        ),
        ticketId: ticket.id,
      });
      await this.recordContextMessage(completed.id, [
        `${input.success ? "Implementation completed" : "Implementation failed"} for ${completed.id}: ${completed.title}`,
        `Topic: ${evolutionTopicForTicket(completed)}`,
        ...(input.summary === undefined ? [] : [`Summary: ${input.summary}`]),
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
            `Created runtime version ${runtimeVersionName(version)}.`,
            version.createdBy,
          ),
        ],
      };
      await this.replaceTicket(updated);
      await this.options.store.appendAudit({
        ...timeline(
          "runtime_code.version_created",
          `Created ${runtimeVersionName(version)} from ${ticket.id}.`,
          version.createdBy,
        ),
        ticketId: ticket.id,
      });
      await this.recordContextMessage(updated.id, [
        `Runtime code version created: ${runtimeVersionName(version)}`,
        `Topic: ${version.topic ?? version.label}`,
        `Ticket: ${ticket.id}`,
        `Created by: ${version.createdBy}`,
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
            `Created self-instructions version ${version.id}.`,
            version.createdBy,
          ),
        ],
      };
      await this.replaceTicket(updated);
      await this.options.store.appendAudit({
        ...timeline(
          "self_instructions.version_created",
          `Created ${version.id} from ${ticket.id}.`,
          version.createdBy,
        ),
        ticketId: ticket.id,
      });
      await this.recordContextMessage(updated.id, [
        `Self-instructions version created: ${version.id}`,
        `Topic: ${version.topic ?? version.label}`,
        `Ticket: ${ticket.id}`,
        `Created by: ${version.createdBy}`,
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
        "Applying self-instructions version.",
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
          completionTopic: `Applied self-instructions: ${versionTopic}`,
        },
        rollout,
        updatedAt: version.createdAt,
        timeline: [
          ...applying.timeline,
          timeline(
            "rollout.applied",
            `Applied self-instructions version ${version.id}.`,
            version.createdBy,
          ),
        ],
      };
      await this.replaceTicket(updated);
      await this.options.store.appendAudit({
        ...timeline(
          "self_instructions.version_created",
          `Created ${version.id} from ${ticket.id}.`,
          version.createdBy,
        ),
        ticketId: ticket.id,
      });
      await this.recordContextMessage(updated.id, [
        `Self-instructions version applied: ${version.id}`,
        `Topic: ${evolutionTopicForTicket(updated)}`,
        `Ticket: ${ticket.id}`,
        `Applied by: ${version.createdBy}`,
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
        ? "Requested runtime restart to activate published code."
        : `Requested runtime restart via ${input.commandLabel}.`;
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
          `Requested runtime activation for ${ticket.id}.`,
          requestedBy,
        ),
        ticketId: ticket.id,
      });
      await this.recordContextMessage(updated.id, [
        `Runtime activation requested for ${updated.id}: ${updated.title}`,
        `Topic: ${evolutionTopicForTicket(updated)}`,
        `Requested by: ${requestedBy}`,
        ...(input.commandLabel === undefined ? [] : [`Restart: ${input.commandLabel}`]),
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
      readonly workspaceRoot: string;
    },
  ): Promise<RuntimeCodeVersionActivationResult> {
    return this.enqueue(() =>
      this.activateRuntimeCodeVersionUnlocked(versionId, input)
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
        label: `Rollback to ${target.id}`,
        topic: `Rollback: ${target.topic ?? target.label}`,
        createdBy: actor(input.actor, this.options.defaultActor),
      });
      await this.options.store.appendAudit({
        ...timeline(
          "self_instructions.rolled_back",
          input.note === undefined
            ? `Rolled back to ${target.id}.`
            : `Rolled back to ${target.id}. ${input.note}`,
          version.createdBy,
        ),
      });
      await this.recordContextMessage(undefined, [
        `Self-instructions rollback applied: ${version.id}`,
        `Topic: ${version.topic ?? version.label}`,
        `Rolled back to: ${target.id}`,
        `Applied by: ${version.createdBy}`,
      ].join("\n"));
      return version;
    });
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
    const summary = `Run ${input.runId} ended with ${input.errorCode}`;
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
        `${surface} run failed with reason=${input.reason}, errorCode=${input.errorCode}. ` +
        "Review whether pibot should adjust its own prompt, policy, tools, or runtime behavior.",
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
      ...timeline("signal.recorded", `Recorded signal ${signal.id}.`),
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
            `Linked ${signal.source} signal ${signal.id}.`,
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
        timeline("ticket.created", `Created from signal ${signal.id}.`),
        timeline("proposal.created", "Generated initial proposal."),
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
    const emptyPublish: RuntimeCodePublishReport = {
      changedFiles: [],
      deletedFiles: [],
      conflicts: [],
    };
    if (currentActive?.versionId === version.id) {
      return {
        version,
        ...(ticket === undefined ? {} : { ticket }),
        active: currentActive,
        publish: emptyPublish,
        alreadyActive: true,
      };
    }

    const publish = await activateRuntimeCodeVersionArchive({
      archiveRoot: this.options.store.getRuntimeCodeVersionArchiveRoot(version.id),
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
    const active: ActiveRuntimeCodeVersion = {
      versionId: version.id,
      activatedAt: new Date().toISOString(),
      activatedBy,
      ...(currentActive === undefined
        ? {}
        : { previousVersionId: currentActive.versionId }),
      ...optionalString("commandLabel", input.commandLabel),
    };
    await this.options.store.writeActiveRuntimeVersion(active);

    const updatedTicket = ticket === undefined
      ? undefined
      : await this.markRuntimeVersionActivated(ticket, version, active);
    await this.options.store.appendAudit({
      ...timeline(
        "runtime_code.version_activated",
        `Activated ${runtimeVersionName(version)}.`,
        activatedBy,
      ),
      ...(updatedTicket === undefined ? {} : { ticketId: updatedTicket.id }),
    });
    await this.recordContextMessage(updatedTicket?.id, [
      `Runtime code version activated: ${runtimeVersionName(version)}`,
      `Topic: ${version.topic ?? version.label}`,
      `Activated by: ${activatedBy}`,
      ...(active.previousVersionId === undefined
        ? []
        : [`Previous version: ${active.previousVersionId}`]),
      ...(input.commandLabel === undefined
        ? []
        : [`Apply: ${input.commandLabel}`]),
    ].join("\n"));

    return {
      version,
      ...(updatedTicket === undefined ? {} : { ticket: updatedTicket }),
      active,
      publish,
      alreadyActive: false,
    };
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
          "runtime_version.activated",
          `Selected ${runtimeVersionName(version)} as the active runtime version.`,
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
    errorCode === "max_turns_exceeded" ||
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
    return `Improve handling for ${signal.run.errorCode}`;
  }
  return signal.summary.length <= 80
    ? signal.summary
    : `${signal.summary.slice(0, 77)}...`;
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
    .trim();
  if (normalized.length === 0) {
    return undefined;
  }
  const prefix = success ? "Completed: " : "Failed: ";
  return `${prefix}${truncateTopic(normalized, 180)}`;
}

function implementationTimelineMessage(success: boolean, ticketId: string): string {
  return `${success ? "Completed" : "Failed"} implementation for ${ticketId}.`;
}

function truncateTopic(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function contextMessageForSignal(
  signal: EvolutionSignal,
  ticket: EvolutionTicket,
): string {
  return [
    `Evolution signal recorded: ${signal.summary}`,
    `Ticket: ${ticket.id} (${ticket.status})`,
    `Topic: ${ticket.proposal.versionTopic ?? ticket.title}`,
    `Source: ${signal.source}`,
    `Scope/target: ${signal.scope}/${signal.target}`,
    ...(signal.details === undefined ? [] : [`Details: ${signal.details}`]),
  ].join("\n");
}

function diagnosisForSignal(signal: EvolutionSignal): string {
  if (signal.run !== undefined) {
    return [
      `The run ended with reason=${signal.run.reason ?? "unknown"} and errorCode=${signal.run.errorCode ?? "unknown"}.`,
      "This is treated as an agent-level maintenance signal, not a request to edit the user's workspace.",
      signal.target === "self_instructions"
        ? "The improvement target is self-instructions because it is versioned, reversible, and affects future behavior without changing runtime source code."
        : `The improvement target is ${signal.target}; validate it in the dedicated self-evolution workflow before rollout.`,
    ].join(" ");
  }
  return [
    "A maintainer explicitly requested an agent self-evolution review.",
    signal.target === "self_instructions"
      ? "The request is being handled as a self-instruction change because it concerns the agent's future operating guidance."
      : `The request is being handled as ${signal.target} because it concerns the runtime/control-plane behavior rather than only future prompt guidance.`,
  ].join(" ");
}

function proposalSummaryForSignal(signal: EvolutionSignal): string {
  if (signal.target === "runtime_code") {
    return "Change pibot runtime/WebUI code through the isolated self-evolution implementation workflow.";
  }
  if (signal.target === "self_instructions") {
    return "Adjust pibot's own operating instructions for this recurring or explicit agent-level issue.";
  }
  return `Prepare a reviewable ${signal.target} self-evolution change for pibot.`;
}

function proposalRiskForSignal(signal: EvolutionSignal): string {
  if (signal.target === "runtime_code") {
    return "The change may affect live WebUI or runtime behavior. Keep the patch narrow, validate it in the isolated workspace, and publish only after checks pass.";
  }
  if (signal.target === "self_instructions") {
    return "The change may alter behavior across channels that share the same global agent profile. Keep the wording narrow and rollback if it increases friction or hides useful errors.";
  }
  return "The change may affect shared agent behavior. Keep the proposal narrow and verify the affected surface before rollout.";
}

function rollbackPlanForSignal(signal: EvolutionSignal): string {
  if (signal.target === "runtime_code") {
    return "Use the WebUI Runtime Versions panel to activate an earlier runtime version. If version activation reports conflicts, inspect the ticket history and apply a narrow follow-up runtime-code ticket.";
  }
  if (signal.target === "self_instructions") {
    return "Use the WebUI Versions panel to restore the previous self-instructions version.";
  }
  return "Use the WebUI evolution ticket history to apply a narrow follow-up rollback for the affected surface.";
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
    `Topic: ${versionTopicForSignal(signal)}`,
    `Signal summary: ${signal.summary}`,
    "",
    "- Treat similar future failures as possible agent-level issues before assuming the user workspace is wrong.",
    "- Preserve the normal task boundary: do not edit user workspace files as part of self-evolution.",
    "- Prefer a narrow diagnosis, a reversible self-instruction change, and a validation note before proposing runtime code changes.",
    "- When a WebUI evolution ticket exists, mention the ticket instead of restarting the analysis from scratch.",
  ].join("\n");

  if (current === undefined || current.length === 0) {
    return [
      "# pibot Self-Instructions",
      "",
      "These instructions are maintained by the WebUI self-evolution control plane and are injected into future pibot runs.",
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
        ? "runtime_code can be implemented in an isolated workspace and published after validation."
        : `${target} can be approved as a self-evolution task for manual implementation.`,
    });
  } else {
    checks.push({
      name: "supported_target",
      passed: true,
      message: "self_instructions can be implemented, versioned, and rolled back.",
    });
  }

  const text = proposedSelfInstructions?.trim() ?? "";
  checks.push({
    name: "size_limit",
    passed: Buffer.byteLength(text, "utf8") <= 64_000,
    message: target === "self_instructions"
      ? "Self-instructions must stay within 64 KB."
      : "Any attached self-instruction draft must stay within 64 KB.",
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
