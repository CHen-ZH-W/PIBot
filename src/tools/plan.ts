import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolError } from "../core/tools";
import {
  enterPlanMode,
  exitPlanMode,
  markPlanUpdated,
} from "../runtime/mode";
import {
  assertContentSize,
  resolveWorkspacePath,
} from "../workspace/path-boundary";
import type { NewPlanTask } from "../workspace/tasks";
import type { CodingToolDefinition, ToolInputParseResult, ToolRunContext } from "./index";

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface EnterPlanModeInput {
  readonly goal?: string;
}

export interface UpdatePlanInput {
  readonly content: string;
  readonly tasks?: readonly NewPlanTask[];
  readonly reason?: string;
}

export interface ExitPlanModeInput {
  readonly summary?: string;
}

export const enterPlanModeTool: CodingToolDefinition<
  "enter_plan_mode",
  EnterPlanModeInput,
  unknown
> = {
  name: "enter_plan_mode",
  riskLevel: "read-only",
  executionMode: "sequential",
  description:
    "Switch the current run into Plan Mode before making changes. Plan Mode permits read-only exploration plus plan/task control tools.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      goal: {
        type: "string",
        description: "Optional concise goal for the planning session.",
      },
    },
  },
  parse(input) {
    return {
      ok: true,
      input: {
        ...optionalString("goal", readString(input, "goal")),
      },
    };
  },
  async execute(input, context, signal) {
    const runtime = requireRuntime(context);
    if (runtime.mode !== "plan") {
      const decision = await runtime.plan.approval?.requestEnterPlanMode?.(
        {
          ...optionalString("goal", input.goal),
        },
        signal,
      );
      if (decision !== undefined && !decision.approved) {
        throw toolError(
          "permission_denied",
          `Plan Mode was not approved: ${decision.reason}`,
        );
      }
    }
    enterPlanMode(runtime);
    return {
      mode: runtime.mode,
      goal: input.goal ?? "",
      planPath: runtime.plan.planPath,
      message:
        "Plan Mode is active. Explore with read-only tools, keep PLAN.md updated, then call exit_plan_mode for approval.",
    };
  },
};

export const updatePlanTool: CodingToolDefinition<
  "update_plan",
  UpdatePlanInput,
  unknown
> = {
  name: "update_plan",
  riskLevel: "mutating",
  executionMode: "sequential",
  description:
    "Save or replace the workspace PLAN.md during Plan Mode. Optionally writes the structured tasks.json task list for Plan-and-Execute.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      content: {
        type: "string",
        description: "Complete Markdown plan to save to PLAN.md.",
      },
      tasks: {
        type: "array",
        description:
          "Optional structured task list for tasks.json. Include stable ids, titles and dependencies.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            dependencies: {
              type: "array",
              items: { type: "string" },
            },
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
        description: "Why the plan changed.",
      },
    },
    required: ["content"],
  },
  parse: parseUpdatePlanInput,
  concurrencyKey: () => "file:PLAN.md",
  async execute(input, context) {
    const runtime = requireRuntime(context);
    if (runtime.mode !== "plan") {
      throw toolError("permission_denied", "update_plan requires AgentMode=plan");
    }

    const planPath = await writePlanMarkdown(context, runtime.plan.planPath, input.content);
    let tasks;
    if (input.tasks !== undefined) {
      const taskStore = requireTaskStore(context);
      tasks = await taskStore.writeTasks({
        tasks: input.tasks,
        ...optionalString("reason", input.reason),
      });
    }
    markPlanUpdated(runtime);
    return {
      mode: runtime.mode,
      planPath,
      bytes: Buffer.byteLength(input.content, "utf8"),
      updatedAt: runtime.plan.updatedAt,
      ...(tasks === undefined
        ? {}
        : {
            tasksPath: context.tasks?.filePath,
            taskCount: tasks.tasks.length,
          }),
    };
  },
};

export const exitPlanModeTool: CodingToolDefinition<
  "exit_plan_mode",
  ExitPlanModeInput,
  unknown
