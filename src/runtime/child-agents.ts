import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AgentRunId } from "../core/ids";
import type { ChannelSessionKey } from "../core/session";
import type { ToolApprovalContext } from "../core/tools";
import type {
  ChildAgentBudget,
  ChildAgentRole,
  ChildAgentRunRecord,
  ChildAgentRunStore,
} from "../workspace/child-agents";
import {
  defaultChildAgentBudget,
  isTerminalChildStatus,
} from "../workspace/child-agents";
import type { ChildAgentSupervisor } from "./tmux-agents";

export interface ChildAgentRuntimeOptions {
  readonly key: ChannelSessionKey;
  readonly parentRunId: AgentRunId;
  readonly workspaceRoot: string;
  readonly store: ChildAgentRunStore;
  readonly supervisor: ChildAgentSupervisor;
  readonly approvalContext?: ToolApprovalContext;
  readonly maxConcurrent?: number;
  readonly defaultTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly defaultMaxToolCalls?: number;
  readonly defaultMaxTokens?: number;
  readonly autoWorktreeRoot?: string;
}

export interface SpawnChildAgentRequest {
  readonly role: ChildAgentRole;
  readonly task: string;
  readonly readOnly?: boolean;
  readonly timeoutMs?: number;
  readonly maxToolCalls?: number;
  readonly maxTokens?: number;
  readonly worktreePath?: string;
}

export interface CaptureChildAgentRequest {
  readonly childRunId: AgentRunId;
  readonly lines?: number;
  readonly maxChars?: number;
}

export interface SendChildAgentRequest {
  readonly childRunId: AgentRunId;
  readonly text: string;
  readonly enter?: boolean;
}

export interface StopChildAgentRequest {
  readonly childRunId: AgentRunId;
  readonly reason?: string;
}

export class ChildAgentRuntime {
  private readonly maxConcurrent: number;
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly defaultMaxToolCalls: number;
  private readonly defaultMaxTokens: number;

  constructor(private readonly options: ChildAgentRuntimeOptions) {
    this.maxConcurrent = positiveInteger(
      options.maxConcurrent,
      20,
      "maxConcurrent",
    );
    this.defaultTimeoutMs = positiveInteger(
      options.defaultTimeoutMs,
      900000,
      "defaultTimeoutMs",
    );
    this.maxTimeoutMs = positiveInteger(
      options.maxTimeoutMs,
      1800000,
      "maxTimeoutMs",
    );
    this.defaultMaxToolCalls = positiveInteger(
      options.defaultMaxToolCalls,
      40,
      "defaultMaxToolCalls",
    );
    this.defaultMaxTokens = positiveInteger(
      options.defaultMaxTokens,
      120000,
      "defaultMaxTokens",
    );
  }

  async spawnAgent(
    request: SpawnChildAgentRequest,
  ): Promise<ChildAgentRunRecord> {
    const task = request.task.trim();
    if (task.length === 0) {
      throw runtimeError("invalid_input", "agent_spawn.task must not be empty");
    }
    const readOnly = request.readOnly ?? false;
    this.assertWriteRules(request, readOnly);
    await this.assertConcurrency(readOnly, request.worktreePath);
    const autoWorktree = readOnly || request.worktreePath !== undefined
      ? undefined
      : await this.createAutoWorktree();
    const worktreePath = request.worktreePath ?? autoWorktree?.path;

    const budget = this.budgetFor(request);
    let record: ChildAgentRunRecord | undefined;
    try {
      record = await this.options.store.createRun({
        key: this.options.key,
        parentRunId: this.options.parentRunId,
        role: request.role,
        task,
        workspaceRoot: this.options.workspaceRoot,
        ...optionalString("worktreePath", worktreePath),
        readOnly,
        budget,
        ...(this.options.approvalContext === undefined
          ? {}
          : { approvalContext: this.options.approvalContext }),
      });
      const tmux = await this.options.supervisor.spawn(record);
      return this.options.store.updateRun(
        this.options.key,
        record.childRunId,
        {
          tmux,
          status: "starting",
        },
      );
    } catch (error: unknown) {
      if (record === undefined) {
        await cleanupAutoWorktree(this.options.workspaceRoot, autoWorktree);
      } else {
        await this.options.store.updateRun(this.options.key, record.childRunId, {
          status: "failed",
          endedAt: new Date().toISOString(),
          stopReason: error instanceof Error ? error.message : String(error),
        });
        await cleanupAutoWorktree(this.options.workspaceRoot, autoWorktree);
      }
      throw error;
    }
  }

