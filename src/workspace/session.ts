import type {
  LlmMessage,
  LlmMessageToolCall,
} from "../core/agent";
import {
  hasUnresolvedToolCalls,
  repairToolCallMessageOrder,
} from "../core/llm-history";
import type {
  SlackEventId,
  SlackMessageTs,
  SlackUserId,
  ToolCallId,
} from "../core/ids";
import type { ChannelSessionKey } from "../core/session";
import type { SlackEvent } from "../core/slack";
import type { AgentRuntimeState } from "../runtime/mode";
import {
  readChannelRuntimeState,
  writeChannelRuntimeState,
} from "../runtime/session-state";
import type {
  CompactableContextEntry,
  SessionCompactionRequest,
  SessionCompactionResult,
  SessionCompactor,
} from "./compaction";
import {
  recordRunRolloutSummary,
  type RunRolloutSummaryRequest,
} from "./memory-sedimentation";
import type {
  ChannelWorkspaceStore,
  JsonObject,
  JsonValue,
  JsonlEntry,
  WorkspaceMemories,
} from "./store";

type StoredContextRole = "user" | "assistant" | "tool";
export type ChannelContextSource = "slack_log" | "webui" | "agent" | "compaction";
type StoredContextSource = ChannelContextSource;

interface SlackUserLogRecord {
  readonly eventId: SlackEventId;
  readonly teamId: string;
  readonly channelId: string;
  readonly userId: SlackUserId;
  readonly messageTs: SlackMessageTs;
  readonly text: string;
  readonly receivedAt: string;
}

interface StoredContextEntry {
  readonly lineNumber: number;
  readonly message: LlmMessage;
  readonly source: StoredContextSource;
  readonly eventId?: SlackEventId;
  readonly createdAt?: string;
  readonly isCompactionSummary: boolean;
  readonly coveredThroughLineNumber?: number;
}

export interface ChannelContextMessage {
  readonly lineNumber: number;
  readonly message: LlmMessage;
  readonly source: ChannelContextSource;
  readonly createdAt?: string;
  readonly eventId?: SlackEventId;
}

export interface ChannelContextAppendRequest {
  readonly message: LlmMessage;
  readonly source?: Extract<ChannelContextSource, "webui" | "agent">;
  readonly createdAt?: string | Date;
}

export interface ChannelRunSyncResult {
  readonly syncedUserMessages: number;
}

export interface BackfilledUserMessagesResult {
  readonly recordedUserMessages: number;
  readonly skippedUserMessages: number;
  readonly syncedUserMessages: number;
}

/**
 * 职责：描述一次 run 启动前从 channel session 读出的上下文。
 * 不应承担：调用模型、发布 Slack 消息、执行工具、裁剪历史。
 */
export interface PreparedChannelRunContext {
  readonly key: ChannelSessionKey;
  readonly history: readonly LlmMessage[];
  readonly memories: WorkspaceMemories;
  readonly generatedMessageStartIndex: number;
  readonly syncedUserMessages: number;
  readonly compaction?: SessionCompactionResult;
}

export interface RefreshedChannelRunContext {
  readonly messages: readonly LlmMessage[];
  readonly compaction?: SessionCompactionResult;
}

export interface WorkspaceSessionStoreOptions {
  readonly store: ChannelWorkspaceStore;
  readonly compactor?: SessionCompactor;
  readonly clock?: () => Date;
}

/**
 * 职责：把 Slack channel 的 user log 与 agent context 同步成 LLM history，并在阈值超限时追加压缩摘要。
 * 不应承担：Slack API 调用、模型调用、工具执行、session tree/fork。
 */
export class WorkspaceSessionStore {
  private readonly store: ChannelWorkspaceStore;
  private readonly compactor: SessionCompactor | undefined;
  private readonly clock: () => Date;

  constructor(options: WorkspaceSessionStoreOptions) {
    this.store = options.store;
    this.compactor = options.compactor;
    this.clock = options.clock ?? (() => new Date());
  }

