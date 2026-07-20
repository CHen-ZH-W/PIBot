import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

const defaultMaxSkills = 100;
const defaultMaxSkillFileBytes = 64_000;
const pibotSkillsRoot = ".pibot/skills";
const openAiSkillsRoot = ".agents/skills";
const legacySkillsRoot = "skills";
const skillRootRelativePaths = [openAiSkillsRoot, legacySkillsRoot] as const;
const maxSkillNameChars = 64;
const maxSkillDescriptionChars = 1024;
const maxSkillCompatibilityChars = 500;
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type WorkspaceSkillSource = "pibot" | "workspace" | "legacy";

export interface WorkspaceSkill {
  readonly name: string;
  readonly description: string;
  readonly location: string;
  readonly source: WorkspaceSkillSource;
  readonly disableModelInvocation: boolean;
  readonly filePath?: string;
}

export type WorkspaceSkillIssueCode =
  | "invalid_skill_directory"
  | "invalid_skill_file"
  | "invalid_skill_frontmatter"
  | "invalid_skill_name"
  | "invalid_skill_description"
  | "invalid_skill_compatibility"
  | "invalid_skill_body"
  | "duplicate_skill_name"
  | "too_many_skills";

export interface WorkspaceSkillIssue {
  readonly code: WorkspaceSkillIssueCode;
  readonly location: string;
  readonly message: string;
}

export interface WorkspaceSkillScanResult {
  readonly skills: readonly WorkspaceSkill[];
  readonly disabledSkills: readonly string[];
  readonly issues: readonly WorkspaceSkillIssue[];
}

export interface ScanWorkspaceSkillsOptions {
  readonly disabledSkills?: readonly string[];
  readonly maxSkills?: number;
  readonly maxSkillFileBytes?: number;
  readonly pibotSkillsRoot?: string;
}

export interface SkillImportFile {
  readonly path: string;
  readonly content: string;
}

export interface ImportOpenAiSkillPackageOptions {
  readonly pibotSkillsRoot: string;
  readonly files: readonly SkillImportFile[];
  readonly overwrite?: boolean;
  readonly maxSkillFileBytes?: number;
}

export interface ImportOpenAiSkillPackageResult {
  readonly skill: WorkspaceSkill;
  readonly writtenFiles: readonly string[];
}

export type SkillMarkdownValidationResult =
  | {
      readonly ok: true;
      readonly skill: WorkspaceSkill;
      readonly issues: readonly WorkspaceSkillIssue[];
    }
  | {
      readonly ok: false;
      readonly issue: WorkspaceSkillIssue;
    };

/**
 * Scans pibot-wide .pibot/skills/<name>/SKILL.md children first, then
 * OpenAI-aligned workspace .agents/skills/<name>/SKILL.md children, plus the
 * legacy skills/<name>/SKILL.md layout for existing pibot workspaces. Skill
 * bodies stay on disk and are loaded through the controlled read_skill tool
 * only when needed.
 */
