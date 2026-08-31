import type { LlmToolSchema } from "../core/agent";
import * as path from "node:path";
import {
  capabilityKinds,
  capabilityRequestRisk,
  grantAllowsCapability,
  issueToolCapabilityGrant,
  legacyToolCapabilityRequest,
  normalizeCapabilityRequest,
  toolCapabilityCallDigest,
  validateToolCapabilityGrant,
  withActiveToolCapabilityGrant,
  type ToolCapabilityGrant,
  type ToolCapabilityKind,
  type ToolCapabilityRequest,
} from "../core/capabilities";
import type {
  ToolCall,
  ToolCallParseResult,
  ToolError,
  ToolExecutionSnapshot,
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
  isCapabilityRequestAllowedInMode,
  isPlanControlTool,
  type AgentRuntimeState,
} from "../runtime/mode";
import type { ChildAgentRuntime } from "../runtime/child-agents";
import type { ChildWorkflowScheduler } from "../workflow/child-scheduler";
import type { TaskGraphScheduler } from "../workflow/task-scheduler";
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
import { defaultSandboxPolicy } from "../workspace/sandbox-policy";
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
  readonly authorization?: {
    readonly request: ToolCapabilityRequest;
    readonly grant: ToolCapabilityGrant;
    readonly callId: ToolCall["id"];
    readonly callDigest: string;
  };
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
  readonly childScheduler?: ChildWorkflowScheduler;
  readonly taskScheduler?: TaskGraphScheduler;
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
  resolveCapabilities?(
    input: Input,
    context: ToolRunContext,
  ): ToolCapabilityRequest;
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
  resolveCapabilities?(
    input: unknown,
    context: ToolRunContext,
  ): ToolCapabilityRequest;
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

  resolveCapabilities(
    call: ToolCall,
    context: ToolRunContext,
  ): ToolCapabilityRequest {
    const definition = this.tools.get(call.name);
    if (definition === undefined) {
      throw toolError("invalid_input", `Tool "${call.name}" is not registered`);
    }
    try {
      return normalizeCapabilityRequest(
        definition.resolveCapabilities?.(call.input, context) ??
          legacyToolCapabilityRequest(definition.name, definition.riskLevel),
      );
    } catch (error: unknown) {
      throw toolError(
        error instanceof Error && error.name === "permission_denied"
          ? "permission_denied"
          : "invalid_input",
        error instanceof Error ? error.message : "Invalid capability request",
      );
    }
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
  readonly childScheduler?: ChildWorkflowScheduler;
  readonly taskScheduler?: TaskGraphScheduler;
  readonly evolution?: ToolRunContext["evolution"];
  /** Hard ceiling independent from approval mode; useful for read-only child runs. */
  readonly deniedCapabilities?: readonly ToolCapabilityKind[];
}