  async recordUserMessage(event: SlackEvent): Promise<boolean> {
    const key = keyFromSlackEvent(event);
    const knownEventIds = await this.readKnownEventIds(key);
    if (knownEventIds.has(event.eventId)) {
      return false;
    }

    await this.store.appendLogRecord(
      key,
      slackEventToLogRecord(event, this.clock()),
    );
    return true;
  }

  async appendUserMessageToContext(event: SlackEvent): Promise<void> {
    const key = keyFromSlackEvent(event);
    const contextEntries = await this.readContextEntries(key);
    for (const entry of contextEntries) {
      if (entry.eventId === event.eventId) {
        return;
      }
    }
    if (hasUnresolvedToolCalls(contextEntries.map((entry) => entry.message))) {
      return;
    }

    await this.store.appendContextRecord(
      key,
      slackEventToContextRecord(event),
    );
  }

  async recordUserMessagesIfAbsent(
    events: readonly SlackEvent[],
  ): Promise<BackfilledUserMessagesResult> {
    const groups = groupEventsByChannel(events);
    let recordedUserMessages = 0;
    let skippedUserMessages = 0;
    let syncedUserMessages = 0;

    for (const group of groups) {
      const knownEventIds = await this.readKnownEventIds(group.key);
      for (const event of group.events) {
        if (knownEventIds.has(event.eventId)) {
          skippedUserMessages += 1;
          continue;
        }

        await this.store.appendLogRecord(
          group.key,
          slackEventToLogRecord(event, this.clock()),
        );
        knownEventIds.add(event.eventId);
        recordedUserMessages += 1;
      }

      const syncResult = await this.syncPendingUserMessages(group.key);
      syncedUserMessages += syncResult.syncedUserMessages;
    }

    return {
      recordedUserMessages,
      skippedUserMessages,
      syncedUserMessages,
    };
  }

  async prepareRun(
    event: SlackEvent,
    request: SessionCompactionRequest = {},
  ): Promise<PreparedChannelRunContext> {
    const key = keyFromSlackEvent(event);
    const syncResult = await this.syncPendingUserMessages(key);
    let contextEntries = await this.readContextEntries(key);
    const compaction = await this.compactIfNeeded(key, contextEntries, request);
    contextEntries = compaction.entries;
    const effectiveEntries = effectiveContextEntries(contextEntries);
    const history = repairToolCallMessageOrder(
      effectiveEntries
        .filter((entry) => entry.eventId !== event.eventId)
        .map((entry) => entry.message),
    );
    const memories = await this.store.readMemories(key);

    return {
      key,
      history,
      memories,
      syncedUserMessages: syncResult.syncedUserMessages,
      generatedMessageStartIndex: history.length + 2,
      ...(compaction.result === undefined ? {} : { compaction: compaction.result }),
    };
  }

  async prepareChannelRun(
    key: ChannelSessionKey,
    request: SessionCompactionRequest = {},
  ): Promise<PreparedChannelRunContext> {
    let contextEntries = await this.readContextEntries(key);
    const compaction = await this.compactIfNeeded(key, contextEntries, request);
    contextEntries = compaction.entries;
    const history = repairToolCallMessageOrder(
      effectiveContextEntries(contextEntries).map((entry) => entry.message),
    );
    const memories = await this.store.readMemories(key);

    return {
      key,
      history,
      memories,
      syncedUserMessages: 0,
      generatedMessageStartIndex: history.length + 2,
      ...(compaction.result === undefined ? {} : { compaction: compaction.result }),
    };
  }

  async syncPendingUserMessages(
    key: ChannelSessionKey,
  ): Promise<ChannelRunSyncResult> {
    const logEntries = await this.store.readLogEntries(key);
    const contextEntries = await this.readContextEntries(key);
    if (hasUnresolvedToolCalls(contextEntries.map((entry) => entry.message))) {
      return { syncedUserMessages: 0 };
    }

    const enteredEventIds = new Set<SlackEventId>();
    for (const entry of contextEntries) {
      if (entry.eventId !== undefined) {
        enteredEventIds.add(entry.eventId);
      }
    }

    let syncedUserMessages = 0;
    for (const entry of logEntries) {
      const logRecord = this.parseLogRecord(entry);
      if (logRecord === null || enteredEventIds.has(logRecord.eventId)) {
        continue;
      }

      await this.store.appendContextRecord(
        key,
        userLogRecordToContextRecord(logRecord),
      );
      enteredEventIds.add(logRecord.eventId);
      syncedUserMessages += 1;
    }

    return { syncedUserMessages };
  }

