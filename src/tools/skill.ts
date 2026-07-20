import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import type { WorkspacePath } from "../core/ids";
import type {
  FileMutationOutput,
  ReadSkillToolInput,
  ReadSkillToolOutput,
  ToolError,
  WriteSkillToolInput,
} from "../core/tools";
import { assertFileSize } from "../workspace/path-boundary";
import {
  validateSkillMarkdown,
  type WorkspaceSkill,
} from "../workspace/skills";
import type { CodingToolDefinition, ToolRunContext } from "./index";
import {
  parseReadSkillInput,
  parseWriteSkillInput,
} from "./parsers";

const defaultLineLimit = 200;
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const allowedSkillResourceRoots = new Set(["agents", "assets", "references", "scripts"]);

export const readSkillTool: CodingToolDefinition<
  "read_skill",
  ReadSkillToolInput,
  ReadSkillToolOutput
> = {
  name: "read_skill",
  riskLevel: "read-only",
  executionMode: "parallel",
  parse: parseReadSkillInput,
  description:
    "Read a SKILL.md file or relative resource from a pibot-indexed Skill. Use the location shown in the available skills list.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      location: {
        type: "string",
        description: "Exact Skill location from the available skills list.",
      },
      path: {
        type: "string",
        description:
          "Optional file path relative to the Skill directory. Defaults to SKILL.md.",
      },
      offset: {
        type: "integer",
        minimum: 0,
        description: "Zero-based line offset. Defaults to 0.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        description: "Maximum number of lines to read. Defaults to 200.",
      },
      startLine: {
        type: "integer",
        minimum: 1,
        description: "One-based start line.",
      },
      endLine: {
        type: "integer",
        minimum: 1,
        description: "One-based end line.",
      },
    },
    required: ["location"],
  },
  async execute(input, context) {
    const skill = findAvailableSkill(context.skills, input.location);
    const resolved = await resolveSkillReadTarget(skill, input.path);
    await assertFileSize(resolved.filePath, context.maxFileBytes, "read skill file");
    const content = await readFile(resolved.filePath, "utf8");
    const lines = splitLines(content);
    const offset = normalizeOffset(input);
    const limit = normalizeLimit(input);
    const selected = lines.slice(offset, offset + limit);
    const selectedText = selected.join("\n");
    const truncatedContent = truncateText(selectedText, context.maxReadChars);
    const endLine = selected.length === 0 ? offset : offset + selected.length;

    return {
      location: skill.location,
      path: resolved.displayPath,
      content: truncatedContent.text,
      startLine: selected.length === 0 ? offset + 1 : offset + 1,
      endLine,
      totalLines: lines.length,
      truncated:
        truncatedContent.truncated || offset + selected.length < lines.length,
      sha256: sha256(content),
    };
  },
};

export const writeSkillTool: CodingToolDefinition<
  "write_skill",
  WriteSkillToolInput,
  FileMutationOutput
> = {
  name: "write_skill",
  riskLevel: "external",
  executionMode: "sequential",
  parse: parseWriteSkillInput,
  description:
    "Create or update a pibot-wide Skill package under .pibot/skills. Requires an explicit Skill name and writes only inside that Skill directory.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: {
        type: "string",
        description:
          "Skill directory name. Use lowercase letters, digits, and single hyphens.",
      },
      path: {
        type: "string",
        description:
          "Optional path inside the Skill directory. Defaults to SKILL.md; resources may live under agents/, assets/, references/, or scripts/.",
      },
      content: {
        type: "string",
        description: "UTF-8 file content to write.",
      },
      overwrite: {
        type: "boolean",
        description: "Whether to replace an existing file. Defaults to false.",
      },
    },
    required: ["name", "content"],
  },
  async execute(input, context) {
    const root = context.pibotSkillsRoot;
    if (root === undefined) {
      throw toolError(
        "permission_denied",
        "write_skill is unavailable because no pibot Skills root is configured",
      );
    }
    const skillName = normalizeSkillName(input.name);
    const relativePath = normalizeSkillPackagePath(input.path ?? "SKILL.md");
    const displayPath = path.posix.join(".pibot/skills", skillName, relativePath);
    if (relativePath === "SKILL.md") {
      assertValidSkillMarkdown(input.content, skillName, displayPath);
    }

    const rootPath = path.resolve(root);
    await ensureDirectory(rootPath, "pibot Skills root");
    const skillDir = path.join(rootPath, skillName);
    await ensureDirectory(skillDir, "Skill directory");
    const filePath = path.join(skillDir, ...relativePath.split("/"));
    assertInsideDirectory(skillDir, filePath, input.path ?? "SKILL.md");
    await ensureDirectoryPath(skillDir, path.dirname(filePath));

    const existingStat = await lstatIfExists(filePath);
    if (existingStat !== undefined) {
      if (!existingStat.isFile() || existingStat.isSymbolicLink()) {
        throw toolError(
          "invalid_input",
          `Skill target must be a regular file: ${displayPath}`,
        );
      }
      if (!input.overwrite) {
        throw toolError(
          "conflict",
          `Skill file already exists. Set overwrite=true to replace it: ${displayPath}`,
        );
      }
    }

    const beforeContent = existingStat === undefined
      ? undefined
      : await readFile(filePath, "utf8");
    await writeFile(filePath, input.content, {
      encoding: "utf8",
      flag: input.overwrite ? "w" : "wx",
    });

    return {
      path: displayPath as WorkspacePath,
      ...(beforeContent === undefined
        ? {}
        : { beforeSha256: sha256(beforeContent) }),
      afterSha256: sha256(input.content),
      summary: mutationSummary(beforeContent, input.content),
    };
  },
};

