import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { ChannelSessionKey } from "../core/session";
import { resolveWorkspacePath } from "./path-boundary";
import {
  createSandboxExecutor,
  type SandboxExecutor,
} from "./sandbox";
import type { ChannelWorkspaceStore } from "./store";

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface RepoWorkflowConfig {
  readonly repoPath: string;
  readonly checkCommand?: string;
  readonly checkTimeoutMs?: number;
  readonly maxOutputChars?: number;
}

export interface ResolvedRepoWorkflowConfig {
  readonly repoPath: string;
  readonly checkCommand?: string;
  readonly checkTimeoutMs: number;
  readonly maxOutputChars: number;
}

export interface RepoGitFileStatus {
  readonly path: string;
  readonly indexStatus: string;
  readonly workingTreeStatus: string;
}

export interface RepoGitStatusResult {
  readonly repoPath: string;
  readonly clean: boolean;
  readonly files: readonly RepoGitFileStatus[];
  readonly raw: string;
}

export interface RepoGitDiffResult {
  readonly repoPath: string;
  readonly diff: string;
  readonly truncated: boolean;
}

export interface RepoDiffSummaryResult {
  readonly repoPath: string;
  readonly summary: string;
  readonly truncated: boolean;
}

export interface RepoCheckResult {
  readonly repoPath: string;
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface RepoRunStartSnapshot {
  readonly config: ResolvedRepoWorkflowConfig;
  readonly status: RepoGitStatusResult;
}

export interface RepoRunSummary {
  readonly config: ResolvedRepoWorkflowConfig;
  readonly beforeStatus: RepoGitStatusResult;
  readonly afterStatus: RepoGitStatusResult;
  readonly diffSummary: RepoDiffSummaryResult;
  readonly checkResult?: RepoCheckResult;
  readonly remainingRisks: readonly string[];
}

export interface ChannelRepoWorkflowOptions {
  readonly workspaceRoot: string;
  readonly store: ChannelWorkspaceStore;
  readonly defaultConfig?: RepoWorkflowConfig;
  readonly useGlobalConfig?: boolean;
  readonly sandboxExecutor?: SandboxExecutor;
  readonly maxCheckTimeoutMs?: number;
}

/**
 * 职责：为 Slack channel 加载 repo workflow 配置，并提供 git_status、git_diff、run_check helper。
 * 不应承担：执行 agent loop、修改 git 历史、自动 commit、决定业务测试命令。
 */
export class ChannelRepoWorkflow {
  private readonly workspaceRoot: string;
  private readonly sandboxExecutor: SandboxExecutor;
  private readonly maxCheckTimeoutMs: number;

  constructor(private readonly options: ChannelRepoWorkflowOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.sandboxExecutor = options.sandboxExecutor ?? createSandboxExecutor();
    this.maxCheckTimeoutMs = normalizePositiveInteger(
      options.maxCheckTimeoutMs,
      600000,
    );
  }

  async prepareCodingTask(
    key: ChannelSessionKey,
    signal?: AbortSignal,
  ): Promise<RepoRunStartSnapshot | undefined> {
    const config = await this.resolveConfig(key);
    if (config === undefined) {
      return undefined;
    }

    return {
      config,
      status: await this.git_status(key, signal),
    };
  }

  async summarizeCodingTask(
    key: ChannelSessionKey,
    start: RepoRunStartSnapshot | undefined,
    signal?: AbortSignal,
  ): Promise<RepoRunSummary | undefined> {
    if (start === undefined) {
      return undefined;
    }

    const checkResult =
      start.config.checkCommand === undefined
        ? undefined
        : await this.run_check(key, signal);
    const afterStatus = await this.git_status(key, signal);
    const diffSummary = await this.git_diff_summary(key, signal);

    return {
      config: start.config,
      beforeStatus: start.status,
      afterStatus,
      diffSummary,
      ...(checkResult !== undefined ? { checkResult } : {}),
      remainingRisks: remainingRisks(afterStatus, checkResult),
    };
  }

  async git_status(
    key: ChannelSessionKey,
    signal?: AbortSignal,
  ): Promise<RepoGitStatusResult> {
    const config = await this.requireConfig(key);
    const result = await runProcess(
      "git",
      ["-c", "core.fsmonitor=false", "status", "--porcelain=v1"],
      config.repoPath,
      30000,
      config.maxOutputChars,
      signal,
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `git status failed in ${config.repoPath}: ${result.stderr || result.stdout}`,
      );
    }

