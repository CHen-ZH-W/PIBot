import { randomUUID } from "node:crypto";
import * as path from "node:path";
import {
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import type {
  ToolApprovalDecision,
  ToolApprovalPromptRequest,
} from "../core/tools";
import type { ToolApprovalPrompter } from "../ports/tools";

interface ChildApprovalRequestFile {
  readonly id: string;
  readonly createdAt: string;
  readonly request: ToolApprovalPromptRequest;
}

interface ChildApprovalDecisionFile {
  readonly id: string;
  readonly decidedAt: string;
  readonly decision: ToolApprovalDecision;
}

export interface FileChildAgentApprovalPrompterOptions {
  readonly runDir: string;
  readonly pollIntervalMs?: number;
}

export class FileChildAgentApprovalPrompter implements ToolApprovalPrompter {
  private readonly pollIntervalMs: number;

  constructor(private readonly options: FileChildAgentApprovalPrompterOptions) {
    this.pollIntervalMs = positiveInteger(
      options.pollIntervalMs,
      500,
      "pollIntervalMs",
    );
  }

  async requestToolApproval(
    request: ToolApprovalPromptRequest,
    signal?: AbortSignal,
  ): Promise<ToolApprovalDecision> {
    if (isAborted(signal)) {
      return deniedDecision("Tool approval was cancelled before it was requested");
    }

    const id = randomUUID();
    const requestFile = this.requestFile(id);
    const decisionFile = this.decisionFile(id);
    await mkdir(path.dirname(requestFile), { recursive: true });
    await writeJson(requestFile, {
      id,
      createdAt: new Date().toISOString(),
      request,
    } satisfies ChildApprovalRequestFile);

    const deadline = Date.now() + request.timeoutMs;
    while (Date.now() < deadline) {
      if (isAborted(signal)) {
        return deniedDecision("Tool approval was cancelled");
      }
      const decision = await readDecisionIfExists(decisionFile);
      if (decision !== undefined) {
        return decision;
      }
      await sleep(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())));
    }

    return deniedDecision("Tool approval timed out");
  }

  private requestFile(id: string): string {
    return path.join(this.options.runDir, "approvals", `${id}.request.json`);
  }

  private decisionFile(id: string): string {
    return path.join(this.options.runDir, "approvals", `${id}.decision.json`);
  }
}

export interface FileChildAgentApprovalResponderOptions {
  readonly rootDir: string;
  readonly prompter: ToolApprovalPrompter;
  readonly pollIntervalMs?: number;
  readonly shouldHandleRequest?: (request: ToolApprovalPromptRequest) => boolean;
  readonly onError?: (error: unknown) => void;
}

export class FileChildAgentApprovalResponder {
  private readonly pollIntervalMs: number;
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: FileChildAgentApprovalResponderOptions) {
    this.pollIntervalMs = positiveInteger(
      options.pollIntervalMs,
      1000,
      "pollIntervalMs",
    );
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      void this.poll().catch((error: unknown) => {
        this.options.onError?.(error);
      });
    }, this.pollIntervalMs);
    void this.poll().catch((error: unknown) => {
      this.options.onError?.(error);
    });
  }

  stop(): void {
    if (this.timer === undefined) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async poll(): Promise<void> {
    const requestFiles = await findApprovalRequestFiles(this.options.rootDir);
    await Promise.all(requestFiles.map((filePath) => this.handleRequest(filePath)));
  }

  private async handleRequest(filePath: string): Promise<void> {
    if (this.inFlight.has(filePath)) {
      return;
    }
    this.inFlight.add(filePath);
    try {
      const decisionFile = decisionFileForRequestFile(filePath);
      if (await fileExists(decisionFile)) {
        return;
      }

      const request = await readApprovalRequest(filePath).catch(() => undefined);
      if (request === undefined) {
        return;
      }
      if (this.options.shouldHandleRequest?.(request.request) === false) {
        return;
      }

      const decision = await this.options.prompter.requestToolApproval(
        request.request,
      );
      await writeJson(decisionFile, {
        id: request.id,
        decidedAt: new Date().toISOString(),
        decision,
      } satisfies ChildApprovalDecisionFile);
    } finally {
      this.inFlight.delete(filePath);
    }
  }
}

async function findApprovalRequestFiles(rootDir: string): Promise<readonly string[]> {
  const result: string[] = [];
  await visit(rootDir, result);
  return result;
}

async function visit(directory: string, result: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    },
  );
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(fullPath, result);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".request.json")) {
      result.push(fullPath);
    }
  }
}

async function readApprovalRequest(
  filePath: string,
): Promise<ChildApprovalRequestFile> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  if (!isRecord(parsed) || typeof parsed.id !== "string") {
    throw new Error("Invalid child approval request file");
  }
  return parsed as unknown as ChildApprovalRequestFile;
}

async function readDecisionIfExists(
  filePath: string,
): Promise<ToolApprovalDecision | undefined> {
  const exists = await fileExists(filePath);
  if (!exists) {
    return undefined;
  }
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.decision)) {
    return deniedDecision("Invalid child approval decision file");
  }
  const approved = parsed.decision.approved;
  const scope = parsed.decision.scope === "run" ? "run" as const : undefined;
  if (approved === true) {
    return { approved: true, ...(scope === undefined ? {} : { scope }) };
  }
  const reason = parsed.decision.reason;
  return {
    approved: false,
    reason: typeof reason === "string"
      ? reason
      : "Child approval was denied",
    ...(scope === undefined ? {} : { scope }),
  };
}

function decisionFileForRequestFile(filePath: string): string {
  return filePath.replace(/\.request\.json$/u, ".decision.json");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fileExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    () => true,
    (error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") {
        return false;
      }
      throw error;
    },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deniedDecision(reason: string): ToolApprovalDecision {
  return {
    approved: false,
    reason,
  };
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

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
