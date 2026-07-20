import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ToolError } from "../core/tools";
import { assertInside } from "./path-boundary";

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "blocked";

export interface PlanTask {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly dependencies: readonly string[];
  readonly status: TaskStatus;
  readonly attempts: number;
  readonly notes?: string;
  readonly error?: string;
  readonly result?: string;
}

export interface TaskStoreSnapshot {
  readonly schemaVersion: 1;
  readonly updatedAt: string;
  readonly maxReplans: number;
  readonly replanCount: number;
  readonly tasks: readonly PlanTask[];
}

export interface TaskStoreWriteRequest {
  readonly tasks: readonly NewPlanTask[];
  readonly reason?: string;
  readonly maxReplans?: number;
}

export interface NewPlanTask {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly dependencies?: readonly string[];
  readonly status?: TaskStatus;
}

export interface TaskStatusUpdate {
  readonly id: string;
  readonly status: TaskStatus;
  readonly notes?: string;
  readonly error?: string;
  readonly result?: string;
}

export interface TaskStore {
  readonly filePath: string;
  read(): Promise<TaskStoreSnapshot>;
  writeTasks(request: TaskStoreWriteRequest): Promise<TaskStoreSnapshot>;
  updateTask(request: TaskStatusUpdate): Promise<TaskStoreSnapshot>;
  recordReplan(reason: string): Promise<TaskStoreSnapshot>;
  nextExecutableTask(): Promise<PlanTask | undefined>;
}

export interface FileTaskStoreOptions {
  readonly workspaceRoot: string;
  readonly fileName?: string;
  readonly maxTasksFileBytes?: number;
  readonly maxTasks?: number;
  readonly maxReplans?: number;
}

export class FileTaskStore implements TaskStore {
  readonly filePath: string;
  private readonly workspaceRoot: string;
  private readonly maxTasksFileBytes: number;
  private readonly maxTasks: number;
  private readonly defaultMaxReplans: number;

  constructor(options: FileTaskStoreOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.filePath = path.resolve(
      this.workspaceRoot,
      options.fileName ?? "tasks.json",
    );
    assertInside(
      this.workspaceRoot,
      this.filePath,
      `tasks.json must stay inside workspace: ${this.filePath}`,
    );
    this.maxTasksFileBytes = positiveInteger(
      options.maxTasksFileBytes,
      512_000,
      "maxTasksFileBytes",
    );
    this.maxTasks = positiveInteger(options.maxTasks, 100, "maxTasks");
    this.defaultMaxReplans = nonNegativeInteger(
      options.maxReplans,
      2,
      "maxReplans",
    );
  }

  async read(): Promise<TaskStoreSnapshot> {
    const existing = await readExistingSnapshot(this.filePath, this.maxTasksFileBytes);
    return existing ?? emptySnapshot(this.defaultMaxReplans);
  }

  async writeTasks(request: TaskStoreWriteRequest): Promise<TaskStoreSnapshot> {
    if (request.tasks.length > this.maxTasks) {
      throw toolError(
        "invalid_input",
        `tasks_update.tasks exceeds maximum task count of ${this.maxTasks}`,
      );
    }
    const previous = await readExistingSnapshot(
      this.filePath,
      this.maxTasksFileBytes,
    );
    const seen = new Set<string>();
    const tasks = request.tasks.map((task) => normalizeNewTask(task, seen));
    const maxReplans =
      request.maxReplans ?? previous?.maxReplans ?? this.defaultMaxReplans;
    let replanCount = previous?.replanCount ?? 0;
    if (previous !== undefined && previous.tasks.length > 0 && request.reason !== undefined) {
      if (replanCount >= maxReplans) {
        throw toolError(
          "conflict",
          `Replan limit reached: ${replanCount}/${maxReplans}. ${request.reason}`,
        );
      }
      replanCount += 1;
    }
    const snapshot: TaskStoreSnapshot = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      maxReplans,
      replanCount,
      tasks,
    };
    await this.writeSnapshot(snapshot);
    return snapshot;
  }

  async updateTask(request: TaskStatusUpdate): Promise<TaskStoreSnapshot> {
    const snapshot = await this.read();
    let found = false;
    const tasks = snapshot.tasks.map((task) => {
      if (task.id !== request.id) {
        return task;
      }
      found = true;
      return {
        ...task,
        status: request.status,
        attempts:
          request.status === "in_progress" ? task.attempts + 1 : task.attempts,
        ...optionalString("notes", request.notes),
        ...optionalString("error", request.error),
        ...optionalString("result", request.result),
      };
    });
    if (!found) {
      throw toolError("not_found", `Task not found: ${request.id}`);
    }
    const next = {
      ...snapshot,
      updatedAt: new Date().toISOString(),
      tasks,
    };
    await this.writeSnapshot(next);
    return next;
  }

  async recordReplan(reason: string): Promise<TaskStoreSnapshot> {
    const snapshot = await this.read();
    if (snapshot.replanCount >= snapshot.maxReplans) {
      throw toolError(
        "conflict",
        `Replan limit reached: ${snapshot.replanCount}/${snapshot.maxReplans}. ${reason}`,
      );
    }
    const next = {
      ...snapshot,
      updatedAt: new Date().toISOString(),
      replanCount: snapshot.replanCount + 1,
    };
    await this.writeSnapshot(next);
    return next;
  }

  async nextExecutableTask(): Promise<PlanTask | undefined> {
    const snapshot = await this.read();
    const completed = new Set(
      snapshot.tasks
        .filter((task) => task.status === "completed")
        .map((task) => task.id),
    );
    return snapshot.tasks.find(
      (task) =>
        task.status === "pending" &&
        task.dependencies.every((dependency) => completed.has(dependency)),
    );
  }

  private async writeSnapshot(snapshot: TaskStoreSnapshot): Promise<void> {
    const content = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > this.maxTasksFileBytes) {
      throw toolError(
        "invalid_input",
        `tasks.json exceeds maximum size of ${this.maxTasksFileBytes} bytes`,
      );
    }
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, content, "utf8");
  }
}

