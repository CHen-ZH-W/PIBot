# pibot

This is the detailed reference that previously lived in the root README. The
concise project entry now lives in [`../README.md`](../README.md).

`pibot` is a coding-agent runtime with a multi-provider model client,
workspace tools, append-only session storage, controlled persistent memory,
workspace Skills, Plan/Reflection workflows, transport adapters and
Linux-native or Docker command sandboxes.

The current application supports WebUI sessions, Slack app mentions and DMs,
streaming ReAct tool use, one-shot/run/session/repo approvals, file upload/download,
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
same multi-provider model client and coding tools; missing credentials or
provider settings surface as agent errors in the WebUI conversation. Tool
approval still follows `TOOL_APPROVAL_MODE`. When a WebUI tool call requires
approval, the live run displays the exact escalation delta and pauses until the
user allows it once, retains an exact rule for the current Run, rejects it or
the request times out.

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
  `.npmrc`, `.netrc`, `approval-rules.jsonl`, `context.jsonl`, `log.jsonl`, `MEMORY.md`, `repo.json`,
  `trace.jsonl` and `usage.jsonl`
- files larger than `TOOL_MAX_FILE_BYTES`

Shell commands and repo check commands use `SandboxExecutor`. On Linux,
`linux-native` mode is recommended. Its native launcher:

- clears inherited environment variables before executing the Shell
- applies a Landlock allowlist using the call's granted workspace-relative
  read/write paths, plus read-only runtime files and a private temporary directory
- blocks network sockets unless that single call has `network.connect`, and
  always blocks the remaining dangerous syscalls with seccomp
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

Tool execution is capability-gated. A Tool keeps its static `riskLevel` as
compatibility metadata for schema exposure, but each parsed call resolves a
`ToolCapabilityRequest`. The request can contain scoped `filesystem.read` and
`filesystem.write` paths plus `process.exec`, `network.connect`,
`external.side_effect`, `runtime.read`, and `runtime.control`. Approval creates
an immutable `ToolCapabilityGrant` bound to the call/request digests, sandbox
policy version, expiry and current runtime-state version. Grants are active only
while their owning call executes; file tools and the Linux-native Shell sandbox
reject inactive, replayed, stale or command-mismatched grants. Runtime-owned
repo checks use an explicit short-lived RuntimeGrant instead of an unauthorised
compatibility fallback.
All built-in tools declare capabilities explicitly. A custom registered tool
without `resolveCapabilities` receives a legacy request derived from its static
`riskLevel` during migration.

The four existing modes remain named policy profiles:

| `TOOL_APPROVAL_MODE` | Capability policy |
|---|---|
| `read-only` | Allow `filesystem.read`, `runtime.read`, and submission of a reviewable `self-evolution:ticket`; deny other capabilities |
| `workspace-write` | Also allow workspace writes, local process execution and runtime control; ask before network, external side effects, or destructive effects |
| `approval-required` | Allow reads; ask before every other capability |
| `full-access` | Allow all requested capabilities |

The default is `read-only`. When approval is required, pibot offers allow/deny
actions for one call, the current Run, the current session, or the current
repo/workspace. Every reusable rule uses an exact key over the approval mode,
Tool name and canonical full capability request; changed paths, commands, hosts
or effects require a new decision. Run rules live on the current Runtime State
and survive its follow-up UserTurns. Session and repo rules are append-only in
`.pibot/approval-rules.jsonl`, survive restarts, and bind the approving user plus
an exact session/repo fingerprint. A session rule also binds the current
repo/workspace so switching a conversation to another repo cannot carry its
authority across. Child agents use the same persistent store when approval is
bridged to the parent, but never inherit a parent's Run-only rules.

Only the Slack user who started the run can decide. Approval does not change the
global mode. The wait expires after `TOOL_APPROVAL_TIMEOUT_MS`. PIBot checks the
current Agent Mode, call digest and SandboxPolicy version again after the wait;
a reusable allow rule is committed only after these checks pass, so a stale
approval neither executes nor leaves authority behind. Persistent denies can be
listed with `GET /api/approval-rules` and revoked by id with
`DELETE /api/approval-rules/<id>` in the WebUI API.

Before an approval prompt is emitted, Bash resolves the requested capabilities,
the executor-owned `SandboxPolicy`, workspace paths and declared backend
enforcement into an `EffectiveSandboxCallPolicy`. Protected, missing or symlink
scopes and backend/path combinations that cannot be enforced fail before the
user is asked. The prompt includes the preflighted backend and policy version;
the active Grant is checked against the same policy again inside the executor.
Direct read/write/edit/attach tools likewise preflight their policy-owned path
boundary (and applicable size/context checks) before prompting, then repeat the
checks at execution to retain TOCTOU protection.

