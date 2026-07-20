import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { LlmMessage, LlmMessageToolCall } from "../core/agent";

export type WebConversationRole = LlmMessage["role"];

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
    const conversation: WebConversation = {
      id: `web_${Date.now()}_${randomUUID().slice(0, 8)}`,
      title: title === undefined || title.trim().length === 0
        ? "Untitled session"
        : title.trim(),
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
  ): Promise<WebConversation> {
    const normalizedTitle = normalizeTitle(title);
    const conversations = await this.readAll();
    const existing = conversations.find(
      (conversation) => conversation.id === conversationId,
    );
    if (existing === undefined) {
      throw new Error(`Unknown WebUI conversation: ${conversationId}`);
    }
    const updated: WebConversation = {
      ...existing,
      title: normalizedTitle,
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
