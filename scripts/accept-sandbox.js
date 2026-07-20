const assert = require("node:assert/strict");
const { mkdir, mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
  createCodingToolExecutor,
  createToolApprovalGate,
} = require("../dist/tools");
const { createSandboxExecutor } = require("../dist/workspace/sandbox");

async function runAcceptance() {
  await runCase("host executor is disabled by default", acceptsHostDisabledByDefault);
  await runCase("docker file tools stay inside mapped workspace", acceptsDockerFileBoundary);
  await runCase("host executor can run when explicitly enabled", acceptsHostEnabled);
  await runCase("timeout terminates host command", acceptsTimeout);
  await runCase("timeout force-kills commands that ignore SIGTERM", acceptsForcedTimeout);
  await runCase("timeout above maximum is rejected", acceptsMaximumTimeout);
  await runCase("abort terminates host command", acceptsAbort);
  await runCase("stdout and stderr are truncated", acceptsOutputTruncation);
  if (process.platform === "linux") {
    await runCase("linux-native executor runs commands", acceptsLinuxNativeCommand);
    await runCase("linux-native clears inherited secrets", acceptsLinuxNativeCleanEnvironment);
    await runCase("linux-native Landlock blocks sensitive files", acceptsLinuxNativeFileBoundary);
    await runCase("linux-native seccomp blocks network sockets", acceptsLinuxNativeNetworkBoundary);
    await runCase("linux-native allows Node child processes", acceptsLinuxNativeNodeChildProcess);
  }
  console.log("Sandbox acceptance passed");
}

async function runCase(name, test) {
  process.stdout.write(`- ${name}: `);

  try {
    await test();
    console.log("PASS");
  } catch (error) {
    console.log("FAIL");
    throw error;
  }
}

