import type { LlmMessage, LlmMessageToolCall } from "./agent";

/**
 * OpenAI-compatible providers require an assistant message with tool_calls to
 * be followed immediately by one tool result for every requested call id.
 * Runtime interrupts can leave durable history in a different append order, so
 * repair the provider-facing view without rewriting the append-only log.
 */
export function repairToolCallMessageOrder(
  messages: readonly LlmMessage[],
): readonly LlmMessage[] {
  const repaired: LlmMessage[] = [];
  const consumed = new Set<number>();

  for (const [index, message] of messages.entries()) {
    if (consumed.has(index)) {
      continue;
    }

    if (message.role === "tool") {
      continue;
    }

    repaired.push(message);
    const toolCalls = message.toolCalls ?? [];
    if (message.role !== "assistant" || toolCalls.length === 0) {
      continue;
    }

    const toolResults = collectFollowingToolResults(messages, index, toolCalls);
    for (const toolCall of toolCalls) {
      const toolResult = toolResults.results.get(toolCall.id);
      if (toolResult === undefined) {
        repaired.push(missingToolResultMessage(toolCall));
        continue;
      }

      const resultIndex = toolResults.indexes.get(toolCall.id);
      if (resultIndex !== undefined) {
        consumed.add(resultIndex);
      }
      repaired.push(toolResult);
    }
  }

  return repaired;
}

export function hasUnresolvedToolCalls(
  messages: readonly LlmMessage[],
): boolean {
  let pending: Set<string> | undefined;

  for (const message of messages) {
    if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
      if (pending !== undefined && pending.size > 0) {
        return true;
      }
      pending = new Set(message.toolCalls?.map((toolCall) => toolCall.id));
      continue;
    }

    if (
      message.role === "tool" &&
      message.toolCallId !== undefined &&
      pending?.has(message.toolCallId) === true
    ) {
      pending.delete(message.toolCallId);
      if (pending.size === 0) {
        pending = undefined;
      }
    }
  }

  return pending !== undefined && pending.size > 0;
}

function collectFollowingToolResults(
  messages: readonly LlmMessage[],
  assistantIndex: number,
  toolCalls: readonly LlmMessageToolCall[],
): {
  readonly results: ReadonlyMap<string, LlmMessage>;
  readonly indexes: ReadonlyMap<string, number>;
} {
  const expected = new Set(toolCalls.map((toolCall) => toolCall.id));
  const results = new Map<string, LlmMessage>();
  const indexes = new Map<string, number>();

  for (
    let index = assistantIndex + 1;
    index < messages.length && results.size < expected.size;
    index += 1
  ) {
    const message = messages[index];
    if (message === undefined) {
      continue;
    }

    if (
      message.role === "assistant" &&
      (message.toolCalls?.length ?? 0) > 0
    ) {
      break;
    }

    if (
      message.role === "tool" &&
      message.toolCallId !== undefined &&
      expected.has(message.toolCallId) &&
      !results.has(message.toolCallId)
    ) {
      results.set(message.toolCallId, message);
      indexes.set(message.toolCallId, index);
    }
  }

  return { results, indexes };
}

function missingToolResultMessage(toolCall: LlmMessageToolCall): LlmMessage {
  return {
    role: "tool",
    toolCallId: toolCall.id,
    content: JSON.stringify({
      ok: false,
      callId: toolCall.id,
      error: {
        code: "missing_tool_result",
        message:
          `Tool result for "${toolCall.name}" was not recorded before the ` +
          "conversation continued. Treat this tool call as interrupted.",
        retryable: false,
      },
    }),
  };
}