async function readExistingSnapshot(
  filePath: string,
  maxBytes: number,
): Promise<TaskStoreSnapshot | undefined> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw toolError("invalid_input", `tasks.json is not a file: ${filePath}`);
    }
    if (fileStat.size > maxBytes) {
      throw toolError(
        "invalid_input",
        `tasks.json exceeds maximum size of ${maxBytes} bytes`,
      );
    }
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return parseSnapshot(parsed);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function parseSnapshot(value: unknown): TaskStoreSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.tasks)) {
    throw toolError("invalid_input", "tasks.json has an invalid schema");
  }
  const seen = new Set<string>();
  return {
    schemaVersion: 1,
    updatedAt:
      typeof value.updatedAt === "string"
        ? value.updatedAt
        : new Date().toISOString(),
    maxReplans:
      typeof value.maxReplans === "number" &&
      Number.isInteger(value.maxReplans) &&
      value.maxReplans >= 0
        ? value.maxReplans
        : 2,
    replanCount:
      typeof value.replanCount === "number" &&
      Number.isInteger(value.replanCount) &&
      value.replanCount >= 0
        ? value.replanCount
        : 0,
    tasks: value.tasks.map((task) => parseTask(task, seen)),
  };
}

function parseTask(value: unknown, seen: Set<string>): PlanTask {
  if (!isRecord(value)) {
    throw toolError("invalid_input", "tasks.json task must be an object");
  }
  const id = readRequiredString(value, "id");
  const title = readRequiredString(value, "title");
  if (seen.has(id)) {
    throw toolError("invalid_input", `Duplicate task id: ${id}`);
  }
  seen.add(id);
  const status = readTaskStatus(value.status) ?? "pending";
  return {
    id,
    title,
    ...optionalString("description", readString(value, "description")),
    dependencies: readStringArray(value, "dependencies"),
    status,
    attempts: readNonNegativeNumber(value, "attempts") ?? 0,
    ...optionalString("notes", readString(value, "notes")),
    ...optionalString("error", readString(value, "error")),
    ...optionalString("result", readString(value, "result")),
  };
}

function normalizeNewTask(task: NewPlanTask, seen: Set<string>): PlanTask {
  if (task.id.trim().length === 0 || task.title.trim().length === 0) {
    throw toolError("invalid_input", "Task id and title must not be empty");
  }
  if (seen.has(task.id)) {
    throw toolError("invalid_input", `Duplicate task id: ${task.id}`);
  }
  seen.add(task.id);
  return {
    id: task.id,
    title: task.title,
    ...optionalString("description", task.description),
    dependencies: task.dependencies ?? [],
    status: task.status ?? "pending",
    attempts: 0,
  };
}

function emptySnapshot(maxReplans: number): TaskStoreSnapshot {
  return {
    schemaVersion: 1,
    updatedAt: new Date(0).toISOString(),
    maxReplans,
    replanCount: 0,
    tasks: [],
  };
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key);
  if (value === undefined || value.length === 0) {
    throw toolError("invalid_input", `tasks.json task.${key} must be a string`);
  }
  return value;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
): readonly string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readTaskStatus(value: unknown): TaskStatus | undefined {
  return value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "failed" ||
    value === "blocked"
    ? value
    : undefined;
}

function readNonNegativeNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
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

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return resolved;
}

function optionalString<Key extends string>(
  key: Key,
  value: string | undefined,
): { readonly [Property in Key]: string } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: string;
  };
}

function toolError(code: ToolError["code"], message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
