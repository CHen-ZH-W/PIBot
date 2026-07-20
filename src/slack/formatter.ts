import type { AgentLoopError } from "../agent/events";
import type { ToolCall, ToolResult } from "../core/tools";

export const SLACK_TEXT_LIMIT = 30000;
export const SLACK_UPDATE_TEXT_LIMIT = 3500;
const ASSISTANT_PREVIEW_BYTES = 900;

/**
 * 职责：表达 Slack mrkdwn 分片后的文本块。
 * 不应承担：调用 Slack API、维护消息 ts、决定发布到主消息还是 thread。
 */
export interface SlackTextChunk {
  readonly index: number;
  readonly total: number;
  readonly text: string;
}

/**
 * 职责：表达主消息当前应展示的 agent 文本和短状态行。
 * 不应承担：执行 agent、发布 Slack 消息、保存 session。
 */
export interface SlackMainMessageState {
  readonly assistantText: string;
  readonly progressText?: string;
  readonly statusLines: readonly string[];
}

export function formatThinkingMessage(): string {
  return "Thinking...";
}

export function formatCancelledMessage(): string {
  return "Cancelled.";
}

export function formatNoActiveRunMessage(): string {
  return "No active run to cancel.";
}

export function formatBusyMessage(): string {
  return "The follow-up queue is full. Send `stop` to cancel the active run.";
}

export function formatFollowUpQueuedMessage(position: number): string {
  return `Added to the follow-up queue at position ${position}. Send \`stop\` to cancel the active run.`;
}

export function formatSteeringQueuedMessage(): string {
  return "Steering message received for the active run.";
}

export function formatModeSwitchMessage(mode: string): string {
  return `Runtime mode switched to \`${sanitizeInlineCode(mode)}\` for the active run.`;
}

export function formatLongRunningStatus(elapsedMs: number): string {
  return `_Still working... elapsed ${formatElapsed(elapsedMs)}_`;
}

export function formatAgentErrorMessage(error: AgentLoopError): string {
  return sanitizeSlackMrkdwn(`Agent error (${error.code}). ${error.message}`);
}

export function formatAssistantText(text: string): string {
  const sanitized = sanitizeSlackMrkdwn(text).trim();
  if (sanitized.length === 0) {
    return "No response.";
  }

  return sanitized;
}

export function formatMainMessage(state: SlackMainMessageState): string {
  const sections: string[] = [];
  if (hasVisibleText(state.progressText ?? "")) {
    sections.push(formatThinkingProgress(state.progressText));
    if (hasVisibleText(state.assistantText)) {
      sections.push(formatAssistantPreview(state.assistantText));
    }
  } else {
    sections.push(
      hasVisibleText(state.assistantText)
        ? formatAssistantText(state.assistantText)
        : formatThinkingMessage(),
    );
  }

  if (state.statusLines.length > 0) {
    sections.push(state.statusLines.join("\n"));
  }

  return sections.join("\n\n");
}

export function formatToolStartStatus(toolName: string): string {
  if (toolName === "enter_plan_mode") {
    return "_Waiting for Plan Mode approval..._";
  }
  if (toolName === "update_plan") {
    return "_Updating plan..._";
  }
  if (toolName === "exit_plan_mode") {
    return "_Waiting for plan approval..._";
  }

  return `_Using tool \`${sanitizeInlineCode(toolName)}\`..._`;
}

export function formatToolEndStatus(
  call: ToolCall,
  result: ToolResult,
): string {
  if (call.name === "enter_plan_mode" && result.ok) {
    return "_Plan Mode is active._";
  }
  if (call.name === "update_plan" && result.ok) {
    return "_Plan updated._";
  }
  if (call.name === "exit_plan_mode" && result.ok) {
    return "_Plan approved. Continuing execution..._";
  }

  return result.ok
    ? `_Tool \`${sanitizeInlineCode(call.name)}\` completed._`
    : `_Tool \`${sanitizeInlineCode(call.name)}\` failed._`;
}

export function formatToolEndThreadMessage(
  call: ToolCall,
  result: ToolResult,
): string {
  return [
    `Tool \`${sanitizeInlineCode(call.name)}\` completed`,
    "",
    "*Args*",
    formatJsonFence(call.input),
    "",
    "*Result*",
    formatJsonFence(result),
  ].join("\n");
}

