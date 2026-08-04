import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import type {
  ActiveRuntimeCodeVersion,
  AgentSelfVersion,
  EvolutionSignal,
  EvolutionTicket,
  EvolutionTimelineEvent,
  PendingRuntimeCodeActivation,
  RuntimeCodeVersion,
} from "./types";

export interface FileEvolutionStoreOptions {
  readonly rootDir: string;
  readonly maxJsonlFileBytes?: number;
}

export interface EvolutionStoreSnapshot {
  readonly signals: readonly EvolutionSignal[];
  readonly tickets: readonly EvolutionTicket[];
  readonly selfInstructions?: string;
  readonly selfVersions: readonly AgentSelfVersion[];
  readonly runtimeVersions: readonly RuntimeCodeVersion[];
  readonly activeRuntimeVersion?: ActiveRuntimeCodeVersion;
  readonly pendingRuntimeActivation?: PendingRuntimeCodeActivation;
}

interface TicketFile {
  readonly tickets: readonly EvolutionTicket[];
}

interface VersionFile {
  readonly versions: readonly AgentSelfVersion[];
}

interface RuntimeVersionFile {
  readonly versions: readonly RuntimeCodeVersion[];
}

interface RuntimeCurrentFile {
  readonly active?: ActiveRuntimeCodeVersion;
  readonly pending?: PendingRuntimeCodeActivation;
}

export class FileEvolutionStore {
  private readonly rootDir: string;
  private readonly maxJsonlFileBytes: number;

  constructor(options: FileEvolutionStoreOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.maxJsonlFileBytes = positiveInteger(
      options.maxJsonlFileBytes,
      5_000_000,
      "maxJsonlFileBytes",
    );
  }

  getRootDir(): string {
    return this.rootDir;
  }

  getSelfInstructionsPath(): string {
    return path.join(this.rootDir, "agent-self", "self-instructions.md");
  }

  async readSnapshot(): Promise<EvolutionStoreSnapshot> {
    const [
      signals,
      tickets,
      selfInstructions,
      selfVersions,
      runtimeVersions,
      activeRuntimeVersion,
      pendingRuntimeActivation,
    ] = await Promise.all([
      this.readSignals(),
      this.readTickets(),
      this.readSelfInstructions(),
      this.readSelfVersions(),
      this.readRuntimeVersions(),
      this.readActiveRuntimeVersion(),
      this.readPendingRuntimeActivation(),
    ]);
    return {
      signals,
      tickets,
      ...(selfInstructions === undefined ? {} : { selfInstructions }),
      selfVersions,
      runtimeVersions,
      ...(activeRuntimeVersion === undefined ? {} : { activeRuntimeVersion }),
      ...(pendingRuntimeActivation === undefined
        ? {}
        : { pendingRuntimeActivation }),
    };
  }

