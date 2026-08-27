import type { SlackUserId, ToolCallId, WorkspacePath } from "./ids";
import type { SlackConversationRef } from "./slack";

export type ToolName = string;

/**
 * 职责：描述 read 工具读取单个 workspace 文件的输入。
 * 不应承担：检查路径权限、读取文件、截断输出策略。
 */
export interface ReadToolInput {
  readonly path: WorkspacePath;
  readonly offset?: number;
  readonly limit?: number;
  readonly startLine?: number;
  readonly endLine?: number;
}

/**
 * 职责：描述读取已索引 Skill 文件或相对资源的输入。
 * 不应承担：扫描 Skill、授权任意 .pibot 文件读取、解释 Skill 内容。
 */
export interface ReadSkillToolInput {
  readonly location: string;
  readonly path?: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly startLine?: number;
  readonly endLine?: number;
}

/**
 * 职责：描述写入 pibot-wide Skill 包内文件的输入。
 * 不应承担：写普通 workspace 文件、绕过全局 Skill 审批、执行 Skill 脚本。
 */
export interface WriteSkillToolInput {
  readonly name: string;
  readonly path?: string;
  readonly content: string;
  readonly overwrite: boolean;
}

/**
 * 职责：描述 grep 工具在 workspace 内搜索文本的输入。
 * 不应承担：执行搜索、排序结果、限制结果数量。
 */
export interface GrepToolInput {
  readonly pattern: string;
  readonly paths: readonly WorkspacePath[];
  readonly caseSensitive: boolean;
  readonly includeGlobs: readonly string[];
  readonly excludeGlobs: readonly string[];
}

/**
 * 职责：描述 bash 工具执行命令的输入。
 * 不应承担：审批危险命令、启动进程、收集 stdout 和 stderr。
 */
export interface BashToolInput {
  readonly command: string;
  readonly cwd?: WorkspacePath;
  readonly timeoutMs?: number;
}

/**
 * 职责：描述 edit 工具的一次文本替换。
 * 不应承担：查找文件、处理多文件变更、写入磁盘。
 */
export interface TextReplacement {
  readonly oldText: string;
  readonly newText: string;
  readonly occurrence?: number;
}

/**
 * 职责：描述 edit 工具对单个文件的替换请求。
 * 不应承担：应用补丁、解决冲突、执行格式化。
 */
export interface EditToolInput {
  readonly path: WorkspacePath;
  readonly replacements: readonly TextReplacement[];
  readonly expectedSha256?: string;
}

/**
 * 职责：描述 write 工具写入单个文件的请求。
 * 不应承担：创建目录策略、审批覆盖行为、执行磁盘写入。
 */
export interface WriteToolInput {
  readonly path: WorkspacePath;
  readonly content: string;
  readonly overwrite: boolean;
  readonly expectedSha256?: string;
}

export interface MemoryReadToolInput {
  readonly scope: "global";
  readonly document:
    | "instructions"
    | "summary"
    | "index"
    | "topic"
    | "rollout_summary"
    | "extension_note"
    | "audit";
  readonly topic?: string;
}

export interface MemoryWriteToolInput {
  readonly scope: "global";
  readonly document:
    | "summary"
    | "index"
    | "topic"
    | "rollout_summary"
    | "extension_note";
  readonly topic?: string;
  readonly content: string;
  readonly reason: string;
}

export interface MemoryDeleteToolInput {
  readonly scope: "global";
  readonly document:
    | "summary"
    | "index"
    | "topic"
    | "rollout_summary"
    | "extension_note";
  readonly topic?: string;
  readonly reason: string;
}

export interface EnterPlanModeToolInput {
  readonly goal?: string;
}

export interface UpdatePlanToolInput {
  readonly content: string;
  readonly tasks?: readonly unknown[];
  readonly reason?: string;
}

export interface ExitPlanModeToolInput {
  readonly summary?: string;
}

export interface EnterCoordinatorModeToolInput {
  readonly goal?: string;
}

export interface ExitCoordinatorModeToolInput {
  readonly summary?: string;
}

export interface TasksReadToolInput {
  readonly includeNext?: boolean;
}

export interface TasksUpdateToolInput {
  readonly tasks: readonly unknown[];
  readonly reason?: string;
  readonly maxReplans?: number;
}