export async function scanWorkspaceSkills(
  workspaceRoot: string,
  options: ScanWorkspaceSkillsOptions = {},
): Promise<WorkspaceSkillScanResult> {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const maxSkills = positiveInteger(options.maxSkills, defaultMaxSkills, "maxSkills");
  const maxSkillFileBytes = positiveInteger(
    options.maxSkillFileBytes,
    defaultMaxSkillFileBytes,
    "maxSkillFileBytes",
  );
  const disabledNames = normalizedDisabledNames(options.disabledSkills);
  const disabledSkills: string[] = [];
  const issues: WorkspaceSkillIssue[] = [];
  const skills: WorkspaceSkill[] = [];
  const scanRoots: SkillScanRoot[] = [
    {
      source: "pibot",
      rootPath: path.resolve(
        options.pibotSkillsRoot ?? path.join(resolvedWorkspaceRoot, pibotSkillsRoot),
      ),
      locationRoot: pibotSkillsRoot,
    },
    ...skillRootRelativePaths.map((rootRelativePath): SkillScanRoot => ({
      source: rootRelativePath === legacySkillsRoot ? "legacy" : "workspace",
      rootPath: path.join(resolvedWorkspaceRoot, rootRelativePath),
      locationRoot: rootRelativePath,
    })),
  ];

  for (const scanRoot of scanRoots) {
    const skillsDir = scanRoot.rootPath;
    const skillsDirStat = await lstatIfExists(skillsDir);
    if (skillsDirStat === undefined) {
      continue;
    }
    if (!skillsDirStat.isDirectory() || skillsDirStat.isSymbolicLink()) {
      issues.push({
        code: "invalid_skill_directory",
        location: scanRoot.locationRoot,
        message: `Skills root must be a regular directory: ${scanRoot.locationRoot}`,
      });
      continue;
    }
    const entries = await readdir(skillsDir, { withFileTypes: true });

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const location = skillLocation(scanRoot.locationRoot, entry.name);
      if (!entry.isDirectory()) {
        if (entry.isSymbolicLink()) {
          issues.push({
            code: "invalid_skill_directory",
            location,
            message: `Skill directory must not be a symbolic link: ${location}`,
          });
        }
        continue;
      }

      const skillDir = path.join(skillsDir, entry.name);
      const skillFile = path.join(skillDir, "SKILL.md");
      const fileStat = await lstatIfExists(skillFile);
      if (
        fileStat === undefined ||
        !fileStat.isFile() ||
        fileStat.isSymbolicLink()
      ) {
        issues.push({
          code: "invalid_skill_file",
          location,
          message: `Skill requires a regular SKILL.md file: ${location}`,
        });
        continue;
      }
      if (fileStat.size > maxSkillFileBytes) {
        issues.push({
          code: "invalid_skill_file",
          location,
          message: `Skill file exceeds maximum size of ${maxSkillFileBytes} bytes: ${location}`,
        });
        continue;
      }

      const validation = validateSkillMarkdown(
        await readFile(skillFile, "utf8"),
        entry.name,
        location,
      );
      if (!validation.ok) {
        issues.push(validation.issue);
        continue;
      }
      issues.push(...validation.issues);
      const skill = await applyOpenAiSkillMetadata({
        ...validation.skill,
        source: scanRoot.source,
        filePath: skillFile,
      }, skillDir);
      if (disabledNames.has(skill.name)) {
        disabledSkills.push(skill.name);
        continue;
      }
      if (skills.length >= maxSkills) {
        issues.push({
          code: "too_many_skills",
          location,
          message: `Skill index exceeds maximum count of ${maxSkills}; skipped ${skill.name}`,
        });
        continue;
      }

      skills.push(skill);
    }
  }

  return {
    skills,
    disabledSkills,
    issues,
  };
}

export function validateSkillMarkdown(
  content: string,
  directoryName: string,
  location: string = skillLocation(openAiSkillsRoot, directoryName),
): SkillMarkdownValidationResult {
  const lines = content.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").split("\n");
  if (lines[0] !== "---") {
    return invalidSkill(
      "invalid_skill_frontmatter",
      location,
      "SKILL.md must start with YAML-like frontmatter delimited by ---",
    );
  }

  const frontmatterEnd = lines.indexOf("---", 1);
  if (frontmatterEnd === -1) {
    return invalidSkill(
      "invalid_skill_frontmatter",
      location,
      "SKILL.md frontmatter is missing its closing --- delimiter",
    );
  }

  const parsedFrontmatter = parseSkillFrontmatter(
    lines.slice(1, frontmatterEnd),
    location,
  );
  if (!parsedFrontmatter.ok) {
    return parsedFrontmatter;
  }
  const metadata = parsedFrontmatter.metadata;
  const issues: WorkspaceSkillIssue[] = [];
  const name = metadata.get("name") ?? "";
  if (name.length === 0) {
    return invalidSkill(
      "invalid_skill_name",
      location,
      "Skill name is required for OpenAI-compatible SKILL.md frontmatter",
    );
  }
  if (name.length > maxSkillNameChars || !skillNamePattern.test(name)) {
    issues.push({
      code: "invalid_skill_name",
      location,
      message:
        `Skill name should be 1-${maxSkillNameChars} characters of lowercase letters, ` +
        `digits, and single hyphens: ${name}`,
    });
  }
  if (name !== directoryName) {
    issues.push({
      code: "invalid_skill_name",
      location,
      message: `Skill name should match its directory for Agent Skills compatibility: ${name} != ${directoryName}`,
    });
  }

  const description = metadata.get("description") ?? "";
  if (description.length === 0 || /[\r\n]/u.test(description)) {
    return invalidSkill(
      "invalid_skill_description",
      location,
      "Skill description must be a non-empty single line",
    );
  }
  if (description.length > maxSkillDescriptionChars) {
    issues.push({
      code: "invalid_skill_description",
      location,
      message: `Skill description should not exceed ${maxSkillDescriptionChars} characters`,
    });
  }

  const compatibility = metadata.get("compatibility");
  if (
    compatibility !== undefined &&
    (compatibility.length === 0 || compatibility.length > maxSkillCompatibilityChars)
  ) {
    issues.push({
      code: "invalid_skill_compatibility",
      location,
      message: `Skill compatibility should be 1-${maxSkillCompatibilityChars} characters when provided`,
    });
  }

  const disableModelInvocation = parseFrontmatterBoolean(
    metadata.get("disable-model-invocation"),
    "disable-model-invocation",
    location,
  );
  if (!disableModelInvocation.ok) {
    return disableModelInvocation;
  }

  if (lines.slice(frontmatterEnd + 1).join("\n").trim().length === 0) {
    return invalidSkill(
      "invalid_skill_body",
      location,
      "SKILL.md must include an instruction body after its frontmatter",
    );
  }

  return {
    ok: true,
    skill: {
      name,
      description,
      location,
      source: "workspace",
      disableModelInvocation: disableModelInvocation.value,
    },
    issues,
  };
}

