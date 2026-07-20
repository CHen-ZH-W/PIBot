import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { createReadStream } from "node:fs";
import type {
  SlackBlock,
  SlackEvent,
  SlackFileRef,
  SlackOutboundEvent,
  SlackPublishResult,
  SlackTextObject,
} from "../core/slack";
import type {
  SlackChannelId,
  SlackEventId,
  SlackMessageTs,
  SlackTeamId,
  SlackUserId,
} from "../core/ids";
import type {
  SlackEventPublisher,
  SlackInteractiveHandler,
  SlackMessageHandler,
  SlackMessageSource,
} from "../ports/slack";
import type { ChannelQueue } from "./queue";
import { InMemoryChannelQueue } from "./queue";

type UnknownRecord = Readonly<Record<string, unknown>>;
type AckFunction = () => unknown | Promise<unknown>;

export interface SlackSocketModeAdapterConfig {
  readonly appToken: string;
  readonly botToken: string;
  readonly botUserId?: SlackUserId;
  readonly shouldBypassQueue?: (event: SlackEvent) => boolean;
  readonly ignoreEventsBefore?: Date;
  readonly staleEventGraceMs?: number;
}

interface SocketModeSlackEventEnvelope {
  readonly ack: () => Promise<void>;
  readonly body: SocketModeSlackEventBody;
  readonly event: RawSlackEvent;
}

interface SocketModeSlackEventBody extends UnknownRecord {
  readonly event_id?: unknown;
  readonly team_id?: unknown;
  readonly authorizations?: unknown;
}

interface RawSlackEvent extends UnknownRecord {
  readonly type?: unknown;
  readonly subtype?: unknown;
  readonly user?: unknown;
  readonly text?: unknown;
  readonly channel?: unknown;
  readonly channel_type?: unknown;
  readonly ts?: unknown;
  readonly thread_ts?: unknown;
  readonly bot_id?: unknown;
  readonly files?: unknown;
}

type SlackApiTextObject = {
  readonly type: "plain_text";
  readonly text: string;
  readonly emoji?: boolean;
} | {
  readonly type: "mrkdwn";
  readonly text: string;
  readonly verbatim?: boolean;
};

type SlackApiBlock =
  | {
      readonly type: "section";
      readonly block_id?: string;
      readonly text: SlackApiTextObject;
    }
  | {
      readonly type: "context";
      readonly block_id?: string;
      readonly elements: SlackApiTextObject[];
    }
  | {
      readonly type: "divider";
      readonly block_id?: string;
    }
  | {
      readonly type: "actions";
      readonly block_id?: string;
      readonly elements: SlackApiButtonElement[];
    };

interface SlackApiButtonElement {
  readonly type: "button";
  readonly action_id: string;
  readonly text: {
    readonly type: "plain_text";
    readonly text: string;
    readonly emoji?: boolean;
  };
  readonly value: string;
  readonly style?: "primary" | "danger";
}