export interface TaskUpdateToolInput {
  readonly id: string;
  readonly status: "pending" | "in_progress" | "completed" | "failed" | "blocked";
  readonly notes?: string;
  readonly error?: string;
  readonly result?: string;
}

export interface CreateEvolutionTaskToolInput {
  readonly summary: string;
  readonly details?: string;
  readonly severity?: "info" | "warning" | "critical";
  readonly scope?: "global_agent" | "profile" | "adapter" | "runtime";
  readonly target?:
    | "self_instructions"
    | "prompt"
    | "policy"
    | "skill"
    | "tool"
    | "runtime_code";
}

export interface AttachToolInput {
  readonly path: WorkspacePath;
  readonly title?: string;
  readonly initialComment?: string;
}

export interface LspToolInput {
  readonly action: "definition" | "references" | "diagnostics";
  readonly path?: WorkspacePath;
  readonly line?: number;
  readonly character?: number;
  readonly maxResults?: number;
}

export interface AgentSpawnToolInput {
  readonly role: "explore" | "review" | "test" | "implement";
  readonly task: string;
  readonly readOnly?: boolean;
  readonly timeoutMs?: number;
  readonly maxToolCalls?: number;
  readonly maxTokens?: number;
  readonly worktreePath?: string;
}

export interface AgentListToolInput {
  readonly includeCompleted?: boolean;
}

export interface AgentCaptureToolInput {
  readonly childRunId: string;
  readonly lines?: number;
  readonly maxChars?: number;
}

export interface AgentSendToolInput {
  readonly childRunId: string;
  readonly text: string;
  readonly enter?: boolean;
}

export interface AgentStopToolInput {
  readonly childRunId: string;
  readonly reason?: string;
}

export interface AgentCollectToolInput {
  readonly childRunId: string;
}

export type ToolInputByName = {
  readonly read: ReadToolInput;
  readonly read_skill: ReadSkillToolInput;
  readonly write_skill: WriteSkillToolInput;
  readonly grep: GrepToolInput;
  readonly bash: BashToolInput;
  readonly agent_spawn: AgentSpawnToolInput;
  readonly agent_list: AgentListToolInput;
  readonly agent_capture: AgentCaptureToolInput;
  readonly agent_send: AgentSendToolInput;
  readonly agent_stop: AgentStopToolInput;
  readonly agent_collect: AgentCollectToolInput;
  readonly attach: AttachToolInput;
  readonly lsp: LspToolInput;
  readonly edit: EditToolInput;
  readonly write: WriteToolInput;
  readonly memory_read: MemoryReadToolInput;
  readonly memory_write: MemoryWriteToolInput;
  readonly memory_delete: MemoryDeleteToolInput;
  readonly enter_plan_mode: EnterPlanModeToolInput;
  readonly update_plan: UpdatePlanToolInput;
  readonly exit_plan_mode: ExitPlanModeToolInput;
  readonly enter_coordinator_mode: EnterCoordinatorModeToolInput;
  readonly exit_coordinator_mode: ExitCoordinatorModeToolInput;
  readonly tasks_read: TasksReadToolInput;
  readonly tasks_update: TasksUpdateToolInput;
  readonly task_update: TaskUpdateToolInput;
  readonly create_evolution_task: CreateEvolutionTaskToolInput;
};

export interface ToolCall<Input = unknown> {
  readonly id: ToolCallId;
  readonly name: ToolName;
  readonly input: Input;
  readonly reason?: string;
}

export interface UnparsedToolCall {
  readonly id: ToolCallId;
  readonly name: string;
  readonly argumentsJson: string;
}

export type ToolExecutionMode = "parallel" | "sequential";
export type ToolRiskLevel = "read-only" | "mutating" | "external";
export type LegacyToolRiskLevel = "low" | "medium" | "high";
export type ToolApprovalRisk = ToolRiskLevel | LegacyToolRiskLevel;

export interface ToolMetadata {
  readonly name: ToolName;
  readonly riskLevel: ToolRiskLevel;
  readonly executionMode: ToolExecutionMode;
}

export type ToolCallParseResult =
  | {
      readonly ok: true;
      readonly call: ToolCall;
    }
  | {
      readonly ok: false;
      readonly call: ToolCall;
      readonly message: string;
    };

