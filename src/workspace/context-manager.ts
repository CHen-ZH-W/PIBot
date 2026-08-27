import type { ModelRequest } from "../agent/model";
import type {
  LlmMessage,
  LlmMessageContentPart,
  LlmToolSchema,
} from "../core/agent";
import type { SlackEventId } from "../core/ids";
import { repairToolCallMessageOrder } from "../core/llm-history";
import type { RuntimeHook, RuntimeModelCallHookContext } from "../runtime/hooks";
import {
  microcompactContext,
  type MicrocompactPolicyOptions,
  type MicrocompactResult,
} from "./microcompact";

const CONTEXT_LANE_PREFIX = "[pibot-context:";
const DYNAMIC_TAIL_MARKER = "[pibot-context-placement:dynamic-tail]";
const STEERING_MESSAGE_PREFIX = "Steering message received during this run:\n";
const DEFAULT_IMAGE_TOKENS = 1_700;

/**
 * A durable context item describes what was recorded. ContextManager decides
 * which of those items belong on the model-facing history surface.
 */
export interface DurableContextItem {
  readonly lineNumber: number;
  readonly message: LlmMessage;
  readonly eventId?: SlackEventId;
  readonly isCompactionSummary: boolean;
  readonly coveredThroughLineNumber?: number;
}

export interface ContextHistoryProjectionRequest {
  readonly excludeEventId?: SlackEventId;
  readonly replaceEventMessage?: {
    readonly eventId: SlackEventId;
    readonly message: LlmMessage;
  };
  readonly replaceLineMessage?: {
    readonly lineNumber: number;
    readonly message: LlmMessage;
  };
}

export interface ContextSystemLane {
  readonly id: string;
  readonly content: string;
  readonly placement?: "stable_prefix" | "dynamic_tail";
}

export interface ContextManagerOptions {
  readonly microcompact?: MicrocompactPolicyOptions;
}

export interface ContextHistorySurfaceRequest {
  readonly projection?: ContextHistoryProjectionRequest;
  readonly modelRequest?: ModelRequest;
  readonly preserveFromLineNumber?: number;
  readonly recentCacheHitRatio?: number;
  readonly cacheAgeMs?: number;
  readonly cacheEpoch?: number;
}

export interface ContextHistorySurface {
  readonly messages: readonly LlmMessage[];
  readonly protectedUserIntentTokens: number;
  readonly microcompaction?: MicrocompactResult;
}

export interface ModelRequestTokenEstimate {
  readonly totalTokens: number;
  readonly messageTokens: number;
  readonly toolTokens: number;
  readonly imageTokens: number;
  readonly messageCount: number;
  readonly toolCount: number;
  readonly imageCount: number;
}

export interface ModelRequestBudgetOptions {
  readonly contextWindowTokens: number;
  readonly reserveTokens: number;
}

export interface ModelRequestBudget extends ModelRequestTokenEstimate {
  readonly contextWindowTokens: number;
  readonly reserveTokens: number;
  readonly inputLimitTokens: number;
  readonly remainingInputTokens: number;
  readonly overBudget: boolean;
}

/**
 * Owns the projection from append-only session history to model-visible
 * history. Persistence, compaction generation and system/world-state assembly
 * remain separate policies and can be added without changing the durable log.
 */
export class ContextManager {
  constructor(private readonly options: ContextManagerOptions = {}) {}

  selectActiveItems<Item extends DurableContextItem>(
    entries: readonly Item[],
  ): readonly Item[] {
    const latestSummary = [...entries]
      .reverse()
      .find(
        (entry) =>
          entry.isCompactionSummary &&
          entry.coveredThroughLineNumber !== undefined,
      );

    if (
      latestSummary === undefined ||
      latestSummary.coveredThroughLineNumber === undefined
    ) {
      return entries;
    }
    const coveredThroughLineNumber = latestSummary.coveredThroughLineNumber;

    return [
      latestSummary,
      ...entries.filter(
        (entry) =>
          entry.lineNumber > coveredThroughLineNumber &&
          !entry.isCompactionSummary,
      ),
    ];
  }

