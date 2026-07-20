import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface SandboxCommandRequest {
  readonly command: string;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
}

export interface SandboxCommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

/**
 * 职责：作为 bash 命令执行的唯一边界，隐藏 host/docker 的进程细节。
 * 不应承担：决定 agent 是否应该调用命令、解释命令输出、读写文件工具的路径规则。
 */
export interface SandboxExecutor {
  /**
   * File tools run in the pibot host process. Docker executors use this hook
   * to ensure that host-side file access stays inside the mounted workspace.
   */
  assertWorkspaceAccess(workspaceRoot: string): void;
  execute(
    request: SandboxCommandRequest,
    signal?: AbortSignal,
  ): Promise<SandboxCommandOutput>;
}

export type SandboxExecutorConfig =
  | {
      readonly kind: "disabled";
    }
  | {
      readonly kind: "host";
      readonly enabled?: boolean;
      readonly shell?: boolean | string;
    }
  | {
      readonly kind: "docker";
      readonly containerName: string;
      readonly hostWorkspaceRoot: string;
      readonly containerWorkspaceRoot: string;
      readonly dockerPath?: string;
    }
  | {
      readonly kind: "linux-native";
      readonly launcherPath?: string;
      readonly maxProcesses?: number;
      readonly maxOpenFiles?: number;
      readonly maxFileSizeBytes?: number;
      readonly maxMemoryBytes?: number;
    };

export class DisabledSandboxExecutor implements SandboxExecutor {
  assertWorkspaceAccess(): void {}

  execute(): Promise<SandboxCommandOutput> {
    throw sandboxError(
      "permission_denied",
      "Host sandbox executor is disabled. Enable it explicitly or configure a docker or linux-native executor.",
    );
  }
}

export class HostSandboxExecutor implements SandboxExecutor {
  private readonly enabled: boolean;
  private readonly shell: boolean | string;

  constructor(options: { readonly enabled: boolean; readonly shell?: boolean | string }) {
    this.enabled = options.enabled;
    this.shell = options.shell ?? true;
  }

  assertWorkspaceAccess(): void {}

  execute(
    request: SandboxCommandRequest,
    signal?: AbortSignal,
  ): Promise<SandboxCommandOutput> {
    if (!this.enabled) {
      throw sandboxError(
        "permission_denied",
        "Host sandbox executor is disabled. Set SANDBOX_EXECUTOR=host and SANDBOX_HOST_ENABLED=1 to enable it.",
      );
    }

    const normalized = normalizeSandboxRequest(request);
    return runProcess(
      {
        command: normalized.command,
        args: [],
        cwd: normalized.cwd,
        shell: this.shell,
        timeoutMs: normalized.timeoutMs,
        maxOutputChars: normalized.maxOutputChars,
      },
      signal,
    );
  }
}

export class DockerSandboxExecutor implements SandboxExecutor {
  private readonly containerName: string;
  private readonly hostWorkspaceRoot: string;
  private readonly containerWorkspaceRoot: string;
  private readonly dockerPath: string;

  constructor(options: {
    readonly containerName: string;
    readonly hostWorkspaceRoot: string;
    readonly containerWorkspaceRoot: string;
    readonly dockerPath?: string;
  }) {
    if (options.containerName.trim().length === 0) {
      throw sandboxError("invalid_input", "docker containerName must not be empty");
    }

    if (!options.containerWorkspaceRoot.startsWith("/")) {
      throw sandboxError(
        "invalid_input",
        "docker containerWorkspaceRoot must be an absolute path",
      );
    }

    this.containerName = options.containerName;
    this.hostWorkspaceRoot = resolve(options.hostWorkspaceRoot);
    this.containerWorkspaceRoot = normalizeContainerRoot(
      options.containerWorkspaceRoot,
    );
    this.dockerPath = options.dockerPath ?? "docker";
  }

  execute(
    request: SandboxCommandRequest,
    signal?: AbortSignal,
  ): Promise<SandboxCommandOutput> {
    const normalized = normalizeSandboxRequest(request);
    const containerCwd = this.toContainerPath(normalized.cwd);

    return runProcess(
      {
        command: this.dockerPath,
        args: [
          "exec",
          "-w",
          containerCwd,
          this.containerName,
          "sh",
          "-lc",
          normalized.command,
        ],
        cwd: normalized.workspaceRoot,
        shell: false,
        timeoutMs: normalized.timeoutMs,
        maxOutputChars: normalized.maxOutputChars,
      },
      signal,
    );
  }

  assertWorkspaceAccess(workspaceRoot: string): void {
    this.toContainerPath(workspaceRoot);
  }

  private toContainerPath(hostPath: string): string {
    const relativePath = relative(this.hostWorkspaceRoot, resolve(hostPath));
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw sandboxError(
        "permission_denied",
        `Path is outside docker workspace mapping: ${hostPath}`,
      );
    }

    if (relativePath.length === 0) {
      return this.containerWorkspaceRoot;
    }

    const containerRelativePath = relativePath.split(sep).join("/");
    if (this.containerWorkspaceRoot === "/") {
      return `/${containerRelativePath}`;
    }

    return `${this.containerWorkspaceRoot}/${containerRelativePath}`;
  }
}

export class LinuxNativeSandboxExecutor implements SandboxExecutor {
  private readonly launcherPath: string;
  private readonly maxProcesses: number;
  private readonly maxOpenFiles: number;
  private readonly maxFileSizeBytes: number;
  private readonly maxMemoryBytes: number;

