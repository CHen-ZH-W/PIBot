import type { ChannelSessionKey } from "../core/session";
import type {
  ChannelWorkspaceStore,
  MemoryUsageEvent,
} from "../workspace/store";
import type {
  RuntimeAfterToolCallHookContext,
  RuntimeHook,
} from "./hooks";

export interface MemoryUsageRuntimeHookOptions {
  readonly store: ChannelWorkspaceStore;
  readonly key: ChannelSessionKey;
  readonly clock?: () => Date;
}

/** Records successful explicit memory reads without treating retrieval as validation. */
export class MemoryUsageRuntimeHook implements RuntimeHook {
  private readonly clock: () => Date;

  constructor(private readonly options: MemoryUsageRuntimeHookOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  async afterToolCall(context: RuntimeAfterToolCallHookContext): Promise<void> {
    if (context.call.name !== "memory_read" || !context.result.ok) {
      return;
    }
    const ref = parseMemoryReadRef(context.call.input);
    if (ref === undefined) {
      return;
    }
    try {
      await this.options.store.appendMemoryUsage(this.options.key, {
        ...ref,
        runId: String(context.run.runId),
        userTurnId: String(context.stepContext.userTurnId),
        stepId: String(context.stepContext.stepId),
        toolCallId: String(context.call.id),
        createdAt: this.clock().toISOString(),
      });
    } catch (error: unknown) {
      this.options.store.recordWarning({
        code: "memory_usage_record_failed",
        filePath: this.options.store.getPaths(this.options.key).globalMemoryUsageFile,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function parseMemoryReadRef(
  input: unknown,
): Pick<MemoryUsageEvent, "document" | "topic"> | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const record = input as Readonly<Record<string, unknown>>;
  const document = record.document;
  if (
    document !== "summary" &&
    document !== "index" &&
    document !== "topic" &&
    document !== "rollout_summary" &&
    document !== "extension_note"
  ) {
    return undefined;
  }
  const topic = record.topic;
  return {
    document,
    ...(typeof topic === "string" ? { topic } : {}),
  };
}
