import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";

export interface SelfInstructionsStagingWorkspace {
  readonly root: string;
  readonly instructionsFile: string;
  readonly baselineInstructions: string;
}

export interface SelfInstructionsValidationReport {
  readonly status: "passed" | "failed";
  readonly checks: readonly SelfInstructionsValidationCheck[];
}

export interface SelfInstructionsValidationCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly message: string;
}

const stagingDirectoryName = ".pibot-evolution-workspaces";
const instructionsFileName = "self-instructions.md";
const maxSelfInstructionsBytes = 64_000;

export async function createSelfInstructionsStagingWorkspace(input: {
  readonly sourceRoot: string;
  readonly ticketId: string;
  readonly runId: string;
  readonly currentInstructions?: string;
  readonly proposalDraft?: string;
}): Promise<SelfInstructionsStagingWorkspace> {
  const sourceRoot = path.resolve(input.sourceRoot);
  const parent = path.join(sourceRoot, stagingDirectoryName);
  await mkdir(parent, { recursive: true });
  const runRoot = await makeUniqueDirectory(parent, [
    sanitizePathPart(input.ticketId),
    sanitizePathPart(input.runId),
    "self-instructions",
  ].join("-"));
  const stagingRoot = path.join(runRoot, "agent-self");
  await mkdir(stagingRoot, { recursive: true });

  const baselineInstructions = initialSelfInstructions(input.currentInstructions);
  const instructionsFile = path.join(stagingRoot, instructionsFileName);
  await writeFile(instructionsFile, baselineInstructions, "utf8");
  await writeFile(
    path.join(stagingRoot, "ticket-draft.md"),
    renderTicketDraft(input.proposalDraft),
    "utf8",
  );

  return {
    root: stagingRoot,
    instructionsFile,
    baselineInstructions,
  };
}

export async function readStagedSelfInstructions(
  staging: SelfInstructionsStagingWorkspace,
): Promise<string> {
  return readFile(staging.instructionsFile, "utf8");
}

export function validateStagedSelfInstructions(input: {
  readonly instructions: string;
  readonly baselineInstructions: string;
}): SelfInstructionsValidationReport {
  const text = input.instructions.trim();
  const checks: SelfInstructionsValidationCheck[] = [
    {
      name: "non_empty_instructions",
      passed: text.length > 0,
      message: text.length > 0
        ? "Self-instructions are present."
        : "Self-instructions are empty.",
    },
    {
      name: "size_limit",
      passed: Buffer.byteLength(input.instructions, "utf8") <= maxSelfInstructionsBytes,
      message: "Self-instructions must stay within 64 KB.",
    },
    {
      name: "changed_instructions",
      passed: normalizeInstructions(input.instructions) !==
        normalizeInstructions(input.baselineInstructions),
      message: "Implementation must change self-instructions.md.",
    },
  ];
  return {
    status: checks.every((check) => check.passed) ? "passed" : "failed",
    checks,
  };
}

export function selfInstructionsFileName(): string {
  return instructionsFileName;
}

function initialSelfInstructions(currentInstructions: string | undefined): string {
  const current = currentInstructions?.trim();
  if (current !== undefined && current.length > 0) {
    return `${current}\n`;
  }
  return [
    "# pibot Self-Instructions",
    "",
    "These instructions are maintained by the WebUI self-evolution control plane and are injected into future pibot runs.",
    "",
  ].join("\n");
}

function renderTicketDraft(proposalDraft: string | undefined): string {
  const draft = proposalDraft?.trim();
  return [
    "# Approved Self-Instruction Draft",
    "",
    draft === undefined || draft.length === 0
      ? "(No draft was provided. Derive the change from the approved ticket prompt.)"
      : draft,
    "",
  ].join("\n");
}

async function makeUniqueDirectory(parent: string, preferredName: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${randomUUID().slice(0, 8)}`;
    const candidate = path.join(parent, `${preferredName}${suffix}`);
    if (await pathExists(candidate)) {
      continue;
    }
    await mkdir(candidate, { recursive: true });
    return candidate;
  }
  throw new Error(`Unable to create staging directory under ${parent}`);
}

async function pathExists(targetPath: string): Promise<boolean> {
  return stat(targetPath).then(
    () => true,
    () => false,
  );
}

function sanitizePathPart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return sanitized.length === 0 ? "run" : sanitized.slice(0, 80);
}

function normalizeInstructions(value: string): string {
  return value.replace(/\r\n/gu, "\n").trim();
}
