import { WebClient } from "@slack/web-api";
import type {
  SlackChannelId,
  SlackEventId,
  SlackMessageTs,
  SlackTeamId,
  SlackUserId,
} from "../core/ids";
import type { SlackEvent } from "../core/slack";
import type { WorkspaceSessionStore } from "../workspace/session";

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface SlackHistoryBackfillOptions {
  readonly botToken: string;
  readonly botUserId?: SlackUserId;
  readonly sessions: WorkspaceSessionStore;
  readonly maxChannels: number;
  readonly maxMessagesPerChannel: number;
  readonly channelTypes: string;
}

export interface SlackHistoryBackfillResult {
  readonly channelsScanned: number;
  readonly messagesScanned: number;
  readonly recordedUserMessages: number;
  readonly skippedUserMessages: number;
  readonly syncedUserMessages: number;
}

/**
 * 职责：启动时把已有 Slack 历史同步到本地 session log/context。
 * 不应承担：触发 agent run、回复旧消息、下载文件、修改 agent loop。
 */
export class SlackHistoryBackfiller {
  private readonly web: WebClient;

  constructor(private readonly options: SlackHistoryBackfillOptions) {
    this.web = new WebClient(options.botToken);
  }

  async run(signal?: AbortSignal): Promise<SlackHistoryBackfillResult> {
    if (isSignalAborted(signal)) {
      return emptyResult();
    }

    const botUserId = await this.resolveBotUserId();
    const teamId = await this.resolveTeamId();
    let channelsScanned = 0;
    let messagesScanned = 0;
    let recordedUserMessages = 0;
    let skippedUserMessages = 0;
    let syncedUserMessages = 0;

    for await (const channel of this.listChannels(signal)) {
      if (isSignalAborted(signal)) {
        break;
      }

      channelsScanned += 1;
      const events = await this.readChannelEvents(channel, teamId, botUserId);
      messagesScanned += events.scanned;
      const result = await this.options.sessions.recordUserMessagesIfAbsent(
        events.events,
      );
      recordedUserMessages += result.recordedUserMessages;
      skippedUserMessages += result.skippedUserMessages;
      syncedUserMessages += result.syncedUserMessages;
    }

    return {
      channelsScanned,
      messagesScanned,
      recordedUserMessages,
      skippedUserMessages,
      syncedUserMessages,
    };
  }

  private async resolveBotUserId(): Promise<SlackUserId> {
    if (this.options.botUserId !== undefined) {
      return this.options.botUserId;
    }

    const response = await this.web.auth.test();
    const userId = readString(response as unknown as UnknownRecord, "user_id");
    if (userId === undefined) {
      throw new Error("Slack auth.test did not return user_id for backfill");
    }

    return userId as SlackUserId;
  }

  private async resolveTeamId(): Promise<SlackTeamId> {
    const response = await this.web.auth.test();
    const teamId = readString(response as unknown as UnknownRecord, "team_id");
    if (teamId === undefined) {
      throw new Error("Slack auth.test did not return team_id for backfill");
    }

    return teamId as SlackTeamId;
  }

  private async *listChannels(
    signal: AbortSignal | undefined,
  ): AsyncIterable<BackfillChannel> {
    let cursor: string | undefined;
    let yielded = 0;
    while (yielded < this.options.maxChannels && !isSignalAborted(signal)) {
      const limit = Math.min(200, this.options.maxChannels - yielded);
      const response = await this.web.conversations.list({
        limit,
        types: this.options.channelTypes,
        ...optionalString("cursor", cursor),
      });
      const record = response as unknown as UnknownRecord;
      const channels = readRecordArray(record, "channels");
      for (const channel of channels) {
        const parsed = parseBackfillChannel(channel);
        if (parsed === null) {
          continue;
        }

        yielded += 1;
        yield parsed;
        if (yielded >= this.options.maxChannels) {
          break;
        }
      }

      cursor = readNextCursor(record);
      if (cursor === undefined) {
        break;
      }
    }
  }

  private async readChannelEvents(
    channel: BackfillChannel,
    teamId: SlackTeamId,
    botUserId: SlackUserId,
  ): Promise<{
    readonly scanned: number;
    readonly events: readonly SlackEvent[];
  }> {
    const response = await this.web.conversations.history({
      channel: channel.id,
      limit: this.options.maxMessagesPerChannel,
    });
    const messages = readRecordArray(
      response as unknown as UnknownRecord,
      "messages",
    );
    const events = [...messages]
      .reverse()
      .flatMap((message): readonly SlackEvent[] => {
        const event = messageToSlackEvent(message, channel, teamId, botUserId);
        return event === null ? [] : [event];
      });

    return {
      scanned: messages.length,
      events,
    };
  }
}

interface BackfillChannel {
  readonly id: SlackChannelId;
  readonly isIm: boolean;
}

function messageToSlackEvent(
  message: UnknownRecord,
  channel: BackfillChannel,
  teamId: SlackTeamId,
  botUserId: SlackUserId,
): SlackEvent | null {
  if (readString(message, "subtype") !== undefined) {
    return null;
  }

  if (readString(message, "bot_id") !== undefined) {
    return null;
  }

  const userId = readString(message, "user");
  const ts = readString(message, "ts");
  const rawText = readString(message, "text");
  if (userId === undefined || ts === undefined || rawText === undefined) {
    return null;
  }

  if (userId === botUserId) {
    return null;
  }

  const shouldKeep = channel.isIm || rawText.includes(`<@${botUserId}>`);
  if (!shouldKeep) {
    return null;
  }

  const text = channel.isIm
    ? rawText.trim()
    : rawText.replace(new RegExp(`^\\s*<@${escapeRegExp(botUserId)}>\\s*`), "").trim();
  if (text.length === 0) {
    return null;
  }

  return {
    type: channel.isIm ? "direct_message" : "app_mention",
    eventId: `backfill:${channel.id}:${ts}` as SlackEventId,
    conversation: {
      teamId,
      channelId: channel.id,
    },
    senderUserId: userId as SlackUserId,
    text,
    messageTs: ts as SlackMessageTs,
    files: [],
    receivedAt: slackTsToDate(ts),
  };
}

function parseBackfillChannel(record: UnknownRecord): BackfillChannel | null {
  const id = readString(record, "id");
  if (id === undefined) {
    return null;
  }

  return {
    id: id as SlackChannelId,
    isIm: readBoolean(record, "is_im") === true,
  };
}

function readNextCursor(record: UnknownRecord): string | undefined {
  const metadata = readRecord(record, "response_metadata");
  if (metadata === undefined) {
    return undefined;
  }

  return readString(metadata, "next_cursor");
}

function slackTsToDate(ts: string): Date {
  const seconds = Number(ts.split(".")[0]);
  if (!Number.isFinite(seconds)) {
    return new Date();
  }

  return new Date(seconds * 1000);
}

function emptyResult(): SlackHistoryBackfillResult {
  return {
    channelsScanned: 0,
    messagesScanned: 0,
    recordedUserMessages: 0,
    skippedUserMessages: 0,
    syncedUserMessages: 0,
  };
}

function readString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readBoolean(record: UnknownRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readRecord(
  record: UnknownRecord,
  key: string,
): UnknownRecord | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function readRecordArray(
  record: UnknownRecord,
  key: string,
): readonly UnknownRecord[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
