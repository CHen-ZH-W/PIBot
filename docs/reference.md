# pibot

This is the detailed reference that previously lived in the root README. The
concise project entry now lives in [`../README.md`](../README.md).

`pibot` is a coding-agent runtime with an OpenAI-compatible model client,
workspace tools, append-only session storage, controlled persistent memory,
workspace Skills, Plan/Reflection workflows, transport adapters and
Linux-native or Docker command sandboxes.

The current application supports WebUI sessions, Slack app mentions and DMs,
streaming ReAct tool use, one-shot approvals, file upload/download,
multimodal image attachments, TypeScript LSP lookup, repo checks, context
compaction, structured trace/usage logs and tmux-backed child agents.

## WebUI and Self-Evolution

pibot can expose an optional WebUI control plane. WebUI, Slack and CLI-style
tools are treated as entry points; the fixed WebUI `#self-evaluation` channel is
the maintenance surface for changing pibot itself.

Enable the WebUI alongside the main app:

```bash
PIBOT_WEBUI_ENABLED=1
PIBOT_WEBUI_HOST=127.0.0.1
PIBOT_WEBUI_PORT=8787
PIBOT_WEBUI_PUBLIC_URL=http://127.0.0.1:8787
npm start
```

For maintenance without connecting Slack, start only the WebUI:

```bash
npm run webui
```

The standalone WebUI reads the same model, sandbox, tool-limit, Skill and
workspace variables used by the Slack runtime. Ordinary WebUI sessions call the
same OpenAI-compatible model client and coding tools; missing `OPENAI_API_KEY`
or provider settings surface as agent errors in the WebUI conversation. Tool
approval still follows `TOOL_APPROVAL_MODE`. When a WebUI tool call requires
one-shot approval, the live run displays an approval card and pauses until the
user approves, rejects or the request times out.

WebUI session titles and ordering are indexed in
`.pibot/webui/conversations.json`, but model history is stored per session in
the same channel layout as Slack:
`.pibot/channels/webui/<web-session-id>/context.jsonl`. Existing WebUI messages
from `conversations.json` are lazily migrated into that channel context the
first time the session is read.

WebUI coding tools are scoped to the same per-session channel workspace. Without
a session-specific repo config, a WebUI session can only write inside
`.pibot/channels/webui/<web-session-id>/`. To grant a WebUI session access to a
real code workspace, create
`.pibot/channels/webui/<web-session-id>/repo.json`; the global `.pibot/repo.json`
is intentionally not applied to WebUI sessions.

The first self-evolution target is versioned self-instructions stored under
`.pibot/evolution/agent-self/`. When a Slack or WebUI run ends with an
agent-level error, pibot records an evolution signal, creates or updates an
evolution ticket, and links the ticket back to Slack when the WebUI public URL
is configured. Users can also ask in a normal Slack or WebUI session for a
pibot behavior change; the `create_evolution_task` tool files that idea as an
evolution ticket without applying it. Maintainers can edit the proposal,
approve it, apply it, and roll back previous self-instruction versions from the
WebUI.

The self-evolution lane does not edit the user's workspace. Approved
self-instructions are injected into future pibot system prompts and can be
rolled back through the WebUI Versions panel. The fixed `#self-evaluation`
entry keeps a short topic index in
`.pibot/channels/webui/self-evaluation/context.jsonl`, while each ticket gets
its own ticket-scoped context under
`.pibot/channels/webui/self-evaluation/tickets/<ticket-id>/context.jsonl`.
Ticket creation, proposal updates, approvals, rollouts, implementation runs and
maintainer notes are recorded against the relevant ticket context instead of
being mixed into one long transcript. A ticket topic starts from the proposal
topic while work is pending, then switches to the completion summary once an
implementation or rollout finishes. Applied self-instruction versions carry a
short topic so the Versions panel and future prompts can show what each version
was about without rereading the full handling context.

Runtime-code self-evolution uses an isolated implementation workspace under
`.pibot-evolution-workspaces/`. The model edits that copy first; the WebUI then
runs control-plane validation, including TypeScript checks and browser-script
parsing for the embedded WebUI JavaScript. Only validated changes are published
back to the real pibot repository, and publishing fails closed if the matching
real file changed after the isolated workspace was created.