  async listAgents(
    options: {
      readonly includeCompleted?: boolean;
    } = {},
  ): Promise<readonly ChildAgentRunRecord[]> {
    const runs = await this.options.store.listRuns(this.options.key, {
      parentRunId: this.options.parentRunId,
      includeCompleted: true,
    });
    if (options.includeCompleted === true) {
      return runs;
    }
    return runs.filter((run) => run.status !== "completed");
  }

  async captureAgent(request: CaptureChildAgentRequest): Promise<{
    readonly childRunId: AgentRunId;
    readonly status: string;
    readonly target?: string;
    readonly output: string;
  }> {
    const record = await this.readRun(request.childRunId);
    if (record.tmux === undefined) {
      throw runtimeError("conflict", "Child agent has no tmux target");
    }
    const output = await this.options.supervisor.capture(record.tmux, {
      ...optionalNumber("lines", request.lines),
      ...optionalNumber("maxChars", request.maxChars),
    });
    return {
      childRunId: record.childRunId,
      status: record.status,
      target: record.tmux.target,
      output,
    };
  }

  async sendAgent(request: SendChildAgentRequest): Promise<{
    readonly childRunId: AgentRunId;
    readonly sent: boolean;
  }> {
    const record = await this.readRun(request.childRunId);
    if (record.tmux === undefined) {
      throw runtimeError("conflict", "Child agent has no tmux target");
    }
    if (isTerminalChildStatus(record.status)) {
      throw runtimeError("conflict", `Child agent is already ${record.status}`);
    }
    await this.options.supervisor.send(record.tmux, request.text, {
      ...optionalBoolean("enter", request.enter),
    });
    await this.options.store.appendTranscript(this.options.key, record.childRunId, {
      type: "child_agent.input_sent",
      childRunId: record.childRunId,
      textBytes: Buffer.byteLength(request.text, "utf8"),
    });
    return {
      childRunId: record.childRunId,
      sent: true,
    };
  }

  async stopAgent(request: StopChildAgentRequest): Promise<ChildAgentRunRecord> {
    const record = await this.readRun(request.childRunId);
    if (record.tmux !== undefined) {
      await this.options.supervisor.stop(record.tmux);
    }
    return this.options.store.updateRun(this.options.key, record.childRunId, {
      status: "stopped",
      endedAt: new Date().toISOString(),
      stopReason: request.reason ?? "stopped_by_parent_agent",
    });
  }

  async collectAgent(childRunId: AgentRunId): Promise<{
    readonly run: ChildAgentRunRecord;
    readonly alive: boolean;
    readonly result?: string;
    readonly usage: unknown;
    readonly captureTail?: string;
  }> {
    let run = await this.readRun(childRunId);
    let alive = run.tmux === undefined
      ? false
      : await this.options.supervisor.isAlive(run.tmux);
    if (!alive && run.tmux !== undefined && !isTerminalChildStatus(run.status)) {
      run = await this.options.store.updateRun(this.options.key, run.childRunId, {
        status: "failed",
        endedAt: new Date().toISOString(),
        stopReason: "tmux_pane_exited_before_status_update",
      });
      alive = false;
    }
    const result = await this.options.store.readResult(this.options.key, childRunId);
    const usage = await this.options.store.readUsage(this.options.key, childRunId);
    const captureTail =
      alive && run.tmux !== undefined
        ? await this.options.supervisor.capture(run.tmux, {
            lines: 80,
            maxChars: 12000,
          }).catch(() => undefined)
        : undefined;

    return {
      run,
      alive,
      ...(result === undefined ? {} : { result }),
      usage,
      ...(captureTail === undefined ? {} : { captureTail }),
    };
  }

