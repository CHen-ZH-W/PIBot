import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppLogger } from "../app/logging";
import type { EvolutionTicket } from "./types";

export interface RuntimeCodeActivationController {
  readonly label: string;
  readonly mode: "process_exit" | "terminal_supervisor" | "command";
  request(input: RuntimeCodeActivationRequest): void;
}

export interface RuntimeCodeActivationRequest {
  readonly ticket: EvolutionTicket;
  readonly actor: string;
}

export function createRuntimeCodeActivationController(input: {
  readonly workspaceRoot: string;
  readonly logger?: AppLogger | undefined;
  readonly enabled?: boolean | undefined;
  readonly command?: string | undefined;
  readonly terminalSupervisor?: boolean | undefined;
  readonly restartMarkerPath?: string | undefined;
  readonly label?: string | undefined;
  readonly delayMs?: number | undefined;
}): RuntimeCodeActivationController | undefined {
  if (input.enabled === false) {
    return undefined;
  }
  const delayMs = input.delayMs ?? 1500;
  const command = input.command?.trim();
  if (command === undefined || command.length === 0) {
    return new ProcessExitRuntimeCodeActivationController({
      label: input.label?.trim() || "terminal restart",
      mode: input.terminalSupervisor === true
        ? "terminal_supervisor"
        : "process_exit",
      restartMarkerPath: input.restartMarkerPath,
      delayMs,
      logger: input.logger,
    });
  }
  return new CommandRuntimeCodeActivationController({
    workspaceRoot: input.workspaceRoot,
    command,
    label: input.label?.trim() || "configured restart command",
    delayMs,
    logger: input.logger,
  });
}

class ProcessExitRuntimeCodeActivationController
  implements RuntimeCodeActivationController
{
  readonly label: string;
  readonly mode: "process_exit" | "terminal_supervisor";
  private readonly restartMarkerPath: string | undefined;
  private readonly delayMs: number;
  private readonly logger: AppLogger | undefined;

  constructor(input: {
    readonly label: string;
    readonly mode: "process_exit" | "terminal_supervisor";
    readonly restartMarkerPath?: string | undefined;
    readonly delayMs: number;
    readonly logger?: AppLogger | undefined;
  }) {
    this.label = input.label;
    this.mode = input.mode;
    this.restartMarkerPath = input.restartMarkerPath;
    this.delayMs = input.delayMs;
    this.logger = input.logger;
  }

  request(input: RuntimeCodeActivationRequest): void {
    const delayMs = Math.max(0, this.delayMs);
    this.logger?.info("runtime_activation_scheduled", {
      ticketId: input.ticket.id,
      versionId: input.ticket.rollout?.versionId,
      actor: input.actor,
      restart: this.label,
      delayMs,
    });
    setTimeout(() => {
      this.logger?.info("runtime_activation_started", {
        ticketId: input.ticket.id,
        versionId: input.ticket.rollout?.versionId,
        actor: input.actor,
        restart: this.label,
        mode: this.mode,
      });
      void this.writeRestartMarker(input).finally(() => {
        process.exit(0);
      });
    }, delayMs);
  }

  private async writeRestartMarker(
    input: RuntimeCodeActivationRequest,
  ): Promise<void> {
    if (
      this.mode !== "terminal_supervisor" ||
      this.restartMarkerPath === undefined
    ) {
      return;
    }
    try {
      await mkdir(dirname(this.restartMarkerPath), { recursive: true });
      await writeFile(
        this.restartMarkerPath,
        JSON.stringify({
          ts: new Date().toISOString(),
          ticketId: input.ticket.id,
          versionId: input.ticket.rollout?.versionId,
          actor: input.actor,
          restart: this.label,
        }) + "\n",
        "utf8",
      );
    } catch (error: unknown) {
      this.logger?.error("runtime_activation_marker_failed", {
        ticketId: input.ticket.id,
        versionId: input.ticket.rollout?.versionId,
        actor: input.actor,
        restart: this.label,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

class CommandRuntimeCodeActivationController
  implements RuntimeCodeActivationController
{
  readonly label: string;
  readonly mode = "command" as const;
  private readonly workspaceRoot: string;
  private readonly command: string;
  private readonly delayMs: number;
  private readonly logger: AppLogger | undefined;

  constructor(input: {
    readonly workspaceRoot: string;
    readonly command: string;
    readonly label: string;
    readonly delayMs: number;
    readonly logger?: AppLogger | undefined;
  }) {
    this.workspaceRoot = input.workspaceRoot;
    this.command = input.command;
    this.label = input.label;
    this.delayMs = input.delayMs;
    this.logger = input.logger;
  }

  request(input: RuntimeCodeActivationRequest): void {
    const delayMs = Math.max(0, this.delayMs);
    this.logger?.info("runtime_activation_scheduled", {
      ticketId: input.ticket.id,
      versionId: input.ticket.rollout?.versionId,
      actor: input.actor,
      restart: this.label,
      delayMs,
    });
    setTimeout(() => {
      this.startRestartCommand(input);
    }, delayMs);
  }

  private startRestartCommand(input: RuntimeCodeActivationRequest): void {
    this.logger?.info("runtime_activation_started", {
      ticketId: input.ticket.id,
      versionId: input.ticket.rollout?.versionId,
      actor: input.actor,
      restart: this.label,
    });
    const child = spawn(this.command, {
      cwd: this.workspaceRoot,
      shell: true,
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.once("error", (error) => {
      this.logger?.error("runtime_activation_failed", {
        ticketId: input.ticket.id,
        versionId: input.ticket.rollout?.versionId,
        actor: input.actor,
        restart: this.label,
        errorMessage: error.message,
      });
    });
    child.unref();
  }
}