`bash.permissions` lets a call declare its least authority. The compatible
`filesystem: "read" | "write"` form covers the whole workspace. A scoped call
can instead use `filesystem: { read: ["src"], write: ["tmp/output.txt"] }`;
directories cover descendants. Exact file scopes must already exist, while an
existing authorized directory can create new descendants. Protected paths and
symbolic-link scopes fail closed. Pure process commands may use empty read and
write arrays, which gives Linux-native zero workspace authority. The remaining
fields are `network`, `externalSideEffect`, and the `destructive` effect hint.
Omitting permissions selects the conservative legacy profile (workspace write,
no network, external side effect), preserving the old approval behavior.
Read-only child agents additionally have a hard `filesystem.write` ceiling
independent of approval mode. Without an approval bridge, enabling read-only
child Bash uses the `workspace-write` baseline, so network and external side
effects remain denied unless explicitly configured.
A write-capable child defaults to `approval-required` when a parent approval
bridge is available and to `workspace-write` otherwise; it no longer defaults
to `full-access`.

Destructive effect hints prompt in both `workspace-write` and
`approval-required`; they are denied by `read-only` and automatically accepted
only by `full-access`. This keeps an ordinary test command distinct from a
declared destructive cleanup even when both need workspace write access.

`full-access` should only be used with the tested `linux-native` sandbox. The
Linux-native launcher enables Shell network access only when the
specific call requested and received `network.connect`. Host mode remains an
explicit development escape hatch and cannot enforce per-call filesystem or
network isolation. The current Docker executor keeps its container-level mount
and network policy. Host and Docker reject path-scoped Bash Grants instead of
pretending to enforce them; their compatible Bash profile remains the explicit
whole-workspace form. They do not yet enforce per-call network changes.

Direct file tools, repo path resolution and the native launcher consume the
same executor-owned, versioned `SandboxPolicy` protected-name lists. The policy
also owns the Linux-native resource-limit defaults and records that outbound
network enforcement currently has `all-or-none` granularity; hostname-specific
enforcement is not claimed.
Each executor also declares its filesystem/network enforcement level. The
runtime resolves these declarations, the call Grant and `SandboxPolicy` into an
`EffectiveSandboxCallPolicy`, and publishes the backend/policy version in the
refreshable World State lane.

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
are serialized per target file. Parallel-safe batches use a bounded rolling
pool (`AGENT_MAX_PARALLEL_TOOL_CALLS`, default `8`) and stop dispatching queued
calls after cancellation while preserving one tool result per model tool call.
The scheduler also accepts complete calls incrementally. In particular,
Anthropic `tool_use` blocks can start execution at `content_block_stop` while
the remainder of the model stream is still arriving. Sequential calls remain
strict barriers, and results are committed to the next model Step in original
call order.

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
  requests structured cancellation of the active Run. The first accepted
  reason wins; repeated or post-terminal cancellation is rejected.
- Messages sent while a run is active are treated as in-flight steering by
  default and enter `NextStepInbox`.
- `steering: ...` uses the same next-Step path explicitly. PIBot has no
  separate `inject` control primitive.
- `follow-up: ...` enters `NextTurnQueue` and starts a new UserTurn under the
  same Run after the active UserTurn reaches a terminal state.
- Steering is delivered in receive order and at most once. Once a UserTurn has
  made its terminal decision, late steering and mode changes are rejected.
- Both control queues are bounded; cancellation closes them and queued but
  undelivered entries receive an explicit terminal disposition.
- Coordinator Mode can be requested with messages such as `coordinator: review
  this diff` or `进入 coordinator 模式`.
- Long-running tasks update the main Slack message periodically.

The runtime boundary is `Run -> UserTurn -> Step`. `AgentRuntime` owns the
process-local active-Run registry and transport-neutral control routing;
`AgentRunController` owns one Run's UserTurns, queues, cancellation and terminal
state. `MinimalAgentLoop` owns model/tool repetition. Each Step captures one
immutable `AgentStepSnapshot` containing runtime state, model-visible World
State, available tools, workspace and execution-authority version. Permission
tightening may still deny a pending call immediately; expansion waits for the
next Step, and a changed executor authority cannot reuse an old snapshot.
`ToolScheduler` owns incremental intake, serial barriers, bounded parallel
dispatch, cancellation backpressure, result ordering, and the rule that every
complete model tool call receives exactly one tool result. Context recovery and
reflection are lifecycle policies; tracing and UI transition consumers are
fail-open observers and cannot change runtime decisions.

## Configuration

Required Slack transport variables:

| Variable | Description |
|---|---|
| `SLACK_APP_TOKEN` | Slack Socket Mode app token |
| `SLACK_BOT_TOKEN` | Slack bot OAuth token |

The active model's credential is also required. In legacy mode this is
`OPENAI_API_KEY`; multi-provider profiles declare `apiKeyEnv` or secret header
environment references such as `ANTHROPIC_API_KEY`.

Common variables:

