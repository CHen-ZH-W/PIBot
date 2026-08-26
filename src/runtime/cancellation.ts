export type RuntimeCancellationReason =
  | "user_stop"
  | "client_disconnect"
  | "timeout"
  | "shutdown"
  | "superseded"
  | "runtime_abort";

export type RuntimeCancellationSource =
  | "slack"
  | "web"
  | "cli"
  | "plugin"
  | "runtime";

export interface RuntimeCancellation {
  readonly reason: RuntimeCancellationReason;
  readonly source: RuntimeCancellationSource;
  readonly requestedAt: string;
}

export interface RuntimeCancellationInput {
  readonly reason: RuntimeCancellationReason;
  readonly source: RuntimeCancellationSource;
  readonly requestedAt?: string;
}

export type RuntimeCancellationReceipt =
  | {
      readonly accepted: true;
      readonly cancellation: RuntimeCancellation;
    }
  | {
      readonly accepted: false;
      readonly cancellation?: RuntimeCancellation;
      readonly reason: "already_cancelled" | "run_already_terminal";
    };

/** Idempotent run-scoped cancellation with a stable first-cause record. */
export class RunCancellation {
  private readonly controller = new AbortController();
  private current: RuntimeCancellation | undefined;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get value(): RuntimeCancellation | undefined {
    return this.current;
  }

  get cancelled(): boolean {
    return this.current !== undefined;
  }

  request(input: RuntimeCancellationInput): RuntimeCancellation {
    if (this.current !== undefined) {
      return this.current;
    }
    this.current = Object.freeze({
      reason: input.reason,
      source: input.source,
      requestedAt: input.requestedAt ?? new Date().toISOString(),
    });
    this.controller.abort(this.current);
    return this.current;
  }
}