  projectHistory<Item extends DurableContextItem>(
    entries: readonly Item[],
    request: ContextHistoryProjectionRequest = {},
  ): readonly LlmMessage[] {
    const surface = projectSurfaceItems(
      entries,
      this.selectActiveItems(entries),
      request,
    );
    return repairToolCallMessageOrder(
      surface.items.map((item) => item.message),
    );
  }

  projectHistorySurface<Item extends DurableContextItem>(
    entries: readonly Item[],
    request: ContextHistorySurfaceRequest = {},
  ): ContextHistorySurface {
    const surface = projectSurfaceItems(
      entries,
      this.selectActiveItems(entries),
      request.projection ?? {},
    );
    const protectedUserIntentTokens = this.estimateMessages(
      surface.protectedUserIntentItems.map((item) => item.message),
    );
    if (
      this.options.microcompact === undefined ||
      request.modelRequest === undefined
    ) {
      return {
        messages: repairToolCallMessageOrder(
          surface.items.map((item) => item.message),
        ),
        protectedUserIntentTokens,
      };
    }
    const projected = microcompactContext(
      surface.items,
      this.options.microcompact,
      {
        modelRequest: request.modelRequest,
        stablePrefixTokens: this.estimateModelRequest({
          ...request.modelRequest,
          messages: stablePrefixMessages(request.modelRequest.messages),
        }).totalTokens,
        ...(request.preserveFromLineNumber === undefined
          ? {}
          : { preserveFromLineNumber: request.preserveFromLineNumber }),
        ...(request.recentCacheHitRatio === undefined
          ? {}
          : { recentCacheHitRatio: request.recentCacheHitRatio }),
        ...(request.cacheAgeMs === undefined
          ? {}
          : { cacheAgeMs: request.cacheAgeMs }),
        ...(request.cacheEpoch === undefined
          ? {}
          : { cacheEpoch: request.cacheEpoch }),
      },
      (messages) => this.estimateMessages(messages),
      (modelRequest) => this.estimateModelRequest(modelRequest).totalTokens,
      (messages) => this.replaceHistoryMessages(request.modelRequest!, messages),
    );
    return {
      messages: repairToolCallMessageOrder(projected.messages),
      protectedUserIntentTokens,
      microcompaction: projected.result,
    };
  }

  /**
   * Adds or replaces a named model-only system lane. Durable history remains
   * untouched, while current runtime truth can be refreshed for every step.
   */
  projectSystemLane(
    request: ModelRequest,
    lane: ContextSystemLane,
  ): ModelRequest {
    const marker = contextLaneMarker(lane.id);
    const laneMessage: LlmMessage = {
      role: "system",
      content: [
        marker,
        ...(lane.placement === "dynamic_tail" ? [DYNAMIC_TAIL_MARKER] : []),
        lane.content,
      ].join("\n"),
    };
    const messages = request.messages.filter(
      (message) => !isContextLaneMessage(message, marker),
    );
    if (lane.placement === "dynamic_tail") {
      return {
        ...request,
        messages: [...messages, laneMessage],
      };
    }
    const [first, ...rest] = messages;
    if (first?.role === "system") {
      return {
        ...request,
        messages: [first, laneMessage, ...rest],
      };
    }

    return {
      ...request,
      messages: [laneMessage, ...messages],
    };
  }

  replaceHistoryMessages(
    request: ModelRequest,
    history: readonly LlmMessage[],
  ): ModelRequest {
    const stablePrefix = stablePrefixMessages(request.messages);
    const dynamicLanes = dynamicTailMessages(request.messages);
    return {
      ...request,
      messages: [...stablePrefix, ...history, ...dynamicLanes],
    };
  }

  estimateModelRequest(request: ModelRequest): ModelRequestTokenEstimate {
    const messageEstimate = estimateMessageTokens(request.messages);
    const toolTokens = estimateToolTokens(request.tools);
    return {
      totalTokens: messageEstimate.tokens + toolTokens,
      messageTokens: messageEstimate.tokens,
      toolTokens,
      imageTokens: messageEstimate.imageTokens,
      messageCount: request.messages.length,
      toolCount: request.tools.length,
      imageCount: messageEstimate.imageCount,
    };
  }