export class SlackSocketModeAdapter
  implements SlackMessageSource, SlackEventPublisher
{
  private readonly socket: SocketModeClient;
  private readonly web: WebClient;
  private readonly queue: ChannelQueue;
  private readonly shouldBypassQueue: (event: SlackEvent) => boolean;
  private readonly ignoreEventsBefore: Date | undefined;
  private readonly staleEventGraceMs: number;
  private botUserId: SlackUserId | undefined;
  private interactiveHandler: SlackInteractiveHandler | undefined;

  constructor(
    config: SlackSocketModeAdapterConfig,
    queue: ChannelQueue = new InMemoryChannelQueue(),
  ) {
    this.socket = new SocketModeClient({ appToken: config.appToken });
    this.web = new WebClient(config.botToken);
    this.queue = queue;
    this.shouldBypassQueue = config.shouldBypassQueue ?? (() => false);
    this.ignoreEventsBefore = config.ignoreEventsBefore;
    this.staleEventGraceMs = config.staleEventGraceMs ?? 5000;
    this.botUserId = config.botUserId;
  }

  setInteractiveHandler(handler: SlackInteractiveHandler): void {
    this.interactiveHandler = handler;
  }

  async startSlackMessageSource(
    handler: SlackMessageHandler,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted === true) {
      return;
    }

    const botUserId = await this.resolveBotUserId();
    const ignoreEventsBefore =
      this.ignoreEventsBefore ??
      new Date(Math.max(0, Date.now() - this.staleEventGraceMs));
    this.socket.on("app_mention", (payload: unknown) => {
      void this.handleSocketPayload(
        payload,
        botUserId,
        handler,
        ignoreEventsBefore,
      ).catch(logUnknownError);
    });
    this.socket.on("message", (payload: unknown) => {
      void this.handleSocketPayload(
        payload,
        botUserId,
        handler,
        ignoreEventsBefore,
      ).catch(logUnknownError);
    });
    this.socket.on("interactive", (payload: unknown) => {
      void this.handleInteractivePayload(payload).catch(logUnknownError);
    });
    this.socket.on("connected", () => {
      console.info("Slack Socket Mode connected");
    });
    this.socket.on("error", logUnknownError);

    signal?.addEventListener(
      "abort",
      () => {
        void this.socket.disconnect();
      },
      { once: true },
    );

    await this.socket.start();
    console.info("Slack Socket Mode started");
  }

  private async handleInteractivePayload(payload: unknown): Promise<void> {
    const envelope = parseSocketModeInteractiveEnvelope(payload);
    if (envelope === null) {
      return;
    }

    await envelope.ack();
    await this.interactiveHandler?.handleSlackInteraction(envelope.body);
  }

  async publishSlackEvent(
    outboundEvent: SlackOutboundEvent,
  ): Promise<SlackPublishResult> {
    switch (outboundEvent.type) {
      case "message.post": {
        const { conversation, text, blocks } = outboundEvent.draft;
        const response = await this.web.chat.postMessage({
          channel: conversation.channelId,
          text,
          ...optionalApiThread(conversation.threadTs),
          ...optionalBlocks(blocks),
        });

        return {
          conversation,
          ...optionalMessageTs(response.ts),
        };
      }
      case "message.update": {
        const { conversation, messageTs, text, blocks } = outboundEvent.update;
        const response = await this.web.chat.update({
          channel: conversation.channelId,
          ts: messageTs,
          text,
          ...optionalBlocks(blocks),
        });

        return {
          conversation,
          ...optionalMessageTs(response.ts),
        };
      }
      case "reaction.add": {
        const { conversation, messageTs, name } = outboundEvent.reaction;
        await this.web.reactions.add({
          channel: conversation.channelId,
          timestamp: messageTs,
          name,
        });

        return {
          conversation,
          messageTs,
        };
      }
      case "reaction.remove": {
        const { conversation, messageTs, name } = outboundEvent.reaction;
        await this.web.reactions.remove({
          channel: conversation.channelId,
          timestamp: messageTs,
          name,
        });

        return {
          conversation,
          messageTs,
        };
      }
      case "file.upload": {
        const { conversation, filePath, filename, title, initialComment } =
          outboundEvent.file;
        if (conversation.threadTs === undefined) {
          await this.web.files.uploadV2({
            channel_id: conversation.channelId,
            file: createReadStream(filePath),
            filename,
            ...optionalString("title", title),
            ...optionalString("initial_comment", initialComment),
          });
        } else {
          await this.web.files.uploadV2({
            channel_id: conversation.channelId,
            thread_ts: conversation.threadTs,
            file: createReadStream(filePath),
            filename,
            ...optionalString("title", title),
            ...optionalString("initial_comment", initialComment),
          });
        }

        return {
          conversation,
        };
      }
    }
  }

  private async resolveBotUserId(): Promise<SlackUserId> {
    if (this.botUserId !== undefined) {
      return this.botUserId;
    }

    const response = await this.web.auth.test();
    if (typeof response.user_id !== "string" || response.user_id.length === 0) {
      throw new Error("Slack auth.test did not return a bot user id");
    }

    this.botUserId = response.user_id as SlackUserId;
    return this.botUserId;
  }

  private async handleSocketPayload(
    payload: unknown,
    botUserId: SlackUserId,
    handler: SlackMessageHandler,
    ignoreEventsBefore: Date,
  ): Promise<void> {
    const envelope = parseSocketModeEnvelope(payload);
    if (envelope === null) {
      return;
    }

    await envelope.ack();

    const event = normalizeSlackEvent(envelope, botUserId);
    if (event === null) {
      return;
    }

    if (isSlackEventBefore(event.messageTs, ignoreEventsBefore)) {
      return;
    }

    if (this.shouldBypassQueue(event)) {
      await handler.handleSlackMessage(event);
      return;
    }

    await this.queue.enqueue(event.conversation.channelId, () =>
      handler.handleSlackMessage(event),
    );
  }
}