| Variable | Default | Description |
|---|---:|---|
| `OPENAI_BASE_URL` | OpenAI URL | OpenAI-compatible API base URL |
| `OPENAI_MODEL` | `gpt-4o-mini` | Model name; `kimi-k2.6` enables Kimi pricing |
| `OPENAI_DEVELOPER_ROLE_MODE` | `native` | `native` sends PIBot application instructions as `developer`; `system-fallback` explicitly maps them to `system` for endpoints that reject `developer` and records an authority downgrade |
| `OPENAI_FALLBACK_MODELS` | empty | Comma-separated fallback models |
| `PIBOT_MODELS_CONFIG` | `.pibot/models.json` | Multi-provider model configuration; absent means the legacy `OPENAI_*` profile is synthesized |
| `PIBOT_MODELS_STORE` | `.pibot/models-store.json` | Last-known-good provider model catalog cache |
| `PIBOT_MODEL` | configured default | Active `provider/model` override; a bare model id uses the configured default provider |
| `PIBOT_MODEL_PROVIDER` | first configured provider | Default provider when `PIBOT_MODEL` is a bare model id |
| `PIBOT_FALLBACK_MODELS` | configured fallbacks or `OPENAI_FALLBACK_MODELS` | Comma-separated `provider/model` fallbacks; each fallback carries its own endpoint, auth and protocol configuration |
| `MODEL_MAX_RETRIES` | `2` | Retries per model before fallback |
| `MODEL_RETRY_BASE_DELAY_MS` | `500` | Initial model retry delay |
| `MODEL_RETRY_MAX_DELAY_MS` | `8000` | Maximum model retry delay |
| `MODEL_CONTEXT_WINDOW_TOKENS` | smallest known configured/catalog window, otherwise `262144` | Context budget shared by selectable models; an explicit value overrides automatic selection |
| `AGENT_MAX_STEPS` | `80` | Maximum Model -> ToolBatch steps for one user turn (`AGENT_MAX_TURNS` remains a legacy fallback) |
| `AGENT_MAX_PARALLEL_TOOL_CALLS` | `8` | Maximum concurrently dispatched parallel-safe tool calls in one step |
| `LONG_TASK_STATUS_UPDATE_MS` | `30000` | Slack status refresh interval for long-running tasks |
| `SESSION_COMPACTION_RESERVE_TOKENS` | `32768` | Buffer reserved for prompt overhead, output and in-run context growth; LLM summary generation uses `floor(0.8 * reserve)` max output tokens |
| `SESSION_COMPACTION_KEEP_RECENT_TOKENS` | `20000` | Approximate recent-history token budget retained after compaction |
| `SESSION_COMPACTION_MAX_OVERFLOW_RETRIES` | `1` | Forced compaction retries after provider context overflow |
| `SESSION_MICROCOMPACT_ENABLED` | `true` | Enable reversible model-surface pruning of stale successful Read/Grep and safe observational Bash results before semantic compaction |
| `SESSION_MICROCOMPACT_PROTECT_RECENT_TOKENS` | `12000` | Recent history tail protected from Microcompact |
| `SESSION_MICROCOMPACT_MIN_RECLAIM_TOKENS` | `512` | Minimum estimated saving for one Microcompact candidate |
| `SESSION_MICROCOMPACT_MAX_ITEMS` | `12` | Maximum Tool Results replaced in one model projection |
| `SESSION_MICROCOMPACT_WARM_CACHE_TTL_MS` | `300000` | Local TTL for treating an observed provider cache hit as warm |
| `TOOL_RESULT_CONTEXT_THRESHOLD_CHARS` | `8192` | Serialized-character threshold for pruning one model-facing Tool Result after the complete raw result is archived |
| `TOOL_RESULT_CONTEXT_HEAD_CHARS` | `4096` | Leading payload characters retained after Tool Result admission pruning |
| `TOOL_RESULT_CONTEXT_TAIL_CHARS` | `1024` | Trailing payload characters retained after Tool Result admission pruning |
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
| `TOOL_APPROVAL_TIMEOUT_MS` | `300000` | Slack tool approval prompt timeout |
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
| `SESSION_MAX_MEMORY_USAGE_FILE_BYTES` | `2000000` | Append-only memory-read usage feedback limit |
| `SESSION_MAX_MEMORY_CURATION_JOB_FILE_BYTES` | `256000` | Per-run durable curation job limit |
| `MEMORY_CURATION_ENABLED` | `true` | Enable best-effort run-end candidate extraction and consolidation |
| `MEMORY_CURATION_MAX_OUTPUT_TOKENS` | `5000` | Output cap for each curation model pass |
| `MEMORY_CURATION_MAX_EVIDENCE_CHARS` | `30000` | Bounded full-run evidence supplied to candidate extraction |
| `MEMORY_CURATION_TIMEOUT_MS` | `60000` | Hard deadline for each extraction or consolidation model request |
| `MEMORY_BACKFILL_TEAM_ID` | `memory-maintenance` | Audit/session team key for manual historical rollout curation |
| `MEMORY_BACKFILL_CHANNEL_ID` | `historical-backfill` | Audit/session channel key for manual historical rollout curation |
| `SKILLS_DISABLED` | empty | Comma-separated workspace Skill names to exclude |
| `SKILLS_MAX_COUNT` | `100` | Maximum Skill entries injected into the prompt index |
| `SKILLS_MAX_FILE_BYTES` | `64000` | Maximum size of each `SKILL.md` file |
| `REFLECTION_ENABLED` | `false` | Enable post-run verify/critique/fix reflection |
| `REFLECTION_MAX_FIX_ATTEMPTS` | `2` | Maximum automatic reflection fix attempts |
| `REFLECTION_MAX_STEPS` | `AGENT_MAX_STEPS` | Maximum steps for a reflection pass (legacy `REFLECTION_MAX_TURNS` remains a fallback) |
| `REFLECTION_VERIFY_COMMANDS` | empty | Comma-separated verification commands for reflection |
| `PIBOT_TMUX_PATH` | `tmux` | tmux binary used by child-agent supervisor |
| `PIBOT_TMUX_SOCKET_PATH` | empty | Optional isolated tmux socket path |
| `PIBOT_CHILD_AGENT_COMMAND` | `node dist/child-agent.js` | Child-agent command template |
| `CHILD_AGENT_MAX_CONCURRENT` | `20` | Maximum active child agents per parent run |
| `CHILD_AGENT_DEFAULT_TIMEOUT_MS` | `900000` | Default child-agent timeout |
| `CHILD_AGENT_MAX_TIMEOUT_MS` | `1800000` | Maximum child-agent timeout |
| `CHILD_AGENT_MAX_TOOL_CALLS` | `40` | Default child-agent tool-call budget |
| `CHILD_AGENT_MAX_TOKENS` | `120000` | Default child-agent output/token budget passed to the model |
| `CHILD_AGENT_MAX_STEPS` | child tool-call budget | Maximum Model -> ToolBatch steps for a built-in child agent (`CHILD_AGENT_MAX_TURNS` remains a legacy fallback) |
| `CHILD_AGENT_CAPTURE_LINES` | `120` | Default tmux pane tail lines captured |
| `CHILD_AGENT_CAPTURE_MAX_CHARS` | `20000` | Default tmux capture character limit |
| `CHILD_AGENT_TOOL_APPROVAL_MODE` | inherited | Optional approval mode override for built-in child agents |
| `CHILD_AGENT_TOOL_APPROVAL_TIMEOUT_MS` | `TOOL_APPROVAL_TIMEOUT_MS` | Child-agent tool approval timeout |
| `CHILD_AGENT_ALLOW_BASH` | `false` | Allow bash for read-only child agents when no approval bridge is available |