  estimateModelRequestBudget(
    request: ModelRequest,
    options: ModelRequestBudgetOptions,
  ): ModelRequestBudget {
    const contextWindowTokens = positiveInteger(
      options.contextWindowTokens,
      "contextWindowTokens",
    );
    const reserveTokens = nonNegativeInteger(
      options.reserveTokens,
      "reserveTokens",
    );
    if (reserveTokens >= contextWindowTokens) {
      throw new Error("reserveTokens must be less than contextWindowTokens");
    }
    const estimate = this.estimateModelRequest(request);
    const inputLimitTokens = contextWindowTokens - reserveTokens;
    const remainingInputTokens = inputLimitTokens - estimate.totalTokens;
    return {
      ...estimate,
      contextWindowTokens,
      reserveTokens,
      inputLimitTokens,
      remainingInputTokens,
      overBudget: remainingInputTokens < 0,
    };
  }

  estimateMessages(messages: readonly LlmMessage[]): number {
    return estimateMessageTokens(messages).tokens;
  }
}

/** Keeps refreshable prompt material at the append-only dynamic tail per step. */
export class DynamicContextHook implements RuntimeHook {
  private readonly contextManager: ContextManager;

  constructor(
    private readonly content: string,
    contextManager?: ContextManager,
  ) {
    this.contextManager = contextManager ?? new ContextManager();
  }

  beforeModelCall(context: RuntimeModelCallHookContext): ModelRequest {
    return this.contextManager.projectSystemLane(context.request, {
      id: "run-context",
      placement: "dynamic_tail",
      content: this.content,
    });
  }
}

interface ProjectedSurfaceItems {
  readonly items: readonly MicrocompactSurfaceItem[];
  readonly protectedUserIntentItems: readonly MicrocompactSurfaceItem[];
}

interface MicrocompactSurfaceItem {
  readonly lineNumber: number;
  readonly message: LlmMessage;
}

function projectSurfaceItems<Item extends DurableContextItem>(
  entries: readonly Item[],
  activeEntries: readonly Item[],
  request: ContextHistoryProjectionRequest,
): ProjectedSurfaceItems {
  const activeItems = projectItems(activeEntries, request);
  const latestSummary = [...entries]
    .reverse()
    .find(
      (entry) =>
        entry.isCompactionSummary &&
        entry.coveredThroughLineNumber !== undefined,
    );
  if (
    latestSummary === undefined ||
    latestSummary.coveredThroughLineNumber === undefined
  ) {
    return { items: activeItems, protectedUserIntentItems: [] };
  }

  const coveredThroughLineNumber = latestSummary.coveredThroughLineNumber;
  const protectedUserEntries = projectItems(
    entries.filter(
      (entry) =>
        entry.lineNumber <= coveredThroughLineNumber &&
        entry.message.role === "user" &&
        !entry.isCompactionSummary,
    ),
    request,
  );
  if (protectedUserEntries.length === 0) {
    return { items: activeItems, protectedUserIntentItems: [] };
  }

  const header: MicrocompactSurfaceItem = {
    lineNumber: latestSummary.lineNumber,
    message: {
      role: "system",
      content: [
        "[pibot-context:exact-user-intent]",
        "The following are historical user messages covered by the checkpoint. Their user-role content is reproduced verbatim and remains authoritative. Preserve their constraints, but do not mistake them for the newest request.",
      ].join("\n"),
    },
  };
  const protectedUserIntentItems: readonly MicrocompactSurfaceItem[] = [
    header,
    ...protectedUserEntries.map((entry) => ({
      lineNumber: entry.lineNumber,
      message: entry.message,
    })),
  ];
  const summaryIndex = activeItems.findIndex(
    (entry) => entry.lineNumber === latestSummary.lineNumber,
  );
  if (summaryIndex < 0) {
    return {
      items: [...protectedUserIntentItems, ...activeItems],
      protectedUserIntentItems,
    };
  }
  return {
    items: [
      ...activeItems.slice(0, summaryIndex + 1),
      ...protectedUserIntentItems,
      ...activeItems.slice(summaryIndex + 1),
    ],
    protectedUserIntentItems,
  };
}