  constructor(options: {
    readonly launcherPath?: string;
    readonly maxProcesses?: number;
    readonly maxOpenFiles?: number;
    readonly maxFileSizeBytes?: number;
    readonly maxMemoryBytes?: number;
  } = {}) {
    if (process.platform !== "linux") {
      throw sandboxError(
        "permission_denied",
        "linux-native sandbox executor is only available on Linux",
      );
    }

    this.launcherPath = resolve(
      options.launcherPath ??
        join(__dirname, "..", "..", "native", "bin", "pibot-linux-sandbox"),
    );
    this.maxProcesses = positiveInteger(options.maxProcesses, 256, "maxProcesses");
    this.maxOpenFiles = positiveInteger(options.maxOpenFiles, 256, "maxOpenFiles");
    this.maxFileSizeBytes = positiveInteger(
      options.maxFileSizeBytes,
      64_000_000,
      "maxFileSizeBytes",
    );
    this.maxMemoryBytes = positiveInteger(
      options.maxMemoryBytes,
      17_179_869_184,
      "maxMemoryBytes",
    );
  }

  assertWorkspaceAccess(): void {}

  async execute(
    request: SandboxCommandRequest,
    signal?: AbortSignal,
  ): Promise<SandboxCommandOutput> {
    const normalized = normalizeSandboxRequest(request);
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "pibot-linux-sandbox-"),
    );

    try {
      return await runProcess(
        {
          command: this.launcherPath,
          args: [
            "--workspace",
            normalized.workspaceRoot,
            "--cwd",
            normalized.cwd,
            "--tmp",
            temporaryDirectory,
            "--cpu-seconds",
            `${Math.ceil(normalized.timeoutMs / 1000) + 1}`,
            "--max-processes",
            `${this.maxProcesses}`,
            "--max-open-files",
            `${this.maxOpenFiles}`,
            "--max-file-size-bytes",
            `${this.maxFileSizeBytes}`,
            "--max-memory-bytes",
            `${this.maxMemoryBytes}`,
            "--",
            "/bin/sh",
            "-lc",
            normalized.command,
          ],
          cwd: normalized.workspaceRoot,
          shell: false,
          timeoutMs: normalized.timeoutMs,
          maxOutputChars: normalized.maxOutputChars,
          env: {
            PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          },
        },
        signal,
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

export function createSandboxExecutor(
  config?: SandboxExecutorConfig,
): SandboxExecutor {
  if (config === undefined || config.kind === "disabled") {
    return new DisabledSandboxExecutor();
  }

  if (config.kind === "host") {
    return new HostSandboxExecutor({
      enabled: config.enabled === true,
      ...(config.shell !== undefined ? { shell: config.shell } : {}),
    });
  }

  if (config.kind === "docker") {
    return new DockerSandboxExecutor(config);
  }

  return new LinuxNativeSandboxExecutor(config);
}

interface NormalizedSandboxRequest {
  readonly command: string;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
}

interface ProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly shell: boolean | string;
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
  readonly env?: NodeJS.ProcessEnv;
}

function normalizeSandboxRequest(
  request: SandboxCommandRequest,
): NormalizedSandboxRequest {
  if (request.command.trim().length === 0) {
    throw sandboxError("invalid_input", "bash.command must not be empty");
  }

  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1) {
    throw sandboxError("invalid_input", "bash.timeoutMs must be a positive integer");
  }

  if (!Number.isInteger(request.maxOutputChars) || request.maxOutputChars < 1) {
    throw sandboxError(
      "invalid_input",
      "bash.maxOutputChars must be a positive integer",
    );
  }

  const workspaceRoot = resolve(request.workspaceRoot);
  const cwd = isAbsolute(request.cwd)
    ? resolve(request.cwd)
    : resolve(workspaceRoot, request.cwd);
  const pathFromRoot = relative(workspaceRoot, cwd);

  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw sandboxError("permission_denied", `cwd is outside workspace: ${request.cwd}`);
  }

  return {
    command: request.command,
    workspaceRoot,
    cwd,
    timeoutMs: request.timeoutMs,
    maxOutputChars: request.maxOutputChars,
  };
}

function runProcess(
  request: ProcessRequest,
  signal: AbortSignal | undefined,
): Promise<SandboxCommandOutput> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(request.command, request.args, createSpawnOptions(request));
    const stdout = createLimitedBuffer(request.maxOutputChars);
    const stderr = createLimitedBuffer(request.maxOutputChars);
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let forcedTermination: NodeJS.Timeout | undefined;

    const timeout = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, request.timeoutMs);

    const abort = () => {
      aborted = true;
      requestTermination();
    };

    const requestTermination = () => {
      terminateChild(child, "SIGTERM");
      if (forcedTermination !== undefined) {
        return;
      }

      forcedTermination = setTimeout(() => {
        terminateChild(child, "SIGKILL");
      }, 1000);
      forcedTermination.unref();
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
      clearTimeout(forcedTermination);
      signal?.removeEventListener("abort", abort);
      if (!settled) {
        settled = true;
        rejectPromise(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      clearTimeout(forcedTermination);
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

function createSpawnOptions(request: ProcessRequest): SpawnOptions {
  return {
    cwd: request.cwd,
    detached: process.platform !== "win32",
    shell: request.shell,
    windowsHide: true,
    ...(request.env === undefined ? {} : { env: request.env }),
  };
}

function terminateChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    child.kill(signal);
    return;
  }

  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch (_error: unknown) {
    child.kill(signal);
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

function normalizeContainerRoot(containerWorkspaceRoot: string): string {
  if (containerWorkspaceRoot === "/") {
    return "/";
  }

  return containerWorkspaceRoot.replace(/\/+$/u, "");
}

function sandboxError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function positiveInteger(
  value: number | undefined,
  defaultValue: number,
  label: string,
): number {
  const resolved = value ?? defaultValue;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw sandboxError("invalid_input", `${label} must be a positive integer`);
  }

  return resolved;
}
