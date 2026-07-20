type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type SlackTeamId = Brand<string, "SlackTeamId">;
export type SlackChannelId = Brand<string, "SlackChannelId">;
export type SlackUserId = Brand<string, "SlackUserId">;
export type SlackMessageTs = Brand<string, "SlackMessageTs">;
export type SlackEventId = Brand<string, "SlackEventId">;
export type SessionId = Brand<string, "SessionId">;
export type AgentRunId = Brand<string, "AgentRunId">;
export type AgentId = Brand<string, "AgentId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type MessageId = Brand<string, "MessageId">;
export type WorkspacePath = Brand<string, "WorkspacePath">;
