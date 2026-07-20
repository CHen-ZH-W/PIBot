import { spawn as spawnProcess } from "node:child_process";
import { chmod, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type {
  ChildAgentRunRecord,
  ChildAgentTmuxTarget,
} from "../workspace/child-agents";

export interface ChildAgentSupervisor {
  spawn(record: ChildAgentRunRecord): Promise<ChildAgentTmuxTarget>;
  capture(
    target: ChildAgentTmuxTarget,
    options?: {
      readonly lines?: number;
      readonly maxChars?: number;
    },
  ): Promise<string>;
  send(
    target: ChildAgentTmuxTarget,
    text: string,
    options?: {
      readonly enter?: boolean;
    },
  ): Promise<void>;
  stop(target: ChildAgentTmuxTarget): Promise<void>;
  isAlive(target: ChildAgentTmuxTarget): Promise<boolean>;
}

export interface TmuxChildAgentSupervisorOptions {
  readonly commandTemplate?: string;
  readonly tmuxPath?: string;
  readonly socketPath?: string;
  readonly defaultCaptureLines?: number;
  readonly defaultCaptureMaxChars?: number;
}

export function defaultChildAgentCommandTemplate(): string {
  return [
    shellQuote(process.execPath),
    shellQuote(path.join(__dirname, "..", "child-agent.js")),
  ].join(" ");
}

export class TmuxChildAgentSupervisor implements ChildAgentSupervisor {
  private readonly tmuxPath: string;
  private readonly socketPath: string | undefined;
  private readonly defaultCaptureLines: number;
  private readonly defaultCaptureMaxChars: number;

  constructor(private readonly options: TmuxChildAgentSupervisorOptions = {}) {
    this.tmuxPath = options.tmuxPath ?? "tmux";
    this.socketPath = normalizedOptionalString(options.socketPath);
    this.defaultCaptureLines = positiveInteger(
      options.defaultCaptureLines,
      120,
      "defaultCaptureLines",
    );
    this.defaultCaptureMaxChars = positiveInteger(
      options.defaultCaptureMaxChars,
      20000,
      "defaultCaptureMaxChars",
    );
  }

  async spawn(record: ChildAgentRunRecord): Promise<ChildAgentTmuxTarget> {
    const commandTemplate =
      normalizedOptionalString(this.options.commandTemplate) ??
      defaultChildAgentCommandTemplate();

    const target = tmuxTargetFor(record, this.socketPath);
    const inheritedEnvFile = path.join(record.paths.runDir, ".child-env.sh");
    await writeInheritedEnvironmentFile(inheritedEnvFile, process.env);
    const wrapper = childWrapperCommand(
      record,
      expandCommand(commandTemplate, record),
      inheritedEnvFile,
    );
    const sessionExists = await this.sessionExists(
      target.session,
      target.socketPath,
    );
    try {
      if (sessionExists) {
        await execFile(
          this.tmuxPath,
          this.tmuxArgs([
            "new-window",
            "-d",
            "-t",
            target.session,
            "-n",
            target.window,
            "--",
            "sh",
            "-lc",
            wrapper,
          ], target.socketPath),
        );
      } else {
        await execFile(
          this.tmuxPath,
          this.tmuxArgs([
            "new-session",
            "-d",
            "-s",
            target.session,
            "-n",
            target.window,
            "--",
            "sh",
            "-lc",
            wrapper,
          ], target.socketPath),
        );
      }
    } catch (error: unknown) {
      await rm(inheritedEnvFile, { force: true }).catch(() => undefined);
      throw error;
    }

    return target;
  }

  async capture(
    target: ChildAgentTmuxTarget,
    options: {
      readonly lines?: number;
      readonly maxChars?: number;
    } = {},
  ): Promise<string> {
    const lines = positiveInteger(
      options.lines,
      this.defaultCaptureLines,
      "lines",
    );
    const maxChars = positiveInteger(
      options.maxChars,
      this.defaultCaptureMaxChars,
      "maxChars",
    );
    const output = await execFile(
      this.tmuxPath,
      this.tmuxArgs([
        "capture-pane",
        "-t",
        target.target,
        "-p",
        "-S",
        `-${lines}`,
      ], target.socketPath),
    );
    return output.stdout.length <= maxChars
      ? output.stdout
      : `${output.stdout.slice(-maxChars)}\n[truncated]`;
  }

  async send(
    target: ChildAgentTmuxTarget,
    text: string,
    options: {
      readonly enter?: boolean;
    } = {},
  ): Promise<void> {
    if (text.length > 4000) {
      throw new Error("agent_send.text exceeds 4000 characters");
    }
    await execFile(
      this.tmuxPath,
      this.tmuxArgs(
        ["send-keys", "-t", target.target, "-l", text],
        target.socketPath,
      ),
    );
    if (options.enter !== false) {
      await execFile(
        this.tmuxPath,
        this.tmuxArgs(
          ["send-keys", "-t", target.target, "C-m"],
          target.socketPath,
        ),
      );
    }
  }

  async stop(target: ChildAgentTmuxTarget): Promise<void> {
    await execFile(
      this.tmuxPath,
      this.tmuxArgs(["kill-window", "-t", target.target], target.socketPath),
    ).catch(() => ({
      stdout: "",
      stderr: "",
    }));
  }

  async isAlive(target: ChildAgentTmuxTarget): Promise<boolean> {
    return execFile(
      this.tmuxPath,
      this.tmuxArgs(["list-panes", "-t", target.target], target.socketPath),
    ).then(
      () => true,
      () => false,
    );
  }

  private async sessionExists(
    session: string,
    socketPath: string | undefined,
  ): Promise<boolean> {
    return execFile(
      this.tmuxPath,
      this.tmuxArgs(["has-session", "-t", session], socketPath),
    ).then(
      () => true,
      () => false,
    );
  }

  private tmuxArgs(
    args: readonly string[],
    socketPath: string | undefined,
  ): readonly string[] {
    return socketPath === undefined ? args : ["-S", socketPath, ...args];
  }
}

function tmuxTargetFor(
  record: ChildAgentRunRecord,
  socketPath: string | undefined,
): ChildAgentTmuxTarget {
  const session = sanitizeTmuxName(`pibot-${shortId(record.parentRunId)}`);
  const window = sanitizeTmuxName(`${record.role}-${shortId(record.childRunId)}`);
  return {
    session,
    window,
    target: `${session}:${window}`,
    ...(socketPath === undefined ? {} : { socketPath }),
  };
}

function childWrapperCommand(
  record: ChildAgentRunRecord,
  childCommand: string,
  inheritedEnvFile: string,
): string {
  const timeoutSeconds = Math.max(1, Math.ceil(record.budget.timeoutMs / 1000));
  const workspaceRoot = record.worktreePath ?? record.workspaceRoot;
  return [
    "set -u",
    `if [ -f ${shellQuote(inheritedEnvFile)} ]; then . ${shellQuote(inheritedEnvFile)}; rm -f ${shellQuote(inheritedEnvFile)}; fi`,
    `export PIBOT_CHILD_RUN_ID=${shellQuote(record.childRunId)}`,
    `export PIBOT_PARENT_RUN_ID=${shellQuote(record.parentRunId)}`,
    `export PIBOT_CHILD_ROLE=${shellQuote(record.role)}`,
    `export PIBOT_CHILD_AGENT_ID=${shellQuote(record.agentId)}`,
    `export PIBOT_CHILD_READ_ONLY=${shellQuote(record.readOnly ? "1" : "0")}`,
    `export PIBOT_CHILD_RUN_DIR=${shellQuote(record.paths.runDir)}`,
    `export PIBOT_TASK_FILE=${shellQuote(record.paths.taskFile)}`,
    `export PIBOT_STATUS_FILE=${shellQuote(record.paths.statusFile)}`,
    `export PIBOT_TRANSCRIPT_FILE=${shellQuote(record.paths.transcriptFile)}`,
    `export PIBOT_RESULT_FILE=${shellQuote(record.paths.resultFile)}`,
    `export PIBOT_USAGE_FILE=${shellQuote(record.paths.usageFile)}`,
    `export PIBOT_WORKSPACE_ROOT=${shellQuote(workspaceRoot)}`,
    `export PIBOT_CHILD_TIMEOUT_MS=${shellQuote(String(record.budget.timeoutMs))}`,
    `export PIBOT_CHILD_MAX_TOOL_CALLS=${shellQuote(String(record.budget.maxToolCalls))}`,
    `export PIBOT_CHILD_MAX_TOKENS=${shellQuote(String(record.budget.maxTokens))}`,
    ...(record.approvalContext === undefined
      ? []
      : [
          `export PIBOT_APPROVAL_TEAM_ID=${shellQuote(record.approvalContext.conversation.teamId)}`,
          `export PIBOT_APPROVAL_CHANNEL_ID=${shellQuote(record.approvalContext.conversation.channelId)}`,
          `export PIBOT_APPROVAL_REQUESTED_BY_USER_ID=${shellQuote(record.approvalContext.requestedByUserId)}`,
          ...(record.approvalContext.conversation.threadTs === undefined
            ? []
            : [
                `export PIBOT_APPROVAL_THREAD_TS=${shellQuote(record.approvalContext.conversation.threadTs)}`,
              ]),
        ]),
    ...(record.worktreePath === undefined
      ? []
      : [`export PIBOT_CHILD_WORKTREE=${shellQuote(record.worktreePath)}`]),
    "update_status() { node -e " +
      shellQuote(statusUpdateScript()) +
      " \"$PIBOT_STATUS_FILE\" \"$1\" \"${2:-}\" \"${3:-}\"; }",
    "append_transcript() { node -e " +
      shellQuote(transcriptAppendScript()) +
      " \"$PIBOT_TRANSCRIPT_FILE\" \"$1\"; }",
    "update_status running",
    "append_transcript child_agent.started",
    `timeout --foreground ${timeoutSeconds}s sh -lc ${shellQuote(childCommand)}`,
    "exit_code=$?",
    "if [ \"$exit_code\" -eq 124 ]; then next_status=timeout; stop_reason=timeout; " +
      "elif [ \"$exit_code\" -eq 0 ]; then next_status=completed; stop_reason=; " +
      "else next_status=failed; stop_reason=process_exit; fi",
    "if [ ! -s \"$PIBOT_RESULT_FILE\" ]; then " +
      "printf 'Child agent exited with code %s and did not write result.md.\\n' \"$exit_code\" > \"$PIBOT_RESULT_FILE\"; fi",
    "update_status \"$next_status\" \"$exit_code\" \"$stop_reason\"",
    "append_transcript child_agent.finished",
    "exit \"$exit_code\"",
  ].join("\n");
}

async function writeInheritedEnvironmentFile(
  file: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const lines = [
    "# Generated by pibot for one child-agent tmux pane.",
    "# Sourced once by the child wrapper and then removed.",
    "set +u",
  ];
  for (const [name, value] of Object.entries(env).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (value === undefined || shouldSkipInheritedEnv(name)) {
      continue;
    }
    lines.push(`export ${name}=${shellQuote(value)}`);
  }
  lines.push("set -u");
  await writeFile(file, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600).catch(() => undefined);
}

function shouldSkipInheritedEnv(name: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    return true;
  }
  return (
    name === "TMUX" ||
    name === "TMUX_PANE" ||
    name === "SHLVL" ||
    name === "_" ||
    name.startsWith("PIBOT_CHILD_") ||
    name === "PIBOT_PARENT_RUN_ID" ||
    name === "PIBOT_TASK_FILE" ||
    name === "PIBOT_STATUS_FILE" ||
    name === "PIBOT_TRANSCRIPT_FILE" ||
    name === "PIBOT_RESULT_FILE" ||
    name === "PIBOT_USAGE_FILE" ||
    name === "PIBOT_WORKSPACE_ROOT" ||
    name === "PIBOT_APPROVAL_TEAM_ID" ||
    name === "PIBOT_APPROVAL_CHANNEL_ID" ||
    name === "PIBOT_APPROVAL_REQUESTED_BY_USER_ID" ||
    name === "PIBOT_APPROVAL_THREAD_TS"
  );
}

