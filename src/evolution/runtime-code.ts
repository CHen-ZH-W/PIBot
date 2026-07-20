import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Script } from "node:vm";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import * as path from "node:path";

export interface RuntimeCodeStagingWorkspace {
  readonly root: string;
  readonly baseline: RuntimeCodeWorkspaceSnapshot;
}

export interface RuntimeCodeWorkspaceSnapshot {
  readonly files: readonly RuntimeCodeFileSnapshot[];
}

export interface RuntimeCodeFileSnapshot {
  readonly path: string;
  readonly sha256: string;
}

export interface RuntimeCodeValidationReport {
  readonly status: "passed" | "failed";
  readonly checks: readonly RuntimeCodeValidationCheck[];
}

export interface RuntimeCodeValidationCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly message: string;
}

export interface RuntimeCodePublishReport {
  readonly changedFiles: readonly string[];
  readonly deletedFiles: readonly string[];
  readonly conflicts: readonly string[];
}

export interface RuntimeCodeVersionArchiveReport {
  readonly snapshot: RuntimeCodeWorkspaceSnapshot;
}

const stagingDirectoryName = ".pibot-evolution-workspaces";
const allowedTopLevelEntries = new Set([
  ".env.example",
  ".github",
  ".gitignore",
  "Dockerfile.sandbox",
  "README.md",
  "dist",
  "docker-compose.sandbox.yml",
  "docs",
  "native",
  "package-lock.json",
  "package.json",
  "scripts",
  "src",
  "tsconfig.json",
]);

export async function createRuntimeCodeStagingWorkspace(input: {
  readonly sourceRoot: string;
  readonly ticketId: string;
  readonly runId: string;
}): Promise<RuntimeCodeStagingWorkspace> {
  const sourceRoot = path.resolve(input.sourceRoot);
  const parent = path.join(sourceRoot, stagingDirectoryName);
  await mkdir(parent, { recursive: true });
  const runRoot = await makeUniqueDirectory(parent, [
    sanitizePathPart(input.ticketId),
    sanitizePathPart(input.runId),
  ].join("-"));
  const stagingRoot = path.join(runRoot, "checkout");
  await mkdir(stagingRoot, { recursive: true });

  for (const entry of allowedTopLevelEntries) {
    const source = path.join(sourceRoot, entry);
    const destination = path.join(stagingRoot, entry);
    if (await pathExists(source)) {
      await copyEntry(source, destination);
    }
  }

  const sourceNodeModules = path.join(sourceRoot, "node_modules");
  if (await pathExists(sourceNodeModules)) {
    await symlink(sourceNodeModules, path.join(stagingRoot, "node_modules"), "dir");
  }

  return {
    root: stagingRoot,
    baseline: await snapshotRuntimeCodeWorkspace(stagingRoot),
  };
}

