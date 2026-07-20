import type {
  MemoryDeleteToolInput,
  MemoryReadToolInput,
  MemoryWriteToolInput,
} from "../core/tools";
import type { CodingToolDefinition, ToolRunContext } from "./index";

type UnknownRecord = Readonly<Record<string, unknown>>;

export const memoryReadTool: CodingToolDefinition<
  "memory_read",
  MemoryReadToolInput,
  unknown
> = {
  name: "memory_read",
  riskLevel: "read-only",
  executionMode: "parallel",
  description:
    "Read controlled persistent memory. Memory is a single Codex-like global store; use document=summary for the compact memory_summary.md, document=index for the MEMORY.md registry, document=topic for durable reusable knowledge, document=rollout_summary for completed task summaries, document=extension_note for pending memory updates, document=instructions for user-managed instructions, or document=audit for the mutation audit log.",
  schema: memoryReadSchema(),
  parse: parseMemoryReadInput,
  async execute(input, context) {
    const memory = requireMemoryAccess(context);
    return memory.store.readMemoryDocument(memory.key, input);
  },
};

export const memoryWriteTool: CodingToolDefinition<
  "memory_write",
  MemoryWriteToolInput,
  unknown
> = {
  name: "memory_write",
  riskLevel: "mutating",
  executionMode: "sequential",
  description:
    "Write controlled persistent memory with an audit reason. Memory is global and Codex-like; express applicability in the content instead of creating per-channel memory. Use summary/index for compact runtime routing, topic for durable reusable knowledge, rollout_summary for completed task recaps, and extension_note for candidate memory updates that need later curation. Summarize reusable triggers and guidance instead of raw transcripts. User-managed instructions cannot be modified with this tool.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ...memoryWritableRefProperties(),
      content: {
        type: "string",
        description: "Complete UTF-8 content to store.",
      },
      reason: {
        type: "string",
        minLength: 1,
        description: "Why this durable memory should be changed.",
      },
    },
    required: ["scope", "document", "content", "reason"],
  },
  parse: parseMemoryWriteInput,
  concurrencyKey: memoryConcurrencyKey,
  async execute(input, context) {
    const memory = requireMemoryAccess(context);
    return memory.store.writeMemoryDocument(memory.key, {
      ...input,
      source: memory.source,
    });
  },
};

export const memoryDeleteTool: CodingToolDefinition<
  "memory_delete",
  MemoryDeleteToolInput,
  unknown
> = {
  name: "memory_delete",
  riskLevel: "mutating",
  executionMode: "sequential",
  description:
    "Delete a controlled MEMORY.md index or detailed memory topic with an audit reason. The append-only audit log remains available through memory_read.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ...memoryWritableRefProperties(),
      reason: {
        type: "string",
        minLength: 1,
        description: "Why this durable memory should be deleted.",
      },
    },
    required: ["scope", "document", "reason"],
  },
  parse: parseMemoryDeleteInput,
  concurrencyKey: memoryConcurrencyKey,
  async execute(input, context) {
    const memory = requireMemoryAccess(context);
    return memory.store.deleteMemoryDocument(memory.key, {
      ...input,
      source: memory.source,
    });
  },
};

function memoryReadSchema(): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      scope: memoryScopeSchema(),
      document: {
        type: "string",
        enum: [
          "instructions",
          "summary",
          "index",
          "topic",
          "rollout_summary",
          "extension_note",
          "audit",
        ],
        description: "Memory document to read.",
      },
      topic: memoryTopicSchema(),
    },
    required: ["scope", "document"],
  };
}

function memoryWritableRefProperties(): Readonly<Record<string, unknown>> {
  return {
    scope: memoryScopeSchema(),
      document: {
        type: "string",
        enum: ["summary", "index", "topic", "rollout_summary", "extension_note"],
        description:
          "Write the compact summary, registry index, reusable topic, completed rollout summary, or candidate extension note.",
      },
      topic: memoryTopicSchema(),
  };
}

function memoryScopeSchema(): Readonly<Record<string, unknown>> {
  return {
    type: "string",
    enum: ["global"],
    description:
      "Persistent memory is a single global Codex-like store. Use content fields such as applies_to, cwd, or keywords to describe applicability.",
  };
}

function memoryTopicSchema(): Readonly<Record<string, unknown>> {
  return {
    type: "string",
    pattern: "^[a-z0-9][a-z0-9_-]{0,63}$",
    description:
      "Required when document=topic, rollout_summary, or extension_note. Use a stable lowercase slug.",
  };
}