  private async readRun(childRunId: AgentRunId): Promise<ChildAgentRunRecord> {
    const run = await this.options.store.readRun(this.options.key, childRunId);
    if (run.parentRunId !== this.options.parentRunId) {
      throw runtimeError(
        "permission_denied",
        "Child agent does not belong to this parent run",
      );
    }
    return run;
  }

  private budgetFor(request: SpawnChildAgentRequest): ChildAgentBudget {
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    if (timeoutMs > this.maxTimeoutMs) {
      throw runtimeError(
        "invalid_input",
        `agent_spawn.timeoutMs exceeds maximum ${this.maxTimeoutMs}`,
      );
    }
    return defaultChildAgentBudget({
      timeoutMs,
      maxToolCalls: request.maxToolCalls ?? this.defaultMaxToolCalls,
      maxTokens: request.maxTokens ?? this.defaultMaxTokens,
    });
  }

  private assertWriteRules(
    request: SpawnChildAgentRequest,
    readOnly: boolean,
  ): void {
    if (readOnly) {
      return;
    }
    if (
      request.worktreePath !== undefined &&
      path.resolve(request.worktreePath) === path.resolve(this.options.workspaceRoot)
    ) {
      throw runtimeError(
        "permission_denied",
        "Write-capable child agents must not use the parent workspaceRoot",
      );
    }
  }

  private async createAutoWorktree(): Promise<AutoWorktree> {
    const hasHead = await gitHeadExists(this.options.workspaceRoot);
    const root = this.options.autoWorktreeRoot ??
      (hasHead
        ? path.join(this.options.workspaceRoot, ".pibot", "child-worktrees")
        : path.join(
            tmpdir(),
            "pibot-child-worktrees",
            sanitizePathPart(path.basename(this.options.workspaceRoot)),
          ));
    await mkdir(root, { recursive: true });
    const worktreePath = path.join(
      root,
      `${sanitizePathPart(this.options.parentRunId)}-${randomUUID()}`,
    );
    try {
      if (hasHead) {
        await execFile("git", [
          "-C",
          this.options.workspaceRoot,
          "worktree",
          "add",
          "--detach",
          worktreePath,
          "HEAD",
        ]);
        await linkNodeModules(this.options.workspaceRoot, worktreePath);
        return {
          path: worktreePath,
          kind: "git-worktree",
        };
      }

      await copyWorkspaceSnapshot(this.options.workspaceRoot, worktreePath);
      await linkNodeModules(this.options.workspaceRoot, worktreePath);
      return {
        path: worktreePath,
        kind: "snapshot",
      };
    } catch (error: unknown) {
      if (hasHead) {
        await execFile("git", [
          "-C",
          this.options.workspaceRoot,
          "worktree",
          "remove",
          "--force",
          worktreePath,
        ]).catch(() => undefined);
      }
      await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async assertConcurrency(
    readOnly: boolean,
    worktreePath: string | undefined,
  ): Promise<void> {
    const active = await this.options.store.listRuns(this.options.key, {
      parentRunId: this.options.parentRunId,
      includeCompleted: false,
    });
    if (active.length >= this.maxConcurrent) {
      throw runtimeError(
        "conflict",
        `Child agent concurrency limit reached: ${active.length}/${this.maxConcurrent}`,
      );
    }
    if (!readOnly && worktreePath !== undefined) {
      const normalized = path.resolve(worktreePath);
      if (
        active.some((run) =>
          run.worktreePath === undefined
            ? path.resolve(run.workspaceRoot) === normalized
            : path.resolve(run.worktreePath) === normalized)
      ) {
        throw runtimeError(
          "conflict",
          "Another child agent is already using that worktree",
        );
      }
    }
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

function optionalString<Key extends string>(
  key: Key,
  value: string | undefined,
): { readonly [Property in Key]: string } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: string;
  };
}

function optionalNumber<Key extends string>(
  key: Key,
  value: number | undefined,
): { readonly [Property in Key]: number } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: number;
  };
}