export async function validateRuntimeCodeWorkspace(input: {
  readonly workspaceRoot: string;
  readonly dependencyRoot?: string;
  readonly timeoutMs?: number;
}): Promise<RuntimeCodeValidationReport> {
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const dependencyRoot = path.resolve(input.dependencyRoot ?? workspaceRoot);
  const checks: RuntimeCodeValidationCheck[] = [];

  const typecheck = await runTypeScriptCompiler({
    workspaceRoot,
    dependencyRoot,
    args: ["--noEmit", "--pretty", "false", "-p", "tsconfig.json"],
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  checks.push({
    name: "tsc_no_emit",
    passed: typecheck.exitCode === 0,
    message: commandMessage(typecheck),
  });

  const browserScript = await parseWebUiBrowserScript(workspaceRoot);
  checks.push(browserScript);

  const emit = await runTypeScriptCompiler({
    workspaceRoot,
    dependencyRoot,
    args: ["--pretty", "false", "-p", "tsconfig.json"],
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  checks.push({
    name: "tsc_emit",
    passed: emit.exitCode === 0,
    message: commandMessage(emit),
  });

  return {
    status: checks.every((check) => check.passed) ? "passed" : "failed",
    checks,
  };
}

export async function publishRuntimeCodeWorkspace(input: {
  readonly stagingRoot: string;
  readonly destinationRoot: string;
  readonly baseline: RuntimeCodeWorkspaceSnapshot;
}): Promise<RuntimeCodePublishReport> {
  const stagingRoot = path.resolve(input.stagingRoot);
  const destinationRoot = path.resolve(input.destinationRoot);
  const before = snapshotMap(input.baseline);
  const afterSnapshot = await snapshotRuntimeCodeWorkspace(stagingRoot);
  const after = snapshotMap(afterSnapshot);
  const changes: {
    readonly path: string;
    readonly kind: "write" | "delete";
  }[] = [];
  const conflicts: string[] = [];

  const allPaths = new Set([...before.keys(), ...after.keys()]);
  for (const relativeFilePath of [...allPaths].sort()) {
    if (!isAllowedRuntimeCodePath(relativeFilePath)) {
      continue;
    }

    const beforeHash = before.get(relativeFilePath);
    const afterHash = after.get(relativeFilePath);
    if (beforeHash === afterHash) {
      continue;
    }

    const destinationFile = path.join(destinationRoot, relativeFilePath);
    const destinationHash = await fileHashIfExists(destinationFile);
    if (destinationHash !== beforeHash) {
      conflicts.push(relativeFilePath);
      continue;
    }

    if (afterHash === undefined) {
      changes.push({ path: relativeFilePath, kind: "delete" });
      continue;
    }

    changes.push({ path: relativeFilePath, kind: "write" });
  }

  if (conflicts.length > 0) {
    return {
      changedFiles: [],
      deletedFiles: [],
      conflicts,
    };
  }

  const changedFiles: string[] = [];
  const deletedFiles: string[] = [];
  for (const change of changes) {
    const destinationFile = path.join(destinationRoot, change.path);
    if (change.kind === "delete") {
      await rm(destinationFile, { force: true });
      deletedFiles.push(change.path);
      continue;
    }
    await mkdir(path.dirname(destinationFile), { recursive: true });
    await copyFile(path.join(stagingRoot, change.path), destinationFile);
    changedFiles.push(change.path);
  }

  return {
    changedFiles,
    deletedFiles,
    conflicts,
  };
}

export async function captureRuntimeCodeVersionArchive(input: {
  readonly sourceRoot: string;
  readonly archiveRoot: string;
}): Promise<RuntimeCodeVersionArchiveReport> {
  const sourceRoot = path.resolve(input.sourceRoot);
  const archiveRoot = path.resolve(input.archiveRoot);
  const filesRoot = path.join(archiveRoot, "files");
  await rm(archiveRoot, { recursive: true, force: true });
  await mkdir(filesRoot, { recursive: true });

  for (const entry of allowedTopLevelEntries) {
    const source = path.join(sourceRoot, entry);
    const destination = path.join(filesRoot, entry);
    if (await pathExists(source)) {
      await copyEntry(source, destination);
    }
  }

  return {
    snapshot: await snapshotRuntimeCodeWorkspace(filesRoot),
  };
}

export async function activateRuntimeCodeVersionArchive(input: {
  readonly archiveRoot: string;
  readonly destinationRoot: string;
  readonly currentActiveArchiveRoot?: string;
}): Promise<RuntimeCodePublishReport> {
  const targetRoot = path.join(path.resolve(input.archiveRoot), "files");
  const destinationRoot = path.resolve(input.destinationRoot);
  if (!(await pathExists(targetRoot))) {
    throw new Error(`Runtime version archive is missing: ${targetRoot}`);
  }

  const target = snapshotMap(await snapshotRuntimeCodeWorkspace(targetRoot));
  const destination = snapshotMap(
    await snapshotRuntimeCodeWorkspace(destinationRoot),
  );
  const expected = input.currentActiveArchiveRoot === undefined
    ? destination
    : snapshotMap(
        await snapshotRuntimeCodeWorkspace(
          path.join(path.resolve(input.currentActiveArchiveRoot), "files"),
        ),
      );

  const conflicts: string[] = [];
  const currentPaths = new Set([...expected.keys(), ...destination.keys()]);
  for (const relativeFilePath of [...currentPaths].sort()) {
    if (!isAllowedRuntimeCodePath(relativeFilePath)) {
      continue;
    }
    const destinationHash = destination.get(relativeFilePath);
    if (
      destinationHash !== expected.get(relativeFilePath) &&
      destinationHash !== target.get(relativeFilePath)
    ) {
      conflicts.push(relativeFilePath);
    }
  }

  if (conflicts.length > 0) {
    return {
      changedFiles: [],
      deletedFiles: [],
      conflicts,
    };
  }

  const changedFiles: string[] = [];
  const deletedFiles: string[] = [];
  const allPaths = new Set([...destination.keys(), ...target.keys()]);
  for (const relativeFilePath of [...allPaths].sort()) {
    if (!isAllowedRuntimeCodePath(relativeFilePath)) {
      continue;
    }
    const targetHash = target.get(relativeFilePath);
    if (destination.get(relativeFilePath) === targetHash) {
      continue;
    }

    const destinationFile = path.join(destinationRoot, relativeFilePath);
    if (targetHash === undefined) {
      await rm(destinationFile, { force: true });
      deletedFiles.push(relativeFilePath);
      continue;
    }

    await mkdir(path.dirname(destinationFile), { recursive: true });
    await copyFile(path.join(targetRoot, relativeFilePath), destinationFile);
    changedFiles.push(relativeFilePath);
  }

  return {
    changedFiles,
    deletedFiles,
    conflicts: [],
  };
}

async function snapshotRuntimeCodeWorkspace(
  root: string,
): Promise<RuntimeCodeWorkspaceSnapshot> {
  const files: RuntimeCodeFileSnapshot[] = [];
  for (const entry of allowedTopLevelEntries) {
    const entryPath = path.join(root, entry);
    if (!(await pathExists(entryPath))) {
      continue;
    }
    await collectFileSnapshots(root, entryPath, files);
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files };
}

async function collectFileSnapshots(
  root: string,
  currentPath: string,
  files: RuntimeCodeFileSnapshot[],
): Promise<void> {
  const fileStat = await lstat(currentPath);
  if (fileStat.isSymbolicLink()) {
    return;
  }
  if (fileStat.isDirectory()) {
    for (const entry of await readdir(currentPath)) {
      await collectFileSnapshots(root, path.join(currentPath, entry), files);
    }
    return;
  }
  if (!fileStat.isFile()) {
    return;
  }

  const relativeFilePath = normalizeRelativePath(path.relative(root, currentPath));
  if (!isAllowedRuntimeCodePath(relativeFilePath)) {
    return;
  }
  files.push({
    path: relativeFilePath,
    sha256: await hashFile(currentPath),
  });
}

async function copyEntry(source: string, destination: string): Promise<void> {
  const fileStat = await lstat(source);
  if (fileStat.isSymbolicLink()) {
    return;
  }
  if (fileStat.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source)) {
      await copyEntry(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  if (!fileStat.isFile()) {
    return;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function parseWebUiBrowserScript(
  workspaceRoot: string,
): Promise<RuntimeCodeValidationCheck> {
  try {
    const sourcePath = path.join(workspaceRoot, "src", "web", "static.ts");
    const source = await readFile(sourcePath, "utf8");
    const prefix = "export const WEBUI_SCRIPT = `";
    const start = source.indexOf(prefix);
    const end = source.lastIndexOf("`;");
    if (start === -1 || end === -1 || end <= start) {
      return {
        name: "webui_browser_script_parse",
        passed: false,
        message: "WEBUI_SCRIPT template literal was not found.",
      };
    }
    const script = source.slice(start + prefix.length, end);
    new Script(script, { filename: "WEBUI_SCRIPT.js" });
    return {
      name: "webui_browser_script_parse",
      passed: true,
      message: "WEBUI browser script parses.",
    };
  } catch (error: unknown) {
    return {
      name: "webui_browser_script_parse",
      passed: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runTypeScriptCompiler(input: {
  readonly workspaceRoot: string;
  readonly dependencyRoot: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
}): Promise<CommandResult> {
  const tscPath = path.join(
    input.dependencyRoot,
    "node_modules",
    "typescript",
    "bin",
    "tsc",
  );
  if (!(await pathExists(tscPath))) {
    return {
      command: "tsc",
      exitCode: 1,
      stdout: "",
      stderr: `TypeScript compiler not found at ${tscPath}`,
      timedOut: false,
    };
  }
  return runCommand(process.execPath, [tscPath, ...input.args], {
    cwd: input.workspaceRoot,
    timeoutMs: input.timeoutMs ?? 120_000,
  });
}

interface CommandResult {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

function runCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly timeoutMs: number;
  },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV ?? "test",
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on("error", (error: Error) => {
      clearTimeout(timeout);
      resolve({
        command: [command, ...args].join(" "),
        exitCode: 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: error.message,
        timedOut,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        command: [command, ...args].join(" "),
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
      });
    });
  });
}

function commandMessage(result: CommandResult): string {
  if (result.exitCode === 0) {
    return `${shortCommand(result.command)} passed.`;
  }
  const detail = [result.stderr.trim(), result.stdout.trim()]
    .filter((value) => value.length > 0)
    .join("\n")
    .slice(0, 1200);
  return [
    `${shortCommand(result.command)} failed with exit code ${result.exitCode}.`,
    ...(result.timedOut ? ["The command timed out."] : []),
    ...(detail.length === 0 ? [] : [detail]),
  ].join(" ");
}

function shortCommand(command: string): string {
  return command.replace(process.execPath, "node");
}

async function makeUniqueDirectory(parent: string, prefix: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt}`;
    const candidate = path.join(parent, `${prefix}${suffix}`);
    try {
      await mkdir(candidate);
      return candidate;
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "EEXIST")) {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Unable to create staging workspace for ${prefix}`);
}

function snapshotMap(
  snapshot: RuntimeCodeWorkspaceSnapshot,
): Map<string, string> {
  return new Map(snapshot.files.map((file) => [file.path, file.sha256]));
}

function isAllowedRuntimeCodePath(relativeFilePath: string): boolean {
  const normalized = normalizeRelativePath(relativeFilePath);
  if (normalized.length === 0 || normalized.startsWith("../")) {
    return false;
  }
  const [topLevel] = normalized.split("/");
  return topLevel !== undefined && allowedTopLevelEntries.has(topLevel);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function fileHashIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await hashFile(filePath);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function normalizeRelativePath(relativeFilePath: string): string {
  return relativeFilePath.split(path.sep).join("/");
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/gu, "_").slice(0, 80) || "run";
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
