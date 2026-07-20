import type { SlackMessageTs } from "../core/ids";
import type {
  SlackConversationRef,
  SlackEvent,
  SlackPublishResult,
} from "../core/slack";
import type { SlackEventPublisher } from "../ports/slack";
import {
  firstChunkForUpdate,
  SLACK_TEXT_LIMIT,
  SLACK_UPDATE_TEXT_LIMIT,
  splitSlackMrkdwn,
} from "./formatter";

const THREAD_CHUNK_PREFIX_RESERVE_BYTES = 64;

/**
 * 职责：管理一次 agent run 在 Slack 中的主消息和 thread 目标。
 * 不应承担：执行 agent loop、解析工具结果、保存 session、决定回复文案。
 */
export class SlackRunContext {
  private mainMessageTs: SlackMessageTs | undefined;
  private mainStartPromise: Promise<void> | undefined;

  constructor(
    private readonly publisher: SlackEventPublisher,
    private readonly sourceEvent: SlackEvent,
  ) {}

  async startMain(text: string): Promise<void> {
    await this.ensureMain(text);
  }

  async updateMain(text: string): Promise<void> {
    await this.ensureMain(firstChunkForUpdate(text));
    const messageTs = this.requireMainMessageTs();
    await this.publisher.publishSlackEvent({
      type: "message.update",
      update: {
        conversation: this.mainConversation(),
        messageTs,
        text: firstChunkForUpdate(text),
      },
    });
  }

  async replaceMain(text: string): Promise<void> {
    await this.ensureMain(firstChunkForUpdate(text));
    const messageTs = this.requireMainMessageTs();
    await this.publisher.publishSlackEvent({
      type: "message.update",
      update: {
        conversation: this.mainConversation(),
        messageTs,
        text: firstChunkForUpdate(text),
      },
    });

    if (splitSlackMrkdwn(text, SLACK_UPDATE_TEXT_LIMIT).length <= 1) {
      return;
    }

    await postSplitMrkdwnMessage(
      this.publisher,
      this.threadConversation(),
      `*Full response*\n\n${text}`,
    );
  }

  async postThreadText(text: string): Promise<void> {
    await this.ensureMain("Thinking...");
    await postSplitMrkdwnMessage(
      this.publisher,
      this.threadConversation(),
      text,
    );
  }

  private async ensureMain(initialText: string): Promise<void> {
    if (this.mainMessageTs !== undefined) {
      return;
    }

    if (this.mainStartPromise === undefined) {
      this.mainStartPromise = this.postInitialMain(initialText);
    }

    await this.mainStartPromise;
  }

  private async postInitialMain(text: string): Promise<void> {
    const chunks = splitSlackMrkdwn(text);
    const first = chunks[0];
    const postResult = await this.publisher.publishSlackEvent({
      type: "message.post",
      draft: {
        conversation: this.mainConversation(),
        text: first?.text ?? "",
      },
    });

    this.mainMessageTs = requirePublishedMessageTs(postResult);

    for (const chunk of chunks.slice(1)) {
      await this.postThreadText(`_${chunk.index}/${chunk.total}_\n${chunk.text}`);
    }
  }

  private mainConversation(): SlackConversationRef {
    return {
      teamId: this.sourceEvent.conversation.teamId,
      channelId: this.sourceEvent.conversation.channelId,
      ...optionalThreadTs(this.sourceEvent.conversation.threadTs),
    };
  }

  private threadConversation(): SlackConversationRef {
    return {
      teamId: this.sourceEvent.conversation.teamId,
      channelId: this.sourceEvent.conversation.channelId,
      threadTs: this.sourceEvent.conversation.threadTs ?? this.requireMainMessageTs(),
    };
  }

  private requireMainMessageTs(): SlackMessageTs {
    if (this.mainMessageTs === undefined) {
      throw new Error("Slack main message has not been created");
    }

    return this.mainMessageTs;
  }
}

export async function postSplitMrkdwnMessage(
  publisher: SlackEventPublisher,
  conversation: SlackConversationRef,
  text: string,
): Promise<void> {
  const chunks = splitSlackMrkdwn(
    text,
    SLACK_TEXT_LIMIT - THREAD_CHUNK_PREFIX_RESERVE_BYTES,
  );
  for (const chunk of chunks) {
    const prefix = chunk.total > 1 ? `_${chunk.index}/${chunk.total}_\n` : "";
    await publisher.publishSlackEvent({
      type: "message.post",
      draft: {
        conversation,
        text: `${prefix}${chunk.text}`,
      },
    });
  }
}

function optionalThreadTs(
  threadTs: SlackMessageTs | undefined,
): { readonly threadTs: SlackMessageTs } | object {
  if (threadTs === undefined) {
    return {};
  }

  return { threadTs };
}

function requirePublishedMessageTs(result: SlackPublishResult): SlackMessageTs {
  if (result.messageTs === undefined) {
    throw new Error("Slack postMessage did not return a message timestamp");
  }

  return result.messageTs;
}
