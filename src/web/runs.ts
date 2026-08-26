import type { AppLogger } from "../app/logging";
import { fingerprintCanonical, fingerprintError } from "../workflow/fingerprints";
import type { WorkflowOrchestrator } from "../workflow/orchestrator";
import type {
  WorkflowEventRecord,
  WorkflowRunRecord,
} from "../workflow/types";
import type { EvolutionController } from "../evolution/controller";
import type { WebAgentRunner, WebAgentRunnerEvent } from "./agent";

export interface DetachedWebRunServiceOptions {
  readonly agent: WebAgentRunner;
  readonly evolution: EvolutionController;
  readonly workflows: WorkflowOrchestrator;
  readonly logger?: AppLogger;
}

type DetachedRunListener = (event: WorkflowEventRecord) => void;

interface ActiveDetachedRun {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

export interface DetachedRunSubmission {
  readonly run: WorkflowRunRecord;
  readonly eventCursor: number;
}

export class DetachedWebRunService {
  private readonly active = new Map<string, ActiveDetachedRun>();
  private readonly listeners = new Map<string, Set<DetachedRunListener>>();

  constructor(private readonly options: DetachedWebRunServiceOptions) {}

  async submitConversation(input: {
    readonly conversationId: string;
    readonly content: string;
  }): Promise<DetachedRunSubmission> {
    const run = await this.options.workflows.ensureRun({
      kind: "web_conversation",
      lifecycle: "detached",
      metadata: {
        conversationId: input.conversationId,
        source: "webui",
      },
      versions: {
        workflowVersion: "web-detached-conversation-v1",
        agentVersion: process.env.PIBOT_AGENT_VERSION ?? "webui-agent-v1",
      },
      budget: {
        maxTotalAttempts: 2,
        maxAttemptsPerStep: 2,
        maxCallsPerEdge: 1,
      },
    });
    await this.options.workflows.ensureStep({
      runId: run.runId,
      stepId: "agent_run",
      kind: "agent_conversation",
    });
    const eventCursor = await this.latestEventSequence(run.runId);
    this.start(run.runId, async (signal) => {
      let recovery = false;
      let triggerErrorFingerprint: string | undefined;
      let message = input.content;
      while (true) {
        const completedToolCallFingerprints = await this.completedToolFingerprints(
          run.runId,
          "agent_run",
        );
        const admission = await this.options.workflows.beginAttempt({
          runId: run.runId,
          stepId: "agent_run",
          strategy: recovery
            ? {
                type: "resume_from_tool_checkpoint",
                conversationId: input.conversationId,
                completedToolCallFingerprints,
              }
            : {
                type: "respond_to_user_message",
                conversationId: input.conversationId,
              },
          ...(triggerErrorFingerprint === undefined
            ? {}
            : {
                triggerErrorFingerprint,
                edgeKey: "model_stream.resume",
                circuitKey: fingerprintCanonical({
                  workflowKind: "web_conversation",
                  stepKind: "agent_conversation",
                  triggerErrorFingerprint,
                }),
              }),
        });
        if (!admission.allowed || admission.attempt === undefined) {
          await this.appendWebEvent(run.runId, {
            type: "status",
            conversationId: input.conversationId,
            message: `Workflow blocked: ${admission.reason ?? "attempt rejected"}`,
          });
          await this.appendTerminalError(
            run.runId,
            admission.reason ?? "Workflow attempt rejected",
          );
          return;
        }
        try {
          const result = await this.options.agent.runUserMessage(
            input.conversationId,
            message,
            {
              signal,
              onEvent: (event) => this.appendWebEvent(run.runId, event),
              completedToolCallFingerprints,
              failureMemoryPolicy: "experience",
            },
          );
          if (signal.aborted || result.reason === "aborted") {
            await this.options.workflows.cancelRun(run.runId);
            await this.appendTerminalError(run.runId, "Run cancelled.");
            return;
          }
          const success = result.reason === "completed" && result.errorCode === undefined;
          const resultFingerprint = success
            ? undefined
            : fingerprintError({
                stepKind: "agent_conversation",
                errorCode: result.errorCode ?? result.reason,
                message: result.errorCode ?? result.reason,
              });
          await this.options.workflows.finishAttempt({
            runId: run.runId,
            attemptId: admission.attempt.attemptId,
            success,
            ...(resultFingerprint === undefined
              ? {}
              : { resultErrorFingerprint: resultFingerprint }),
            summary: success
              ? "Detached conversation completed."
              : `Detached conversation ended with ${result.errorCode ?? result.reason}.`,
          });
          if (!success && !recovery && result.errorCode === "model_error") {
            recovery = true;
            triggerErrorFingerprint = resultFingerprint;
            message = formatCheckpointRecoveryPrompt(
              await this.completedToolFingerprints(run.runId, "agent_run"),
            );
            await this.appendWebEvent(run.runId, {
              type: "status",
              conversationId: input.conversationId,
              message:
                "Model stream ended. Replanning from the latest completed-tool checkpoint...",
            });
            continue;
          }
          await this.appendWebEvent(run.runId, {
            type: "done",
            run: result,
            conversation: await this.options.agent.getConversation(input.conversationId),
          });
          return;
        } catch (error: unknown) {
          if (signal.aborted) {
            await this.options.workflows.cancelRun(run.runId).catch(() => undefined);
            await this.appendTerminalError(run.runId, "Run cancelled.");
            return;
          }
          const errorMessage = error instanceof Error ? error.message : String(error);
          await this.options.workflows.finishAttempt({
            runId: run.runId,
            attemptId: admission.attempt.attemptId,
            success: false,
            resultErrorFingerprint: fingerprintError({
              stepKind: "agent_conversation",
              errorCode: error instanceof Error ? error.name : "exception",
              message: errorMessage,
            }),
            summary: errorMessage,
          }).catch(() => undefined);
          await this.appendTerminalError(run.runId, errorMessage);
          return;
        }
      }
    });
    return { run, eventCursor };
  }

