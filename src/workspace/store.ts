import { createHash } from "node:crypto";
import * as path from "node:path";
import { appendFile, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import type { ChannelSessionKey } from "../core/session";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * 职责：定位一个 Slack channel 对应的本地持久化文件。
 * 不应承担：解释 transcript、调用模型、执行工具、决定上下文裁剪策略。
 */
export interface ChannelWorkspacePaths {
  readonly rootDir: string;
  readonly channelsDir: string;
  readonly channelDir: string;
  readonly attachmentsDir: string;
  readonly logFile: string;
  readonly contextFile: string;
  readonly globalInstructionsFile: string;
  readonly globalMemoriesDir: string;
  readonly globalMemoryFile: string;
  readonly globalMemoryDir: string;
  readonly globalMemorySummaryFile: string;
  readonly globalMemoryRolloutSummariesDir: string;
  readonly globalMemoryExtensionNotesDir: string;
  readonly globalMemoryAuditFile: string;
  readonly legacyGlobalMemoryFile: string;
  readonly legacyGlobalMemoryDir: string;
  readonly legacyGlobalMemoryAuditFile: string;
  readonly channelInstructionsFile: string;
}

/**
 * 职责：表达从 JSONL 文件读出的一条合法 JSON object 及其位置。
 * 不应承担：校验业务 schema、构造 LLM messages、修改文件内容。
 */
export interface JsonlEntry {
  readonly filePath: string;
  readonly lineNumber: number;
  readonly record: JsonObject;
}

export type WorkspaceStoreWarningCode =
  | "jsonl_parse_error"
  | "jsonl_non_object"
  | "invalid_log_record"
  | "invalid_context_record"
  | "compaction_failed"
  | "tool_result_archive_failed"
  | "memory_curation_failed";

/**
 * 职责：描述本地 workspace store 读写时可恢复的问题。
 * 不应承担：决定是否中断 agent run、生成 Slack 回复、修复坏数据。
 */
export interface WorkspaceStoreWarning {
  readonly code: WorkspaceStoreWarningCode;
  readonly filePath: string;
  readonly message: string;
  readonly lineNumber?: number;
  readonly rawLine?: string;
}

export type WorkspaceStoreWarningHandler = (
  warning: WorkspaceStoreWarning,
) => void;

/**
 * 职责：表达可注入 system prompt 的持久记忆内容。
 * 不应承担：总结、压缩、编辑 memory 文件。
 */
export interface WorkspaceMemories {
  readonly globalInstructions?: string;
  readonly channelInstructions?: string;
  readonly globalMemorySummary?: string;
  readonly globalMemory?: string;
}

export type MemoryScope = "global";
export type MemoryDocument =
  | "instructions"
  | "summary"
  | "index"
  | "topic"
  | "rollout_summary"
  | "extension_note"
  | "audit";
export type WritableMemoryDocument =
  | "summary"
  | "index"
  | "topic"
  | "rollout_summary"
  | "extension_note";

export interface MemoryDocumentRef {
  readonly scope: MemoryScope;
  readonly document: MemoryDocument;
  readonly topic?: string;
}

export interface WritableMemoryDocumentRef {
  readonly scope: MemoryScope;
  readonly document: WritableMemoryDocument;
  readonly topic?: string;
}

export interface MemoryMutationSource {
  readonly type: "agent_tool" | "user" | "system";
  readonly runId?: string;
  readonly userId?: string;
}

export interface MemoryMutationRequest extends WritableMemoryDocumentRef {
  readonly reason: string;
  readonly source: MemoryMutationSource;
}

export interface MemoryWriteRequest extends MemoryMutationRequest {
  readonly content: string;
}

interface MemoryReferenceUpdate {
  readonly scope: MemoryScope;
  readonly topic: string | undefined;
  readonly section: string;
  readonly marker: string;
  readonly bullet: string;
  readonly reason: string;
  readonly source: MemoryMutationSource;
}

interface MemoryReferenceRemove {
  readonly scope: MemoryScope;
  readonly topic: string | undefined;
  readonly section: string;
  readonly marker: string;
  readonly reason: string;
  readonly source: MemoryMutationSource;
}

export interface MemoryReadResult extends MemoryDocumentRef {
  readonly path: string;
  readonly content?: string;
}

export interface MemoryMutationResult extends WritableMemoryDocumentRef {
  readonly path: string;
  readonly changed: boolean;
  readonly beforeBytes?: number;
  readonly afterBytes?: number;
}

/**
 * 职责：提供 per-channel 目录、log/context JSONL 和 MEMORY.md 的文件边界。
 * 不应承担：解释 Slack 消息、构造 agent history、做 compaction、执行工具。
 */
export interface ChannelWorkspaceStore {
  getPaths(key: ChannelSessionKey): ChannelWorkspacePaths;
  ensureChannelDirectory(key: ChannelSessionKey): Promise<ChannelWorkspacePaths>;
  appendLogRecord(
    key: ChannelSessionKey,
    record: JsonObject,
  ): Promise<void>;
  appendContextRecord(
    key: ChannelSessionKey,
    record: JsonObject,
  ): Promise<void>;
  readLogEntries(key: ChannelSessionKey): Promise<readonly JsonlEntry[]>;
  readContextEntries(key: ChannelSessionKey): Promise<readonly JsonlEntry[]>;
  readMemories(key: ChannelSessionKey): Promise<WorkspaceMemories>;
  readMemoryDocument(
    key: ChannelSessionKey,
    ref: MemoryDocumentRef,
  ): Promise<MemoryReadResult>;
  writeMemoryDocument(
    key: ChannelSessionKey,
    request: MemoryWriteRequest,
  ): Promise<MemoryMutationResult>;
  deleteMemoryDocument(
    key: ChannelSessionKey,
    request: MemoryMutationRequest,
  ): Promise<MemoryMutationResult>;
  deleteChannelDirectory(key: ChannelSessionKey): Promise<void>;
  recordWarning(warning: WorkspaceStoreWarning): void;
}

export interface FileChannelWorkspaceStoreOptions {
  readonly rootDir: string;
  readonly onWarning?: WorkspaceStoreWarningHandler;
  readonly maxLogFileBytes?: number;
  readonly maxContextFileBytes?: number;
  readonly maxMemoryFileBytes?: number;
  readonly maxMemoryIndexFileBytes?: number;
  readonly maxMemoryAuditFileBytes?: number;
}

export class FileChannelWorkspaceStore implements ChannelWorkspaceStore {
  private readonly rootDir: string;
  private readonly onWarning: WorkspaceStoreWarningHandler | undefined;
  private readonly maxLogFileBytes: number;
  private readonly maxContextFileBytes: number;
  private readonly maxMemoryFileBytes: number;
  private readonly maxMemoryIndexFileBytes: number;
  private readonly maxMemoryAuditFileBytes: number;

  constructor(options: FileChannelWorkspaceStoreOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.onWarning = options.onWarning;
    this.maxLogFileBytes = positiveInteger(
      options.maxLogFileBytes,
      2_000_000,
      "maxLogFileBytes",
    );
    this.maxContextFileBytes = positiveInteger(
      options.maxContextFileBytes,
      10_000_000,
      "maxContextFileBytes",
    );
    this.maxMemoryFileBytes = positiveInteger(
      options.maxMemoryFileBytes,
      64_000,
      "maxMemoryFileBytes",
    );
    this.maxMemoryIndexFileBytes = positiveInteger(
      options.maxMemoryIndexFileBytes,
      8_000,
      "maxMemoryIndexFileBytes",
    );
    this.maxMemoryAuditFileBytes = positiveInteger(
      options.maxMemoryAuditFileBytes,
      2_000_000,
      "maxMemoryAuditFileBytes",
    );
  }

  getPaths(key: ChannelSessionKey): ChannelWorkspacePaths {
    const channelsDir = resolveInside(this.rootDir, "channels");
    const teamSegment = encodePathSegment(key.teamId);
    const channelSegments = channelPathSegments(key.channelId);
    const globalMemoriesDir = resolveInside(this.rootDir, "memories");
    const channelDir = resolveInside(
      this.rootDir,
      "channels",
      teamSegment,
      ...channelSegments,
    );
    return {
      rootDir: this.rootDir,
      channelsDir,
      channelDir,
      attachmentsDir: path.join(channelDir, "attachments"),
      logFile: path.join(channelDir, "log.jsonl"),
      contextFile: path.join(channelDir, "context.jsonl"),
      globalInstructionsFile: path.join(this.rootDir, "instructions.md"),
      globalMemoriesDir,
      globalMemoryFile: path.join(globalMemoriesDir, "MEMORY.md"),
      globalMemoryDir: path.join(globalMemoriesDir, "topics"),
      globalMemorySummaryFile: path.join(globalMemoriesDir, "memory_summary.md"),
      globalMemoryRolloutSummariesDir: path.join(globalMemoriesDir, "rollout_summaries"),
      globalMemoryExtensionNotesDir: path.join(
        globalMemoriesDir,
        "extensions",
        "ad_hoc",
        "notes",
      ),
      globalMemoryAuditFile: path.join(globalMemoriesDir, "audit.jsonl"),
      legacyGlobalMemoryFile: path.join(this.rootDir, "MEMORY.md"),
      legacyGlobalMemoryDir: path.join(this.rootDir, "memory"),
      legacyGlobalMemoryAuditFile: path.join(this.rootDir, "memory", "audit.jsonl"),
      channelInstructionsFile: path.join(channelDir, "instructions.md"),
    };
  }

  async ensureChannelDirectory(
    key: ChannelSessionKey,
  ): Promise<ChannelWorkspacePaths> {
    const paths = this.getPaths(key);
    await mkdir(paths.channelDir, { recursive: true });
    return paths;
  }

  async appendLogRecord(
    key: ChannelSessionKey,
    record: JsonObject,
  ): Promise<void> {
    const paths = await this.ensureChannelDirectory(key);
    await appendJsonl(paths.logFile, record, this.maxLogFileBytes);
  }

  async appendContextRecord(
    key: ChannelSessionKey,
    record: JsonObject,
  ): Promise<void> {
    const paths = await this.ensureChannelDirectory(key);
    await appendJsonl(paths.contextFile, record, this.maxContextFileBytes);
  }

  async readLogEntries(key: ChannelSessionKey): Promise<readonly JsonlEntry[]> {
    const paths = await this.ensureChannelDirectory(key);
    return this.readJsonlEntries(paths.logFile);
  }

  async readContextEntries(
    key: ChannelSessionKey,
  ): Promise<readonly JsonlEntry[]> {
    const paths = await this.ensureChannelDirectory(key);
    return this.readJsonlEntries(paths.contextFile);
  }

  async readMemories(key: ChannelSessionKey): Promise<WorkspaceMemories> {
    const paths = await this.ensureChannelDirectory(key);
    const globalInstructions = await readTextIfExists(
      paths.globalInstructionsFile,
      this.maxMemoryFileBytes,
    );
    const channelInstructions = await readTextIfExists(
      paths.channelInstructionsFile,
      this.maxMemoryFileBytes,
    );
    const globalMemorySummary = await readTextIfExists(
      paths.globalMemorySummaryFile,
      this.maxMemoryIndexFileBytes,
    );
    const globalMemory = await readTextWithLegacyFallback(
      paths.globalMemoryFile,
      paths.legacyGlobalMemoryFile,
      this.maxMemoryIndexFileBytes,
    );

    return {
      ...(globalInstructions !== undefined ? { globalInstructions } : {}),
      ...(channelInstructions !== undefined ? { channelInstructions } : {}),
      ...(globalMemorySummary !== undefined ? { globalMemorySummary } : {}),
      ...(globalMemory !== undefined ? { globalMemory } : {}),
    };
  }

  async readMemoryDocument(
    key: ChannelSessionKey,
    ref: MemoryDocumentRef,
  ): Promise<MemoryReadResult> {
    const paths = await this.ensureChannelDirectory(key);
    const filePath = memoryDocumentPath(paths, ref);
    const maxBytes = this.memoryDocumentMaxBytes(ref);
    let content = await readTextIfExists(filePath, maxBytes);
    let resultPath = filePath;
    if (content === undefined) {
      const legacyPath = legacyMemoryDocumentPath(paths, ref);
      if (legacyPath !== undefined && legacyPath !== filePath) {
        content = await readTextIfExists(legacyPath, maxBytes);
        if (content !== undefined) {
          resultPath = legacyPath;
        }
      }
    }
    return {
      ...ref,
      path: relativeStorePath(this.rootDir, resultPath),
      ...(content === undefined ? {} : { content }),
    };
  }

  async writeMemoryDocument(
    key: ChannelSessionKey,
    request: MemoryWriteRequest,
  ): Promise<MemoryMutationResult> {
    assertMemoryReason(request.reason);
    const paths = await this.ensureChannelDirectory(key);
    const filePath = writableMemoryDocumentPath(paths, request);
    const maxBytes = this.memoryDocumentMaxBytes(request);
    assertTextSize(request.content, maxBytes, "Memory content");
    const before = await readTextIfExists(filePath, maxBytes);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, request.content, "utf8");
    const result = memoryMutationResult(
      this.rootDir,
      request,
      filePath,
      before,
      request.content,
    );
    await this.appendMemoryAudit(paths, {
      action: "write",
      request,
      result,
      before,
      after: request.content,
    });
    await this.updateMemoryReferenceIndexesBestEffort(key, paths, request);
    return result;
  }

  async deleteMemoryDocument(
    key: ChannelSessionKey,
    request: MemoryMutationRequest,
  ): Promise<MemoryMutationResult> {
    assertMemoryReason(request.reason);
    const paths = await this.ensureChannelDirectory(key);
    const filePath = writableMemoryDocumentPath(paths, request);
    const maxBytes = this.memoryDocumentMaxBytes(request);
    const before = await readTextIfExists(filePath, maxBytes);
    if (before !== undefined) {
      await unlink(filePath);
    }
    const result = memoryMutationResult(
      this.rootDir,
      request,
      filePath,
      before,
      undefined,
    );
    await this.appendMemoryAudit(paths, {
      action: "delete",
      request,
      result,
      before,
      after: undefined,
    });
    await this.removeMemoryReferenceIndexesBestEffort(key, paths, request);
    return result;
  }

  async deleteChannelDirectory(key: ChannelSessionKey): Promise<void> {
    const paths = this.getPaths(key);
    await rm(paths.channelDir, { recursive: true, force: true });
  }

  recordWarning(warning: WorkspaceStoreWarning): void {
    this.onWarning?.(warning);
  }

  private memoryDocumentMaxBytes(ref: MemoryDocumentRef): number {
    if (ref.document === "index" || ref.document === "summary") {
      return this.maxMemoryIndexFileBytes;
    }
    if (ref.document === "audit") {
      return this.maxMemoryAuditFileBytes;
    }
    return this.maxMemoryFileBytes;
  }

  private async appendMemoryAudit(
    paths: ChannelWorkspacePaths,
    input: {
      readonly action: "write" | "delete";
      readonly request: MemoryMutationRequest;
      readonly result: MemoryMutationResult;
      readonly before: string | undefined;
      readonly after: string | undefined;
    },
  ): Promise<void> {
    const auditFile = paths.globalMemoryAuditFile;
    await mkdir(path.dirname(auditFile), { recursive: true });
    await appendJsonl(
      auditFile,
      {
        type: "memory_mutation",
        schemaVersion: 1,
        action: input.action,
        scope: input.request.scope,
        document: input.request.document,
        ...(input.request.topic === undefined ? {} : { topic: input.request.topic }),
        path: input.result.path,
        source: memoryMutationSourceToJson(input.request.source),
        reason: input.request.reason,
        changed: input.result.changed,
        ...(input.before === undefined
          ? {}
          : {
              beforeBytes: Buffer.byteLength(input.before, "utf8"),
              beforeSha256: sha256(input.before),
            }),
        ...(input.after === undefined
          ? {}
          : {
              afterBytes: Buffer.byteLength(input.after, "utf8"),
              afterSha256: sha256(input.after),
            }),
        createdAt: new Date().toISOString(),
      },
      this.maxMemoryAuditFileBytes,
    );
  }

  private async updateMemoryReferenceIndexesBestEffort(
    key: ChannelSessionKey,
    paths: ChannelWorkspacePaths,
    request: MemoryWriteRequest,
  ): Promise<void> {
    if (
      request.document !== "rollout_summary" &&
      request.document !== "extension_note"
    ) {
      return;
    }
    try {
      if (request.document === "rollout_summary") {
        await this.upsertMemoryIndexBullet(key, paths, {
          scope: request.scope,
          topic: request.topic,
          section: "Recent Rollout Summaries",
          marker: "recent-rollout-summaries",
          bullet: memoryReferenceBullet({
            topic: request.topic,
            title: extractMemoryTitle(request.content, "Run summary"),
            href: `rollout_summaries/${request.topic}.md`,
            detail: extractMemoryExcerpt(request.content),
          }),
          reason: "Automatically index rollout_summary memory document",
          source: request.source,
        });
      } else {
        await this.upsertMemoryIndexBullet(key, paths, {
          scope: request.scope,
          topic: request.topic,
          section: "Pending Extension Notes",
          marker: "pending-extension-notes",
          bullet: memoryReferenceBullet({
            topic: request.topic,
            title: extractMemoryTitle(request.content, "Extension note"),
            href: `extensions/ad_hoc/notes/${request.topic}.md`,
            detail: extractMemoryExcerpt(request.content),
          }),
          reason: "Automatically index extension_note memory candidate",
          source: request.source,
        });
        await this.upsertMemorySummaryBullet(key, paths, {
          scope: request.scope,
          topic: request.topic,
          section: "Pending Extension Notes",
          marker: "pending-extension-notes",
          bullet: memorySummaryBullet({
            topic: request.topic,
            title: extractMemoryTitle(request.content, "Extension note"),
          }),
          reason: "Automatically surface extension_note memory candidate",
          source: request.source,
        });
      }
    } catch (error: unknown) {
      this.recordWarning({
        code: "memory_curation_failed",
        filePath: memoryDocumentPath(paths, request),
        message: `Failed to update memory references: ${errorMessage(error)}`,
      });
    }
  }

  private async removeMemoryReferenceIndexesBestEffort(
    key: ChannelSessionKey,
    paths: ChannelWorkspacePaths,
    request: MemoryMutationRequest,
  ): Promise<void> {
    if (
      request.document !== "rollout_summary" &&
      request.document !== "extension_note"
    ) {
      return;
    }
    try {
      if (request.document === "rollout_summary") {
        await this.removeMemoryIndexBullet(key, paths, {
          scope: request.scope,
          topic: request.topic,
          section: "Recent Rollout Summaries",
          marker: "recent-rollout-summaries",
          reason: "Remove deleted rollout_summary from memory index",
          source: request.source,
        });
      } else {
        await this.removeMemoryIndexBullet(key, paths, {
          scope: request.scope,
          topic: request.topic,
          section: "Pending Extension Notes",
          marker: "pending-extension-notes",
          reason: "Remove deleted extension_note from memory index",
          source: request.source,
        });
        await this.removeMemorySummaryBullet(key, paths, {
          scope: request.scope,
          topic: request.topic,
          section: "Pending Extension Notes",
          marker: "pending-extension-notes",
          reason: "Remove deleted extension_note from memory summary",
          source: request.source,
        });
      }
    } catch (error: unknown) {
      this.recordWarning({
        code: "memory_curation_failed",
        filePath: memoryDocumentPath(paths, request),
        message: `Failed to remove memory references: ${errorMessage(error)}`,
      });
    }
  }

  private async upsertMemoryIndexBullet(
    key: ChannelSessionKey,
    paths: ChannelWorkspacePaths,
    input: MemoryReferenceUpdate,
  ): Promise<void> {
    const ref = { scope: input.scope, document: "index" as const };
    const current = await readTextWithLegacyFallback(
      memoryDocumentPath(paths, ref),
      legacyMemoryDocumentPath(paths, ref),
      this.maxMemoryIndexFileBytes,
    );
    const content = upsertManagedBullet(current, input);
    await this.writeMemoryDocument(key, {
      ...ref,
      content,
      reason: input.reason,
      source: input.source,
    });
  }

  private async upsertMemorySummaryBullet(
    key: ChannelSessionKey,
    paths: ChannelWorkspacePaths,
    input: MemoryReferenceUpdate,
  ): Promise<void> {
    const ref = { scope: input.scope, document: "summary" as const };
    const current = await readTextIfExists(
      memoryDocumentPath(paths, ref),
      this.maxMemoryIndexFileBytes,
    );
    const content = upsertManagedBullet(current, input);
    await this.writeMemoryDocument(key, {
      ...ref,
      content,
      reason: input.reason,
      source: input.source,
    });
  }

  private async removeMemoryIndexBullet(
    key: ChannelSessionKey,
    paths: ChannelWorkspacePaths,
    input: MemoryReferenceRemove,
  ): Promise<void> {
    const ref = { scope: input.scope, document: "index" as const };
    const current = await readTextWithLegacyFallback(
      memoryDocumentPath(paths, ref),
      legacyMemoryDocumentPath(paths, ref),
      this.maxMemoryIndexFileBytes,
    );
    const content = removeManagedBullet(current, input);
    await this.writeMemoryDocument(key, {
      ...ref,
      content,
      reason: input.reason,
      source: input.source,
    });
  }

  private async removeMemorySummaryBullet(
    key: ChannelSessionKey,
    paths: ChannelWorkspacePaths,
    input: MemoryReferenceRemove,
  ): Promise<void> {
    const ref = { scope: input.scope, document: "summary" as const };
    const current = await readTextIfExists(
      memoryDocumentPath(paths, ref),
      this.maxMemoryIndexFileBytes,
    );
    const content = removeManagedBullet(current, input);
    await this.writeMemoryDocument(key, {
      ...ref,
      content,
      reason: input.reason,
      source: input.source,
    });
  }

  private async readJsonlEntries(
    filePath: string,
  ): Promise<readonly JsonlEntry[]> {
    const maxBytes =
      filePath.endsWith("log.jsonl")
        ? this.maxLogFileBytes
        : this.maxContextFileBytes;
    const content = await readTextIfExists(filePath, maxBytes);
    if (content === undefined) {
      return [];
    }

    const entries: JsonlEntry[] = [];
    const lines = content.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const rawLine = lines[index] ?? "";
      if (rawLine.trim().length === 0) {
        continue;
      }

      const lineNumber = index + 1;
      const parsed = parseJsonLine(rawLine);
      if (parsed === null) {
        this.recordWarning({
          code: "jsonl_parse_error",
          filePath,
          lineNumber,
          rawLine,
          message: "Skipping invalid JSONL line",
        });
        continue;
      }

      if (!isJsonObject(parsed)) {
        this.recordWarning({
          code: "jsonl_non_object",
          filePath,
          lineNumber,
          rawLine,
          message: "Skipping JSONL line that is not a JSON object",
        });
        continue;
      }

      entries.push({
        filePath,
        lineNumber,
        record: parsed,
      });
    }

    return entries;
  }
}