function optionalBoolean<Key extends string>(
  key: Key,
  value: boolean | undefined,
): { readonly [Property in Key]: boolean } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: boolean;
  };
}

function runtimeError(code: string, message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}

interface AutoWorktree {
  readonly path: string;
  readonly kind: "git-worktree" | "snapshot";
}

const SNAPSHOT_TOP_LEVEL_EXCLUDES = new Set([
  ".git",
  ".pibot",
  ".pibot-evolution-workspaces",
  "approvals",
  "attachments",
  "audit.jsonl",
  "context.jsonl",
  "dist",
  "logs",
  "node_modules",
  "result.md",
  "runtime-state.json",
  "runs",
  "signals.jsonl",
  "status.json",
  "tasks.json",
  "tickets.json",
  "transcript.jsonl",
  "usage.json",
  "versions.json",
]);

const SNAPSHOT_ANY_DEPTH_EXCLUDES = new Set([
  ".DS_Store",
  ".cache",
  ".child-env.sh",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "__pycache__",
  "node_modules",
  "venv",
]);

async function gitHeadExists(workspaceRoot: string): Promise<boolean> {
  return execFile("git", [
    "-C",
    workspaceRoot,
    "rev-parse",
    "--verify",
    "HEAD",
  ]).then(
    () => true,
    () => false,
  );
}

async function copyWorkspaceSnapshot(
  workspaceRoot: string,
  destination: string,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  await cp(workspaceRoot, destination, {
    recursive: true,
    dereference: false,
    filter(source) {
      return shouldCopyWorkspaceSnapshotEntry(workspaceRoot, source);
    },
  });
}

function shouldCopyWorkspaceSnapshotEntry(
  workspaceRoot: string,
  source: string,
): boolean {
  const relative = path.relative(workspaceRoot, source);
  if (relative.length === 0) {
    return true;
  }
  const parts = relative.split(path.sep);
  const firstPart = parts[0] ?? "";
  const baseName = path.basename(source);
  if (
    baseName.endsWith(".sock") ||
    baseName.endsWith(".pyc") ||
    baseName.endsWith(".pyo")
  ) {
    return false;
  }
  if (SNAPSHOT_TOP_LEVEL_EXCLUDES.has(firstPart)) {
    return false;
  }
  return parts.every((part) => !SNAPSHOT_ANY_DEPTH_EXCLUDES.has(part));
}

async function linkNodeModules(
  workspaceRoot: string,
  worktreePath: string,
): Promise<void> {
  const source = path.join(workspaceRoot, "node_modules");
  const destination = path.join(worktreePath, "node_modules");
  const sourceStat = await stat(source).catch(() => undefined);
  if (sourceStat === undefined || !sourceStat.isDirectory()) {
    return;
  }
  await symlink(source, destination, "dir").catch(() => undefined);
}

async function cleanupAutoWorktree(
  workspaceRoot: string,
  worktree: AutoWorktree | undefined,
): Promise<void> {
  if (worktree === undefined) {
    return;
  }
  if (worktree.kind === "git-worktree") {
    await execFile("git", [
      "-C",
      workspaceRoot,
      "worktree",
      "remove",
      "--force",
      worktree.path,
    ]).catch(() => undefined);
  }
  await rm(worktree.path, { recursive: true, force: true }).catch(() => undefined);
}

function execFile(
  command: string,
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCallback(command, [...args], (error, stdout, stderr) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve({
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/gu, "_").slice(0, 80) || "run";
}
