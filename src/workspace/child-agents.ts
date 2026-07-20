import { randomUUID } from "node:crypto";
import * as path from "node:path";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import type { ChannelSessionKey } from "../core/session";
import type { ToolApprovalContext } from "../core/tools";
import type {
  AgentRunId,
  SlackChannelId,
  SlackTeamId,
} from "../core/ids";
import type {
  ChannelWorkspaceStore,
  JsonObject,
  JsonValue,
} from "./store";

export type ChildAgentRole = "explore" | "review" | "test" | "implement";
export type ChildAgentStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "timeout";

export interface ChildAgentBudget {
  readonly timeoutMs: number;
  readonly maxToolCalls: number;
  readonly maxTokens: number;
}

export interface ChildAgentTmuxTarget {
  readonly session: string;
  readonly window: string;
  readonly target: string;
  readonly socketPath?: string;
}

export interface ChildAgentRunPaths {
  readonly runDir: string;
  readonly taskFile: string;
  readonly statusFile: string;
  readonly transcriptFile: string;
  readonly resultFile: string;
  readonly usageFile: string;
}

export interface ChildAgentRunRecord {
  readonly childRunId: AgentRunId;
  readonly parentRunId: AgentRunId;
  readonly role: ChildAgentRole;
  readonly agentId: string;
  readonly status: ChildAgentStatus;
  readonly teamId: string;
  readonly channelId: string;
  readonly workspaceRoot: string;
  readonly worktreePath?: string;
  readonly readOnly: boolean;
  readonly task: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly exitCode?: number;
  readonly stopReason?: string;
  readonly budget: ChildAgentBudget;
  readonly tmux?: ChildAgentTmuxTarget;
  readonly approvalContext?: ToolApprovalContext;
  readonly paths: ChildAgentRunPaths;
}

export interface ChildAgentUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly toolCalls: number;
  readonly durationMs: number;
}

export interface CreateChildAgentRunRequest {
  readonly key: ChannelSessionKey;
  readonly parentRunId: AgentRunId;
  readonly role: ChildAgentRole;
  readonly agentId?: string;
  readonly task: string;
  readonly workspaceRoot: string;
  readonly worktreePath?: string;
  readonly readOnly: boolean;
  readonly budget: ChildAgentBudget;
  readonly tmux?: ChildAgentTmuxTarget;
  readonly approvalContext?: ToolApprovalContext;
}

export interface ChildAgentRunStore {
  createRun(request: CreateChildAgentRunRequest): Promise<ChildAgentRunRecord>;
  readRun(
    key: ChannelSessionKey,
    childRunId: AgentRunId,
  ): Promise<ChildAgentRunRecord>;
  listRuns(
    key: ChannelSessionKey,
    options?: {
      readonly parentRunId?: AgentRunId;
      readonly includeCompleted?: boolean;
    },
  ): Promise<readonly ChildAgentRunRecord[]>;
  updateRun(
    key: ChannelSessionKey,
    childRunId: AgentRunId,
    patch: ChildAgentRunPatch,
  ): Promise<ChildAgentRunRecord>;
  appendTranscript(
    key: ChannelSessionKey,
    childRunId: AgentRunId,
    event: JsonObject,
  ): Promise<void>;
  readResult(
    key: ChannelSessionKey,
    childRunId: AgentRunId,
  ): Promise<string | undefined>;
  readUsage(
    key: ChannelSessionKey,
    childRunId: AgentRunId,
  ): Promise<ChildAgentUsage>;
}

export interface ChildAgentRunPatch {
  readonly status?: ChildAgentStatus;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly exitCode?: number;
  readonly stopReason?: string;
  readonly tmux?: ChildAgentTmuxTarget;
}

export interface FileChildAgentRunStoreOptions {
  readonly store: ChannelWorkspaceStore;
  readonly maxResultBytes?: number;
  readonly maxTranscriptBytes?: number;
  readonly maxIndexBytes?: number;
}

