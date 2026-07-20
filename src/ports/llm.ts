import type { LlmRequest, LlmStreamEvent } from "../core/agent";

/**
 * 职责：把规范化的 LLM 请求发送给模型提供方，并返回流式模型事件。
 * 不应承担：Slack 协议处理、工具执行、session 存储、agent loop 的控制策略。
 */
export interface LlmClient {
  streamCompletion(
    request: LlmRequest,
    signal?: AbortSignal,
  ): AsyncIterable<LlmStreamEvent>;
}

