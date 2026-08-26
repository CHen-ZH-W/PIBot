import { isStopCommandText } from "../core/commands";
import {
  enterCoordinatorMode,
  exitCoordinatorMode,
  setAgentRuntimeMode,
  type AgentMode,
  type AgentRuntimeState,
} from "./mode";

export interface ModeSwitchRequest {
  readonly mode: AgentMode;
  readonly goal?: string;
}

export function isAgentStopCommand(text: string): boolean {
  return isStopCommandText(text);
}

export function parseSteeringMessage(text: string): string | undefined {
  const match = /^(?:steer|steering)\s*:\s*(.+)$/isu.exec(text.trim());
  return match?.[1]?.trim() || undefined;
}

export function parseFollowUpMessage(text: string): string | undefined {
  const match =
    /^(?:follow[-\s]?up|queue|next|later|排队|稍后|下一步|后续)\s*[:：]\s*(.+)$/isu.exec(
      text.trim(),
    );
  return match?.[1]?.trim() || undefined;
}

export function renderInlineSteering(text: string): string {
  return `User sent this in-flight update:\n${text.trim()}`;
}

export function parseModeSwitchMessage(
  text: string,
): ModeSwitchRequest | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const exitCoordinator =
    /(?:退出|关闭|离开|结束)\s*(?:coordinator|协调|协调者|多\s*agent|multi[-\s]?agent)\s*(?:模式)?/iu
      .test(trimmed) ||
    /^(?:exit|leave|disable)\s+(?:coordinator|coordinator\s+mode)$/iu
      .test(trimmed);
  if (exitCoordinator) {
    return { mode: "execute" };
  }

  const coordinatorPrefix =
    /^(?:\/?coordinator|coordinator\s+mode|协调模式|协调者模式|多\s*agent\s*模式|multi[-\s]?agent\s+mode)\s*[:：]?\s*(.*)$/isu
      .exec(trimmed);
  if (coordinatorPrefix !== null) {
    return {
      mode: "coordinator",
      ...optionalString("goal", coordinatorPrefix[1]?.trim() || undefined),
    };
  }

  const enterCoordinator =
    /(?:进入|使用|启用|开启|切换到|用)\s*(?:coordinator|协调|协调者|多\s*agent|multi[-\s]?agent)\s*(?:模式)?/iu
      .test(trimmed) ||
    /(?:coordinator|multi[-\s]?agent)\s+mode/iu.test(trimmed);
  if (enterCoordinator) {
    return {
      mode: "coordinator",
      goal: trimmed,
    };
  }

  return undefined;
}

export function applyModeSwitch(
  state: AgentRuntimeState,
  request: ModeSwitchRequest,
): void {
  if (request.mode === "coordinator") {
    enterCoordinatorMode(state, request.goal);
    return;
  }

  if (state.mode === "coordinator") {
    exitCoordinatorMode(state);
  } else {
    setAgentRuntimeMode(state, request.mode);
  }
}

export function renderModeSwitchSteering(request: ModeSwitchRequest): string {
  if (request.mode === "coordinator") {
    return [
      "The user requested Coordinator Mode for this run.",
      "Coordinate with tmux child agents, collect structured results, and avoid direct file mutations in the main agent.",
      ...(request.goal === undefined ? [] : [`Goal: ${request.goal}`]),
    ].join("\n");
  }

  return "The user requested leaving Coordinator Mode and returning to Execute Mode.";
}

function optionalString<Key extends string>(
  key: Key,
  value: string | undefined,
): { readonly [Property in Key]: string } | object {
  if (value === undefined) {
    return {};
  }

  return { [key]: value } as { readonly [Property in Key]: string };
}
