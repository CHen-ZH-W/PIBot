import type {
  SlackConversationRef,
  SlackEvent,
  SlackOutboundEvent,
  SlackPublishResult,
} from "../core/slack";
import type { AgentEvent } from "../core/agent";

/**
 * 职责：把 Slack transport adapter 接收到的规范化消息推给应用层 handler。
 * 不应承担：agent 编排、session 持久化、工具执行、决定回复内容。
 */
export interface SlackMessageSource {
  startSlackMessageSource(
    handler: SlackMessageHandler,
    signal?: AbortSignal,
  ): Promise<void>;
}

/**
 * 职责：接收已经验签、去重、规范化后的 Slack 消息，并交给应用层处理。
 * 不应承担：HTTP/Socket Mode 框架绑定、Slack Web API 调用、LLM 调用、session 持久化。
 */
export interface SlackMessageHandler {
  handleSlackMessage(event: SlackEvent): Promise<void>;
}

/**
 * 职责：把应用层产生的 Slack 出站事件发布到 Slack，例如发消息、更新消息、加/移除 reaction。
 * 不应承担：决定回复内容、维护 agent 状态、保存 session、执行工具。
 */
export interface SlackEventPublisher {
  publishSlackEvent(event: SlackOutboundEvent): Promise<SlackPublishResult>;
}

/**
 * 职责：处理 Slack 交互事件，例如按钮点击。
 * 不应承担：解析 Socket Mode envelope、接收普通消息、执行工具。
 */
export interface SlackInteractiveHandler {
  handleSlackInteraction(body: Readonly<Record<string, unknown>>): Promise<boolean>;
}

/**
 * 职责：把 agent 事件流中的单个事件转换为零个或多个 Slack 出站事件。
 * 不应承担：调用 Slack API、消费完整 agent turn、保存 session、执行工具。
 */
export interface SlackAgentEventRenderer {
  renderAgentEvent(
    event: AgentEvent,
    conversation: SlackConversationRef,
  ): readonly SlackOutboundEvent[];
}
