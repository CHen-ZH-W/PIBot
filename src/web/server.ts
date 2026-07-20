import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { errorFields, type AppLogger, NoopLogger } from "../app/logging";
import {
  evolutionChannelKey,
  evolutionContextTopic,
  type EvolutionContextRecorder,
} from "../evolution/channel-context";
import type {
  EvolutionController,
  ManualEvolutionSignalInput,
} from "../evolution/controller";
import type {
  EvolutionScope,
  EvolutionSeverity,
  EvolutionSignalSource,
  EvolutionTicket,
  EvolutionTarget,
} from "../evolution/types";
import type { RuntimeCodeActivationController } from "../evolution/runtime-activation";
import {
  importOpenAiSkillPackage,
  scanWorkspaceSkills,
  type SkillImportFile,
} from "../workspace/skills";
import type { WebAgentRunner } from "./agent";
import type {
  FileWebConversationStore,
  WebConversation,
  WebConversationRole,
} from "./conversations";
import { WEBUI_CSS, WEBUI_HTML, WEBUI_SCRIPT } from "./static";

export interface WebUiServerOptions {
  readonly host: string;
  readonly port: number;
  readonly workspaceRoot: string;
  readonly evolution: EvolutionController;
  readonly evolutionContext?: EvolutionContextRecorder;
  readonly runtimeActivation?: RuntimeCodeActivationController | undefined;
  readonly conversations: FileWebConversationStore;
  readonly agent?: WebAgentRunner;
  readonly logger?: AppLogger;
  readonly pibotSkillsRoot?: string;
  readonly disabledSkills?: readonly string[];
  readonly maxSkills?: number;
  readonly maxSkillFileBytes?: number;
}

export interface StartedWebUiServer {
  readonly server: Server;
  readonly url: string;
}

interface WebUiRuntimeState {
  readonly instanceId: string;
  readonly startedAt: string;
  readonly pid: number;
}

