const { mkdirSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

if (process.platform !== "linux") {
  console.log("Skipping linux-native sandbox build on non-Linux platform");
  process.exit(0);
}

const root = join(__dirname, "..");
const outputDir = join(root, "native", "bin");
const output = join(outputDir, "pibot-linux-sandbox");
mkdirSync(outputDir, { recursive: true });

const result = spawnSync(
  process.env.CC ?? "cc",
  [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-o",
    output,
    join(root, "native", "pibot-linux-sandbox.c"),
  ],
  {
    stdio: "inherit",
  },
);

if (result.error !== undefined) {
  throw result.error;
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Built ${output}`);
