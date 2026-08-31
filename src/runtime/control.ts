import { randomUUID } from "node:crypto";
import type {
  AgentRunId,
  AgentStepId,
  AgentUserTurnId,
  RuntimeControlMessageId,
} from "../core/ids";

export type RuntimeControlSource =
  | "slack"
  | "web"
  | "cli"
  | "plugin"
  | "runtime";

export type RuntimeControlKind = "steer" | "follow_up";

export type RuntimeControlDisposition =
  | "queued"
  | "delivered"
  | "expired"
  | "cancelled"
  | "rejected";

export type RuntimeControlTerminalReason =
  | "user_turn_replaced"
  | "user_turn_completed"
  | "user_turn_failed"
  | "user_turn_aborted"
  | "step_budget_exhausted"
  | "run_aborted_before_first_step"
  | "run_cancelled"
  | "run_completed"
  | "run_failed";

export type RuntimeControlReceiptReason =
  | RuntimeControlTerminalReason
  | "duplicate_control_message"
  | "empty_control_message"
  | "user_turn_not_active"
  | "next_step_inbox_full"
  | "next_step_inbox_bytes_exceeded"
  | "next_turn_queue_full"
  | "next_turn_queue_bytes_exceeded";

export interface RuntimeControlMessage<
  Kind extends RuntimeControlKind = RuntimeControlKind,
> {
  readonly id: RuntimeControlMessageId;
  readonly kind: Kind;
  readonly runId: AgentRunId;
  readonly userTurnId: AgentUserTurnId;
  readonly text: string;
  readonly source: RuntimeControlSource;
  readonly receivedAt: string;
}

export interface RuntimeControlRecord<
  Kind extends RuntimeControlKind = RuntimeControlKind,
> {
  readonly message: RuntimeControlMessage<Kind>;
  status: RuntimeControlDisposition;
  deliveredStepId?: AgentStepId;
  dispositionReason?: RuntimeControlReceiptReason;
}

export interface RuntimeControlReceipt<
  Kind extends RuntimeControlKind = RuntimeControlKind,
> {
  readonly accepted: boolean;
  readonly position?: number;
  readonly message: RuntimeControlMessage<Kind>;
  readonly reason?: RuntimeControlReceiptReason;
}

export interface RuntimeControlMessageInput<
  Kind extends RuntimeControlKind = RuntimeControlKind,
> {
  readonly kind: Kind;
  readonly runId: AgentRunId;
  readonly userTurnId: AgentUserTurnId;
  readonly text: string;
  readonly source?: RuntimeControlSource;
  readonly id?: RuntimeControlMessageId;
  readonly receivedAt?: string;
}

export interface RuntimeMailboxLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
}

const DEFAULT_STEP_INBOX_LIMITS: RuntimeMailboxLimits = {
  maxEntries: 100,
  maxBytes: 256 * 1024,
};

const DEFAULT_TURN_QUEUE_LIMITS: RuntimeMailboxLimits = {
  maxEntries: 5,
  maxBytes: 512 * 1024,
};

/** Ordered, once-only delivery of steering to the next step of one user turn. */
export class NextStepInbox {
  private readonly records: Array<RuntimeControlRecord<"steer">> = [];
  private readonly closedUserTurns = new Map<
    AgentUserTurnId,
    RuntimeControlTerminalReason
  >();
  private activeUserTurnId: AgentUserTurnId | undefined;
  private closedReason: RuntimeControlTerminalReason | undefined;

  constructor(
    private readonly limits: RuntimeMailboxLimits = DEFAULT_STEP_INBOX_LIMITS,
  ) {
    validateLimits(limits, false);
  }

  openUserTurn(userTurnId: AgentUserTurnId): void {
    if (this.closedReason !== undefined) {
      return;
    }
    if (
      this.activeUserTurnId !== undefined &&
      this.activeUserTurnId !== userTurnId
    ) {
      this.closeUserTurn(this.activeUserTurnId, "user_turn_replaced");
    }
    this.activeUserTurnId = userTurnId;
  }

