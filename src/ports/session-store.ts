import type { ChannelSession, ChannelSessionKey, SessionPatch } from "../core/session";

/**
 * 职责：按 Slack team + channel 读取、创建和保存 per-channel agent session。
 * 不应承担：解释 Slack 消息、裁剪上下文、调用 LLM、执行工具、决定并发冲突策略之外的业务流程。
 */
export interface ChannelSessionStore {
  getSession(key: ChannelSessionKey): Promise<ChannelSession | null>;
  createSession(key: ChannelSessionKey): Promise<ChannelSession>;
  saveSession(patch: SessionPatch): Promise<ChannelSession>;
}