async function appendJsonl(
  filePath: string,
  record: JsonObject,
  maxBytes: number,
): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  const currentBytes = await fileSizeIfExists(filePath);
  if (currentBytes + Buffer.byteLength(line, "utf8") > maxBytes) {
    throw new Error(`Workspace store file exceeds maximum size of ${maxBytes} bytes: ${filePath}`);
  }

  await appendFile(filePath, line, "utf8");
}

function memoryDocumentPath(
  paths: ChannelWorkspacePaths,
  ref: MemoryDocumentRef,
): string {
  switch (ref.document) {
    case "instructions":
      return paths.globalInstructionsFile;
    case "summary":
      return paths.globalMemorySummaryFile;
    case "index":
      return paths.globalMemoryFile;
    case "audit":
      return paths.globalMemoryAuditFile;
    case "topic": {
      const topic = assertMemoryTopic(ref.topic);
      return path.join(paths.globalMemoryDir, `${topic}.md`);
    }
    case "rollout_summary": {
      const topic = assertMemoryTopic(ref.topic);
      return path.join(paths.globalMemoryRolloutSummariesDir, `${topic}.md`);
    }
    case "extension_note": {
      const topic = assertMemoryTopic(ref.topic);
      return path.join(paths.globalMemoryExtensionNotesDir, `${topic}.md`);
    }
  }
}