After a runtime-code ticket is implemented and published, the WebUI shows an
`Activate Runtime` button by default. Clicking it records a runtime-activation
event and exits the current Node process. When WebUI is started with
`npm run webui`, that command runs a small terminal supervisor: it detects the
activation marker, rebuilds, restarts `dist/web-main.js` in the same terminal,
and the browser waits for `/api/health` before reloading. This keeps logs
visible in the terminal you originally used instead of starting a hidden
background process. If you launch `node dist/web-main.js` directly, activation
still exits and you must restart manually. To use an explicit server-side
restart command instead, set `PIBOT_EVOLUTION_RESTART_COMMAND`; keep it pointed
at your supervisor, for example `sudo systemctl restart pibot` or a narrow
deploy script. The browser never supplies the command text.

## Requirements

- Node.js 22+
- npm
- A Slack app with Socket Mode enabled
- An OpenAI-compatible API key
- Linux with Landlock ABI 3+ and a C compiler for the recommended native sandbox
- Docker with Compose only when using the optional Docker sandbox

## Slack App

Create a Slack app, enable Socket Mode and Interactivity & Shortcuts, then
subscribe to:

- `app_mention`
- `message.im`

The bot needs these OAuth scopes:

- `app_mentions:read`
- `chat:write`
- `files:read`
- `files:write`
- `im:history`
- `reactions:write`

Startup history backfill uses Slack conversation listing/history APIs and
defaults to `public_channel,private_channel,im`. Add the matching Slack
history/read scopes for the channel types you keep enabled, or set
`SLACK_BACKFILL_ENABLED=0`.

## Quickstart

Install dependencies and create a local environment file:

```bash
npm ci
cp .env.example .env
```

Build the Linux launcher, export the values from `.env`, then start pibot:

```bash
npm run build:native
set -a
. ./.env
set +a
npm start
```

With `SANDBOX_EXECUTOR=linux-native`, model-requested Shell commands run as
restricted child processes in the current Linux environment. This works when
`pibot` itself runs in a container and does not require Docker-in-Docker.

## Security Model

File tools run in the pibot process, but they are restricted to the configured
workspace. In Docker mode, the allowed pibot workspace must also be mapped into
the configured sandbox container workspace. File tools reject:

- paths outside the workspace
- symbolic links in requested paths
- protected runtime and secret paths such as `.git/`, `.pibot/`, `.env*`,
  `.npmrc`, `.netrc`, `context.jsonl`, `log.jsonl`, `MEMORY.md`, `repo.json`,
  `trace.jsonl` and `usage.jsonl`
- files larger than `TOOL_MAX_FILE_BYTES`

Shell commands and repo check commands use `SandboxExecutor`. On Linux,
`linux-native` mode is recommended. Its native launcher:

- clears inherited environment variables before executing the Shell
- applies a Landlock allowlist for workspace files, read-only runtime files and
  a private temporary directory
- blocks network sockets and dangerous syscalls with seccomp
- limits CPU time, memory, process count, open files and generated file sizes

Landlock rules are additive. Without an overlay filesystem, a workspace
directory containing a protected descendant receives conservative Shell write
permissions. File tools can still create ordinary files after their own path
checks. Overlay-backed ignore support is planned separately.

The launcher applies an address-space limit. Node.js and WebAssembly reserve
large virtual address ranges, so this is deliberately higher than typical
resident memory use. Configure the outer container cgroup when a strict
physical-memory limit is required. Linux Landlock ABI 3 also cannot restrict
file-mode metadata changes such as `chmod`; protected file contents remain
unreadable and unwritable, while overlay-backed isolation is planned to close
that metadata gap.

Host mode is an explicit development escape hatch and does not provide
additional filesystem isolation:

```bash
SANDBOX_EXECUTOR=host
SANDBOX_HOST_ENABLED=1
```

Tool execution is policy-gated:

| `TOOL_APPROVAL_MODE` | Allowed tools |
|---|---|
| `read-only` | Automatically allow read-only tools; deny mutating and external tools |
| `workspace-write` | Automatically allow read-only and mutating workspace tools; ask in Slack before external tools such as `bash`, `attach` and child-agent control |
| `approval-required` | Automatically allow read-only tools; ask in Slack before mutating and external tools |
| `full-access` | Automatically allow all tools |

The default is `read-only`. When approval is required, pibot posts `Allow once`
and `Reject` buttons. Only the Slack user who started the run can decide, and
the decision applies only to that tool call. Approval does not change the
global mode. The wait expires after `TOOL_APPROVAL_TIMEOUT_MS`.

`full-access` should only be used with a tested `linux-native` or Docker
sandbox. Shell network access remains blocked by the Linux-native launcher even
after a tool call is approved.

## Coding Agent Features

pibot keeps the core loop as a single-agent ReAct runtime:

```text
Slack message
-> model text or tool call
-> runtime hooks validate mode, approvals and trace
-> tool result enters context
-> model continues or returns a final answer
```

Registered tools are described once in a tool registry with a JSON schema, risk
level and execution mode. Read-only tools may run in parallel; file mutations
are serialized per target file.

Current built-in tools:

| Area | Tools |
|---|---|
| Workspace inspection | `read`, `grep`, `lsp` |
| Execution and mutation | `bash`, `edit`, `write` |
| Slack experience | `attach` |
| Persistent memory | `memory_read`, `memory_write`, `memory_delete` |
| Skills | `read_skill`, `write_skill` |
| Plan and tasks | `enter_plan_mode`, `update_plan`, `exit_plan_mode`, `tasks_read`, `tasks_update`, `task_update` |
| Coordinator mode | `enter_coordinator_mode`, `exit_coordinator_mode` |
| tmux child agents | `agent_spawn`, `agent_list`, `agent_capture`, `agent_send`, `agent_stop`, `agent_collect` |
| Self-evolution | `create_evolution_task` |

Slack runtime behavior:

- `stop`, `cancel`, or common Chinese equivalents such as `停止` / `取消`
  cancels the active run in the channel.
- Messages sent while a run is active are treated as in-flight steering by
  default.
- `steering: ...` explicitly injects an in-flight correction into the active
  run.
- `follow-up: ...` queues a message to run after the active run completes.
- Coordinator Mode can be requested with messages such as `coordinator: review
  this diff` or `进入 coordinator 模式`.
- Long-running tasks update the main Slack message periodically.

## Configuration

Required variables:

| Variable | Description |
|---|---|
| `SLACK_APP_TOKEN` | Slack Socket Mode app token |
| `SLACK_BOT_TOKEN` | Slack bot OAuth token |
| `OPENAI_API_KEY` | Model provider API key |

Common variables:

| Variable | Default | Description |
|---|---:|---|
| `OPENAI_BASE_URL` | OpenAI URL | OpenAI-compatible API base URL |
| `OPENAI_MODEL` | `gpt-4o-mini` | Model name; `kimi-k2.6` enables Kimi pricing |
| `OPENAI_FALLBACK_MODELS` | empty | Comma-separated fallback models |
| `MODEL_MAX_RETRIES` | `2` | Retries per model before fallback |
| `MODEL_RETRY_BASE_DELAY_MS` | `500` | Initial model retry delay |
| `MODEL_RETRY_MAX_DELAY_MS` | `8000` | Maximum model retry delay |
| `MODEL_CONTEXT_WINDOW_TOKENS` | `262144` | Active model context window; set this to the smallest configured fallback window when overriding |
| `AGENT_MAX_TURNS` | `80` | Maximum model/tool turns for one run |
| `LONG_TASK_STATUS_UPDATE_MS` | `30000` | Slack status refresh interval for long-running tasks |
| `SESSION_COMPACTION_RESERVE_TOKENS` | `32768` | Buffer reserved for prompt overhead, output and in-run context growth; LLM summary generation uses `floor(0.8 * reserve)` max output tokens |
| `SESSION_COMPACTION_KEEP_RECENT_TOKENS` | `20000` | Approximate recent-history token budget retained after compaction |
| `SESSION_COMPACTION_MAX_OVERFLOW_RETRIES` | `1` | Forced compaction retries after provider context overflow |
| `WORKSPACE_ROOT` | current directory | pibot workspace boundary |
| `PIBOT_STORE_ROOT` | `.pibot` in workspace | Session and attachment storage |
| `PIBOT_TRACE_MAX_FILE_BYTES` | `20000000` | Maximum structured trace JSONL size |
| `PIBOT_EVOLUTION_RESTART_ENABLED` | `true` | Enable the WebUI `Activate Runtime` button after runtime-code self-evolution publishes |
| `PIBOT_EVOLUTION_RESTART_COMMAND` | empty | Optional server-side command used by `Activate Runtime`; when empty, `npm run webui` restarts in the original terminal via its marker-based supervisor |
| `PIBOT_EVOLUTION_RESTART_MARKER` | `.pibot/runtime-activation/restart-request.json` | Internal marker file used by the `npm run webui` terminal supervisor |
| `PIBOT_EVOLUTION_RESTART_LABEL` | `terminal restart` or `configured restart command` | Human-readable restart label shown in runtime-activation audit/UI state |
| `PIBOT_EVOLUTION_RESTART_DELAY_MS` | `1500` | Delay before starting activation, giving the HTTP response time to flush |
| `SLACK_EVENT_GRACE_MS` | `5000` | Ignore stale events from before startup plus this grace window |
| `SLACK_BACKFILL_ENABLED` | enabled | Set to `0`, `false` or `no` to skip startup history backfill |
| `SLACK_BACKFILL_MAX_CHANNELS` | `20` | Maximum channels scanned during startup backfill |
| `SLACK_BACKFILL_MAX_MESSAGES_PER_CHANNEL` | `50` | Maximum recent messages scanned per channel during startup backfill |
| `SLACK_BACKFILL_CHANNEL_TYPES` | `public_channel,private_channel,im` | Slack channel types for startup backfill |
| `SANDBOX_EXECUTOR` | disabled | `linux-native`, `docker` or `host` |
| `TOOL_APPROVAL_MODE` | `read-only` | Tool permission policy |
| `TOOL_APPROVAL_TIMEOUT_MS` | `300000` | Slack one-shot tool approval timeout |
| `SLACK_MAX_ATTACHMENT_BYTES` | `5000000` | Maximum downloaded attachment size |
| `SLACK_ATTACHMENT_DOWNLOAD_TIMEOUT_MS` | `30000` | Attachment download timeout |
| `ATTACH_MAX_FILE_BYTES` | `TOOL_MAX_FILE_BYTES` | Maximum generated file size the `attach` tool may upload |
| `TOOL_MAX_FILE_BYTES` | `1000000` | Maximum file-tool input size |
| `TOOL_MAX_READ_CHARS` | `20000` | Maximum text returned by one `read` call |
| `TOOL_MAX_GREP_MATCHES` | `200` | Maximum grep matches returned |
| `TOOL_MAX_GREP_OUTPUT_CHARS` | `2000000` | Maximum grep output characters |
| `TOOL_MAX_COMMAND_OUTPUT_CHARS` | `20000` | Shell stdout/stderr limit |
| `BASH_DEFAULT_TIMEOUT_MS` | `120000` | Default Shell timeout |
| `BASH_MAX_TIMEOUT_MS` | `600000` | Maximum Shell timeout |
| `SESSION_MAX_LOG_FILE_BYTES` | `2000000` | Per-channel log limit |
| `SESSION_MAX_CONTEXT_FILE_BYTES` | `10000000` | Per-channel context limit |
| `SESSION_MAX_MEMORY_INDEX_FILE_BYTES` | `8000` | Concise `MEMORY.md` index limit |
| `SESSION_MAX_MEMORY_FILE_BYTES` | `64000` | Instructions and detailed memory-topic limit |
| `SESSION_MAX_MEMORY_AUDIT_FILE_BYTES` | `2000000` | Append-only memory mutation audit limit |
| `SKILLS_DISABLED` | empty | Comma-separated workspace Skill names to exclude |
| `SKILLS_MAX_COUNT` | `100` | Maximum Skill entries injected into the prompt index |
| `SKILLS_MAX_FILE_BYTES` | `64000` | Maximum size of each `SKILL.md` file |
| `REFLECTION_ENABLED` | `false` | Enable post-run verify/critique/fix reflection |
| `REFLECTION_MAX_FIX_ATTEMPTS` | `2` | Maximum automatic reflection fix attempts |
| `REFLECTION_MAX_TURNS` | `AGENT_MAX_TURNS` | Maximum turns for a reflection pass |
| `REFLECTION_VERIFY_COMMANDS` | empty | Comma-separated verification commands for reflection |
| `PIBOT_TMUX_PATH` | `tmux` | tmux binary used by child-agent supervisor |
| `PIBOT_TMUX_SOCKET_PATH` | empty | Optional isolated tmux socket path |
| `PIBOT_CHILD_AGENT_COMMAND` | `node dist/child-agent.js` | Child-agent command template |
| `CHILD_AGENT_MAX_CONCURRENT` | `20` | Maximum active child agents per parent run |
| `CHILD_AGENT_DEFAULT_TIMEOUT_MS` | `900000` | Default child-agent timeout |
| `CHILD_AGENT_MAX_TIMEOUT_MS` | `1800000` | Maximum child-agent timeout |
| `CHILD_AGENT_MAX_TOOL_CALLS` | `40` | Default child-agent tool-call budget |
| `CHILD_AGENT_MAX_TOKENS` | `120000` | Default child-agent output/token budget passed to the model |
| `CHILD_AGENT_MAX_TURNS` | `16` | Maximum model/tool turns for a built-in child agent |
| `CHILD_AGENT_CAPTURE_LINES` | `120` | Default tmux pane tail lines captured |
| `CHILD_AGENT_CAPTURE_MAX_CHARS` | `20000` | Default tmux capture character limit |
| `CHILD_AGENT_TOOL_APPROVAL_MODE` | inherited | Optional approval mode override for built-in child agents |
| `CHILD_AGENT_TOOL_APPROVAL_TIMEOUT_MS` | `TOOL_APPROVAL_TIMEOUT_MS` | Child-agent tool approval timeout |
| `CHILD_AGENT_ALLOW_BASH` | `false` | Allow bash for read-only child agents when no approval bridge is available |