> = {
  name: "exit_plan_mode",
  riskLevel: "mutating",
  executionMode: "sequential",
  description:
    "Request user approval to leave Plan Mode. Execution can continue only after the saved PLAN.md is approved.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: {
        type: "string",
        description: "Concise summary of the plan the user should approve.",
      },
    },
  },
  parse(input) {
    return {
      ok: true,
      input: {
        ...optionalString("summary", readString(input, "summary")),
      },
    };
  },
  async execute(input, context, signal) {
    const runtime = requireRuntime(context);
    if (runtime.mode !== "plan") {
      return {
        mode: runtime.mode,
        approved: true,
        message: "Already in execute mode.",
      };
    }
    const planMarkdown = await readPlanMarkdown(
      context,
      runtime.plan.planPath,
    );
    const approval = runtime.plan.approval;
    if (approval === undefined) {
      throw toolError(
        "permission_denied",
        "exit_plan_mode requires a Plan Mode approval requester",
      );
    }

    const decision = await approval.requestExitPlanMode(
      {
        planPath: runtime.plan.planPath,
        ...optionalString("summary", input.summary),
        ...optionalString("planMarkdown", planMarkdown),
      },
      signal,
    );
    if (!decision.approved) {
      throw toolError(
        "permission_denied",
        `Plan was not approved: ${decision.reason}`,
      );
    }

    exitPlanMode(runtime, input.summary);
    return {
      mode: runtime.mode,
      approved: true,
      approvedAt: runtime.plan.approvedAt,
      planPath: runtime.plan.planPath,
    };
  },
};

function parseUpdatePlanInput(
  input: UnknownRecord,
): ToolInputParseResult<UpdatePlanInput> {
  const content = readString(input, "content");
  if (content === undefined) {
    return invalidInput("update_plan.content must be a string");
  }
  const tasks = readOptionalTasks(input);
  if (tasks === null) {
    return invalidInput(
      "update_plan.tasks must contain objects with string id/title fields",
    );
  }
  return {
    ok: true,
    input: {
      content,
      ...(tasks === undefined ? {} : { tasks }),
      ...optionalString("reason", readString(input, "reason")),
    },
  };
}

async function writePlanMarkdown(
  context: ToolRunContext,
  planPath: string,
  content: string,
): Promise<string> {
  assertContentSize(content, context.maxFileBytes, "PLAN.md content");
  const filePath = await resolveWorkspacePath(context.workspaceRoot, planPath, {
    access: "mutate",
    allowMissing: true,
  });
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return planPath;
}

async function readPlanMarkdown(
  context: ToolRunContext,
  planPath: string,
): Promise<string | undefined> {
  try {
    const filePath = await resolveWorkspacePath(context.workspaceRoot, planPath, {
      access: "read",
    });
    return await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "not_found") {
      return undefined;
    }
    throw error;
  }
}

function requireRuntime(context: ToolRunContext) {
  if (context.runtime === undefined) {
    throw toolError("invalid_input", "Runtime state is not available");
  }
  return context.runtime;
}

function requireTaskStore(context: ToolRunContext) {
  if (context.tasks === undefined) {
    throw toolError("invalid_input", "TaskStore is not available");
  }
  return context.tasks;
}

function readOptionalTasks(
  input: UnknownRecord,
): readonly NewPlanTask[] | undefined | null {
  const value = input.tasks;
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const tasks: NewPlanTask[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      return null;
    }
    const id = readString(item, "id");
    const title = readString(item, "title");
    if (id === undefined || title === undefined) {
      return null;
    }
    const status = readString(item, "status");
    tasks.push({
      id,
      title,
      ...optionalString("description", readString(item, "description")),
      dependencies: readStringArray(item, "dependencies"),
      ...(isTaskStatus(status) ? { status } : {}),
    });
  }
  return tasks;
}

function isTaskStatus(status: string | undefined): status is NonNullable<NewPlanTask["status"]> {
  return status === "pending" ||
    status === "in_progress" ||
    status === "completed" ||
    status === "failed" ||
    status === "blocked";
}

function readString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
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

function optionalString<Key extends string>(
  key: Key,
  value: string | undefined,
): { readonly [Property in Key]: string } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: string;
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
