const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, stat, writeFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
  createConfiguredModelClient,
  ModelRuntime,
} = require("../dist/models/runtime");
const { EvolutionController } = require("../dist/evolution/controller");
const { FileEvolutionStore } = require("../dist/evolution/store");
const { FileWebConversationStore } = require("../dist/web/conversations");
const { startWebUiServer } = require("../dist/web/server");

async function main() {
  const root = await mkdtemp(join(tmpdir(), "pibot-model-runtime-"));
  const requests = [];
  let alphaCatalogVersion = 1;
  let betaCatalogFails = false;
  let betaMessageCalls = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length === 0
      ? undefined
      : JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({
      url: request.url,
      headers: request.headers,
      body,
    });

    if (request.url === "/alpha/models") {
      const etag = `\"alpha-${alphaCatalogVersion}\"`;
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { etag });
        response.end();
        return;
      }
      const models = alphaCatalogVersion === 1
        ? [{ id: "alpha-fail" }, { id: "alpha-one" }]
        : [{ id: "alpha-one" }, { id: "alpha-two" }];
      json(response, 200, { data: models }, { etag });
      return;
    }
    if (request.url.startsWith("/beta/models")) {
      if (betaCatalogFails) {
        json(response, 503, { error: "temporary beta catalog failure" });
        return;
      }
      if (request.url.includes("after_id=beta-one")) {
        json(response, 200, {
          data: [{ id: "beta-two", name: "Beta Two" }],
          has_more: false,
        });
        return;
      }
      const etag = "\"beta-1\"";
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { etag });
        response.end();
        return;
      }
      json(response, 200, {
        data: [{ id: "beta-one", name: "Beta One" }],
        has_more: true,
        last_id: "beta-one",
      }, { etag });
      return;
    }
    if (request.url === "/alpha/chat/completions") {
      json(response, 503, { error: { message: "alpha unavailable" } });
      return;
    }
    if (request.url === "/beta/messages") {
      betaMessageCalls += 1;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":2,"cache_creation_input_tokens":1,"output_tokens":1}}}\n\n');
      if (betaMessageCalls === 1) {
        response.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
        response.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"beta ok"}}\n\n');
        response.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
        response.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n');
      } else {
        response.write('event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool_beta_1","name":"lookup","input":{}}}\n\n');
        response.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"pi"}}\n\n');
        response.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"bot\\"}"}}\n\n');
        response.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n');
        response.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}\n\n');
      }
      response.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      response.end();
      return;
    }
    json(response, 404, { error: "not found" });
  });

  try {
    const address = await listen(server);
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const configPath = join(root, "models.json");
    const storePath = join(root, "models-store.json");
    await writeFile(configPath, JSON.stringify({
      version: 1,
      defaultModel: "alpha/alpha-fail",
      fallbackModels: ["beta/beta-one"],
      providers: {
        alpha: {
          api: "openai-chat-completions",
          baseUrl: `${baseUrl}/alpha`,
          apiKeyEnv: "ALPHA_API_KEY",
          defaultModel: "alpha-fail",
          catalog: { type: "models-api" },
          models: [
            {
              id: "alpha-fail",
              contextWindow: 128000,
              headers: { "x-alpha-model": { env: "ALPHA_MODEL_HEADER" } },
              request: {
                streamUsage: false,
                supportsTemperature: false,
                maxTokensField: "max_completion_tokens",
                extraBody: { service_tier: "flex" },
              },
            },
            { id: "alpha-one", contextWindow: 64000 },
          ],
        },
        beta: {
          api: "anthropic-messages",
          baseUrl: `${baseUrl}/beta`,
          auth: "none",
          defaultModel: "beta-one",
          developerRoleMode: "system-fallback",
          headers: {
            "x-provider": "beta",
            "x-api-key": { env: "BETA_API_KEY" },
          },
          catalog: { type: "models-api" },
          models: [{
            id: "beta-one",
            contextWindow: 32000,
            maxOutputTokens: 4096,
            headers: { "x-model": { env: "BETA_MODEL_HEADER" } },
            pricing: {
              currency: "USD",
              inputPerMillionTokens: 1,
              cachedInputPerMillionTokens: 0.25,
              outputPerMillionTokens: 4,
            },
            request: {
              streamUsage: false,
              maxTokensField: "max_completion_tokens",
              extraBody: { reasoning_effort: "low" },
            },
          }, {
            id: "beta-native",
            contextWindow: 32000,
            developerRoleMode: "native",
          }],
        },
      },
    }, null, 2));

    const env = {
      ALPHA_API_KEY: "alpha-secret",
      ALPHA_MODEL_HEADER: "alpha-model-value",
      BETA_API_KEY: "beta-secret",
      BETA_MODEL_HEADER: "beta-model-value",
    };
    const configured = await createConfiguredModelClient({
      storeRoot: root,
      configPath,
      storePath,
      env,
      maxRetries: 0,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
    });
    assert.equal(configured.runtime.activeModel().ref.provider, "alpha");
    assert.equal(configured.runtime.minimumKnownContextWindow(262144), 32000);
    assert.deepEqual(configured.runtime.fallbackModels(), [
      { provider: "beta", model: "beta-one" },
    ]);

    const events = [];
    for await (const event of configured.client.stream({
      messages: [
        { role: "developer", content: "keep authority explicit" },
        { role: "user", content: "hello" },
      ],
      tools: [],
      temperature: 0.2,
      maxOutputTokens: 123,
    })) {
      events.push(event);
    }
    assert.deepEqual(
      events.filter((event) => event.type === "start").map((event) => event.provider),
      ["alpha", "beta"],
    );
    assert.equal(events.find((event) => event.type === "text_delta").text, "beta ok");
    const done = events.find((event) => event.type === "done");
    assert.deepEqual(done.usage, {
      inputTokens: 15,
      cachedInputTokens: 2,
      outputTokens: 3,
      totalTokens: 18,
    });
    const alphaRequest = requests.find((item) => item.url === "/alpha/chat/completions");
    assert.equal(alphaRequest.headers["x-alpha-model"], "alpha-model-value");
    assert.equal(alphaRequest.body.max_completion_tokens, 123);
    assert.equal(alphaRequest.body.max_tokens, undefined);
    assert.equal(alphaRequest.body.stream_options, undefined);
    assert.equal(alphaRequest.body.temperature, undefined);
    assert.equal(alphaRequest.body.service_tier, "flex");
    const betaRequest = requests.find((item) => item.url === "/beta/messages");
    assert.equal(betaRequest.headers["x-api-key"], "beta-secret");
    assert.equal(betaRequest.headers["x-provider"], "beta");
    assert.equal(betaRequest.headers["x-model"], "beta-model-value");
    assert.equal(betaRequest.body.max_tokens, 123);
    assert.equal(betaRequest.body.max_completion_tokens, undefined);
    assert.equal(betaRequest.body.stream_options, undefined);
    assert.equal(betaRequest.body.temperature, 0.2);
    assert.equal(betaRequest.body.reasoning_effort, "low");
    assert.equal(betaRequest.body.system, "keep authority explicit");
    assert.equal(betaRequest.body.messages[0].role, "user");
    assert.equal(
      events.find((event) =>
        event.type === "start" && event.provider === "beta"
      ).authorityDegraded,
      true,
    );

    const nativeEvents = [];
    for await (const event of configured.runtime.stream({
      modelRef: { provider: "beta", model: "beta-native" },
      messages: [{ role: "developer", content: "must remain developer" }],
      tools: [],
    })) {
      nativeEvents.push(event);
    }
    assert.match(
      nativeEvents.find((event) => event.type === "error").error.message,
      /system-fallback/u,
    );

    const checked = await configured.runtime.checkCatalogs();
    assert.equal(checked.synchronized, false);
    assert.deepEqual(
      checked.results.find((item) => item.provider === "alpha").added,
      ["alpha-fail", "alpha-one"],
    );
    await assert.rejects(stat(storePath), /ENOENT/u);

    await configured.runtime.syncCatalogs();
    const firstStore = JSON.parse(await readFile(storePath, "utf8"));
    assert.deepEqual(
      firstStore.providers.beta.models.map((model) => model.id),
      ["beta-one", "beta-two"],
    );
    assert.equal(firstStore.providers.beta.lastError, undefined);

    const unchanged = await configured.runtime.checkCatalogs();
    assert.equal(unchanged.synchronized, true);
    assert.equal(
      unchanged.results.find((item) => item.provider === "alpha").notModified,
      true,
    );

    alphaCatalogVersion = 2;
    betaCatalogFails = true;
    const refreshed = await configured.runtime.syncCatalogs();
    assert.equal(
      refreshed.results.find((item) => item.provider === "beta").status,
      "error",
    );
    const secondStore = JSON.parse(await readFile(storePath, "utf8"));
    assert.deepEqual(
      secondStore.providers.beta.models.map((model) => model.id),
      ["beta-one", "beta-two"],
    );
    assert.match(secondStore.providers.beta.lastError, /HTTP 503/u);
    assert.deepEqual(
      secondStore.providers.alpha.models.map((model) => model.id),
      ["alpha-one", "alpha-two"],
    );

    const selected = configured.runtime.selectModel("beta/beta-one");
    assert.equal(selected.spec.source, "configured");
    assert.equal(selected.spec.status, "active");
    assert.equal(selected.spec.pricing.outputPerMillionTokens, 4);
    assert.equal(configured.runtime.credentialRequirement().configured, true);

    const toolEvents = [];
    for await (const event of configured.client.stream({
      messages: [
        { role: "system", content: "system" },
        { role: "developer", content: "developer" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "old_tool",
            name: "lookup",
            argumentsJson: "{\"query\":\"old\"}",
          }],
        },
        { role: "tool", content: "old result", toolCallId: "old_tool" },
        { role: "user", content: "lookup pibot" },
      ],
      tools: [{
        name: "lookup",
        description: "Lookup a query",
        inputSchemaJson: '{"type":"object","properties":{"query":{"type":"string"}}}',
      }],
    })) {
      toolEvents.push(event);
    }
    const toolCall = toolEvents.find((event) => event.type === "tool_call").call;
    assert.equal(toolCall.name, "lookup");
    assert.equal(toolCall.argumentsJson, '{"query":"pibot"}');
    const anthropicToolRequest = requests.filter((item) => item.url === "/beta/messages")[1];
    assert.equal(anthropicToolRequest.body.system, "system\n\ndeveloper");
    assert.equal(anthropicToolRequest.body.tools[0].input_schema.type, "object");
    assert.equal(anthropicToolRequest.body.messages[0].content[0].type, "tool_use");
    assert.equal(anthropicToolRequest.body.messages[1].content[0].type, "tool_result");

    const reloaded = await ModelRuntime.create({
      storeRoot: root,
      configPath,
      storePath,
      env,
    });
    assert.equal(
      reloaded.listModels().some((model) => model.id === "alpha-two"),
      true,
    );
    assert.equal(
      reloaded.listModels().find((model) => model.id === "alpha-two").status,
      "unknown",
    );
    const withoutCredentials = await ModelRuntime.create({
      storeRoot: root,
      configPath,
      storePath,
      env: {},
    });
    assert.equal(withoutCredentials.activeModelRef().provider, "alpha");
    assert.equal(withoutCredentials.credentialRequirement().configured, false);
    assert.equal(withoutCredentials.listModels().length > 0, true);
    const webEvolution = new EvolutionController({
      store: new FileEvolutionStore({ rootDir: join(root, "evolution") }),
      defaultActor: "model-runtime-test",
    });
    const webServer = await startWebUiServer({
      host: "127.0.0.1",
      port: 0,
      workspaceRoot: root,
      evolution: webEvolution,
      conversations: new FileWebConversationStore(root),
      models: reloaded,
    });
    const webAddress = webServer.server.address();
    assert.equal(typeof webAddress, "object");
    const webBaseUrl = `http://127.0.0.1:${webAddress.port}`;
    try {
      const modelState = await (await fetch(`${webBaseUrl}/api/models`)).json();
      assert.equal(modelState.active, "alpha/alpha-fail");
      assert.equal(modelState.providers.length, 2);
      assert.equal("apiKey" in modelState.providers[0].credential, false);
      assert.equal(JSON.stringify(modelState).includes("alpha-secret"), false);
      assert.equal(JSON.stringify(modelState).includes("beta-secret"), false);
      betaCatalogFails = false;
      const checkedState = await (await fetch(`${webBaseUrl}/api/models/check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })).json();
      assert.equal(checkedState.catalog.synchronized, true);
      const syncedState = await (await fetch(`${webBaseUrl}/api/models/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })).json();
      assert.equal(syncedState.catalog.synchronized, true);
      const selectedState = await (await fetch(`${webBaseUrl}/api/models/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "beta/beta-one" }),
      })).json();
      assert.equal(selectedState.active, "beta/beta-one");
      const fullState = await (await fetch(`${webBaseUrl}/api/state`)).json();
      assert.equal(fullState.models.active, "beta/beta-one");
    } finally {
      await close(webServer.server);
    }
    console.log("PASS model runtime routes providers, switches models, and syncs catalogs safely");
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