function legacyMemoryDocumentPath(
  paths: ChannelWorkspacePaths,
  ref: MemoryDocumentRef,
): string | undefined {
  switch (ref.document) {
    case "instructions":
    case "summary":
    case "rollout_summary":
    case "extension_note":
      return undefined;
    case "index":
      return paths.legacyGlobalMemoryFile;
    case "audit":
      return paths.legacyGlobalMemoryAuditFile;
    case "topic": {
      const topic = assertMemoryTopic(ref.topic);
      return path.join(paths.legacyGlobalMemoryDir, `${topic}.md`);
    }
  }
}

function writableMemoryDocumentPath(
  paths: ChannelWorkspacePaths,
  ref: WritableMemoryDocumentRef,
): string {
  return memoryDocumentPath(paths, ref);
}

function memoryMutationResult(
  rootDir: string,
  ref: WritableMemoryDocumentRef,
  filePath: string,
  before: string | undefined,
  after: string | undefined,
): MemoryMutationResult {
  return {
    scope: ref.scope,
    document: ref.document,
    ...(ref.topic === undefined ? {} : { topic: ref.topic }),
    path: relativeStorePath(rootDir, filePath),
    changed: before !== after,
    ...(before === undefined
      ? {}
      : { beforeBytes: Buffer.byteLength(before, "utf8") }),
    ...(after === undefined
      ? {}
      : { afterBytes: Buffer.byteLength(after, "utf8") }),
  };
}