export class FileChildAgentRunStore implements ChildAgentRunStore {
  private readonly maxResultBytes: number;
  private readonly maxTranscriptBytes: number;
  private readonly maxIndexBytes: number;

  constructor(private readonly options: FileChildAgentRunStoreOptions) {
    this.maxResultBytes = positiveInteger(
      options.maxResultBytes,
      200_000,
      "maxResultBytes",
    );
    this.maxTranscriptBytes = positiveInteger(
      options.maxTranscriptBytes,
      2_000_000,
      "maxTranscriptBytes",
    );
    this.maxIndexBytes = positiveInteger(
      options.maxIndexBytes,
      4_000_000,
      "maxIndexBytes",
    );
  }

  async createRun(
    request: CreateChildAgentRunRequest,
  ): Promise<ChildAgentRunRecord> {
    const paths = await this.pathsForNewRun(request.key);
    const now = new Date().toISOString();
    const record: ChildAgentRunRecord = {
      childRunId: path.basename(paths.runDir) as AgentRunId,
      parentRunId: request.parentRunId,
      role: request.role,
      agentId: request.agentId ?? roleAgentId(request.role),
      status: "starting",
      teamId: request.key.teamId,
      channelId: request.key.channelId,
      workspaceRoot: request.workspaceRoot,
      ...optionalString("worktreePath", request.worktreePath),
      readOnly: request.readOnly,
      task: request.task,
      createdAt: now,
      updatedAt: now,
      budget: request.budget,
      ...(request.tmux === undefined ? {} : { tmux: request.tmux }),
      ...(request.approvalContext === undefined
        ? {}
        : { approvalContext: request.approvalContext }),
      paths,
    };

    await mkdir(paths.runDir, { recursive: true });
    await writeFile(paths.taskFile, renderTaskMarkdown(record), "utf8");
    await writeJson(paths.statusFile, record);
    await writeJson(paths.usageFile, emptyUsage());
    await writeFile(paths.resultFile, "", "utf8");
    await this.appendTranscript(request.key, record.childRunId, {
      type: "child_agent.created",
      childRunId: record.childRunId,
      parentRunId: record.parentRunId,
      role: record.role,
      readOnly: record.readOnly,
      createdAt: record.createdAt,
    });
    await this.appendGlobalIndex(record);
    return record;
  }

  async readRun(
    key: ChannelSessionKey,
    childRunId: AgentRunId,
  ): Promise<ChildAgentRunRecord> {
    return parseRunRecord(
      await readJson(this.pathsForRun(key, childRunId).statusFile),
    );
  }

