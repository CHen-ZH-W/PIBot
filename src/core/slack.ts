import type {
  SlackChannelId,
  SlackEventId,
  SlackMessageTs,
  SlackTeamId,
  SlackUserId,
} from "./ids";

export type SlackInboundEventType =
  | "app_mention"
  | "direct_message"
  | "channel_message"
  | "message_changed";

export type SlackTextFormat = "plain_text" | "mrkdwn";

/**
 * 职责：描述 Slack text object 的最小可渲染结构。
 * 不应承担：生成文案、校验 Slack 全量 Block Kit schema、调用 Slack API。
 */
export interface SlackTextObject {
  readonly type: SlackTextFormat;
  readonly text: string;
  readonly emoji?: boolean;
  readonly verbatim?: boolean;
}

export interface SlackPlainTextObject extends SlackTextObject {
  readonly type: "plain_text";
}

/**
 * 职责：描述 Slack section block 的边界类型。
 * 不应承担：决定 block 排版策略、拆分长文本、发送消息。
 */
export interface SlackSectionBlock {
  readonly type: "section";
  readonly blockId?: string;
  readonly text: SlackTextObject;
}

/**
 * 职责：描述 Slack context block 的边界类型。
 * 不应承担：选择展示哪些运行事件、格式化 agent 进度、发送消息。
 */
export interface SlackContextBlock {
  readonly type: "context";
  readonly blockId?: string;
  readonly elements: readonly SlackTextObject[];
}

/**
 * 职责：描述 Slack divider block 的边界类型。
 * 不应承担：决定视觉分组策略、维护消息生命周期、发送消息。
 */
export interface SlackDividerBlock {
  readonly type: "divider";
  readonly blockId?: string;
}

export interface SlackButtonElement {
  readonly type: "button";
  readonly actionId: string;
  readonly text: SlackPlainTextObject;
  readonly value: string;
  readonly style?: "primary" | "danger";
}

export interface SlackActionsBlock {
  readonly type: "actions";
  readonly blockId?: string;
  readonly elements: readonly SlackButtonElement[];
}

export type SlackBlock =
  | SlackSectionBlock
  | SlackContextBlock
  | SlackDividerBlock
  | SlackActionsBlock;

/**
 * 职责：表达 Slack 入站消息携带的文件引用。
 * 不应承担：下载文件、读取文件内容、推断文件用途。
 */
export interface SlackFileRef {
  readonly id: string;
  readonly name: string;
  readonly mimetype?: string;
  readonly url?: string;
  readonly size?: number;
}

/**
 * 职责：定位 Slack 中的一段对话，包含 team、channel 和可选 thread。
 * 不应承担：作为 per-channel session key、查询 Slack 历史、判断权限。
 */
export interface SlackConversationRef {
  readonly teamId: SlackTeamId;
  readonly channelId: SlackChannelId;
  readonly threadTs?: SlackMessageTs;
}

/**
 * 职责：承载已经规范化后的 Slack 入站事件，供应用层启动一次处理流程。
 * 不应承担：Slack 请求验签、事件去重、session 查找、agent prompt 构造。
 */
export interface SlackEvent {
  readonly type: SlackInboundEventType;
  readonly eventId: SlackEventId;
  readonly conversation: SlackConversationRef;
  readonly senderUserId: SlackUserId;
  readonly text: string;
  readonly messageTs: SlackMessageTs;
  readonly files: readonly SlackFileRef[];
  readonly receivedAt: Date;
}

export type SlackInboundMessage = SlackEvent;

/**
 * 职责：描述要发布到 Slack 的新消息。
 * 不应承担：执行发布动作、记录 Slack ts、决定回复内容。
 */
export interface SlackMessageDraft {
  readonly conversation: SlackConversationRef;
  readonly text: string;
  readonly blocks?: readonly SlackBlock[];
}

/**
 * 职责：描述要更新的 Slack 消息内容。
 * 不应承担：合并流式 delta、处理 Slack 限流、保存 agent 状态。
 */
export interface SlackMessageUpdate {
  readonly conversation: SlackConversationRef;
  readonly messageTs: SlackMessageTs;
  readonly text: string;
  readonly blocks?: readonly SlackBlock[];
}

/**
 * 职责：描述 Slack reaction 的增删目标。
 * 不应承担：决定何时展示进度、调用 Slack API、处理失败重试。
 */
export interface SlackReactionChange {
  readonly conversation: SlackConversationRef;
  readonly messageTs: SlackMessageTs;
  readonly name: string;
}

export interface SlackFileUploadDraft {
  readonly conversation: SlackConversationRef;
  readonly filePath: string;
  readonly filename: string;
  readonly title?: string;
  readonly initialComment?: string;
}

export type SlackOutboundEvent =
  | {
      readonly type: "message.post";
      readonly draft: SlackMessageDraft;
    }
  | {
      readonly type: "message.update";
      readonly update: SlackMessageUpdate;
    }
  | {
      readonly type: "reaction.add";
      readonly reaction: SlackReactionChange;
    }
  | {
      readonly type: "reaction.remove";
      readonly reaction: SlackReactionChange;
    }
  | {
      readonly type: "file.upload";
      readonly file: SlackFileUploadDraft;
    };

/**
 * 职责：表达一次 Slack 发布动作返回的定位信息。
 * 不应承担：持久化消息映射、解释 Slack 错误、驱动 agent loop。
 */
export interface SlackPublishResult {
  readonly conversation: SlackConversationRef;
  readonly messageTs?: SlackMessageTs;
}