  async readContextMessages(
    key: ChannelSessionKey,
  ): Promise<readonly LlmMessage[]> {
    return repairToolCallMessageOrder(
      effectiveContextEntries(await this.readContextEntries(key)).map(
        (entry) => entry.message,
      ),
    );
  }

  async readRuntimeState(key: ChannelSessionKey): Promise<AgentRuntimeState> {
    return readChannelRuntimeState(this.store, key);
  }

  async writeRuntimeState(
    key: ChannelSessionKey,
    state: AgentRuntimeState,
  ): Promise<void> {
    await writeChannelRuntimeState(this.store, key, state);
  }

  async readChannelContextMessages(
    key: ChannelSessionKey,
  ): Promise<readonly ChannelContextMessage[]> {
    return effectiveContextEntries(await this.readContextEntries(key)).map(
      (entry) => ({
        lineNumber: entry.lineNumber,
        message: entry.message,
        source: entry.source,
        ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
        ...(entry.eventId === undefined ? {} : { eventId: entry.eventId }),
      }),
    );
  }

  async appendContextMessage(
    key: ChannelSessionKey,
    request: ChannelContextAppendRequest,
  ): Promise<void> {
    const source = request.source ?? "webui";
    const createdAt = normalizeCreatedAt(request.createdAt, this.clock());
    await this.store.appendContextRecord(
      key,
      contextMessageToRecord(request.message, source, createdAt),
    );
  }

  async appendRunMessages(
    prepared: PreparedChannelRunContext,
    messages: readonly LlmMessage[],
  ): Promise<void> {
    const generatedMessages = messages.slice(prepared.generatedMessageStartIndex);
    for (const message of generatedMessages) {
      await this.appendGeneratedMessage(prepared, message);
    }
  }

  async appendGeneratedMessage(
    prepared: PreparedChannelRunContext,
    message: LlmMessage,
  ): Promise<boolean> {
    if (!shouldStoreGeneratedMessage(message)) {
      return false;
    }

    await this.store.appendContextRecord(
      prepared.key,
      agentMessageToContextRecord(message, this.clock()),
    );
    return true;
  }

  async compactRunMessagesIfNeeded(
    prepared: PreparedChannelRunContext,
    currentEvent: SlackEvent,
    currentUserMessage: LlmMessage,
    request: SessionCompactionRequest = {},
  ): Promise<RefreshedChannelRunContext> {
    const contextEntries = await this.readContextEntries(prepared.key);
    const compaction = await this.compactIfNeeded(
      prepared.key,
      contextEntries,
      request,
    );
    const messages = effectiveContextEntries(compaction.entries).map((entry) =>
      entry.eventId === currentEvent.eventId
        ? currentUserMessage
        : entry.message);

    return {
      messages: repairToolCallMessageOrder(messages),
      ...(compaction.result === undefined ? {} : { compaction: compaction.result }),
    };
  }

  async readMemories(key: ChannelSessionKey): Promise<WorkspaceMemories> {
    return this.store.readMemories(key);
  }

  async recordRunRolloutSummary(
    request: RunRolloutSummaryRequest,
  ): Promise<void> {
    await recordRunRolloutSummary(this.store, {
      ...request,
      createdAt: request.createdAt ?? this.clock(),
    });
  }

  async forceCompact(
    key: ChannelSessionKey,
    signal?: AbortSignal,
  ): Promise<SessionCompactionResult | undefined> {
    const contextEntries = await this.readContextEntries(key);
    return (
      await this.compactIfNeeded(key, contextEntries, {
        force: true,
        reason: "context_overflow",
        ...(signal === undefined ? {} : { signal }),
      })
    ).result;
  }

