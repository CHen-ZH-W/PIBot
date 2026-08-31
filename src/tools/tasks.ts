import type { TaskExecutionSpec, TaskStatus } from "../workspace/tasks";
import type { CodingToolDefinition, ToolInputParseResult, ToolRunContext } from "./index";

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface TasksReadInput {
  readonly includeNext?: boolean;
}

export interface TasksUpdateInput {
  readonly tasks: readonly {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
    readonly dependencies?: readonly string[];
    readonly execution?: Partial<TaskExecutionSpec>;
  }[];
  readonly reason?: string;
  readonly maxReplans?: number;
}

export interface TaskUpdateInput {
  readonly id: string;
  readonly status: TaskStatus;
  readonly notes?: string;
  readonly error?: string;
  readonly result?: string;
}

export const tasksReadTool: CodingToolDefinition<
  "tasks_read",
  TasksReadInput,
  unknown
> = {
  name: "tasks_read",
  riskLevel: "read-only",
  executionMode: "parallel",
  resolveCapabilities: (_input, context) => ({
    requirements: [
      { capability: "filesystem.read", paths: [taskStoreCapabilityPath(context)] },
      { capability: "runtime.read", resources: ["tasks"] },
    ],
  }),
  description:
    "Read the versioned Plan-and-Execute tasks.json graph and its runtime projection.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      includeNext: {
        type: "boolean",
        description: "Whether to include the next pending task whose dependencies are complete.",
      },
    },
  },
  parse(input) {
    return {
      ok: true,
      input: {
        includeNext: readBoolean(input, "includeNext") ?? false,
      },
    };
  },
  async execute(input, context) {
    const taskStore = requireTaskStore(context);
    const snapshot = await taskStore.read();
    return {
      ...snapshot,
      ...(input.includeNext
        ? { nextTask: await taskStore.nextExecutableTask() }
        : {}),
    };
  },
};

export const tasksUpdateTool: CodingToolDefinition<
  "tasks_update",
  TasksUpdateInput,
  unknown
> = {
  name: "tasks_update",
  riskLevel: "mutating",
  executionMode: "sequential",
  resolveCapabilities: (_input, context) => ({
    requirements: [
      { capability: "filesystem.write", paths: [taskStoreCapabilityPath(context)] },
      { capability: "runtime.control", resources: ["tasks"] },
    ],
  }),
  description:
    "Replace tasks.json with a structured task list. Use in Plan Mode for initial planning or limited replan.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            dependencies: { type: "array", items: { type: "string" } },
            execution: taskExecutionSchema(),
          },
          required: ["id", "title"],
        },
      },
      reason: {
        type: "string",
        description: "Why the task list is being written or replanned.",
      },
      maxReplans: {
        type: "integer",
        minimum: 0,
        description: "Maximum replans allowed after execution starts. Defaults to 2.",
      },
    },
    required: ["tasks"],
  },
  parse: parseTasksUpdateInput,
  concurrencyKey: () => "file:tasks.json",
  async execute(input, context) {
    const taskStore = requireTaskStore(context);
    const current = await taskStore.read();
    if (current.graphState === "frozen" && context.runtime?.mode !== "plan") {
      throw namedError(
        "permission_denied",
        "Frozen TaskGraph changes require Plan Mode and a new approval",
      );
    }
    const snapshot = await taskStore.writeTasks({
      tasks: input.tasks,
      ...optionalString("reason", input.reason),
      ...optionalNumber("maxReplans", input.maxReplans),
    });
    return {
      tasksPath: taskStore.filePath,
      taskCount: snapshot.tasks.length,
      graphVersion: snapshot.graphVersion,
      graphState: snapshot.graphState,
      tasksDigest: snapshot.tasksDigest,
      replanCount: snapshot.replanCount,
      maxReplans: snapshot.maxReplans,
    };
  },
};

export const taskUpdateTool: CodingToolDefinition<
  "task_update",
  TaskUpdateInput,
  unknown
> = {
  name: "task_update",
  riskLevel: "mutating",
  executionMode: "sequential",
  resolveCapabilities: (input, context) => ({
    requirements: [
      { capability: "filesystem.write", paths: [taskStoreCapabilityPath(context)] },
      {
        capability: "runtime.control",
        resources: [`task:${input.id}`],
      },
    ],
  }),
  description:
    "Update one task status only for a legacy draft graph. Frozen graph transitions are scheduler-owned.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      status: {
        type: "string",
        enum: ["pending", "in_progress", "completed", "failed", "blocked"],
      },
      notes: { type: "string" },
      error: { type: "string" },
      result: { type: "string" },
    },
    required: ["id", "status"],
  },
  parse: parseTaskUpdateInput,
  concurrencyKey: () => "file:tasks.json",
  async execute(input, context) {
    const taskStore = requireTaskStore(context);
    if ((await taskStore.read()).graphState === "frozen") {
      throw namedError(
        "permission_denied",
        "The runtime scheduler owns status transitions for a frozen TaskGraph",
      );
    }
    const snapshot = await taskStore.updateTask(input);
    return {
      tasksPath: taskStore.filePath,
      task: snapshot.tasks.find((task) => task.id === input.id),
      nextTask: await taskStore.nextExecutableTask(),
    };
  },
};

