import type { LlmToolSchema } from "../core/agent";
import * as path from "node:path";
import type {
  ToolCall,
  ToolCallParseResult,
  ToolError,
  ToolExecutionMode,
  ToolMetadata,
  ToolName,
  ToolResult,
  ToolRiskLevel,
  UnparsedToolCall,
} from "../core/tools";
import type { ToolApprovalGate, ToolExecutor } from "../ports/tools";
import type { ChannelSessionKey } from "../core/session";
import type { SlackConversationRef } from "../core/slack";
import {
  isPlanControlTool,
  type AgentRuntimeState,
} from "../runtime/mode";
import type { ChildAgentRuntime } from "../runtime/child-agents";
import type { SlackEventPublisher } from "../ports/slack";
import type { ManualEvolutionSignalInput } from "../evolution/controller";
import type {
  EvolutionSignalSource,
  EvolutionSubmissionResult,
} from "../evolution/types";
import type {
  ChannelWorkspaceStore,
  MemoryMutationSource,
} from "../workspace/store";
import type { WorkspaceSkill } from "../workspace/skills";
import type { TaskStore } from "../workspace/tasks";
import {
  createSandboxExecutor,
  type SandboxExecutor,
} from "../workspace/sandbox";
import { bashTool } from "./bash";
import {
  agentCaptureTool,
  agentCollectTool,
  agentListTool,
  agentSendTool,
  agentSpawnTool,
  agentStopTool,
} from "./agents";
import { attachTool } from "./attach";
import {
  enterCoordinatorModeTool,
  exitCoordinatorModeTool,
} from "./coordinator";
import { editTool } from "./edit";
import { grepTool } from "./grep";
import { lspTool } from "./lsp";
import { readTool } from "./read";
import {
  readSkillTool,
  writeSkillTool,
} from "./skill";
import { writeTool } from "./write";
import {
  memoryDeleteTool,
  memoryReadTool,
  memoryWriteTool,
} from "./memory";
import {
  enterPlanModeTool,
  exitPlanModeTool,
  updatePlanTool,
} from "./plan";
import {
  taskUpdateTool,
  tasksReadTool,
  tasksUpdateTool,
} from "./tasks";
import { createEvolutionTaskTool } from "./evolution";
import { createToolApprovalGate } from "./approval";

type UnknownRecord = Readonly<Record<string, unknown>>;

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ToolRunContext {
  readonly workspaceRoot: string;
  readonly pibotSkillsRoot?: string;
  readonly skills?: readonly WorkspaceSkill[];
  readonly sandboxExecutor: SandboxExecutor;
  readonly maxReadChars: number;
  readonly maxFileBytes: number;
  readonly maxCommandOutputChars: number;
  readonly maxGrepMatches: number;
  readonly maxGrepOutputChars: number;
  readonly defaultShellTimeoutMs: number;
  readonly maxShellTimeoutMs: number;
  readonly memory?: {
    readonly store: ChannelWorkspaceStore;
    readonly key: ChannelSessionKey;
    readonly source: MemoryMutationSource;
  };
  readonly runtime?: AgentRuntimeState;
  readonly tasks?: TaskStore;
  readonly attach?: {
    readonly publisher: SlackEventPublisher;
    readonly conversation: SlackConversationRef;
    readonly maxFileBytes: number;
  };
  readonly childAgents?: ChildAgentRuntime;
  readonly evolution?: {
    readonly submitManualSignal: (
      input: ManualEvolutionSignalInput,
    ) => Promise<EvolutionSubmissionResult>;
    readonly source?: EvolutionSignalSource;
    readonly actor?: string;
  };
}

export type ToolInputParseResult<Input> =
  | {
      readonly ok: true;
      readonly input: Input;
    }
  | {
      readonly ok: false;
      readonly message: string;
    };

export interface CodingToolDefinition<
  Name extends string,
  Input,
  Output,
> {
  readonly name: Name;
  readonly description: string;
  readonly schema: JsonSchema;
  readonly riskLevel: ToolRiskLevel;
  readonly executionMode: ToolExecutionMode;
  parse(input: UnknownRecord): ToolInputParseResult<Input>;
  execute(
    input: Input,
    context: ToolRunContext,
    signal?: AbortSignal,
  ): Promise<Output> | Output;
  concurrencyKey?(input: Input): string | undefined;
}

