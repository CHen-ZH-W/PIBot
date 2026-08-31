import { lstat, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import {
  defaultSandboxPolicy,
  isSandboxProtectedName,
  type SandboxPolicy,
} from "./sandbox-policy";

export type WorkspacePathAccess = "read" | "mutate" | "search" | "cwd";

export interface ResolveWorkspacePathOptions {
  readonly access: WorkspacePathAccess;
  readonly allowMissing?: boolean;
  readonly allowWorkspaceRoot?: boolean;
  readonly policy?: SandboxPolicy;
}

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

  if (isProtectedWorkspacePath(relativePath, options.policy)) {
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

export function isProtectedWorkspacePath(
  relativePath: string,
  policy: SandboxPolicy = defaultSandboxPolicy,
): boolean {
  const segments = relativePath.split(/[\\/]+/u).filter((segment) => segment.length > 0);
  return segments.some((segment) => isSandboxProtectedName(segment, policy));
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