Session compaction runs before a new Slack task when estimated history usage exceeds
`MODEL_CONTEXT_WINDOW_TOKENS - SESSION_COMPACTION_RESERVE_TOKENS`. Token counts
use a lightweight estimate. The compactor preserves complete messages up to the
recent-history budget and keeps tool calls paired with their tool results. It asks
the configured model for a structured summary and falls back to a heuristic
summary if that call fails. Provider context overflow triggers one forced
compaction and automatic retry by default.

Usage pricing can be overridden with `USAGE_COST_CURRENCY`,
`USAGE_INPUT_COST_PER_1M_TOKENS`,
`USAGE_CACHED_INPUT_COST_PER_1M_TOKENS` and
`USAGE_OUTPUT_COST_PER_1M_TOKENS`. If no provider usage is returned, pibot
records an estimated usage entry.

## Persistent Memory

Persistent memory uses controlled tools instead of ordinary workspace file tools:

```text
.pibot/
├── instructions.md
├── memories/
│   ├── memory_summary.md
│   ├── MEMORY.md
│   ├── topics/<topic>.md
│   ├── rollout_summaries/<summary>.md
│   ├── extensions/ad_hoc/notes/<note>.md
│   └── audit.jsonl
└── channels/<team>/<channel>/
    └── instructions.md
```

`instructions.md` is user-managed configuration. The compact
`memory_summary.md` and short `MEMORY.md` indexes are injected into the system
prompt. Detailed topics, rollout summaries, and extension notes are loaded only
when needed with `memory_read`. Before a final answer on non-trivial work, the
shared system prompt asks the model to review whether the run produced durable
memory candidates.

Memory is meant to be reusable operational knowledge, not a transcript archive.
Good candidates include stable user preferences, repo-specific source-of-truth
paths, runtime entrypoints, validated workflows or commands, recurring failure
modes, architectural decisions, and completed-task outcome summaries that make a
future run cheaper or safer. A useful topic should read like a triggerable note:
scope/applicability, keywords, what to inspect, what worked, and what failed or
should be done differently.

