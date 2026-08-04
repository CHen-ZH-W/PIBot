const { createHash } = require("node:crypto");
const {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} = require("node:fs/promises");
const path = require("node:path");

const allowedTopLevelEntries = new Set([
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
]);

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
  const evolutionRoot = path.join(workspaceRoot, ".pibot", "evolution");
  const runtimeRoot = path.join(evolutionRoot, "runtime-code");
  const versions = await readJson(path.join(runtimeRoot, "versions.json"), {
    versions: [],
  });
  const current = await readJson(path.join(runtimeRoot, "current.json"), {});
  const active = current.active;
  const allVersions = versions.versions || [];
  const target = resolveTargetVersion(allVersions, active, options.versionId);

  if (active && active.versionId === target.id) {
    throw new Error(`${target.id} is already the active runtime version.`);
  }

  const targetArchiveRoot = path.join(runtimeRoot, "versions", target.id);
  const activeArchiveRoot = active
    ? path.join(runtimeRoot, "versions", active.versionId)
    : undefined;
  const targetFilesRoot = path.join(targetArchiveRoot, "files");
  if (!(await pathExists(targetFilesRoot))) {
    throw new Error(`Runtime version archive is missing: ${targetFilesRoot}`);
  }

  if (!options.noBackup && !options.dryRun) {
    const backupRoot = path.join(
      runtimeRoot,
      "emergency-backups",
      compactTimestamp(new Date()),
      "files",
    );
    await captureWorkspace(workspaceRoot, backupRoot);
    console.log(`Backed up current runtime code to ${backupRoot}`);
  }

  const publish = await activateArchive({
    targetFilesRoot,
    destinationRoot: workspaceRoot,
    activeFilesRoot: activeArchiveRoot
      ? path.join(activeArchiveRoot, "files")
      : undefined,
    force: options.force,
    dryRun: options.dryRun,
  });

  if (publish.conflicts.length > 0) {
    throw new Error(
      [
        "Rollback stopped because local runtime files differ from the current active archive:",
        publish.conflicts.join(", "),
        "Re-run with --force only if you want to overwrite those local runtime changes.",
      ].join("\n"),
    );
  }

  if (!options.dryRun) {
    const nextActive = {
      versionId: target.id,
      activatedAt: new Date().toISOString(),
      activatedBy: options.actor,
      ...(active ? { previousVersionId: active.versionId } : {}),
      commandLabel: "scripts/rollback-runtime-version.js",
    };
    await writeJson(path.join(runtimeRoot, "current.json"), {
      active: nextActive,
    });
    await appendAudit(path.join(evolutionRoot, "audit.jsonl"), {
      type: "runtime_code.version_activated",
      message: `Emergency rollback activated ${runtimeVersionName(target)}.`,
      actor: options.actor,
      at: nextActive.activatedAt,
    });
  }

  const mode = options.dryRun ? "Would activate" : "Activated";
  console.log(`${mode} ${runtimeVersionName(target)}`);
  console.log(
    `Changed files: ${
      publish.changedFiles.length === 0 ? "none" : publish.changedFiles.join(", ")
    }`,
  );
  console.log(
    `Deleted files: ${
      publish.deletedFiles.length === 0 ? "none" : publish.deletedFiles.join(", ")
    }`,
  );
  if (!options.dryRun) {
    console.log("Restart pibot with npm run webui if the current process is still serving the old bundle.");
  }
}

