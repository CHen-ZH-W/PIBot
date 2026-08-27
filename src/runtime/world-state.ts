import { execFile } from "node:child_process";
import * as path from "node:path";
import type { ChildAgentRuntime } from "./child-agents";

type WorldStateObject = Readonly<Record<string, unknown>>;

export interface RuntimeWorldStateProviderOptions {
  readonly workspaceRoot: string;
  readonly sandboxLabel?: string;
  readonly approvalMode?: string;
  readonly pendingApprovalCount?: () => number;
  readonly childAgents?: ChildAgentRuntime;
  /** pibot currently has no MCP client registry; keep this explicit in state. */
  readonly mcpServers?: readonly string[];
}

/**
 * Produces bounded, refreshable environment truth for the World State lane.
 * Failures are represented as availability fields and never abort a model step.
 */
export function createRuntimeWorldStateProvider(
  options: RuntimeWorldStateProviderOptions,
): () => Promise<WorldStateObject> {
  return async () => {
    const [repo, childAgents] = await Promise.all([
      readRepoWorldState(options.workspaceRoot),
      readChildAgentWorldState(options.childAgents),
    ]);
    return {
      workspace: {
        cwd: path.resolve(options.workspaceRoot),
      },
      repo,
      sandbox: {
        configured: options.sandboxLabel !== undefined,
        label: options.sandboxLabel ?? "unknown",
      },
      approval: {
        mode: options.approvalMode ?? "unknown",
        pending: safePendingCount(options.pendingApprovalCount),
      },
      mcp: {
        supported: false,
        configured: (options.mcpServers?.length ?? 0) > 0,
        servers: options.mcpServers ?? [],
      },
      childAgents,
    };
  };
}

async function readRepoWorldState(
  workspaceRoot: string,
): Promise<WorldStateObject> {
  try {
    const [rootResult, statusResult] = await Promise.all([
      runGit(workspaceRoot, ["rev-parse", "--show-toplevel"]),
      runGit(workspaceRoot, [
        "-c",
        "core.fsmonitor=false",
        "status",
        "--porcelain=v1",
        "--branch",
      ]),
    ]);
    const statusLines = statusResult.stdout
      .split(/\r?\n/u)
      .filter((line) => line.length > 0);
    const branchLine = statusLines[0]?.startsWith("## ") === true
      ? statusLines.shift()?.slice(3)
      : undefined;
    const files = statusLines.slice(0, 50).map((line) => ({
      status: line.slice(0, 2),
      path: truncate(line.slice(3), 500),
    }));
    return {
      available: true,
      root: rootResult.stdout.trim(),
      branch: normalizeBranch(branchLine),
      dirty: statusLines.length > 0,
      changedFileCount: statusLines.length,
      files,
      omittedFiles: Math.max(0, statusLines.length - files.length),
    };
  } catch (error: unknown) {
    return {
      available: false,
      error: truncate(error instanceof Error ? error.message : String(error), 500),
    };
  }
}

async function readChildAgentWorldState(
  runtime: ChildAgentRuntime | undefined,
): Promise<WorldStateObject> {
  if (runtime === undefined) {
    return { configured: false, counts: {}, active: [] };
  }
  try {
    const runs = await runtime.listAgents({ includeCompleted: true });
    const counts: Record<string, number> = {};
    for (const run of runs) {
      counts[run.status] = (counts[run.status] ?? 0) + 1;
    }
    const activeRuns = runs.filter(
      (run) =>
        run.status !== "completed" &&
        run.status !== "failed" &&
        run.status !== "stopped" &&
        run.status !== "timeout",
    );
    const active = activeRuns
      .slice(-20)
      .map((run) => ({
        childRunId: run.childRunId,
        agentId: run.agentId,
        role: run.role,
        status: run.status,
        readOnly: run.readOnly,
        task: truncate(run.task, 500),
        updatedAt: run.updatedAt,
      }));
    return {
      configured: true,
      total: runs.length,
      counts,
      active,
      omittedActive: Math.max(0, activeRuns.length - active.length),
    };
  } catch (error: unknown) {
    return {
      configured: true,
      available: false,
      error: truncate(error instanceof Error ? error.message : String(error), 500),
    };
  }
}

function runGit(
  cwd: string,
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        encoding: "utf8",
        timeout: 3_000,
        maxBuffer: 256_000,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function normalizeBranch(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const withoutTracking = value.split("...")[0]?.trim() ?? value.trim();
  return withoutTracking.replace(/^No commits yet on /u, "");
}

function safePendingCount(provider: (() => number) | undefined): number {
  if (provider === undefined) {
    return 0;
  }
  try {
    return Math.max(0, Math.floor(provider()));
  } catch {
    return 0;
  }
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars
    ? value
    : `${value.slice(0, Math.max(0, maxChars - 14))}...[truncated]`;
}