    return {
      repoPath: config.repoPath,
      clean: result.stdout.trim().length === 0,
      files: parsePorcelainStatus(result.stdout),
      raw: result.stdout,
    };
  }

  async git_diff(
    key: ChannelSessionKey,
    signal?: AbortSignal,
  ): Promise<RepoGitDiffResult> {
    const config = await this.requireConfig(key);
    const result = await runProcess(
      "git",
      ["diff", "--no-ext-diff", "--no-textconv", "--", "."],
      config.repoPath,
      30000,
      config.maxOutputChars,
      signal,
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `git diff failed in ${config.repoPath}: ${result.stderr || result.stdout}`,
      );
    }

    return {
      repoPath: config.repoPath,
      diff: result.stdout,
      truncated: result.stdoutTruncated,
    };
  }

  async git_diff_summary(
    key: ChannelSessionKey,
    signal?: AbortSignal,
  ): Promise<RepoDiffSummaryResult> {
    const config = await this.requireConfig(key);
    const workingTreeResult = await runProcess(
      "git",
      ["diff", "--no-ext-diff", "--no-textconv", "--stat", "--", "."],
      config.repoPath,
      30000,
      config.maxOutputChars,
      signal,
    );
    const stagedResult = await runProcess(
      "git",
      ["diff", "--no-ext-diff", "--no-textconv", "--cached", "--stat", "--", "."],
      config.repoPath,
      30000,
      config.maxOutputChars,
      signal,
    );

    if (workingTreeResult.exitCode !== 0) {
      throw new Error(
        `git diff summary failed in ${config.repoPath}: ${workingTreeResult.stderr || workingTreeResult.stdout}`,
      );
    }
    if (stagedResult.exitCode !== 0) {
      throw new Error(
        `git staged diff summary failed in ${config.repoPath}: ${stagedResult.stderr || stagedResult.stdout}`,
      );
    }

    const summary = [
      workingTreeResult.stdout.trim(),
      stagedResult.stdout.trim(),
    ]
      .filter((value) => value.length > 0)
      .join("\n");

    return {
      repoPath: config.repoPath,
      summary,
      truncated:
        workingTreeResult.stdoutTruncated || stagedResult.stdoutTruncated,
    };
  }

  async run_check(
    key: ChannelSessionKey,
    signal?: AbortSignal,
  ): Promise<RepoCheckResult> {
    const config = await this.requireConfig(key);
    if (config.checkCommand === undefined) {
      throw new Error("run_check requires repo config checkCommand");
    }

    const result = await this.sandboxExecutor.execute(
      {
        command: config.checkCommand,
        workspaceRoot: config.repoPath,
        cwd: config.repoPath,
        timeoutMs: config.checkTimeoutMs,
        maxOutputChars: config.maxOutputChars,
      },
      signal,
    );

    return {
      repoPath: config.repoPath,
      command: config.checkCommand,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      aborted: result.aborted,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    };
  }

  async resolveConfig(
    key: ChannelSessionKey,
  ): Promise<ResolvedRepoWorkflowConfig | undefined> {
    const paths = await this.options.store.ensureChannelDirectory(key);
    const globalConfig = this.options.useGlobalConfig === false
      ? undefined
      : await readRepoConfig(path.join(paths.rootDir, "repo.json"));
    const channelConfig = await readRepoConfig(path.join(paths.channelDir, "repo.json"));
    const merged = mergeRepoConfigs(
      this.options.defaultConfig,
      globalConfig,
      channelConfig,
    );

    if (merged === undefined) {
      return undefined;
    }

    return this.resolveRepoConfig(merged);
  }

  private async requireConfig(
    key: ChannelSessionKey,
  ): Promise<ResolvedRepoWorkflowConfig> {
    const config = await this.resolveConfig(key);
    if (config === undefined) {
      throw new Error("Repo workflow is not configured for this channel");
    }

    return config;
  }

  private async resolveRepoConfig(
    config: RepoWorkflowConfig,
  ): Promise<ResolvedRepoWorkflowConfig> {
    const repoPath = await resolveWorkspacePath(this.workspaceRoot, config.repoPath, {
      access: "cwd",
      allowWorkspaceRoot: true,
    });
    this.sandboxExecutor.assertWorkspaceAccess(repoPath);
    return {
      repoPath,
      ...optionalString("checkCommand", normalizeOptionalString(config.checkCommand)),
      checkTimeoutMs: normalizeBoundedPositiveInteger(
        config.checkTimeoutMs,
        120000,
        this.maxCheckTimeoutMs,
        "repo checkTimeoutMs",
      ),
      maxOutputChars: normalizePositiveInteger(config.maxOutputChars, 12000),
    };
  }
}

