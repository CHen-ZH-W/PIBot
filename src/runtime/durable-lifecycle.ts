import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import * as path from "node:path";
import type {
  AgentId,
  AgentRunId,
  AgentStepId,
  AgentUserTurnId,
  ToolCallId,
} from "../core/ids";
import {
  combineRecoveryDispositions,
  type RecoveryDisposition,
} from "../core/recovery";
import type { ToolCall, ToolMetadata, ToolResult } from "../core/tools";
import type { AgentStepContext } from "./context";

export type DurableLifecycleEventType =
  | "run.opened"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.interrupted"
  | "turn.opened"
  | "turn.completed"
  | "turn.failed"
  | "turn.cancelled"
  | "turn.interrupted"
  | "step.opened"
  | "step.completed"
  | "step.failed"
  | "step.cancelled"
  | "step.interrupted"
  | "tool.prepared"
  | "tool.dispatched"
  | "tool.completed"
  | "tool.failed"
  | "tool.cancelled"
  | "tool.interrupted";

export interface DurableLifecycleEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly seq: number;
  readonly type: DurableLifecycleEventType;
  readonly ts: string;
  readonly runId: AgentRunId;
  readonly userTurnId?: AgentUserTurnId;
  readonly stepId?: AgentStepId;
  readonly callId?: ToolCallId;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface DurableLifecycleRecoveryEntity {
  readonly runId: AgentRunId;
  readonly userTurnId?: AgentUserTurnId;
  readonly stepId?: AgentStepId;
  readonly callId?: ToolCallId;
  readonly disposition: RecoveryDisposition;
}

export interface DurableLifecycleRecoveryReport {
  readonly recoveredRuns: number;
  readonly interruptedTurns: number;
  readonly interruptedSteps: number;
  readonly interruptedTools: number;
  readonly entities: readonly DurableLifecycleRecoveryEntity[];
}

export interface DurableLifecycleAuthority {
  openRun(input: {
    readonly runId: AgentRunId;
    readonly scope: string;
    readonly agentId: AgentId;
    readonly parentRunId?: AgentRunId;
  }): Promise<void>;
  finishRun(input: {
    readonly runId: AgentRunId;
    readonly status: "completed" | "failed" | "cancelled";
    readonly reason?: string;
  }): Promise<void>;
  openUserTurn(input: {
    readonly runId: AgentRunId;
    readonly userTurnId: AgentUserTurnId;
  }): Promise<void>;
  finishUserTurn(input: {
    readonly runId: AgentRunId;
    readonly userTurnId: AgentUserTurnId;
    readonly status: "completed" | "failed" | "cancelled";
    readonly reason?: string;
  }): Promise<void>;
  openStep(context: AgentStepContext): Promise<void>;
  finishStep(input: {
    readonly runId: AgentRunId;
    readonly userTurnId: AgentUserTurnId;
    readonly stepId: AgentStepId;
    readonly status: "completed" | "failed" | "cancelled";
    readonly reason?: string;
  }): Promise<void>;
  prepareTool(input: {
    readonly context: AgentStepContext;
    readonly call: ToolCall;
    readonly metadata?: ToolMetadata;
  }): Promise<void>;
  markToolDispatched(input: {
    readonly context: AgentStepContext;
    readonly call: ToolCall;
  }): Promise<void>;
  finishTool(input: {
    readonly context: AgentStepContext;
    readonly call: ToolCall;
    readonly result: ToolResult;
  }): Promise<void>;
}

export interface FileDurableLifecycleOptions {
  readonly rootDir: string;
  readonly maxJournalBytes?: number;
}

