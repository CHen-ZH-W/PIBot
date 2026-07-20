import { stat } from "node:fs/promises";
import * as path from "node:path";

export interface StartupConfigValidationInput {
  readonly slackAppToken: string | undefined;
  readonly slackBotToken: string | undefined;
  readonly modelApiKey: string | undefined;
  readonly modelApiKeyEnvVar: string;
  readonly workspaceRoot: string;
  readonly sandboxLabel: string;
}

/**
 * 职责：启动时校验必需配置能支撑 Slack、模型、workspace 和 sandbox。
 * 不应承担：创建 Slack client、调用模型、修改环境变量、决定业务默认值。
 */
export async function validateStartupConfig(
  input: StartupConfigValidationInput,
): Promise<void> {
  const errors: string[] = [];

  if (isBlank(input.slackAppToken)) {
    errors.push("SLACK_APP_TOKEN is required");
  }

  if (isBlank(input.slackBotToken)) {
    errors.push("SLACK_BOT_TOKEN is required");
  }

  if (isBlank(input.modelApiKey)) {
    errors.push(`${input.modelApiKeyEnvVar} is required`);
  }

  const workspaceRoot = path.resolve(input.workspaceRoot);
  const workspaceStat = await stat(workspaceRoot).catch((error: unknown) => {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }

    throw error;
  });
  if (workspaceStat === undefined) {
    errors.push(`WORKSPACE_ROOT does not exist: ${workspaceRoot}`);
  } else if (!workspaceStat.isDirectory()) {
    errors.push(`WORKSPACE_ROOT must be a directory: ${workspaceRoot}`);
  }

  if (input.sandboxLabel.trim().length === 0) {
    errors.push("sandbox executor must be configured");
  }

  if (errors.length > 0) {
    throw new Error(`Invalid startup configuration:\n- ${errors.join("\n- ")}`);
  }
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
