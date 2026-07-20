const { spawn } = require("node:child_process");
const { readFile, rm } = require("node:fs/promises");
const { join, resolve } = require("node:path");

const workspaceRoot = resolve(process.env.WORKSPACE_ROOT || process.cwd());
const storeRoot = resolve(
  process.env.PIBOT_STORE_ROOT || join(workspaceRoot, ".pibot"),
);
const markerPath = resolve(
  process.env.PIBOT_EVOLUTION_RESTART_MARKER ||
    join(storeRoot, "runtime-activation", "restart-request.json"),
);

let child = null;
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    if (child !== null && child.exitCode === null) {
      child.kill(signal);
      return;
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

async function main() {
  await rm(markerPath, { force: true });
  while (!stopping) {
    const build = await run("npm", ["run", "build"]);
    if (stopping) {
      process.exit(build.exitCode ?? 0);
    }
    if (build.exitCode !== 0) {
      process.exit(build.exitCode ?? 1);
    }

    const webui = await run(process.execPath, ["dist/web-main.js"]);
    if (stopping) {
      process.exit(webui.exitCode ?? 0);
    }

    const marker = await consumeRestartMarker();
    if (marker === null) {
      process.exit(webui.exitCode ?? 0);
    }

    const ticket = marker.ticketId ? ` for ${marker.ticketId}` : "";
    console.log(`[pibot] runtime activation requested${ticket}; restarting WebUI in this terminal...`);
  }
}

function run(command, args) {
  return new Promise((resolveRun) => {
    child = spawn(command, args, {
      cwd: workspaceRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        WORKSPACE_ROOT: workspaceRoot,
        PIBOT_EVOLUTION_RESTART_MARKER: markerPath,
        PIBOT_WEBUI_TERMINAL_SUPERVISOR: "1",
      },
    });
    child.once("exit", (exitCode, signal) => {
      resolveRun({ exitCode, signal });
    });
    child.once("error", (error) => {
      console.error(`[pibot] failed to start ${command}: ${error.message}`);
      resolveRun({ exitCode: 1, signal: null });
    });
  });
}

async function consumeRestartMarker() {
  let raw;
  try {
    raw = await readFile(markerPath, "utf8");
  } catch (_error) {
    return null;
  }
  await rm(markerPath, { force: true });
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return {};
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