interface RegisteredCodingToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly schema: JsonSchema;
  readonly riskLevel: ToolRiskLevel;
  readonly executionMode: ToolExecutionMode;
  parse(input: UnknownRecord): ToolInputParseResult<unknown>;
  execute(
    input: unknown,
    context: ToolRunContext,
    signal?: AbortSignal,
  ): Promise<unknown> | unknown;
  concurrencyKey?(input: unknown): string | undefined;
}

export class CodingToolRegistry {
  private readonly tools = new Map<string, RegisteredCodingToolDefinition>();

  registerTool<Name extends string, Input, Output>(
    definition: CodingToolDefinition<Name, Input, Output>,
  ): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool "${definition.name}" is already registered`);
    }
    this.tools.set(
      definition.name,
      definition as unknown as RegisteredCodingToolDefinition,
    );
  }

  listTools(): readonly ToolName[] {
    return [...this.tools.keys()];
  }

  listDefinitions(): readonly RegisteredCodingToolDefinition[] {
    return [...this.tools.values()];
  }

  describeTool(name: string): ToolMetadata | undefined {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      return undefined;
    }
    return {
      name: tool.name,
      riskLevel: tool.riskLevel,
      executionMode: tool.executionMode,
    };
  }

  parseToolCall(call: UnparsedToolCall): ToolCallParseResult {
    const definition = this.tools.get(call.name);
    if (definition === undefined) {
      return invalidToolCall(call, `Tool "${call.name}" is not registered`);
    }
    const input = parseJsonObject(call.argumentsJson);
    if (input === null) {
      return invalidToolCall(
        call,
        `Tool "${call.name}" arguments must be a JSON object`,
      );
    }
    const parsed = definition.parse(input);
    if (!parsed.ok) {
      return invalidToolCall(call, parsed.message);
    }
    return {
      ok: true,
      call: {
        id: call.id,
        name: call.name,
        input: parsed.input,
      },
    };
  }

  async executeTool(
    call: ToolCall,
    context: ToolRunContext,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const definition = this.tools.get(call.name);
    if (definition === undefined) {
      throw toolError("invalid_input", `Tool "${call.name}" is not registered`);
    }
    return definition.execute(call.input, context, signal);
  }

  concurrencyKey(call: ToolCall): string | undefined {
    return this.tools.get(call.name)?.concurrencyKey?.(call.input);
  }
}

export interface CodingToolExecutorOptions {
  readonly workspaceRoot: string;
  readonly pibotSkillsRoot?: string;
  readonly skills?: readonly WorkspaceSkill[];
  readonly sandboxExecutor?: SandboxExecutor;
  readonly approvalGate?: ToolApprovalGate;
  readonly registry?: CodingToolRegistry;
  readonly disabledTools?: readonly ToolName[];
  readonly maxReadChars?: number;
  readonly maxFileBytes?: number;
  readonly maxCommandOutputChars?: number;
  readonly maxGrepMatches?: number;
  readonly maxGrepOutputChars?: number;
  readonly defaultShellTimeoutMs?: number;
  readonly maxShellTimeoutMs?: number;
  readonly memory?: ToolRunContext["memory"];
  readonly runtime?: AgentRuntimeState;
  readonly tasks?: TaskStore;
  readonly attach?: ToolRunContext["attach"];
  readonly childAgents?: ChildAgentRuntime;
  readonly evolution?: ToolRunContext["evolution"];
}

export class CodingToolExecutor implements ToolExecutor {
  private readonly context: ToolRunContext;
  private readonly approvalGate: ToolApprovalGate;
  private readonly registry: CodingToolRegistry;
  private readonly disabledTools: ReadonlySet<ToolName>;

  constructor(options: CodingToolExecutorOptions) {
    const sandboxExecutor = options.sandboxExecutor ?? createSandboxExecutor();
    sandboxExecutor.assertWorkspaceAccess(options.workspaceRoot);
    this.context = {
      workspaceRoot: options.workspaceRoot,
      ...(options.pibotSkillsRoot === undefined
        ? {}
        : { pibotSkillsRoot: options.pibotSkillsRoot }),
      ...(options.skills === undefined ? {} : { skills: options.skills }),
      sandboxExecutor,
      maxReadChars: positiveInteger(options.maxReadChars, 20000, "maxReadChars"),
      maxFileBytes: positiveInteger(options.maxFileBytes, 1_000_000, "maxFileBytes"),
      maxCommandOutputChars: positiveInteger(
        options.maxCommandOutputChars,
        20000,
        "maxCommandOutputChars",
      ),
      maxGrepMatches: positiveInteger(options.maxGrepMatches, 200, "maxGrepMatches"),
      maxGrepOutputChars: positiveInteger(
        options.maxGrepOutputChars,
        2_000_000,
        "maxGrepOutputChars",
      ),
      defaultShellTimeoutMs: positiveInteger(
        options.defaultShellTimeoutMs,
        120000,
        "defaultShellTimeoutMs",
      ),
      maxShellTimeoutMs: positiveInteger(
        options.maxShellTimeoutMs,
        600000,
        "maxShellTimeoutMs",
      ),
      ...(options.memory === undefined ? {} : { memory: options.memory }),
      ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
      ...(options.tasks === undefined ? {} : { tasks: options.tasks }),
      ...(options.attach === undefined ? {} : { attach: options.attach }),
      ...(options.childAgents === undefined
        ? {}
        : { childAgents: options.childAgents }),
      ...(options.evolution === undefined ? {} : { evolution: options.evolution }),
    };
    if (this.context.defaultShellTimeoutMs > this.context.maxShellTimeoutMs) {
      throw new Error("defaultShellTimeoutMs must not exceed maxShellTimeoutMs");
    }
    this.approvalGate = options.approvalGate ?? createToolApprovalGate();
    this.registry = options.registry ?? codingToolRegistry;
    this.disabledTools = new Set(options.disabledTools ?? []);
  }

  listTools(): readonly ToolName[] {
    return this.registry.listTools().filter((name) => !this.disabledTools.has(name));
  }

  describeTool(name: string): ToolMetadata | undefined {
    if (this.disabledTools.has(name)) {
      return undefined;
    }
    return this.registry.describeTool(name);
  }

  parseToolCall(call: UnparsedToolCall): ToolCallParseResult {
    if (this.disabledTools.has(call.name)) {
      return invalidToolCall(call, `Tool "${call.name}" is disabled in this run`);
    }
    return this.registry.parseToolCall(call);
  }

  async executeTool(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    try {
      if (this.disabledTools.has(call.name)) {
        return deniedToolResult(call, `Tool "${call.name}" is disabled in this run`);
      }
      const metadata = this.registry.describeTool(call.name);
      if (metadata === undefined) {
        return deniedToolResult(call, `Tool "${call.name}" is not registered`);
      }
      if (!isPlanModeControlCall(this.context.runtime, call.name)) {
        const decision = await this.approvalGate.reviewToolCall({
          call,
          risk: metadata.riskLevel,
          explanation: `${call.name} is classified as ${metadata.riskLevel}`,
        }, signal);
        if (!decision.approved) {
          return deniedToolResult(call, decision.reason);
        }
      }

      const execute = () => this.registry.executeTool(call, this.context, signal);
      const concurrencyKey = this.registry.concurrencyKey(call);
      return {
        ok: true,
        callId: call.id,
        output:
          concurrencyKey === undefined
            ? await execute()
            : await codingToolFileQueue.run(
                workspaceConcurrencyKey(this.context.workspaceRoot, concurrencyKey),
                execute,
              ),
      };
    } catch (error: unknown) {
      return {
        ok: false,
        callId: call.id,
        error: toToolError(error),
      };
    }
  }
}

function isPlanModeControlCall(
  runtime: AgentRuntimeState | undefined,
  toolName: string,
): boolean {
  return runtime?.mode === "plan" && isPlanControlTool(toolName);
}

class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<Output>(
    key: string,
    execute: () => Promise<Output>,
  ): Promise<Output> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, next);

    await previous;
    try {
      return await execute();
    } finally {
      release();
      if (this.tails.get(key) === next) {
        this.tails.delete(key);
      }
    }
  }
}

const codingToolRegistry = new CodingToolRegistry();
const codingToolFileQueue = new KeyedSerialQueue();

function workspaceConcurrencyKey(workspaceRoot: string, key: string): string {
  if (key.startsWith("file:")) {
    return `file:${path.resolve(workspaceRoot, key.slice("file:".length))}`;
  }
  return `${path.resolve(workspaceRoot)}:${key}`;
}

export function registerTool<Name extends string, Input, Output>(
  definition: CodingToolDefinition<Name, Input, Output>,
): void {
  codingToolRegistry.registerTool(definition);
}

registerTool(readTool);
registerTool(readSkillTool);
registerTool(grepTool);
registerTool(bashTool);
registerTool(agentSpawnTool);
registerTool(agentListTool);
registerTool(agentCaptureTool);
registerTool(agentSendTool);
registerTool(agentStopTool);
registerTool(agentCollectTool);
registerTool(attachTool);
registerTool(editTool);
registerTool(writeTool);
registerTool(writeSkillTool);
registerTool(memoryReadTool);
registerTool(memoryWriteTool);
registerTool(memoryDeleteTool);
registerTool(lspTool);
registerTool(enterPlanModeTool);
registerTool(updatePlanTool);
registerTool(exitPlanModeTool);
registerTool(enterCoordinatorModeTool);
registerTool(exitCoordinatorModeTool);
registerTool(tasksReadTool);
registerTool(tasksUpdateTool);
registerTool(taskUpdateTool);
registerTool(createEvolutionTaskTool);

function deniedToolResult(call: ToolCall, message: string): ToolResult {
  return {
    ok: false,
    callId: call.id,
    error: {
      code: "permission_denied",
      message,
      retryable: false,
    },
  };
}

function invalidToolCall(
  call: UnparsedToolCall,
  message: string,
): ToolCallParseResult {
  return {
    ok: false,
    call: {
      id: call.id,
      name: call.name,
      input: {},
      reason: `invalid_tool_call:${message}`,
    },
    message,
  };
}

function parseJsonObject(value: string): UnknownRecord | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is UnknownRecord {
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

function toToolError(error: unknown): ToolError {
  if (error instanceof Error) {
    return {
      code: toToolErrorCode(error.name),
      message: error.message,
      retryable: isRetryable(error.name),
    };
  }
  return {
    code: "execution_failed",
    message: "Unknown tool error",
    retryable: false,
  };
}

function toToolErrorCode(name: string): ToolError["code"] {
  switch (name) {
    case "not_found":
    case "permission_denied":
    case "invalid_input":
    case "timeout":
    case "conflict":
    case "execution_failed":
      return name;
    default:
      return "execution_failed";
  }
}

function isRetryable(name: string): boolean {
  return name === "timeout" || name === "execution_failed";
}

function toolError(code: ToolError["code"], message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}

export function createCodingToolExecutor(
  options: CodingToolExecutorOptions,
): CodingToolExecutor {
  return new CodingToolExecutor(options);
}

export function getCodingToolSchemas(): readonly LlmToolSchema[] {
  return codingToolRegistry.listDefinitions().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchemaJson: JSON.stringify(tool.schema),
  }));
}

export function getCodingTools(): readonly RegisteredCodingToolDefinition[] {
  return codingToolRegistry.listDefinitions();
}

export { bashTool } from "./bash";
export {
  agentCaptureTool,
  agentCollectTool,
  agentListTool,
  agentSendTool,
  agentSpawnTool,
  agentStopTool,
} from "./agents";
export { attachTool } from "./attach";
export { createEvolutionTaskTool } from "./evolution";
export { editTool } from "./edit";
export { grepTool } from "./grep";
export { lspTool } from "./lsp";
export { readTool } from "./read";
export { writeTool } from "./write";
export {
  memoryDeleteTool,
  memoryReadTool,
  memoryWriteTool,
} from "./memory";
export {
  enterPlanModeTool,
  exitPlanModeTool,
  updatePlanTool,
} from "./plan";
export {
  enterCoordinatorModeTool,
  exitCoordinatorModeTool,
} from "./coordinator";
export {
  taskUpdateTool,
  tasksReadTool,
  tasksUpdateTool,
} from "./tasks";
export * from "./approval";