### Multi-provider model runtime

When `.pibot/models.json` (or `PIBOT_MODELS_CONFIG`) is absent, PIBot creates a
backward-compatible `openai` profile from the existing `OPENAI_*` variables.
For multiple providers, start from `docs/models.example.json`. Provider config
owns protocol, endpoint, credential environment variable, headers, default
model, catalog discovery, and request compatibility. A model entry may override
the protocol, endpoint, headers, developer-role mode, context window, output
limit, pricing, and request fields such as usage streaming, temperature support,
the max-token field, and extra JSON body values. Header secrets use
`{ "env": "VARIABLE_NAME" }`; resolved secrets are never persisted in the
catalog store or returned by the WebUI API.

Supported protocol adapters:

- `openai-chat-completions`: OpenAI-compatible streaming chat, tools, image URL
  input, reasoning deltas, and usage.
- `anthropic-messages`: native Anthropic message/tool content blocks and
  streaming text, thinking, tool-use, and usage events. Anthropic has no
  `developer` message role, so its profile must explicitly select
  `developerRoleMode: "system-fallback"`; model-start events and traces record
  this authority downgrade. Thinking deltas are displayed but are not replayed
  as assistant thinking blocks because Anthropic requires provider-issued
  signatures that PIBot does not persist. A completed `tool_use` block is handed
  to the bounded scheduler immediately instead of waiting for `message_stop`.

The WebUI model selector changes the process-wide default without restarting.
Each Run captures its complete `provider/model` at the start, so a later UI
selection cannot change the model halfway through that Run. Fallback entries
are also complete references and may cross providers or protocols.

Model discovery is opt-in per provider through `catalog.type = "models-api"`
(`"openai-models"` remains a compatibility alias). It accepts common `data[]`,
`models[]`, or array responses and
deliberately treats discovery as identity/name data. Capability, context, and
pricing metadata remain curated model overrides. A discovered ID therefore has
`unknown` status until configuration supplies the compatibility metadata; its
presence in `/models` alone does not prove that it supports PIBot's chat/tool
request shape.