  private async readKnownEventIds(
    key: ChannelSessionKey,
  ): Promise<Set<SlackEventId>> {
    const eventIds = new Set<SlackEventId>();
    for (const entry of await this.store.readLogEntries(key)) {
      const logRecord = this.parseLogRecord(entry);
      if (logRecord !== null) {
        eventIds.add(logRecord.eventId);
      }
    }
    for (const entry of await this.readContextEntries(key)) {
      if (entry.eventId !== undefined) {
        eventIds.add(entry.eventId);
      }
    }

    return eventIds;
  }

  private async readContextEntries(
    key: ChannelSessionKey,
  ): Promise<readonly StoredContextEntry[]> {
    const entries = await this.store.readContextEntries(key);
    const parsed: StoredContextEntry[] = [];
    for (const entry of entries) {
      const contextEntry = this.parseContextEntry(entry);
      if (contextEntry !== null) {
        parsed.push(contextEntry);
      }
    }

    return parsed;
  }

  private parseLogRecord(entry: JsonlEntry): SlackUserLogRecord | null {
    const record = entry.record;
    if (readString(record, "type") !== "slack_user_message") {
      this.warnInvalidLog(entry, "Log record type must be slack_user_message");
      return null;
    }

    const eventId = readString(record, "eventId");
    const teamId = readString(record, "teamId");
    const channelId = readString(record, "channelId");
    const userId = readString(record, "userId");
    const messageTs = readString(record, "messageTs");
    const text = readString(record, "text");
    const receivedAt = readString(record, "receivedAt");

    if (
      eventId === undefined ||
      teamId === undefined ||
      channelId === undefined ||
      userId === undefined ||
      messageTs === undefined ||
      text === undefined ||
      receivedAt === undefined
    ) {
      this.warnInvalidLog(entry, "Log record is missing required fields");
      return null;
    }

    return {
      eventId: eventId as SlackEventId,
      teamId,
      channelId,
      userId: userId as SlackUserId,
      messageTs: messageTs as SlackMessageTs,
      text,
      receivedAt,
    };
  }

  private parseContextEntry(entry: JsonlEntry): StoredContextEntry | null {
    const record = entry.record;
    if (readString(record, "type") !== "context_message") {
      this.warnInvalidContext(
        entry,
        "Context record type must be context_message",
      );
      return null;
    }

    const role = readString(record, "role");
    const content = readString(record, "content");
    const source = readString(record, "source");
    if (
      !isStoredContextRole(role) ||
      content === undefined ||
      !isContextSource(source)
    ) {
      this.warnInvalidContext(entry, "Context record is missing required fields");
      return null;
    }

    const toolCallId = readString(record, "toolCallId");
    if (role === "tool" && toolCallId === undefined) {
      this.warnInvalidContext(entry, "Tool context record needs toolCallId");
      return null;
    }

    const toolCalls = readToolCalls(record);
    if (toolCalls === null) {
      this.warnInvalidContext(entry, "Assistant toolCalls must be valid");
      return null;
    }
    const reasoningContent =
      readString(record, "reasoningContent") ??
      readString(record, "reasoning_content");
    const compactionKind = readString(record, "compactionKind");
    const createdAt = readString(record, "createdAt");
    const coveredThroughLineNumber = readNumber(
      record,
      "coveredThroughLineNumber",
    );
    const isCompactionSummary =
      source === "compaction" && compactionKind === "session_summary";

    return {
      lineNumber: entry.lineNumber,
      message: {
        role,
        content,
        ...(toolCallId !== undefined
          ? { toolCallId: toolCallId as ToolCallId }
          : {}),
        ...(toolCalls !== undefined ? { toolCalls } : {}),
        ...(reasoningContent !== undefined ? { reasoningContent } : {}),
      },
      source,
      ...optionalEventId(readString(record, "eventId")),
      ...(createdAt === undefined ? {} : { createdAt }),
      isCompactionSummary,
      ...optionalNumber(
        "coveredThroughLineNumber",
        coveredThroughLineNumber,
      ),
    };
  }