export class FileDurableLifecycleAuthority
  implements DurableLifecycleAuthority {
  private readonly rootDir: string;
  private readonly maxJournalBytes: number;
  private queue: Promise<void> = Promise.resolve();
  private readonly nextSequence = new Map<string, number>();

  constructor(options: FileDurableLifecycleOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.maxJournalBytes = positiveInteger(
      options.maxJournalBytes,
      20_000_000,
      "maxJournalBytes",
    );
  }

  openRun(input: {
    readonly runId: AgentRunId;
    readonly scope: string;
    readonly agentId: AgentId;
    readonly parentRunId?: AgentRunId;
  }): Promise<void> {
    return this.append({
      type: "run.opened",
      runId: input.runId,
      payload: {
        scope: input.scope,
        agentId: input.agentId,
        ...(input.parentRunId === undefined
          ? {}
          : { parentRunId: input.parentRunId }),
      },
    });
  }

  finishRun(input: {
    readonly runId: AgentRunId;
    readonly status: "completed" | "failed" | "cancelled";
    readonly reason?: string;
  }): Promise<void> {
    return this.append({
      type: `run.${input.status}`,
      runId: input.runId,
      payload: optionalReason(input.reason),
    });
  }

  openUserTurn(input: {
    readonly runId: AgentRunId;
    readonly userTurnId: AgentUserTurnId;
  }): Promise<void> {
    return this.append({
      type: "turn.opened",
      runId: input.runId,
      userTurnId: input.userTurnId,
    });
  }

  finishUserTurn(input: {
    readonly runId: AgentRunId;
    readonly userTurnId: AgentUserTurnId;
    readonly status: "completed" | "failed" | "cancelled";
    readonly reason?: string;
  }): Promise<void> {
    return this.append({
      type: `turn.${input.status}`,
      runId: input.runId,
      userTurnId: input.userTurnId,
      payload: optionalReason(input.reason),
    });
  }

  openStep(context: AgentStepContext): Promise<void> {
    return this.append({
      type: "step.opened",
      runId: context.runId,
      userTurnId: context.userTurnId,
      stepId: context.stepId,
      payload: {
        step: context.step,
        mode: context.mode,
        stateVersion: context.stateVersion,
        snapshotFingerprint: fingerprintValue(context.snapshot),
        ...(context.model === undefined ? {} : { model: context.model }),
      },
    });
  }

  finishStep(input: {
    readonly runId: AgentRunId;
    readonly userTurnId: AgentUserTurnId;
    readonly stepId: AgentStepId;
    readonly status: "completed" | "failed" | "cancelled";
    readonly reason?: string;
  }): Promise<void> {
    return this.append({
      type: `step.${input.status}`,
      runId: input.runId,
      userTurnId: input.userTurnId,
      stepId: input.stepId,
      payload: optionalReason(input.reason),
    });
  }

  prepareTool(input: {
    readonly context: AgentStepContext;
    readonly call: ToolCall;
    readonly metadata?: ToolMetadata;
  }): Promise<void> {
    const policy = recoveryPolicyFor(input.metadata);
    return this.append({
      type: "tool.prepared",
      runId: input.context.runId,
      userTurnId: input.context.userTurnId,
      stepId: input.context.stepId,
      callId: input.call.id,
      payload: {
        tool: input.call.name,
        callFingerprint: fingerprintValue({
          name: input.call.name,
          input: input.call.input,
        }),
        recoveryPolicy: policy,
        ...(policy === "resumable"
          ? {
              idempotencyKey: [
                input.context.runId,
                input.context.stepId,
                input.call.id,
              ].join("/"),
            }
          : {}),
      },
    });
  }

  markToolDispatched(input: {
    readonly context: AgentStepContext;
    readonly call: ToolCall;
  }): Promise<void> {
    return this.append({
      type: "tool.dispatched",
      runId: input.context.runId,
      userTurnId: input.context.userTurnId,
      stepId: input.context.stepId,
      callId: input.call.id,
      payload: { tool: input.call.name },
    });
  }

  finishTool(input: {
    readonly context: AgentStepContext;
    readonly call: ToolCall;
    readonly result: ToolResult;
  }): Promise<void> {
    const cancelled = !input.result.ok && input.result.error.code === "aborted";
    return this.append({
      type: input.result.ok
        ? "tool.completed"
        : cancelled
          ? "tool.cancelled"
          : "tool.failed",
      runId: input.context.runId,
      userTurnId: input.context.userTurnId,
      stepId: input.context.stepId,
      callId: input.call.id,
      payload: {
        tool: input.call.name,
        outcome: input.result.ok ? "success" : "error",
        resultFingerprint: fingerprintValue(input.result),
        ...(!input.result.ok
          ? {
              errorCode: input.result.error.code,
              retryable: input.result.error.retryable,
            }
          : {}),
      },
    });
  }

  async readEvents(runId: AgentRunId): Promise<readonly DurableLifecycleEvent[]> {
    return readJsonl<DurableLifecycleEvent>(this.journalFile(runId));
  }

  async recoverInterrupted(
    reason = "runtime_restarted",
  ): Promise<DurableLifecycleRecoveryReport> {
    return this.enqueue(async () => {
      const entities: DurableLifecycleRecoveryEntity[] = [];
      let recoveredRuns = 0;
      let interruptedTurns = 0;
      let interruptedSteps = 0;
      let interruptedTools = 0;
      for (const runIdValue of await readDirectoryNames(this.runsDir())) {
        const events = await readJsonl<DurableLifecycleEvent>(
          path.join(this.runsDir(), runIdValue, "lifecycle.jsonl"),
        );
        if (events.length === 0) continue;
        const aggregate = aggregateLifecycle(events);
        const runId = aggregate.runId;
        const openTools = [...aggregate.tools.values()].filter((tool) => tool.open);
        const toolDispositions = new Map<string, RecoveryDisposition>();
        for (const tool of openTools) {
          const disposition = tool.dispatched
            ? tool.policy
            : "retry-safe";
          toolDispositions.set(tool.key, disposition);
          await this.appendUnlocked({
            type: "tool.interrupted",
            runId,
            userTurnId: tool.userTurnId,
            stepId: tool.stepId,
            callId: tool.callId,
            payload: {
              reason,
              phase: tool.dispatched ? "dispatched" : "prepared",
              recoveryDisposition: disposition,
            },
          });
          interruptedTools += 1;
          entities.push({
            runId,
            userTurnId: tool.userTurnId,
            stepId: tool.stepId,
            callId: tool.callId,
            disposition,
          });
        }
        const openToolStepKeys = new Set(
          openTools.map((tool) => `${tool.userTurnId}/${tool.stepId}`),
        );
        const openSteps = [...aggregate.steps.values()].filter((step) =>
          step.open || openToolStepKeys.has(step.key));
        const stepDispositions = new Map<string, RecoveryDisposition>();
        for (const step of openSteps) {
          const dispositions = openTools
            .filter((tool) => tool.stepId === step.stepId)
            .map((tool) => toolDispositions.get(tool.key) ?? "retry-safe");
          const disposition = combineRecoveryDispositions(dispositions);
          stepDispositions.set(step.key, disposition);
          await this.appendUnlocked({
            type: "step.interrupted",
            runId,
            userTurnId: step.userTurnId,
            stepId: step.stepId,
            payload: { reason, recoveryDisposition: disposition },
          });
          interruptedSteps += 1;
          entities.push({
            runId,
            userTurnId: step.userTurnId,
            stepId: step.stepId,
            disposition,
          });
        }
        const openStepTurnKeys = new Set(
          openSteps.map((step) => String(step.userTurnId)),
        );
        const openTurns = [...aggregate.turns.values()].filter((turn) =>
          turn.open || openStepTurnKeys.has(turn.key));
        const turnDispositions = new Map<string, RecoveryDisposition>();
        for (const turn of openTurns) {
          const dispositions = openSteps
            .filter((step) => step.userTurnId === turn.userTurnId)
            .map((step) => stepDispositions.get(step.key) ?? "retry-safe");
          const disposition = combineRecoveryDispositions(dispositions);
          turnDispositions.set(turn.key, disposition);
          await this.appendUnlocked({
            type: "turn.interrupted",
            runId,
            userTurnId: turn.userTurnId,
            payload: { reason, recoveryDisposition: disposition },
          });
          interruptedTurns += 1;
          entities.push({ runId, userTurnId: turn.userTurnId, disposition });
        }
        if (
          aggregate.runOpen ||
          openTools.length > 0 ||
          openSteps.length > 0 ||
          openTurns.length > 0
        ) {
          const dispositions = [
            ...openTurns.map((turn) =>
              turnDispositions.get(turn.key) ?? "retry-safe"),
            ...openSteps.map((step) =>
              stepDispositions.get(step.key) ?? "retry-safe"),
          ];
          const disposition = combineRecoveryDispositions(dispositions);
          await this.appendUnlocked({
            type: "run.interrupted",
            runId,
            payload: { reason, recoveryDisposition: disposition },
          });
          recoveredRuns += 1;
          entities.push({ runId, disposition });
        }
      }
      return {
        recoveredRuns,
        interruptedTurns,
        interruptedSteps,
        interruptedTools,
        entities,
      };
    });
  }

  private append(input: LifecycleEventInput): Promise<void> {
    return this.enqueue(() => this.appendUnlocked(input));
  }

  private async appendUnlocked(input: LifecycleEventInput): Promise<void> {
    const runKey = String(input.runId);
    const seq = await this.nextSeq(runKey);
    const event: DurableLifecycleEvent = {
      schemaVersion: 1,
      eventId: randomUUID(),
      seq,
      type: input.type,
      ts: new Date().toISOString(),
      runId: input.runId,
      ...(input.userTurnId === undefined
        ? {}
        : { userTurnId: input.userTurnId }),
      ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
      ...(input.callId === undefined ? {} : { callId: input.callId }),
      payload: input.payload ?? {},
    };
    await appendDurably(
      this.journalFile(input.runId),
      `${JSON.stringify(event)}\n`,
      this.maxJournalBytes,
    );
    this.nextSequence.set(runKey, seq + 1);
  }

  private async nextSeq(runKey: string): Promise<number> {
    const cached = this.nextSequence.get(runKey);
    if (cached !== undefined) return cached;
    const events = await this.readEvents(runKey as AgentRunId);
    const next = (events.at(-1)?.seq ?? 0) + 1;
    this.nextSequence.set(runKey, next);
    return next;
  }

  private runsDir(): string {
    return path.join(this.rootDir, "runs");
  }

  private journalFile(runId: AgentRunId): string {
    return path.join(this.runsDir(), safeSegment(runId), "lifecycle.jsonl");
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

interface LifecycleEventInput {
  readonly type: DurableLifecycleEventType;
  readonly runId: AgentRunId;
  readonly userTurnId?: AgentUserTurnId;
  readonly stepId?: AgentStepId;
  readonly callId?: ToolCallId;
  readonly payload?: Readonly<Record<string, unknown>>;
}

interface ToolAggregate {
  readonly key: string;
  readonly userTurnId: AgentUserTurnId;
  readonly stepId: AgentStepId;
  readonly callId: ToolCallId;
  open: boolean;
  dispatched: boolean;
  policy: RecoveryDisposition;
}

interface StepAggregate {
  readonly key: string;
  readonly userTurnId: AgentUserTurnId;
  readonly stepId: AgentStepId;
  open: boolean;
}

interface TurnAggregate {
  readonly key: string;
  readonly userTurnId: AgentUserTurnId;
  open: boolean;
}

function aggregateLifecycle(events: readonly DurableLifecycleEvent[]): {
  readonly runId: AgentRunId;
  readonly runOpen: boolean;
  readonly turns: ReadonlyMap<string, TurnAggregate>;
  readonly steps: ReadonlyMap<string, StepAggregate>;
  readonly tools: ReadonlyMap<string, ToolAggregate>;
} {
  const runId = events[0]?.runId;
  if (runId === undefined) {
    throw new Error("Cannot aggregate an empty lifecycle journal");
  }
  let runOpen = false;
  const turns = new Map<string, TurnAggregate>();
  const steps = new Map<string, StepAggregate>();
  const tools = new Map<string, ToolAggregate>();
  for (const event of events) {
    if (event.type === "run.opened") runOpen = true;
    if (isRunTerminal(event.type)) runOpen = false;
    if (event.userTurnId !== undefined) {
      const key = String(event.userTurnId);
      const turn = turns.get(key) ?? {
        key,
        userTurnId: event.userTurnId,
        open: false,
      };
      if (event.type === "turn.opened") turn.open = true;
      if (isTurnTerminal(event.type)) turn.open = false;
      turns.set(key, turn);
    }
    if (event.userTurnId !== undefined && event.stepId !== undefined) {
      const key = `${event.userTurnId}/${event.stepId}`;
      const step = steps.get(key) ?? {
        key,
        userTurnId: event.userTurnId,
        stepId: event.stepId,
        open: false,
      };
      if (event.type === "step.opened") step.open = true;
      if (isStepTerminal(event.type)) step.open = false;
      steps.set(key, step);
    }
    if (
      event.userTurnId !== undefined &&
      event.stepId !== undefined &&
      event.callId !== undefined
    ) {
      const key = `${event.userTurnId}/${event.stepId}/${event.callId}`;
      const existing = tools.get(key) ?? {
        key,
        userTurnId: event.userTurnId,
        stepId: event.stepId,
        callId: event.callId,
        open: false,
        dispatched: false,
        policy: "needs-reconciliation" as const,
      };
      if (event.type === "tool.prepared") {
        existing.open = true;
        const policy = event.payload["recoveryPolicy"];
        existing.policy = isDisposition(policy)
          ? policy
          : "needs-reconciliation";
      }
      if (event.type === "tool.dispatched") existing.dispatched = true;
      if (isToolTerminal(event.type)) existing.open = false;
      tools.set(key, existing);
    }
  }
  return { runId, runOpen, turns, steps, tools };
}

function recoveryPolicyFor(metadata: ToolMetadata | undefined): RecoveryDisposition {
  return metadata?.recoveryPolicy ??
    (metadata?.riskLevel === "read-only"
      ? "retry-safe"
      : "needs-reconciliation");
}

function isDisposition(value: unknown): value is RecoveryDisposition {
  return value === "retry-safe" ||
    value === "resumable" ||
    value === "needs-reconciliation" ||
    value === "terminal-failed";
}

function isRunTerminal(type: DurableLifecycleEventType): boolean {
  return type === "run.completed" ||
    type === "run.failed" ||
    type === "run.cancelled" ||
    type === "run.interrupted";
}

function isTurnTerminal(type: DurableLifecycleEventType): boolean {
  return type === "turn.completed" ||
    type === "turn.failed" ||
    type === "turn.cancelled" ||
    type === "turn.interrupted";
}

function isStepTerminal(type: DurableLifecycleEventType): boolean {
  return type === "step.completed" ||
    type === "step.failed" ||
    type === "step.cancelled" ||
    type === "step.interrupted";
}

function isToolTerminal(type: DurableLifecycleEventType): boolean {
  return type === "tool.completed" ||
    type === "tool.failed" ||
    type === "tool.cancelled" ||
    type === "tool.interrupted";
}

async function appendDurably(
  filePath: string,
  line: string,
  maxBytes: number,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await repairJsonlTail(filePath);
  const currentBytes = await fileSizeIfExists(filePath);
  if (currentBytes + Buffer.byteLength(line, "utf8") > maxBytes) {
    throw new Error(`Lifecycle journal exceeds maximum size: ${filePath}`);
  }
  const handle = await open(filePath, "a");
  try {
    await handle.writeFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(filePath));
}

async function repairJsonlTail(filePath: string): Promise<void> {
  let content: Buffer;
  try {
    content = await readFile(filePath);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  if (content.length === 0 || content.at(-1) === 0x0a) return;
  const lastNewline = content.lastIndexOf(0x0a);
  const tailStart = lastNewline + 1;
  const tail = content.subarray(tailStart).toString("utf8").trim();
  let complete = false;
  if (tail.length > 0) {
    try {
      JSON.parse(tail);
      complete = true;
    } catch {
      complete = false;
    }
  }
  const handle = await open(filePath, "r+");
  try {
    if (complete) {
      await handle.write(Buffer.from("\n"), 0, 1, content.length);
    } else {
      await handle.truncate(tailStart);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error: unknown) {
    if (!isIgnorableDirectorySyncError(error)) throw error;
  } finally {
    await handle?.close();
  }
}

function isIgnorableDirectorySyncError(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error.code === "EINVAL" || error.code === "ENOTSUP" || error.code === "EISDIR");
}

async function readJsonl<T>(filePath: string): Promise<readonly T[]> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  const values: T[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      values.push(JSON.parse(trimmed) as T);
    } catch {
      if (lines.slice(index + 1).some((candidate) => candidate.trim().length > 0)) {
        throw new Error(`Lifecycle journal is corrupt before its tail: ${filePath}`);
      }
      // A crash can truncate only the final append. Earlier fsynced events remain valid.
    }
  }
  return values;
}

async function readDirectoryNames(directory: string): Promise<readonly string[]> {
  try {
    return await readdir(directory);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
}

async function fileSizeIfExists(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return 0;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function optionalReason(reason: string | undefined): Readonly<Record<string, unknown>> {
  return reason === undefined ? {} : { reason: reason.slice(0, 4000) };
}

function fingerprintValue(value: unknown): string {
  const serialized = stableStringify(value);
  // A non-cryptographic identity is insufficient at recovery boundaries. Reuse
  // Node's built-in digest without storing the potentially sensitive value.
  return createHash("sha256").update(serialized).digest("hex");
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(canonicalize(value));
  } catch {
    return JSON.stringify({ unhashable: Object.prototype.toString.call(value) });
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const nested = (value as Record<string, unknown>)[key];
    if (nested !== undefined) output[key] = canonicalize(nested);
  }
  return output;
}

function safeSegment(value: string): string {
  return encodeURIComponent(value);
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