At runtime the injected `MEMORY.md` file is a compact routing index, not
complete truth. The model should use them to decide when a topic may matter, call
`memory_read` for detailed `topic` or `rollout_summary` documents before relying
on prior work, and revalidate drift-prone facts from the current repo or runtime
state. `extension_note` stores candidate updates that should be reviewed or
merged later instead of silently changing the registry. Completed agent runs are
also recorded automatically as global `rollout_summary` documents and indexed
under a managed `Recent Rollout Summaries` section in `MEMORY.md`.
Writing an `extension_note` automatically registers it under managed
`Pending Extension Notes` sections in `MEMORY.md` and `memory_summary.md`, so
future runs can see that a candidate exists without treating it as a final
long-term rule. Persistent memory is a single Codex-like global store; use
`applies_to`, `cwd`, keywords, and reuse guidance inside the content to express
where a memory applies instead of creating per-channel memory. The agent should
leave one-off details, secrets, raw transcripts, speculative claims, and risky
merges out of persistent memory.
`memory_delete` handles explicit forget requests. Every mutation records its
source, timestamp and reason in an
append-only audit log. The legacy `.pibot/MEMORY.md` and `.pibot/memory/` layout
is still readable as a compatibility fallback, but new writes use
`.pibot/memories/`.

## Pibot Skills

Skills are reusable operation manuals and optional script packages, not native
tools. At the start of a task, pibot scans pibot-wide
`.pibot/skills/*/SKILL.md` children from the runtime store, then
OpenAI-aligned workspace `.agents/skills/*/SKILL.md` children, then the legacy
`skills/*/SKILL.md` layout for compatibility. It validates their metadata and
injects only a compact XML index into the system prompt.

Pibot-wide Skills are shared by different channels and WebUI conversations:

```text
.pibot/
└── skills/
    └── release-check/
        ├── SKILL.md
        └── references/
```

Project-local Skills may still live in the Codex repo layout:

```text
.agents/
└── skills/
    └── release-check/
        ├── SKILL.md
        └── scripts/
```

Legacy pibot workspaces may still use:

```text
skills/
└── release-check/
    ├── SKILL.md
    └── scripts/
```

When a task matches a Skill, the model uses `read_skill` with the indexed
location to load `SKILL.md` or relative resources. `write_skill` creates or
updates pibot-wide files under `.pibot/skills/<skill-name>/` through the tool
approval policy. Ordinary workspace file tools remain bounded to the active
repo or channel workspace. Recoverable convention violations produce warnings.
Structurally unusable Skills are skipped. Set `SKILLS_DISABLED` to exclude
specific names without deleting their files. To hide one from the automatic
prompt index, either set `policy.allow_implicit_invocation: false` in
`agents/openai.yaml`, or use the legacy `disable-model-invocation: true`
frontmatter field.

See [`docs/skills.md`](docs/skills.md) for the creation format. Run
`npm run validate:skills` before publishing a new Skill package.

## Plan, Tasks and Reflection

pibot has three runtime modes:

| Mode | Purpose |
|---|---|
| `execute` | Normal coding-agent execution |
| `plan` | Read-only exploration plus `PLAN.md` and `tasks.json` updates |
| `coordinator` | Main agent coordinates tmux child agents and summarizes results |

Plan Mode is enforced by runtime hooks. While in Plan Mode, mutating tools are
hidden or denied except for plan/task control tools. `update_plan` writes
`PLAN.md` and can also write structured tasks to `tasks.json`. `exit_plan_mode`
requests Slack approval before returning to Execute Mode.

The Plan-and-Execute task store keeps task ids, dependencies, status, attempts,
notes and bounded replan counts in `tasks.json`. The agent can use `tasks_read`
and `task_update` to execute approved work item by item.

When `REFLECTION_ENABLED=true`, a completed Execute Mode run starts a bounded
verification pass. Reflection asks the model to verify, critique, fix when
needed, verify again, and end with a status marker. It stops after
`REFLECTION_MAX_FIX_ATTEMPTS` and reports remaining risk instead of looping.