function parseArgs(args) {
  const options = {
    actor: "rollback-script",
    dryRun: false,
    force: false,
    noBackup: false,
    versionId: undefined,
    workspaceRoot: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--previous") {
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--no-backup") {
      options.noBackup = true;
      continue;
    }
    if (arg === "--to") {
      options.versionId = requireValue(args, (index += 1), arg);
      continue;
    }
    if (arg === "--actor") {
      options.actor = requireValue(args, (index += 1), arg);
      continue;
    }
    if (arg === "--workspace") {
      options.workspaceRoot = requireValue(args, (index += 1), arg);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function printHelp() {
  console.log([
    "Usage: node scripts/rollback-runtime-version.js [--previous] [--to <versionId>] [--force] [--dry-run]",
    "",
    "Rolls the protected runtime code back to an archived self-evolution runtime version.",
    "Default target is active.previousVersionId, falling back to the version before the active one.",
  ].join("\n"));
}

function resolveTargetVersion(versions, active, requestedVersionId) {
  if (versions.length === 0) {
    throw new Error("No runtime versions are available to activate.");
  }
  if (requestedVersionId) {
    const requested = versions.find((version) => version.id === requestedVersionId);
    if (!requested) {
      throw new Error(`Unknown runtime version: ${requestedVersionId}`);
    }
    return requested;
  }
  if (active && active.previousVersionId) {
    const previous = versions.find((version) => version.id === active.previousVersionId);
    if (previous) {
      return previous;
    }
  }
  if (active) {
    const activeIndex = versions.findIndex((version) => version.id === active.versionId);
    if (activeIndex > 0) {
      return versions[activeIndex - 1];
    }
  }
  if (versions.length >= 2) {
    return versions[versions.length - 2];
  }
  throw new Error("There is no previous runtime version to roll back to.");
}

async function activateArchive(input) {
  const target = snapshotMap(await snapshotWorkspace(input.targetFilesRoot));
  const destination = snapshotMap(await snapshotWorkspace(input.destinationRoot));
  const expected = input.activeFilesRoot && await pathExists(input.activeFilesRoot)
    ? snapshotMap(await snapshotWorkspace(input.activeFilesRoot))
    : destination;
  const conflicts = [];

  if (!input.force) {
    const currentPaths = new Set([...expected.keys(), ...destination.keys()]);
    for (const relativeFilePath of [...currentPaths].sort()) {
      if (!isAllowedRuntimeCodePath(relativeFilePath)) {
        continue;
      }
      const destinationHash = destination.get(relativeFilePath);
      if (
        destinationHash !== expected.get(relativeFilePath) &&
        destinationHash !== target.get(relativeFilePath)
      ) {
        conflicts.push(relativeFilePath);
      }
    }
  }

  if (conflicts.length > 0) {
    return { changedFiles: [], deletedFiles: [], conflicts };
  }

  const changedFiles = [];
  const deletedFiles = [];
  const allPaths = new Set([...destination.keys(), ...target.keys()]);
  for (const relativeFilePath of [...allPaths].sort()) {
    if (!isAllowedRuntimeCodePath(relativeFilePath)) {
      continue;
    }
    const targetHash = target.get(relativeFilePath);
    if (destination.get(relativeFilePath) === targetHash) {
      continue;
    }
    const destinationFile = path.join(input.destinationRoot, relativeFilePath);
    if (targetHash === undefined) {
      if (!input.dryRun) {
        await rm(destinationFile, { force: true });
      }
      deletedFiles.push(relativeFilePath);
      continue;
    }
    if (!input.dryRun) {
      await mkdir(path.dirname(destinationFile), { recursive: true });
      await copyFile(path.join(input.targetFilesRoot, relativeFilePath), destinationFile);
    }
    changedFiles.push(relativeFilePath);
  }

  return { changedFiles, deletedFiles, conflicts: [] };
}

async function captureWorkspace(sourceRoot, backupRoot) {
  await rm(path.dirname(backupRoot), { recursive: true, force: true });
  await mkdir(backupRoot, { recursive: true });
  for (const entry of allowedTopLevelEntries) {
    const source = path.join(sourceRoot, entry);
    if (await pathExists(source)) {
      await copyEntry(source, path.join(backupRoot, entry));
    }
  }
}

async function snapshotWorkspace(root) {
  const files = [];
  for (const entry of allowedTopLevelEntries) {
    const entryPath = path.join(root, entry);
    if (await pathExists(entryPath)) {
      await collectFileSnapshots(root, entryPath, files);
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function collectFileSnapshots(root, currentPath, files) {
  const fileStat = await lstat(currentPath);
  if (fileStat.isSymbolicLink()) {
    return;
  }
  if (fileStat.isDirectory()) {
    for (const entry of await readdir(currentPath)) {
      await collectFileSnapshots(root, path.join(currentPath, entry), files);
    }
    return;
  }
  if (!fileStat.isFile()) {
    return;
  }
  const relativeFilePath = normalizeRelativePath(path.relative(root, currentPath));
  if (!isAllowedRuntimeCodePath(relativeFilePath)) {
    return;
  }
  files.push({
    path: relativeFilePath,
    sha256: await hashFile(currentPath),
  });
}

async function copyEntry(source, destination) {
  const fileStat = await lstat(source);
  if (fileStat.isSymbolicLink()) {
    return;
  }
  if (fileStat.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source)) {
      await copyEntry(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  if (fileStat.isFile()) {
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

function snapshotMap(files) {
  return new Map(files.map((file) => [file.path, file.sha256]));
}

function isAllowedRuntimeCodePath(relativeFilePath) {
  const normalized = normalizeRelativePath(relativeFilePath);
  const [topLevel] = normalized.split("/");
  if (!allowedTopLevelEntries.has(topLevel)) {
    return false;
  }
  if (normalized.includes("/node_modules/") || normalized.endsWith("/node_modules")) {
    return false;
  }
  if (normalized.includes("/.git/") || normalized.endsWith("/.git")) {
    return false;
  }
  return true;
}

function normalizeRelativePath(value) {
  return value.split(path.sep).join("/");
}

async function hashFile(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
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

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rm(filePath, { force: true });
  await copyFile(`${filePath}.tmp`, filePath);
  await rm(`${filePath}.tmp`, { force: true });
}

async function appendAudit(filePath, event) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
}

function runtimeVersionName(version) {
  return `v${String(version.number).padStart(4, "0")} (${version.id})`;
}

function compactTimestamp(date) {
  const pad = (part) => String(part).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "-",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
}