async function acceptsHostDisabledByDefault() {
  const result = await executeBash({
    sandboxExecutor: createSandboxExecutor(),
    command: "echo should-not-run",
    timeoutMs: 1000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "permission_denied");
}

async function acceptsHostEnabled() {
  const result = await executeBash({
    sandboxExecutor: createSandboxExecutor({
      kind: "host",
      enabled: true,
    }),
    command: "printf sandbox-ok",
    timeoutMs: 1000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.output.exitCode, 0);
  assert.equal(result.output.stdout, "sandbox-ok");
}

async function acceptsDockerFileBoundary() {
  const mappedWorkspace = await createWorkspace();
  const outsideWorkspace = await createWorkspace();
  const sandboxExecutor = createSandboxExecutor({
    kind: "docker",
    containerName: "pibot-test",
    hostWorkspaceRoot: mappedWorkspace,
    containerWorkspaceRoot: "/workspace",
  });

  assert.throws(
    () =>
      createCodingToolExecutor({
        workspaceRoot: outsideWorkspace,
        sandboxExecutor,
      }),
    /outside docker workspace mapping/u,
  );
}

async function acceptsTimeout() {
  const result = await executeBash({
    sandboxExecutor: createSandboxExecutor({
      kind: "host",
      enabled: true,
    }),
    command: "sleep 2",
    timeoutMs: 100,
  });

  assert.equal(result.ok, true);
  assert.equal(result.output.timedOut, true);
}

async function acceptsForcedTimeout() {
  const startedAt = Date.now();
  const result = await executeBash({
    sandboxExecutor: createSandboxExecutor({
      kind: "host",
      enabled: true,
    }),
    command: 'trap "" TERM; sleep 5',
    timeoutMs: 100,
  });

  assert.equal(result.ok, true);
  assert.equal(result.output.timedOut, true);
  assert.equal(Date.now() - startedAt < 3000, true);
}

async function acceptsAbort() {
  const controller = new AbortController();
  const promise = executeBash(
    {
      sandboxExecutor: createSandboxExecutor({
        kind: "host",
        enabled: true,
      }),
      command: "sleep 2",
      timeoutMs: 5000,
    },
    controller.signal,
  );

  setTimeout(() => {
    controller.abort();
  }, 100);

  const result = await promise;

  assert.equal(result.ok, true);
  assert.equal(result.output.aborted, true);
}

async function acceptsMaximumTimeout() {
  const result = await executeBash({
    sandboxExecutor: createSandboxExecutor({
      kind: "host",
      enabled: true,
    }),
    command: "printf should-not-run",
    timeoutMs: 1001,
    maxShellTimeoutMs: 1000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_input");
  assert.match(result.error.message, /must not exceed 1000/u);
}

async function acceptsOutputTruncation() {
  const result = await executeBash({
    sandboxExecutor: createSandboxExecutor({
      kind: "host",
      enabled: true,
    }),
    command:
      "printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; printf 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy' >&2",
    timeoutMs: 1000,
    maxCommandOutputChars: 10,
  });

  assert.equal(result.ok, true);
  assert.equal(result.output.stdoutTruncated, true);
  assert.equal(result.output.stderrTruncated, true);
  assert.equal(result.output.stdout.includes("[truncated]"), true);
  assert.equal(result.output.stderr.includes("[truncated]"), true);
}

async function acceptsLinuxNativeCommand() {
  const result = await executeBash({
    sandboxExecutor: createSandboxExecutor({ kind: "linux-native" }),
    command: "printf linux-native-ok",
    timeoutMs: 1000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.output.exitCode, 0);
  assert.equal(result.output.stdout, "linux-native-ok");
}

async function acceptsLinuxNativeCleanEnvironment() {
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "must-not-leak";

  try {
    const result = await executeBash({
      sandboxExecutor: createSandboxExecutor({ kind: "linux-native" }),
      command: 'test -z "$OPENAI_API_KEY" && printf environment-clean',
      timeoutMs: 1000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.output.exitCode, 0);
    assert.equal(result.output.stdout, "environment-clean");
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousApiKey;
    }
  }
}

async function acceptsLinuxNativeFileBoundary() {
  const workspaceRoot = await createWorkspace();
  await mkdir(join(workspaceRoot, ".pibot"), { recursive: true });
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, ".env"), "env-secret", "utf8");
  await writeFile(join(workspaceRoot, "instructions.md"), "user-instructions", "utf8");
  await writeFile(join(workspaceRoot, ".pibot", "secret.txt"), "store-secret", "utf8");
  await writeFile(join(workspaceRoot, "src", "input.txt"), "normal-file", "utf8");

  const result = await executeBash({
    workspaceRoot,
    sandboxExecutor: createSandboxExecutor({ kind: "linux-native" }),
    command:
      "cat src/input.txt && ! cat .env && ! cat instructions.md && ! cat .pibot/secret.txt && ! cat /etc/passwd && printf changed > src/output.txt",
    timeoutMs: 1000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.output.exitCode, 0);
  assert.equal(result.output.stdout, "normal-file");
  assert.match(result.output.stderr, /Permission denied/u);
  assert.equal(await readFile(join(workspaceRoot, "src", "output.txt"), "utf8"), "changed");
}

async function acceptsLinuxNativeNetworkBoundary() {
  const result = await executeBash({
    sandboxExecutor: createSandboxExecutor({ kind: "linux-native" }),
    command:
      "node -e 'const fs = require(\"node:fs\"); const socket = require(\"node:net\").connect(80, \"127.0.0.1\"); socket.on(\"error\", (error) => { fs.writeSync(1, error.code); process.exit(error.code === \"EPERM\" ? 0 : 1); });'",
    timeoutMs: 3000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.output.exitCode, 0);
  assert.equal(result.output.stdout.trim(), "EPERM");
}

async function acceptsLinuxNativeNodeChildProcess() {
  const result = await executeBash({
    sandboxExecutor: createSandboxExecutor({ kind: "linux-native" }),
    command:
      "node -e 'const fs = require(\"node:fs\"); const { spawn } = require(\"node:child_process\"); const child = spawn(\"/usr/bin/true\"); child.on(\"error\", (error) => { fs.writeSync(1, error.code); process.exit(1); }); child.on(\"close\", (code) => { fs.writeSync(1, `close:${code}`); process.exit(code); });'",
    timeoutMs: 3000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.output.exitCode, 0);
  assert.equal(result.output.stdout, "close:0");
}

async function executeBash(options, signal) {
  const workspaceRoot = options.workspaceRoot ?? (await createWorkspace());
  const tools = createCodingToolExecutor({
    workspaceRoot,
    sandboxExecutor: options.sandboxExecutor,
    approvalGate: createToolApprovalGate("full-access"),
    maxCommandOutputChars: options.maxCommandOutputChars ?? 1000,
    defaultShellTimeoutMs: options.defaultShellTimeoutMs ?? 1000,
    maxShellTimeoutMs: options.maxShellTimeoutMs ?? 600000,
  });

  return tools.executeTool(
    {
      id: "bash-call",
      name: "bash",
      input: {
        command: options.command,
        timeoutMs: options.timeoutMs,
      },
    },
    signal,
  );
}

async function createWorkspace() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pibot-sandbox-"));
  await mkdir(workspaceRoot, { recursive: true });
  return workspaceRoot;
}

runAcceptance().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