export function splitSlackMrkdwn(
  text: string,
  limit: number = SLACK_TEXT_LIMIT,
): readonly SlackTextChunk[] {
  const normalized = sanitizeSlackMrkdwn(text);
  if (utf8Bytes(normalized) <= limit) {
    return [
      {
        index: 1,
        total: 1,
        text: normalized,
      },
    ];
  }

  const chunks: string[] = [];
  let remaining = normalized;
  while (utf8Bytes(remaining) > limit) {
    const splitAt = findSplitIndex(remaining, limit);
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  const total = chunks.length;
  return chunks.map((chunk, index) => ({
    index: index + 1,
    total,
    text: chunk,
  }));
}

export function firstChunkForUpdate(text: string): string {
  const chunks = splitSlackMrkdwn(text, SLACK_UPDATE_TEXT_LIMIT);
  const first = chunks[0];
  if (first === undefined || first.total === 1) {
    return first?.text ?? "";
  }

  return appendWithinLimit(
    first.text,
    "\n\n_Response is longer than one Slack message and will continue in thread when finished._",
  );
}

export function sanitizeSlackMrkdwn(text: string): string {
  return text.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu,
    "$1 $2",
  );
}

function formatJsonFence(value: unknown): string {
  const json = JSON.stringify(value, null, 2) ?? "null";
  return [
    "```json",
    json.replace(/```/gu, "` ` `"),
    "```",
  ].join("\n");
}

function findSplitIndex(text: string, limit: number): number {
  const hardLimitIndex = largestPrefixIndexByUtf8Bytes(text, limit);
  const newlineIndex = text.lastIndexOf("\n", hardLimitIndex);
  if (newlineIndex >= Math.floor(hardLimitIndex * 0.6)) {
    return newlineIndex + 1;
  }

  const spaceIndex = text.lastIndexOf(" ", hardLimitIndex);
  if (spaceIndex >= Math.floor(hardLimitIndex * 0.6)) {
    return spaceIndex + 1;
  }

  return hardLimitIndex;
}

function appendWithinLimit(text: string, suffix: string): string {
  if (utf8Bytes(text) + utf8Bytes(suffix) <= SLACK_UPDATE_TEXT_LIMIT) {
    return `${text}${suffix}`;
  }

  return `${sliceByUtf8Bytes(
    text,
    SLACK_UPDATE_TEXT_LIMIT - utf8Bytes(suffix),
  )}${suffix}`;
}

function formatAssistantPreview(text: string): string {
  const sanitized = sanitizeSlackMrkdwn(text).trim();
  if (utf8Bytes(sanitized) <= ASSISTANT_PREVIEW_BYTES) {
    return sanitized;
  }

  return `${sliceByUtf8Bytes(sanitized, ASSISTANT_PREVIEW_BYTES)}\n...`;
}

function formatThinkingProgress(progressText: string | undefined): string {
  if (!hasVisibleText(progressText ?? "")) {
    return formatThinkingMessage();
  }

  const excerpt = tailWithinLimit(
    sanitizeSlackMrkdwn(progressText ?? "").trim(),
    12000,
  );
  return `${formatThinkingMessage()}\n\n${excerpt}`;
}

function tailWithinLimit(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `...${text.slice(text.length - maxLength)}`;
}

function sliceByUtf8Bytes(text: string, limit: number): string {
  return text.slice(0, largestPrefixIndexByUtf8Bytes(text, limit));
}

function largestPrefixIndexByUtf8Bytes(text: string, limit: number): number {
  if (limit <= 0) {
    return 0;
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8Bytes(text.slice(0, mid)) <= limit) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return avoidSurrogateSplit(text, low);
}

function avoidSurrogateSplit(text: string, index: number): number {
  if (index <= 0 || index >= text.length) {
    return index;
  }

  const previous = text.charCodeAt(index - 1);
  const next = text.charCodeAt(index);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    return index - 1;
  }

  return index;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function hasVisibleText(text: string): boolean {
  return text.trim().length > 0;
}

function sanitizeInlineCode(text: string): string {
  return text.replace(/`/gu, "'");
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}
