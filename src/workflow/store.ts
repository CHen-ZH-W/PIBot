import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import type {
  CircuitBreakerRecord,
  FailureExperienceRecord,
  WorkflowAttemptRecord,
  WorkflowEventRecord,
  WorkflowRunRecord,
  WorkflowStepRecord,
} from "./types";

export interface FileWorkflowStoreOptions {
  readonly rootDir: string;
  readonly maxEventFileBytes?: number;
  readonly maxExperienceFileBytes?: number;
}

export class FileWorkflowStore {
  private readonly rootDir: string;
  private readonly maxEventFileBytes: number;
  private readonly maxExperienceFileBytes: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: FileWorkflowStoreOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.maxEventFileBytes = positiveInteger(
      options.maxEventFileBytes,
      20_000_000,
      "maxEventFileBytes",
    );
    this.maxExperienceFileBytes = positiveInteger(
      options.maxExperienceFileBytes,
      20_000_000,
      "maxExperienceFileBytes",
    );
  }

  getRootDir(): string {
    return this.rootDir;
  }

  createRun(record: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    return this.enqueue(async () => {
      await writeJsonAtomic(this.runFile(record.runId), record);
      await writeJsonAtomic(this.stepsFile(record.runId), { steps: [] });
      await writeJsonAtomic(this.attemptsFile(record.runId), { attempts: [] });
      return record;
    });
  }

  async readRun(runId: string): Promise<WorkflowRunRecord> {
    return readRequiredJson<WorkflowRunRecord>(this.runFile(runId));
  }

  async findRunByExternalKey(
    externalKey: string,
  ): Promise<WorkflowRunRecord | undefined> {
    for (const runId of await readDirectoryNames(this.runsDir())) {
      const run = await readJsonIfExists<WorkflowRunRecord>(this.runFile(runId));
      if (run?.externalKey === externalKey) {
        return run;
      }
    }
    return undefined;
  }

  async listRuns(): Promise<readonly WorkflowRunRecord[]> {
    const runs: WorkflowRunRecord[] = [];
    for (const runId of await readDirectoryNames(this.runsDir())) {
      const run = await readJsonIfExists<WorkflowRunRecord>(this.runFile(runId));
      if (run !== undefined) {
        runs.push(run);
      }
    }
    return runs.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  updateRun(
    runId: string,
    update: (current: WorkflowRunRecord) => WorkflowRunRecord,
  ): Promise<WorkflowRunRecord> {
    return this.enqueue(async () => {
      const next = update(await this.readRun(runId));
      await writeJsonAtomic(this.runFile(runId), next);
      return next;
    });
  }

  async readSteps(runId: string): Promise<readonly WorkflowStepRecord[]> {
    const file = await readJsonIfExists<{ readonly steps?: readonly WorkflowStepRecord[] }>(
      this.stepsFile(runId),
    );
    return file?.steps ?? [];
  }

  writeSteps(
    runId: string,
    update: (
      current: readonly WorkflowStepRecord[],
    ) => readonly WorkflowStepRecord[],
  ): Promise<readonly WorkflowStepRecord[]> {
    return this.enqueue(async () => {
      const next = update(await this.readSteps(runId));
      await writeJsonAtomic(this.stepsFile(runId), { steps: next });
      return next;
    });
  }

  async readAttempts(runId: string): Promise<readonly WorkflowAttemptRecord[]> {
    const file = await readJsonIfExists<{
      readonly attempts?: readonly WorkflowAttemptRecord[];
    }>(this.attemptsFile(runId));
    return file?.attempts ?? [];
  }

  writeAttempts(
    runId: string,
    update: (
      current: readonly WorkflowAttemptRecord[],
    ) => readonly WorkflowAttemptRecord[],
  ): Promise<readonly WorkflowAttemptRecord[]> {
    return this.enqueue(async () => {
      const next = update(await this.readAttempts(runId));
      await writeJsonAtomic(this.attemptsFile(runId), { attempts: next });
      return next;
    });
  }

  appendEvent(input: {
    readonly runId: string;
    readonly type: string;
    readonly stepId?: string;
    readonly attemptId?: string;
    readonly payload?: Readonly<Record<string, unknown>>;
  }): Promise<WorkflowEventRecord> {
    return this.enqueue(async () => {
      const previous = await this.readEvents(input.runId, 0);
      const event: WorkflowEventRecord = {
        schemaVersion: 1,
        runId: input.runId,
        seq: (previous.at(-1)?.seq ?? 0) + 1,
        type: input.type,
        ts: new Date().toISOString(),
        ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
        ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
        payload: input.payload ?? {},
      };
      await appendJsonl(
        this.eventsFile(input.runId),
        event,
        this.maxEventFileBytes,
      );
      return event;
    });
  }

  async readEvents(
    runId: string,
    afterSeq = 0,
  ): Promise<readonly WorkflowEventRecord[]> {
    return (await readJsonl<WorkflowEventRecord>(this.eventsFile(runId)))
      .filter((event) => event.runId === runId && event.seq > afterSeq)
      .sort((left, right) => left.seq - right.seq);
  }

  appendFailureExperience(
    experience: FailureExperienceRecord,
  ): Promise<void> {
    return this.enqueue(() =>
      appendJsonl(
        this.experiencesFile(),
        experience,
        this.maxExperienceFileBytes,
      )
    );
  }

  async readFailureExperiences(): Promise<readonly FailureExperienceRecord[]> {
    return readJsonl<FailureExperienceRecord>(this.experiencesFile());
  }

  async readCircuits(): Promise<readonly CircuitBreakerRecord[]> {
    const file = await readJsonIfExists<{
      readonly circuits?: readonly CircuitBreakerRecord[];
    }>(this.circuitsFile());
    return file?.circuits ?? [];
  }

  writeCircuits(
    update: (
      current: readonly CircuitBreakerRecord[],
    ) => readonly CircuitBreakerRecord[],
  ): Promise<readonly CircuitBreakerRecord[]> {
    return this.enqueue(async () => {
      const next = update(await this.readCircuits());
      await writeJsonAtomic(this.circuitsFile(), { circuits: next });
      return next;
    });
  }

  private runsDir(): string {
    return path.join(this.rootDir, "runs");
  }

  private runDir(runId: string): string {
    return path.join(this.runsDir(), safeSegment(runId));
  }

  private runFile(runId: string): string {
    return path.join(this.runDir(runId), "run.json");
  }

  private stepsFile(runId: string): string {
    return path.join(this.runDir(runId), "steps.json");
  }

  private attemptsFile(runId: string): string {
    return path.join(this.runDir(runId), "attempts.json");
  }

  private eventsFile(runId: string): string {
    return path.join(this.runDir(runId), "events.jsonl");
  }

  private experiencesFile(): string {
    return path.join(this.rootDir, "experience", "failures.jsonl");
  }

  private circuitsFile(): string {
    return path.join(this.rootDir, "circuits.json");
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
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
    throw new Error(`Workflow JSONL exceeds maximum size: ${filePath}`);
  }
  await appendFile(filePath, line, "utf8");
}

async function readJsonl<T>(filePath: string): Promise<readonly T[]> {
  const text = await readTextIfExists(filePath);
  if (text === undefined) {
    return [];
  }
  const values: T[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      values.push(JSON.parse(trimmed) as T);
    } catch {
      // A process crash may leave one truncated trailing record. Earlier events remain valid.
    }
  }
  return values;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

async function readRequiredJson<T>(filePath: string): Promise<T> {
  const value = await readJsonIfExists<T>(filePath);
  if (value === undefined) {
    throw new Error(`Workflow record not found: ${filePath}`);
  }
  return value;
}

async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
  const text = await readTextIfExists(filePath);
  return text === undefined ? undefined : JSON.parse(text) as T;
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readDirectoryNames(directory: string): Promise<readonly string[]> {
  try {
    return await readdir(directory);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function fileSizeIfExists(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function safeSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.-]+/gu, "-");
  if (normalized.length === 0 || normalized === "." || normalized === "..") {
    throw new Error(`Invalid workflow path segment: ${value}`);
  }
  return normalized.slice(0, 160);
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
