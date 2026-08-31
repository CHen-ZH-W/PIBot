import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ToolError } from "../core/tools";
import { assertInside } from "./path-boundary";

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "blocked";

export type TaskGraphState = "draft" | "frozen";

export interface TaskExecutionSpec {
  readonly kind: "child_agent";
  readonly role: "explore" | "review" | "test" | "implement";
  readonly readOnly: boolean;
  readonly timeoutMs?: number;
  readonly maxToolCalls?: number;
  readonly maxTokens?: number;
}

export interface PlanTask {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly dependencies: readonly string[];
  readonly execution: TaskExecutionSpec;
  readonly status: TaskStatus;
  readonly attempts: number;
  readonly notes?: string;
  readonly error?: string;
  readonly result?: string;
}

export interface TaskStoreSnapshot {
  readonly schemaVersion: 1;
  readonly updatedAt: string;
  readonly graphVersion: number;
  readonly graphState: TaskGraphState;
  readonly tasksDigest: string;
  readonly planDigest?: string;
  readonly frozenAt?: string;
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
  readonly execution?: Partial<TaskExecutionSpec> & {
    readonly kind?: "child_agent";
  };
}

export interface TaskStatusUpdate {
  readonly id: string;
  readonly status: TaskStatus;
  readonly notes?: string;
  readonly error?: string;
  readonly result?: string;
  readonly attempts?: number;
}

export interface TaskGraphInspection {
  readonly graphVersion: number;
  readonly graphState: TaskGraphState;
  readonly tasksDigest: string;
  readonly taskCount: number;
  readonly writeTaskCount: number;
}

export interface FreezeTaskGraphRequest {
  readonly planDigest: string;
  readonly expectedTasksDigest: string;
}

export interface TaskGraphIdentity {
  readonly graphVersion: number;
  readonly tasksDigest: string;
}