The checked-in example is a dated configuration starting point, not an account
availability guarantee. It was refreshed on 2026-08-29; use `models:check` for
the credentials and endpoint used by the running PIBot.

```bash
npm run models:list
npm run models:check       # read-only; exits 2 when live data differs
npm run models:diff        # read-only live-vs-local differences
npm run models:sync        # atomically activates the checked cache
```

Checks use ETag and Last-Modified when available. Provider failures are isolated.
Sync records the failure while preserving that provider's previous models, so a
timeout cannot erase the other providers or make startup depend on the network.

Session compaction runs before model steps when the estimated full request exceeds
`MODEL_CONTEXT_WINDOW_TOKENS - SESSION_COMPACTION_RESERVE_TOKENS`. The lightweight
estimate includes system/runtime messages, history, reasoning fields, tool calls,
tool schemas and a conservative image allowance. Slack and Web runs persist
completed in-run messages before this check, so a refreshed projection does not
lose the current tool-call/result sequence. The compactor preserves the current
user turn, keeps complete messages up to the recent-history budget, and keeps tool
calls paired with their tool results. It asks
the configured model for a structured summary and falls back to a heuristic
summary if that call fails. Provider context overflow triggers one forced
compaction and automatic retry by default.

`ContextManager` is the model-surface boundary for durable channel history. It
selects the latest checkpoint plus uncovered records, applies per-run user-message
exclusion or replacement, and repairs tool-call ordering without rewriting
`context.jsonl`. It also owns named model-only lanes with explicit `authority`,
`kind`, and `placement`, plus final-request token estimation. Compaction records
remain append-only and include both the rendered checkpoint and machine-readable
`summaryFacts`, so a later heuristic fallback can inherit facts from an earlier
LLM checkpoint.

Prompt assembly separates cache placement from model authority. Ordered Tool
schemas plus the leading `system` and `developer` messages form the stable
prefix. Durable history and model-only reference lanes remain in the middle;
refreshable state and Steering form an append-only dynamic tail. History
replacement preserves every declared lane placement and never inserts context
between an assistant Tool Call and its Tool Result.

| Context source | Model role | Kind | Placement |
|---|---|---|---|
| PIBot identity, sandbox and authority boundaries | `system` | instruction | stable prefix |
| Tools, operating guidelines and runtime policy | `developer` | instruction | stable prefix |
| Persistent Memory synthesized from prior runs | `assistant` | reference | before current user |
| Workspace/legacy Skill metadata | `user` | reference | before current user |
| Global and channel user instructions | `user` | instruction | before current user |
| Compaction Summary | `assistant` | reference | durable history |
| Covered historical user wording | `user` | instruction | durable history, verbatim |
| Trusted PIBot Skill index, repo/run snapshot and World State | `developer` | instruction/state | dynamic tail |
| Working Set and current file snapshots | `user` | reference | before current user |
| In-run Steering | `user` | instruction | dynamic tail |

The wire-level `AgentRole` includes `developer`. OpenAI-compatible requests send
that role unchanged in `native` mode. Compatibility fallback is never inferred:
an endpoint that rejects `developer` must be configured with
`OPENAI_DEVELOPER_ROLE_MODE=system-fallback`. Model-start events and traces expose
`developerRoleMode` and `authorityDegraded`; `model.started` additionally records
per-role message counts. The repository's Kimi `.env.example` selects this
fallback explicitly because that endpoint documents only `system`, `user`, and
`assistant` input roles.

After a checkpoint covers older history, `ContextManager` inserts an
`[pibot-context:exact-user-intent]` developer header immediately after the
assistant-authored Summary and then replays every covered, non-compaction user
message with its original `user` role and verbatim content. The uncovered recent
tail remains after this protected lane, so an old request is not mistaken for the
newest request. These messages are loaded from the append-only durable log rather
than reconstructed from `summaryFacts`.

Checkpoint coverage advances only through newly covered non-checkpoint records;
the later physical JSONL line number of a Summary is never used to hide an older
uncovered recent tail. Active projection includes only the newest checkpoint and
filters earlier checkpoint records.

Every context message carries an initial durable lifecycle state. Ordinary
messages start as `Active`; safely repeatable archived Read, Skill-read and Grep
results start as `Regenerable`. Microcompact appends a `context_lifecycle` record
that moves selected Tool Results to `Pruned`, without changing their original
message or blob. A later projection may append a transition back to
`Regenerable`. Full Compact appends `Stale` transitions for covered source lines.
Lifecycle changes are batched append-only records in `context.jsonl`, so current
state is replayable without rewriting earlier records.

