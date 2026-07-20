import type { WorkspacePath } from "../core/ids";
import type {
  BashToolInput,
  EditToolInput,
  GrepToolInput,
  ReadToolInput,
  ReadSkillToolInput,
  TextReplacement,
  WriteToolInput,
  WriteSkillToolInput,
} from "../core/tools";
import type { ToolInputParseResult } from "./index";

type UnknownRecord = Readonly<Record<string, unknown>>;

export function parseReadInput(
  input: UnknownRecord,
): ToolInputParseResult<ReadToolInput> {
  const path = readString(input, "path");
  if (path === undefined) {
    return invalidInput("read.path must be a string");
  }
  return {
    ok: true,
    input: {
      path: path as WorkspacePath,
      ...optionalNumber("offset", readNumber(input, "offset")),
      ...optionalNumber("limit", readNumber(input, "limit")),
      ...optionalNumber("startLine", readNumber(input, "startLine")),
      ...optionalNumber("endLine", readNumber(input, "endLine")),
    },
  };
}

export function parseReadSkillInput(
  input: UnknownRecord,
): ToolInputParseResult<ReadSkillToolInput> {
  const location = readString(input, "location");
  if (location === undefined) {
    return invalidInput("read_skill.location must be a string");
  }
  return {
    ok: true,
    input: {
      location,
      ...optionalString("path", readString(input, "path")),
      ...optionalNumber("offset", readNumber(input, "offset")),
      ...optionalNumber("limit", readNumber(input, "limit")),
      ...optionalNumber("startLine", readNumber(input, "startLine")),
      ...optionalNumber("endLine", readNumber(input, "endLine")),
    },
  };
}

export function parseGrepInput(
  input: UnknownRecord,
): ToolInputParseResult<GrepToolInput> {
  const pattern = readString(input, "pattern");
  if (pattern === undefined) {
    return invalidInput("grep.pattern must be a string");
  }
  return {
    ok: true,
    input: {
      pattern,
      paths: readStringArray(input, "paths").map((item) => item as WorkspacePath),
      caseSensitive: readBoolean(input, "caseSensitive") ?? false,
      includeGlobs: readStringArray(input, "includeGlobs"),
      excludeGlobs: readStringArray(input, "excludeGlobs"),
    },
  };
}

export function parseBashInput(
  input: UnknownRecord,
): ToolInputParseResult<BashToolInput> {
  const command = readString(input, "command");
  if (command === undefined) {
    return invalidInput("bash.command must be a string");
  }
  return {
    ok: true,
    input: {
      command,
      ...optionalWorkspacePath("cwd", readString(input, "cwd")),
      ...optionalNumber("timeoutMs", readNumber(input, "timeoutMs")),
    },
  };
}

export function parseEditInput(
  input: UnknownRecord,
): ToolInputParseResult<EditToolInput> {
  const path = readString(input, "path");
  if (path === undefined) {
    return invalidInput("edit.path must be a string");
  }
  const replacements = readReplacements(input);
  if (replacements === null) {
    return invalidInput("edit.replacements must contain oldText/newText strings");
  }
  return {
    ok: true,
    input: {
      path: path as WorkspacePath,
      replacements,
      ...optionalString("expectedSha256", readString(input, "expectedSha256")),
    },
  };
}

export function parseWriteInput(
  input: UnknownRecord,
): ToolInputParseResult<WriteToolInput> {
  const path = readString(input, "path");
  const content = readString(input, "content");
  if (path === undefined || content === undefined) {
    return invalidInput("write.path and write.content must be strings");
  }
  return {
    ok: true,
    input: {
      path: path as WorkspacePath,
      content,
      overwrite: readBoolean(input, "overwrite") ?? false,
      ...optionalString("expectedSha256", readString(input, "expectedSha256")),
    },
  };
}

export function parseWriteSkillInput(
  input: UnknownRecord,
): ToolInputParseResult<WriteSkillToolInput> {
  const name = readString(input, "name");
  const content = readString(input, "content");
  if (name === undefined || content === undefined) {
    return invalidInput("write_skill.name and write_skill.content must be strings");
  }
  return {
    ok: true,
    input: {
      name,
      content,
      overwrite: readBoolean(input, "overwrite") ?? false,
      ...optionalString("path", readString(input, "path")),
    },
  };
}

function readReplacements(
  input: UnknownRecord,
): readonly TextReplacement[] | null {
  const replacements = input.replacements;
  if (!Array.isArray(replacements)) {
    return null;
  }
  const parsed: TextReplacement[] = [];
  for (const replacement of replacements) {
    if (!isRecord(replacement)) {
      return null;
    }
    const oldText = readString(replacement, "oldText");
    const newText = readString(replacement, "newText");
    if (oldText === undefined || newText === undefined) {
      return null;
    }
    parsed.push({
      oldText,
      newText,
      ...optionalNumber("occurrence", readNumber(replacement, "occurrence")),
    });
  }
  return parsed;
}

function invalidInput(message: string): { readonly ok: false; readonly message: string } {
  return { ok: false, message };
}

function readString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: UnknownRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function readBoolean(record: UnknownRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(record: UnknownRecord, key: string): readonly string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNumber<Key extends string>(
  key: Key,
  value: number | undefined,
): { readonly [Property in Key]: number } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: number;
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

function optionalWorkspacePath<Key extends string>(
  key: Key,
  value: string | undefined,
): { readonly [Property in Key]: WorkspacePath } | object {
  return value === undefined ? {} : { [key]: value as WorkspacePath } as {
    readonly [Property in Key]: WorkspacePath;
  };
}
