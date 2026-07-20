import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { WorkspacePath } from "../core/ids";
import type { GrepMatch, GrepToolInput, GrepToolOutput, ToolError } from "../core/tools";
import {
  isProtectedWorkspacePath,
  resolveWorkspacePath,
} from "../workspace/path-boundary";
import type { CodingToolDefinition, ToolRunContext } from "./index";
import { parseGrepInput } from "./parsers";

type UnknownRecord = Readonly<Record<string, unknown>>;

export const grepTool: CodingToolDefinition<"grep", GrepToolInput, GrepToolOutput> = {
  name: "grep",
  riskLevel: "read-only",
  executionMode: "parallel",
  parse: parseGrepInput,
  description:
    "Search workspace text files for a regex pattern. Uses rg when available and falls back to a Node search.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pattern: {
        type: "string",
        description: "Regex pattern to search for.",
      },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Files or directories inside the workspace. Defaults to workspace root.",
      },
      caseSensitive: {
        type: "boolean",
        description: "Whether matching is case-sensitive. Defaults to false.",
      },
      includeGlobs: {
        type: "array",
        items: { type: "string" },
        description: "rg include globs.",
      },
      excludeGlobs: {
        type: "array",
        items: { type: "string" },
        description: "rg exclude globs.",
      },
    },
    required: ["pattern"],
  },
  async execute(input, context, signal) {
    const paths = await resolveSearchPaths(context.workspaceRoot, input.paths);
    const rgResult = await tryRunRg(input, paths, context, signal);
    if (rgResult !== null) {
      return rgResult;
    }

    return nodeSearch(input, paths, context);
  },
};

function tryRunRg(
  input: GrepToolInput,
  paths: readonly string[],
  context: ToolRunContext,
  signal: AbortSignal | undefined,
): Promise<GrepToolOutput | null> {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = [
      "--json",
      "--line-number",
      "--color",
      "never",
      "--max-filesize",
      `${context.maxFileBytes}`,
      ...(input.caseSensitive ? [] : ["--ignore-case"]),
      ...input.includeGlobs.flatMap((glob) => ["--glob", glob]),
      ...input.excludeGlobs.flatMap((glob) => ["--glob", `!${glob}`]),
      "--glob",
      "!.git/**",
      "--glob",
      "!.pibot/**",
      "--glob",
      "!.env",
      "--glob",
      "!.env.*",
      "--glob",
      "!.npmrc",
      "--glob",
      "!.netrc",
      "--glob",
      "!.gitconfig",
      "--glob",
      "!.pibotignore",
      "--glob",
      "!repo.json",
      "--glob",
      "!log.jsonl",
      "--glob",
      "!context.jsonl",
      "--glob",
      "!instructions.md",
      "--glob",
      "!MEMORY.md",
      "--glob",
      "!trace.jsonl",
      "--glob",
      "!usage.jsonl",
      input.pattern,
      ...paths,
    ];
    const child = spawn("rg", args, {
      cwd: resolve(context.workspaceRoot),
      windowsHide: true,
    });
    const matches: GrepMatch[] = [];
    let buffer = "";
    let stderr = "";
    let outputChars = 0;
    let truncated = false;
    let settled = false;

    const abort = () => {
      child.kill("SIGTERM");
    };

    if (signal?.aborted === true) {
      abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      outputChars += chunk.length;
      if (outputChars > context.maxGrepOutputChars) {
        truncated = true;
        child.kill("SIGTERM");
        return;
      }

      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const match = parseRgJsonLine(line, context.workspaceRoot);
        if (match !== null) {
          matches.push(match);
          if (matches.length >= context.maxGrepMatches) {
            truncated = true;
            child.kill("SIGTERM");
            return;
          }
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      signal?.removeEventListener("abort", abort);
      if (settled) {
        return;
      }

      settled = true;
      if (error.code === "ENOENT") {
        resolvePromise(null);
        return;
      }

      rejectPromise(error);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (settled) {
        return;
      }

      settled = true;
      if (buffer.length > 0) {
        const match = parseRgJsonLine(buffer, context.workspaceRoot);
        if (match !== null) {
          matches.push(match);
        }
      }

      if (code !== 0 && code !== 1 && !truncated) {
        rejectPromise(toolError("execution_failed", stderr.trim() || "rg failed"));
        return;
      }

      resolvePromise({
        matches,
        truncated,
      });
    });
  });
}