interface SocketModeInteractiveEnvelope {
  readonly ack: () => Promise<void>;
  readonly body: UnknownRecord;
}

export function parseSocketModeInteractiveEnvelope(
  payload: unknown,
): SocketModeInteractiveEnvelope | null {
  if (!isRecord(payload) || !isAckFunction(payload.ack) || !isRecord(payload.body)) {
    return null;
  }

  const ack = payload.ack;
  return {
    ack: async () => {
      await Promise.resolve(ack());
    },
    body: payload.body,
  };
}

function parseSocketModeEnvelope(
  payload: unknown,
): SocketModeSlackEventEnvelope | null {
  if (!isRecord(payload)) {
    return null;
  }

  const ack = payload.ack;
  const body = payload.body;
  const event = payload.event;

  if (
    !isAckFunction(ack) ||
    !isRecord(body) ||
    !isRecord(event)
  ) {
    return null;
  }

  return {
    ack: async () => {
      await Promise.resolve(ack());
    },
    body,
    event,
  };
}

function normalizeSlackEvent(
  envelope: SocketModeSlackEventEnvelope,
  botUserId: SlackUserId,
): SlackEvent | null {
  return normalizeSlackEventFromRaw(
    envelope.body,
    envelope.event,
    botUserId,
    new Date(),
  );
}

export function normalizeSlackEventFromRaw(
  body: Readonly<Record<string, unknown>>,
  rawEvent: Readonly<Record<string, unknown>>,
  botUserId: SlackUserId,
  receivedAt: Date = new Date(),
): SlackEvent | null {
  const rawType = readString(rawEvent, "type");
  const subtype = readString(rawEvent, "subtype");
  const channelType = readString(rawEvent, "channel_type");

  if (subtype !== undefined && subtype !== "file_share") {
    return null;
  }

  if (rawType !== "app_mention" && !(rawType === "message" && channelType === "im")) {
    return null;
  }

  if (readString(rawEvent, "bot_id") !== undefined) {
    return null;
  }

  const senderUserId = readString(rawEvent, "user");
  if (senderUserId === undefined || senderUserId === botUserId) {
    return null;
  }

  const files = readFiles(rawEvent.files);
  const rawText = readString(rawEvent, "text") ?? "";
  if (rawText.length === 0 && files.length === 0) {
    return null;
  }

  const text =
    rawType === "app_mention"
      ? removeLeadingBotMention(rawText, botUserId)
      : rawText.trim();
  if (text.length === 0 && files.length === 0) {
    return null;
  }

  const teamId = readTeamId(body);
  const channelId = readString(rawEvent, "channel");
  const messageTs = readString(rawEvent, "ts");
  const eventId = readString(body, "event_id");

  if (
    teamId === undefined ||
    channelId === undefined ||
    messageTs === undefined ||
    eventId === undefined
  ) {
    return null;
  }

  const threadTs = readString(rawEvent, "thread_ts");

  return {
    type: rawType === "app_mention" ? "app_mention" : "direct_message",
    eventId: eventId as SlackEventId,
    conversation: {
      teamId: teamId as SlackTeamId,
      channelId: channelId as SlackChannelId,
      ...optionalConversationThread(threadTs),
    },
    senderUserId: senderUserId as SlackUserId,
    text: text.length === 0 ? "[Slack message contains attachment(s)]" : text,
    messageTs: messageTs as SlackMessageTs,
    files,
    receivedAt,
  };
}

export function isSlackEventBefore(
  messageTs: SlackMessageTs | string,
  cutoff: Date,
): boolean {
  const eventTimeMs = slackTimestampToMillis(messageTs);
  return eventTimeMs !== undefined && eventTimeMs < cutoff.getTime();
}