Before semantic compaction, Microcompact can replace old, successful and safely
recoverable Read, Grep, Skill-read, or observational Bash results on the model
surface with a small locator/metadata result. It does not rewrite the result
already stored in `context.jsonl`, does not compact failed results or mutating
shell commands, protects the current user turn and recent tail, and retains the
original `toolCallId` so Provider ordering remains valid. This is reversible
projection, not a second durable summary.

Prompt-cache state is a cost input to that decision rather than a compression
mechanism. Provider usage (`cachedInputTokens / inputTokens`) and its observation
age select one of these policies:

- `warm_conservative`: while a recent cache hit is within TTL, preserve more of
  the prefix and require a good reclaim-to-invalidated-suffix ratio.
- `cold`: no observed hit, a zero hit, or TTL expiry; preferentially clean older
  eligible Tool Results because there is no warm suffix to protect.

If pressure remains after Microcompact, semantic Full Compact appends a Summary +
Working Set checkpoint. Every successful Full Compact advances the local cache
epoch and clears its warm observation, so the first request in the new epoch is
treated as cold and then establishes a new reusable prefix. Slack traces record
`session.microcompacted` with cache state, epoch, protected-prefix and invalidated-
suffix estimates; `session.compacted` records protected-user-intent token estimates
and marks `promptCacheEpochBoundary=true`.

Full Compact summaries are recursive checkpoint nodes. Each version-2 Summary
record stores `summaryHierarchy` with its level, parent Summary line numbers and
source Summary/message counts. The first checkpoint is level 1; compacting a
parent checkpoint plus newer source regions creates the next level. LLM
compaction is instructed to merge parent checkpoint facts with the new delta,
and heuristic fallback performs the same durable-fact merge. Old transcripts are
not expanded again merely to build a newer Summary.

Verbatim user intent is deliberately not a compaction target. If that protected
lane itself dominates the model window and there are no newly coverable
assistant/tool records, threshold compaction returns without writing another
equivalent Summary. A forced provider-overflow recovery may still make its single
configured retry, but pibot does not silently summarize or truncate the protected
user wording. Extremely long-lived sessions can therefore require an explicit
future archive policy or a larger model window.

Compaction source selection operates on complete message/tool-call regions instead
of deleting an arbitrary middle character range. Oversized individual message or
tool-result fields retain bounded head and tail text with an explicit durable-line
marker. Checkpoints separately retain exact user constraint segments, current
work, pending tasks, failed approaches, errors and fixes, code state, and
verification state. Existing version-1 context records without `summaryFacts`
remain readable through the rendered-summary compatibility parser.

`RuntimeModeHook` refreshes a `[pibot-context:world-state]` developer/state lane
at the dynamic tail for every model step. The lane contains the frozen step/mode
identity, model name, current
plan metadata, coordinator goal, a bounded live `tasks.json` projection, cwd,
live git root/branch/dirty files, sandbox label, approval policy and pending
count, MCP capability/configuration, and bounded child-agent status counts and
active details. pibot currently has no MCP client registry, so World State says
`supported=false` and reports an empty server list instead of implying hidden
connectivity. A newer projection replaces the previous lane on the model surface;
it is not appended to durable conversation history. Environment lookup failures
become bounded `available=false` facts and do not abort the Step.
Request-budget fields are recorded on `model.started` traces, while
`session.compacted` traces distinguish history tokens from non-history request
overhead.

After a checkpoint becomes active, `WorkingSetHook` uses its modified/read file
lists to rehydrate a bounded `user`/reference lane immediately before the current
user message. It is explicitly marked as untrusted reference data. Modified files are
preferred over read-only files; current filesystem content is loaded with
workspace and symlink boundary checks, cached by size/mtime, and represented as
full text or bounded head/tail text with a reread locator. Missing, binary and
out-of-workspace candidates are reported without aborting the model step;
protected runtime and credential paths use the same denial policy as file tools. Exact
constraints, current work, code state and verification state stay beside these
current file snapshots.

Every Slack, WebUI and built-in child-agent Tool Result is archived before it is
serialized into a model-visible tool message. The exact executor result plus tool
name/input is written with mode `0600` under the channel or child-run
`tool-results/` directory. The admitted Tool Result carries a store-relative
artifact locator, SHA-256, byte count and regenerability flag. Microcompact keeps
that artifact reference in its small replacement, so pruning context does not
remove the durable result blob. Existing tool-level safety/output limits still
bound what the executor itself may produce; the archive is the complete result at
the model-admission boundary, not an unbounded capture of discarded process I/O.

Usage pricing can be overridden with `USAGE_COST_CURRENCY`,
`USAGE_INPUT_COST_PER_1M_TOKENS`,
`USAGE_CACHED_INPUT_COST_PER_1M_TOKENS` and
`USAGE_OUTPUT_COST_PER_1M_TOKENS`. If no provider usage is returned, pibot
records an estimated usage entry. Provider-reported records additionally persist
`cacheHitRatio` and `cacheSavings`; per-Step trace events include uncached-input,
cached-input and output cost components when pricing is configured. Slack, the
embedded WebUI and the standalone WebUI all attach the same trace hook. The
metrics report therefore exposes both per-run Slack usage and per-model-call
Provider usage across traced agent surfaces.