export class CodingToolExecutor implements ToolExecutor {
  private readonly context: ToolRunContext;
  private readonly approvalGate: ToolApprovalGate;
  private readonly registry: CodingToolRegistry;
  private readonly disabledTools: ReadonlySet<ToolName>;
  private readonly deniedCapabilities: ReadonlySet<ToolCapabilityKind>;

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
      ...(options.childScheduler === undefined
        ? {}
        : { childScheduler: options.childScheduler }),
      ...(options.taskScheduler === undefined
        ? {}
        : { taskScheduler: options.taskScheduler }),
      ...(options.evolution === undefined ? {} : { evolution: options.evolution }),
    };
    if (this.context.defaultShellTimeoutMs > this.context.maxShellTimeoutMs) {
      throw new Error("defaultShellTimeoutMs must not exceed maxShellTimeoutMs");
    }
    this.approvalGate = options.approvalGate ?? createToolApprovalGate();
    this.registry = options.registry ?? codingToolRegistry;
    this.disabledTools = new Set(options.disabledTools ?? []);
    this.deniedCapabilities = new Set(options.deniedCapabilities ?? []);
  }

  listTools(): readonly ToolName[] {
    return this.registry.listTools().filter((name) => !this.disabledTools.has(name));
  }

  captureExecutionSnapshot(): ToolExecutionSnapshot {
    return Object.freeze({
      schemaVersion: 1 as const,
      authorityVersion: this.authorityVersion(),
      availableTools: Object.freeze([...this.listTools()]),
      workspaceRoot: this.context.workspaceRoot,
      ...(this.context.runtime === undefined
        ? {}
        : {
            runtimeStateVersion: this.context.runtime.version,
            mode: this.context.runtime.mode,
          }),
    });
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

  resolveCapabilities(call: ToolCall): ToolCapabilityRequest {
    if (this.disabledTools.has(call.name)) {
      throw toolError("permission_denied", `Tool "${call.name}" is disabled in this run`);
    }
    return this.registry.resolveCapabilities(call, this.context);
  }

  async executeTool(
    call: ToolCall,
    signal?: AbortSignal,
    snapshot?: ToolExecutionSnapshot,
  ): Promise<ToolResult> {
    try {
      const snapshotDenial = this.findSnapshotDenial(call, snapshot);
      if (snapshotDenial !== undefined) {
        return deniedToolResult(call, snapshotDenial);
      }
      if (this.disabledTools.has(call.name)) {
        return deniedToolResult(call, `Tool "${call.name}" is disabled in this run`);
      }
      const metadata = this.registry.describeTool(call.name);
      if (metadata === undefined) {
        return deniedToolResult(call, `Tool "${call.name}" is not registered`);
      }
      const capabilities = this.resolveCapabilities(call);
      const snapshotModeDenial = this.findSnapshotModeDenial(
        call,
        capabilities,
        snapshot,
      );
      if (snapshotModeDenial !== undefined) {
        return deniedToolResult(call, snapshotModeDenial);
      }
      const callDigest = toolCapabilityCallDigest(call.id, call.name, call.input);
      const capabilityDenial = this.findCapabilityDenial(capabilities);
      if (capabilityDenial !== undefined) {
        return deniedToolResult(call, capabilityDenial);
      }
      const initialModeDenial = this.findModeDenial(call, capabilities);
      if (initialModeDenial !== undefined) {
        return deniedToolResult(call, initialModeDenial);
      }
      const approvalStateVersion =
        snapshot?.runtimeStateVersion ?? this.context.runtime?.version;
      if (!isRuntimeControlCall(this.context.runtime, call.name)) {
        const risk = capabilityRequestRisk(capabilities);
        const decision = await this.approvalGate.reviewToolCall({
          call,
          risk,
          explanation: capabilityExplanation(call.name, capabilities),
          capabilities,
        }, signal);
        if (!decision.approved) {
          return deniedToolResult(call, decision.reason);
        }
      }

      // Approval is asynchronous. Re-read mutable runtime state before issuing
      // authority so a mode tightening during the prompt cannot inherit a stale allow.
      const finalModeDenial = this.findModeDenial(call, capabilities);
      if (finalModeDenial !== undefined) {
        return deniedToolResult(call, finalModeDenial);
      }
      const transitionDenial = this.findModeTighteningSince(
        call,
        capabilities,
        approvalStateVersion,
      );
      if (transitionDenial !== undefined) {
        return deniedToolResult(call, transitionDenial);
      }
      if (toolCapabilityCallDigest(call.id, call.name, call.input) !== callDigest) {
        return deniedToolResult(
          call,
          `Tool "${call.name}" changed while approval was pending`,
        );
      }

      const grant = issueToolCapabilityGrant({
        callId: call.id,
        toolName: call.name,
        input: call.input,
        request: capabilities,
        policyVersion: sandboxPolicyVersion(this.context.sandboxExecutor),
        ttlMs: this.context.maxShellTimeoutMs + 60_000,
        source: isRuntimeControlCall(this.context.runtime, call.name)
          ? "runtime-control"
          : "policy",
        ...(this.context.runtime === undefined
          ? {}
          : {
              runtimeStateVersion:
                snapshot?.runtimeStateVersion ?? this.context.runtime.version,
            }),
      });
      const callContext: ToolRunContext = {
        ...this.context,
        authorization: {
          request: capabilities,
          grant,
          callId: call.id,
          callDigest,
        },
      };

      const execute = () => this.registry.executeTool(call, callContext, signal);
      const concurrencyKey = this.registry.concurrencyKey(call);
      return {
        ok: true,
        callId: call.id,
        output:
          concurrencyKey === undefined
            ? await withActiveToolCapabilityGrant(grant, execute)
            : await codingToolFileQueue.run(
                workspaceConcurrencyKey(this.context.workspaceRoot, concurrencyKey),
                () => withActiveToolCapabilityGrant(grant, execute),
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

  private findCapabilityDenial(
    request: ToolCapabilityRequest,
  ): string | undefined {
    const denied = capabilityKinds(request).find((capability) =>
      this.deniedCapabilities.has(capability)
    );
    return denied === undefined
      ? undefined
      : `Capability "${denied}" is denied by this run's capability ceiling`;
  }

  private findSnapshotDenial(
    call: ToolCall,
    snapshot: ToolExecutionSnapshot | undefined,
  ): string | undefined {
    if (snapshot === undefined) {
      return undefined;
    }
    if (!snapshot.availableTools.includes(call.name)) {
      return `Tool "${call.name}" was not available in the Step execution snapshot`;
    }
    if (
      snapshot.workspaceRoot !== undefined &&
      snapshot.workspaceRoot !== this.context.workspaceRoot
    ) {
      return `Tool "${call.name}" belongs to a different workspace snapshot`;
    }
    if (snapshot.authorityVersion !== this.authorityVersion()) {
      return `Tool "${call.name}" execution authority changed after the model Step started`;
    }
    return undefined;
  }

  private findSnapshotModeDenial(
    call: ToolCall,
    request: ToolCapabilityRequest,
    snapshot: ToolExecutionSnapshot | undefined,
  ): string | undefined {
    const mode = snapshot?.mode;
    if (
      mode === undefined ||
      (mode !== "execute" && mode !== "plan" && mode !== "coordinator") ||
      isCapabilityRequestAllowedInMode(mode, call.name, request)
    ) {
      return undefined;
    }
    return `Tool "${call.name}" was not allowed by the Step mode snapshot (${mode})`;
  }

  private authorityVersion(): string {
    return [
      sandboxPolicyVersion(this.context.sandboxExecutor),
      [...this.disabledTools].sort().join(","),
      [...this.deniedCapabilities].sort().join(","),
    ].join("|");
  }

  private findModeDenial(
    call: ToolCall,
    request: ToolCapabilityRequest,
  ): string | undefined {
    const runtime = this.context.runtime;
    if (
      runtime === undefined ||
      isCapabilityRequestAllowedInMode(runtime.mode, call.name, request)
    ) {
      return undefined;
    }
    return (
      `Tool "${call.name}" requires ${capabilityKinds(request).join(", ")} ` +
      `and is not allowed while AgentMode=${runtime.mode}`
    );
  }

  private findModeTighteningSince(
    call: ToolCall,
    request: ToolCapabilityRequest,
    stateVersion: number | undefined,
  ): string | undefined {
    const runtime = this.context.runtime;
    if (runtime === undefined || stateVersion === undefined) {
      return undefined;
    }
    const tightening = runtime.modeTransitions.find((transition) =>
      transition.version > stateVersion &&
      !isCapabilityRequestAllowedInMode(transition.mode, call.name, request)
    );
    return tightening === undefined
      ? undefined
      : `Tool "${call.name}" approval became stale when AgentMode=${tightening.mode}`;
  }
}

export function assertToolCapability(
  context: ToolRunContext,
  capability: ToolCapabilityKind,
  resource?: string,
): void {
  const grant = context.authorization?.grant;
  if (grant !== undefined && context.authorization !== undefined) {
    validateToolCapabilityGrant(grant, {
      callId: context.authorization.callId,
      callDigest: context.authorization.callDigest,
      policyVersion: sandboxPolicyVersion(context.sandboxExecutor),
    });
  }
  if (grant === undefined || !grantAllowsCapability(grant, capability, resource)) {
    throw toolError(
      "permission_denied",
      `Tool execution lacks capability ${capability}${
        resource === undefined ? "" : ` for ${resource}`
      }`,
    );
  }
}

function capabilityExplanation(
  toolName: string,
  request: ToolCapabilityRequest,
): string {
  const resources = request.requirements.map((requirement) => {
    if (
      requirement.capability === "filesystem.read" ||
      requirement.capability === "filesystem.write"
    ) {
      return `${requirement.capability}(${requirement.paths.join(", ")})`;
    }
    if (requirement.capability === "network.connect") {
      return `${requirement.capability}(${requirement.hosts.join(", ")})`;
    }
    if (requirement.capability === "process.exec") {
      return requirement.capability;
    }
    return `${requirement.capability}(${requirement.resources.join(", ")})`;
  });
  return `${toolName} requests ${resources.join(", ")}`;
}

function isRuntimeControlCall(
  runtime: AgentRuntimeState | undefined,
  toolName: string,
): boolean {
  return toolName === "enter_plan_mode" ||
    toolName === "enter_coordinator_mode" ||
    toolName === "exit_coordinator_mode" ||
    (runtime?.mode === "plan" && isPlanControlTool(toolName));
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

function sandboxPolicyVersion(executor: SandboxExecutor): string {
  return executor.policy?.version ?? defaultSandboxPolicy.version;
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