export async function importOpenAiSkillPackage(
  options: ImportOpenAiSkillPackageOptions,
): Promise<ImportOpenAiSkillPackageResult> {
  const maxSkillFileBytes = positiveInteger(
    options.maxSkillFileBytes,
    defaultMaxSkillFileBytes,
    "maxSkillFileBytes",
  );
  const normalizedFiles = normalizeSkillImportFiles(options.files);
  const skillFile = selectImportedSkillFile(normalizedFiles);
  if (Buffer.byteLength(skillFile.content, "utf8") > maxSkillFileBytes) {
    throw new Error(`SKILL.md exceeds maximum size of ${maxSkillFileBytes} bytes`);
  }
  const declaredName = readFrontmatterField(skillFile.content, "name");
  const validation = validateSkillMarkdown(
    skillFile.content,
    declaredName ?? importedSkillDirectoryName(skillFile.path),
    ".pibot/skills/import/SKILL.md",
  );
  if (!validation.ok) {
    throw new Error(validation.issue.message);
  }
  const fatalIssues = validation.issues.filter(
    (issue) =>
      issue.code !== "invalid_skill_name" ||
      !issue.message.includes("should match its directory"),
  );
  if (fatalIssues.length > 0) {
    throw new Error(fatalIssues.map((issue) => issue.message).join("; "));
  }

  const skillName = validation.skill.name;
  const rootPath = path.resolve(options.pibotSkillsRoot);
  await ensureRegularDirectory(rootPath, "pibot Skills root");
  const skillDir = path.join(rootPath, skillName);
  await ensureRegularDirectory(skillDir, "Skill directory");
  const importRoot = importedPackageRoot(skillFile.path);
  const writtenFiles: string[] = [];
  for (const file of normalizedFiles) {
    if (!isPathUnderImportRoot(file.path, importRoot)) {
      continue;
    }
    const relativePath = normalizeImportedSkillResourcePath(
      stripImportRoot(file.path, importRoot),
    );
    if (relativePath === undefined) {
      continue;
    }
    if (
      relativePath === "SKILL.md" &&
      Buffer.byteLength(file.content, "utf8") > maxSkillFileBytes
    ) {
      throw new Error(`SKILL.md exceeds maximum size of ${maxSkillFileBytes} bytes`);
    }
    const targetPath = path.join(skillDir, ...relativePath.split("/"));
    assertInsideDirectory(skillDir, targetPath, relativePath);
    await ensureRegularDirectory(path.dirname(targetPath), "Skill file parent");
    const existing = await lstatIfExists(targetPath);
    if (existing !== undefined) {
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new Error(`Skill target must be a regular file: ${relativePath}`);
      }
      if (options.overwrite !== true) {
        throw new Error(
          `Skill file already exists. Enable overwrite to replace it: ${relativePath}`,
        );
      }
    }
    await writeFile(targetPath, file.content, {
      encoding: "utf8",
      flag: options.overwrite === true ? "w" : "wx",
    });
    writtenFiles.push(path.posix.join(".pibot/skills", skillName, relativePath));
  }

  const importedSkill = await applyOpenAiSkillMetadata({
    ...validation.skill,
    location: skillLocation(pibotSkillsRoot, skillName),
    source: "pibot",
    filePath: path.join(skillDir, "SKILL.md"),
  }, skillDir);

  return {
    skill: importedSkill,
    writtenFiles,
  };
}