## tmux Child Agents

Coordinator Mode uses tmux windows and independent child-agent processes for
transparent multi-agent work. The default child command is the built-in
`node dist/child-agent.js`, and `PIBOT_CHILD_AGENT_COMMAND` can override it.

Child tasks are chosen by the model in the `agent_spawn.task` text. Roles are
coarse execution and permission labels rather than fixed objective templates:

| Role | Runtime meaning |
|---|---|
| `explore` | Read-only child unless explicitly overridden |
| `review` | Read-only child unless explicitly overridden |
| `test` | Read-only child unless explicitly overridden |
| `implement` | May request write-capable work only with an isolated worktree |

Child-agent runs are stored under:

```text
.pibot/channels/<team>/<channel>/runs/<child-run-id>/
├── task.md
├── status.json
├── transcript.jsonl
├── result.md
└── usage.json
```

The parent agent can capture a pane tail, send input, stop a child and collect
structured results without ingesting the full transcript. High-risk child tools
can bridge approval requests back to the main Slack approval broker through
files in the child run directory.

Users can inspect or take over child agents with tmux:

```bash
tmux list-windows
tmux attach -t <session>
tmux capture-pane -t <session>:<window> -p
```

If `PIBOT_TMUX_SOCKET_PATH` is set, pass `-S <socket>` to those tmux commands.

Linux-native optional overrides:

| Variable | Default | Description |
|---|---:|---|
| `SANDBOX_LINUX_LAUNCHER_PATH` | `native/bin/pibot-linux-sandbox` | Native launcher path |
| `SANDBOX_LINUX_MAX_PROCESSES` | `256` | Maximum processes for a Shell command |
| `SANDBOX_LINUX_MAX_OPEN_FILES` | `256` | Maximum open files |
| `SANDBOX_LINUX_MAX_FILE_SIZE_BYTES` | `64000000` | Maximum generated file size |
| `SANDBOX_LINUX_MAX_MEMORY_BYTES` | `17179869184` | Maximum virtual address space |

To use the optional Docker executor instead, start its container:

```bash
docker compose -f docker-compose.sandbox.yml up -d --build
SANDBOX_EXECUTOR=docker
SANDBOX_DOCKER_CONTAINER=pibot-sandbox
SANDBOX_DOCKER_WORKSPACE_ROOT=/workspace
```

## Repo Workflow

Create `.pibot/repo.json` or a channel-specific
`.pibot/channels/<team>/<channel>/repo.json`:

```json
{
  "repoPath": ".",
  "checkCommand": "npm test"
}
```

The configurable `checkCommand` runs through the same `SandboxExecutor` used by
the `bash` tool.

For WebUI sessions, use the channel-specific path
`.pibot/channels/webui/<web-session-id>/repo.json`. WebUI intentionally ignores
the global `.pibot/repo.json` so each browser session only edits the workspace
explicitly assigned to that session.

## Runtime Trace

Each Slack run appends structured events to `.pibot/trace.jsonl`. Events share
`runId`, optional `parentRunId`, and `agentId`, and cover model calls, token
usage, cost, retries, tool arguments, tool results, duration, approval decisions,
interception reasons, and final run status.

Each Slack run also appends a usage record to `.pibot/usage.jsonl`. Child-agent
usage is stored in each child run directory and summarized by `agent_collect`.

## Attachments

Slack text attachments are downloaded to:

```text
.pibot/channels/<team>/<channel>/attachments/
```

The model receives a channel-workspace-relative file path. Without a configured
repo it may inspect text files with `read` or `grep`. Downloaded image
attachments are also converted to multimodal `image_url` content parts for
providers that support OpenAI-compatible image input.

The `attach` tool uploads a generated workspace file back to the current Slack
thread. It requires the Slack `files:write` scope and is treated as an external
tool by the approval policy.

When a repo is configured, file tools switch to the repo root. Exposing
downloaded Slack attachments to that repo workspace is still a known gap.

## Development

```bash
npm run typecheck
npm test
```

`npm test` builds the project, runs production checks and executes every
acceptance script.
