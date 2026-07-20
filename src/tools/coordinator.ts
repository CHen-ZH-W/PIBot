import {
  enterCoordinatorMode,
  exitCoordinatorMode,
} from "../runtime/mode";
import type { CodingToolDefinition, ToolRunContext } from "./index";

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface EnterCoordinatorModeInput {
  readonly goal?: string;
}

export interface ExitCoordinatorModeInput {
  readonly summary?: string;
}

export const enterCoordinatorModeTool: CodingToolDefinition<
  "enter_coordinator_mode",
  EnterCoordinatorModeInput,
  unknown
> = {
  name: "enter_coordinator_mode",
  riskLevel: "read-only",
  executionMode: "sequential",
  description:
    "Switch the current run into Coordinator Mode. The main agent coordinates tmux child agents and summarizes results instead of directly editing files.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      goal: {
        type: "string",
        description: "Optional concise goal for the multi-agent coordination session.",
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
  execute(input, context) {
    const runtime = requireRuntime(context);
    enterCoordinatorMode(runtime, input.goal);
    return {
      mode: runtime.mode,
      goal: runtime.coordinator.goal ?? "",
      enteredAt: runtime.coordinator.enteredAt,
      message:
        "Coordinator Mode is active. Spawn focused child agents, observe tmux panes, collect result.md/usage.json, and summarize without directly mutating files.",
    };
  },
};

export const exitCoordinatorModeTool: CodingToolDefinition<
  "exit_coordinator_mode",
  ExitCoordinatorModeInput,
  unknown
> = {
  name: "exit_coordinator_mode",
  riskLevel: "read-only",
  executionMode: "sequential",
  description:
    "Leave Coordinator Mode and return the current run to normal Execute Mode.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: {
        type: "string",
        description: "Optional concise summary of what was coordinated.",
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
  execute(input, context) {
    const runtime = requireRuntime(context);
    exitCoordinatorMode(runtime);
    return {
      mode: runtime.mode,
      exitedAt: runtime.coordinator.exitedAt,
      summary: input.summary ?? "",
      message: "Coordinator Mode is inactive. Execute Mode is active.",
    };
  },
};

function requireRuntime(context: ToolRunContext) {
  if (context.runtime === undefined) {
    const error = new Error("Coordinator Mode requires runtime state");
    error.name = "invalid_input";
    throw error;
  }
  return context.runtime;
}

function readString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function optionalString<Key extends string>(
  key: Key,
  value: string | undefined,
): { readonly [Property in Key]: string } | object {
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: string;
  };
}
