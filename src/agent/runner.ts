import { randomUUID } from "node:crypto";
import type {
  LlmMessage,
  LlmMessageContentPart,
  LlmToolSchema,
} from "../core/agent";
import type { AgentId, AgentRunId, SlackChannelId } from "../core/ids";
import type { AppLogger, LogFields } from "../app/logging";
import { errorFields, NoopLogger } from "../app/logging";
import type { UsagePricing, UsageRecorder } from "../app/usage";
import {
  calculateUsage,
  estimateRunUsage,
  NoopUsageRecorder,
} from "../app/usage";
import type { ChannelSessionKey } from "../core/session";
import type { ToolApprovalContext } from "../core/tools";
import type {
  SlackConversationRef,
  SlackEvent,
} from "../core/slack";
import type { SlackEventPublisher, SlackMessageHandler } from "../ports/slack";
import {
  appendAttachmentPathsToText,
  downloadedImageAttachmentsToContentParts,
  type SlackAttachmentDownloader,
} from "../slack/attachments";
import {
  postSplitMrkdwnMessage,
  SlackRunContext,
} from "../slack/context";
import {
  formatAgentErrorMessage,
  formatAssistantText,
  formatBusyMessage,
  formatCancelledMessage,
  formatFollowUpQueuedMessage,
  formatLongRunningStatus,
  formatMainMessage,
  formatModeSwitchMessage,
  formatNoActiveRunMessage,
  formatSteeringQueuedMessage,
  formatSteeringRejectedMessage,
  formatThinkingMessage,
  formatToolEndStatus,
  formatToolEndThreadMessage,
  formatToolStartStatus,
} from "../slack/formatter";
import {
  formatRepoRunPrompt,
  formatRepoRunSummary,
  formatRepoWorkflowError,
  type ChannelRepoWorkflow,
  type RepoRunSummary,
  type RepoRunStartSnapshot,
} from "../workspace/repo";
import type {
  PreparedChannelRunContext,
  WorkspaceSessionStore,
} from "../workspace/session";
import type {
  SessionCompactionResult,
  SessionCompactionStart,
} from "../workspace/compaction";
import {
  scanWorkspaceSkills,
  type WorkspaceSkill,
} from "../workspace/skills";
import type { AgentLoopResult, MinimalAgentLoop } from "./agent-loop";
import type { AgentLoopEvent } from "./events";
import type { ModelRequest, ModelUsage } from "./model";
import {
  buildCodingAgentSystemPrompt,
  formatChannelWorkspacePrompt,
} from "./system-prompt";
import type { AgentRunContext } from "../runtime/context";
import { createAgentRunContext } from "../runtime/context";
import {
  NoopTraceRecorder,
  type TraceEvent,
  type TraceRecorder,
  withRun,
} from "../runtime/trace";
import {
  buildReflectionPrompt,
  normalizeMaxFixAttempts,
  parseReflectionStatus,
  type ReflectionWorkflowOptions,
} from "../runtime/reflection";
import {
  isAgentStopCommand as isRunStopCommand,
  parseFollowUpMessage,
  parseModeSwitchMessage,
  parseSteeringMessage,
  renderInlineSteering,
  renderModeSwitchSteering,
} from "../runtime/run-control";
import type { RuntimeHook } from "../runtime/hooks";
import {
  AgentRunController,
} from "../runtime/run-controller";
import type { EvolutionRunFailureReporter } from "../evolution/types";

export interface AgentRunnerOptions {
  readonly slack: SlackEventPublisher;
  readonly agentLoop: MinimalAgentLoop;
  readonly createAgentLoopForWorkspace?: (
    workspaceRoot: string,
    approvalContext: ToolApprovalContext,
    runContext: AgentRunContext,
    workspaceSkills: readonly WorkspaceSkill[],
  ) => MinimalAgentLoop;
  readonly resolveChannelWorkspaceRoot?: (
    key: ChannelSessionKey,
  ) => Promise<string>;
  readonly sessions: WorkspaceSessionStore;
  readonly tools: readonly LlmToolSchema[];
  readonly maxSteps: number;
  readonly maxParallelToolCalls?: number;
  readonly model?: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly updateThrottleMs?: number;
  readonly updateMinChars?: number;
  readonly repoWorkflow?: ChannelRepoWorkflow;
  readonly attachmentDownloader?: SlackAttachmentDownloader;
  readonly logger?: AppLogger;
  readonly usageRecorder?: UsageRecorder;
  readonly usagePricing?: UsagePricing;
  readonly traceRecorder?: TraceRecorder;
  readonly agentId?: AgentId;
  readonly maxContextOverflowRetries?: number;
  readonly disabledSkills?: readonly string[];
  readonly maxSkills?: number;
  readonly maxSkillFileBytes?: number;
  readonly pibotSkillsRoot?: string;
  readonly reflection?: ReflectionWorkflowOptions;
  readonly maxFollowUpQueueSize?: number;
  readonly longTaskStatusUpdateMs?: number;
  readonly evolution?: EvolutionRunFailureReporter;
  readonly agentSelfInstructionsProvider?: () => Promise<string | undefined>;
  readonly thinkingLanguage?: string;
}

interface ActiveRun {
  readonly runId: AgentRunId;
  readonly channelId: SlackChannelId;
  readonly userId: SlackEvent["senderUserId"];
  readonly startedAt: Date;
  readonly control: AgentRunController<PreparedSlackRunInput>;
  readonly context: SlackRunContext;
  readonly runtime: AgentRunContext;
}

interface RunRenderState {
  currentAssistantText: string;
  progressText: string;
  progressResetCount: number;
  insideProgressCodeBlock: boolean;
  lastProgressWasOmission: boolean;
  longTaskStatusLine?: string;
  lastRenderedMainText: string;
  lastUpdateAt: number;
}

interface RunPersistenceState {
  prepared: PreparedChannelRunContext;
  completedGeneratedMessages: number;
}

interface PreparedSlackRunInput {
  readonly event: SlackEvent;
  readonly userContentParts: readonly LlmMessageContentPart[];
  readonly control?: AgentRunController<PreparedSlackRunInput>;
}

interface SlackUserTurnOutcome {
  readonly reason: string;
  readonly errorCode?: string;
}

/**
 * 职责：按 Slack channel 编排 session、agent loop 和 Slack run context。
 * 不应承担：调用 provider API、执行工具实现、Socket Mode 解析、context compaction。
 */
