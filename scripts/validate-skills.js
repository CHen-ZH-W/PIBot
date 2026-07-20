const { join, resolve } = require("node:path");
const { scanWorkspaceSkills } = require("../dist/workspace/skills");

async function validateSkills() {
  const workspaceRoot = resolve(process.env.WORKSPACE_ROOT ?? process.cwd());
  const pibotSkillsRoot = resolve(
    process.env.PIBOT_STORE_ROOT ?? join(workspaceRoot, ".pibot"),
    "skills",
  );
  const result = await scanWorkspaceSkills(workspaceRoot, {
    pibotSkillsRoot,
    maxSkills: readPositiveIntegerEnv("SKILLS_MAX_COUNT") ?? 100,
    maxSkillFileBytes: readPositiveIntegerEnv("SKILLS_MAX_FILE_BYTES") ?? 64_000,
  });

  for (const issue of result.issues) {
    console.error(`- ${issue.location}: ${issue.message}`);
  }
  if (result.issues.length > 0) {
    throw new Error(`Skill validation failed with ${result.issues.length} issue(s)`);
  }

  console.log(`Validated ${result.skills.length} skill(s)`);
}

function readPositiveIntegerEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

validateSkills().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