export interface TaskStore {
  readonly filePath: string;
  read(): Promise<TaskStoreSnapshot>;
  writeTasks(request: TaskStoreWriteRequest): Promise<TaskStoreSnapshot>;
  updateTask(request: TaskStatusUpdate): Promise<TaskStoreSnapshot>;
  syncExecutionState(
    updates: Readonly<Record<string, TaskStatusUpdate>>,
    expectedGraph?: TaskGraphIdentity,
  ): Promise<TaskStoreSnapshot>;
  recordReplan(reason: string): Promise<TaskStoreSnapshot>;
  nextExecutableTask(): Promise<PlanTask | undefined>;
  inspectGraph(): Promise<TaskGraphInspection>;
  freezeGraph(request: FreezeTaskGraphRequest): Promise<TaskStoreSnapshot>;
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
    return enqueueTaskStoreMutation(this.filePath, async () => {
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
      const proposed = request.tasks.map((task) => normalizeNewTask(task, seen));
      const tasks = preserveCompletedTasks(proposed, previous?.tasks ?? []);
      validateTaskGraph(tasks);
      const maxReplans =
        request.maxReplans ?? previous?.maxReplans ?? this.defaultMaxReplans;
      let replanCount = previous?.replanCount ?? 0;
      if (
        previous?.graphState === "frozen" &&
        previous.tasks.length > 0
      ) {
        if (request.reason === undefined) {
          throw toolError(
            "conflict",
            "Frozen tasks.json requires an explicit replan reason before replacement",
          );
        }
        if (replanCount >= maxReplans) {
          throw toolError(
            "conflict",
            `Replan limit reached: ${replanCount}/${maxReplans}. ${request.reason}`,
          );
        }
        replanCount += 1;
      }
      const graphVersion = previous?.graphState === "frozen"
        ? previous.graphVersion + 1
        : previous?.graphVersion ?? 1;
      const snapshot: TaskStoreSnapshot = {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        graphVersion,
        graphState: "draft",
        tasksDigest: fingerprintTasks(tasks),
        maxReplans,
        replanCount,
        tasks,
      };
      await this.writeSnapshot(snapshot);
      return snapshot;
    });
  }

  async updateTask(request: TaskStatusUpdate): Promise<TaskStoreSnapshot> {
    return enqueueTaskStoreMutation(this.filePath, async () => {
      const snapshot = await this.read();
      if (snapshot.graphState === "frozen") {
        throw toolError(
          "permission_denied",
          "The runtime scheduler owns status transitions for a frozen TaskGraph",
        );
      }
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
    });
  }

  async syncExecutionState(
    updates: Readonly<Record<string, TaskStatusUpdate>>,
    expectedGraph?: TaskGraphIdentity,
  ): Promise<TaskStoreSnapshot> {
    return enqueueTaskStoreMutation(this.filePath, async () => {
      const snapshot = await this.read();
      if (snapshot.graphState === "frozen" && expectedGraph === undefined) {
        throw toolError(
          "permission_denied",
          "Frozen TaskGraph synchronization requires its approved graph identity",
        );
      }
      if (
        expectedGraph !== undefined &&
        (snapshot.graphState !== "frozen" ||
          snapshot.graphVersion !== expectedGraph.graphVersion ||
          snapshot.tasksDigest !== expectedGraph.tasksDigest)
      ) {
        return snapshot;
      }
      const now = new Date().toISOString();
      const tasks = snapshot.tasks.map((task) => {
        const update = updates[task.id];
        if (update === undefined) {
          return task;
        }
        const { error: _error, result: previousResult, ...base } = task;
        return {
          ...base,
          status: update.status,
          attempts: update.attempts ?? task.attempts,
          ...optionalString("notes", update.notes),
          ...optionalString("error", update.error),
          ...optionalString(
            "result",
            update.result ??
              (update.status === "completed" || update.status === "failed" ||
                  update.status === "blocked"
                ? previousResult
                : undefined),
          ),
        };
      });
      const next = { ...snapshot, updatedAt: now, tasks };
      await this.writeSnapshot(next);
      return next;
    });
  }

  async recordReplan(reason: string): Promise<TaskStoreSnapshot> {
    return enqueueTaskStoreMutation(this.filePath, async () => {
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
    });
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

  async inspectGraph(): Promise<TaskGraphInspection> {
    const snapshot = await this.read();
    validateTaskGraph(snapshot.tasks);
    const actualDigest = fingerprintTasks(snapshot.tasks);
    if (actualDigest !== snapshot.tasksDigest) {
      throw toolError(
        "conflict",
        `${snapshot.graphState === "frozen" ? "Frozen" : "Draft"} tasks.json specification no longer matches its recorded digest`,
      );
    }
    return {
      graphVersion: snapshot.graphVersion,
      graphState: snapshot.graphState,
      tasksDigest: snapshot.tasksDigest,
      taskCount: snapshot.tasks.length,
      writeTaskCount: snapshot.tasks.filter((task) => !task.execution.readOnly).length,
    };
  }

  async freezeGraph(request: FreezeTaskGraphRequest): Promise<TaskStoreSnapshot> {
    return enqueueTaskStoreMutation(this.filePath, async () => {
      const snapshot = await this.read();
      validateTaskGraph(snapshot.tasks);
      const tasksDigest = fingerprintTasks(snapshot.tasks);
      if (
        request.expectedTasksDigest !== snapshot.tasksDigest ||
        request.expectedTasksDigest !== tasksDigest
      ) {
        throw toolError(
          "conflict",
          "tasks.json changed while plan approval was pending; approve the new graph",
        );
      }
      const now = new Date().toISOString();
      const frozen: TaskStoreSnapshot = {
        ...snapshot,
        updatedAt: now,
        graphState: "frozen",
        tasksDigest,
        planDigest: request.planDigest,
        frozenAt: now,
      };
      await this.writeSnapshot(frozen);
      return frozen;
    });
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
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, content, "utf8");
      await rename(temporaryPath, this.filePath);
    } catch (error: unknown) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

const taskStoreMutationQueues = new Map<string, Promise<void>>();

function enqueueTaskStoreMutation<T>(
  filePath: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = taskStoreMutationQueues.get(filePath) ?? Promise.resolve();
  const next = previous.then(work, work);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  taskStoreMutationQueues.set(filePath, tail);
  return next.finally(() => {
    if (taskStoreMutationQueues.get(filePath) === tail) {
      taskStoreMutationQueues.delete(filePath);
    }
  });
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
  const tasks = value.tasks.map((task) => parseTask(task, seen));
  validateTaskGraph(tasks);
  const graphVersion = readPositiveNumber(value, "graphVersion") ?? 1;
  const graphState = value.graphState === "frozen" ? "frozen" : "draft";
  return {
    schemaVersion: 1,
    updatedAt:
      typeof value.updatedAt === "string"
        ? value.updatedAt
        : new Date().toISOString(),
    graphVersion,
    graphState,
    tasksDigest: typeof value.tasksDigest === "string"
      ? value.tasksDigest
      : fingerprintTasks(tasks),
    ...optionalString("planDigest", readString(value, "planDigest")),
    ...optionalString("frozenAt", readString(value, "frozenAt")),
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
    tasks,
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
    execution: parseExecutionSpec(value.execution),
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
    execution: normalizeExecutionSpec(task.execution),
    status: "pending",
    attempts: 0,
  };
}

