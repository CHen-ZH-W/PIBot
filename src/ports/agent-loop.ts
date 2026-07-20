import type { AgentTurn, AgentTurnRequest } from "../core/agent";
import type { LlmClient } from "./llm";
import type { ToolApprovalGate, ToolExecutor } from "./tools";

/**
 * 职责：声明 AgentLoop 运行一次 turn 所需的模型、工具和审批端口。
 * 不应承担：初始化 provider、执行依赖注入容器逻辑、保存运行状态。
 */
export interface AgentLoopDependencies {
  readonly llm: LlmClient;
  readonly tools: ToolExecutor;
  readonly approvals: ToolApprovalGate;
}

/**
 * 职责：执行一次 coding-agent turn：组织上下文、调用 LLM、按需请求工具、产生可流式消费的 AgentEvent。
 * 不应承担：接收 Slack 原始事件、发布 Slack 消息、持久化 channel session、直接读写文件系统。
 */
export interface AgentLoop {
  runTurn(
    request: AgentTurnRequest,
    dependencies: AgentLoopDependencies,
    signal?: AbortSignal,
  ): AgentTurn;
}