function projectItems<Item extends DurableContextItem>(
  entries: readonly Item[],
  request: ContextHistoryProjectionRequest,
): readonly Item[] {
  const replacement = request.replaceEventMessage;
  const lineReplacement = request.replaceLineMessage;
  return entries
    .filter(
      (entry) =>
        request.excludeEventId === undefined ||
        entry.eventId !== request.excludeEventId,
    )
    .map((entry) => {
      if (
        lineReplacement !== undefined &&
        entry.lineNumber === lineReplacement.lineNumber
      ) {
        return { ...entry, message: lineReplacement.message };
      }
      if (replacement !== undefined && entry.eventId === replacement.eventId) {
        return { ...entry, message: replacement.message };
      }
      return entry;
    });
}

function contextLaneMarker(id: string): string {
  const normalized = id.trim().toLowerCase().replace(/[^a-z0-9_-]+/gu, "-");
  if (normalized.length === 0) {
    throw new Error("Context system lane id must not be empty");
  }
  return `${CONTEXT_LANE_PREFIX}${normalized}]`;
}

function isContextLaneMessage(message: LlmMessage, marker: string): boolean {
  return message.role === "system" && message.content.startsWith(`${marker}\n`);
}

function isAnyContextLaneMessage(message: LlmMessage): boolean {
  return message.role === "system" && message.content.startsWith(
    CONTEXT_LANE_PREFIX,
  );
}

function isDynamicTailMessage(message: LlmMessage): boolean {
  return (
    (isAnyContextLaneMessage(message) &&
      typeof message.content === "string" &&
      message.content.includes(DYNAMIC_TAIL_MARKER)) ||
    (message.role === "user" &&
      typeof message.content === "string" &&
      message.content.startsWith(STEERING_MESSAGE_PREFIX))
  );
}

function dynamicTailMessages(
  messages: readonly LlmMessage[],
): readonly LlmMessage[] {
  let startIndex = messages.length;
  while (
    startIndex > 0 &&
    isDynamicTailMessage(messages[startIndex - 1] as LlmMessage)
  ) {
    startIndex -= 1;
  }
  return messages.slice(startIndex);
}

function stablePrefixMessages(
  messages: readonly LlmMessage[],
): readonly LlmMessage[] {
  const stablePrefix: LlmMessage[] = [];
  for (const message of messages) {
    if (message.role !== "system" || isDynamicTailMessage(message)) {
      break;
    }
    stablePrefix.push(message);
  }
  return stablePrefix;
}

function estimateMessageTokens(messages: readonly LlmMessage[]): {
  readonly tokens: number;
  readonly imageTokens: number;
  readonly imageCount: number;
} {
  let textChars = 0;
  let imageCount = 0;
  for (const message of messages) {
    textChars += message.role.length + 16;
    if (message.contentParts === undefined || message.contentParts.length === 0) {
      textChars += message.content.length;
    } else {
      const parts = estimateContentParts(message.contentParts);
      textChars += parts.textChars;
      imageCount += parts.imageCount;
    }
    textChars += message.reasoningContent?.length ?? 0;
    textChars += message.toolCallId?.length ?? 0;
    for (const call of message.toolCalls ?? []) {
      textChars += call.id.length + call.name.length + call.argumentsJson.length + 24;
    }
  }
  const imageTokens = imageCount * DEFAULT_IMAGE_TOKENS;
  return {
    tokens: Math.ceil(textChars / 4) + imageTokens,
    imageTokens,
    imageCount,
  };
}

function estimateContentParts(parts: readonly LlmMessageContentPart[]): {
  readonly textChars: number;
  readonly imageCount: number;
} {
  let textChars = 0;
  let imageCount = 0;
  for (const part of parts) {
    if (part.type === "text") {
      textChars += part.text.length + 12;
    } else {
      imageCount += 1;
      textChars += part.imageUrl.detail?.length ?? 0;
    }
  }
  return { textChars, imageCount };
}

function estimateToolTokens(tools: readonly LlmToolSchema[]): number {
  const chars = tools.reduce(
    (total, tool) =>
      total +
      tool.name.length +
      tool.description.length +
      tool.inputSchemaJson.length +
      32,
    0,
  );
  return Math.ceil(chars / 4);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}
