import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import * as path from "node:path";
import type { ToolApprovalContext } from "../core/tools";

export type PersistentToolApprovalScope = "session" | "repo";
export type ToolApprovalRuleEffect = "allow" | "deny";

export interface ToolApprovalRuleIdentity {
  readonly context: ToolApprovalContext;
  readonly workspaceRoot: string;
}

export interface ToolApprovalRuleMatchRequest {
  readonly ruleKey: string;
  readonly mode: string;
  readonly toolName: string;
  readonly identity: ToolApprovalRuleIdentity;
}

export interface ToolApprovalRuleRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly effect: ToolApprovalRuleEffect;
  readonly scope: PersistentToolApprovalScope;
  readonly mode: string;
  readonly toolName: string;
  readonly ruleKey: string;
  readonly actorId: string;
  readonly repoFingerprint: string;
  readonly sessionFingerprint?: string;
  readonly createdAt: string;
}

export interface PersistentToolApprovalRuleStore {
  find(
    request: ToolApprovalRuleMatchRequest,
  ): Promise<ToolApprovalRuleRecord | undefined>;
  remember(
    request: ToolApprovalRuleMatchRequest & {
      readonly effect: ToolApprovalRuleEffect;
      readonly scope: PersistentToolApprovalScope;
    },
  ): Promise<ToolApprovalRuleRecord>;
  list(): Promise<readonly ToolApprovalRuleRecord[]>;
  revoke(ruleId: string, revokedBy?: string): Promise<boolean>;
}

export interface FileToolApprovalRuleStoreOptions {
  readonly rootDir: string;
  readonly maxFileBytes?: number;
}

type ApprovalRuleEvent =
  | ({ readonly type: "rule.set" } & ToolApprovalRuleRecord)
  | {
      readonly schemaVersion: 1;
      readonly type: "rule.revoke";
      readonly id: string;
      readonly revokedAt: string;
      readonly revokedBy?: string;
    };

/** Append-only, exact-match approval rules shared by parent and child runtimes. */
export class FileToolApprovalRuleStore
  implements PersistentToolApprovalRuleStore
{
  private readonly filePath: string;
  private readonly maxFileBytes: number;
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(options: FileToolApprovalRuleStoreOptions) {
    this.filePath = path.join(path.resolve(options.rootDir), "approval-rules.jsonl");
    this.maxFileBytes = positiveInteger(
      options.maxFileBytes,
      2_000_000,
      "maxFileBytes",
    );
  }

  async find(
    request: ToolApprovalRuleMatchRequest,
  ): Promise<ToolApprovalRuleRecord | undefined> {
    const identity = await approvalRuleFingerprints(request.identity);
    const matching = (await this.list()).filter((rule) =>
      rule.ruleKey === request.ruleKey &&
      rule.mode === request.mode &&
      rule.toolName === request.toolName &&
      rule.actorId === identity.actorId &&
      rule.repoFingerprint === identity.repoFingerprint &&
      (rule.scope !== "session" ||
        rule.sessionFingerprint === identity.sessionFingerprint)
    );
    return matching.find((rule) => rule.scope === "session") ??
      matching.find((rule) => rule.scope === "repo");
  }

  async remember(
    request: ToolApprovalRuleMatchRequest & {
      readonly effect: ToolApprovalRuleEffect;
      readonly scope: PersistentToolApprovalScope;
    },
  ): Promise<ToolApprovalRuleRecord> {
    const identity = await approvalRuleFingerprints(request.identity);
    const rule: ToolApprovalRuleRecord = Object.freeze({
      schemaVersion: 1,
      id: randomUUID(),
      effect: request.effect,
      scope: request.scope,
      mode: request.mode,
      toolName: request.toolName,
      ruleKey: request.ruleKey,
      actorId: identity.actorId,
      repoFingerprint: identity.repoFingerprint,
      ...(request.scope === "session"
        ? { sessionFingerprint: identity.sessionFingerprint }
        : {}),
      createdAt: new Date().toISOString(),
    });
    await this.append({ type: "rule.set", ...rule });
    return rule;
  }

  async list(): Promise<readonly ToolApprovalRuleRecord[]> {
    await this.appendQueue;
    const content = await readFile(this.filePath, "utf8").catch(
      (error: unknown) => {
        if (isNodeError(error) && error.code === "ENOENT") {
          return "";
        }
        throw error;
      },
    );
    if (Buffer.byteLength(content, "utf8") > this.maxFileBytes) {
      throw new Error(
        `Approval rule file exceeds maximum size of ${this.maxFileBytes} bytes`,
      );
    }
    const activeBySelector = new Map<string, ToolApprovalRuleRecord>();
    const revokedIds = new Set<string>();
    for (const [index, line] of content.split("\n").entries()) {
      if (line.trim().length === 0) {
        continue;
      }
      const event = parseApprovalRuleEvent(line, index + 1);
      if (event.type === "rule.revoke") {
        revokedIds.add(event.id);
        for (const [selector, rule] of activeBySelector.entries()) {
          if (rule.id === event.id) {
            activeBySelector.delete(selector);
          }
        }
        continue;
      }
      if (revokedIds.has(event.id)) {
        continue;
      }
      activeBySelector.set(ruleSelector(event), freezeRule(event));
    }
    return Object.freeze([...activeBySelector.values()]);
  }

  async revoke(ruleId: string, revokedBy?: string): Promise<boolean> {
    const normalizedId = ruleId.trim();
    if (normalizedId.length === 0) {
      throw new Error("Approval rule id must not be empty");
    }
    const exists = (await this.list()).some((rule) => rule.id === normalizedId);
    if (!exists) {
      return false;
    }
    await this.append({
      schemaVersion: 1,
      type: "rule.revoke",
      id: normalizedId,
      revokedAt: new Date().toISOString(),
      ...(revokedBy === undefined ? {} : { revokedBy }),
    });
    return true;
  }

  private append(event: ApprovalRuleEvent): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    const operation = this.appendQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const bytes = await fileSizeIfExists(this.filePath);
      if (bytes + Buffer.byteLength(line, "utf8") > this.maxFileBytes) {
        throw new Error(
          `Approval rule file exceeds maximum size of ${this.maxFileBytes} bytes`,
        );
      }
      await appendFile(this.filePath, line, "utf8");
    });
    this.appendQueue = operation.catch(() => undefined);
    return operation;
  }
}