  async listRuns(
    key: ChannelSessionKey,
    options: {
      readonly parentRunId?: AgentRunId;
      readonly includeCompleted?: boolean;
    } = {},
  ): Promise<readonly ChildAgentRunRecord[]> {
    const runsDir = this.channelRunsDir(key);
    const entries = await readDirectoryNames(runsDir);
    const runs: ChildAgentRunRecord[] = [];
    for (const entry of entries) {
      try {
        const run = await this.readRun(key, entry as AgentRunId);
        if (
          options.parentRunId !== undefined &&
          run.parentRunId !== options.parentRunId
        ) {
          continue;
        }
        if (
          options.includeCompleted !== true &&
          isTerminalChildStatus(run.status)
        ) {
          continue;
        }
        runs.push(run);
      } catch {
        continue;
      }
    }

    return runs.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt));
  }

  async updateRun(
    key: ChannelSessionKey,
    childRunId: AgentRunId,
    patch: ChildAgentRunPatch,
  ): Promise<ChildAgentRunRecord> {
    const current = await this.readRun(key, childRunId);
    const next: ChildAgentRunRecord = {
      ...current,
      ...optionalStatus("status", patch.status),
      ...optionalString("startedAt", patch.startedAt),
      ...optionalString("endedAt", patch.endedAt),
      ...optionalNumber("exitCode", patch.exitCode),
      ...optionalString("stopReason", patch.stopReason),
      ...(patch.tmux === undefined ? {} : { tmux: patch.tmux }),
      updatedAt: new Date().toISOString(),
    };
    await writeJson(current.paths.statusFile, next);
    await this.appendTranscript(key, childRunId, {
      type: "child_agent.status_updated",
      childRunId,
      status: next.status,
      updatedAt: next.updatedAt,
      ...(patch.stopReason === undefined
        ? {}
        : { stopReason: patch.stopReason }),
      ...(patch.exitCode === undefined ? {} : { exitCode: patch.exitCode }),
    });
    await this.appendGlobalIndex(next);
    return next;
  }

  async appendTranscript(
    key: ChannelSessionKey,
    childRunId: AgentRunId,
    event: JsonObject,
  ): Promise<void> {
    const paths = this.pathsForRun(key, childRunId);
    await appendJsonl(paths.transcriptFile, {
      ts: new Date().toISOString(),
      ...event,
    }, this.maxTranscriptBytes);
  }

  async readResult(
    key: ChannelSessionKey,
    childRunId: AgentRunId,
  ): Promise<string | undefined> {
    const resultFile = this.pathsForRun(key, childRunId).resultFile;
    const fileStat = await stat(resultFile).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (fileStat === undefined) {
      return undefined;
    }
    if (fileStat.size > this.maxResultBytes) {
      return `${await readFile(resultFile, "utf8").then((value) =>
        value.slice(0, this.maxResultBytes),
      )}\n[truncated]`;
    }

    return readFile(resultFile, "utf8");
  }

  async readUsage(
    key: ChannelSessionKey,
    childRunId: AgentRunId,
  ): Promise<ChildAgentUsage> {
    const usageFile = this.pathsForRun(key, childRunId).usageFile;
    try {
      return parseUsage(await readJson(usageFile));
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return emptyUsage();
      }
      return emptyUsage();
    }
  }

  private async pathsForNewRun(
    key: ChannelSessionKey,
  ): Promise<ChildAgentRunPaths> {
    await this.options.store.ensureChannelDirectory(key);
    while (true) {
      const childRunId = randomUUID() as AgentRunId;
      const paths = this.pathsForRun(key, childRunId);
      const exists = await stat(paths.runDir).then(
        () => true,
        () => false,
      );
      if (!exists) {
        return paths;
      }
    }
  }

  private pathsForRun(
    key: ChannelSessionKey,
    childRunId: AgentRunId,
  ): ChildAgentRunPaths {
    const runDir = path.join(this.channelRunsDir(key), childRunId);
    return {
      runDir,
      taskFile: path.join(runDir, "task.md"),
      statusFile: path.join(runDir, "status.json"),
      transcriptFile: path.join(runDir, "transcript.jsonl"),
      resultFile: path.join(runDir, "result.md"),
      usageFile: path.join(runDir, "usage.json"),
    };
  }

  private channelRunsDir(key: ChannelSessionKey): string {
    return path.join(this.options.store.getPaths(key).channelDir, "runs");
  }

  private async appendGlobalIndex(record: ChildAgentRunRecord): Promise<void> {
    const key = {
      teamId: record.teamId as SlackTeamId,
      channelId: record.channelId as SlackChannelId,
    };
    const rootDir = this.options.store.getPaths(key).rootDir;
    const indexFile = path.join(
      rootDir,
      "runs",
      "index.jsonl",
    );
    await appendJsonl(indexFile, {
      type: "child_agent_run",
      childRunId: record.childRunId,
      parentRunId: record.parentRunId,
      role: record.role,
      agentId: record.agentId,
      status: record.status,
      teamId: record.teamId,
      channelId: record.channelId,
      runDir: path.relative(
        rootDir,
        record.paths.runDir,
      ).split(path.sep).join("/"),
      updatedAt: record.updatedAt,
    }, this.maxIndexBytes);
  }
}

export function isTerminalChildStatus(status: ChildAgentStatus): boolean {
  return status === "completed" ||
    status === "failed" ||
    status === "stopped" ||
    status === "timeout";
}

