import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ChannelSessionKey } from "../core/session";
import type { ChannelWorkspaceStore, JsonObject } from "../workspace/store";
import {
  createAgentRuntimeStateFromSnapshot,
  snapshotAgentRuntimeState,
  type AgentMode,
  type AgentRuntimeState,
  type AgentRuntimeStateSnapshot,
} from "./mode";

const RUNTIME_STATE_FILE = "runtime-state.json";

export async function readChannelRuntimeState(
  store: ChannelWorkspaceStore,
  key: ChannelSessionKey,
): Promise<AgentRuntimeState> {
  const snapshot =
    await readPersistedRuntimeStateSnapshot(store, key) ??
    await inferRuntimeStateSnapshotFromContext(store, key);
  return createAgentRuntimeStateFromSnapshot(snapshot);
}

export async function writeChannelRuntimeState(
  store: ChannelWorkspaceStore,
  key: ChannelSessionKey,
  state: AgentRuntimeState,
): Promise<void> {
  const paths = await store.ensureChannelDirectory(key);
  const record = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    state: snapshotAgentRuntimeState(state),
  };
  await writeFile(
    path.join(paths.channelDir, RUNTIME_STATE_FILE),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

async function readPersistedRuntimeStateSnapshot(
  store: ChannelWorkspaceStore,
  key: ChannelSessionKey,
): Promise<AgentRuntimeStateSnapshot | undefined> {
  const paths = store.getPaths(key);
  const filePath = path.join(paths.channelDir, RUNTIME_STATE_FILE);
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }

  const parsed = parseJsonObject(content);
  return runtimeStateRecordSnapshot(parsed);
}

async function inferRuntimeStateSnapshotFromContext(
  store: ChannelWorkspaceStore,
  key: ChannelSessionKey,
): Promise<AgentRuntimeStateSnapshot | undefined> {
  const entries = await store.readContextEntries(key);
  let snapshot: AgentRuntimeStateSnapshot | undefined;
  for (const entry of entries) {
    const record = entry.record;
    if (record.type !== "context_message" || record.role !== "tool") {
      continue;
    }
    const content = record.content;
    if (typeof content !== "string") {
      continue;
    }
    const payload = parseJsonObject(content);
    if (payload?.ok !== true || !isJsonObject(payload.output)) {
      continue;
    }
    snapshot = applyToolOutputSnapshot(
      snapshot,
      payload.output,
      typeof record.createdAt === "string" ? record.createdAt : undefined,
    );
  }
  return snapshot;
}

function applyToolOutputSnapshot(
  current: AgentRuntimeStateSnapshot | undefined,
  output: JsonObject,
  createdAt: string | undefined,
): AgentRuntimeStateSnapshot | undefined {
  const mode = readMode(output.mode);
  if (mode === undefined) {
    return current;
  }

  if (mode === "plan") {
    const updatedAt = readString(output.updatedAt) ?? current?.plan?.updatedAt;
    return {
      mode,
      plan: {
        planPath: readString(output.planPath) ?? current?.plan?.planPath ?? "PLAN.md",
        ...optionalString("enteredAt", current?.plan?.enteredAt ?? createdAt),
        ...optionalString("updatedAt", updatedAt),
        ...optionalString("approvedAt", current?.plan?.approvedAt),
        ...optionalString("approvalSummary", current?.plan?.approvalSummary),
      },
      ...(current?.coordinator === undefined
        ? {}
        : { coordinator: current.coordinator }),
    };
  }

  if (mode === "coordinator") {
    const enteredAt =
      readString(output.enteredAt) ?? current?.coordinator?.enteredAt ?? createdAt;
    return {
      mode,
      ...(current?.plan === undefined ? {} : { plan: current.plan }),
      coordinator: {
        ...optionalString("enteredAt", enteredAt),
        ...optionalString("exitedAt", current?.coordinator?.exitedAt),
        ...optionalString("goal", readString(output.goal) ?? current?.coordinator?.goal),
      },
    };
  }

  const approvedAt = readString(output.approvedAt) ?? current?.plan?.approvedAt;
  const exitedAt = readString(output.exitedAt) ?? current?.coordinator?.exitedAt;
  return {
    mode,
    plan: {
      ...optionalString("planPath", current?.plan?.planPath),
      ...optionalString("enteredAt", current?.plan?.enteredAt),
      ...optionalString("updatedAt", current?.plan?.updatedAt),
      ...optionalString("approvedAt", approvedAt),
      ...optionalString("approvalSummary", current?.plan?.approvalSummary),
    },
    coordinator: {
      ...optionalString("enteredAt", current?.coordinator?.enteredAt),
      ...optionalString("exitedAt", exitedAt),
      ...optionalString("goal", current?.coordinator?.goal),
    },
  };
}

function runtimeStateRecordSnapshot(
  value: JsonObject | undefined,
): AgentRuntimeStateSnapshot | undefined {
  if (value?.schemaVersion !== 1 || !isJsonObject(value.state)) {
    return undefined;
  }
  return parseSnapshot(value.state);
}

function parseSnapshot(
  value: JsonObject,
): AgentRuntimeStateSnapshot | undefined {
  const mode = readMode(value.mode);
  if (mode === undefined) {
    return undefined;
  }
  return {
    mode,
    ...(isJsonObject(value.plan)
      ? {
          plan: {
            ...optionalString("planPath", readString(value.plan.planPath)),
            ...optionalString("enteredAt", readString(value.plan.enteredAt)),
            ...optionalString("updatedAt", readString(value.plan.updatedAt)),
            ...optionalString("approvedAt", readString(value.plan.approvedAt)),
            ...optionalString(
              "approvalSummary",
              readString(value.plan.approvalSummary),
            ),
          },
        }
      : {}),
    ...(isJsonObject(value.coordinator)
      ? {
          coordinator: {
            ...optionalString("enteredAt", readString(value.coordinator.enteredAt)),
            ...optionalString("exitedAt", readString(value.coordinator.exitedAt)),
            ...optionalString("goal", readString(value.coordinator.goal)),
          },
        }
      : {}),
  };
}

function readMode(value: unknown): AgentMode | undefined {
  return value === "execute" || value === "plan" || value === "coordinator"
    ? value
    : undefined;
}

function readString(value: unknown): string | undefined {
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

function parseJsonObject(value: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isNodeErrorWithCode(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