async function approvalRuleFingerprints(
  identity: ToolApprovalRuleIdentity,
): Promise<{
  readonly actorId: string;
  readonly repoFingerprint: string;
  readonly sessionFingerprint: string;
}> {
  const canonicalWorkspace = await realpath(path.resolve(identity.workspaceRoot));
  const actorId = String(identity.context.requestedByUserId);
  const repoFingerprint = digest(["repo-v1", canonicalWorkspace]);
  const conversation = identity.context.conversation;
  const sessionFingerprint = digest([
    "session-v1",
    String(conversation.teamId),
    String(conversation.channelId),
    conversation.threadTs === undefined ? "" : String(conversation.threadTs),
    actorId,
    repoFingerprint,
  ]);
  return { actorId, repoFingerprint, sessionFingerprint };
}

function ruleSelector(rule: ToolApprovalRuleRecord): string {
  return [
    rule.scope,
    rule.mode,
    rule.toolName,
    rule.ruleKey,
    rule.actorId,
    rule.repoFingerprint,
    rule.sessionFingerprint ?? "",
  ].join("\u0000");
}

function freezeRule(rule: ToolApprovalRuleRecord): ToolApprovalRuleRecord {
  return Object.freeze({
    schemaVersion: 1,
    id: rule.id,
    effect: rule.effect,
    scope: rule.scope,
    mode: rule.mode,
    toolName: rule.toolName,
    ruleKey: rule.ruleKey,
    actorId: rule.actorId,
    repoFingerprint: rule.repoFingerprint,
    ...(rule.sessionFingerprint === undefined
      ? {}
      : { sessionFingerprint: rule.sessionFingerprint }),
    createdAt: rule.createdAt,
  });
}

function parseApprovalRuleEvent(line: string, lineNumber: number): ApprovalRuleEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new Error(`Invalid approval rule JSON at line ${lineNumber}`);
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new Error(`Invalid approval rule event at line ${lineNumber}`);
  }
  if (
    parsed.type === "rule.revoke" &&
    typeof parsed.id === "string" &&
    typeof parsed.revokedAt === "string"
  ) {
    return parsed as unknown as ApprovalRuleEvent;
  }
  if (
    parsed.type === "rule.set" &&
    typeof parsed.id === "string" &&
    (parsed.effect === "allow" || parsed.effect === "deny") &&
    (parsed.scope === "session" || parsed.scope === "repo") &&
    typeof parsed.mode === "string" &&
    typeof parsed.toolName === "string" &&
    typeof parsed.ruleKey === "string" &&
    typeof parsed.actorId === "string" &&
    typeof parsed.repoFingerprint === "string" &&
    typeof parsed.createdAt === "string" &&
    (parsed.scope !== "session" || typeof parsed.sessionFingerprint === "string")
  ) {
    return parsed as unknown as ApprovalRuleEvent;
  }
  throw new Error(`Invalid approval rule event at line ${lineNumber}`);
}

async function fileSizeIfExists(filePath: string): Promise<number> {
  return stat(filePath).then(
    (value) => value.size,
    (error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") {
        return 0;
      }
      throw error;
    },
  );
}

function digest(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