function memoryMutationSourceToJson(source: MemoryMutationSource): JsonObject {
  return {
    type: source.type,
    ...(source.runId === undefined ? {} : { runId: source.runId }),
    ...(source.userId === undefined ? {} : { userId: source.userId }),
  };
}

function upsertManagedBullet(
  content: string | undefined,
  input: MemoryReferenceUpdate,
): string {
  const topic = assertMemoryTopic(input.topic);
  const start = managedStartMarker(input.marker);
  const end = managedEndMarker(input.marker);
  const base = normalizeMemoryIndexContent(content);
  const existing = managedSectionLines(base, start, end)
    .filter((line) => !isManagedBulletForTopic(line, topic));
  const lines = [...existing, input.bullet]
    .filter((line) => line.trim().length > 0)
    .slice(-40);
  return replaceManagedSection(base, input.section, start, end, lines);
}

function removeManagedBullet(
  content: string | undefined,
  input: MemoryReferenceRemove,
): string {
  const topic = assertMemoryTopic(input.topic);
  const start = managedStartMarker(input.marker);
  const end = managedEndMarker(input.marker);
  const base = normalizeMemoryIndexContent(content);
  const lines = managedSectionLines(base, start, end)
    .filter((line) => !isManagedBulletForTopic(line, topic));
  return replaceManagedSection(base, input.section, start, end, lines);
}