Run a controlled real Provider cache experiment with a frozen system prefix and
append-only conversation tail:

```bash
OPENAI_API_KEY=... OPENAI_MODEL=... npm run measure:provider-cache
```

The command requires Provider usage metadata and writes
`.pibot/measurements/provider-cache-latest.json`. `PIBOT_CACHE_BENCHMARK_TURNS`,
`PIBOT_CACHE_BENCHMARK_STABLE_CHARS`, `PIBOT_CACHE_BENCHMARK_TAIL_CHARS` and
`PIBOT_CACHE_BENCHMARK_OUTPUT` control the experiment. To aggregate real
long-session usage, cache savings, Full Compact and Microcompact counts already
recorded by a running deployment, use:

```bash
PIBOT_STORE_ROOT=.pibot npm run report:context-metrics
```

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
│   ├── curation_jobs/<run>.json
│   ├── audit.jsonl
│   └── usage.jsonl
└── channels/<team>/<channel>/
    └── instructions.md
```

`instructions.md` is user-managed configuration. The compact
`memory_summary.md` and short `MEMORY.md` indexes are injected into the system
prompt. Detailed topics, rollout summaries, and extension notes are loaded only
when needed with `memory_read`. Before a final answer on non-trivial work, the
shared system prompt asks the model to review whether the run produced durable
memory candidates. After the rollout summary is persisted, an asynchronous,
best-effort curation pipeline examines fuller run messages and tool evidence:

```text
run evidence -> typed extension_note candidate -> consolidation
                                         |-- no-op / needs review
                                         `-- accepted semantic Task Group
                                                   -> MEMORY.md + memory_summary.md

memory_read -> run-scoped outcome feedback -> lifecycle decision
                                            |-- weak evidence -> review note
                                            `-- active / stale / superseded
                                                      -> rebuild compact routing