function findAvailableSkill(
  skills: readonly WorkspaceSkill[] | undefined,
  location: string,
): WorkspaceSkill {
  const skill = skills?.find((entry) => entry.location === location);
  if (skill?.filePath === undefined) {
    throw toolError(
      "not_found",
      `Skill is not available in this run: ${location}`,
    );
  }
  return skill;
}

async function resolveSkillReadTarget(
  skill: WorkspaceSkill,
  requestedPath: string | undefined,
): Promise<{
  readonly filePath: string;
  readonly displayPath: string;
}> {
  if (skill.filePath === undefined) {
    throw toolError("not_found", `Skill has no readable file: ${skill.location}`);
  }
  const skillDir = path.dirname(skill.filePath);
  await assertDirectoryNotSymlink(skillDir, "Skill directory");
  if (requestedPath === undefined || requestedPath === "SKILL.md") {
    await assertRegularFileNotSymlink(skill.filePath, skill.location);
    return {
      filePath: skill.filePath,
      displayPath: skill.location,
    };
  }

  const relativePath = normalizeSkillPackagePath(requestedPath);
  const filePath = path.join(skillDir, ...relativePath.split("/"));
  assertInsideDirectory(skillDir, filePath, requestedPath);
  await assertNoSymlinkAncestors(skillDir, path.dirname(filePath));
  await assertRegularFileNotSymlink(
    filePath,
    path.posix.join(path.posix.dirname(skill.location), relativePath),
  );
  return {
    filePath,
    displayPath: path.posix.join(path.posix.dirname(skill.location), relativePath),
  };
}

function normalizeSkillName(name: string): string {
  if (!skillNamePattern.test(name)) {
    throw toolError(
      "invalid_input",
      "write_skill.name must use lowercase letters, digits, and single hyphens",
    );
  }
  return name;
}

