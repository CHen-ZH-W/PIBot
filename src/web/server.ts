import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { errorFields, type AppLogger, NoopLogger } from "../app/logging";
import {
  evolutionChannelKey,
  evolutionContextTopic,
  evolutionTicketChannelKey,
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
import type { ModelRuntime } from "../models/runtime";
import { formatModelRef } from "../models/types";
import type { WorkflowOrchestrator } from "../workflow/orchestrator";
import type { WorkflowEventRecord, WorkflowRunRecord } from "../workflow/types";
import {
  importOpenAiSkillPackage,
  scanWorkspaceSkills,
  type SkillImportFile,
} from "../workspace/skills";
import type { WebAgentRunner } from "./agent";
import {
  conversationTitleRetryReady,
  conversationTitleSource,
  type FileWebConversationStore,
  type WebConversation,
  type WebConversationRole,
} from "./conversations";
import { WEBUI_CSS, WEBUI_HTML, WEBUI_SCRIPT } from "./static";
import { DetachedWebRunService } from "./runs";

export interface WebUiServerOptions {
  readonly host: string;
  readonly port: number;
  readonly publicUrl?: string | undefined;
  readonly workspaceRoot: string;
  readonly evolution: EvolutionController;
  readonly evolutionContext?: EvolutionContextRecorder;
  readonly runtimeActivation?: RuntimeCodeActivationController | undefined;
  readonly conversations: FileWebConversationStore;
  readonly agent?: WebAgentRunner;
  readonly models?: ModelRuntime;
  readonly workflows?: WorkflowOrchestrator;
  readonly logger?: AppLogger;
  readonly pibotSkillsRoot?: string;
  readonly disabledSkills?: readonly string[];
  readonly maxSkills?: number;
  readonly maxSkillFileBytes?: number;
  readonly titleEmptyRetryMs?: number;
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
  const interruptedRuns = await options.workflows?.recoverInterruptedRuns();
  if ((interruptedRuns ?? 0) > 0) {
    logger.warn("webui_detached_runs_interrupted_after_restart", {
      count: interruptedRuns,
    });
    const evolution = await options.evolution.readSnapshot();
    for (const ticket of evolution.tickets.filter((item) =>
      item.status === "applying")) {
      await options.evolution.finishImplementation(ticket.id, {
        actor: "workflow-orchestrator",
        success: false,
        summary:
          "服务端进程在实现期间重启；工作流已保存中断状态和最近工具 checkpoint。",
      });
    }
  }
  const runtimeState: WebUiRuntimeState = {
    instanceId: [
      process.pid,
      Date.now().toString(36),
      Math.random().toString(36).slice(2),
    ].join("-"),
    startedAt: new Date().toISOString(),
    pid: process.pid,
  };
  const detachedRuns = options.agent === undefined || options.workflows === undefined
    ? undefined
    : new DetachedWebRunService({
        agent: options.agent,
        evolution: options.evolution,
        workflows: options.workflows,
        logger,
      });
  const server = createServer((request, response) => {
    void routeRequest(options, runtimeState, detachedRuns, request, response).catch(
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

  const url = options.publicUrl ?? browserUrlFor(options.host, options.port);
  logger.info("webui_started", { url });
  return { server, url };
}

function browserUrlFor(host: string, port: number): string {
  if (host === "0.0.0.0" || host === "::") {
    return `http://127.0.0.1:${port}`;
  }
  return `http://${host}:${port}`;
}

function webModelState(runtime: ModelRuntime): Readonly<Record<string, unknown>> {
  return {
    active: formatModelRef(runtime.activeModelRef()),
    configPath: runtime.config.configPath,
    storePath: runtime.config.storePath,
    providers: runtime.providers().map((provider) => ({
      id: provider.id,
      api: provider.api,
      credential: runtime.credentialRequirement({
        provider: provider.id,
        model: provider.defaultModel,
      }),
      catalogEnabled:
        provider.catalog !== undefined && provider.catalog.enabled !== false,
    })),
    models: runtime.listModels().map((model) => ({
      ref: `${model.provider}/${model.id}`,
      provider: model.provider,
      id: model.id,
      name: model.name,
      status: model.status,
      source: model.source,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      input: model.input,
      reasoning: model.reasoning,
      tools: model.tools,
      checkedAt: model.checkedAt,
      fetchedAt: model.fetchedAt,
    })),
  };
}

function sendDetachedRunAccepted(
  response: ServerResponse,
  run: WorkflowRunRecord,
  eventCursor: number,
): void {
  sendJson(response, 202, {
    runId: run.runId,
    status: run.status,
    eventCursor,
    eventsUrl: `/api/runs/${encodeURIComponent(run.runId)}/events`,
    cancelUrl: `/api/runs/${encodeURIComponent(run.runId)}/cancel`,
  });
}

async function streamDetachedRunEvents(
  service: DetachedWebRunService,
  request: IncomingMessage,
  response: ServerResponse,
  runId: string,
  afterQuery: string | null,
): Promise<void> {
  await service.readRun(runId);
  const headerValue = Array.isArray(request.headers["last-event-id"])
    ? request.headers["last-event-id"][0]
    : request.headers["last-event-id"];
  let lastSeq = parseEventSequence(headerValue ?? afterQuery, runId);
  let ended = false;
  let replaying = true;
  const buffered: WorkflowEventRecord[] = [];
  let unsubscribe = () => {};

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.write(": connected\n\n");
  request.socket.setKeepAlive(true);

  const heartbeat = setInterval(() => {
    if (!ended && !response.destroyed && !response.writableEnded) {
      response.write(`: heartbeat ${Date.now()}\n\n`);
    }
  }, 15_000);
  heartbeat.unref();

  const finish = () => {
    if (ended) {
      return;
    }
    ended = true;
    clearInterval(heartbeat);
    unsubscribe();
    request.off("aborted", finish);
    response.off("close", finish);
    if (!response.destroyed && !response.writableEnded) {
      response.end();
    }
  };
  const emit = (event: WorkflowEventRecord) => {
    if (ended || event.seq <= lastSeq || response.destroyed) {
      return;
    }
    lastSeq = event.seq;
    const clientEvent = webClientEvent(event);
    response.write(
      `id: ${runId}:${event.seq}\ndata: ${JSON.stringify(clientEvent)}\n\n`,
    );
    if (isTerminalClientEvent(clientEvent)) {
      finish();
    }
  };

  request.once("aborted", finish);
  response.once("close", finish);
  unsubscribe = service.subscribe(runId, (event) => {
    if (replaying) {
      buffered.push(event);
      return;
    }
    emit(event);
  });

  try {
    for (const event of await service.readEvents(runId, lastSeq)) {
      emit(event);
      if (ended) {
        return;
      }
    }
    while (buffered.length > 0 && !ended) {
      const pending = buffered.splice(0).sort((left, right) => left.seq - right.seq);
      for (const event of pending) {
        emit(event);
        if (ended) {
          return;
        }
      }
    }
    replaying = false;
  } catch (error: unknown) {
    finish();
    throw error;
  }
}

function parseEventSequence(value: string | null | undefined, runId: string): number {
  if (value === undefined || value === null || value.trim().length === 0) {
    return 0;
  }
  const normalized = value.startsWith(`${runId}:`)
    ? value.slice(runId.length + 1)
    : value;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function webClientEvent(event: WorkflowEventRecord): Readonly<Record<string, unknown>> {
  const payloadEvent = event.payload["event"];
  if (typeof payloadEvent === "object" && payloadEvent !== null) {
    return {
      ...(payloadEvent as Readonly<Record<string, unknown>>),
      workflow: { runId: event.runId, seq: event.seq },
    };
  }
  return { type: "workflow_event", event };
}

function isTerminalClientEvent(event: Readonly<Record<string, unknown>>): boolean {
  return event["type"] === "done" || event["type"] === "error";
}

async function routeRequest(
  options: WebUiServerOptions,
  runtimeState: WebUiRuntimeState,
  detachedRuns: DetachedWebRunService | undefined,
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
  if (method === "GET" && url.pathname === "/api/models") {
    if (options.models === undefined) {
      sendJson(response, 400, { error: "Model runtime is not configured" });
      return;
    }
    sendJson(response, 200, webModelState(options.models));
    return;
  }
  if (method === "POST" && url.pathname === "/api/models/select") {
    if (options.models === undefined) {
      sendJson(response, 400, { error: "Model runtime is not configured" });
      return;
    }
    const body = await readJsonBody(request);
    options.models.selectModel(stringField(body, "model"));
    sendJson(response, 200, webModelState(options.models));
    return;
  }
  if (
    method === "POST" &&
    (url.pathname === "/api/models/check" || url.pathname === "/api/models/sync")
  ) {
    if (options.models === undefined) {
      sendJson(response, 400, { error: "Model runtime is not configured" });
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const catalog = url.pathname.endsWith("/sync")
        ? await options.models.syncCatalogs(controller.signal)
        : await options.models.checkCatalogs(controller.signal);
      sendJson(response, 200, {
        ...webModelState(options.models),
        catalog,
      });
    } finally {
      clearTimeout(timeout);
    }
    return;
  }
  if (method === "POST" && url.pathname === "/api/runs") {
    if (detachedRuns === undefined) {
      sendJson(response, 400, { error: "Detached runs are not configured" });
      return;
    }
    const body = await readJsonBody(request);
    const kind = stringField(body, "kind");
    const submission = kind === "conversation"
      ? await detachedRuns.submitConversation({
          conversationId: stringField(body, "conversationId"),
          content: stringField(body, "content"),
        })
      : kind === "evolution_implementation"
      ? await detachedRuns.submitEvolutionImplementation(stringField(body, "ticketId"))
      : undefined;
    if (submission === undefined) {
      sendJson(response, 400, { error: `Unsupported detached run kind: ${kind}` });
      return;
    }
    sendDetachedRunAccepted(response, submission.run, submission.eventCursor);
    return;
  }
  const runEventsMatch = matchRoute(
    url.pathname,
    /^\/api\/runs\/([^/]+)\/events$/u,
  );
  if (method === "GET" && runEventsMatch !== undefined) {
    if (detachedRuns === undefined) {
      sendJson(response, 400, { error: "Detached runs are not configured" });
      return;
    }
    await streamDetachedRunEvents(
      detachedRuns,
      request,
      response,
      runEventsMatch,
      url.searchParams.get("after"),
    );
    return;
  }
  const runCancelMatch = matchRoute(
    url.pathname,
    /^\/api\/runs\/([^/]+)\/cancel$/u,
  );
  if (method === "POST" && runCancelMatch !== undefined) {
    if (detachedRuns === undefined) {
      sendJson(response, 400, { error: "Detached runs are not configured" });
      return;
    }
    sendJson(response, 200, { run: await detachedRuns.cancel(runCancelMatch) });
    return;
  }
  const runMatch = matchRoute(url.pathname, /^\/api\/runs\/([^/]+)$/u);
  if (method === "GET" && runMatch !== undefined) {
    if (detachedRuns === undefined || options.workflows === undefined) {
      sendJson(response, 400, { error: "Detached runs are not configured" });
      return;
    }
    const [run, steps, attempts] = await Promise.all([
      detachedRuns.readRun(runMatch),
      options.workflows.store.readSteps(runMatch),
      options.workflows.store.readAttempts(runMatch),
    ]);
    sendJson(response, 200, { run, steps, attempts });
    return;
  }
  if (method === "GET" && url.pathname === "/api/state") {
    const [evolution, conversations, skills] = await Promise.all([
      options.evolution.readSnapshot(),
      readWebConversations(options),
      readWebSkills(options),
    ]);
    sendJson(response, 200, {
      evolution: {
        ...evolution,
        context: readLightweightEvolutionContext(evolution.tickets),
        runtimeActivation: runtimeActivationState(options),
      },
      runtime: runtimeState,
      ...(options.models === undefined
        ? {}
        : { models: webModelState(options.models) }),
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
  if (method === "GET" && url.pathname === "/api/evolution/context") {
    const evolution = await options.evolution.readSnapshot();
    sendJson(response, 200, {
      context: await readEvolutionContext(options, evolution.tickets),
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
    if (detachedRuns !== undefined) {
      const submission = await detachedRuns.submitEvolutionImplementation(
        implementationMatch,
      );
      sendDetachedRunAccepted(
        response,
        submission.run,
        submission.eventCursor,
      );
      return;
    }
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
      ...(result.active === undefined
        ? {}
        : { activeRuntimeVersion: result.active }),
      ...(result.pending === undefined
        ? {}
        : { pendingRuntimeActivation: result.pending }),
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
    const confirmPending = optionalBooleanValue(body, "confirmPending");
    const result = await options.evolution.activateRuntimeCodeVersion(
      runtimeVersionActivationMatch,
      {
        actor: actorName,
        commandLabel: options.runtimeActivation.label,
        ...(confirmPending === undefined ? {} : { confirmPending }),
        workspaceRoot: options.workspaceRoot,
      },
    );
    const evolution = await options.evolution.readSnapshot();
    sendJson(response, 202, {
      ticket: result.ticket,
      version: result.version,
      ...(result.active === undefined
        ? {}
        : { activeRuntimeVersion: result.active }),
      ...(result.pending === undefined
        ? {}
        : { pendingRuntimeActivation: result.pending }),
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
  const runtimeVersionConfirmByIdMatch = matchRoute(
    url.pathname,
    /^\/api\/evolution\/runtime-code\/versions\/([^/]+)\/confirm$/u,
  );
  if (method === "POST" && runtimeVersionConfirmByIdMatch !== undefined) {
    const body = await readJsonBody(request);
    const actorName = optionalStringValue(body, "actor")?.trim() || "webui";
    const result = await options.evolution.confirmRuntimeCodeVersion(
      runtimeVersionConfirmByIdMatch,
      { actor: actorName },
    );
    const evolution = await options.evolution.readSnapshot();
    sendJson(response, 200, {
      confirmed: result.confirmed,
      ...(result.ticket === undefined ? {} : { ticket: result.ticket }),
      ...(result.version === undefined ? {} : { version: result.version }),
      ...(result.active === undefined
        ? {}
        : { activeRuntimeVersion: result.active }),
      context: await readEvolutionContext(options, evolution.tickets),
    });
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
  const deleteTicketMatch = matchRoute(
    url.pathname,
    /^\/api\/evolution\/tickets\/([^/]+)$/u,
  );
  if (method === "DELETE" && deleteTicketMatch !== undefined) {
    const body = await readJsonBody(request);
    const result = await options.evolution.deleteTicket(deleteTicketMatch, {
      ...optionalBodyString(body, "actor"),
    });
    const evolution = await options.evolution.readSnapshot();
    sendJson(response, 200, {
      ...result,
      context: await readEvolutionContext(options, evolution.tickets),
    });
    return;
  }
  const deleteRuntimeVersionMatch = matchRoute(
    url.pathname,
    /^\/api\/evolution\/runtime-code\/versions\/([^/]+)$/u,
  );
  if (method === "DELETE" && deleteRuntimeVersionMatch !== undefined) {
    const body = await readJsonBody(request);
    const result = await options.evolution.deleteRuntimeVersion(
      deleteRuntimeVersionMatch,
      {
        ...optionalBodyString(body, "actor"),
      },
    );
    const evolution = await options.evolution.readSnapshot();
    sendJson(response, 200, {
      ...result,
      context: await readEvolutionContext(options, evolution.tickets),
    });
    return;
  }
  const deleteSelfVersionMatch = matchRoute(
    url.pathname,
    /^\/api\/evolution\/self-instructions\/versions\/([^/]+)$/u,
  );
  if (method === "DELETE" && deleteSelfVersionMatch !== undefined) {
    const body = await readJsonBody(request);
    const result = await options.evolution.deleteSelfVersion(
      deleteSelfVersionMatch,
      {
        ...optionalBodyString(body, "actor"),
      },
    );
    const evolution = await options.evolution.readSnapshot();
    sendJson(response, 200, {
      ...result,
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
  if (method === "GET" && url.pathname === "/api/approval-rules") {
    if (options.agent === undefined) {
      sendJson(response, 400, { error: "WebUI agent runner is not configured" });
      return;
    }
    sendJson(response, 200, {
      rules: await options.agent.listApprovalRules(),
    });
    return;
  }
  const approvalRuleMatch = matchRoute(
    url.pathname,
    /^\/api\/approval-rules\/([^/]+)$/u,
  );
  if (method === "DELETE" && approvalRuleMatch !== undefined) {
    if (options.agent === undefined) {
      sendJson(response, 400, { error: "WebUI agent runner is not configured" });
      return;
    }
    const revoked = await options.agent.revokeApprovalRule(approvalRuleMatch);
    sendJson(
      response,
      revoked ? 200 : 404,
      revoked ? { ok: true } : { error: "Approval rule not found" },
    );
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
    const approvalScope = optionalStringValue(body, "scope") ?? "once";
    if (
      approvalScope !== "once" &&
      approvalScope !== "run" &&
      approvalScope !== "session" &&
      approvalScope !== "repo"
    ) {
      throw new Error("scope must be once, run, session, or repo");
    }
    const result = await options.agent.decideApproval(
      approvalMatch,
      booleanField(body, "approved"),
      approvalScope,
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
  const generateTitleMatch = matchRoute(
    url.pathname,
    /^\/api\/conversations\/([^/]+)\/generate-title$/u,
  );
  if (method === "POST" && generateTitleMatch !== undefined) {
    if (options.agent === undefined) {
      sendJson(response, 400, {
        error: "WebUI agent runner is not configured",
      });
      return;
    }
    const body = await readJsonBody(request);
    const title = await options.agent.generateConversationTitle(
      generateTitleMatch,
      optionalStringValue(body, "content"),
    );
    if (title.length === 0) {
      sendJson(response, 200, { title: "", generated: false });
      return;
    }
    sendJson(response, 200, { title, generated: true });
    return;
  }
  const runtimeVersionConfirmMatch = matchRoute(
    url.pathname,
    /^\/api\/evolution\/runtime-code\/activation\/confirm$/u,
  );
  if (method === "POST" && runtimeVersionConfirmMatch !== undefined) {
    const body = await readJsonBody(request);
    const actorName = optionalStringValue(body, "actor")?.trim() || "webui";
    const versionId = optionalStringValue(body, "versionId")?.trim();
    const active = await options.evolution.confirmPendingRuntimeActivation({
      actor: actorName,
      ...(versionId === undefined || versionId.length === 0 ? {} : { versionId }),
    });
    const evolution = await options.evolution.readSnapshot();
    sendJson(response, 200, {
      confirmed: active !== undefined,
      ...(active === undefined ? {} : { activeRuntimeVersion: active }),
      context: await readEvolutionContext(options, evolution.tickets),
    });
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
      if (detachedRuns !== undefined) {
        const submission = await detachedRuns.submitConversation({
          conversationId: messageMatch,
          content,
        });
        void generateAndPersistConversationTitle(
          options,
          messageMatch,
          content,
          (conversation) =>
            detachedRuns.appendEvent(submission.run.runId, {
              type: "conversation",
              conversation,
            }),
        );
        sendDetachedRunAccepted(
          response,
          submission.run,
          submission.eventCursor,
        );
        return;
      }
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

function readLightweightEvolutionContext(
  tickets: readonly EvolutionTicket[] = [],
) {
  return {
    key: evolutionChannelKey(),
    messages: [],
    topics: tickets.map(evolutionContextTopic),
    ticketContexts: tickets.map((ticket) => ({
      ticketId: ticket.id,
      key: evolutionTicketChannelKey(ticket.id),
      messages: [],
    })),
  };
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

  let writeChain = Promise.resolve();
  const writeStreamEvent = (value: unknown): Promise<void> => {
    writeChain = writeChain.then(() => writeNdjson(response, value));
    return writeChain;
  };

  let markMainRunFinished: (() => void) | undefined;
  const mainRunFinished = new Promise<void>((resolve) => {
    markMainRunFinished = resolve;
  });
  const initialTitleTask = generateAndPersistConversationTitle(
    options,
    input.conversationId,
    input.content,
    async (conversation) => {
      if (!response.writableEnded) {
        await writeStreamEvent({ type: "conversation", conversation });
      }
    },
  );
  const titleLifecycleTask = initialTitleTask.then(async (initialResult) => {
    await mainRunFinished;
    if (initialResult.outcome !== "empty" && initialResult.outcome !== "failed") {
      return initialResult;
    }
    options.logger?.warn("webui_title_generation_retry", {
      conversationId: input.conversationId,
      reason: initialResult.outcome === "empty" ? "empty" : "error",
    });
    return generateAndPersistConversationTitle(
      options,
      input.conversationId,
      input.content,
      async (conversation) => {
        if (!response.writableEnded) {
          await writeStreamEvent({ type: "conversation", conversation });
        }
      },
      {
        ignoreRetryAfter: true,
        reportFinalFailure: true,
      },
    );
  });

  try {
    const run = await options.agent.runUserMessage(
      input.conversationId,
      input.content,
      {
        signal: controller.signal,
        onEvent: async (event) => {
          await writeStreamEvent(event);
        },
      },
    );
    const conversation = await options.agent.getConversation(input.conversationId);
    const evolution = await options.evolution.readSnapshot();
    await writeStreamEvent({
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
    await writeStreamEvent({
      type: "error",
      error: errorMessage(error),
    });
  } finally {
    markMainRunFinished?.();
    await Promise.race([titleLifecycleTask, delay(1500)]);
    await writeChain;
    response.off("close", abortOnClose);
    request.off("aborted", abortOnRequest);
    if (!response.writableEnded) {
      response.end();
    }
  }
}

type ConversationTitleGenerationOutcome =
  | "generated"
  | "empty"
  | "failed"
  | "protected"
  | "skipped";

interface ConversationTitleGenerationResult {
  readonly outcome: ConversationTitleGenerationOutcome;
  readonly conversation?: WebConversation;
}

async function generateAndPersistConversationTitle(
  options: WebUiServerOptions,
  conversationId: string,
  content: string,
  onConversation?: (conversation: WebConversation) => Promise<void> | void,
  generationOptions: {
    readonly ignoreRetryAfter?: boolean;
    readonly reportFinalFailure?: boolean;
  } = {},
): Promise<ConversationTitleGenerationResult> {
  if (options.agent === undefined) {
    return { outcome: "skipped" };
  }
  try {
    const current = await options.conversations.get(conversationId);
    if (!shouldGenerateConversationTitle(current, generationOptions)) {
      return { outcome: "skipped" };
    }
    let lastPersistedTitle: string | undefined;
    let persistedConversation: WebConversation | undefined;
    let cancelledByRename = false;
    const persistCandidate = async (title: string): Promise<void> => {
      if (cancelledByRename || title.length === 0) {
        return;
      }
      const latest = await options.conversations.get(conversationId);
      const canPersist = lastPersistedTitle === undefined
        ? shouldGenerateConversationTitle(latest, generationOptions)
        : latest.title === lastPersistedTitle;
      if (!canPersist) {
        cancelledByRename = true;
        return;
      }
      if (latest.title !== title) {
        await options.conversations.rename(conversationId, title, {
          source: "model",
        });
      }
      lastPersistedTitle = title;
      persistedConversation = await options.agent?.getConversation(conversationId);
      if (persistedConversation !== undefined) {
        await onConversation?.(persistedConversation);
      }
    };

    try {
      const title = await options.agent.generateConversationTitle(
        conversationId,
        content,
        { onCandidate: persistCandidate },
      );
      await persistCandidate(title);
      if (persistedConversation !== undefined) {
        return { outcome: "generated", conversation: persistedConversation };
      }
      if (cancelledByRename) {
        return { outcome: "protected" };
      }
      await options.conversations.recordTitleGenerationFailure(
        conversationId,
        options.titleEmptyRetryMs,
      );
      if (generationOptions.reportFinalFailure === true) {
        options.logger?.warn("webui_title_generation_empty", { conversationId });
      }
      return { outcome: "empty" };
    } catch (error: unknown) {
      if (persistedConversation !== undefined) {
        return { outcome: "generated", conversation: persistedConversation };
      }
      if (cancelledByRename) {
        return { outcome: "protected" };
      }
      await options.conversations.recordTitleGenerationFailure(
        conversationId,
        options.titleEmptyRetryMs,
      );
      if (generationOptions.reportFinalFailure === true) {
        options.logger?.warn("webui_title_generation_failed", {
          conversationId,
          ...errorFields(error),
        });
      }
      return { outcome: "failed" };
    }
  } catch (error: unknown) {
    options.logger?.warn("webui_title_generation_failed", {
      conversationId,
      ...errorFields(error),
    });
    return { outcome: "failed" };
  }
}

function shouldGenerateConversationTitle(
  conversation: WebConversation,
  options: {
    readonly ignoreRetryAfter?: boolean;
  } = {},
): boolean {
  if (conversation.messages.length > 6) {
    return false;
  }
  return options.ignoreRetryAfter === true
    ? conversationTitleSource(conversation) === "placeholder"
    : conversationTitleRetryReady(conversation);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