function parseTasksUpdateInput(
  input: UnknownRecord,
): ToolInputParseResult<TasksUpdateInput> {
  const value = input.tasks;
  if (!Array.isArray(value)) {
    return invalidInput("tasks_update.tasks must be an array");
  }
  const tasks: {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
    readonly dependencies?: readonly string[];
    readonly execution?: Partial<TaskExecutionSpec>;
  }[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      return invalidInput("tasks_update.tasks items must be objects");
    }
    const id = readString(item, "id");
    const title = readString(item, "title");
    if (id === undefined || title === undefined) {
      return invalidInput("tasks_update task id/title must be strings");
    }
    tasks.push({
      id,
      title,
      ...optionalString("description", readString(item, "description")),
      dependencies: readStringArray(item, "dependencies"),
      ...optionalExecution("execution", readTaskExecution(item, "execution")),
    });
  }
  return {
    ok: true,
    input: {
      tasks,
      ...optionalString("reason", readString(input, "reason")),
      ...optionalNumber("maxReplans", readNumber(input, "maxReplans")),
    },
  };
}

function taskExecutionSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["child_agent"] },
      role: {
        type: "string",
        enum: ["explore", "review", "test", "implement"],
      },
      readOnly: { type: "boolean" },
      timeoutMs: { type: "integer", minimum: 1 },
      maxToolCalls: { type: "integer", minimum: 1 },
      maxTokens: { type: "integer", minimum: 1 },
    },
  };
}

function readTaskExecution(
  record: UnknownRecord,
  key: string,
): Partial<TaskExecutionSpec> | undefined {
  const value = record[key];
  if (!isRecord(value)) return undefined;
  const role = readString(value, "role");
  const readOnly = readBoolean(value, "readOnly");
  return {
    ...(value.kind === "child_agent" ? { kind: value.kind } : {}),
    ...(role === "explore" || role === "review" || role === "test" ||
        role === "implement" ? { role } : {}),
    ...(readOnly === undefined ? {} : { readOnly }),
    ...optionalNumber("timeoutMs", readPositiveInteger(value, "timeoutMs")),
    ...optionalNumber(
      "maxToolCalls",
      readPositiveInteger(value, "maxToolCalls"),
    ),
    ...optionalNumber("maxTokens", readPositiveInteger(value, "maxTokens")),
  };
}

function readPositiveInteger(record: UnknownRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : undefined;
}

function optionalExecution<Key extends string>(
  key: Key,
  value: Partial<TaskExecutionSpec> | undefined,
): { readonly [Property in Key]: Partial<TaskExecutionSpec> } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: Partial<TaskExecutionSpec>;
  };
}

function parseTaskUpdateInput(
  input: UnknownRecord,
): ToolInputParseResult<TaskUpdateInput> {
  const id = readString(input, "id");
  const status = readTaskStatus(input, "status");
  if (id === undefined || status === undefined) {
    return invalidInput("task_update.id and task_update.status are required");
  }
  return {
    ok: true,
    input: {
      id,
      status,
      ...optionalString("notes", readString(input, "notes")),
      ...optionalString("error", readString(input, "error")),
      ...optionalString("result", readString(input, "result")),
    },
  };
}

function requireTaskStore(context: ToolRunContext) {
  if (context.tasks === undefined) {
    const error = new Error("TaskStore is not available");
    error.name = "invalid_input";
    throw error;
  }
  return context.tasks;
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

function readTaskStatus(
  record: UnknownRecord,
  key: string,
): TaskStatus | undefined {
  const value = record[key];
  return value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "failed" ||
    value === "blocked"
    ? value
    : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function invalidInput(message: string): { readonly ok: false; readonly message: string } {
  return { ok: false, message };
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function taskStoreCapabilityPath(context: ToolRunContext): string {
  const filePath = context.tasks?.filePath;
  if (filePath === undefined) return "tasks.json";
  const prefix = `${context.workspaceRoot.replace(/[\\/]+$/u, "")}/`;
  return filePath.startsWith(prefix)
    ? filePath.slice(prefix.length).replace(/\\/gu, "/")
    : "tasks.json";
}
