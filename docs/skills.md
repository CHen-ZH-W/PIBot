# Pibot Skill Creation

A Skill is a reusable operation manual with optional resources. It is not a
native tool. Pibot keeps a global Skill registry under `.pibot/skills` so
different channels and WebUI conversations can use the same workflows. The
model loads a matching Skill with `read_skill`; it creates or updates
pibot-wide Skill files with `write_skill`.

## Layout

Create one direct child directory under `.pibot/skills/` for a pibot-wide
Skill:

```text
.pibot/
└── skills/
    └── release-check/
        ├── SKILL.md
        ├── agents/
        │   └── openai.yaml
        └── references/
            └── checklist.md
```

Pibot also understands the OpenAI/Codex repo-local layout when a Skill should
belong to a specific project or workspace:

```text
.agents/
└── skills/
    └── release-check/
        ├── SKILL.md
        ├── agents/
        │   └── openai.yaml
        ├── scripts/
        │   └── verify.sh
        └── references/
            └── checklist.md
```

Pibot scans `.pibot/skills/*/SKILL.md` first, then
`.agents/skills/*/SKILL.md`, then the older `skills/*/SKILL.md` layout as a
compatibility fallback for existing workspaces. The default physical global
root is `<WORKSPACE_ROOT>/.pibot/skills`; if `PIBOT_STORE_ROOT` is configured,
it becomes `$PIBOT_STORE_ROOT/skills`. Pibot does not scan global
`$HOME/.agents/skills` or `/etc/codex/skills` locations. Directories and
`SKILL.md` files must not be symbolic links.

## SKILL.md Format

`SKILL.md` starts with a small frontmatter block:

```markdown
---
name: release-check
description: Verify release readiness before publishing.
---
# Release Check

1. Read the current package metadata.
2. Follow the release checklist in `references/checklist.md`.
3. Report failed checks before publishing.
```

Rules:

- `name` is required and should match its directory name for Agent Skills
  compatibility.
- `name` uses 1-64 lowercase letters, digits and single hyphens between
  segments. Pibot logs a recoverable warning if the name differs from the
  directory.
- `description` is a specific single-line explanation of what the Skill does
  and when to use it, with at most 1024 characters.
- Optional Agent Skills fields such as `license`, `compatibility`, `metadata`
  and `allowed-tools` are accepted.
- For OpenAI-style invocation policy, add `agents/openai.yaml` with
  `policy.allow_implicit_invocation: false` to keep a Skill out of the
  automatic system-prompt index. Pibot also accepts the older
  `disable-model-invocation: true` frontmatter field.
- The instruction body must not be empty.
- Each `SKILL.md` is limited by `SKILLS_MAX_FILE_BYTES`.
- The prompt receives only `name`, `description`, `source` and `location`;
  detailed instructions and references stay on disk until the model calls
  `read_skill`.

Example `agents/openai.yaml`:

```yaml
policy:
  allow_implicit_invocation: false
```

## Validation

Run:

```bash
npm run validate:skills
```

The model may create or improve a Skill when asked to capture a reusable
workflow. By default, reusable Skills are pibot-wide and should be written with
`write_skill` under `.pibot/skills/<skill-name>/`. Use `.agents/skills` only
when the Skill is explicitly repo/project-specific. Runtime validation logs
`skill_invalid` warnings for recoverable convention violations. Structurally
unusable Skills, such as files without a description, are skipped.
`npm run validate:skills` remains strict and fails on warnings so published
Skills stay portable. To disable a valid Skill without deleting it, add its
name to `SKILLS_DISABLED`.