function normalizeMemoryIndexContent(content: string | undefined): string {
  const trimmed = content?.trim();
  return trimmed === undefined || trimmed.length === 0 ? "# Memory\n" : trimmed;
}

function managedSectionLines(
  content: string,
  start: string,
  end: string,
): readonly string[] {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    return [];
  }
  return content
    .slice(startIndex + start.length, endIndex)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));
}

function replaceManagedSection(
  content: string,
  section: string,
  start: string,
  end: string,
  lines: readonly string[],
): string {
  const sectionText = [
    `## ${section}`,
    "",
    start,
    ...lines,
    end,
  ].join("\n");
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex >= 0 && endIndex > startIndex) {
    const headingIndex = content.lastIndexOf(`## ${section}`, startIndex);
    const replaceStart = headingIndex >= 0 ? headingIndex : startIndex;
    const replaceEnd = endIndex + end.length;
    return `${content.slice(0, replaceStart).trimEnd()}\n\n${sectionText}\n${content.slice(replaceEnd).trimStart()}`.trimEnd() + "\n";
  }
  return `${content.trimEnd()}\n\n${sectionText}\n`;
}

function managedStartMarker(marker: string): string {
  return `<!-- pibot:${marker}:start -->`;
}

function managedEndMarker(marker: string): string {
  return `<!-- pibot:${marker}:end -->`;
}