  private async compactIfNeeded(
    key: ChannelSessionKey,
    entries: readonly StoredContextEntry[],
    request: SessionCompactionRequest = {},
  ): Promise<{
    readonly entries: readonly StoredContextEntry[];
    readonly result?: SessionCompactionResult;
  }> {
    if (this.compactor === undefined) {
      return { entries };
    }

    const effectiveEntries = effectiveContextEntries(entries);
    try {
      const result = await this.compactor.maybeCompact(
        effectiveEntries.map(toCompactableEntry),
        this.clock(),
        request,
      );
      if (!result.triggered) {
        return { entries, result };
      }

      if (result.summaryRecord === undefined) {
        throw new Error("Compactor triggered without a summary record");
      }

      await this.store.appendContextRecord(key, result.summaryRecord);
      return {
        entries: await this.readContextEntries(key),
        result,
      };
    } catch (error: unknown) {
      this.warnCompactionFailed(key, error);
      return { entries };
    }
  }

  private warnInvalidLog(entry: JsonlEntry, message: string): void {
    this.store.recordWarning({
      code: "invalid_log_record",
      filePath: entry.filePath,
      lineNumber: entry.lineNumber,
      message,
    });
  }

  private warnInvalidContext(entry: JsonlEntry, message: string): void {
    this.store.recordWarning({
      code: "invalid_context_record",
      filePath: entry.filePath,
      lineNumber: entry.lineNumber,
      message,
    });
  }

  private warnCompactionFailed(
    key: ChannelSessionKey,
    error: unknown,
  ): void {
    this.store.recordWarning({
      code: "compaction_failed",
      filePath: this.store.getPaths(key).contextFile,
      message:
        error instanceof Error
          ? error.message
          : "Session compaction failed with an unknown error",
    });
  }
}

export function keyFromSlackEvent(event: SlackEvent): ChannelSessionKey {
  return {
    teamId: event.conversation.teamId,
    channelId: event.conversation.channelId,
  };
}

function slackEventToLogRecord(event: SlackEvent, loggedAt: Date): JsonObject {
  return {
    type: "slack_user_message",
    schemaVersion: 1,
    eventId: event.eventId,
    teamId: event.conversation.teamId,
    channelId: event.conversation.channelId,
    userId: event.senderUserId,
    messageTs: event.messageTs,
    text: event.text,
    receivedAt: event.receivedAt.toISOString(),
    loggedAt: loggedAt.toISOString(),
  };
}

function groupEventsByChannel(events: readonly SlackEvent[]): readonly {
  readonly key: ChannelSessionKey;
  readonly events: readonly SlackEvent[];
}[] {
  const groups = new Map<string, { key: ChannelSessionKey; events: SlackEvent[] }>();
  for (const event of events) {
    const key = keyFromSlackEvent(event);
    const groupKey = `${key.teamId}:${key.channelId}`;
    const existing = groups.get(groupKey);
    if (existing !== undefined) {
      existing.events.push(event);
      continue;
    }

    groups.set(groupKey, {
      key,
      events: [event],
    });
  }

  return [...groups.values()];
}

function userLogRecordToContextRecord(
  logRecord: SlackUserLogRecord,
): JsonObject {
  return {
    type: "context_message",
    schemaVersion: 1,
    role: "user",
    content: logRecord.text,
    source: "slack_log",
    eventId: logRecord.eventId,
    teamId: logRecord.teamId,
    channelId: logRecord.channelId,
    userId: logRecord.userId,
    messageTs: logRecord.messageTs,
    createdAt: logRecord.receivedAt,
  };
}

function slackEventToContextRecord(event: SlackEvent): JsonObject {
  return userLogRecordToContextRecord({
    eventId: event.eventId,
    teamId: event.conversation.teamId,
    channelId: event.conversation.channelId,
    userId: event.senderUserId,
    messageTs: event.messageTs,
    text: event.text,
    receivedAt: event.receivedAt.toISOString(),
  });
}