function expandCommand(template: string, record: ChildAgentRunRecord): string {
  const workspaceRoot = record.worktreePath ?? record.workspaceRoot;
  const values: Record<string, string> = {
    childRunId: record.childRunId,
    parentRunId: record.parentRunId,
    role: record.role,
    agentId: record.agentId,
    runDir: record.paths.runDir,
    taskFile: record.paths.taskFile,
    statusFile: record.paths.statusFile,
    transcriptFile: record.paths.transcriptFile,
    resultFile: record.paths.resultFile,
    usageFile: record.paths.usageFile,
    workspaceRoot,
    parentWorkspaceRoot: record.workspaceRoot,
    readOnly: record.readOnly ? "1" : "0",
    worktreePath: workspaceRoot,
  };
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu, (match, key) =>
    values[key] ?? match);
}

function statusUpdateScript(): string {
  return [
    "const fs=require('fs');",
    "const [file,status,exitCode,stopReason]=process.argv.slice(1);",
    "const data=JSON.parse(fs.readFileSync(file,'utf8'));",
    "const now=new Date().toISOString();",
    "data.status=status;",
    "data.updatedAt=now;",
    "if(status==='running'&&!data.startedAt)data.startedAt=now;",
    "if(['completed','failed','stopped','timeout'].includes(status))data.endedAt=now;",
    "if(exitCode!=='')data.exitCode=Number(exitCode);",
    "if(stopReason!=='')data.stopReason=stopReason;",
    "fs.writeFileSync(file,JSON.stringify(data,null,2)+'\\n');",
  ].join("");
}

function transcriptAppendScript(): string {
  return [
    "const fs=require('fs');",
    "const [file,type]=process.argv.slice(1);",
    "fs.mkdirSync(require('path').dirname(file),{recursive:true});",
    "fs.appendFileSync(file,JSON.stringify({ts:new Date().toISOString(),type})+'\\n');",
  ].join("");
}

function sanitizeTmuxName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/gu, "_").slice(0, 80) || "pibot";
}

function shortId(value: string): string {
  return value.replace(/[^A-Za-z0-9]/gu, "").slice(0, 8) || "run";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function normalizedOptionalString(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  return value;
}

function execFile(
  command: string,
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) {
        resolve(result);
        return;
      }
      const error = new Error(
        `${command} ${args.join(" ")} exited with code ${code}: ${result.stderr}`,
      );
      reject(error);
    });
  });
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