function isManagedBulletForTopic(line: string, topic: string): boolean {
  return line.startsWith(`- \`${topic}\``);
}

function memoryReferenceBullet(input: {
  readonly topic: string | undefined;
  readonly title: string;
  readonly href: string;
  readonly detail: string;
}): string {
  const topic = assertMemoryTopic(input.topic);
  const detail = input.detail.length === 0 ? "" : ` - ${input.detail}`;
  return `- \`${topic}\`: [${escapeMarkdownInline(input.title)}](${input.href})${detail}`;
}

function memorySummaryBullet(input: {
  readonly topic: string | undefined;
  readonly title: string;
}): string {
  const topic = assertMemoryTopic(input.topic);
  return `- \`${topic}\`: ${escapeMarkdownInline(input.title)}`;
}

function extractMemoryTitle(content: string, fallback: string): string {
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine
      .trim()
      .replace(/^#+\s*/u, "")
      .replace(/^[-*]\s*/u, "")
      .trim();
    if (line.length > 0 && !line.startsWith("```")) {
      return truncateInline(line, 120);
    }
  }
  return fallback;
}

function extractMemoryExcerpt(content: string): string {
  const lines = content
    .split(/\r?\n/u)
    .map((line) =>
      line
        .trim()
        .replace(/^#+\s*/u, "")
        .replace(/^[-*]\s*/u, "")
        .trim(),
    )
    .filter((line) => line.length > 0 && !line.startsWith("```"));
  if (lines.length <= 1) {
    return "";
  }
  return truncateInline(lines.slice(1).join(" "), 180);
}

function truncateInline(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/gu, " ").trim();
  if (oneLine.length <= maxChars) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function escapeMarkdownInline(text: string): string {
  return text.replace(/[\[\]\\]/gu, "\\$&").replace(/\|/gu, "\\|");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertMemoryTopic(topic: string | undefined): string {
  if (topic === undefined || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(topic)) {
    throw storeError(
      "invalid_input",
      "Memory topic must match /^[a-z0-9][a-z0-9_-]{0,63}$/",
    );
  }
  return topic;
}

function assertMemoryReason(reason: string): void {
  if (reason.trim().length === 0) {
    throw storeError("invalid_input", "Memory mutation reason must not be empty");
  }
}

function assertTextSize(content: string, maxBytes: number, label: string): void {
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    throw storeError(
      "invalid_input",
      `${label} exceeds maximum size of ${maxBytes} bytes`,
    );
  }
}

function relativeStorePath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readTextIfExists(
  filePath: string,
  maxBytes: number,
): Promise<string | undefined> {
  try {
    const fileStat = await stat(filePath);
    if (fileStat.size > maxBytes) {
      throw new Error(`Workspace store file exceeds maximum size of ${maxBytes} bytes: ${filePath}`);
    }

    return await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }

    throw error;
  }
}