function agentMessageToContextRecord(
  message: LlmMessage,
  createdAt: Date,
): JsonObject {
  return contextMessageToRecord(message, "agent", createdAt);
}

function contextMessageToRecord(
  message: LlmMessage,
  source: Extract<ChannelContextSource, "webui" | "agent">,
  createdAt: Date,
): JsonObject {
  return {
    type: "context_message",
    schemaVersion: 1,
    role: message.role,
    content: message.content,
    source,
    createdAt: createdAt.toISOString(),
    ...(message.toolCallId !== undefined
      ? { toolCallId: message.toolCallId }
      : {}),
    ...(message.toolCalls !== undefined
      ? { toolCalls: toolCallsToJson(message.toolCalls) }
      : {}),
    ...(message.reasoningContent !== undefined
      ? { reasoningContent: message.reasoningContent }
      : {}),
  };
}

function shouldStoreGeneratedMessage(message: LlmMessage): boolean {
  if (message.role === "assistant") {
    return (
      message.content.length > 0 ||
      (message.toolCalls !== undefined && message.toolCalls.length > 0)
    );
  }

  return message.role === "tool" && message.content.length > 0;
}

function readString(
  record: JsonObject,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(
  record: JsonObject,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function readToolCalls(
  record: JsonObject,
): readonly LlmMessageToolCall[] | null | undefined {
  const value = record.toolCalls;
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const toolCalls: LlmMessageToolCall[] = [];
  for (const item of value) {
    if (!isJsonObject(item)) {
      return null;
    }

    const id = readString(item, "id");
    const name = readString(item, "name");
    const argumentsJson = readString(item, "argumentsJson");
    if (id === undefined || name === undefined || argumentsJson === undefined) {
      return null;
    }

    toolCalls.push({
      id: id as ToolCallId,
      name,
      argumentsJson,
    });
  }

  return toolCalls;
}

function toolCallsToJson(
  toolCalls: readonly LlmMessageToolCall[],
): readonly JsonObject[] {
  return toolCalls.map((toolCall) => ({
    id: toolCall.id,
    name: toolCall.name,
    argumentsJson: toolCall.argumentsJson,
  }));
}

function isStoredContextRole(
  role: string | undefined,
): role is StoredContextRole {
  return role === "user" || role === "assistant" || role === "tool";
}

function isContextSource(
  source: string | undefined,
): source is StoredContextSource {
  return (
    source === "slack_log" ||
    source === "webui" ||
    source === "agent" ||
    source === "compaction"
  );
}

function normalizeCreatedAt(
  value: string | Date | undefined,
  fallback: Date,
): Date {
  if (value instanceof Date) {
    return value;
  }
  if (value !== undefined) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return fallback;
}

function optionalEventId(
  value: string | undefined,
): { readonly eventId: SlackEventId } | object {
  if (value === undefined) {
    return {};
  }

  return { eventId: value as SlackEventId };
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

function effectiveContextEntries(
  entries: readonly StoredContextEntry[],
): readonly StoredContextEntry[] {
  const latestSummary = [...entries]
    .reverse()
    .find(
      (entry) =>
        entry.isCompactionSummary &&
        entry.coveredThroughLineNumber !== undefined,
    );

  if (
    latestSummary === undefined ||
    latestSummary.coveredThroughLineNumber === undefined
  ) {
    return entries;
  }
  const coveredThroughLineNumber = latestSummary.coveredThroughLineNumber;

  return [
    latestSummary,
    ...entries.filter(
      (entry) =>
        entry.lineNumber > coveredThroughLineNumber &&
        entry.lineNumber !== latestSummary.lineNumber,
    ),
  ];
}

function toCompactableEntry(
  entry: StoredContextEntry,
): CompactableContextEntry {
  return {
    lineNumber: entry.lineNumber,
    message: entry.message,
    source: entry.source,
    isCompactionSummary: entry.isCompactionSummary,
    ...optionalEventId(entry.eventId),
    ...optionalNumber(
      "coveredThroughLineNumber",
      entry.coveredThroughLineNumber,
    ),
  };
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