export class PerChannelAgentRunner implements SlackMessageHandler {
  private readonly activeByChannel = new Map<SlackChannelId, ActiveRun>();
  private readonly updateThrottleMs: number;
  private readonly updateMinChars: number;
  private readonly maxFollowUpQueueSize: number;
  private readonly longTaskStatusUpdateMs: number;
  private readonly logger: AppLogger;
  private readonly usageRecorder: UsageRecorder;
  private readonly usagePricing: UsagePricing;
  private readonly traceRecorder: TraceRecorder;

  constructor(private readonly options: AgentRunnerOptions) {
    this.updateThrottleMs = options.updateThrottleMs ?? 2000;
    this.updateMinChars = options.updateMinChars ?? 500;
    this.maxFollowUpQueueSize = options.maxFollowUpQueueSize ?? 5;
    this.longTaskStatusUpdateMs = options.longTaskStatusUpdateMs ?? 30000;
    this.logger = options.logger ?? new NoopLogger();
    this.usageRecorder = options.usageRecorder ?? new NoopUsageRecorder();
    this.usagePricing = options.usagePricing ?? {
      strategy: "unconfigured",
      currency: "USD",
      inputCostPerMillionTokens: 0,
      cachedInputCostPerMillionTokens: 0,
      outputCostPerMillionTokens: 0,
    };
    this.traceRecorder = options.traceRecorder ?? new NoopTraceRecorder();
  }

  async handleSlackMessage(event: SlackEvent): Promise<void> {
    if (isAgentStopCommand(event.text)) {
      await this.options.sessions.recordUserMessage(event);
      await this.abortActiveRun(event);
      return;
    }

    const prepared = await this.eventWithDownloadedAttachments(event);
    const recorded = await this.options.sessions.recordUserMessage(prepared.event);
    if (!recorded) {
      return;
    }

    await this.runAgent(prepared);
  }

  shouldBypassSlackQueue(event: SlackEvent): boolean {
    return (
      isAgentStopCommand(event.text) ||
      this.activeByChannel.has(event.conversation.channelId)
    );
  }

  private async eventWithDownloadedAttachments(
    event: SlackEvent,
  ): Promise<PreparedSlackRunInput> {
    if (
      event.files.length === 0 ||
      this.options.attachmentDownloader === undefined
    ) {
      return {
        event,
        userContentParts: [],
      };
    }

    const result = await this.options.attachmentDownloader.downloadForEvent(
      event,
      {
        teamId: event.conversation.teamId,
        channelId: event.conversation.channelId,
      },
    );
    for (const failure of result.failures) {
      this.logger.warn("attachment_download_failed", {
        channelId: event.conversation.channelId,
        userId: event.senderUserId,
        fileId: failure.fileId,
        fileName: failure.name,
        errorMessage: failure.message,
      });
    }

    return {
      event: {
        ...event,
        text: appendAttachmentPathsToText(event.text, result),
      },
      userContentParts: await downloadedImageAttachmentsToContentParts(result),
    };
  }

