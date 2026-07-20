import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { LlmMessageContentPart } from "../core/agent";
import type { WorkspacePath } from "../core/ids";
import type { ChannelSessionKey } from "../core/session";
import type { SlackEvent, SlackFileRef } from "../core/slack";
import type { ChannelWorkspaceStore } from "../workspace/store";

export interface DownloadedSlackAttachment {
  readonly fileId: string;
  readonly name: string;
  readonly path: WorkspacePath;
  readonly absolutePath: string;
  readonly mimetype?: string;
}

export interface SlackAttachmentDownloadFailure {
  readonly fileId: string;
  readonly name: string;
  readonly message: string;
}

export interface SlackAttachmentDownloadResult {
  readonly downloaded: readonly DownloadedSlackAttachment[];
  readonly failures: readonly SlackAttachmentDownloadFailure[];
}

export interface SlackAttachmentDownloaderOptions {
  readonly botToken: string;
  readonly store: ChannelWorkspaceStore;
  readonly maxAttachmentBytes?: number;
  readonly downloadTimeoutMs?: number;
}

/**
 * 职责：把 Slack 文件下载到 channel workspace 的 attachments 目录。
 * 不应承担：解析 Slack 事件类型、决定 agent 是否处理消息、读取附件内容。
 */
export class SlackAttachmentDownloader {
  private readonly botToken: string;
  private readonly store: ChannelWorkspaceStore;
  private readonly maxAttachmentBytes: number;
  private readonly downloadTimeoutMs: number;

  constructor(options: SlackAttachmentDownloaderOptions) {
    this.botToken = options.botToken;
    this.store = options.store;
    this.maxAttachmentBytes = positiveInteger(
      options.maxAttachmentBytes,
      5_000_000,
      "maxAttachmentBytes",
    );
    this.downloadTimeoutMs = positiveInteger(
      options.downloadTimeoutMs,
      30000,
      "downloadTimeoutMs",
    );
  }

  async downloadForEvent(
    event: SlackEvent,
    key: ChannelSessionKey,
  ): Promise<SlackAttachmentDownloadResult> {
    if (event.files.length === 0) {
      return {
        downloaded: [],
        failures: [],
      };
    }

    const paths = await this.store.ensureChannelDirectory(key);
    await mkdir(paths.attachmentsDir, { recursive: true });

    const downloaded: DownloadedSlackAttachment[] = [];
    const failures: SlackAttachmentDownloadFailure[] = [];
    for (const file of event.files) {
      const result = await this.downloadOne(file, event, paths.attachmentsDir);
      if ("failure" in result) {
        failures.push(result.failure);
      } else {
        downloaded.push({
          ...result.attachment,
          path: toWorkspacePath(paths.channelDir, result.attachment.absolutePath),
        });
      }
    }

    return {
      downloaded,
      failures,
    };
  }

  private async downloadOne(
    file: SlackFileRef,
    event: SlackEvent,
    attachmentsDir: string,
  ): Promise<
    | {
        readonly attachment: Omit<DownloadedSlackAttachment, "path">;
      }
    | {
        readonly failure: SlackAttachmentDownloadFailure;
      }
  > {
    if (file.url === undefined) {
      return {
        failure: {
          fileId: file.id,
          name: file.name,
          message: "Slack file has no private download URL",
        },
      };
    }

    if (file.size !== undefined && file.size > this.maxAttachmentBytes) {
      return this.tooLargeFailure(file);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.downloadTimeoutMs);
    try {
      const response = await fetch(file.url, {
        headers: {
          authorization: `Bearer ${this.botToken}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          failure: {
            fileId: file.id,
            name: file.name,
            message: `Slack file download failed with HTTP ${response.status}`,
          },
        };
      }

      const contentLength = response.headers.get("content-length");
      if (
        contentLength !== null &&
        Number(contentLength) > this.maxAttachmentBytes
      ) {
        return this.tooLargeFailure(file);
      }

      const targetPath = path.join(
        attachmentsDir,
        `${safeFileSegment(event.messageTs)}-${safeFileSegment(file.id)}-${safeFileSegment(file.name)}`,
      );
      await writeFile(
        targetPath,
        await readLimitedBody(response, this.maxAttachmentBytes),
      );

      return {
        attachment: {
          fileId: file.id,
          name: file.name,
          absolutePath: targetPath,
          ...optionalString("mimetype", file.mimetype),
        },
      };
    } catch (error: unknown) {
      return {
        failure: {
          fileId: file.id,
          name: file.name,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private tooLargeFailure(file: SlackFileRef): {
    readonly failure: SlackAttachmentDownloadFailure;
  } {
    return {
      failure: {
        fileId: file.id,
        name: file.name,
        message: `Slack file exceeds maximum size of ${this.maxAttachmentBytes} bytes`,
      },
    };
  }
}

export function appendAttachmentPathsToText(
  text: string,
  result: SlackAttachmentDownloadResult,
): string {
  if (result.downloaded.length === 0 && result.failures.length === 0) {
    return text;
  }

  const lines = [text.trim(), "", "Slack attachments:"];
  for (const attachment of result.downloaded) {
    lines.push(`- ${attachment.path} (${attachment.name})`);
  }
  for (const failure of result.failures) {
    lines.push(`- ${failure.name}: download failed: ${failure.message}`);
  }

  return lines.join("\n");
}

export async function downloadedImageAttachmentsToContentParts(
  result: SlackAttachmentDownloadResult,
): Promise<readonly LlmMessageContentPart[]> {
  const parts: LlmMessageContentPart[] = [];
  for (const attachment of result.downloaded) {
    const mimeType = imageMimeType(attachment);
    if (mimeType === undefined) {
      continue;
    }

    const content = await readFile(attachment.absolutePath);
    parts.push({
      type: "image_url",
      imageUrl: {
        url: `data:${mimeType};base64,${content.toString("base64")}`,
        detail: "auto",
      },
    });
  }

  return parts;
}

function toWorkspacePath(channelDir: string, absolutePath: string): WorkspacePath {
  return path.relative(channelDir, absolutePath).split(path.sep).join("/") as WorkspacePath;
}

function safeFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "_").slice(0, 120) || "file";
}

function imageMimeType(
  attachment: DownloadedSlackAttachment,
): string | undefined {
  const mimetype = attachment.mimetype?.toLowerCase();
  if (mimetype?.startsWith("image/") === true) {
    return mimetype;
  }

  const extension = path.extname(attachment.name).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return undefined;
  }
}

function optionalString<Key extends string>(
  key: Key,
  value: string | undefined,
): { readonly [Property in Key]: string } | object {
  if (value === undefined) {
    return {};
  }

  return { [key]: value } as { readonly [Property in Key]: string };
}

async function readLimitedBody(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (response.body === null) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > maxBytes) {
      throw new Error(`Slack file exceeds maximum size of ${maxBytes} bytes`);
    }

    return body;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return Buffer.concat(chunks, totalBytes);
      }

      const chunk = Buffer.from(result.value);
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error(`Slack file exceeds maximum size of ${maxBytes} bytes`);
      }

      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
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