function parseRgJsonLine(line: string, workspaceRoot: string): GrepMatch | null {
  if (line.trim().length === 0) {
    return null;
  }

  const parsed = parseJsonObject(line);
  if (parsed === null || readString(parsed, "type") !== "match") {
    return null;
  }

  const data = readRecord(parsed, "data");
  const pathRecord = readRecord(data, "path");
  const linesRecord = readRecord(data, "lines");
  const absolutePath = readString(pathRecord, "text");
  const text = readString(linesRecord, "text");
  const lineNumber = readNumber(data, "line_number");

  if (absolutePath === undefined || text === undefined || lineNumber === undefined) {
    return null;
  }

  const relativePath = toWorkspacePath(workspaceRoot, absolutePath);
  if (isProtectedWorkspacePath(relativePath)) {
    return null;
  }

  return {
    path: relativePath,
    line: lineNumber,
    text: text.replace(/\r?\n$/u, ""),
  };
}

async function nodeSearch(
  input: GrepToolInput,
  paths: readonly string[],
  context: ToolRunContext,
): Promise<GrepToolOutput> {
  const regex = compileRegex(input.pattern, input.caseSensitive);
  const matches: GrepMatch[] = [];
  let truncated = false;

  for (const searchPath of paths) {
    for await (const filePath of walkFiles(searchPath)) {
      const fileStat = await stat(filePath).catch(() => undefined);
      if (fileStat === undefined || fileStat.size > context.maxFileBytes) {
        continue;
      }
      const content = await readFile(filePath, "utf8").catch(() => undefined);
      if (content === undefined) {
        continue;
      }

      const lines = content.replace(/\r\n/gu, "\n").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (regex.test(lines[index] ?? "")) {
          matches.push({
            path: toWorkspacePath(context.workspaceRoot, filePath),
            line: index + 1,
            text: lines[index] ?? "",
          });
        }

        regex.lastIndex = 0;
        if (matches.length >= context.maxGrepMatches) {
          truncated = true;
          return { matches, truncated };
        }
      }
    }
  }

  return {
    matches,
    truncated,
  };
}

async function* walkFiles(root: string): AsyncIterable<string> {
  const rootStat = await stat(root);
  if (rootStat.isFile()) {
    yield root;
    return;
  }

  if (!rootStat.isDirectory()) {
    return;
  }

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (
      isProtectedWorkspacePath(entry.name) ||
      entry.name === ".git" ||
      entry.name === ".pibot" ||
      entry.name === "node_modules" ||
      entry.name === "dist"
    ) {
      continue;
    }

    const child = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(child);
    } else if (entry.isFile()) {
      yield child;
    }
  }
}

async function resolveSearchPaths(
  root: string,
  requestedPaths: readonly WorkspacePath[],
): Promise<readonly string[]> {
  if (requestedPaths.length === 0) {
    return [resolve(root)];
  }

  return Promise.all(
    requestedPaths.map((requestedPath) =>
      resolveWorkspacePath(root, requestedPath, {
        access: "search",
        allowWorkspaceRoot: true,
      }),
    ),
  );
}

function compileRegex(pattern: string, caseSensitive: boolean): RegExp {
  try {
    return new RegExp(pattern, caseSensitive ? "u" : "iu");
  } catch (_error: unknown) {
    throw toolError("invalid_input", `Invalid grep pattern: ${pattern}`);
  }
}

function toWorkspacePath(root: string, path: string): WorkspacePath {
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(root, path);
  return relative(resolve(root), absolutePath) as WorkspacePath;
}

function parseJsonObject(value: string): UnknownRecord | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch (_error: unknown) {
    return null;
  }
}

function readRecord(
  record: UnknownRecord | undefined,
  key: string,
): UnknownRecord | undefined {
  if (record === undefined) {
    return undefined;
  }

  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function readString(
  record: UnknownRecord | undefined,
  key: string,
): string | undefined {
  if (record === undefined) {
    return undefined;
  }

  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(
  record: UnknownRecord | undefined,
  key: string,
): number | undefined {
  if (record === undefined) {
    return undefined;
  }

  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function toolError(code: ToolError["code"], message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}