  enqueue(
    input: Omit<RuntimeControlMessageInput<"steer">, "kind">,
  ): RuntimeControlReceipt<"steer"> {
    const message = createRuntimeControlMessage({ ...input, kind: "steer" });
    const duplicate = this.records.find((record) => record.message.id === message.id);
    if (duplicate !== undefined) {
      return {
        accepted: duplicate.status === "queued",
        message: duplicate.message,
        ...optionalReason("duplicate_control_message"),
      };
    }
    const rejection = this.enqueueRejection(message.userTurnId, message.text);
    if (rejection !== undefined) {
      this.records.push({
        message,
        status: "rejected",
        dispositionReason: rejection,
      });
      return { accepted: false, message, reason: rejection };
    }
    this.records.push({ message, status: "queued" });
    return {
      accepted: true,
      position: this.pending(message.userTurnId).length,
      message,
    };
  }

  drain(
    userTurnId: AgentUserTurnId,
    stepId: AgentStepId,
  ): readonly RuntimeControlMessage<"steer">[] {
    if (this.closedReason !== undefined || this.activeUserTurnId !== userTurnId) {
      return [];
    }
    const pending = this.pending(userTurnId);
    for (const record of pending) {
      record.status = "delivered";
      record.deliveredStepId = stepId;
    }
    return Object.freeze(pending.map((record) => record.message));
  }

  hasPending(userTurnId: AgentUserTurnId): boolean {
    return this.pending(userTurnId).length > 0;
  }

  closeUserTurn(
    userTurnId: AgentUserTurnId,
    reason: RuntimeControlTerminalReason = "user_turn_completed",
  ): void {
    for (const record of this.pending(userTurnId)) {
      record.status = "expired";
      record.dispositionReason = reason;
    }
    if (this.activeUserTurnId === userTurnId) {
      this.activeUserTurnId = undefined;
    }
    this.closedUserTurns.set(userTurnId, reason);
  }

  close(
    reason: RuntimeControlTerminalReason = "run_cancelled",
    disposition: Extract<RuntimeControlDisposition, "cancelled" | "expired"> =
      "cancelled",
  ): void {
    if (this.closedReason !== undefined) {
      return;
    }
    this.closedReason = reason;
    for (const record of this.records) {
      if (record.status === "queued") {
        record.status = disposition;
        record.dispositionReason = reason;
      }
    }
    this.activeUserTurnId = undefined;
  }

  history(): readonly RuntimeControlRecord<"steer">[] {
    return this.records.map(copyRecord);
  }

  private enqueueRejection(
    userTurnId: AgentUserTurnId,
    text: string,
  ): RuntimeControlReceiptReason | undefined {
    if (this.closedReason !== undefined) {
      return this.closedReason;
    }
    const userTurnClosedReason = this.closedUserTurns.get(userTurnId);
    if (userTurnClosedReason !== undefined) {
      return userTurnClosedReason;
    }
    if (this.activeUserTurnId !== userTurnId) {
      return "user_turn_not_active";
    }
    if (text.trim().length === 0) {
      return "empty_control_message";
    }
    const pending = this.pending(userTurnId);
    if (pending.length >= this.limits.maxEntries) {
      return "next_step_inbox_full";
    }
    if (pendingBytes(pending) + Buffer.byteLength(text, "utf8") > this.limits.maxBytes) {
      return "next_step_inbox_bytes_exceeded";
    }
    return undefined;
  }

  private pending(
    userTurnId: AgentUserTurnId,
  ): Array<RuntimeControlRecord<"steer">> {
    return this.records.filter(
      (record) =>
        record.status === "queued" && record.message.userTurnId === userTurnId,
    );
  }
}

interface QueuedTurn<Payload> {
  readonly payload: Payload;
  readonly record: RuntimeControlRecord<"follow_up">;
  readonly bytes: number;
}

/** Ordered next-user-turn queue with explicit capacity and dispositions. */
export class NextTurnQueue<Payload> {
  private readonly entries: Array<QueuedTurn<Payload>> = [];
  private readonly records: Array<RuntimeControlRecord<"follow_up">> = [];
  private closedReason: RuntimeControlTerminalReason | undefined;

  constructor(
    private readonly limits: RuntimeMailboxLimits = DEFAULT_TURN_QUEUE_LIMITS,
  ) {
    validateLimits(limits, true);
  }

  get size(): number {
    return this.entries.length;
  }