function readTeamId(body: SocketModeSlackEventBody): string | undefined {
  const bodyTeamId = readString(body, "team_id");
  if (bodyTeamId !== undefined) {
    return bodyTeamId;
  }

  const authorizations = body.authorizations;
  if (!Array.isArray(authorizations) || authorizations.length === 0) {
    return undefined;
  }

  const firstAuthorization = authorizations[0];
  if (!isRecord(firstAuthorization)) {
    return undefined;
  }

  return readString(firstAuthorization, "team_id");
}

function readFiles(value: unknown): readonly SlackFileRef[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((file): readonly SlackFileRef[] => {
    if (!isRecord(file)) {
      return [];
    }

    const id = readString(file, "id");
    const name = readString(file, "name") ?? readString(file, "title");
    if (id === undefined || name === undefined) {
      return [];
    }

    return [
      {
        id,
        name,
        ...optionalString("mimetype", readString(file, "mimetype")),
        ...optionalString("url", readString(file, "url_private")),
        ...optionalNumber("size", readNonNegativeNumber(file, "size")),
      },
    ];
  });
}

function removeLeadingBotMention(text: string, botUserId: SlackUserId): string {
  const escapedBotUserId = escapeRegExp(botUserId);
  return text.replace(new RegExp(`^\\s*<@${escapedBotUserId}>\\s*`), "").trim();
}

function optionalConversationThread(
  threadTs: string | undefined,
): { readonly threadTs: SlackMessageTs } | object {
  if (threadTs === undefined) {
    return {};
  }

  return { threadTs: threadTs as SlackMessageTs };
}

function optionalApiThread(
  threadTs: SlackMessageTs | undefined,
): { readonly thread_ts: string } | object {
  if (threadTs === undefined) {
    return {};
  }

  return { thread_ts: threadTs };
}

function optionalMessageTs(
  messageTs: string | undefined,
): { readonly messageTs: SlackMessageTs } | object {
  if (messageTs === undefined) {
    return {};
  }

  return { messageTs: messageTs as SlackMessageTs };
}

function optionalBlocks(
  blocks: readonly SlackBlock[] | undefined,
): { readonly blocks: SlackApiBlock[] } | object {
  if (blocks === undefined) {
    return {};
  }

  return { blocks: blocks.map(toApiBlock) };
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

function readNonNegativeNumber(
  record: UnknownRecord,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function toApiBlock(block: SlackBlock): SlackApiBlock {
  switch (block.type) {
    case "section":
      return {
        type: "section",
        text: toApiTextObject(block.text),
        ...optionalString("block_id", block.blockId),
      };
    case "context":
      return {
        type: "context",
        elements: block.elements.map(toApiTextObject),
        ...optionalString("block_id", block.blockId),
      };
    case "divider":
      return {
        type: "divider",
        ...optionalString("block_id", block.blockId),
      };
    case "actions":
      return {
        type: "actions",
        elements: block.elements.map((element) => ({
          type: "button",
          action_id: element.actionId,
          text: {
            type: "plain_text",
            text: element.text.text,
            ...optionalBoolean("emoji", element.text.emoji),
          },
          value: element.value,
          ...(element.style === undefined ? {} : { style: element.style }),
        })),
        ...optionalString("block_id", block.blockId),
      };
  }
}

function toApiTextObject(text: SlackTextObject): SlackApiTextObject {
  switch (text.type) {
    case "plain_text":
      return {
        type: "plain_text",
        text: text.text,
        ...optionalBoolean("emoji", text.emoji),
      };
    case "mrkdwn":
      return {
        type: "mrkdwn",
        text: text.text,
        ...optionalBoolean("verbatim", text.verbatim),
      };
  }
}

function optionalBoolean<Key extends string>(
  key: Key,
  value: boolean | undefined,
): { readonly [Property in Key]: boolean } | object {
  if (value === undefined) {
    return {};
  }

  return { [key]: value } as { readonly [Property in Key]: boolean };
}

function slackTimestampToMillis(timestamp: SlackMessageTs | string): number | undefined {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) {
    return undefined;
  }

  return Math.floor(seconds * 1000);
}

function readString(
  record: UnknownRecord,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function isAckFunction(value: unknown): value is AckFunction {
  return typeof value === "function";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function logUnknownError(error: unknown): void {
  if (error instanceof Error) {
    console.error(error.stack ?? error.message);
    return;
  }

  console.error(String(error));
}
