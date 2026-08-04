const { spawn } = require("node:child_process");
const { cp, lstat, readFile, rm, writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");

const workspaceRoot = resolve(process.env.WORKSPACE_ROOT || process.cwd());
const storeRoot = resolve(
  process.env.PIBOT_STORE_ROOT || join(workspaceRoot, ".pibot"),
);
const markerPath = resolve(
  process.env.PIBOT_EVOLUTION_RESTART_MARKER ||
    join(storeRoot, "runtime-activation", "restart-request.json"),
);
const runtimeCurrentPath = join(storeRoot, "evolution", "runtime-code", "current.json");
const runtimeVersionsRoot = join(storeRoot, "evolution", "runtime-code", "versions");
const runtimeCodeEntries = [
  ".env.example",
  ".github",
  ".gitignore",
  "Dockerfile.sandbox",
  "README.md",
  "dist",
  "docker-compose.sandbox.yml",
  "docs",
  "native",
  "package-lock.json",
  "package.json",
  "scripts",
  "src",
  "tsconfig.json",
];
const requiredRuntimeRestoreEntries = [
  "package.json",
  "package-lock.json",
  "scripts",
  "src",
  "tsconfig.json",
];

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
  let allowPendingTrial = false;
  while (!stopping) {
    await restoreUnconfirmedRuntimeActivation({ allowPendingTrial });
    allowPendingTrial = false;
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
    allowPendingTrial = true;
  }
}

async function restoreUnconfirmedRuntimeActivation(options) {
  let current;
  try {
    current = JSON.parse(await readFile(runtimeCurrentPath, "utf8"));
  } catch (_error) {
    return;
  }
  if (!current || current.pending === undefined) {
    return;
  }
  if (options && options.allowPendingTrial) {
    console.log(`[pibot] starting unconfirmed runtime trial ${current.pending.versionId}; confirm it in WebUI to make it the default.`);
    return;
  }
  if (current.active === undefined) {
    console.warn("[pibot] runtime activation was pending but no confirmed version exists; clearing pending marker.");
    await writeRuntimeCurrent({});
    return;
  }

  const archiveFiles = join(runtimeVersionsRoot, current.active.versionId, "files");
  if (!(await pathExists(archiveFiles))) {
    throw new Error(
      `Runtime version archive is missing: ${archiveFiles}. Refusing to modify the workspace; fix current.json or run an explicit rollback.`,
    );
  }
  for (const entry of requiredRuntimeRestoreEntries) {
    const archiveEntry = join(archiveFiles, entry);
    if (!(await pathExists(archiveEntry))) {
      throw new Error(
        `Runtime version archive is incomplete: ${archiveEntry}. Refusing to modify the workspace; fix current.json or run an explicit rollback.`,
      );
    }
  }
  console.log(
    `[pibot] unconfirmed runtime version ${current.pending.versionId} found; restoring confirmed ${current.active.versionId} before build...`,
  );
  for (const entry of runtimeCodeEntries) {
    const archiveEntry = join(archiveFiles, entry);
    await rm(join(workspaceRoot, entry), { recursive: true, force: true });
    if (!(await pathExists(archiveEntry))) {
      continue;
    }
    await cp(archiveEntry, join(workspaceRoot, entry), {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
    });
  }
  await writeRuntimeCurrent({ active: current.active });
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function writeRuntimeCurrent(value) {
  await writeFile(runtimeCurrentPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
