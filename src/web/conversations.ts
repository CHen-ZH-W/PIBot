import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { LlmMessage, LlmMessageToolCall } from "../core/agent";

export type WebConversationRole = LlmMessage["role"];
export type WebConversationTitleSource = "placeholder" | "model" | "manual";

export interface WebConversationMessage {
  readonly id: string;
  readonly role: WebConversationRole;
  readonly content: string;
  readonly createdAt: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly LlmMessageToolCall[];
  readonly reasoningContent?: string;
}

export interface WebConversation {
  readonly id: string;
  readonly title: string;
  readonly titleSource?: WebConversationTitleSource;
  readonly titleFailureCount?: number;
  readonly titleRetryAfter?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: readonly WebConversationMessage[];
}

interface ConversationFile {
  readonly conversations: readonly WebConversation[];
}

export class FileWebConversationStore {
  private readonly filePath: string;

  constructor(rootDir: string) {
    this.filePath = path.join(path.resolve(rootDir), "webui", "conversations.json");
  }

  async list(): Promise<readonly WebConversation[]> {
    return this.readAll();
  }

  async create(title: string | undefined): Promise<WebConversation> {
    const now = new Date().toISOString();
    const normalizedTitle = title === undefined || title.trim().length === 0
      ? "Untitled session"
      : title.trim();
    const conversation: WebConversation = {
      id: `web_${Date.now()}_${randomUUID().slice(0, 8)}`,
      title: normalizedTitle,
      titleSource: isPlaceholderConversationTitle(normalizedTitle)
        ? "placeholder"
        : "manual",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    const conversations = await this.readAll();
    await this.writeAll([conversation, ...conversations]);
    return conversation;
  }

  async rename(
    conversationId: string,
    title: string,
    options: {
      readonly source?: Exclude<WebConversationTitleSource, "placeholder">;
    } = {},
  ): Promise<WebConversation> {
    const normalizedTitle = normalizeTitle(title);
    const conversations = await this.readAll();
    const existing = conversations.find(
      (conversation) => conversation.id === conversationId,
    );
    if (existing === undefined) {
      throw new Error(`Unknown WebUI conversation: ${conversationId}`);
    }
    const source = options.source ?? "manual";
    if (source === "model" && conversationTitleSource(existing) === "manual") {
      return existing;
    }
    const {
      titleFailureCount: _titleFailureCount,
      titleRetryAfter: _titleRetryAfter,
      ...conversationWithoutTitleFailures
    } = existing;
    const updated: WebConversation = {
      ...conversationWithoutTitleFailures,
      title: normalizedTitle,
      titleSource: source,
      updatedAt: new Date().toISOString(),
    };
    await this.writeAll(
      conversations.map((conversation) =>
        conversation.id === updated.id ? updated : conversation
      ),
    );
    return updated;
  }

  async recordTitleGenerationFailure(
    conversationId: string,
    retryBaseMs = 300_000,
  ): Promise<WebConversation> {
    const conversations = await this.readAll();
    const existing = conversations.find(
      (conversation) => conversation.id === conversationId,
    );
    if (existing === undefined) {
      throw new Error(`Unknown WebUI conversation: ${conversationId}`);
    }
    if (conversationTitleSource(existing) !== "placeholder") {
      return existing;
    }
    const failureCount = (existing.titleFailureCount ?? 0) + 1;
    const retryDelayMs = Math.min(
      3_600_000,
      Math.max(1, retryBaseMs) * failureCount,
    );
    const updated: WebConversation = {
      ...existing,
      titleSource: "placeholder",
      titleFailureCount: failureCount,
      titleRetryAfter: new Date(Date.now() + retryDelayMs).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.writeAll(
      conversations.map((conversation) =>
        conversation.id === updated.id ? updated : conversation
      ),
    );
    return updated;
  }

  async delete(conversationId: string): Promise<void> {
    const conversations = await this.readAll();
    const filtered = conversations.filter(
      (conversation) => conversation.id !== conversationId,
    );
    if (filtered.length === conversations.length) {
      throw new Error(`Unknown WebUI conversation: ${conversationId}`);
    }
    await this.writeAll(filtered);
  }

  async appendMessage(
    conversationId: string,
    role: WebConversationRole,
    content: string,
  ): Promise<WebConversation> {
    return this.appendMessages(conversationId, [
      {
        role,
        content,
      },
    ]);
  }

  async appendLlmMessages(
    conversationId: string,
    messages: readonly LlmMessage[],
  ): Promise<WebConversation> {
    return this.appendMessages(
      conversationId,
      messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.toolCallId === undefined
            ? {}
            : { toolCallId: message.toolCallId }),
          ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
          ...(message.reasoningContent === undefined
            ? {}
            : { reasoningContent: message.reasoningContent }),
        })),
    );
  }

  toLlmHistory(conversation: WebConversation): readonly LlmMessage[] {
    return conversation.messages
      .filter((message) => message.role !== "system")
      .map((message) => webMessageToLlmMessage(message));
  }

  async get(conversationId: string): Promise<WebConversation> {
    const conversations = await this.readAll();
    const existing = conversations.find(
      (conversation) => conversation.id === conversationId,
    );
    if (existing === undefined) {
      throw new Error(`Unknown WebUI conversation: ${conversationId}`);
    }
    return existing;
  }

  private async appendMessages(
    conversationId: string,
    messages: readonly {
      readonly role: WebConversationRole;
      readonly content: string;
      readonly toolCallId?: string;
      readonly toolCalls?: readonly LlmMessageToolCall[];
      readonly reasoningContent?: string;
    }[],
  ): Promise<WebConversation> {
    const conversations = await this.readAll();
    const existing = conversations.find(
      (conversation) => conversation.id === conversationId,
    );
    if (existing === undefined) {
      throw new Error(`Unknown WebUI conversation: ${conversationId}`);
    }
    const now = new Date().toISOString();
    const updated: WebConversation = {
      ...existing,
      updatedAt: now,
      messages: [
        ...existing.messages,
        ...messages.map((message, index) => ({
          id: `msg_${Date.now()}_${index}_${randomUUID().slice(0, 8)}`,
          role: message.role,
          content: message.content,
          createdAt: now,
          ...(message.toolCallId === undefined
            ? {}
            : { toolCallId: message.toolCallId }),
          ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
          ...(message.reasoningContent === undefined
            ? {}
            : { reasoningContent: message.reasoningContent }),
        })),
      ],
    };
    await this.writeAll(
      conversations.map((conversation) =>
        conversation.id === updated.id ? updated : conversation
      ),
    );
    return updated;
  }

  private async readAll(): Promise<readonly WebConversation[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as ConversationFile;
      return parsed.conversations ?? [];
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    }
  }

  private async writeAll(
    conversations: readonly WebConversation[],
  ): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      `${JSON.stringify({ conversations }, null, 2)}\n`,
      "utf8",
    );
  }
}

