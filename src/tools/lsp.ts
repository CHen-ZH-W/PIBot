import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import * as ts from "typescript";
import type { WorkspacePath } from "../core/ids";
import type { ToolError } from "../core/tools";
import {
  assertInside,
  resolveWorkspacePath,
} from "../workspace/path-boundary";
import type { CodingToolDefinition, ToolInputParseResult, ToolRunContext } from "./index";

type LspAction = "definition" | "references" | "diagnostics";
type UnknownRecord = Readonly<Record<string, unknown>>;

export interface LspToolInput {
  readonly action: LspAction;
  readonly path?: WorkspacePath;
  readonly line?: number;
  readonly character?: number;
  readonly maxResults?: number;
}

export const lspTool: CodingToolDefinition<"lsp", LspToolInput, unknown> = {
  name: "lsp",
  riskLevel: "read-only",
  executionMode: "parallel",
  description:
    "Use TypeScript language-service features for definition lookup, reference search, and diagnostics in the workspace.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: ["definition", "references", "diagnostics"],
      },
      path: {
        type: "string",
        description:
          "Workspace-relative TS/JS file path. Required for definition and references; optional for diagnostics.",
      },
      line: {
        type: "integer",
        minimum: 1,
        description: "1-based line number for definition/references.",
      },
      character: {
        type: "integer",
        minimum: 1,
        description: "1-based character column for definition/references.",
      },
      maxResults: {
        type: "integer",
        minimum: 1,
        description: "Maximum locations or diagnostics to return. Defaults to 50.",
      },
    },
    required: ["action"],
  },
  parse: parseLspInput,
  async execute(input, context) {
    const service = await createWorkspaceLanguageService(context);
    switch (input.action) {
      case "definition":
        return definitionAt(service, context, input);
      case "references":
        return referencesAt(service, context, input);
      case "diagnostics":
        return diagnostics(service, context, input);
    }
  },
};

function parseLspInput(input: UnknownRecord): ToolInputParseResult<LspToolInput> {
  const action = readString(input, "action");
  if (!isLspAction(action)) {
    return invalidInput("lsp.action must be definition, references, or diagnostics");
  }

  return {
    ok: true,
    input: {
      action,
      ...optionalWorkspacePath("path", readString(input, "path")),
      ...optionalNumber("line", readNumber(input, "line")),
      ...optionalNumber("character", readNumber(input, "character")),
      ...optionalNumber("maxResults", readNumber(input, "maxResults")),
    },
  };
}

async function definitionAt(
  service: ts.LanguageService,
  context: ToolRunContext,
  input: LspToolInput,
): Promise<unknown> {
  const target = await sourcePosition(context, input);
  const definitions = service.getDefinitionAtPosition(
    target.fileName,
    target.position,
  ) ?? [];
  return {
    action: input.action,
    locations: definitions
      .slice(0, maxResults(input))
      .flatMap((definition) => toLocation(context.workspaceRoot, definition)),
    truncated: definitions.length > maxResults(input),
  };
}

async function referencesAt(
  service: ts.LanguageService,
  context: ToolRunContext,
  input: LspToolInput,
): Promise<unknown> {
  const target = await sourcePosition(context, input);
  const references = service.findReferences(target.fileName, target.position) ?? [];
  const entries = references.flatMap((reference) => reference.references);
  return {
    action: input.action,
    locations: entries
      .slice(0, maxResults(input))
      .flatMap((reference) => toLocation(context.workspaceRoot, reference)),
    truncated: entries.length > maxResults(input),
  };
}

async function diagnostics(
  service: ts.LanguageService,
  context: ToolRunContext,
  input: LspToolInput,
): Promise<unknown> {
  const files =
    input.path === undefined
      ? service.getProgram()?.getRootFileNames() ?? []
      : [(await resolveWorkspacePath(context.workspaceRoot, input.path, {
          access: "read",
        }))];
  const max = maxResults(input);
  const output = [];
  for (const fileName of files) {
    if (!isInsideWorkspace(context.workspaceRoot, fileName)) {
      continue;
    }
    const fileDiagnostics = [
      ...service.getSyntacticDiagnostics(fileName),
      ...service.getSemanticDiagnostics(fileName),
      ...service.getSuggestionDiagnostics(fileName),
    ];
    for (const diagnostic of fileDiagnostics) {
      output.push(toDiagnostic(context.workspaceRoot, diagnostic));
      if (output.length >= max) {
        return {
          action: input.action,
          diagnostics: output,
          truncated: true,
        };
      }
    }
  }

  return {
    action: input.action,
    diagnostics: output,
    truncated: false,
  };
}