function parseMemoryReadInput(
  input: UnknownRecord,
): ReturnType<CodingToolDefinition<"memory_read", MemoryReadToolInput, unknown>["parse"]> {
  const ref = parseMemoryRef(input, true);
  return ref.ok ? { ok: true, input: ref.input } : ref;
}

function parseMemoryWriteInput(
  input: UnknownRecord,
): ReturnType<CodingToolDefinition<"memory_write", MemoryWriteToolInput, unknown>["parse"]> {
  const ref = parseMemoryRef(input, false);
  const content = readString(input, "content");
  const reason = readNonEmptyString(input, "reason");
  if (!ref.ok) {
    return ref;
  }
  if (content === undefined || reason === undefined) {
    return invalidInput("memory_write.content and memory_write.reason must be strings");
  }
  return {
    ok: true,
    input: {
      ...ref.input,
      content,
      reason,
    },
  };
}

function parseMemoryDeleteInput(
  input: UnknownRecord,
): ReturnType<CodingToolDefinition<"memory_delete", MemoryDeleteToolInput, unknown>["parse"]> {
  const ref = parseMemoryRef(input, false);
  const reason = readNonEmptyString(input, "reason");
  if (!ref.ok) {
    return ref;
  }
  if (reason === undefined) {
    return invalidInput("memory_delete.reason must be a non-empty string");
  }
  return {
    ok: true,
    input: {
      ...ref.input,
      reason,
    },
  };
}

function parseMemoryRef(
  input: UnknownRecord,
  readable: true,
): { readonly ok: true; readonly input: MemoryReadToolInput } | InvalidInput;
function parseMemoryRef(
  input: UnknownRecord,
  readable: false,
): {
  readonly ok: true;
  readonly input: Pick<MemoryWriteToolInput, "scope" | "document" | "topic">;
} | InvalidInput;
function parseMemoryRef(
  input: UnknownRecord,
  readable: boolean,
):
  | { readonly ok: true; readonly input: MemoryReadToolInput }
  | {
      readonly ok: true;
      readonly input: Pick<MemoryWriteToolInput, "scope" | "document" | "topic">;
    }
  | InvalidInput {
  const scope = readString(input, "scope");
  const document = readString(input, "document");
  const topic = readString(input, "topic");
  if (scope !== "global") {
    return invalidInput("memory scope must be global");
  }
  const writableDocument =
    document === "summary" ||
    document === "index" ||
    document === "topic" ||
    document === "rollout_summary" ||
    document === "extension_note";
  const readableDocument =
    writableDocument || document === "instructions" || document === "audit";
  if (!readableDocument || (!readable && !writableDocument)) {
    return invalidInput(
      readable
        ? "memory_read.document must be instructions, summary, index, topic, rollout_summary, extension_note, or audit"
        : "memory mutation document must be summary, index, topic, rollout_summary, or extension_note",
    );
  }
  const requiresTopic =
    document === "topic" ||
    document === "rollout_summary" ||
    document === "extension_note";
  if (requiresTopic && topic === undefined) {
    return invalidInput(
      "memory topic is required when document=topic, rollout_summary, or extension_note",
    );
  }
  if (!requiresTopic && topic !== undefined) {
    return invalidInput(
      "memory topic is only valid when document=topic, rollout_summary, or extension_note",
    );
  }
  if (topic !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(topic)) {
    return invalidInput("memory topic must match /^[a-z0-9][a-z0-9_-]{0,63}$/");
  }
  return {
    ok: true,
    input: {
      scope,
      document,
      ...(topic === undefined ? {} : { topic }),
    },
  };
}

function memoryConcurrencyKey(
  input: Pick<MemoryWriteToolInput, "scope" | "document" | "topic">,
): string {
  return `memory:${input.scope}:${input.document}:${input.topic ?? ""}`;
}

function requireMemoryAccess(context: ToolRunContext): NonNullable<ToolRunContext["memory"]> {
  if (context.memory === undefined) {
    throw toolError(
      "permission_denied",
      "Persistent memory is not available in this tool execution context",
    );
  }
  return context.memory;
}

interface InvalidInput {
  readonly ok: false;
  readonly message: string;
}

function invalidInput(message: string): InvalidInput {
  return { ok: false, message };
}

function readString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNonEmptyString(record: UnknownRecord, key: string): string | undefined {
  const value = readString(record, key);
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function toolError(code: string, message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}