  private async runAgent(
    input: PreparedSlackRunInput,
  ): Promise<SlackUserTurnOutcome | undefined> {
    const event = input.event;
    const channelId = event.conversation.channelId;
    const sessionKey = {
      teamId: event.conversation.teamId,
      channelId,
    };
    const existing = input.control === undefined
      ? this.activeByChannel.get(channelId)
      : undefined;
    if (existing !== undefined) {
      const modeSwitch = parseModeSwitchMessage(event.text);
      if (modeSwitch !== undefined) {
        const receipt = existing.control.changeMode(
          modeSwitch,
          renderModeSwitchSteering(modeSwitch),
          "slack",
        );
        await postSplitMrkdwnMessage(
          this.options.slack,
          replyConversationFor(event),
          receipt.accepted
            ? formatModeSwitchMessage(modeSwitch.mode)
            : formatSteeringRejectedMessage(),
        );
        return;
      }

      const steering = parseSteeringMessage(event.text);
      if (steering !== undefined) {
        const receipt = existing.control.steer(steering, "slack");
        await postSplitMrkdwnMessage(
          this.options.slack,
          replyConversationFor(event),
          receipt.accepted
            ? formatSteeringQueuedMessage()
            : formatSteeringRejectedMessage(),
        );
        return;
      }

      const followUp = parseFollowUpMessage(event.text);
      if (followUp === undefined) {
        const receipt = existing.control.steer(
          renderInlineSteering(event.text),
          "slack",
        );
        await postSplitMrkdwnMessage(
          this.options.slack,
          replyConversationFor(event),
          receipt.accepted
            ? formatSteeringQueuedMessage()
            : formatSteeringRejectedMessage(),
        );
        return;
      }

      const receipt = existing.control.enqueueFollowUp(
        {
          ...input,
          event: {
            ...event,
            text: followUp,
          },
        },
        { text: followUp, source: "slack" },
      );
      await postSplitMrkdwnMessage(
        this.options.slack,
        replyConversationFor(event),
        !receipt.accepted || receipt.position === undefined
          ? formatBusyMessage()
          : formatFollowUpQueuedMessage(receipt.position),
      );
      return;
    }

    if (input.control === undefined) {
      const initialRuntime = createAgentRunContext({
        runId: createRunId(),
        agentId: this.options.agentId ?? ("coding-bot" as AgentId),
        state: await this.options.sessions.readRuntimeState(sessionKey),
      });
      const controlRef: {
        current?: AgentRunController<PreparedSlackRunInput>;
      } = {};
      const control = new AgentRunController<PreparedSlackRunInput>({
        runContext: initialRuntime,
        maxFollowUps: this.maxFollowUpQueueSize,
        onTransition: (transition) =>
          this.traceRecorder.record(withRun(
            controlRef.current?.runContext ?? initialRuntime,
            {
              type: "runtime.transition",
              transition,
            },
          )).catch(() => undefined),
      });
      controlRef.current = control;
      await this.traceRecorder.record(withRun(initialRuntime, {
        type: "run.started",
        channelId,
        userId: event.senderUserId,
      })).catch(() => undefined);

      let finalOutcome: SlackUserTurnOutcome = { reason: "unknown" };
      try {
        finalOutcome = await control.runUserTurns({
          initial: { ...input, control },
          execute: async (turnInput) =>
            await this.runAgent({ ...turnInput, control }) ?? { reason: "unknown" },
        });
        return finalOutcome;
      } catch (error: unknown) {
        finalOutcome = {
          reason: "exception",
          errorCode: error instanceof Error ? error.name : "unknown",
        };
        throw error;
      } finally {
        if (this.activeByChannel.get(channelId)?.control === control) {
          this.activeByChannel.delete(channelId);
        }
        await this.traceRecorder.record(withRun(control.runContext, {
          type: "run.completed",
          finalUserTurnReason: finalOutcome.reason,
          ...optionalString("errorCode", finalOutcome.errorCode),
        })).catch(() => undefined);
      }
    }

    const context = new SlackRunContext(this.options.slack, event);
    const startedAt = new Date();
    const control = input.control;
    const runtime = control.runContext;
    const initialModeSwitch = parseModeSwitchMessage(event.text);
    if (initialModeSwitch !== undefined) {
      control.changeMode(
        initialModeSwitch,
        renderModeSwitchSteering(initialModeSwitch),
        "slack",
      );
    }
    const active: ActiveRun = {
      runId: runtime.runId,
      channelId,
      userId: event.senderUserId,
      startedAt,
      control,
      context,
      runtime,
    };
    this.activeByChannel.set(channelId, active);
    this.logRun("info", "run_start", active, {
      messageTs: event.messageTs,
    });
    await this.recordTrace(active, {
      type: "user_turn.started",
      userTurnId: runtime.userTurnId,
      channelId,
      userId: event.senderUserId,
      messageTs: event.messageTs,
    });

    let runReason = "unknown";
    let errorCode: string | undefined;
    let usageModel = this.options.model;
    let providerUsage: ModelUsage | undefined;
    let stopStatusTicker: (() => void) | undefined;
    let usageInput:
      | {
          readonly systemPrompt: string;
          readonly history: readonly LlmMessage[];
          readonly userText: string;
        }
      | undefined;
    let generatedMessages: readonly LlmMessage[] = [];

    try {
      await context.startMain(formatThinkingMessage());
      if (active.control.cancelled) {
        await this.replaceMainBestEffort(active, formatCancelledMessage(), "cancelled");
        runReason = "cancelled";
        return { reason: runReason };
      }

      const renderState: RunRenderState = {
        currentAssistantText: "",
        progressText: "",
        progressResetCount: 0,
        insideProgressCodeBlock: false,
        lastProgressWasOmission: false,
        lastRenderedMainText: formatThinkingMessage(),
        lastUpdateAt: 0,
      };
      stopStatusTicker = this.startStatusTicker(active, renderState);
      appendProgressLine(
        renderState,
        "_Checking context size; compacting history if needed..._",
      );
      await this.updateMainNow(active, renderState);
      allowImmediateRender(renderState);

      let preparedRun = await this.options.sessions.prepareRun(event, {
        signal: active.control.signal,
        onCompactionStart: async (compaction) => {
          await this.renderCompactionStartStatus(
            active,
            renderState,
            compaction,
          );
        },
      });
      await this.recordCompactionTrace(active, preparedRun.compaction);
      await this.renderCompactionStatus(active, renderState, preparedRun.compaction);
      const repoStart = await this.safePrepareRepoWorkflow(
        active,
        preparedRun.key,
        active.control.signal,
      );
      if (repoStart === null) {
        runReason = "repo_error";
        errorCode = "repo_workflow_error";
        return { reason: runReason, errorCode };
      }

      const runWorkspaceRoot = await this.resolveRunWorkspaceRoot(
        preparedRun.key,
        repoStart,
      );
      const workspaceSkills = await this.loadWorkspaceSkills(
        active,
        runWorkspaceRoot,
      );
      const agentSelfInstructions = await this.loadAgentSelfInstructions(active);
      let systemPrompt = buildCodingAgentSystemPrompt({
        tools: this.options.tools,
        memories: preparedRun.memories,
        workspaceSkills,
        repoPrompt: formatRepoRunPrompt(repoStart),
        channelWorkspacePrompt: formatChannelWorkspacePrompt(
          runWorkspaceRoot,
          repoStart,
        ),
        workspaceRoot: runWorkspaceRoot,
        mode: active.runtime.state.mode,
        reflectionEnabled: this.options.reflection?.enabled === true,
        ...(agentSelfInstructions === undefined
          ? {}
          : { agentSelfInstructions }),
        ...(this.options.thinkingLanguage === undefined
          ? {}
          : { thinkingLanguage: this.options.thinkingLanguage }),
      });
      usageInput = {
        systemPrompt,
        history: preparedRun.history,
        userText: event.text,
      };

      const agentLoop = this.agentLoopForRun(
        runWorkspaceRoot,
        event,
        active.runtime,
        workspaceSkills,
      );
      let persistence: RunPersistenceState = {
        prepared: preparedRun,
        completedGeneratedMessages: 0,
      };
      const realtimeCompactionHook = this.createRealtimeCompactionHook({
        active,
        event,
        renderState,
        getPersistence: () => persistence,
      });
      const result = await active.control.run({
        execute: () => agentLoop.run(
          {
            userText: event.text,
            userContentParts: input.userContentParts,
            systemPrompt,
            history: preparedRun.history,
            tools: this.options.tools,
            hooks: [realtimeCompactionHook],
            maxSteps: this.options.maxSteps,
            ...(this.options.maxParallelToolCalls === undefined
              ? {}
              : { maxParallelToolCalls: this.options.maxParallelToolCalls }),
            runContext: active.runtime,
            ...optionalString("model", this.options.model),
            ...optionalNumber("temperature", this.options.temperature),
            ...optionalNumber("maxOutputTokens", this.options.maxOutputTokens),
            onEvent: async (agentEvent) => {
              if (active.control.cancelled) {
                return;
              }

              await this.handleAgentEvent(
                active,
                renderState,
                persistence,
                agentEvent,
              );
            },
          },
          active.control.signal,
        ),
        lifecycle: {
          contextRecovery: {
            maxAttempts: this.options.maxContextOverflowRetries ?? 1,
            shouldRecover: (attemptResult) =>
              attemptResult.error?.code === "context_overflow",
            recover: async (contextOverflowRetries, attemptResult) => {
              await this.appendRemainingRunMessages(
                persistence,
                attemptResult.messages,
              );
              appendProgressLine(
                renderState,
                "_Context is too large. Compacting history before retry..._",
              );
              await this.updateMainNow(active, renderState);
              const overflowCompaction = await this.options.sessions.forceCompact(
                preparedRun.key,
                active.control.signal,
              );
              await this.recordCompactionTrace(active, overflowCompaction);
              await this.renderCompactionStatus(
                active,
                renderState,
                overflowCompaction,
              );
              if (overflowCompaction?.triggered !== true) {
                return false;
              }

              await this.recordTrace(active, {
                type: "run.context_overflow_retry",
                attempt: contextOverflowRetries,
              });
              preparedRun = await this.options.sessions.prepareRun(event, {
                signal: active.control.signal,
                onCompactionStart: async (compaction) => {
                  await this.renderCompactionStartStatus(
                    active,
                    renderState,
                    compaction,
                  );
                },
              });
              persistence = {
                prepared: preparedRun,
                completedGeneratedMessages: 0,
              };
              await this.recordCompactionTrace(active, preparedRun.compaction);
              await this.renderCompactionStatus(
                active,
                renderState,
                preparedRun.compaction,
              );
              systemPrompt = buildCodingAgentSystemPrompt({
                tools: this.options.tools,
                memories: preparedRun.memories,
                workspaceSkills,
                repoPrompt: formatRepoRunPrompt(repoStart),
                channelWorkspacePrompt: formatChannelWorkspacePrompt(
                  runWorkspaceRoot,
                  repoStart,
                ),
                workspaceRoot: runWorkspaceRoot,
                mode: active.runtime.state.mode,
                reflectionEnabled: this.options.reflection?.enabled === true,
                ...(agentSelfInstructions === undefined
                  ? {}
                  : { agentSelfInstructions }),
                ...(this.options.thinkingLanguage === undefined
                  ? {}
                  : { thinkingLanguage: this.options.thinkingLanguage }),
              });
              usageInput = {
                systemPrompt,
                history: preparedRun.history,
                userText: event.text,
              };
              return true;
            },
          },
          reflection: {
            run: (initialResult) => this.maybeRunReflection({
              active,
              agentLoop,
              renderState,
              persistence,
              initialResult,
              systemPrompt,
              userText: event.text,
              signal: active.control.signal,
            }),
          },
        },
      });

      if (active.control.cancelled) {
        runReason = "cancelled";
        return { reason: runReason };
      }
      usageModel = result.model ?? usageModel;
      providerUsage = result.usage;
      generatedMessages = result.messages.slice(
        preparedRun.generatedMessageStartIndex,
      );
      runReason = result.reason;

      const repoSummary = await this.summarizeRepoWorkflow(
        preparedRun.key,
        repoStart,
        active.control.signal,
      );

      await this.appendRemainingRunMessages(persistence, result.messages);
      await this.recordRunRolloutSummaryBestEffort(
        preparedRun.key,
        event,
        active,
        result,
      );

      if (result.error !== undefined) {
        errorCode = result.error.code;
        await this.replaceMainBestEffort(
          active,
          formatAgentErrorMessage(result.error),
          "error",
        );
        return { reason: runReason, errorCode };
      }

      await this.replaceMainBestEffort(
        active,
        formatAssistantText(
          `${finalAssistantText(result.messages)}${optionalRepoSummaryText(repoSummary)}`,
        ),
        "final",
      );
    } catch (error: unknown) {
      runReason = "exception";
      errorCode = error instanceof Error ? error.name : "unknown";
      this.logRun("error", "run_exception", active, errorFields(error));
      throw error;
    } finally {
      stopStatusTicker?.();
      await this.recordUsage(
        active,
        runReason,
        errorCode,
        usageModel,
        providerUsage,
        usageInput,
        generatedMessages,
      );
      this.logRun("info", "run_end", active, {
        reason: runReason,
        ...optionalString("errorCode", errorCode),
        durationMs: Date.now() - active.startedAt.getTime(),
      });
      await this.recordTrace(active, {
        type: "user_turn.completed",
        userTurnId: active.runtime.userTurnId,
        reason: runReason,
        ...optionalString("errorCode", errorCode),
        durationMs: Date.now() - active.startedAt.getTime(),
      });
      await this.reportEvolutionFailureIfNeeded(
        active,
        event,
        runReason,
        errorCode,
      );
      await this.options.sessions.writeRuntimeState(
        sessionKey,
        active.runtime.state,
      ).catch((error: unknown) => {
        this.logger.warn("runtime_state_persist_failed", {
          channelId,
          ...errorFields(error),
        });
      });
      await this.options.sessions.syncPendingUserMessages({
        teamId: event.conversation.teamId,
        channelId: event.conversation.channelId,
      });
    }
    return {
      reason: runReason,
      ...optionalString("errorCode", errorCode),
    };
  }