export function renderWorkspaceSkillIndex(
  skills: readonly WorkspaceSkill[],
): string | undefined {
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) {
    return undefined;
  }

  return [
    "The following pibot skills provide specialized instructions for specific tasks.",
    "Use read_skill with the listed location to load a Skill's SKILL.md when the task matches its description.",
    "When a Skill file references a relative resource path, use read_skill with the same location and that path.",
    "<available_skills>",
    ...visibleSkills.map(
      (skill) =>
        `  <skill>\n    <name>${escapeXml(skill.name)}</name>\n    <description>${escapeXml(skill.description)}</description>\n    <source>${escapeXml(skill.source)}</source>\n    <location>${escapeXml(skill.location)}</location>\n  </skill>`,
    ),
    "</available_skills>",
  ].join("\n");
}

interface SkillScanRoot {
  readonly source: WorkspaceSkillSource;
  readonly rootPath: string;
  readonly locationRoot: string;
}

function skillLocation(rootRelativePath: string, directoryName: string): string {
  return path.posix.join(rootRelativePath, directoryName, "SKILL.md");
}

function normalizeSkillImportFiles(
  files: readonly SkillImportFile[],
): readonly SkillImportFile[] {
  if (files.length === 0) {
    throw new Error("Skill import requires at least one file");
  }
  return files.map((file) => {
    const normalizedPath = normalizeImportPath(file.path);
    if (typeof file.content !== "string") {
      throw new Error(`Imported file content must be a string: ${normalizedPath}`);
    }
    return {
      path: normalizedPath,
      content: file.content,
    };
  });
}

function normalizeImportPath(filePath: string): string {
  if (filePath.length === 0 || filePath.includes("\\")) {
    throw new Error("Imported Skill paths must be relative POSIX paths");
  }
  const normalized = path.posix.normalize(filePath);
  if (
    normalized === "." ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`Imported Skill path escapes the package: ${filePath}`);
  }
  return normalized;
}

function selectImportedSkillFile(
  files: readonly SkillImportFile[],
): SkillImportFile {
  const skillFiles = files
    .filter((file) => path.posix.basename(file.path) === "SKILL.md")
    .sort((left, right) => left.path.split("/").length - right.path.split("/").length);
  if (skillFiles[0] === undefined) {
    throw new Error("Imported Skill package must include SKILL.md");
  }
  return skillFiles[0];
}

function importedPackageRoot(skillFilePath: string): string {
  const dirname = path.posix.dirname(skillFilePath);
  return dirname === "." ? "" : dirname;
}

function importedSkillDirectoryName(skillFilePath: string): string {
  const root = importedPackageRoot(skillFilePath);
  return root.length === 0 ? "import" : path.posix.basename(root);
}

function isPathUnderImportRoot(filePath: string, root: string): boolean {
  return root.length === 0 || filePath === root || filePath.startsWith(`${root}/`);
}

function stripImportRoot(filePath: string, root: string): string {
  return root.length === 0 ? filePath : filePath.slice(root.length + 1);
}

function normalizeImportedSkillResourcePath(
  filePath: string,
): string | undefined {
  const normalized = normalizeImportPath(filePath);
  if (normalized === "SKILL.md") {
    return normalized;
  }
  const firstSegment = normalized.split("/")[0] ?? "";
  if (!["agents", "assets", "references", "scripts"].includes(firstSegment)) {
    return undefined;
  }
  return normalized;
}

