import type { AgentRunId, MessageId, ToolCallId } from "./ids";
import type { SlackInboundMessage } from "./slack";
import type { ToolCall, ToolResult } from "./tools";

export type AgentRole = "system" | "user" | "assistant" | "tool";

/**
 * 职责：表达 agent transcript 中的一条规范化消息。
 * 不应承担：裁剪上下文、序列化存储、转换 Slack 文本格式。
 */
export interface AgentMessage {
  readonly id: MessageId;
  readonly role: AgentRole;
  readonly content: string;
  readonly createdAt: Date;
  readonly toolCallId?: ToolCallId;
}

/**
 * 职责：保存一次 channel session 中 agent 需要延续的状态。
 * 不应承担：读写数据库、生成摘要、决定 session 生命周期。
 */
export interface AgentSessionState {
  readonly messages: readonly AgentMessage[];
}

/**
 * 职责：描述启动一次 agent turn 所需的输入、run id 和当前状态。
 * 不应承担：加载 session、创建 run id、校验 Slack 签名。
 */
export interface AgentTurnRequest {
  readonly runId: AgentRunId;
  readonly input: SlackInboundMessage;
  readonly state: AgentSessionState;
}

export type AgentEvent =
  | {
      readonly type: "run.started";
      readonly runId: AgentRunId;
    }
  | {
      readonly type: "assistant.delta";
      readonly runId: AgentRunId;
      readonly text: string;
    }
  | {
      readonly type: "assistant.message";
      readonly runId: AgentRunId;
      readonly message: AgentMessage;
    }
  | {
      readonly type: "tool.requested";
      readonly runId: AgentRunId;
      readonly call: ToolCall;
    }
  | {
      readonly type: "tool.completed";
      readonly runId: AgentRunId;
      readonly result: ToolResult;
    }
  | {
      readonly type: "run.failed";
      readonly runId: AgentRunId;
      readonly error: AgentRunError;
    }
  | {
      readonly type: "run.completed";
      readonly runId: AgentRunId;
      readonly nextState: AgentSessionState;
    };

/**
 * 职责：描述 agent loop 边界可理解的失败信息。
 * 不应承担：生成用户可见回复、重试请求、记录日志。
 */
export interface AgentRunError {
  readonly code:
    | "llm_error"
    | "tool_error"
    | "cancelled"
    | "invalid_state"
    | "unknown";
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * 职责：把一次 agent turn 暴露为事件流和最终完成结果。
 * 不应承担：消费事件流、发布 Slack 消息、保存完成后的 session。
 */
export interface AgentTurn {
  readonly events: AsyncIterable<AgentEvent>;
  readonly completion: Promise<AgentTurnCompletion>;
}

/**
 * 职责：表达一次 agent turn 完成后的持久化候选状态。
 * 不应承担：执行持久化、解决并发写冲突、修改 Slack 消息。
 */
export interface AgentTurnCompletion {
  readonly runId: AgentRunId;
  readonly nextState: AgentSessionState;
}

/**
 * 职责：表达 assistant 消息中由模型请求的工具调用。
 * 不应承担：执行工具、校验工具参数、保存工具结果。
 */
export interface LlmMessageToolCall {
  readonly id: ToolCallId;
  readonly name: string;
  readonly argumentsJson: string;
}

export type LlmMessageContentPart =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "image_url";
      readonly imageUrl: {
        readonly url: string;
        readonly detail?: "auto" | "low" | "high";
      };
    };

/**
 * 职责：表达传给 LLM provider 的最小消息结构。
 * 不应承担：构造 prompt、处理 token 流、执行工具调用。
 */
export interface LlmMessage {
  readonly role: AgentRole;
  readonly content: string;
  readonly contentParts?: readonly LlmMessageContentPart[];
  readonly toolCallId?: ToolCallId;
  readonly toolCalls?: readonly LlmMessageToolCall[];
  readonly reasoningContent?: string;
}

/**
 * 职责：描述暴露给 LLM 的工具 schema。
 * 不应承担：执行工具、校验运行时输入、决定工具授权。
 */
export interface LlmToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchemaJson: string;
}

/**
 * 职责：承载一次 LLM 流式请求的消息、工具和采样参数。
 * 不应承担：选择模型 provider、发送网络请求、更新 agent 状态。
 */
export interface LlmRequest {
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly LlmToolSchema[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

export type LlmStreamEvent =
  | {
      readonly type: "text.delta";
      readonly text: string;
    }
  | {
      readonly type: "tool.call";
      readonly call: ToolCall;
    }
  | {
      readonly type: "message.completed";
      readonly message: LlmMessage;
    };