export function formatRepoRunPrompt(
  start: RepoRunStartSnapshot | undefined,
): string | undefined {
  if (start === undefined) {
    return undefined;
  }

  return [
    "Repo workflow:",
    `repoPath: ${start.config.repoPath}`,
    `checkCommand: ${start.config.checkCommand ?? "not configured"}`,
    "git status before task:",
    formatStatusForPrompt(start.status),
  ].join("\n");
}

export function formatRepoRunSummary(
  summary: RepoRunSummary | undefined,
): string {
  if (summary === undefined) {
    return [
      "",
      "*Repo workflow*",
      "Changed files: not configured",
      "Check result: not configured",
      "Remaining risks: repo workflow not configured for this channel",
    ].join("\n");
  }

  return [
    "",
    "*Repo workflow*",
    `Changed files: ${formatChangedFiles(summary.afterStatus.files)}`,
    `Diff summary: ${formatDiffSummary(summary.diffSummary, summary.afterStatus)}`,
    `Check result: ${formatCheckResult(summary.checkResult)}`,
    `Remaining risks: ${formatRisks(summary.remainingRisks)}`,
  ].join("\n");
}

export function formatRepoNotConfiguredMessage(): string {
  return [
    "Repo workflow is not configured for this channel.",
    "",
    "Create `.pibot/repo.json` for a global default, or `.pibot/channels/<team>/<channel>/repo.json` for this channel.",
    "",
    "Example:",
    "```json",
    JSON.stringify(
      {
        repoPath: ".",
        checkCommand: "npm run build",
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

export function formatRepoWorkflowError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Repo workflow error: ${message}`;
}

function formatStatusForPrompt(status: RepoGitStatusResult): string {
  if (status.clean) {
    return "clean";
  }

  return status.files
    .map(
      (file) =>
        `${file.indexStatus}${file.workingTreeStatus} ${file.path}`,
    )
    .join("\n");
}

function formatChangedFiles(files: readonly RepoGitFileStatus[]): string {
  if (files.length === 0) {
    return "none";
  }

  return files.map((file) => `\`${sanitizeInlineCode(file.path)}\``).join(", ");
}

function formatDiffSummary(
  diffSummary: RepoDiffSummaryResult,
  status: RepoGitStatusResult,
): string {
  const rawSummary = diffSummary.summary.trim();
  if (rawSummary.length > 0) {
    const truncated = diffSummary.truncated ? "\n[truncated]" : "";
    return `\n\`\`\`\n${rawSummary}${truncated}\n\`\`\``;
  }

  const untrackedFiles = status.files.filter(
    (file) => file.indexStatus === "?" || file.workingTreeStatus === "?",
  );
  if (untrackedFiles.length > 0) {
    return `untracked ${untrackedFiles.length} file(s)`;
  }

  return "none";
}

function formatCheckResult(checkResult: RepoCheckResult | undefined): string {
  if (checkResult === undefined) {
    return "not configured";
  }

  if (checkResult.aborted) {
    return `aborted: \`${sanitizeInlineCode(checkResult.command)}\``;
  }

  if (checkResult.timedOut) {
    return `timed out: \`${sanitizeInlineCode(checkResult.command)}\``;
  }

  if (checkResult.exitCode === 0) {
    return `passed: \`${sanitizeInlineCode(checkResult.command)}\``;
  }

  return `failed with exit ${checkResult.exitCode}: \`${sanitizeInlineCode(checkResult.command)}\`${formatCheckFailureReason(checkResult)}`;
}

function formatRisks(risks: readonly string[]): string {
  if (risks.length === 0) {
    return "none";
  }

  return risks.join("; ");
}

function remainingRisks(
  status: RepoGitStatusResult,
  checkResult: RepoCheckResult | undefined,
): readonly string[] {
  const risks: string[] = [];
  if (checkResult === undefined) {
    risks.push("check command is not configured");
  } else if (checkResult.aborted) {
    risks.push("check was aborted");
  } else if (checkResult.timedOut) {
    risks.push("check timed out");
  } else if (checkResult.exitCode !== 0) {
    risks.push("check failed");
  }

  if (status.files.some((file) => file.indexStatus === "?" || file.workingTreeStatus === "?")) {
    risks.push("untracked files remain");
  }

  return risks;
}

function formatCheckFailureReason(checkResult: RepoCheckResult): string {
  const line = firstNonEmptyLine(checkResult.stderr) ?? firstNonEmptyLine(checkResult.stdout);
  if (line === undefined) {
    return "";
  }

  return `; reason: ${line}`;
}

function firstNonEmptyLine(text: string): string | undefined {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function parsePorcelainStatus(raw: string): readonly RepoGitFileStatus[] {
  return raw
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => {
      const indexStatus = line[0] ?? " ";
      const workingTreeStatus = line[1] ?? " ";
      return {
        indexStatus,
        workingTreeStatus,
        path: parseStatusPath(line.slice(3)),
      };
    });
}

function parseStatusPath(value: string): string {
  const renameArrow = " -> ";
  const renameIndex = value.indexOf(renameArrow);
  if (renameIndex >= 0) {
    return value.slice(renameIndex + renameArrow.length);
  }

  return value;
}

function mergeRepoConfigs(
  ...configs: readonly (RepoWorkflowConfig | undefined)[]
): RepoWorkflowConfig | undefined {
  let merged: RepoWorkflowConfig | undefined;
  for (const config of configs) {
    if (config === undefined) {
      continue;
    }

    merged = {
      ...(merged ?? {}),
      ...config,
    };
  }

  return merged;
}

async function readRepoConfig(
  filePath: string,
): Promise<RepoWorkflowConfig | undefined> {
  const content = await readTextIfExists(filePath);
  if (content === undefined) {
    return undefined;
  }

  const parsed = parseJsonObject(content);
  if (parsed === null) {
    throw new Error(`Invalid repo config JSON: ${filePath}`);
  }

  const repoPath = readString(parsed, "repoPath");
  if (repoPath === undefined) {
    throw new Error(`repo config requires repoPath: ${filePath}`);
  }

  return {
    repoPath,
    ...optionalString("checkCommand", normalizeOptionalString(readString(parsed, "checkCommand"))),
    ...optionalNumber("checkTimeoutMs", readNumber(parsed, "checkTimeoutMs")),
    ...optionalNumber("maxOutputChars", readNumber(parsed, "maxOutputChars")),
  };
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }

    throw error;
  }
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  maxOutputChars: number,
  signal: AbortSignal | undefined,
  shell: boolean = false,
): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      shell,
      windowsHide: true,
    });
    const stdout = createLimitedBuffer(maxOutputChars);
    const stderr = createLimitedBuffer(maxOutputChars);
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateChild(child);
    }, timeoutMs);

    const abort = () => {
      aborted = true;
      terminateChild(child);
    };

    if (signal?.aborted === true) {
      abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on("error", (error: Error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (!settled) {
        settled = true;
        rejectPromise(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (!settled) {
        settled = true;
        resolvePromise({
          exitCode: code ?? -1,
          stdout: stdout.text(),
          stderr: stderr.text(),
          timedOut,
          aborted,
          stdoutTruncated: stdout.truncated(),
          stderrTruncated: stderr.truncated(),
        });
      }
    });
  });
}

