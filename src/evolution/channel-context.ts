import type {
  SlackChannelId,
  SlackTeamId,
} from "../core/ids";
import type { ChannelSessionKey } from "../core/session";
import type {
  ChannelContextMessage,
  WorkspaceSessionStore,
} from "../workspace/session";
import {
  EVOLUTION_CHANNEL_NAME,
  type EvolutionTicket,
} from "./types";

export interface EvolutionContextMessageInput {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly createdAt?: string | Date;
  readonly ticketId?: string;
}

export interface EvolutionContextTopic {
  readonly ticketId: string;
  readonly title: string;
  readonly topic: string;
  readonly status: EvolutionTicket["status"];
  readonly target: EvolutionTicket["target"];
  readonly updatedAt: string;
}

export interface EvolutionTicketContextSnapshot {
  readonly ticketId: string;
  readonly key: ChannelSessionKey;
  readonly messages: readonly ChannelContextMessage[];
}

export interface EvolutionContextReadOptions {
  readonly tickets?: readonly EvolutionTicket[];
}

export interface EvolutionContextSnapshot {
  readonly key: ChannelSessionKey;
  readonly messages: readonly ChannelContextMessage[];
  readonly topics: readonly EvolutionContextTopic[];
  readonly ticketContexts: readonly EvolutionTicketContextSnapshot[];
}

export interface EvolutionContextRecorder {
  appendEvolutionContextMessage(
    input: EvolutionContextMessageInput,
  ): Promise<void>;
  readEvolutionContext(
    options?: EvolutionContextReadOptions,
  ): Promise<EvolutionContextSnapshot>;
}

export class SessionEvolutionContextRecorder implements EvolutionContextRecorder {
  constructor(private readonly sessions: WorkspaceSessionStore) {}

  async appendEvolutionContextMessage(
    input: EvolutionContextMessageInput,
  ): Promise<void> {
    await this.sessions.appendContextMessage(evolutionContextKey(input.ticketId), {
      message: {
        role: input.role,
        content: input.content,
      },
      source: input.role === "user" ? "webui" : "agent",
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    });
  }

  async readEvolutionContext(
    options: EvolutionContextReadOptions = {},
  ): Promise<EvolutionContextSnapshot> {
    const key = evolutionChannelKey();
    const tickets = options.tickets ?? [];
    return {
      key,
      messages: await this.sessions.readChannelContextMessages(key),
      topics: tickets.map(evolutionContextTopic),
      ticketContexts: await Promise.all(tickets.map(async (ticket) => {
        const ticketKey = evolutionTicketChannelKey(ticket.id);
        return {
          ticketId: ticket.id,
          key: ticketKey,
          messages: await this.sessions.readChannelContextMessages(ticketKey),
        };
      })),
    };
  }
}

export function evolutionContextKey(
  ticketId: string | undefined,
): ChannelSessionKey {
  return ticketId === undefined
    ? evolutionChannelKey()
    : evolutionTicketChannelKey(ticketId);
}

export function evolutionChannelKey(): ChannelSessionKey {
  return {
    teamId: "webui" as SlackTeamId,
    channelId: EVOLUTION_CHANNEL_NAME as SlackChannelId,
  };
}

export function evolutionTicketChannelKey(ticketId: string): ChannelSessionKey {
  return {
    teamId: "webui" as SlackTeamId,
    channelId: `${EVOLUTION_CHANNEL_NAME}--${ticketId}` as SlackChannelId,
  };
}

export function evolutionContextTopic(
  ticket: EvolutionTicket,
): EvolutionContextTopic {
  return {
    ticketId: ticket.id,
    title: ticket.title,
    topic: ticket.proposal.completionTopic ??
      ticket.proposal.versionTopic ??
      ticket.title,
    status: ticket.status,
    target: ticket.target,
    updatedAt: ticket.updatedAt,
  };
}