export async function startWebUiServer(
  options: WebUiServerOptions,
): Promise<StartedWebUiServer> {
  const logger = options.logger ?? new NoopLogger();
  const runtimeState: WebUiRuntimeState = {
    instanceId: [
      process.pid,
      Date.now().toString(36),
      Math.random().toString(36).slice(2),
    ].join("-"),
    startedAt: new Date().toISOString(),
    pid: process.pid,
  };
  const server = createServer((request, response) => {
    void routeRequest(options, runtimeState, request, response).catch(
      (error: unknown) => {
        logger.warn("webui_request_failed", errorFields(error));
        sendJson(response, 500, { error: errorMessage(error) });
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const url = `http://${options.host}:${options.port}`;
  logger.info("webui_started", { url });
  return { server, url };
}

async function routeRequest(
  options: WebUiServerOptions,
  runtimeState: WebUiRuntimeState,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");
  if (method === "GET" && url.pathname === "/") {
    sendText(response, 200, "text/html; charset=utf-8", WEBUI_HTML);
    return;
  }
  if (method === "GET" && url.pathname === "/assets/app.css") {
    sendText(response, 200, "text/css; charset=utf-8", WEBUI_CSS);
    return;
  }
  if (method === "GET" && url.pathname === "/assets/app.js") {
    sendText(response, 200, "text/javascript; charset=utf-8", WEBUI_SCRIPT);
    return;
  }
  if (method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, runtime: runtimeState });
    return;
  }
  if (method === "GET" && url.pathname === "/api/state") {
    const [evolution, conversations, skills] = await Promise.all([
      options.evolution.readSnapshot(),
      readWebConversations(options),
      readWebSkills(options),
    ]);
    const evolutionContext = await readEvolutionContext(
      options,
      evolution.tickets,
    );
    sendJson(response, 200, {
      evolution: {
        ...evolution,
        context: evolutionContext,
        runtimeActivation: runtimeActivationState(options),
      },
      runtime: runtimeState,
      conversations,
      skills,
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/skills") {
    sendJson(response, 200, {
      skills: await readWebSkills(options),
    });
    return;
  }
  if (method === "POST" && url.pathname === "/api/skills/import") {
    if (options.pibotSkillsRoot === undefined) {
      sendJson(response, 400, { error: "Pibot Skills root is not configured" });
      return;
    }
    const body = await readJsonBody(request);
    const result = await importOpenAiSkillPackage({
      pibotSkillsRoot: options.pibotSkillsRoot,
      files: skillImportFilesField(body, "files"),
      overwrite: optionalBooleanValue(body, "overwrite") ?? false,
      ...(options.maxSkillFileBytes === undefined
        ? {}
        : { maxSkillFileBytes: options.maxSkillFileBytes }),
    });
    sendJson(response, 200, {
      import: result,
      skills: await readWebSkills(options),
    });
    return;
  }
  if (method === "POST" && url.pathname === "/api/evolution/context/messages") {
    if (options.evolutionContext === undefined) {
      sendJson(response, 400, { error: "Evolution context is not configured" });
      return;
    }
    const body = await readJsonBody(request);
    const ticketId = optionalStringValue(body, "ticketId");
    const evolution = await options.evolution.readSnapshot();
    if (ticketId !== undefined) {
      assertKnownEvolutionTicket(evolution.tickets, ticketId);
    }
    await options.evolutionContext.appendEvolutionContextMessage({
      role: "user",
      content: stringField(body, "content"),
      ...(ticketId === undefined ? {} : { ticketId }),
    });
    sendJson(response, 200, {
      context: await readEvolutionContext(options, evolution.tickets),
    });
    return;
  }
  if (method === "POST" && url.pathname === "/api/evolution/signals") {
    const body = await readJsonBody(request);
    const summary = stringField(body, "summary");
    const input: ManualEvolutionSignalInput = {
      summary,
      ...optionalBodyString(body, "details"),
      ...optionalEnumBodyValue(
        "source",
        optionalEnum<EvolutionSignalSource>(body, "source", [
          "slack_error",
          "slack_user",
          "webui_user",
          "cli_user",
          "runtime_error",
        ]),
      ),
      ...optionalEnumBodyValue(
        "severity",
        optionalEnum<EvolutionSeverity>(body, "severity", [
          "info",
          "warning",
          "critical",
        ]),
      ),
      ...optionalEnumBodyValue(
        "scope",
        optionalEnum<EvolutionScope>(body, "scope", [
          "global_agent",
          "profile",
          "adapter",
          "runtime",
        ]),
      ),
      ...optionalEnumBodyValue(
        "target",
        optionalEnum<EvolutionTarget>(body, "target", [
          "self_instructions",
          "prompt",
          "policy",
          "skill",
          "tool",
          "runtime_code",
        ]),
      ),
      ...optionalBodyString(body, "actor"),
    };
    const result = await options.evolution.submitManualSignal(input);
    const evolution = await options.evolution.readSnapshot();
    sendJson(response, 200, {
      ...result,
      context: await readEvolutionContext(options, evolution.tickets),
    });
    return;
  }
  const proposalMatch = matchRoute(
    url.pathname,
    /^\/api\/evolution\/tickets\/([^/]+)\/proposal$/u,
  );
  if (method === "POST" && proposalMatch !== undefined) {
    const body = await readJsonBody(request);
    const ticket = await options.evolution.updateProposal(proposalMatch, {
      ...optionalBodyString(body, "title"),
      ...optionalBodyString(body, "summary"),
      ...optionalBodyString(body, "diagnosis"),
      ...optionalBodyString(body, "versionTopic"),
      ...optionalBodyString(body, "proposedSelfInstructions"),
      ...optionalBodyString(body, "risk"),
      ...optionalBodyString(body, "rollbackPlan"),
      ...optionalBodyString(body, "actor"),
    });
    const evolution = await options.evolution.readSnapshot();
    sendJson(response, 200, {
      ticket,
      context: await readEvolutionContext(options, evolution.tickets),
    });
    return;
  }
  const approveMatch = matchRoute(
    url.pathname,
    /^\/api\/evolution\/tickets\/([^/]+)\/approve$/u,
  );
  if (method === "POST" && approveMatch !== undefined) {
    const body = await readJsonBody(request);
    const ticket = await options.evolution.approveTicket(approveMatch, {
      ...optionalBodyString(body, "actor"),
      ...optionalBodyString(body, "note"),
    });
    const evolution = await options.evolution.readSnapshot();
    sendJson(response, 200, {
      ticket,
      context: await readEvolutionContext(options, evolution.tickets),
    });
    return;
  }
  const implementationMatch = matchRoute(
    url.pathname,
    /^\/api\/evolution\/tickets\/([^/]+)\/implementation$/u,
  );
  if (method === "POST" && implementationMatch !== undefined) {
    await streamEvolutionImplementation(options, response, {
      ticketId: implementationMatch,
    });
    return;
  }
  const activationMatch = matchRoute(
    url.pathname,
    /^\/api\/evolution\/tickets\/([^/]+)\/activation$/u,
  );
  if (method === "POST" && activationMatch !== undefined) {
    if (options.runtimeActivation === undefined) {
      sendJson(response, 400, {
        error: "Runtime activation is disabled on the server.",
      });
      return;
    }
    const body = await readJsonBody(request);
    const actorName = optionalStringValue(body, "actor")?.trim() || "webui";
    const result = await options.evolution.activateRuntimeCodeVersionForTicket(
      activationMatch,
      {
        actor: actorName,
        commandLabel: options.runtimeActivation.label,
        workspaceRoot: options.workspaceRoot,
      },
    );
    const evolution = await options.evolution.readSnapshot();
    sendJson(response, 202, {
      ticket: result.ticket,
      version: result.version,
      activeRuntimeVersion: result.active,
      publish: result.publish,
      alreadyActive: result.alreadyActive,
      runtimeActivation: runtimeActivationState(options),
      context: await readEvolutionContext(options, evolution.tickets),
    });
    try {
      if (result.alreadyActive) {
        return;
      }
      if (result.ticket === undefined) {
        throw new Error(`Runtime version ${result.version.id} has no source ticket`);
      }
      options.runtimeActivation.request({
        ticket: result.ticket,
        actor: actorName,
      });
    } catch (error: unknown) {
      (options.logger ?? new NoopLogger()).error(
        "runtime_activation_request_failed",
        errorFields(error),
      );
    }
    return;
  }
  const runtimeVersionActivationMatch = matchRoute(
    url.pathname,
    /^\/api\/evolution\/runtime-code\/versions\/([^/]+)\/activate$/u,
  );
  if (method === "POST" && runtimeVersionActivationMatch !== undefined) {
    if (options.runtimeActivation === undefined) {
      sendJson(response, 400, {
        error: "Runtime activation is disabled on the server.",
      });
      return;
    }
    const body = await readJsonBody(request);
    const actorName = optionalStringValue(body, "actor")?.trim() || "webui";
    const result = await options.evolution.activateRuntimeCodeVersion(
      runtimeVersionActivationMatch,
      {
        actor: actorName,
        commandLabel: options.runtimeActivation.label,
        workspaceRoot: options.workspaceRoot,
      },
    );
    const evolution = await options.evolution.readSnapshot();
    sendJson(response, 202, {
      ticket: result.ticket,
      version: result.version,
      activeRuntimeVersion: result.active,
      publish: result.publish,
      alreadyActive: result.alreadyActive,
      runtimeActivation: runtimeActivationState(options),
      context: await readEvolutionContext(options, evolution.tickets),
    });
    try {
      if (result.alreadyActive) {
        return;
      }
      if (result.ticket === undefined) {
        throw new Error(`Runtime version ${result.version.id} has no source ticket`);
      }
      options.runtimeActivation.request({
        ticket: result.ticket,
        actor: actorName,
      });
    } catch (error: unknown) {
      (options.logger ?? new NoopLogger()).error(
        "runtime_activation_request_failed",
        errorFields(error),
      );
    }
    return;
  }
  const rejectMatch = matchRoute(
    url.pathname,
    /^\/api\/evolution\/tickets\/([^/]+)\/reject$/u,
  );
  if (method === "POST" && rejectMatch !== undefined) {
    const body = await readJsonBody(request);
    const ticket = await options.evolution.rejectTicket(rejectMatch, {
      ...optionalBodyString(body, "actor"),
      ...optionalBodyString(body, "note"),
    });
    const evolution = await options.evolution.readSnapshot();
    sendJson(response, 200, {
      ticket,
      context: await readEvolutionContext(options, evolution.tickets),
    });
    return;
  }
  const applyMatch = matchRoute(
    url.pathname,
    /^\/api\/evolution\/tickets\/([^/]+)\/apply$/u,
  );
  if (method === "POST" && applyMatch !== undefined) {
    const body = await readJsonBody(request);
    const ticket = await options.evolution.applyTicket(applyMatch, {
      ...optionalBodyString(body, "actor"),
    });
    const evolution = await options.evolution.readSnapshot();
    sendJson(response, 200, {
      ticket,
      context: await readEvolutionContext(options, evolution.tickets),
    });
    return;
  }
  if (
    method === "POST" &&
    url.pathname === "/api/evolution/self-instructions/rollback"
  ) {
    const body = await readJsonBody(request);
    const version = await options.evolution.rollbackSelfInstructions({
      versionId: stringField(body, "versionId"),
      ...optionalBodyString(body, "actor"),
      ...optionalBodyString(body, "note"),
    });
    sendJson(response, 200, { version });
    return;
  }
  const approvalMatch = matchRoute(
    url.pathname,
    /^\/api\/approvals\/([^/]+)$/u,
  );
  if (method === "POST" && approvalMatch !== undefined) {
    if (options.agent === undefined) {
      sendJson(response, 400, { error: "WebUI agent runner is not configured" });
      return;
    }
    const body = await readJsonBody(request);
    const result = await options.agent.decideApproval(
      approvalMatch,
      booleanField(body, "approved"),
    );
    sendJson(response, result.ok ? 200 : 404, result);
    return;
  }
  if (method === "POST" && url.pathname === "/api/conversations") {
    const body = await readJsonBody(request);
    const conversation = await options.conversations.create(
      optionalStringValue(body, "title"),
    );
    sendJson(response, 200, { conversation });
    return;
  }
  const conversationMatch = matchRoute(
    url.pathname,
    /^\/api\/conversations\/([^/]+)$/u,
  );
  if (method === "PATCH" && conversationMatch !== undefined) {
    const body = await readJsonBody(request);
    const conversation = await options.conversations.rename(
      conversationMatch,
      stringField(body, "title"),
    );
    sendJson(response, 200, { conversation });
    return;
  }
  if (method === "DELETE" && conversationMatch !== undefined) {
    if (options.agent !== undefined) {
      try {
        await options.agent.deleteChannelWorkspace(conversationMatch);
      } catch {
        // best-effort cleanup of server-side channel storage
      }
    }
    await options.conversations.delete(conversationMatch);
    sendJson(response, 200, { deleted: true, id: conversationMatch });
    return;
  }
  const messageMatch = matchRoute(
    url.pathname,
    /^\/api\/conversations\/([^/]+)\/messages$/u,
  );
  if (method === "POST" && messageMatch !== undefined) {
    const body = await readJsonBody(request);
    const role = webConversationRoleField(body, "role");
    const content = stringField(body, "content");
    if (
      role === "user" &&
      options.agent !== undefined &&
      url.searchParams.get("stream") === "1"
    ) {
      await streamAgentConversationMessage(options, request, response, {
        conversationId: messageMatch,
        content,
      });
      return;
    }
    if (role === "user" && options.agent !== undefined) {
      const run = await options.agent.runUserMessage(messageMatch, content);
      const conversation = await options.agent.getConversation(messageMatch);
      const evolution = await options.evolution.readSnapshot();
      sendJson(response, 200, {
        conversation,
        run,
        evolution: {
          ...evolution,
          runtimeActivation: runtimeActivationState(options),
        },
        context: await readEvolutionContext(options, evolution.tickets),
      });
      return;
    }

    const conversation = await options.conversations.appendMessage(
      messageMatch,
      role,
      content,
    );
    sendJson(response, 200, { conversation });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

async function readWebConversations(
  options: WebUiServerOptions,
): Promise<readonly WebConversation[]> {
  return options.agent === undefined
    ? options.conversations.list()
    : options.agent.listConversations();
}

async function readWebSkills(options: WebUiServerOptions) {
  const result = await scanWorkspaceSkills(options.workspaceRoot, {
    ...(options.pibotSkillsRoot === undefined
      ? {}
      : { pibotSkillsRoot: options.pibotSkillsRoot }),
    ...(options.disabledSkills === undefined
      ? {}
      : { disabledSkills: options.disabledSkills }),
    ...(options.maxSkills === undefined ? {} : { maxSkills: options.maxSkills }),
    ...(options.maxSkillFileBytes === undefined
      ? {}
      : { maxSkillFileBytes: options.maxSkillFileBytes }),
  });
  return {
    skills: result.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      location: skill.location,
      disableModelInvocation: skill.disableModelInvocation,
    })),
    disabledSkills: result.disabledSkills,
    issues: result.issues,
  };
}

async function readEvolutionContext(
  options: WebUiServerOptions,
  tickets: readonly EvolutionTicket[] = [],
) {
  return options.evolutionContext === undefined
    ? {
        key: evolutionChannelKey(),
        messages: [],
        topics: tickets.map(evolutionContextTopic),
        ticketContexts: [],
      }
    : options.evolutionContext.readEvolutionContext({
      tickets,
    });
}

function runtimeActivationState(options: WebUiServerOptions) {
  return {
    configured: options.runtimeActivation !== undefined,
    ...(options.runtimeActivation === undefined
      ? {}
      : {
          label: options.runtimeActivation.label,
          mode: options.runtimeActivation.mode,
        }),
  };
}

function assertKnownEvolutionTicket(
  tickets: readonly EvolutionTicket[],
  ticketId: string,
): void {
  if (!tickets.some((ticket) => ticket.id === ticketId)) {
    throw new Error(`Unknown evolution ticket: ${ticketId}`);
  }
}

async function streamAgentConversationMessage(
  options: WebUiServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
  input: {
    readonly conversationId: string;
    readonly content: string;
  },
): Promise<void> {
  if (options.agent === undefined) {
    sendJson(response, 400, { error: "WebUI agent runner is not configured" });
    return;
  }

  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  });

  const controller = new AbortController();
  const abortOnClose = () => {
    if (!response.writableEnded) {
      controller.abort();
    }
  };
  const abortOnRequest = () => {
    controller.abort();
  };
  response.once("close", abortOnClose);
  request.once("aborted", abortOnRequest);

  try {
    const run = await options.agent.runUserMessage(
      input.conversationId,
      input.content,
      {
        signal: controller.signal,
        onEvent: async (event) => {
          await writeNdjson(response, event);
        },
      },
    );
    const conversation = await options.agent.getConversation(input.conversationId);
    const evolution = await options.evolution.readSnapshot();
    await writeNdjson(response, {
      type: "done",
      conversation,
      run,
      evolution: {
        ...evolution,
        runtimeActivation: runtimeActivationState(options),
      },
      context: await readEvolutionContext(options, evolution.tickets),
    });
  } catch (error: unknown) {
    await writeNdjson(response, {
      type: "error",
      error: errorMessage(error),
    });
  } finally {
    response.off("close", abortOnClose);
    request.off("aborted", abortOnRequest);
    if (!response.writableEnded) {
      response.end();
    }
  }
}

async function streamEvolutionImplementation(
  options: WebUiServerOptions,
  response: ServerResponse,
  input: {
    readonly ticketId: string;
  },
): Promise<void> {
  if (options.agent === undefined) {
    sendJson(response, 400, { error: "WebUI agent runner is not configured" });
    return;
  }

  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  });

  try {
    const run = await options.agent.runEvolutionTicketImplementation(
      input.ticketId,
      {
        onEvent: async (event) => {
          await writeNdjson(response, event);
        },
      },
    );
    const evolution = await options.evolution.readSnapshot();
    await writeNdjson(response, {
      type: "done",
      run,
      evolution: {
        ...evolution,
        runtimeActivation: runtimeActivationState(options),
      },
      context: await readEvolutionContext(options, evolution.tickets),
    });
  } catch (error: unknown) {
    await writeNdjson(response, {
      type: "error",
      error: errorMessage(error),
    });
  } finally {
    if (!response.writableEnded) {
      response.end();
    }
  }
}