  private async recordRunRolloutSummaryBestEffort(
    key: ChannelSessionKey,
    event: SlackEvent,
    active: ActiveRun,
    result: AgentLoopResult,
  ): Promise<void> {
    try {
      await this.options.sessions.recordRunRolloutSummary({
        key,
        runId: active.runtime.runId,
        userText: event.text,
        reason: result.reason,
        steps: result.steps,
        messages: result.messages,
        ...(result.error === undefined
          ? {}
          : {
              errorCode: result.error.code,
              errorMessage: result.error.message,
            }),
        durationMs: Date.now() - active.startedAt.getTime(),
        source: {
          type: "system",
          runId: active.runtime.runId,
          userId: event.senderUserId,
        },
      });
    } catch (error: unknown) {
      this.logger.warn("memory_rollout_summary_failed", {
        channelId: event.conversation.channelId,
        ...errorFields(error),
      });
    }
  }

  private async maybeRunReflection(input: {
    readonly active: ActiveRun;
    readonly agentLoop: MinimalAgentLoop;
    readonly renderState: RunRenderState;
    readonly persistence: RunPersistenceState;
    readonly initialResult: AgentLoopResult;
    readonly systemPrompt: string;
    readonly userText: string;
    readonly signal: AbortSignal;
  }): Promise<AgentLoopResult> {
    const options = this.options.reflection;
    if (
      options?.enabled !== true ||
      input.initialResult.error !== undefined ||
      input.initialResult.reason !== "completed" ||
      input.active.runtime.state.mode !== "execute"
    ) {
      return input.initialResult;
    }

    const maxFixAttempts = normalizeMaxFixAttempts(options.maxFixAttempts);
    const maxSteps = options.maxSteps ?? this.options.maxSteps;
    let messages = input.initialResult.messages;
    let steps = input.initialResult.steps;
    let usage = input.initialResult.usage;
    let model = input.initialResult.model;

    let fixAttempts = 0;
    let reflectionPass = 0;
    while (true) {
      input.active.control.recordTransition({
        type: "start_reflection",
        attempt: reflectionPass,
      });
      await this.recordTrace(input.active, {
        type: "reflection.started",
        attempt: reflectionPass,
        fixAttempts,
        maxFixAttempts,
      });
      const history = stripSystemMessages(messages);
      const reflectionResult = await input.agentLoop.run(
        {
          userText: buildReflectionPrompt({
            attempt: fixAttempts,
            maxFixAttempts,
            userGoal: input.userText,
            latestAssistantText: finalAssistantText(messages),
            verifyCommands: options.verifyCommands ?? [],
          }),
          systemPrompt: input.systemPrompt,
          history,
          tools: this.options.tools,
          maxSteps,
          ...(this.options.maxParallelToolCalls === undefined
            ? {}
            : { maxParallelToolCalls: this.options.maxParallelToolCalls }),
          runContext: input.active.runtime,
          ...optionalString("model", this.options.model),
          ...optionalNumber("temperature", this.options.temperature),
          ...optionalNumber("maxOutputTokens", this.options.maxOutputTokens),
          onEvent: async (agentEvent) => {
            if (input.active.control.cancelled) {
              return;
            }

            await this.handleAgentEvent(
              input.active,
              input.renderState,
              input.persistence,
              agentEvent,
            );
          },
        },
        input.signal,
      );
      const generatedStartIndex = history.length + 2;
      messages = [
        ...messages,
        ...reflectionResult.messages.slice(generatedStartIndex),
      ];
      steps += reflectionResult.steps;
      usage = addModelUsage(usage, reflectionResult.usage);
      model = reflectionResult.model ?? model;

      if (reflectionResult.error !== undefined || input.active.control.cancelled) {
        return {
          ...input.initialResult,
          messages,
          steps,
          ...optionalString("model", model),
          ...optionalModelUsage(usage),
          reason: reflectionResult.reason,
          ...optionalAgentLoopError(reflectionResult.error),
        };
      }

      const status = parseReflectionStatus(finalAssistantText(reflectionResult.messages));
      await this.recordTrace(input.active, {
        type: "reflection.completed",
        attempt: reflectionPass,
        fixAttempts,
        status,
      });
      if (status === "passed" || status === "blocked") {
        break;
      }
      if (status !== "fixed") {
        await this.recordTrace(input.active, {
          type: "reflection.stopped",
          reason: "missing_status_marker",
          attempt: reflectionPass,
          fixAttempts,
        });
        break;
      }
      fixAttempts += 1;
      if (fixAttempts >= maxFixAttempts) {
        messages = [
          ...messages,
          {
            role: "assistant",
            content:
              `Reflection stopped after reaching maxFixAttempts=${maxFixAttempts}. ` +
              "The last reflection pass still reported a fix instead of a clean pass; treat the latest critique and verification output as remaining risk.",
          },
        ];
        await this.recordTrace(input.active, {
          type: "reflection.stopped",
          reason: "max_fix_attempts",
          attempt: reflectionPass,
          fixAttempts,
        });
        break;
      }
      reflectionPass += 1;
    }

    return {
      ...input.initialResult,
      messages,
      steps,
      ...optionalString("model", model),
      ...optionalModelUsage(usage),
    };
  }

