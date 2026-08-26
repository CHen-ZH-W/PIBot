export interface ReflectionWorkflowOptions {
  readonly enabled: boolean;
  readonly maxFixAttempts?: number;
  readonly maxSteps?: number;
  readonly verifyCommands?: readonly string[];
}

export type ReflectionStatus = "passed" | "fixed" | "blocked" | "unknown";

export interface BuildReflectionPromptOptions {
  readonly attempt: number;
  readonly maxFixAttempts: number;
  readonly userGoal: string;
  readonly latestAssistantText: string;
  readonly verifyCommands: readonly string[];
}

export function buildReflectionPrompt(
  options: BuildReflectionPromptOptions,
): string {
  const commandGuidance =
    options.verifyCommands.length === 0
      ? [
          "Identify the repository's own verification workflow from its files, docs, and existing conventions.",
          "Prefer targeted tests for the changed behavior, then broader checks such as the existing test suite, static analysis, type checks, build checks, lint checks, or diff review when available.",
          "Do not assume a language, framework, or package manager. If no command is appropriate or safe to run, explain why.",
        ].join(" ")
      : [
          "Run these repository-configured verification commands unless clearly impossible or unsafe:",
          ...options.verifyCommands.map((command) => `- ${command}`),
        ].join("\n");

  return [
    "Reflection pass:",
    `Original user goal:\n${options.userGoal}`,
    `Latest assistant result:\n${options.latestAssistantText}`,
    commandGuidance,
    "Workflow:",
    "1. Inspect the current workspace state and changed files.",
    "2. Identify the new or modified behavior and check whether it has targeted validation. Add or update tests/examples/checks only when the repository already supports an appropriate way to do so.",
    "3. Run the most relevant targeted verification for the changed behavior when available.",
    "4. Run or reason through broader regression validation for existing behavior using the repository's established checks when available.",
    "5. Critique failures, missing tests, unsafe changes, or mismatches with the user goal.",
    "6. If a concrete fix is needed and the fix-attempt budget remains, make the smallest safe fix.",
    "7. Verify again after a fix when feasible.",
    "If targeted tests or regression checks cannot be added or run, state the concrete blocker and remaining risk.",
    `Fix attempt budget: ${options.attempt}/${options.maxFixAttempts}.`,
    "End your final assistant message with exactly one marker line:",
    "reflection_status: passed",
    "reflection_status: fixed",
    "reflection_status: blocked",
  ].join("\n\n");
}

export function parseReflectionStatus(text: string): ReflectionStatus {
  const match = /reflection_status:\s*(passed|fixed|blocked)\s*$/imu.exec(text);
  if (match === null) {
    return "unknown";
  }
  return match[1] as ReflectionStatus;
}

export function normalizeMaxFixAttempts(value: number | undefined): number {
  if (value === undefined) {
    return 2;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("reflection.maxFixAttempts must be a non-negative integer");
  }
  return value;
}
