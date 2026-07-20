import type { AgentRunId } from "../core/ids";
import type { LlmMessage } from "../core/agent";
import type { ChannelSessionKey } from "../core/session";
import type {
  ChannelWorkspaceStore,
  MemoryMutationResult,
  MemoryMutationSource,
} from "./store";

export interface RunRolloutSummaryRequest {
  readonly key: ChannelSessionKey;
  readonly runId: AgentRunId;
  readonly userText: string;
  readonly reason: string;
  readonly turns: number;
  readonly messages: readonly LlmMessage[];
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly durationMs?: number;
  readonly source: MemoryMutationSource;
  readonly createdAt?: Date;
}

export async function recordRunRolloutSummary(
  store: ChannelWorkspaceStore,
  request: RunRolloutSummaryRequest,
): Promise<MemoryMutationResult | undefined> {
  const topic = rolloutSummaryTopic(request.createdAt ?? new Date(), request.runId);
  const content = formatRunRolloutSummary(request);
  return store.writeMemoryDocument(request.key, {
    scope: "global",
    document: "rollout_summary",
    topic,
    content,
    reason: "Automatically record a completed agent run summary",
    source: request.source,
  });
}

function rolloutSummaryTopic(createdAt: Date, runId: AgentRunId): string {
  const date = createdAt.toISOString().slice(0, 10).replace(/-/gu, "");
  const sanitizedRunId = String(runId)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  return `run-${date}-${sanitizedRunId || "unknown"}`.slice(0, 64);
}

function formatRunRolloutSummary(request: RunRolloutSummaryRequest): string {
  const createdAt = (request.createdAt ?? new Date()).toISOString();
  const finalText = finalAssistantText(request.messages);
  const toolNames = uniqueToolNames(request.messages);
  const lines = [
    `# Run ${request.runId} Summary`,
    "",
    "## Metadata",
    "",
    `- Created at: ${createdAt}`,
    `- Run ID: ${request.runId}`,
    `- End reason: ${request.reason}`,
    `- Turns: ${request.turns}`,
    ...(request.durationMs === undefined
      ? []
      : [`- Duration: ${request.durationMs} ms`]),
    ...(request.errorCode === undefined ? [] : [`- Error code: ${request.errorCode}`]),
    ...(request.errorMessage === undefined
      ? []
      : [`- Error message: ${singleLine(request.errorMessage, 240)}`]),
    ...(toolNames.length === 0
      ? ["- Tools used: none"]
      : [`- Tools used: ${toolNames.join(", ")}`]),
    "",
    "## User Request",
    "",
    fencedText(request.userText, 1200),
    "",
    "## Final Assistant Output",
    "",
    finalText.length === 0 ? "(no final assistant text)" : fencedText(finalText, 2400),
    "",
    "## Reuse Guidance",
    "",
    "- Treat this as a completed-run recap, not a source of truth by itself.",
    "- Before relying on details here, recheck drift-prone repo, runtime, or environment facts.",
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

function finalAssistantText(messages: readonly LlmMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.content.trim().length > 0) {
      return message.content.trim();
    }
  }
  return "";
}

function uniqueToolNames(messages: readonly LlmMessage[]): readonly string[] {
  const names = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const call of message.toolCalls ?? []) {
      names.add(call.name);
    }
  }
  return [...names].sort();
}

function fencedText(text: string, maxChars: number): string {
  const trimmed = truncate(text.trim(), maxChars);
  return `\`\`\`text\n${trimmed}\n\`\`\``;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n...[truncated]`;
}

function singleLine(text: string, maxChars: number): string {
  return truncate(text.replace(/\s+/gu, " ").trim(), maxChars);
}
