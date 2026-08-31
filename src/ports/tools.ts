import type {
  ToolApprovalDecision,
  ToolApprovalPromptRequest,
  ToolApprovalRequest,
  ToolCall,
  ToolCallParseResult,
  ToolMetadata,
  ToolName,
  ToolExecutionSnapshot,
  ToolResult,
  UnparsedToolCall,
} from "../core/tools";
import type { ToolCapabilityRequest } from "../core/capabilities";

/**
 * 职责：暴露当前运行环境可用的 coding tools，并执行 read/grep/bash/edit/write 这五类工具调用。
 * 不应承担：选择何时调用工具、组织 LLM prompt、发布 Slack 消息、保存 session。
 */
export interface ToolExecutor {
  listTools(): readonly ToolName[];
  /** Captures the immutable authority that a model Step is allowed to rely on. */
  captureExecutionSnapshot?(): ToolExecutionSnapshot;
  describeTool?(name: string): ToolMetadata | undefined;
  parseToolCall?(call: UnparsedToolCall): ToolCallParseResult;
  resolveCapabilities?(call: ToolCall): ToolCapabilityRequest;
  executeTool(
    call: ToolCall,
    signal?: AbortSignal,
    snapshot?: ToolExecutionSnapshot,
  ): Promise<ToolResult>;
}

/**
 * 职责：对工具调用做安全审批边界，尤其是 bash/edit/write 等有副作用的操作。
 * 不应承担：实际执行工具、修改文件、调用 LLM、把审批请求直接发到 Slack。
 */
export interface ToolApprovalGate {
  reviewToolCall(
    request: ToolApprovalRequest,
    signal?: AbortSignal,
  ): Promise<ToolApprovalDecision>;
}

/**
 * 职责：向用户展示一次工具审批请求，并等待单次决策。
 * 不应承担：决定哪些风险需要审批、实际执行工具、永久修改权限策略。
 */
export interface ToolApprovalPrompter {
  requestToolApproval(
    request: ToolApprovalPromptRequest,
    signal?: AbortSignal,
  ): Promise<ToolApprovalDecision>;
}