function readFrontmatterField(content: string, field: string): string | undefined {
  const lines = content.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").split("\n");
  if (lines[0] !== "---") {
    return undefined;
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    return undefined;
  }
  const pattern = new RegExp(`^${field}:[ \\t]*(.*)$`, "u");
  for (const line of lines.slice(1, end)) {
    const match = pattern.exec(line);
    if (match !== null) {
      return unquote(match[1] ?? "").trim();
    }
  }
  return undefined;
}

async function ensureRegularDirectory(filePath: string, label: string): Promise<void> {
  const existing = await lstatIfExists(filePath);
  if (existing === undefined) {
    await mkdir(filePath, { recursive: true });
    return;
  }
  if (!existing.isDirectory() || existing.isSymbolicLink()) {
    throw new Error(`${label} must be a regular directory`);
  }
}

function assertInsideDirectory(
  baseDir: string,
  candidate: string,
  requestedPath: string,
): void {
  const relative = path.relative(path.resolve(baseDir), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Skill path is outside the Skill directory: ${requestedPath}`);
  }
}

async function applyOpenAiSkillMetadata(
  skill: WorkspaceSkill,
  skillDir: string,
): Promise<WorkspaceSkill> {
  const metadataPath = path.join(skillDir, "agents", "openai.yaml");
  const metadataStat = await lstatIfExists(metadataPath);
  if (
    metadataStat === undefined ||
    !metadataStat.isFile() ||
    metadataStat.isSymbolicLink()
  ) {
    return skill;
  }

  const content = await readFile(metadataPath, "utf8");
  const allowImplicitInvocation = parseOpenAiAllowImplicitInvocation(content);
  if (allowImplicitInvocation !== false) {
    return skill;
  }

  return {
    ...skill,
    disableModelInvocation: true,
  };
}

function parseOpenAiAllowImplicitInvocation(content: string): boolean | undefined {
  const match = /^\s*allow_implicit_invocation:\s*(true|false)\s*(?:#.*)?$/imu.exec(
    content,
  );
  if (match === null) {
    return undefined;
  }
  return match[1] === "true";
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

function normalizedDisabledNames(names: readonly string[] | undefined): Set<string> {
  return new Set(
    (names ?? [])
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
  );
}

function parseSkillFrontmatter(
  lines: readonly string[],
  location: string,
):
  | {
      readonly ok: true;
      readonly metadata: ReadonlyMap<string, string>;
    }
  | {
      readonly ok: false;
      readonly issue: WorkspaceSkillIssue;
    } {
  const metadata = new Map<string, string>();
  for (const line of lines) {
    if (line.trim().length === 0 || /^[ \t]+/u.test(line)) {
      continue;
    }

    const match = /^([a-z][a-z0-9_-]*):[ \t]*(.*)$/u.exec(line);
    if (match === null) {
      return invalidSkill(
        "invalid_skill_frontmatter",
        location,
        `Skill frontmatter must use key: value entries: ${line}`,
      );
    }

    const key = match[1] ?? "";
    if (metadata.has(key)) {
      return invalidSkill(
        "invalid_skill_frontmatter",
        location,
        `Skill frontmatter contains duplicate field: ${key}`,
      );
    }
    metadata.set(key, unquote(match[2] ?? "").trim());
  }

  return {
    ok: true,
    metadata,
  };
}

function parseFrontmatterBoolean(
  value: string | undefined,
  field: string,
  location: string,
):
  | {
      readonly ok: true;
      readonly value: boolean;
    }
  | {
      readonly ok: false;
      readonly issue: WorkspaceSkillIssue;
    } {
  if (value === undefined || value === "false") {
    return {
      ok: true,
      value: false,
    };
  }
  if (value === "true") {
    return {
      ok: true,
      value: true,
    };
  }

  return invalidSkill(
    "invalid_skill_frontmatter",
    location,
    `Skill frontmatter field ${field} must be true or false`,
  );
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function invalidSkill(
  code: WorkspaceSkillIssueCode,
  location: string,
  message: string,
): {
  readonly ok: false;
  readonly issue: WorkspaceSkillIssue;
} {
  return {
    ok: false,
    issue: {
      code,
      location,
      message,
    },
  };
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

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