```

Run completion first persists a bounded job under `curation_jobs/`, then starts
curation without making the user-facing run wait for model extraction. Each
model pass has a hard deadline. A timeout, provider error, or process restart
leaves the job durable; Slack and WebUI startup recover pending jobs. A
successful terminal no-op, review, rejection, or consolidation records
`run_completed` in the audit before deleting the job.

The extractor cannot mutate accepted topics directly. Low-risk candidates go
through a separate consolidation model pass that compares existing accepted
knowledge, merges duplicates, preserves provenance, and refuses unresolved
conflicts. Preferences, uncertain claims, sensitive content, and risky merges
remain `needs_review` extension notes. Evidence, candidates, and accepted
knowledge are separate runtime states. One run may stage up to five candidates
when its evidence genuinely spans separate semantic Task Groups; candidates are
not split merely to create one note per task or crammed into a project-wide
catch-all topic.

Memory is meant to be reusable operational knowledge, not a transcript archive.
Good candidates include stable user preferences, repo-specific source-of-truth
paths, runtime entrypoints, validated workflows or commands, recurring failure
modes, architectural decisions, and completed-task outcome summaries that make a
future run cheaper or safer. A useful accepted topic is a semantic Task Group
rather than a per-run note. It stores scope/applicability, keywords, reuse rules,
conditional preferences, reusable claims, negative failure lessons,
verification boundaries, historical state, and claim-level source runs.
Verification is dimensional: source review, focused tests, builds, real browser
use, live Provider behavior, deployment, and production observation are not
interchangeable. Evidence-bearing claims also retain a source-derived last
validation timestamp instead of trusting a model-invented date.
Historical state, preferences, and verification metadata are supporting
context; a newly accepted Task Group must still contain reusable knowledge or a
negative failure lesson. This prevents a checkout/config snapshot from becoming
the body of always-routed long-term memory.

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
append-only audit log. Successful explicit `memory_read` calls append run,
user-turn, step, tool-call, topic and timestamp data to `usage.jsonl`. That
feedback reorders compact routing toward important and frequently used topics.
Run-end extraction can additionally classify a topic read during that same run
as `helpful`, `validated`, `not_applicable`, `contradicted`, or `superseded`.
Outcome feedback records an `observed`, `accepted`, or `needs_review`
disposition; accepted/helpful outcomes influence routing ahead of raw read
counts.

Retrieval is not validation. `contradicted`, `superseded`, and reactivation
proposals require a separate lifecycle model pass plus a concrete current-run
dimension such as source inspection, focused/integration testing, runtime,
browser, Provider, deployment, or production observation. Accepted transitions
are stored in the Task Group lifecycle as `active`, `stale`, `superseded`, or
`archived`. Only active groups enter `MEMORY.md` and `memory_summary.md`; other
groups remain readable with their evidence and provenance. Weak evidence becomes
a `needs_review` extension note. Low usage alone never deletes or marks a topic
stale. The legacy `.pibot/MEMORY.md` and `.pibot/memory/` layout
is still readable as a compatibility fallback, but new writes use
`.pibot/memories/`.

Historical rollout summaries can be curated explicitly in bounded batches:

```bash
npm run memory:backfill -- --limit 10
```

The command recovers pending jobs first, scans newest summaries first, and uses
the audit log to skip completed runs on later invocations. `--limit` counts only
newly enqueued runs and accepts `1` through `100`; add `--json` for structured
counts. Backfilled summaries are labelled
`historical_rollout_recap_only`: they provide provenance and routing context,
not raw trace, diff, tool, browser, Provider, deployment, or production proof.
Use `MEMORY_BACKFILL_TEAM_ID` and `MEMORY_BACKFILL_CHANNEL_ID` only when a
distinct maintenance session key is needed.

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
validates the task DAG and asks the user to approve the plan path, graph version,
task digest, task count and write-capable task count. Approval freezes both the
plan digest and `tasks.json` specification before returning to Execute Mode.
Agent Mode remains a separate dynamic capability ceiling: call-time requirements
are checked before approval and again immediately before a grant is issued.

The Plan-and-Execute task store keeps a versioned graph specification plus its
runtime projection in `tasks.json`. Each task declares stable ids, dependencies
and a child execution policy (`role`, `readOnly`, and optional budgets). After
freeze, `TaskGraphScheduler` maps tasks to durable Workflow Steps and each child
run to a Workflow Attempt. Runtime code computes ready tasks, dispatches all
available independent work up to the child concurrency limit, consumes terminal
status-file events, persists results and attempts, then unlocks dependents. The
model may inspect this state with `tasks_read`, but `task_update` cannot advance a
frozen graph. Bounded completed results and blocked-task failure summaries are
also projected into the next Parent model step through World State, so the
Parent does not have to call `agent_collect`. While a frozen graph is active,
the runtime places an explicit completion hold on the Parent Run. When the graph
reaches `succeeded` or `blocked`, the scheduler queues one runtime-generated
follow-up, releases the hold, and starts a new UserTurn under the same Run and
runtime state. The follow-up is persisted with `runtime` provenance rather than
being represented as a new human instruction. A failed Parent turn or explicit
Run cancellation still wins over the hold. Parent Run resurrection after a
whole pibot process restart is not provided; durable workflow recovery resumes
the child graph, and the next transport Run observes its state.

Failed child attempts pass through `WorkflowOrchestrator` attempt, edge and
circuit budgets. Mechanically retryable failures reuse the frozen task strategy;
when the graph itself must change, the coordinator re-enters Plan Mode and writes
an explicitly reasoned version. Runtime-completed tasks whose specification is
unchanged are carried into the new draft; model-supplied status fields cannot
claim completion. Once a newer draft exists, the previous workflow is marked
superseded and cannot dispatch newly unlocked children.

When `REFLECTION_ENABLED=true`, a completed Execute Mode run starts a bounded
verification pass. Reflection asks the model to verify, critique, fix when
needed, verify again, and end with a status marker. It stops after
`REFLECTION_MAX_FIX_ATTEMPTS` and reports remaining risk instead of looping.

## tmux Child Agents

Coordinator Mode uses tmux windows and independent child-agent processes for
transparent multi-agent work. The default child command is the built-in
`node dist/child-agent.js`, and `PIBOT_CHILD_AGENT_COMMAND` can override it.

Child completion is event-driven for both approved TaskGraphs and direct
Coordinator `agent_spawn` calls. Each direct call becomes a detached Workflow
with one child Step and one or more bounded Attempts. The runtime watches the
durable child `status.json`, rechecks it after watcher registration to close the
startup race, persists the terminal result in the Workflow event log, and queues
a runtime-generated UserTurn in the same Parent Run. The Parent therefore does
not poll `agent_collect`; that tool remains available for explicit diagnostics.
Failed attempts pass through the shared attempt, edge and circuit budgets before
the Parent receives a blocked event. `agent_stop` cancels the owning Workflow so
an intentional stop cannot trigger a mechanical retry.

The in-process Parent Run has one completion hold per scheduled direct child, so
children may finish independently and each accepted completion event resumes the
same Run with its existing context and runtime state. Runtime follow-ups reserve
queue entry capacity from ordinary user follow-ups, while still honoring the
mailbox byte limit. On process restart, the attempt-to-child binding and status
file remain sufficient to recover durable Workflow/child state, but the previous
process-local Parent Run itself is not resurrected automatically.

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
`runId`, `userTurnId`, `stepId`, optional `parentRunId`, and `agentId`, and cover model calls, token
usage, cost, retries, tool arguments, tool results, duration, approval decisions,
interception reasons, explicit runtime transitions, and final run status.

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
