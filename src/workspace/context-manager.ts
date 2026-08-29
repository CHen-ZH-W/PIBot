import type { ModelRequest } from "../agent/model";
import type {
  LlmMessage,
  LlmMessageContentPart,
  LlmMessageContextLane,
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
const AUTHORITY_MARKER_PREFIX = "[pibot-context-authority:";
const KIND_MARKER_PREFIX = "[pibot-context-kind:";
const STABLE_PREFIX_MARKER = "[pibot-context-placement:stable-prefix]";
const BEFORE_CURRENT_USER_MARKER =
  "[pibot-context-placement:before-current-user]";
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

export type ContextLaneAuthority =
  | "system"
  | "developer"
  | "user"
  | "assistant";

export type ContextLaneKind = LlmMessageContextLane["kind"];

export type ContextLanePlacement = LlmMessageContextLane["placement"];

export interface ContextLane {
  readonly id: string;
  readonly authority: ContextLaneAuthority;
  readonly kind: ContextLaneKind;
  readonly content: string;
  readonly placement: ContextLanePlacement;
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

  /** Adds or replaces a named, explicitly-authorized model-only context lane. */
  projectContextLane(
    request: ModelRequest,
    lane: ContextLane,
  ): ModelRequest {
    const normalizedId = normalizeContextLaneId(lane.id);
    const marker = contextLaneMarker(normalizedId);
    const laneMessage: LlmMessage = {
      role: lane.authority,
      contextLane: {
        id: normalizedId,
        kind: lane.kind,
        placement: lane.placement,
      },
      content: [
        marker,
        `${AUTHORITY_MARKER_PREFIX}${lane.authority}]`,
        `${KIND_MARKER_PREFIX}${lane.kind}]`,
        placementMarker(lane.placement),
        lane.content,
      ].join("\n"),
    };
    const messages = request.messages.filter(
      (message) => !isContextLaneMessage(message, normalizedId),
    );
    if (lane.placement === "dynamic_tail") {
      return {
        ...request,
        messages: [...messages, laneMessage],
      };
    }
    if (lane.placement === "before_current_user") {
      return {
        ...request,
        messages: insertBeforeCurrentUser(messages, laneMessage),
      };
    }

    const boundary = stablePrefixBoundary(messages);
    return {
      ...request,
      messages: [
        ...messages.slice(0, boundary),
        laneMessage,
        ...messages.slice(boundary),
      ],
    };
  }

  replaceHistoryMessages(
    request: ModelRequest,
    history: readonly LlmMessage[],
  ): ModelRequest {
    const stablePrefix = stablePrefixMessages(request.messages);
    const beforeCurrentUserLanes = request.messages.filter(
      isBeforeCurrentUserLaneMessage,
    );
    const dynamicLanes = dynamicTailMessages(request.messages);
    let messages = [...stablePrefix, ...history, ...dynamicLanes];
    for (const lane of beforeCurrentUserLanes) {
      messages = insertBeforeCurrentUser(messages, lane);
    }
    return {
      ...request,
      messages,
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

/** Projects authority-typed context lanes on every model step. */
export class ContextLanesHook implements RuntimeHook {
  private readonly contextManager: ContextManager;

  constructor(
    private readonly lanes: readonly ContextLane[],
    contextManager?: ContextManager,
  ) {
    this.contextManager = contextManager ?? new ContextManager();
  }

  beforeModelCall(context: RuntimeModelCallHookContext): ModelRequest {
    return this.lanes.reduce(
      (request, lane) => this.contextManager.projectContextLane(request, lane),
      context.request,
    );
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
      role: "developer",
      content: [
        "[pibot-context:exact-user-intent]",
        "[pibot-context-authority:developer]",
        "[pibot-context-kind:instruction]",
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
  return `${CONTEXT_LANE_PREFIX}${id}]`;
}

function normalizeContextLaneId(id: string): string {
  const normalized = id.trim().toLowerCase().replace(/[^a-z0-9_-]+/gu, "-");
  if (normalized.length === 0) {
    throw new Error("Context lane id must not be empty");
  }
  return normalized;
}

function isContextLaneMessage(message: LlmMessage, id: string): boolean {
  return message.contextLane?.id === id;
}

export function isModelContextLaneMessage(message: LlmMessage): boolean {
  return message.contextLane !== undefined;
}

export function isProjectedContextLaneMessage(message: LlmMessage): boolean {
  return message.contextLane !== undefined;
}

function placementMarker(placement: ContextLanePlacement): string {
  switch (placement) {
    case "stable_prefix":
      return STABLE_PREFIX_MARKER;
    case "before_current_user":
      return BEFORE_CURRENT_USER_MARKER;
    case "dynamic_tail":
      return DYNAMIC_TAIL_MARKER;
  }
}

function isBeforeCurrentUserLaneMessage(message: LlmMessage): boolean {
  return message.contextLane?.placement === "before_current_user";
}

function insertBeforeCurrentUser(
  messages: readonly LlmMessage[],
  lane: LlmMessage,
): LlmMessage[] {
  let currentUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" && !isModelContextLaneMessage(message)) {
      currentUserIndex = index;
      break;
    }
  }
  const boundary = currentUserIndex >= 0
    ? currentUserIndex
    : dynamicTailStartIndex(messages);
  return [
    ...messages.slice(0, boundary),
    lane,
    ...messages.slice(boundary),
  ];
}

function isDynamicTailMessage(message: LlmMessage): boolean {
  return (
    message.contextLane?.placement === "dynamic_tail" ||
    (message.role === "user" &&
      typeof message.content === "string" &&
      message.content.startsWith(STEERING_MESSAGE_PREFIX))
  );
}

function dynamicTailMessages(
  messages: readonly LlmMessage[],
): readonly LlmMessage[] {
  return messages.slice(dynamicTailStartIndex(messages));
}

function dynamicTailStartIndex(messages: readonly LlmMessage[]): number {
  let startIndex = messages.length;
  while (startIndex > 0 && isDynamicTailMessage(messages[startIndex - 1]!)) {
    startIndex -= 1;
  }
  return startIndex;
}

function stablePrefixBoundary(messages: readonly LlmMessage[]): number {
  let boundary = 0;
  while (boundary < messages.length) {
    const message = messages[boundary]!;
    if (
      (message.role !== "system" && message.role !== "developer") ||
      isDynamicTailMessage(message) ||
      isBeforeCurrentUserLaneMessage(message)
    ) {
      break;
    }
    boundary += 1;
  }
  return boundary;
}

function stablePrefixMessages(
  messages: readonly LlmMessage[],
): readonly LlmMessage[] {
  return messages.slice(0, stablePrefixBoundary(messages));
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
