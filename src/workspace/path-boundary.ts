import { lstat, realpath, stat } from "node:fs/promises";
import * as path from "node:path";

export type WorkspacePathAccess = "read" | "mutate" | "search" | "cwd";

export interface ResolveWorkspacePathOptions {
  readonly access: WorkspacePathAccess;
  readonly allowMissing?: boolean;
  readonly allowWorkspaceRoot?: boolean;
}

const protectedDirectoryNames = new Set([
  ".git",
  ".pibot",
  ".pibot-evolution-workspaces",
]);
const protectedFileNames = new Set([
  ".gitconfig",
  ".netrc",
  ".npmrc",
  ".pibotignore",
  "instructions.md",
  "context.jsonl",
  "log.jsonl",
  "MEMORY.md",
  "repo.json",
  "runtime-state.json",
  "trace.jsonl",
  "usage.jsonl",
]);

/**
 * Resolves an agent-controlled path while rejecting workspace escapes,
 * protected runtime files and symbolic-link traversal.
 */
export async function resolveWorkspacePath(
  root: string,
  requestedPath: string,
  options: ResolveWorkspacePathOptions,
): Promise<string> {
  const workspaceRoot = path.resolve(root);
  const target = path.resolve(workspaceRoot, requestedPath);
  assertInside(workspaceRoot, target, `Path is outside workspace: ${requestedPath}`);

  const relativePath = path.relative(workspaceRoot, target);
  if (relativePath.length === 0 && options.allowWorkspaceRoot !== true) {
    throw boundaryError("permission_denied", "Workspace root cannot be used as a file path");
  }

  if (isProtectedWorkspacePath(relativePath)) {
    throw boundaryError("permission_denied", `Path is protected: ${requestedPath}`);
  }

  const workspaceRealPath = await realpath(workspaceRoot);
  let currentPath = workspaceRoot;
  const segments = relativePath.length === 0 ? [] : relativePath.split(path.sep);
  for (let index = 0; index < segments.length; index += 1) {
    currentPath = path.join(currentPath, segments[index] ?? "");
    const fileStat = await lstat(currentPath).catch((error: unknown) => {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        return undefined;
      }

      throw error;
    });
    if (fileStat === undefined) {
      if (options.allowMissing === true) {
        return target;
      }

      throw boundaryError("not_found", `Path does not exist: ${requestedPath}`);
    }

    if (fileStat.isSymbolicLink()) {
      throw boundaryError(
        "permission_denied",
        `Symbolic links are not allowed in workspace paths: ${requestedPath}`,
      );
    }
  }

  const targetRealPath = await realpath(target);
  assertInside(
    workspaceRealPath,
    targetRealPath,
    `Resolved path is outside workspace: ${requestedPath}`,
  );
  return target;
}

export function isProtectedWorkspacePath(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]+/u).filter((segment) => segment.length > 0);
  if (segments.some((segment) => protectedDirectoryNames.has(segment))) {
    return true;
  }

  return segments.some((segment) => isProtectedFileName(segment));
}

export async function assertFileSize(
  filePath: string,
  maxBytes: number,
  label: string,
): Promise<void> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw boundaryError("invalid_input", `Path is not a file: ${filePath}`);
  }

  if (fileStat.size > maxBytes) {
    throw boundaryError(
      "invalid_input",
      `${label} exceeds maximum size of ${maxBytes} bytes`,
    );
  }
}

export function assertContentSize(
  content: string,
  maxBytes: number,
  label: string,
): void {
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    throw boundaryError(
      "invalid_input",
      `${label} exceeds maximum size of ${maxBytes} bytes`,
    );
  }
}

export function assertInside(root: string, target: string, message: string): void {
  const relativePath = path.relative(path.resolve(root), path.resolve(target));
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw boundaryError("permission_denied", message);
  }
}

export function boundaryError(code: string, message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function isProtectedFileName(fileName: string): boolean {
  if (protectedFileNames.has(fileName) || fileName === ".env") {
    return true;
  }

  return fileName.startsWith(".env.") && fileName !== ".env.example";
}