  async readSignals(): Promise<readonly EvolutionSignal[]> {
    const filePath = this.signalsFile();
    const text = await readTextIfExists(filePath);
    if (text === undefined || text.trim().length === 0) {
      return [];
    }

    const signals: EvolutionSignal[] = [];
    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const parsed = JSON.parse(trimmed) as unknown;
      if (isObject(parsed)) {
        signals.push(parsed as unknown as EvolutionSignal);
      }
    }
    return signals;
  }

  async appendSignal(signal: EvolutionSignal): Promise<void> {
    await appendJsonl(this.signalsFile(), signal, this.maxJsonlFileBytes);
  }

  async readTickets(): Promise<readonly EvolutionTicket[]> {
    const parsed = await readJsonFile<TicketFile>(this.ticketsFile());
    return parsed?.tickets ?? [];
  }

  async writeTickets(tickets: readonly EvolutionTicket[]): Promise<void> {
    await writeJsonFile(this.ticketsFile(), { tickets });
  }

  async appendAudit(event: EvolutionTimelineEvent & {
    readonly ticketId?: string;
  }): Promise<void> {
    await appendJsonl(this.auditFile(), event, this.maxJsonlFileBytes);
  }

  async readSelfInstructions(): Promise<string | undefined> {
    return readTextIfExists(this.getSelfInstructionsPath());
  }

  async readSelfVersions(): Promise<readonly AgentSelfVersion[]> {
    const parsed = await readJsonFile<VersionFile>(this.selfVersionsFile());
    return parsed?.versions ?? [];
  }

  async readRuntimeVersions(): Promise<readonly RuntimeCodeVersion[]> {
    const parsed = await readJsonFile<RuntimeVersionFile>(
      this.runtimeVersionsFile(),
    );
    return parsed?.versions ?? [];
  }

  async writeRuntimeVersions(
    versions: readonly RuntimeCodeVersion[],
  ): Promise<void> {
    await writeJsonFile(this.runtimeVersionsFile(), { versions });
  }

  async deleteTicket(ticketId: string): Promise<boolean> {
    const tickets = await this.readTickets();
    const next = tickets.filter((ticket) => ticket.id !== ticketId);
    if (next.length === tickets.length) {
      return false;
    }
    await this.writeTickets(next);
    return true;
  }

  async deleteRuntimeVersion(versionId: string): Promise<boolean> {
    const versions = await this.readRuntimeVersions();
    const next = versions.filter((version) => version.id !== versionId);
    if (next.length === versions.length) {
      return false;
    }
    await this.writeRuntimeVersions(next);
    await rm(this.getRuntimeCodeVersionArchiveRoot(versionId), {
      recursive: true,
      force: true,
    });
    return true;
  }

  async deleteSelfVersion(versionId: string): Promise<boolean> {
    const versions = await this.readSelfVersions();
    const next = versions.filter((version) => version.id !== versionId);
    if (next.length === versions.length) {
      return false;
    }
    await writeJsonFile(this.selfVersionsFile(), { versions: next });
    return true;
  }

  async readActiveRuntimeVersion(): Promise<
    ActiveRuntimeCodeVersion | undefined
  > {
    const parsed = await readJsonFile<RuntimeCurrentFile>(
      this.runtimeCurrentFile(),
    );
    return parsed?.active;
  }

  async writeActiveRuntimeVersion(
    active: ActiveRuntimeCodeVersion,
  ): Promise<void> {
    const parsed = await readJsonFile<RuntimeCurrentFile>(
      this.runtimeCurrentFile(),
    );
    await writeJsonFile(this.runtimeCurrentFile(), {
      active,
      ...(parsed?.pending === undefined ? {} : { pending: parsed.pending }),
    });
  }

  async readPendingRuntimeActivation(): Promise<
    PendingRuntimeCodeActivation | undefined
  > {
    const parsed = await readJsonFile<RuntimeCurrentFile>(
      this.runtimeCurrentFile(),
    );
    return parsed?.pending;
  }

  async writePendingRuntimeActivation(
    pending: PendingRuntimeCodeActivation,
  ): Promise<void> {
    const parsed = await readJsonFile<RuntimeCurrentFile>(
      this.runtimeCurrentFile(),
    );
    await writeJsonFile(this.runtimeCurrentFile(), {
      ...(parsed?.active === undefined ? {} : { active: parsed.active }),
      pending,
    });
  }

  async confirmPendingRuntimeActivation(input: {
    readonly actor: string;
  }): Promise<ActiveRuntimeCodeVersion | undefined> {
    const parsed = await readJsonFile<RuntimeCurrentFile>(
      this.runtimeCurrentFile(),
    );
    if (parsed?.pending === undefined) {
      return undefined;
    }
    const active: ActiveRuntimeCodeVersion = {
      versionId: parsed.pending.versionId,
      activatedAt: new Date().toISOString(),
      activatedBy: input.actor,
      ...(parsed.pending.previousVersionId === undefined
        ? {}
        : { previousVersionId: parsed.pending.previousVersionId }),
      ...(parsed.pending.commandLabel === undefined
        ? {}
        : { commandLabel: parsed.pending.commandLabel }),
    };
    await writeJsonFile(this.runtimeCurrentFile(), { active });
    return active;
  }

  async clearPendingRuntimeActivation(): Promise<void> {
    const parsed = await readJsonFile<RuntimeCurrentFile>(
      this.runtimeCurrentFile(),
    );
    if (parsed === undefined) {
      return;
    }
    await writeJsonFile(this.runtimeCurrentFile(), {
      ...(parsed.active === undefined ? {} : { active: parsed.active }),
    });
  }

  async writeSelfInstructionsVersion(input: {
    readonly instructions: string;
    readonly label: string;
    readonly topic?: string;
    readonly createdBy: string;
    readonly sourceTicketId?: string;
  }): Promise<AgentSelfVersion> {
    const versions = await this.readSelfVersions();
    const version: AgentSelfVersion = {
      id: `self-${Date.now()}-${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      label: input.label,
      ...(input.topic === undefined ? {} : { topic: input.topic }),
      instructions: input.instructions,
      createdBy: input.createdBy,
      ...(input.sourceTicketId === undefined
        ? {}
        : { sourceTicketId: input.sourceTicketId }),
    };
    await mkdir(path.dirname(this.getSelfInstructionsPath()), { recursive: true });
    await writeFile(this.getSelfInstructionsPath(), input.instructions, "utf8");
    await writeJsonFile(this.selfVersionsFile(), {
      versions: [...versions, version],
    });
    return version;
  }

  newId(prefix: string): string {
    return `${prefix}_${compactTimestamp(new Date())}_${randomUUID().slice(0, 4)}`;
  }

  getRuntimeCodeVersionArchiveRoot(versionId: string): string {
    return path.join(this.rootDir, "runtime-code", "versions", versionId);
  }

  private signalsFile(): string {
    return path.join(this.rootDir, "signals.jsonl");
  }

  private ticketsFile(): string {
    return path.join(this.rootDir, "tickets.json");
  }

  private auditFile(): string {
    return path.join(this.rootDir, "audit.jsonl");
  }

  private selfVersionsFile(): string {
    return path.join(this.rootDir, "agent-self", "versions.json");
  }

  private runtimeVersionsFile(): string {
    return path.join(this.rootDir, "runtime-code", "versions.json");
  }

  private runtimeCurrentFile(): string {
    return path.join(this.rootDir, "runtime-code", "current.json");
  }
}

async function appendJsonl(
  filePath: string,
  value: unknown,
  maxBytes: number,
): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  await mkdir(path.dirname(filePath), { recursive: true });
  const currentBytes = await fileSizeIfExists(filePath);
  if (currentBytes + Buffer.byteLength(line, "utf8") > maxBytes) {
    throw new Error(`File exceeds maximum size of ${maxBytes} bytes: ${filePath}`);
  }
  await appendFile(filePath, line, "utf8");
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  const text = await readTextIfExists(filePath);
  if (text === undefined || text.trim().length === 0) {
    return undefined;
  }
  return JSON.parse(text) as T;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function fileSizeIfExists(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return 0;
    }
    throw error;
  }
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function compactTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "-",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
}