function terminateChild(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) {
    child.kill("SIGTERM");
    return;
  }

  if (process.platform === "win32") {
    child.kill("SIGTERM");
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (_error: unknown) {
    child.kill("SIGTERM");
  }
}

function createLimitedBuffer(maxChars: number): {
  readonly push: (chunk: Buffer) => void;
  readonly text: () => string;
  readonly truncated: () => boolean;
} {
  let value = "";
  let isTruncated = false;

  return {
    push(chunk) {
      if (value.length >= maxChars) {
        isTruncated = true;
        return;
      }

      value += chunk.toString("utf8");
      if (value.length > maxChars) {
        value = `${value.slice(0, maxChars)}\n[truncated]`;
        isTruncated = true;
      }
    },
    text() {
      return value;
    },
    truncated() {
      return isTruncated;
    },
  };
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value < 1) {
    return fallback;
  }

  return value;
}

function normalizeBoundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  max: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}`);
  }

  return resolved;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseJsonObject(value: string): UnknownRecord | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch (_error: unknown) {
    return null;
  }
}

function readString(
  record: UnknownRecord,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(
  record: UnknownRecord,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
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

function optionalNumber<Key extends string>(
  key: Key,
  value: number | undefined,
): { readonly [Property in Key]: number } | object {
  if (value === undefined) {
    return {};
  }

  return { [key]: value } as { readonly [Property in Key]: number };
}

function sanitizeInlineCode(value: string): string {
  return value.replace(/`/gu, "'");
}