async function sourcePosition(
  context: ToolRunContext,
  input: LspToolInput,
): Promise<{ readonly fileName: string; readonly position: number }> {
  if (input.path === undefined || input.line === undefined || input.character === undefined) {
    throw toolError(
      "invalid_input",
      "lsp.path, lsp.line, and lsp.character are required for this action",
    );
  }
  const fileName = await resolveWorkspacePath(context.workspaceRoot, input.path, {
    access: "read",
  });
  const source = ts.createSourceFile(
    fileName,
    await readFile(fileName, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  return {
    fileName,
    position: source.getPositionOfLineAndCharacter(
      assertPositiveInteger(input.line, "lsp.line") - 1,
      assertPositiveInteger(input.character, "lsp.character") - 1,
    ),
  };
}

async function createWorkspaceLanguageService(
  context: ToolRunContext,
): Promise<ts.LanguageService> {
  const config = await readTsConfig(context.workspaceRoot);
  const files = [...(config.fileNames.length > 0
    ? config.fileNames
    : await findSourceFiles(context.workspaceRoot))];
  const versions = new Map(files.map((file) => [file, "0"]));
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => files,
    getScriptVersion: (fileName) => versions.get(fileName) ?? "0",
    getScriptSnapshot: (fileName) => {
      if (!ts.sys.fileExists(fileName)) {
        return undefined;
      }
      return ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName) ?? "");
    },
    getCurrentDirectory: () => context.workspaceRoot,
    getCompilationSettings: () => config.options,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
  };

  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

async function readTsConfig(
  workspaceRoot: string,
): Promise<{ readonly fileNames: readonly string[]; readonly options: ts.CompilerOptions }> {
  const configPath = ts.findConfigFile(workspaceRoot, ts.sys.fileExists);
  if (configPath === undefined || !isInsideWorkspace(workspaceRoot, configPath)) {
    return {
      fileNames: [],
      options: defaultCompilerOptions(),
    };
  }
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error !== undefined) {
    throw toolError(
      "invalid_input",
      ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
    defaultCompilerOptions(),
    configPath,
  );
  return {
    fileNames: parsed.fileNames.filter((fileName) =>
      isInsideWorkspace(workspaceRoot, fileName)),
    options: parsed.options,
  };
}

async function findSourceFiles(workspaceRoot: string): Promise<readonly string[]> {
  const files: string[] = [];
  await walk(workspaceRoot, files);
  return files;
}

async function walk(directory: string, files: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (shouldSkipPath(entry.name)) {
      continue;
    }
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, files);
      continue;
    }
    if (entry.isFile() && isSourceFile(fullPath)) {
      files.push(fullPath);
    }
  }
}

function toLocation(
  workspaceRoot: string,
  span: { readonly fileName: string; readonly textSpan: ts.TextSpan },
): readonly unknown[] {
  if (!isInsideWorkspace(workspaceRoot, span.fileName)) {
    return [];
  }
  const source = ts.createSourceFile(
    span.fileName,
    ts.sys.readFile(span.fileName) ?? "",
    ts.ScriptTarget.Latest,
    true,
  );
  const position = source.getLineAndCharacterOfPosition(span.textSpan.start);
  return [
    {
      path: toWorkspacePath(workspaceRoot, span.fileName),
      line: position.line + 1,
      character: position.character + 1,
    },
  ];
}

function toDiagnostic(
  workspaceRoot: string,
  diagnostic: ts.Diagnostic,
): unknown {
  const file = diagnostic.file;
  const position =
    file === undefined || diagnostic.start === undefined
      ? undefined
      : file.getLineAndCharacterOfPosition(diagnostic.start);
  return {
    ...(file === undefined || !isInsideWorkspace(workspaceRoot, file.fileName)
      ? {}
      : { path: toWorkspacePath(workspaceRoot, file.fileName) }),
    ...(position === undefined
      ? {}
      : { line: position.line + 1, character: position.character + 1 }),
    category: ts.DiagnosticCategory[diagnostic.category].toLowerCase(),
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  };
}

function defaultCompilerOptions(): ts.CompilerOptions {
  return {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.ReactJSX,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    target: ts.ScriptTarget.ES2022,
  };
}

function toWorkspacePath(workspaceRoot: string, fileName: string): WorkspacePath {
  return path.relative(workspaceRoot, fileName).split(path.sep).join("/") as WorkspacePath;
}

function isInsideWorkspace(workspaceRoot: string, fileName: string): boolean {
  try {
    assertInside(workspaceRoot, fileName, "LSP result is outside workspace");
    return true;
  } catch {
    return false;
  }
}

function shouldSkipPath(name: string): boolean {
  return name === "node_modules" ||
    name === ".git" ||
    name === ".pibot" ||
    name === "dist";
}

function isSourceFile(filePath: string): boolean {
  return [".ts", ".tsx", ".js", ".jsx"].includes(path.extname(filePath));
}

function maxResults(input: LspToolInput): number {
  return assertPositiveInteger(input.maxResults ?? 50, "lsp.maxResults");
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw toolError("invalid_input", `${label} must be a positive integer`);
  }
  return value;
}

function isLspAction(value: string | undefined): value is LspAction {
  return value === "definition" ||
    value === "references" ||
    value === "diagnostics";
}

function readString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: UnknownRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function optionalNumber<Key extends string>(
  key: Key,
  value: number | undefined,
): { readonly [Property in Key]: number } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: number;
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

function invalidInput(message: string): { readonly ok: false; readonly message: string } {
  return { ok: false, message };
}

function toolError(code: ToolError["code"], message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}
