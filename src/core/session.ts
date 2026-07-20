import type {
  SessionId,
  SlackChannelId,
  SlackTeamId,
} from "./ids";
import type { AgentSessionState } from "./agent";

/**
 * 职责：定义 per-channel session 的查找键，只使用 Slack team + channel。
 * 不应承担：表达 thread 粒度状态、查询数据库、包含用户级权限。
 */
export interface ChannelSessionKey {
  readonly teamId: SlackTeamId;
  readonly channelId: SlackChannelId;
}

/**
 * 职责：表达一个 channel 级 agent session 及其可延续状态。
 * 不应承担：持久化自身、裁剪 agent transcript、同步 Slack thread。
 */
export interface ChannelSession {
  readonly id: SessionId;
  readonly key: ChannelSessionKey;
  readonly state: AgentSessionState;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * 职责：描述一次 session 状态保存请求，并携带可选乐观锁信息。
 * 不应承担：计算 nextState、处理存储冲突、发布完成事件。
 */
export interface SessionPatch {
  readonly id: SessionId;
  readonly nextState: AgentSessionState;
  readonly expectedUpdatedAt?: Date;
}