function preserveCompletedTasks(
  proposed: readonly PlanTask[],
  previous: readonly PlanTask[],
): readonly PlanTask[] {
  const completed = new Map(
    previous
      .filter((task) => task.status === "completed")
      .map((task) => [task.id, task]),
  );
  return proposed.map((task) => {
    const prior = completed.get(task.id);
    if (prior === undefined || fingerprintTask(prior) !== fingerprintTask(task)) {
      return task;
    }
    return {
      ...task,
      status: "completed",
      attempts: prior.attempts,
      ...optionalString("notes", prior.notes),
      ...optionalString("result", prior.result),
    };
  });
}

function emptySnapshot(maxReplans: number): TaskStoreSnapshot {
  return {
    schemaVersion: 1,
    updatedAt: new Date(0).toISOString(),
    graphVersion: 1,
    graphState: "draft",
    tasksDigest: fingerprintTasks([]),
    maxReplans,
    replanCount: 0,
    tasks: [],
  };
}

function parseExecutionSpec(value: unknown): TaskExecutionSpec {
  if (!isRecord(value)) {
    return defaultExecutionSpec();
  }
  return normalizeExecutionSpec({
    ...(value.kind === "child_agent" ? { kind: value.kind } : {}),
    ...(isChildAgentRole(value.role) ? { role: value.role } : {}),
    ...(typeof value.readOnly === "boolean" ? { readOnly: value.readOnly } : {}),
    ...optionalNumber("timeoutMs", readPositiveNumber(value, "timeoutMs")),
    ...optionalNumber("maxToolCalls", readPositiveNumber(value, "maxToolCalls")),
    ...optionalNumber("maxTokens", readPositiveNumber(value, "maxTokens")),
  });
}

function normalizeExecutionSpec(
  value: NewPlanTask["execution"],
): TaskExecutionSpec {
  return {
    kind: "child_agent",
    role: value?.role ?? "explore",
    readOnly: value?.readOnly ?? true,
    ...optionalNumber("timeoutMs", positiveOptional(value?.timeoutMs, "timeoutMs")),
    ...optionalNumber(
      "maxToolCalls",
      positiveOptional(value?.maxToolCalls, "maxToolCalls"),
    ),
    ...optionalNumber("maxTokens", positiveOptional(value?.maxTokens, "maxTokens")),
  };
}

function defaultExecutionSpec(): TaskExecutionSpec {
  return { kind: "child_agent", role: "explore", readOnly: true };
}

function validateTaskGraph(tasks: readonly PlanTask[]): void {
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    if (new Set(task.dependencies).size !== task.dependencies.length) {
      throw toolError(
        "invalid_input",
        `Task ${task.id} contains duplicate dependencies`,
      );
    }
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) {
        throw toolError(
          "invalid_input",
          `Task ${task.id} depends on missing task ${dependency}`,
        );
      }
      if (dependency === task.id) {
        throw toolError("invalid_input", `Task ${task.id} cannot depend on itself`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) {
      throw toolError("invalid_input", `tasks.json contains a dependency cycle at ${taskId}`);
    }
    visiting.add(taskId);
    for (const dependency of byId.get(taskId)?.dependencies ?? []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.id);
}

function fingerprintTasks(tasks: readonly PlanTask[]): string {
  return createHash("sha256").update(JSON.stringify(tasks.map(taskDefinition)))
    .digest("hex");
}

function fingerprintTask(task: PlanTask): string {
  return createHash("sha256").update(JSON.stringify(taskDefinition(task))).digest("hex");
}

function taskDefinition(task: PlanTask): Readonly<Record<string, unknown>> {
  return {
    id: task.id,
    title: task.title,
    ...(task.description === undefined ? {} : { description: task.description }),
    dependencies: [...task.dependencies],
    execution: task.execution,
  };
}

function isChildAgentRole(
  value: unknown,
): value is TaskExecutionSpec["role"] {
  return value === "explore" || value === "review" || value === "test" ||
    value === "implement";
}

function positiveOptional(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw toolError("invalid_input", `Task execution ${label} must be a positive integer`);
  }
  return value;
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

function readPositiveNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 1
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

function optionalNumber<Key extends string>(
  key: Key,
  value: number | undefined,
): { readonly [Property in Key]: number } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: number;
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