export function defaultChildAgentBudget(
  options: {
    readonly timeoutMs?: number;
    readonly maxToolCalls?: number;
    readonly maxTokens?: number;
  } = {},
): ChildAgentBudget {
  return {
    timeoutMs: positiveInteger(options.timeoutMs, 900000, "timeoutMs"),
    maxToolCalls: positiveInteger(options.maxToolCalls, 40, "maxToolCalls"),
    maxTokens: positiveInteger(options.maxTokens, 120000, "maxTokens"),
  };
}

function renderTaskMarkdown(record: ChildAgentRunRecord): string {
  return [
    `# ${record.agentId}`,
    "",
    `- childRunId: ${record.childRunId}`,
    `- parentRunId: ${record.parentRunId}`,
    `- role: ${record.role}`,
    `- readOnly: ${record.readOnly}`,
    `- workspaceRoot: ${record.workspaceRoot}`,
    ...(record.worktreePath === undefined
      ? []
      : [`- worktreePath: ${record.worktreePath}`]),
    "",
    "## Task",
    "",
    record.task,
    "",
    "## Output Contract",
    "",
    "- Write the final structured result to result.md.",
    "- Keep detailed logs in transcript.jsonl or the tmux pane.",
    "- Update status.json and usage.json if your child runner supports it.",
  ].join("\n");
}

function roleAgentId(role: ChildAgentRole): string {
  switch (role) {
    case "explore":
      return "ExploreAgent";
    case "review":
      return "ReviewAgent";
    case "test":
      return "TestAgent";
    case "implement":
      return "ImplementAgent";
  }
}

async function readDirectoryNames(directory: string): Promise<readonly string[]> {
  try {
    return await readdir(directory);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function appendJsonl(
  filePath: string,
  record: JsonObject,
  maxFileBytes: number,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  const currentBytes = await fileSizeIfExists(filePath);
  if (currentBytes + Buffer.byteLength(line, "utf8") > maxFileBytes) {
    throw new Error(`File exceeds maximum size of ${maxFileBytes} bytes: ${filePath}`);
  }
  await appendFile(filePath, line, "utf8");
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseRunRecord(value: unknown): ChildAgentRunRecord {
  if (!isRecord(value)) {
    throw new Error("Invalid child agent status.json");
  }
  const status = readString(value, "status");
  const role = readString(value, "role");
  if (!isChildAgentStatus(status) || !isChildAgentRole(role)) {
    throw new Error("Invalid child agent status or role");
  }
  return value as unknown as ChildAgentRunRecord;
}

function parseUsage(value: unknown): ChildAgentUsage {
  if (!isRecord(value)) {
    return emptyUsage();
  }
  return {
    inputTokens: readNonNegativeInteger(value, "inputTokens") ?? 0,
    outputTokens: readNonNegativeInteger(value, "outputTokens") ?? 0,
    totalTokens: readNonNegativeInteger(value, "totalTokens") ?? 0,
    toolCalls: readNonNegativeInteger(value, "toolCalls") ?? 0,
    durationMs: readNonNegativeInteger(value, "durationMs") ?? 0,
  };
}

function emptyUsage(): ChildAgentUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    durationMs: 0,
  };
}

function isChildAgentRole(value: string | undefined): value is ChildAgentRole {
  return value === "explore" ||
    value === "review" ||
    value === "test" ||
    value === "implement";
}

function isChildAgentStatus(value: string | undefined): value is ChildAgentStatus {
  return value === "starting" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "stopped" ||
    value === "timeout";
}

function isRecord(value: unknown): value is Record<string, JsonValue | undefined> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, JsonValue | undefined>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNonNegativeInteger(
  record: Record<string, JsonValue | undefined>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

async function fileSizeIfExists(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
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

function optionalStatus<Key extends string>(
  key: Key,
  value: ChildAgentStatus | undefined,
): { readonly [Property in Key]: ChildAgentStatus } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: ChildAgentStatus;
  };
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