/**
 * 职责：表达 read 工具成功读取后的内容和行号范围。
 * 不应承担：决定是否把内容发给 Slack、更新 transcript、缓存文件内容。
 */
export interface ReadToolOutput {
  readonly path: WorkspacePath;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly truncated: boolean;
  readonly sha256?: string;
}

/**
 * 职责：表达 read_skill 成功读取后的内容和行号范围。
 * 不应承担：暴露真实宿主绝对路径、读取未索引的 Skill。
 */
export interface ReadSkillToolOutput {
  readonly location: string;
  readonly path: string;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly truncated: boolean;
  readonly sha256?: string;
}

/**
 * 职责：表达 grep 工具中的单条匹配结果。
 * 不应承担：聚合结果、生成摘要、定位编辑范围。
 */
export interface GrepMatch {
  readonly path: WorkspacePath;
  readonly line: number;
  readonly text: string;
}

/**
 * 职责：表达 grep 工具成功完成后的匹配集合。
 * 不应承担：再次查询文件、裁剪 agent 上下文、渲染 Slack block。
 */
export interface GrepToolOutput {
  readonly matches: readonly GrepMatch[];
  readonly truncated: boolean;
}

/**
 * 职责：表达 bash 工具运行后的退出码和输出。
 * 不应承担：解释命令语义、自动重试、决定后续 agent 动作。
 */
export interface BashToolOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

/**
 * 职责：描述 write/edit 工具造成的文件内容变化摘要。
 * 不应承担：生成完整 diff、解释业务影响、提交 git。
 */
export interface FileMutationSummary {
  readonly changed: boolean;
  readonly beforeBytes?: number;
  readonly afterBytes: number;
  readonly addedLines: number;
  readonly removedLines: number;
  readonly replacementsApplied?: number;
  readonly description: string;
}

/**
 * 职责：表达 edit/write 工具完成后的文件指纹变化。
 * 不应承担：生成 diff、提交 git、触发测试。
 */
export interface FileMutationOutput {
  readonly path: WorkspacePath;
  readonly beforeSha256?: string;
  readonly afterSha256: string;
  readonly summary: FileMutationSummary;
}

export type ToolOutputByName = {
  readonly read: ReadToolOutput;
  readonly read_skill: ReadSkillToolOutput;
  readonly write_skill: FileMutationOutput;
  readonly grep: GrepToolOutput;
  readonly bash: BashToolOutput;
  readonly edit: FileMutationOutput;
  readonly write: FileMutationOutput;
};

export interface ToolResultArtifactRef {
  readonly kind: "tool_result_blob";
  /** Store-root-relative locator, never an absolute host path. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly toolName: string;
  readonly regenerable: boolean;
}

export type ToolResult =
  | {
      readonly ok: true;
      readonly callId: ToolCallId;
      readonly output: unknown;
      readonly artifact?: ToolResultArtifactRef;
    }
  | {
      readonly ok: false;
      readonly callId: ToolCallId;
      readonly error: ToolError;
      readonly artifact?: ToolResultArtifactRef;
    };

/**
 * 职责：表达工具执行失败的稳定错误形状。
 * 不应承担：记录日志、决定重试、转换成用户可见回复。
 */
export interface ToolError {
  readonly code:
    | "not_found"
    | "permission_denied"
    | "invalid_input"
    | "timeout"
    | "aborted"
    | "conflict"
    | "execution_failed";
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * 职责：描述一个需要审批的工具调用和风险说明。
 * 不应承担：询问用户、执行审批结果、修改工具输入。
 */
export interface ToolApprovalRequest {
  readonly call: ToolCall;
  readonly risk: ToolApprovalRisk;
  readonly explanation: string;
}

export interface ToolApprovalContext {
  readonly conversation: SlackConversationRef;
  readonly requestedByUserId: SlackUserId;
}

export interface ToolApprovalPromptRequest extends ToolApprovalRequest {
  readonly context: ToolApprovalContext;
  readonly timeoutMs: number;
}

export type ToolApprovalDecision =
  | {
      readonly approved: true;
    }
  | {
      readonly approved: false;
      readonly reason: string;
    };