  private async abortActiveRun(event: SlackEvent): Promise<void> {
    const active = this.activeByChannel.get(event.conversation.channelId);
    if (active === undefined) {
      await postSplitMrkdwnMessage(
        this.options.slack,
        replyConversationFor(event),
        formatNoActiveRunMessage(),
      );
      return;
    }

    const receipt = active.control.cancel({
      reason: "user_stop",
      source: "slack",
    });
    if (!receipt.accepted) {
      await postSplitMrkdwnMessage(
        this.options.slack,
        replyConversationFor(event),
        formatNoActiveRunMessage(),
      );
      return;
    }
    this.logRun("warn", "run_abort_requested", active, {
      requestedByUserId: event.senderUserId,
    });
    await active.context.replaceMain(formatCancelledMessage());
  }

  private startStatusTicker(
    active: ActiveRun,
    renderState: RunRenderState,
  ): () => void {
    const intervalMs = this.longTaskStatusUpdateMs;
    if (!Number.isInteger(intervalMs) || intervalMs < 1) {
      return () => undefined;
    }

    let updating = false;
    const timer = setInterval(() => {
      if (updating || active.control.cancelled) {
        return;
      }
      updating = true;
      renderState.longTaskStatusLine = formatLongRunningStatus(
        Date.now() - active.startedAt.getTime(),
      );
      void this.updateMainNow(active, renderState).finally(() => {
        updating = false;
      });
    }, intervalMs);

    return () => {
      clearInterval(timer);
    };
  }

  private async handleAgentEvent(
    active: ActiveRun,
    renderState: RunRenderState,
    persistence: RunPersistenceState,
    event: AgentLoopEvent,
  ): Promise<void> {
    switch (event.type) {
      case "step_start":
        renderState.currentAssistantText = "";
        await this.updateMainNow(active, renderState);
        allowImmediateRender(renderState);
        return;
      case "reasoning_delta":
        appendReasoningProgressText(renderState, event.text);
        await this.updateMainForDelta(active, renderState);
        return;
      case "message_delta":
        renderState.currentAssistantText += event.text;
        await this.updateMainForDelta(active, renderState);
        return;
      case "message_completed":
        persistence.completedGeneratedMessages += 1;
        await this.options.sessions.appendGeneratedMessage(
          persistence.prepared,
          event.message,
        );
        return;
      case "tool_start":
        appendProgressLine(renderState, formatToolStartStatus(event.call.name));
        await this.updateMainNow(active, renderState);
        allowImmediateRender(renderState);
        return;
      case "tool_end":
        appendProgressLine(
          renderState,
          formatToolEndStatus(event.call, event.result),
        );
        await this.updateMainNow(active, renderState);
        allowImmediateRender(renderState);
        try {
          await active.context.postThreadText(
            formatToolEndThreadMessage(event.call, event.result),
          );
        } catch (error: unknown) {
          this.logRun("warn", "slack_tool_thread_failed", active, {
            toolName: event.call.name,
            ...errorFields(error),
          });
        }
        return;
      default:
        return;
    }
  }

  private async appendRemainingRunMessages(
    persistence: RunPersistenceState,
    messages: readonly LlmMessage[],
  ): Promise<void> {
    const generatedMessages = messages.slice(
      persistence.prepared.generatedMessageStartIndex,
    );
    for (const message of generatedMessages.slice(
      persistence.completedGeneratedMessages,
    )) {
      persistence.completedGeneratedMessages += 1;
      await this.options.sessions.appendGeneratedMessage(
        persistence.prepared,
        message,
      );
    }
  }

