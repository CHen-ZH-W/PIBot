import type { TaskStatus } from "../workspace/tasks";
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
    readonly status?: TaskStatus;
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
  description:
    "Read the structured Plan-and-Execute tasks.json file and optionally return the next executable task.",
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
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "failed", "blocked"],
            },
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
    const snapshot = await taskStore.writeTasks({
      tasks: input.tasks,
      ...optionalString("reason", input.reason),
      ...optionalNumber("maxReplans", input.maxReplans),
    });
    return {
      tasksPath: taskStore.filePath,
      taskCount: snapshot.tasks.length,
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
  description:
    "Update one task status in tasks.json as the executor works through the approved plan.",
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
    readonly status?: TaskStatus;
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
    const status = readTaskStatus(item, "status");
    tasks.push({
      id,
      title,
      ...optionalString("description", readString(item, "description")),
      dependencies: readStringArray(item, "dependencies"),
      ...(status === undefined ? {} : { status }),
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