async function readTextWithLegacyFallback(
  filePath: string,
  legacyFilePath: string | undefined,
  maxBytes: number,
): Promise<string | undefined> {
  const content = await readTextIfExists(filePath, maxBytes);
  if (content !== undefined) {
    return content;
  }
  if (legacyFilePath === undefined || legacyFilePath === filePath) {
    return undefined;
  }
  return readTextIfExists(legacyFilePath, maxBytes);
}

async function fileSizeIfExists(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return 0;
    }

    throw error;
  }
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${label} must be a positive integer`);
  }

  return resolved;
}

function parseJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function encodePathSegment(value: string): string {
  if (/^[A-Za-z0-9_-]+$/u.test(value)) {
    return value;
  }

  return Buffer.from(value, "utf8").toString("base64url");
}

function channelPathSegments(channelId: string): readonly string[] {
  const ticketId = evolutionTicketIdFromChannelId(channelId);
  if (ticketId !== undefined) {
    return ["self-evaluation", "tickets", ticketId];
  }
  return [encodePathSegment(channelId)];
}

function evolutionTicketIdFromChannelId(channelId: string): string | undefined {
  const prefix = "self-evaluation--";
  if (!channelId.startsWith(prefix)) {
    return undefined;
  }
  const ticketId = channelId.slice(prefix.length);
  return /^[A-Za-z0-9_-]+$/u.test(ticketId) ? ticketId : undefined;
}

function resolveInside(rootDir: string, ...segments: readonly string[]): string {
  const candidate = path.resolve(rootDir, ...segments);
  const relative = path.relative(rootDir, candidate);
  if (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  ) {
    return candidate;
  }

  throw new Error(`Workspace store path escapes root: ${candidate}`);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function storeError(code: string, message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}