  enqueue(
    payload: Payload,
    input: Omit<RuntimeControlMessageInput<"follow_up">, "kind">,
    options: { readonly reserveCapacity?: boolean } = {},
  ): RuntimeControlReceipt<"follow_up"> {
    const message = createRuntimeControlMessage({ ...input, kind: "follow_up" });
    const duplicate = this.records.find((record) => record.message.id === message.id);
    if (duplicate !== undefined) {
      return {
        accepted: duplicate.status === "queued",
        message: duplicate.message,
        ...optionalReason("duplicate_control_message"),
      };
    }
    const bytes = Buffer.byteLength(message.text, "utf8");
    const rejection = this.enqueueRejection(
      bytes,
      message.text,
      options.reserveCapacity === true,
    );
    const record: RuntimeControlRecord<"follow_up"> = {
      message,
      status: rejection === undefined ? "queued" : "rejected",
      ...(rejection === undefined ? {} : { dispositionReason: rejection }),
    };
    this.records.push(record);
    if (rejection !== undefined) {
      return { accepted: false, message, reason: rejection };
    }
    this.entries.push({ payload, record, bytes });
    return { accepted: true, position: this.entries.length, message };
  }

  dequeue(): { readonly payload: Payload; readonly message: RuntimeControlMessage<"follow_up"> } | undefined {
    const next = this.entries.shift();
    if (next === undefined) {
      return undefined;
    }
    next.record.status = "delivered";
    return { payload: next.payload, message: next.record.message };
  }

  close(
    reason: RuntimeControlTerminalReason = "run_cancelled",
    disposition: Extract<RuntimeControlDisposition, "cancelled" | "expired"> =
      "cancelled",
  ): void {
    if (this.closedReason !== undefined) {
      return;
    }
    this.closedReason = reason;
    for (const entry of this.entries.splice(0, this.entries.length)) {
      entry.record.status = disposition;
      entry.record.dispositionReason = reason;
    }
  }

  history(): readonly RuntimeControlRecord<"follow_up">[] {
    return this.records.map(copyRecord);
  }

  private enqueueRejection(
    bytes: number,
    text: string,
    reserveCapacity: boolean,
  ): RuntimeControlReceiptReason | undefined {
    if (this.closedReason !== undefined) {
      return this.closedReason;
    }
    if (text.trim().length === 0) {
      return "empty_control_message";
    }
    if (!reserveCapacity && this.entries.length >= this.limits.maxEntries) {
      return "next_turn_queue_full";
    }
    const queuedBytes = this.entries.reduce((total, entry) => total + entry.bytes, 0);
    if (queuedBytes + bytes > this.limits.maxBytes) {
      return "next_turn_queue_bytes_exceeded";
    }
    return undefined;
  }
}

export function createRuntimeControlMessage<Kind extends RuntimeControlKind>(
  input: RuntimeControlMessageInput<Kind>,
): RuntimeControlMessage<Kind> {
  return Object.freeze({
    id: input.id ?? (randomUUID() as RuntimeControlMessageId),
    kind: input.kind,
    runId: input.runId,
    userTurnId: input.userTurnId,
    text: input.text,
    source: input.source ?? "runtime",
    receivedAt: input.receivedAt ?? new Date().toISOString(),
  });
}

function pendingBytes(
  records: readonly RuntimeControlRecord[],
): number {
  return records.reduce(
    (total, record) => total + Buffer.byteLength(record.message.text, "utf8"),
    0,
  );
}

function copyRecord<Kind extends RuntimeControlKind>(
  record: RuntimeControlRecord<Kind>,
): RuntimeControlRecord<Kind> {
  return {
    message: record.message,
    status: record.status,
    ...(record.deliveredStepId === undefined
      ? {}
      : { deliveredStepId: record.deliveredStepId }),
    ...(record.dispositionReason === undefined
      ? {}
      : { dispositionReason: record.dispositionReason }),
  };
}

function validateLimits(limits: RuntimeMailboxLimits, allowZeroEntries: boolean): void {
  if (
    !Number.isInteger(limits.maxEntries) ||
    limits.maxEntries < (allowZeroEntries ? 0 : 1)
  ) {
    throw new Error(
      allowZeroEntries
        ? "Runtime mailbox maxEntries must be a non-negative integer"
        : "Runtime mailbox maxEntries must be a positive integer",
    );
  }
  if (!Number.isInteger(limits.maxBytes) || limits.maxBytes < 1) {
    throw new Error("Runtime mailbox maxBytes must be a positive integer");
  }
}

function optionalReason(
  reason: RuntimeControlReceiptReason | undefined,
): { readonly reason: RuntimeControlReceiptReason } | object {
  return reason === undefined ? {} : { reason };
}