  async submitEvolutionImplementation(ticketId: string): Promise<DetachedRunSubmission> {
    const run = await this.options.workflows.ensureRun({
      externalKey: `evolution-ticket:${ticketId}`,
      kind: "evolution_implementation",
      lifecycle: "detached",
      metadata: { ticketId, source: "webui" },
      versions: {
        workflowVersion: "evolution-implementation-v1",
        agentVersion: process.env.PIBOT_AGENT_VERSION ?? "webui-evolution-agent-v1",
      },
    });
    const eventCursor = await this.latestEventSequence(run.runId);
    if (!this.active.has(run.runId)) {
      this.start(run.runId, async (signal) => {
        try {
          const result = await this.options.agent.runEvolutionTicketImplementation(
            ticketId,
            {
              signal,
              onEvent: (event) => this.appendWebEvent(run.runId, event),
              failureMemoryPolicy: "experience",
            },
          );
          if (signal.aborted) {
            await this.options.workflows.cancelRun(run.runId);
            await this.appendTerminalError(run.runId, "Run cancelled.");
            return;
          }
          await this.appendWebEvent(run.runId, {
            type: "done",
            run: result,
            evolution: await this.options.evolution.readSnapshot(),
          });
        } catch (error: unknown) {
          if (signal.aborted) {
            await this.options.workflows.cancelRun(run.runId).catch(() => undefined);
            await this.appendTerminalError(run.runId, "Run cancelled.");
            return;
          }
          await this.appendTerminalError(
            run.runId,
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    }
    return { run, eventCursor };
  }

  readRun(runId: string): Promise<WorkflowRunRecord> {
    return this.options.workflows.store.readRun(runId);
  }

  readEvents(runId: string, afterSeq = 0): Promise<readonly WorkflowEventRecord[]> {
    return this.options.workflows.store.readEvents(runId, afterSeq);
  }

  subscribe(runId: string, listener: DetachedRunListener): () => void {
    const listeners = this.listeners.get(runId) ?? new Set<DetachedRunListener>();
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(runId);
      }
    };
  }

  async cancel(runId: string): Promise<WorkflowRunRecord> {
    this.active.get(runId)?.controller.abort();
    return this.options.workflows.cancelRun(runId);
  }

  appendEvent(
    runId: string,
    event: WebAgentRunnerEvent | DetachedTerminalEvent,
  ): Promise<void> {
    return this.appendWebEvent(runId, event);
  }

  private start(
    runId: string,
    work: (signal: AbortSignal) => Promise<void>,
  ): void {
    if (this.active.has(runId)) {
      return;
    }
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => work(controller.signal))
      .catch((error: unknown) => {
        this.options.logger?.warn("detached_web_run_failed", {
          runId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.active.delete(runId);
      });
    this.active.set(runId, { controller, promise });
  }

  private async appendWebEvent(
    runId: string,
    event: WebAgentRunnerEvent | DetachedTerminalEvent,
  ): Promise<void> {
    await this.checkpointCompletedTool(runId, event);
    const stored = await this.options.workflows.store.appendEvent({
      runId,
      type: "web.event",
      payload: { event },
    });
    this.publish(stored);
  }

  private appendTerminalError(runId: string, error: string): Promise<void> {
    return this.appendWebEvent(runId, { type: "error", error });
  }

  private publish(event: WorkflowEventRecord): void {
    for (const listener of this.listeners.get(event.runId) ?? []) {
      try {
        listener(event);
      } catch {
        // A stale client subscriber must never fail the detached run.
      }
    }
  }

  private async latestEventSequence(runId: string): Promise<number> {
    return (await this.readEvents(runId)).at(-1)?.seq ?? 0;
  }

  private async checkpointCompletedTool(
    runId: string,
    event: WebAgentRunnerEvent | DetachedTerminalEvent,
  ): Promise<void> {
    if (
      event.type !== "agent_event" ||
      event.event.type !== "tool_end" ||
      !event.event.result.ok
    ) {
      return;
    }
    const steps = await this.options.workflows.store.readSteps(runId);
    const step = steps.find((candidate) => candidate.status === "running") ??
      steps.at(-1);
    if (step === undefined) {
      return;
    }
    const completed = await this.completedToolFingerprints(runId, step.stepId);
    const next = completed.includes(event.event.call.fingerprint)
      ? completed
      : [...completed, event.event.call.fingerprint];
    await this.options.workflows.recordStepCheckpoint({
      runId,
      stepId: step.stepId,
      checkpoint: {
        completedToolCallFingerprints: next,
        lastCompletedTool: {
          callId: event.event.call.id,
          name: event.event.call.name,
          fingerprint: event.event.call.fingerprint,
          resultSummary: event.event.result.summary,
        },
      },
    });
  }

  private async completedToolFingerprints(
    runId: string,
    stepId: string,
  ): Promise<readonly string[]> {
    const step = (await this.options.workflows.store.readSteps(runId))
      .find((candidate) => candidate.stepId === stepId);
    const values = step?.checkpoint?.["completedToolCallFingerprints"];
    return Array.isArray(values)
      ? values.filter((value): value is string => typeof value === "string")
      : [];
  }
}

type DetachedTerminalEvent =
  | {
      readonly type: "done";
      readonly run: unknown;
      readonly conversation?: unknown;
      readonly evolution?: unknown;
    }
  | {
      readonly type: "error";
      readonly error: string;
    };

function formatCheckpointRecoveryPrompt(
  completedToolCallFingerprints: readonly string[],
): string {
  const completed = completedToolCallFingerprints.length === 0
    ? "- 无已完成工具步骤。"
    : completedToolCallFingerprints
      .map((fingerprint) => `- ${fingerprint}`)
      .join("\n");
  return [
    "上一次模型流已中断。请基于会话中已经持久化的工具结果重新规划并继续任务。",
    "不要尝试从某个 token 续传，也不要重复执行以下完全相同的工具动作：",
    completed,
  ].join("\n");
}