async function writeNdjson(
  response: ServerResponse,
  value: unknown,
): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  if (!response.write(`${JSON.stringify(value)}\n`)) {
    await once(response, "drain");
  }
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text.length === 0) {
    return {};
  }
  const parsed = JSON.parse(text) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  sendText(
    response,
    statusCode,
    "application/json; charset=utf-8",
    `${JSON.stringify(value)}\n`,
  );
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  text: string,
): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(text);
}

function matchRoute(pathname: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(pathname);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

function stringField(
  body: Record<string, unknown>,
  key: string,
): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function booleanField(
  body: Record<string, unknown>,
  key: string,
): boolean {
  const value = body[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function optionalBooleanValue(
  body: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function optionalStringValue(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function skillImportFilesField(
  body: Record<string, unknown>,
  key: string,
): readonly SkillImportFile[] {
  const value = body[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${key} must be a non-empty array`);
  }
  return value.map((entry, index): SkillImportFile => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry)
    ) {
      throw new Error(`${key}[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const filePath = record.path;
    const content = record.content;
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      throw new Error(`${key}[${index}].path must be a non-empty string`);
    }
    if (typeof content !== "string") {
      throw new Error(`${key}[${index}].content must be a string`);
    }
    return {
      path: filePath,
      content,
    };
  });
}

function optionalBodyString<Key extends string>(
  body: Record<string, unknown>,
  key: Key,
): { readonly [Property in Key]: string } | object {
  const value = optionalStringValue(body, key);
  return value === undefined ? {} : { [key]: value } as {
    readonly [Property in Key]: string;
  };
}

function optionalEnum<T extends string>(
  body: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = optionalStringValue(body, key);
  if (value === undefined) {
    return undefined;
  }
  if (allowed.includes(value as T)) {
    return value as T;
  }
  throw new Error(`${key} must be one of: ${allowed.join(", ")}`);
}

function optionalEnumBodyValue<Key extends string, Value extends string>(
  key: Key,
  value: Value | undefined,
): { readonly [Property in Key]: Value } | object {
  if (value === undefined) {
    return {};
  }
  return { [key]: value } as { readonly [Property in Key]: Value };
}

function webConversationRoleField(
  body: Record<string, unknown>,
  key: string,
): WebConversationRole {
  const value = stringField(body, key);
  if (value === "user" || value === "assistant" || value === "system") {
    return value;
  }
  throw new Error(`${key} must be one of: user, assistant, system`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