function normalizeTitle(title: string): string {
  const normalized = title.trim();
  if (normalized.length === 0) {
    throw new Error("Conversation title must not be empty");
  }
  if (normalized.length > 120) {
    throw new Error("Conversation title must be at most 120 characters");
  }
  return normalized;
}

export function conversationTitleSource(
  conversation: WebConversation,
): WebConversationTitleSource {
  if (conversation.titleSource !== undefined) {
    return conversation.titleSource;
  }
  return isPlaceholderConversationTitle(conversation.title)
    ? "placeholder"
    : "manual";
}

export function conversationTitleRetryReady(
  conversation: WebConversation,
  now = Date.now(),
): boolean {
  if (conversationTitleSource(conversation) !== "placeholder") {
    return false;
  }
  if (conversation.titleRetryAfter === undefined) {
    return true;
  }
  const retryAfter = Date.parse(conversation.titleRetryAfter);
  return !Number.isFinite(retryAfter) || retryAfter <= now;
}

function isPlaceholderConversationTitle(title: string): boolean {
  const normalized = title.trim();
  return normalized === "Web session" || normalized === "Untitled session";
}

function webMessageToLlmMessage(message: WebConversationMessage): LlmMessage {
  const result: {
    role: LlmMessage["role"];
    content: string;
    toolCallId?: NonNullable<LlmMessage["toolCallId"]>;
    toolCalls?: readonly LlmMessageToolCall[];
    reasoningContent?: string;
  } = {
    role: message.role,
    content: message.content,
  };
  if (message.toolCallId !== undefined) {
    result.toolCallId = message.toolCallId as NonNullable<LlmMessage["toolCallId"]>;
  }
  if (message.toolCalls !== undefined) {
    result.toolCalls = message.toolCalls;
  }
  if (message.reasoningContent !== undefined) {
    result.reasoningContent = message.reasoningContent;
  }
  return result;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