  private async updateMainForDelta(
    active: ActiveRun,
    renderState: RunRenderState,
  ): Promise<void> {
    const nextText = formatMainMessage({
      assistantText: renderState.currentAssistantText,
      progressText: renderState.progressText,
      statusLines: statusLinesFor(renderState),
    });
    const now = Date.now();
    if (
      nextText === renderState.lastRenderedMainText ||
      (now - renderState.lastUpdateAt < this.updateThrottleMs &&
        nextText.length - renderState.lastRenderedMainText.length <
          this.updateMinChars)
    ) {
      return;
    }

    try {
      await active.context.updateMain(nextText);
    } catch (error: unknown) {
      this.logSlackRenderFailure(active, "slack_main_update_failed", nextText, error);
      return;
    }
    renderState.lastRenderedMainText = nextText;
    renderState.lastUpdateAt = now;
  }

  private async updateMainNow(
    active: ActiveRun,
    renderState: RunRenderState,
  ): Promise<void> {
    const nextText = formatMainMessage({
      assistantText: renderState.currentAssistantText,
      progressText: renderState.progressText,
      statusLines: statusLinesFor(renderState),
    });
    if (nextText === renderState.lastRenderedMainText) {
      return;
    }

    try {
      await active.context.updateMain(nextText);
    } catch (error: unknown) {
      this.logSlackRenderFailure(active, "slack_main_update_failed", nextText, error);
      return;
    }
    renderState.lastRenderedMainText = nextText;
    renderState.lastUpdateAt = Date.now();
  }

  private async renderCompactionStartStatus(
    active: ActiveRun,
    renderState: RunRenderState,
    event: SessionCompactionStart,
  ): Promise<void> {
    appendProgressLine(renderState, formatCompactionStartStatus(event));
    await this.updateMainNow(active, renderState);
    allowImmediateRender(renderState);
  }

  private async renderCompactionStatus(
    active: ActiveRun,
    renderState: RunRenderState,
    result: SessionCompactionResult | undefined,
  ): Promise<void> {
    if (result?.triggered !== true) {
      return;
    }

    appendProgressLine(renderState, formatCompactionStatus(result));
    await this.updateMainNow(active, renderState);
    allowImmediateRender(renderState);
  }

  private createRealtimeCompactionHook(input: {
    readonly active: ActiveRun;
    readonly event: SlackEvent;
    readonly renderState: RunRenderState;
    readonly getPersistence: () => RunPersistenceState;
  }): RuntimeHook {
    return {
      beforeModelCall: async (context) => {
        if (input.active.control.cancelled) {
          return context.request;
        }

        const persistence = input.getPersistence();
        const currentUserMessage = currentRunUserMessage(
          context.request,
          persistence.prepared,
        );
        if (currentUserMessage === undefined) {
          return context.request;
        }

        const refreshed = await this.options.sessions.compactRunMessagesIfNeeded(
          persistence.prepared,
          input.event,
          currentUserMessage,
          {
            signal: input.active.control.signal,
            onCompactionStart: async (compaction) => {
              await this.renderCompactionStartStatus(
                input.active,
                input.renderState,
                compaction,
              );
            },
          },
        );
        if (refreshed.compaction?.triggered !== true) {
          return context.request;
        }

        await this.recordCompactionTrace(input.active, refreshed.compaction);
        await this.renderCompactionStatus(
          input.active,
          input.renderState,
          refreshed.compaction,
        );
        return requestWithSessionMessages(context.request, refreshed.messages);
      },
    };
  }

  private async prepareRepoWorkflow(
    key: ChannelSessionKey,
    signal: AbortSignal,
  ): Promise<RepoRunStartSnapshot | undefined> {
    if (this.options.repoWorkflow === undefined) {
      return undefined;
    }

    return this.options.repoWorkflow.prepareCodingTask(key, signal);
  }

  private async safePrepareRepoWorkflow(
    active: ActiveRun,
    key: ChannelSessionKey,
    signal: AbortSignal,
  ): Promise<RepoRunStartSnapshot | undefined | null> {
    try {
      return await this.prepareRepoWorkflow(key, signal);
    } catch (error: unknown) {
      await active.context.replaceMain(formatRepoWorkflowError(error));
      return null;
    }
  }

  private async summarizeRepoWorkflow(
    key: ChannelSessionKey,
    start: RepoRunStartSnapshot | undefined,
    signal: AbortSignal,
  ): Promise<RepoRunSummary | undefined> {
    if (this.options.repoWorkflow === undefined) {
      return undefined;
    }

    return this.options.repoWorkflow.summarizeCodingTask(key, start, signal);
  }

  private async resolveRunWorkspaceRoot(
    key: ChannelSessionKey,
    repoStart: RepoRunStartSnapshot | undefined,
  ): Promise<string | undefined> {
    if (repoStart !== undefined) {
      return repoStart.config.repoPath;
    }

    return this.options.resolveChannelWorkspaceRoot?.(key);
  }

  private agentLoopForRun(
    workspaceRoot: string | undefined,
    event: SlackEvent,
    runContext: AgentRunContext,
    workspaceSkills: readonly WorkspaceSkill[],
  ): MinimalAgentLoop {
    if (
      workspaceRoot !== undefined &&
      this.options.createAgentLoopForWorkspace !== undefined
    ) {
      return this.options.createAgentLoopForWorkspace(
        workspaceRoot,
        {
          conversation: replyConversationFor(event),
          requestedByUserId: event.senderUserId,
        },
        runContext,
        workspaceSkills,
      );
    }

    return this.options.agentLoop;
  }

  private async loadWorkspaceSkills(
    active: ActiveRun,
    workspaceRoot: string | undefined,
  ): Promise<readonly WorkspaceSkill[]> {
    if (workspaceRoot === undefined) {
      return [];
    }

    try {
      const result = await scanWorkspaceSkills(workspaceRoot, {
        ...(this.options.pibotSkillsRoot === undefined
          ? {}
          : { pibotSkillsRoot: this.options.pibotSkillsRoot }),
        ...(this.options.disabledSkills === undefined
          ? {}
          : { disabledSkills: this.options.disabledSkills }),
        ...(this.options.maxSkills === undefined
          ? {}
          : { maxSkills: this.options.maxSkills }),
        ...(this.options.maxSkillFileBytes === undefined
          ? {}
          : { maxSkillFileBytes: this.options.maxSkillFileBytes }),
      });
      for (const issue of result.issues) {
        this.logRun("warn", "skill_invalid", active, {
          skillLocation: issue.location,
          issueCode: issue.code,
          errorMessage: issue.message,
        });
      }
      return result.skills;
    } catch (error: unknown) {
      this.logRun("warn", "skill_scan_failed", active, errorFields(error));
      return [];
    }
  }