function normalizeSkillPackagePath(requestedPath: string): string {
  if (requestedPath.length === 0 || requestedPath.includes("\\")) {
    throw toolError("invalid_input", "Skill resource path must be a relative POSIX path");
  }
  const normalized = path.posix.normalize(requestedPath);
  if (
    normalized === "." ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw toolError("invalid_input", `Skill resource path escapes the Skill directory: ${requestedPath}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw toolError("invalid_input", `Invalid Skill resource path: ${requestedPath}`);
  }
  if (normalized === "SKILL.md") {
    return normalized;
  }
  if (!allowedSkillResourceRoots.has(segments[0] ?? "")) {
    throw toolError(
      "invalid_input",
      "Skill resources must be SKILL.md or live under agents/, assets/, references/, or scripts/",
    );
  }
  return normalized;
}

function assertValidSkillMarkdown(
  content: string,
  skillName: string,
  location: string,
): void {
  const validation = validateSkillMarkdown(content, skillName, location);
  if (!validation.ok) {
    throw toolError("invalid_input", validation.issue.message);
  }
  if (validation.issues.length > 0) {
    throw toolError(
      "invalid_input",
      validation.issues.map((issue) => issue.message).join("; "),
    );
  }
}

async function ensureDirectory(filePath: string, label: string): Promise<void> {
  const existing = await lstatIfExists(filePath);
  if (existing !== undefined) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw toolError("invalid_input", `${label} must be a regular directory`);
    }
    return;
  }
  await mkdir(filePath, { recursive: true });
  await assertDirectoryNotSymlink(filePath, label);
}

async function ensureDirectoryPath(baseDir: string, targetDir: string): Promise<void> {
  assertInsideDirectory(baseDir, targetDir, path.relative(baseDir, targetDir));
  const relative = path.relative(baseDir, targetDir);
  const segments = relative.length === 0 ? [] : relative.split(path.sep);
  let current = baseDir;
  for (const segment of segments) {
    current = path.join(current, segment);
    const existing = await lstatIfExists(current);
    if (existing === undefined) {
      await mkdir(current);
      continue;
    }
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw toolError(
        "invalid_input",
        `Skill resource parent must be a regular directory: ${segment}`,
      );
    }
  }
}

async function assertNoSymlinkAncestors(
  baseDir: string,
  targetDir: string,
): Promise<void> {
  assertInsideDirectory(baseDir, targetDir, path.relative(baseDir, targetDir));
  const relative = path.relative(baseDir, targetDir);
  const segments = relative.length === 0 ? [] : relative.split(path.sep);
  let current = baseDir;
  for (const segment of segments) {
    current = path.join(current, segment);
    await assertDirectoryNotSymlink(current, "Skill resource parent");
  }
}

async function assertDirectoryNotSymlink(filePath: string, label: string): Promise<void> {
  const stat = await lstatIfExists(filePath);
  if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw toolError("invalid_input", `${label} must be a regular directory`);
  }
}

async function assertRegularFileNotSymlink(
  filePath: string,
  displayPath: string,
): Promise<void> {
  const stat = await lstatIfExists(filePath);
  if (stat === undefined) {
    throw toolError("not_found", `Skill file does not exist: ${displayPath}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw toolError("invalid_input", `Skill file must be a regular file: ${displayPath}`);
  }
}

function assertInsideDirectory(
  baseDir: string,
  candidate: string,
  requestedPath: string,
): void {
  const relative = path.relative(path.resolve(baseDir), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw toolError(
      "permission_denied",
      `Skill path is outside the Skill directory: ${requestedPath}`,
    );
  }
}

async function lstatIfExists(
  filePath: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(filePath);
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function normalizeOffset(input: ReadSkillToolInput): number {
  if (input.offset !== undefined) {
    return assertNonNegativeInteger(input.offset, "read_skill.offset");
  }
  if (input.startLine !== undefined) {
    return Math.max(
      0,
      assertNonNegativeInteger(input.startLine, "read_skill.startLine") - 1,
    );
  }
  return 0;
}

function normalizeLimit(input: ReadSkillToolInput): number {
  if (input.limit !== undefined) {
    return assertPositiveInteger(input.limit, "read_skill.limit");
  }
  if (input.startLine !== undefined && input.endLine !== undefined) {
    const startLine = assertNonNegativeInteger(
      input.startLine,
      "read_skill.startLine",
    );
    const endLine = assertNonNegativeInteger(input.endLine, "read_skill.endLine");
    return Math.max(1, endLine - startLine + 1);
  }
  return defaultLineLimit;
}

function splitLines(content: string): readonly string[] {
  if (content.length === 0) {
    return [];
  }
  return content.replace(/\r\n/gu, "\n").split("\n");
}

function truncateText(
  text: string,
  maxChars: number,
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= maxChars) {
    return {
      text,
      truncated: false,
    };
  }
  return {
    text: `${text.slice(0, maxChars)}\n[truncated]`,
    truncated: true,
  };
}

function mutationSummary(
  beforeContent: string | undefined,
  afterContent: string,
): FileMutationOutput["summary"] {
  const beforeLines = beforeContent === undefined ? [] : splitLines(beforeContent);
  const afterLines = splitLines(afterContent);
  return {
    changed: beforeContent !== afterContent,
    ...(beforeContent === undefined ? {} : { beforeBytes: Buffer.byteLength(beforeContent) }),
    afterBytes: Buffer.byteLength(afterContent),
    addedLines: Math.max(0, afterLines.length - beforeLines.length),
    removedLines: Math.max(0, beforeLines.length - afterLines.length),
    description:
      beforeContent === undefined
        ? "created pibot-wide Skill file"
        : "updated pibot-wide Skill file",
  };
}

function assertNonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw toolError("invalid_input", `${name} must be a non-negative integer`);
  }
  return value;
}

function assertPositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw toolError("invalid_input", `${name} must be a positive integer`);
  }
  return value;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function toolError(code: ToolError["code"], message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}
