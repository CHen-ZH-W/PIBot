import type { AgentLoop } from "../ports/agent-loop";
import type {
  SlackAgentEventRenderer,
  SlackEventPublisher,
  SlackMessageHandler,
} from "../ports/slack";
import type { ChannelSessionStore } from "../ports/session-store";

/**
 * 职责：声明 SlackCodingBot 编排所需的外部端口依赖。
 * 不应承担：创建依赖实例、管理连接生命周期、隐藏业务配置。
 */
export interface SlackCodingBotDependencies {
  readonly sessions: ChannelSessionStore;
  readonly agentLoop: AgentLoop;
  readonly slack: SlackEventPublisher;
  readonly slackRenderer: SlackAgentEventRenderer;
}

/**
 * 职责：作为核心应用入口处理一条 Slack 消息，串联 session 读取/保存、agent turn、事件转发。
 * 不应承担：Slack 传输层实现、LLM provider 细节、工具具体实现、业务逻辑之外的文件系统操作。
 */
export interface SlackCodingBot extends SlackMessageHandler {
  readonly dependencies: SlackCodingBotDependencies;
}