  private async loadAgentSelfInstructions(
    active: ActiveRun,
  ): Promise<string | undefined> {
    if (this.options.agentSelfInstructionsProvider === undefined) {
      return undefined;
    }

    try {
      const instructions = await this.options.agentSelfInstructionsProvider();
      const trimmed = instructions?.trim();
      return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
    } catch (error: unknown) {
      this.logRun("warn", "agent_self_instructions_load_failed", active, errorFields(error));
      return undefined;
    }
  }

  private async reportEvolutionFailureIfNeeded(
    active: ActiveRun,
    event: SlackEvent,
    reason: string,
    errorCode: string | undefined,
  ): Promise<void> {
    if (this.options.evolution === undefined || errorCode === undefined) {
      return;
    }
    if (reason === "cancelled" || errorCode === "aborted") {
      return;
    }

    try {
      const result = await this.options.evolution.reportRunFailure({
        runId: active.runId,
        channelId: active.channelId,
        userId: active.userId,
        messageTs: event.messageTs,
        reason,
        errorCode,
        durationMs: Date.now() - active.startedAt.getTime(),
      });
      if (result === undefined) {
        return;
      }
      const linkText = result.ticketUrl === undefined
        ? result.ticket.id
        : `${result.ticket.id} ${result.ticketUrl}`;
      await active.context.postThreadText(
        `Self-evolution ticket created: ${linkText}`,
      );
    } catch (error: unknown) {
      this.logRun("warn", "evolution_signal_failed", active, errorFields(error));
    }
  }

  private async recordUsage(
    active: ActiveRun,
    reason: string,
    errorCode: string | undefined,
    model: string | undefined,
    providerUsage: ModelUsage | undefined,
    usageInput:
      | {
          readonly systemPrompt: string;
          readonly history: readonly LlmMessage[];
          readonly userText: string;
        }
      | undefined,
    generatedMessages: readonly LlmMessage[],
  ): Promise<void> {
    const endedAt = new Date();
    const usage =
      providerUsage !== undefined
        ? calculateUsage(providerUsage, this.usagePricing)
        : usageInput === undefined
          ? calculateUsage(
              {
                inputTokens: 0,
                cachedInputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
              },
              this.usagePricing,
            )
          : estimateRunUsage({
              ...usageInput,
              generatedMessages,
              pricing: this.usagePricing,
            });

    try {
      await this.usageRecorder.recordUsage({
        runId: active.runId,
        channelId: active.channelId,
        userId: active.userId,
        startedAt: active.startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - active.startedAt.getTime(),
        ...optionalString("model", model),
        reason,
        ...optionalString("errorCode", errorCode),
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        uncachedInputTokens: usage.uncachedInputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        pricingStrategy: this.usagePricing.strategy,
        cost: usage.cost,
        currency: usage.currency,
        estimated: providerUsage === undefined,
      });
    } catch (error: unknown) {
      this.logRun("warn", "usage_record_failed", active, errorFields(error));
    }
  }

  private logRun(
    level: "info" | "warn" | "error",
    event: string,
    active: ActiveRun,
    fields: LogFields = {},
  ): void {
    this.logger[level](event, {
      runId: active.runId,
      channelId: active.channelId,
      userId: active.userId,
      ...fields,
    });
  }

  private logSlackRenderFailure(
    active: ActiveRun,
    event: string,
    text: string,
    error: unknown,
  ): void {
    this.logRun("warn", event, active, {
      textBytes: Buffer.byteLength(text, "utf8"),
      ...errorFields(error),
    });
  }

  private async replaceMainBestEffort(
    active: ActiveRun,
    text: string,
    phase: string,
  ): Promise<void> {
    try {
      await active.context.replaceMain(text);
      return;
    } catch (error: unknown) {
      this.logSlackRenderFailure(
        active,
        `slack_${phase}_replace_failed`,
        text,
        error,
      );
    }

    try {
      await active.context.postThreadText(`*${phase} response*\n\n${text}`);
    } catch (error: unknown) {
      this.logSlackRenderFailure(
        active,
        `slack_${phase}_thread_fallback_failed`,
        text,
        error,
      );
    }
  }

  private async recordTrace(
    active: ActiveRun,
    event: TraceEvent,
  ): Promise<void> {
    await this.traceRecorder.record(withRun(active.runtime, event)).catch((error: unknown) => {
      this.logRun("warn", "trace_record_failed", active, errorFields(error));
    });
  }

  private async recordCompactionTrace(
    active: ActiveRun,
    result: SessionCompactionResult | undefined,
  ): Promise<void> {
    if (result?.triggered !== true) {
      return;
    }
    await this.recordTrace(active, {
      type: "session.compacted",
      reason: result.reason,
      summaryStrategy: result.summaryStrategy,
      estimatedTokensBefore: result.estimatedTokensBefore,
      estimatedTokensAfter: result.estimatedTokensAfter,
      compactionTriggerTokens: result.compactionTriggerTokens,
      keepRecentTokens: result.keepRecentTokens,
      keptRecentTokens: result.keptRecentTokens,
      keptRecentMessages: result.keptRecentMessages,
      coveredThroughLineNumber: result.coveredThroughLineNumber,
      summaryUsage: result.summaryUsage,
      fallbackReason: result.fallbackReason,
    });
  }
}

export function isAgentStopCommand(text: string): boolean {
  return isRunStopCommand(text);
}

function createRunId(): AgentRunId {
  return randomUUID() as AgentRunId;
}

function finalAssistantText(messages: readonly LlmMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      return message.content;
    }
  }

  return "";
}

function optionalRepoSummaryText(
  summary: RepoRunSummary | undefined,
): string {
  if (summary === undefined) {
    return "";
  }

  return formatRepoRunSummary(summary);
}

function replyConversationFor(event: SlackEvent): SlackConversationRef {
  return {
    teamId: event.conversation.teamId,
    channelId: event.conversation.channelId,
    ...optionalThreadTs(event.conversation.threadTs),
  };
}

function optionalThreadTs(
  threadTs: SlackConversationRef["threadTs"],
): { readonly threadTs: NonNullable<SlackConversationRef["threadTs"]> } | object {
  if (threadTs === undefined) {
    return {};
  }

  return { threadTs };
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

function optionalNumber<Key extends string>(
  key: Key,
  value: number | undefined,
): { readonly [Property in Key]: number } | object {
  if (value === undefined) {
    return {};
  }

  return { [key]: value } as { readonly [Property in Key]: number };
}

function statusLinesFor(state: RunRenderState): readonly string[] {
  return state.longTaskStatusLine === undefined ? [] : [state.longTaskStatusLine];
}

function appendProgressText(state: RunRenderState, text: string): void {
  appendProgressChunk(state, text);
}

function allowImmediateRender(state: RunRenderState): void {
  state.lastUpdateAt = 0;
}

function appendReasoningProgressText(state: RunRenderState, text: string): void {
  const formatted = formatReasoningDeltaForProgress(state, text);
  if (formatted.length === 0) {
    return;
  }

  appendProgressText(state, formatted);
}

function appendProgressLine(state: RunRenderState, line: string): void {
  const prefix =
    state.progressText.length === 0 || state.progressText.endsWith("\n")
      ? ""
      : "\n";
  appendProgressChunk(state, `${prefix}${line}\n`);
}

function formatCompactionStartStatus(event: SessionCompactionStart): string {
  const reason =
    event.reason === "context_overflow"
      ? "Compacting context after overflow"
      : "Compacting context now";
  return `_${reason}: ${formatTokenCount(event.estimatedTokensBefore)} in history._`;
}

function formatCompactionStatus(result: SessionCompactionResult): string {
  const reason =
    result.reason === "context_overflow"
      ? "Context compacted after overflow"
      : "Context compacted";
  const before = formatTokenCount(result.estimatedTokensBefore);
  const after =
    result.estimatedTokensAfter === undefined
      ? undefined
      : formatTokenCount(result.estimatedTokensAfter);
  const kept =
    result.keptRecentMessages === undefined
      ? undefined
      : `${result.keptRecentMessages} recent messages kept`;
  const details = [after === undefined ? before : `${before} -> ${after}`, kept]
    .filter((part): part is string => part !== undefined)
    .join("; ");
  return details.length === 0 ? `_${reason}._` : `_${reason}: ${details}._`;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    return `${Math.round(tokens / 100) / 10}k tokens`;
  }

  return `${tokens} tokens`;
}

const PROGRESS_WINDOW_BYTES = 2200;
const PROGRESS_CLEAR_NOTICE_PREFIX = "_Earlier progress cleared to keep Slack readable";

function appendProgressChunk(state: RunRenderState, chunk: string): void {
  if (chunk.length === 0) {
    return;
  }

  const normalizedChunk = clampProgressChunk(chunk);
  if (
    Buffer.byteLength(state.progressText, "utf8") +
      Buffer.byteLength(normalizedChunk, "utf8") >
    PROGRESS_WINDOW_BYTES
  ) {
    state.progressResetCount += 1;
    state.progressText =
      `${PROGRESS_CLEAR_NOTICE_PREFIX} (${state.progressResetCount})._\n`;
    state.lastProgressWasOmission = false;
  }

  state.progressText += normalizedChunk;
}

function clampProgressChunk(chunk: string): string {
  if (Buffer.byteLength(chunk, "utf8") <= PROGRESS_WINDOW_BYTES) {
    return chunk;
  }

  const suffix = "\n...";
  return `${sliceUtf8(chunk, PROGRESS_WINDOW_BYTES - Buffer.byteLength(suffix, "utf8"))}${suffix}`;
}

function formatReasoningDeltaForProgress(
  state: RunRenderState,
  text: string,
): string {
  const output: string[] = [];
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      state.insideProgressCodeBlock = !state.insideProgressCodeBlock;
      appendProgressOmission(state, output);
      continue;
    }

    if (state.insideProgressCodeBlock || looksLikeCodeOrFileLine(trimmed)) {
      appendProgressOmission(state, output);
      continue;
    }

    if (trimmed.length === 0) {
      output.push(line);
      continue;
    }

    state.lastProgressWasOmission = false;
    output.push(truncateProgressLine(line));
  }

  return truncateProgressDelta(output.join("\n"));
}

function appendProgressOmission(
  state: RunRenderState,
  output: string[],
): void {
  if (state.lastProgressWasOmission) {
    return;
  }

  output.push("[code/content omitted]");
  state.lastProgressWasOmission = true;
}

function looksLikeCodeOrFileLine(trimmed: string): boolean {
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.length > 220) {
    return true;
  }
  if (/^(?:diff --git|@@|\+\+\+|---)/u.test(trimmed)) {
    return true;
  }
  if (/^(?:import|from|def|class|function|const|let|var|export|return|if|for|while|try|except|async|await|interface|type)\b/u.test(trimmed)) {
    return true;
  }
  if (/^[+-]\s*(?:import|from|def|class|function|const|let|var|export|return|if|for|while|async|await)\b/u.test(trimmed)) {
    return true;
  }

  return /[{};]/u.test(trimmed) && /(?:=>|=|:|\(|\))/u.test(trimmed);
}

function truncateProgressLine(line: string): string {
  return line.length <= 180 ? line : `${line.slice(0, 180)}...`;
}

function truncateProgressDelta(text: string): string {
  return text.length <= 700 ? text : `${text.slice(0, 700)}...`;
}

function sliceUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  if (low > 0 && low < text.length) {
    const previous = text.charCodeAt(low - 1);
    const next = text.charCodeAt(low);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      return text.slice(0, low - 1);
    }
  }

  return text.slice(0, low);
}

function currentRunUserMessage(
  request: ModelRequest,
  prepared: PreparedChannelRunContext,
): LlmMessage | undefined {
  const message = request.messages[prepared.history.length + 1];
  return message?.role === "user" ? message : undefined;
}

function requestWithSessionMessages(
  request: ModelRequest,
  messages: readonly LlmMessage[],
): ModelRequest {
  const leadingSystemMessages: LlmMessage[] = [];
  for (const message of request.messages) {
    if (message.role !== "system") {
      break;
    }
    leadingSystemMessages.push(message);
  }

  return {
    ...request,
    messages: [...leadingSystemMessages, ...messages],
  };
}

function optionalModelUsage(
  usage: ModelUsage | undefined,
): { readonly usage: ModelUsage } | object {
  return usage === undefined ? {} : { usage };
}

function optionalAgentLoopError(
  error: AgentLoopResult["error"],
): { readonly error: NonNullable<AgentLoopResult["error"]> } | object {
  return error === undefined ? {} : { error };
}

function addModelUsage(
  left: ModelUsage | undefined,
  right: ModelUsage | undefined,
): ModelUsage | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function stripSystemMessages(
  messages: readonly LlmMessage[],
): readonly LlmMessage[] {
  return messages.filter((message) => message.role !== "system");
}
