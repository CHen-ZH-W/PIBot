export const WEBUI_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>PIBot</title>
    <link rel="stylesheet" href="/assets/app.css">
  </head>
  <body>
    <div id="app"></div>
    <script src="/assets/app.js"></script>
  </body>
</html>
`;

export const WEBUI_CSS = `
:root {
  color-scheme: dark;
  --bg: #111111;
  --panel: #171717;
  --panel-2: #1d1d1d;
  --line: #303030;
  --line-soft: #252525;
  --text: #eeeeee;
  --muted: #a3a3a3;
  --dim: #737373;
  --accent: #d97706;
  --accent-2: #f59e0b;
  --danger: #ef4444;
  --ok: #22c55e;
  --warn: #eab308;
  --focus: #60a5fa;
  --app-header-height: 50px;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* {
  box-sizing: border-box;
}

html,
body,
#app {
  width: 100%;
  height: 100%;
  margin: 0;
}

body {
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
  font-size: 14px;
}

button,
input,
textarea,
select {
  font: inherit;
}

button {
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--text);
  border-radius: 6px;
  min-height: 32px;
  padding: 0 10px;
  cursor: pointer;
}

button:hover {
  border-color: var(--accent);
}

button.pending {
  border-color: var(--focus);
}

button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #111111;
  font-weight: 650;
}

button.danger {
  border-color: rgba(239, 68, 68, 0.5);
  color: #fecaca;
}

button.ghost {
  background: transparent;
}

.btn-icon {
  padding: 0 8px;
  min-width: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.refresh-icon {
  display: inline-block;
  font-size: 18px;
  line-height: 1;
}

button.pending .refresh-icon {
  animation: spin 0.8s linear infinite;
}

input,
textarea,
select {
  width: 100%;
  border: 1px solid var(--line);
  background: #101010;
  color: var(--text);
  border-radius: 6px;
  padding: 8px 10px;
  outline: none;
}

textarea {
  resize: vertical;
  min-height: 96px;
  line-height: 1.45;
}

input:focus,
textarea:focus,
select:focus {
  border-color: var(--focus);
}

.checkbox-line {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 13px;
}

.checkbox-line input {
  width: auto;
}

.shell {
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr) 360px;
  height: 100%;
  min-width: 0;
}

.shell.sessions-shell {
  grid-template-columns: 248px minmax(0, 1fr);
}

.shell.sessions-shell .inspector {
  display: none;
}

.shell.evolution-focus-shell {
  grid-template-columns: 248px minmax(0, 1fr);
}

.shell.evolution-focus-shell .inspector {
  display: none;
}

.shell.skills-shell {
  grid-template-columns: 248px minmax(0, 1fr);
}

.shell.skills-shell .inspector {
  display: none;
}

.sidebar,
.main,
.inspector {
  min-height: 0;
  overflow: hidden;
}

.sidebar {
  border-right: 1px solid var(--line);
  background: #141414;
  display: flex;
  flex-direction: column;
}

.brand,
.topbar {
  height: var(--app-header-height);
  min-height: var(--app-header-height);
  flex: 0 0 var(--app-header-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px;
  border-bottom: 1px solid var(--line);
  background: #141414;
}

.brand strong {
  font-size: 15px;
}

.session-rail {
  min-height: 0;
  display: flex;
  flex: 1;
  flex-direction: column;
  padding: 10px;
}

.session-header {
  min-height: 34px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: var(--muted);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0;
}

.icon-button {
  width: 28px;
  height: 28px;
  min-height: 28px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  line-height: 1;
}

.session-list {
  min-height: 0;
  overflow: auto;
  display: grid;
  align-content: start;
  gap: 4px;
  padding-top: 4px;
}

.session-item {
  width: 100%;
  min-height: 34px;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 3px 4px 3px 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  overflow: hidden;
}

.session-item:hover,
.session-item.active {
  background: #202020;
  border-color: var(--line);
}

.session-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-delete {
  width: 24px;
  height: 24px;
  min-height: 24px;
  padding: 0;
  border-color: transparent;
  background: transparent;
  color: var(--dim);
}

.session-delete:hover {
  color: #fecaca;
  border-color: rgba(239, 68, 68, 0.45);
}

.ticket-row .session-delete {
  margin-left: auto;
  flex: 0 0 24px;
}

.item-toolbar {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}

.item.runtime-version-item {
  position: relative;
}

.item.runtime-version-item .session-delete {
  position: absolute;
  top: 6px;
  right: 6px;
}

.item.runtime-version-item .item-title {
  padding-right: 26px;
}

.sidebar-bottom {
  padding: 10px;
  border-top: 1px solid var(--line-soft);
}

.evolution-entry {
  width: 100%;
  text-align: left;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 20px;
  padding: 6px 14px;
  margin-bottom: 4px;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.06),
    0 1px 3px rgba(0, 0, 0, 0.3);
  transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
}

.evolution-entry:last-child {
  margin-bottom: 0;
}

.evolution-entry.active {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.15);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.1),
    0 2px 6px rgba(0, 0, 0, 0.35);
}

.count {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.item {
  width: 100%;
  display: grid;
  gap: 3px;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 8px;
  cursor: pointer;
}

.item:hover,
.item.active {
  background: #202020;
  border-color: var(--line);
}

.item-title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-meta {
  display: flex;
  gap: 6px;
  color: var(--dim);
  font-size: 12px;
  overflow: hidden;
}

.ticket-row .item-meta {
  flex-wrap: nowrap;
  align-items: center;
}

.main {
  display: flex;
  flex-direction: column;
}

.topbar-left {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  flex: 1;
}

.topbar h1 {
  margin: 0;
  font-size: 15px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
}

.content {
  min-height: 0;
  overflow: auto;
  padding: 16px;
}

.main > .content {
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.main > .ticket-workspace-content {
  display: block;
  overflow-x: hidden;
  overflow-y: auto;
}

.split {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 16px;
  align-items: stretch;
  min-height: 0;
  overflow: hidden;
  flex: 1;
}

.ticket-workspace {
  align-items: start;
  flex: 0 0 auto;
  min-height: auto;
  overflow: visible;
}

.ticket-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.ticket-workspace .ticket-panel {
  max-height: calc(100dvh - 82px);
  position: sticky;
  top: 0;
}

.ticket-panel .panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.stack {
  display: grid;
  gap: 16px;
  overflow-y: auto;
  min-height: 0;
}

.ticket-workspace .stack {
  min-height: auto;
  overflow: visible;
}

.evolution-page {
  display: grid;
  gap: 16px;
  max-width: 980px;
  margin: 0 auto;
}

.evolution-page.wide {
  max-width: 1120px;
}

.evolution-context-page .messages {
  max-height: none;
  overflow: visible;
}

.panel {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  overflow: hidden;
}

.main .content > .panel {
  min-height: 0;
  display: flex;
  flex-direction: column;
  flex: 1;
}

.main .content > .panel > .panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.main .content > .panel > .panel-header {
  flex-shrink: 0;
}

.panel-header {
  min-height: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 12px;
  border-bottom: 1px solid var(--line);
}

.panel-title {
  font-weight: 650;
}

.panel-header .panel-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.panel-body {
  padding: 12px;
  display: grid;
  gap: 12px;
}

.ticket-list {
  display: grid;
  gap: 8px;
}

.skills-list {
  display: grid;
  gap: 8px;
}

.skill-row {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel-2);
  color: var(--text);
  text-align: left;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow: hidden;
  min-width: 0;
}

.skill-row .skill-title {
  font-weight: 650;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.skill-row .item-meta {
  flex-wrap: nowrap;
  align-items: center;
  min-width: 0;
}

.skill-row .skill-location {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-row .skill-description {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  min-width: 0;
}

.ticket-row {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel-2);
  color: var(--text);
  text-align: left;
  height: 80px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  cursor: pointer;
  overflow: hidden;
}

.ticket-row:hover,
.ticket-row.active {
  background: #202020;
  border-color: var(--accent);
}

.ticket-row .line {
  display: flex;
  gap: 8px;
  justify-content: space-between;
  align-items: flex-start;
  min-width: 0;
  flex: 0 0 38px;
}

.ticket-row .line strong {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  flex: 1 1 auto;
  min-width: 0;
  max-height: 38px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 19px;
}

.badge {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 7px;
  border-radius: 999px;
  border: 1px solid var(--line);
  color: var(--muted);
  background: #141414;
  font-size: 12px;
  white-space: nowrap;
  flex-shrink: 0;
}

.badge.ok {
  color: #bbf7d0;
  border-color: rgba(34, 197, 94, 0.45);
}

.badge.warn {
  color: #fef08a;
  border-color: rgba(234, 179, 8, 0.45);
}

.badge.danger {
  color: #fecaca;
  border-color: rgba(239, 68, 68, 0.5);
}

.form-grid {
  display: grid;
  gap: 10px;
}

.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.field label {
  display: block;
  color: var(--muted);
  font-size: 12px;
  margin-bottom: 5px;
}

.file-picker {
  display: flex;
  align-items: center;
  gap: 8px;
}

.file-picker input[type="file"] {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.file-picker-btn {
  flex-shrink: 0;
}

.file-picker-label {
  color: var(--dim);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.timeline {
  display: grid;
  gap: 8px;
}

.timeline-row {
  border-left: 2px solid var(--line);
  padding-left: 10px;
  color: var(--muted);
}

.timeline-row strong {
  color: var(--text);
}

.action-status {
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid rgba(96, 165, 250, 0.35);
  border-radius: 6px;
  color: #bfdbfe;
  background: rgba(96, 165, 250, 0.08);
  font-size: 13px;
}

.action-status.warn {
  border-color: rgba(234, 179, 8, 0.35);
  color: #fef08a;
  background: rgba(234, 179, 8, 0.08);
}

.action-status.danger {
  border-color: rgba(239, 68, 68, 0.4);
  color: #fecaca;
  background: rgba(239, 68, 68, 0.08);
}

.action-error {
  flex: 0 0 auto;
  margin-bottom: 12px;
}

.action-error span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.action-error button {
  margin-left: auto;
  flex: 0 0 auto;
}

.spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(191, 219, 254, 0.35);
  border-top-color: #bfdbfe;
  border-radius: 999px;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.codebox {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow: auto;
  max-height: 280px;
  border: 1px solid var(--line);
  background: #101010;
  border-radius: 6px;
  padding: 10px;
}

.inspector {
  border-left: 1px solid var(--line);
  background: #141414;
  display: flex;
  flex-direction: column;
}

.inspector .content {
  padding: 12px;
}

.kv {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 8px;
  font-size: 13px;
}

.kv span:first-child {
  color: var(--dim);
}

.kv span:last-child {
  min-width: 0;
  overflow-wrap: anywhere;
}

.messages {
  display: grid;
  gap: 10px;
}

.evolution-context .messages {
  max-height: 280px;
  overflow: auto;
}

.message {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px;
  background: var(--panel);
  overflow: hidden;
  contain: paint;
}

.message.user {
  border-color: rgba(217, 119, 6, 0.45);
}

.message.live {
  border-color: rgba(96, 165, 250, 0.45);
}

.message-role {
  color: var(--dim);
  font-size: 12px;
  margin-bottom: 6px;
}

.live-status {
  margin-top: 8px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.45;
}

.run-blocks {
  display: grid;
  gap: 8px;
}

.assistant-text-block {
  line-height: 1.5;
}

.assistant-text-block p {
  margin: 0 0 8px;
}

.assistant-text-block p:last-child {
  margin-bottom: 0;
}

.assistant-text-block .md-heading {
  margin: 10px 0 6px;
  color: var(--text);
  font-weight: 700;
  line-height: 1.25;
}

.assistant-text-block .md-heading:first-child {
  margin-top: 0;
}

.assistant-text-block .md-heading-1 {
  font-size: 22px;
}

.assistant-text-block .md-heading-2 {
  font-size: 18px;
}

.assistant-text-block .md-heading-3,
.assistant-text-block .md-heading-4,
.assistant-text-block .md-heading-5,
.assistant-text-block .md-heading-6 {
  font-size: 15px;
}

.assistant-text-block .md-table-wrapper {
  max-width: 100%;
  overflow: auto;
  margin: 8px 0;
  border: 1px solid var(--line);
  border-radius: 6px;
}

.assistant-text-block .md-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  min-width: 360px;
}

.assistant-text-block .md-table th,
.assistant-text-block .md-table td {
  padding: 7px 9px;
  border-right: 1px solid var(--line-soft);
  border-bottom: 1px solid var(--line-soft);
  text-align: left;
  vertical-align: top;
}

.assistant-text-block .md-table th:last-child,
.assistant-text-block .md-table td:last-child {
  border-right: none;
}

.assistant-text-block .md-table tbody tr:last-child td {
  border-bottom: none;
}

.assistant-text-block .md-table th {
  background: #202020;
  color: var(--text);
  font-weight: 650;
}

.assistant-text-block .md-table tbody tr:nth-child(even) {
  background: #1a1a1a;
}

.assistant-text-block .md-codeblock,
.assistant-text-block .md-pre {
  margin: 8px 0;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #121212;
  overflow: auto;
}

.assistant-text-block .md-code-lang {
  padding: 5px 10px;
  border-bottom: 1px solid var(--line-soft);
  color: var(--dim);
  font-size: 11px;
  text-transform: uppercase;
}

.assistant-text-block .md-codeblock pre,
.assistant-text-block .md-pre {
  padding: 10px;
}

.assistant-text-block .md-codeblock pre,
.assistant-text-block .md-pre,
.assistant-text-block .md-codeblock code,
.assistant-text-block .md-pre code,
.assistant-text-block .md-inline-code {
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
}

.assistant-text-block .md-codeblock pre {
  margin: 0;
}

.assistant-text-block .md-codeblock code,
.assistant-text-block .md-pre code {
  display: block;
  color: #e5e5e5;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre;
}

.assistant-text-block .md-inline-code {
  padding: 1px 4px;
  border-radius: 4px;
  background: #242424;
  color: #f5f5f5;
  font-size: 0.92em;
}

.assistant-text-block .md-list {
  margin: 6px 0 8px 20px;
  padding: 0;
}

.assistant-text-block .md-list li {
  margin: 3px 0;
}

.assistant-text-block .md-blockquote {
  margin: 8px 0;
  padding: 6px 10px;
  border-left: 3px solid var(--line);
  color: var(--muted);
  background: #191919;
}

.assistant-text-block .md-hr {
  border: none;
  border-top: 1px solid var(--line);
  margin: 10px 0;
}

.tool-stream {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 4px 0;
}

.tool-chip {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 1px 6px;
  border-radius: 3px;
  background: #1e1e1e;
  border: 1px solid #2a2a2a;
  font-size: 11px;
  color: var(--dim);
  word-break: break-all;
}

.tool-chip.done {
  color: var(--muted);
  border-color: #333;
}

.tool-chip.error {
  color: var(--danger);
  border-color: rgba(239,68,68,0.3);
}

.approval-list {
  display: grid;
  gap: 8px;
  margin: 6px 0 8px;
}

.approval-request {
  border: 1px solid rgba(234, 179, 8, 0.45);
  border-radius: 6px;
  background: #181610;
  padding: 8px;
  display: grid;
  gap: 6px;
}

.approval-request.resolved {
  border-color: var(--line);
  background: #171717;
}

.approval-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}

.approval-title {
  font-weight: 650;
}

.approval-summary,
.approval-details {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.45;
}

.approval-details {
  display: grid;
  gap: 2px;
}

.empty {
  color: var(--dim);
  padding: 18px 0;
}

.reasoning {
  margin-bottom: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: #1a1a1a;
  border-left: 3px solid var(--accent);
  overflow: hidden;
  contain: paint;
}

.reasoning summary {
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
}

.reasoning .reasoning-body {
  margin-top: 6px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.45;
  max-height: 180px;
  overflow: auto;
}

.reasoning:not([open]) .reasoning-body {
  display: none;
}

.reasoning-stream {
  color: var(--accent-2);
  font-size: 13px;
  line-height: 1.45;
  padding: 6px 0;
  white-space: pre-wrap;
}

.tool-calls {
  margin-top: 6px;
  display: grid;
  gap: 4px;
}

.tool-call {
  padding: 5px 8px;
  border-radius: 4px;
  background: #1a1a1a;
  font-size: 13px;
}

.tool-call-name {
  color: var(--accent);
  font-weight: 600;
}

.tool-call-summary {
  color: var(--dim);
}

.tool-result {
  color: var(--muted);
  font-size: 13px;
  max-height: 60px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

button:disabled,
input:disabled,
select:disabled,
textarea:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.model-select {
  max-width: 260px;
  min-width: 150px;
}

@media (max-width: 1080px) {
  .shell {
    grid-template-columns: 220px minmax(0, 1fr);
  }
  .shell.sessions-shell {
    grid-template-columns: 220px minmax(0, 1fr);
  }
  .shell.evolution-focus-shell {
    grid-template-columns: 220px minmax(0, 1fr);
  }
  .inspector {
    display: none;
  }
}

@media (max-width: 760px) {
  .shell {
    grid-template-columns: 1fr;
  }
  .shell.sessions-shell {
    grid-template-columns: 1fr;
    grid-template-rows: 220px minmax(0, 1fr);
  }
  .sidebar {
    display: none;
  }
  .shell.sessions-shell .sidebar {
    display: flex;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .split,
  .two {
    grid-template-columns: 1fr;
  }
  .ticket-workspace .ticket-panel {
    max-height: 40dvh;
    position: static;
  }
}
`;

export const WEBUI_SCRIPT = `
const app = document.getElementById("app");
const EVOLUTION_CONVERSATION_ID = "self-evaluation";
const PENDING_NEW_SESSION = "__pending_new__";
const state = {
  view: "sessions",
  snapshot: null,
  runtime: null,
  models: null,
  conversations: [],
  skills: { skills: [], disabledSkills: [], issues: [] },
  liveRuns: {},
  pendingActions: {},
  activeEvolutionTicketId: null,
  evolutionPane: "tickets",
  evolutionContextLoaded: false,
  selectedTicketId: null,
  selectedConversationId: null,
  pendingNewSession: false,
  autoScrollMain: true,
  loading: true,
  error: null,
  actionError: null,
  skillImportFiles: [],
  skillImportFolderName: "",
  skillImportOverwrite: false,
  drafts: {}
};
let renderScheduled = false;
const SCROLL_BOTTOM_THRESHOLD_PX = 80;
const EVOLUTION_STREAM_RENDER_DELAY_MS = 90;
const LIVE_STREAM_RENDER_DELAY_MS = 50;
const LIVE_REASONING_RENDER_DELAY_MS = 70;
const LIVE_REASONING_MAX_CHARS = 12000;
const LIVE_ASSISTANT_MAX_CHARS = 20000;
const FOCUSED_INPUT_RENDER_DELAY_MS = 80;
const MANUAL_SCROLL_RENDER_DELAY_MS = 80;
const MANUAL_SCROLL_RENDER_WINDOW_MS = 140;
let composingTextFieldId = "";
let renderDeferredDuringComposition = false;
let lastMainScrollAt = 0;
const liveRenderTimers = {};
const renderedMessageSequenceCache = new WeakMap();
const renderedContextMessageSequenceCache = new WeakMap();

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function errorMessage(error) {
  if (error && typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }
  return String(error || "Unexpected error");
}

function saveDraft() {
  if (!state.selectedConversationId) return;
  var textarea = document.getElementById("session-message");
  if (textarea) {
    state.drafts[state.selectedConversationId] = textarea.value;
  }
}

function getDraft(conversationId) {
  return state.drafts[conversationId] || "";
}

function isTextField(element) {
  if (!element) return false;
  if (element instanceof HTMLTextAreaElement) return true;
  if (!(element instanceof HTMLInputElement)) return false;
  var type = (element.getAttribute("type") || "text").toLowerCase();
  return ["text", "search", "url", "tel", "email", "password"].includes(type);
}

function activeTextField() {
  var element = document.activeElement;
  return isTextField(element) ? element : null;
}

function shouldDeferRenderForComposition() {
  var field = activeTextField();
  return !!(composingTextFieldId && field && field.id === composingTextFieldId);
}

function captureFocusedTextField() {
  var field = activeTextField();
  if (!field || !field.id || !app.contains(field)) return null;
  if (field.id === "session-message" && state.selectedConversationId) {
    state.drafts[state.selectedConversationId] = field.value;
  }
  return {
    id: field.id,
    value: field.value,
    selectionStart: typeof field.selectionStart === "number" ? field.selectionStart : null,
    selectionEnd: typeof field.selectionEnd === "number" ? field.selectionEnd : null,
    selectionDirection: field.selectionDirection || "none",
    scrollTop: field.scrollTop || 0,
    scrollLeft: field.scrollLeft || 0
  };
}

function restoreFocusedTextField(previous) {
  if (!previous) return;
  var field = document.getElementById(previous.id);
  if (!isTextField(field) || field.disabled) return;
  field.value = previous.value;
  if (field.id === "session-message" && state.selectedConversationId) {
    state.drafts[state.selectedConversationId] = field.value;
  }
  try {
    field.focus({ preventScroll: true });
  } catch (_error) {
    field.focus();
  }
  if (previous.selectionStart !== null && previous.selectionEnd !== null) {
    try {
      var max = field.value.length;
      field.setSelectionRange(
        Math.min(previous.selectionStart, max),
        Math.min(previous.selectionEnd, max),
        previous.selectionDirection
      );
    } catch (_error) {}
  }
  field.scrollTop = previous.scrollTop;
  field.scrollLeft = previous.scrollLeft;
}

function fmtTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function fmtShortTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function timestampFromSemanticId(value) {
  var text = String(value || "");
  var compact = text.match(/^(?:evo|sig|web)_([0-9]{8}-[0-9]{6})/);
  if (compact) {
    var stamp = compact[1];
    return new Date(
      stamp.slice(0, 4) + "-" +
      stamp.slice(4, 6) + "-" +
      stamp.slice(6, 8) + "T" +
      stamp.slice(9, 11) + ":" +
      stamp.slice(11, 13) + ":" +
      stamp.slice(13, 15) + "Z"
    ).toISOString();
  }
  var legacy = text.match(/^(?:evo|sig|web)_([0-9]{12,})_/);
  if (legacy) {
    var ms = Number(legacy[1]);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return "";
}

function ticketDisplayId(ticket) {
  if (!ticket) return "";
  var time = fmtShortTime(ticket.createdAt || timestampFromSemanticId(ticket.id));
  return time ? "Ticket " + time : ticket.id;
}

function runtimeVersions() {
  return (state.snapshot && state.snapshot.runtimeVersions) || [];
}

function selfInstructionVersions() {
  return (state.snapshot && state.snapshot.selfVersions) || [];
}

function activeRuntimeVersion() {
  return state.snapshot && state.snapshot.activeRuntimeVersion
    ? state.snapshot.activeRuntimeVersion
    : null;
}

function activeRuntimeVersionId() {
  var active = activeRuntimeVersion();
  return active ? active.versionId : "";
}

function pendingRuntimeActivation() {
  return state.snapshot && state.snapshot.pendingRuntimeActivation
    ? state.snapshot.pendingRuntimeActivation
    : null;
}

function pendingRuntimeActivationVersionId() {
  var pending = pendingRuntimeActivation();
  return pending ? pending.versionId : "";
}

function runtimeVersionLabel(version) {
  if (!version) return "";
  var number = Number.isFinite(Number(version.number))
    ? String(version.number).padStart(4, "0")
    : "????";
  return "v" + number;
}

function runtimeVersionTitle(version) {
  if (!version) return "";
  return runtimeVersionLabel(version) + " · " + (version.topic || version.label || version.id);
}

function runtimeVersionForTicket(ticket) {
  if (!ticket || !ticket.rollout || !ticket.rollout.versionId) return null;
  return runtimeVersions().find(function(version) {
    return version.id === ticket.rollout.versionId;
  }) || null;
}

function selfInstructionVersionForTicket(ticket) {
  if (!ticket || !ticket.rollout || !ticket.rollout.versionId) return null;
  return selfInstructionVersions().find(function(version) {
    return version.id === ticket.rollout.versionId;
  }) || null;
}

function isRuntimeVersionActive(versionId) {
  return !!versionId && activeRuntimeVersionId() === versionId;
}

function isRuntimeVersionPendingActivation(versionId) {
  return !!versionId && pendingRuntimeActivationVersionId() === versionId;
}

function badgeClass(value) {
  if (value === "applied" || value === "approved" || value === "passed") return "ok";
  if (value === "critical" || value === "failed" || value === "rejected") return "danger";
  if (value === "warning" || value === "waiting_for_approval" || value === "applying") return "warn";
  return "";
}

function truncate(value, maxLength) {
  if (!value) return "";
  var str = String(value);
  return str.length <= maxLength ? str : str.slice(0, maxLength - 3) + "...";
}

async function api(path, options) {
  const response = await fetch(path, Object.assign({
    headers: { "content-type": "application/json" }
  }, options || {}));
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = await response.json();
      message = body.error || message;
    } catch (_error) {}
    throw new Error(message);
  }
  return response.json();
}

function sleep(ms) {
  return new Promise(function(resolve) {
    window.setTimeout(resolve, ms);
  });
}

function hasLoadedState() {
  return state.snapshot !== null ||
    state.conversations.length > 0 ||
    ((state.skills && state.skills.skills && state.skills.skills.length) || 0) > 0;
}

function currentRuntimeInstanceId() {
  return state.runtime && state.runtime.instanceId
    ? String(state.runtime.instanceId)
    : "";
}

function healthRuntimeInstanceId(health) {
  return health && health.runtime && health.runtime.instanceId
    ? String(health.runtime.instanceId)
    : "";
}

function reloadActivatedPage() {
  const url = new URL(window.location.href);
  url.searchParams.set("activated", String(Date.now()));
  window.location.href = url.toString();
}

async function pollRuntimeHealth(timeoutMs) {
  const controller = new AbortController();
  const timeout = window.setTimeout(function() {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch("/api/health?restart=" + Date.now(), {
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) {
      return { available: false, health: null };
    }
    var health = null;
    try {
      health = await response.json();
    } catch (_parseError) {}
    return { available: true, health: health };
  } catch (_error) {
    return { available: false, health: null };
  } finally {
    window.clearTimeout(timeout);
  }
}

async function waitForRuntimeActivation(pendingKey, runtimeActivation) {
  const previousInstanceId = currentRuntimeInstanceId();
  const manualRestart = runtimeActivation && runtimeActivation.mode === "process_exit";
  setPending(
    pendingKey,
    manualRestart
      ? "Activate pibot in the original terminal; this page will reconnect automatically..."
      : "Waiting for activated runtime..."
  );
  render();
  const startedAt = Date.now();
  let sawUnavailable = false;
  const maxWaitMs = 300000;
  const zeroDowntimeReloadMs = 10000;
  const fallbackReloadMs = manualRestart ? 15000 : zeroDowntimeReloadMs;
  const healthPollTimeoutMs = 2500;
  while (Date.now() - startedAt < maxWaitMs) {
    const poll = await pollRuntimeHealth(healthPollTimeoutMs);
    if (!poll.available) {
      sawUnavailable = true;
      await sleep(1000);
      continue;
    }
    const instanceId = healthRuntimeInstanceId(poll.health);
    if (previousInstanceId && instanceId && instanceId !== previousInstanceId) {
      setPending(pendingKey, "Runtime version activated. Refreshing page...");
      render();
      reloadActivatedPage();
      return;
    }
    if (sawUnavailable) {
      setPending(pendingKey, "Activated runtime is reachable. Refreshing page...");
      render();
      reloadActivatedPage();
      return;
    }
    if (Date.now() - startedAt > fallbackReloadMs) {
      setPending(pendingKey, "Refreshing page to check the active runtime version...");
      render();
      reloadActivatedPage();
      return;
    }
    await sleep(1000);
  }
  throw new Error("Runtime version activation was requested, but the server did not come back within 300 seconds. Restart pibot manually with npm run webui, then refresh this page.");
}

async function refresh(options) {
  const showLoading = options && options.showLoading === true
    ? true
    : !hasLoadedState();
  state.loading = showLoading;
  state.error = null;
  state.actionError = null;
  if (showLoading) {
    render();
  }
  try {
    const data = await api("/api/state");
    state.snapshot = data.evolution;
    state.evolutionContextLoaded = false;
    state.runtime = data.runtime || null;
    state.models = data.models || null;
    state.conversations = data.conversations;
    state.skills = data.skills || { skills: [], disabledSkills: [], issues: [] };
    if (!state.selectedTicketId && data.evolution.tickets.length > 0) {
      state.selectedTicketId = data.evolution.tickets[data.evolution.tickets.length - 1].id;
    }
    if (!state.selectedConversationId && data.conversations[0]) {
      state.selectedConversationId = data.conversations[0].id;
    }
    if (state.view === "evolution" && state.evolutionPane === "context") {
      await ensureEvolutionContextLoaded();
    }
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
    render();
  }
}

function sortedTickets() {
  const tickets = (state.snapshot && state.snapshot.tickets) || [];
  return tickets.slice().sort(function(a, b) {
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
}

function selectedTicket() {
  return sortedTickets().find(function(ticket) {
    return ticket.id === state.selectedTicketId;
  }) || sortedTickets()[0] || null;
}

function ticketById(ticketId) {
  const tickets = (state.snapshot && state.snapshot.tickets) || [];
  return tickets.find(function(ticket) {
    return ticket.id === ticketId;
  }) || null;
}

function upsertTicket(ticket) {
  if (!ticket) return;
  const snapshot = state.snapshot || { tickets: [], signals: [], selfVersions: [] };
  const tickets = snapshot.tickets || [];
  const existing = tickets.findIndex(function(item) {
    return item.id === ticket.id;
  });
  state.snapshot = Object.assign({}, snapshot, {
    tickets: existing === -1
      ? [ticket].concat(tickets)
      : tickets.map(function(item) {
          return item.id === ticket.id ? ticket : item;
        })
  });
}

function patchTicket(ticketId, patch) {
  const snapshot = state.snapshot;
  if (!snapshot || !Array.isArray(snapshot.tickets)) return;
  state.snapshot = Object.assign({}, snapshot, {
    tickets: snapshot.tickets.map(function(ticket) {
      return ticket.id === ticketId ? Object.assign({}, ticket, patch) : ticket;
    })
  });
}

function updateEvolutionContext(context) {
  if (!context) return;
  state.snapshot = Object.assign({}, state.snapshot || {}, { context: context });
  state.evolutionContextLoaded = true;
}

async function ensureEvolutionContextLoaded() {
  if (state.evolutionContextLoaded) return;
  const result = await api("/api/evolution/context");
  updateEvolutionContext(result.context);
}

function selectedConversation() {
  if (state.pendingNewSession) return null;
  return state.conversations.find(function(conversation) {
    return conversation.id === state.selectedConversationId;
  }) || state.conversations[0] || null;
}

function lastConversationMessageRole(conversation) {
  if (!conversation || !Array.isArray(conversation.messages) || conversation.messages.length === 0) {
    return "";
  }
  var message = conversation.messages[conversation.messages.length - 1];
  return message && message.role ? message.role : "";
}

function evolutionContextForTicket(ticketId) {
  const context = state.snapshot && state.snapshot.context;
  const ticketContexts = context && Array.isArray(context.ticketContexts)
    ? context.ticketContexts
    : [];
  return ticketContexts.find(function(ticketContext) {
    return ticketContext.ticketId === ticketId;
  }) || null;
}

function evolutionContextMessages(ticketId) {
  const context = state.snapshot && state.snapshot.context;
  if (ticketId) {
    const ticketContext = evolutionContextForTicket(ticketId);
    return ticketContext && Array.isArray(ticketContext.messages)
      ? ticketContext.messages
      : [];
  }
  return context && Array.isArray(context.messages) ? context.messages : [];
}

function scheduleRender(options) {
  if (shouldDeferRenderForComposition()) {
    renderDeferredDuringComposition = true;
    return;
  }
  if (renderScheduled) return;
  renderScheduled = true;
  const requestedDelayMs = options && options.delayMs ? options.delayMs : 0;
  const focusedDelayMs = activeTextField() ? FOCUSED_INPUT_RENDER_DELAY_MS : 0;
  const manualScrollDelayMs = recentMainScrollRenderDelayMs();
  const delayMs = Math.max(requestedDelayMs, focusedDelayMs, manualScrollDelayMs);
  const flush = function() {
    renderScheduled = false;
    render();
  };
  if (delayMs > 0) {
    window.setTimeout(function() {
      window.requestAnimationFrame(flush);
    }, delayMs);
    return;
  }
  window.requestAnimationFrame(flush);
}

function shouldRenderRun(conversationId) {
  if (conversationId === EVOLUTION_CONVERSATION_ID) {
    return state.view === "evolution" && state.evolutionPane === "context";
  }
  return state.view === "sessions" && state.selectedConversationId === conversationId;
}

function scheduleRunRender(conversationId, options) {
  if (shouldRenderRun(conversationId)) {
    if (conversationId === EVOLUTION_CONVERSATION_ID) {
      const delayMs = options && options.delayMs ? options.delayMs : 0;
      scheduleRender({ delayMs: Math.max(delayMs, EVOLUTION_STREAM_RENDER_DELAY_MS) });
      return;
    }
    scheduleRender(options);
  }
}

function scheduleLiveRender(conversationId, options) {
  if (!shouldRenderRun(conversationId)) return;
  if (!liveRunFor(conversationId)) return;
  const delayMs = options && options.delayMs !== undefined
    ? options.delayMs
    : LIVE_STREAM_RENDER_DELAY_MS;
  if (liveRenderTimers[conversationId]) return;
  liveRenderTimers[conversationId] = window.setTimeout(function() {
    window.requestAnimationFrame(function() {
      delete liveRenderTimers[conversationId];
      if (!renderLiveRunElement(conversationId)) {
        scheduleRunRender(conversationId, { delayMs: 0 });
      }
    });
  }, delayMs);
}

function cancelLiveRender(conversationId) {
  if (!liveRenderTimers[conversationId]) return;
  window.clearTimeout(liveRenderTimers[conversationId]);
  delete liveRenderTimers[conversationId];
}

function clearLiveRunElement(conversationId) {
  const element = liveMessageElementFor(conversationId);
  if (!element) return;
  element.innerHTML = "";
  element.classList.add("ending");
}

function renderRunNow(conversationId) {
  if (shouldRenderRun(conversationId)) {
    render();
  }
}

function render() {
  if (shouldDeferRenderForComposition()) {
    renderDeferredDuringComposition = true;
    return;
  }
  const previousFocus = captureFocusedTextField();
  const previousScroll = captureScrollContainers();
  const tickets = sortedTickets();
  const activeTicket = selectedTicket();
  const activeConversation = selectedConversation();
  const pendingCount = tickets.filter(function(ticket) {
    return ticket.status === "waiting_for_approval" || ticket.status === "approved";
  }).length;
  const shellClass = state.view === "sessions"
    ? "shell sessions-shell"
    : (state.view === "skills" ? "shell skills-shell"
      : (state.view === "evolution" && state.evolutionPane === "context" ? "shell evolution-focus-shell" : "shell"));
  const contentClass = (state.view === "evolution" && state.evolutionPane === "tickets") || state.view === "skills"
    ? "content ticket-workspace-content"
    : "content";
  app.innerHTML =
    '<div class="' + shellClass + '">' +
      '<aside class="sidebar">' +
        '<div class="brand"><strong>PIBot</strong></div>' +
        '<div class="session-rail">' +
          '<div class="session-header"><span>Sessions</span><button class="icon-button" title="New session" aria-label="New session" data-action="new-session">+</button></div>' +
          '<div class="session-list">' + (state.conversations.length === 0 ? '<div class="empty">No sessions.</div>' : state.conversations.map(renderSidebarConversation).join("")) + '</div>' +
        '</div>' +
        '<div class="sidebar-bottom">' +
          '<button class="evolution-entry ' + (state.view === "skills" ? "active" : "") + '" data-view="skills"><span>Skills</span></button>' +
          '<button class="evolution-entry ' + (state.view === "evolution" ? "active" : "") + '" data-view="evolution"><span>Self-evaluation</span><span class="count">' + pendingCount + '</span></button>' +
        '</div>' +
      '</aside>' +
      '<main class="main">' +
        renderTopbar(activeTicket) +
        '<div class="' + contentClass + '" data-scroll-key="main">' + renderActionError() + renderMain(activeTicket, activeConversation, tickets) + '</div>' +
      '</main>' +
      '<aside class="inspector">' +
        '<div class="topbar"><div class="topbar-left"><h1>Inspector</h1></div><div class="toolbar"></div></div>' +
        '<div class="content">' + renderInspector(activeTicket) + '</div>' +
      '</aside>' +
    '</div>';
  restoreScrollContainers(previousScroll);
  restoreFocusedTextField(previousFocus);
}

function isNearBottom(element) {
  return element.scrollTop + element.clientHeight >= element.scrollHeight - SCROLL_BOTTOM_THRESHOLD_PX;
}

function getMainScrollContainer() {
  var content = app.querySelector(".main .content");
  if (!content) return null;
  if (content.classList.contains("ticket-workspace-content")) return content;
  var panelBody = content.querySelector(":scope > .panel > .panel-body");
  if (panelBody) return panelBody;
  var stack = content.querySelector(":scope > .split > .stack");
  if (stack) return stack;
  return content;
}

function mainScrollContainerForEventTarget(value) {
  var element = value instanceof Element ? value : null;
  if (!element) return null;
  if (element.closest(".ticket-workspace .ticket-panel .panel-body")) {
    return null;
  }
  var content = element.closest(".main .content");
  if (content && content.classList.contains("ticket-workspace-content")) {
    return content;
  }
  return element.closest(".main .panel-body, .main .stack");
}

function captureScrollContainers() {
  var containers = {};
  var mainScroll = getMainScrollContainer();
  if (mainScroll) {
    containers["main"] = {
      top: mainScroll.scrollTop,
      nearBottom: isNearBottom(mainScroll)
    };
  }
  app.querySelectorAll("[data-scroll-key]").forEach(function(element) {
    var key = element.dataset.scrollKey;
    if (!key || key === "main") return;
    containers[key] = {
      top: element.scrollTop,
      nearBottom: isNearBottom(element)
    };
  });
  return containers;
}

function restoreScrollContainers(previousScroll) {
  var mainScroll = getMainScrollContainer();
  if (mainScroll) {
    var previous = previousScroll["main"];
    var stickToBottom = state.autoScrollMain &&
      !mainScroll.classList.contains("ticket-workspace-content") &&
      (!previous || previous.nearBottom);
    if (stickToBottom) {
      mainScroll.scrollTop = mainScroll.scrollHeight;
    } else if (previous) {
      var maxTop = Math.max(0, mainScroll.scrollHeight - mainScroll.clientHeight);
      mainScroll.scrollTop = Math.min(previous.top, maxTop);
    }
  }
  app.querySelectorAll("[data-scroll-key]").forEach(function(element) {
    var key = element.dataset.scrollKey;
    if (!key || key === "main") return;
    var previous = previousScroll[key];
    var stickToBottom = element.dataset.scrollStick === "bottom" && (!previous || previous.nearBottom);
    if (stickToBottom) {
      element.scrollTop = element.scrollHeight;
      return;
    }
    if (!previous) return;
    var maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.min(previous.top, maxTop);
  });
}

function closestElement(value, selector) {
  return value instanceof Element ? value.closest(selector) : null;
}

function updateMainAutoScroll(element) {
  if (!element || !element.closest(".main")) return;
  state.autoScrollMain = isNearBottom(element);
}

function markMainScrollActivity() {
  lastMainScrollAt = Date.now();
}

function recentMainScrollRenderDelayMs() {
  if (!lastMainScrollAt) return 0;
  var elapsed = Date.now() - lastMainScrollAt;
  if (elapsed < 0 || elapsed >= MANUAL_SCROLL_RENDER_WINDOW_MS) return 0;
  return Math.min(MANUAL_SCROLL_RENDER_DELAY_MS, MANUAL_SCROLL_RENDER_WINDOW_MS - elapsed);
}

function renderTopbar(ticket) {
  const conversation = selectedConversation();
  const title = state.view === "evolution"
    ? evolutionTopbarTitle(ticket)
    : (state.view === "skills" ? "Skills" : (conversation ? conversation.title : (state.pendingNewSession ? "New Session" : "Sessions")));
  const leading = state.view === "evolution" && state.evolutionPane === "context"
    ? '<button class="ghost btn-icon" data-action="back-evolution" title="Back" aria-label="Back">←</button>'
    : '';
  const refreshPending = pendingLabel("refresh");
  const actions = state.view === "sessions"
    ? renderModelControls()
    : (state.view === "skills" ? '' : renderEvolutionTopbarActions(ticket));
  return '<div class="topbar"><div class="topbar-left">' + leading + '<h1 title="' + escapeHtml(title) + '">' + escapeHtml(title) + '</h1></div><div class="toolbar">' + actions + '<button class="ghost btn-icon' + pendingClass(refreshPending) + '" data-action="refresh"' + disabledAttr(state.loading || !!refreshPending) + ' title="' + (refreshPending || "Refresh") + '"><span class="refresh-icon">↻</span></button></div></div>';
}

function renderModelControls() {
  if (!state.models || !Array.isArray(state.models.models)) return '';
  const active = String(state.models.active || '');
  const selectPending = pendingLabel("model-select");
  const checkPending = pendingLabel("model-check");
  const syncPending = pendingLabel("model-sync");
  const options = state.models.models.map(function(model) {
    const ref = String(model.ref || '');
    const name = model.name ? " · " + model.name : "";
    const compatibility = model.status === "unknown" ? " · unverified" : "";
    const label = ref + name + compatibility;
    return '<option value="' + escapeHtml(ref) + '"' + (ref === active ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
  }).join("");
  return '<select id="model-selector" class="model-select" title="Active model"' + disabledAttr(!!selectPending) + '>' + options + '</select>' +
    '<button class="ghost" data-action="check-models"' + disabledAttr(!!checkPending || !!syncPending) + ' title="Check provider model catalogs without writing">' + escapeHtml(checkPending || "Check models") + '</button>' +
    '<button class="ghost" data-action="sync-models"' + disabledAttr(!!checkPending || !!syncPending) + ' title="Synchronize provider model catalogs">' + escapeHtml(syncPending || "Sync models") + '</button>';
}

function evolutionTopbarTitle(ticket) {
  if (state.evolutionPane === "context" && ticket) {
    return "Self-evaluation / Context";
  }
  return "Self-evaluation";
}

function renderEvolutionTopbarActions(ticket) {
  return '';
}

function renderSidebarConversation(conversation) {
  return '<div class="session-item ' + (conversation.id === state.selectedConversationId ? "active" : "") + '" data-conversation-id="' + escapeHtml(conversation.id) + '">' +
    '<span class="session-name" title="' + escapeHtml(conversation.title) + '">' + escapeHtml(conversation.title) + '</span>' +
    '<button class="session-delete" title="Delete session" aria-label="Delete session" data-action="delete-conversation" data-conversation-id="' + escapeHtml(conversation.id) + '">x</button>' +
  '</div>';
}

function liveRunFor(conversationId) {
  return state.liveRuns[conversationId] || null;
}

function ensureLiveRun(conversationId) {
  if (!state.liveRuns[conversationId]) {
    state.liveRuns[conversationId] = {
      assistantText: "",
      reasoningText: "",
      statusLines: [],
      toolChips: [],
      approvals: [],
      blocks: [],
      runId: null,
      userTurnId: null
    };
  }
  return state.liveRuns[conversationId];
}

function clearLiveRun(conversationId) {
  cancelLiveRender(conversationId);
  clearLiveRunElement(conversationId);
  delete state.liveRuns[conversationId];
}

function upsertConversation(conversation, options) {
  const existing = state.conversations.findIndex(function(item) {
    return item.id === conversation.id;
  });
  if (existing === -1) {
    state.conversations = [conversation].concat(state.conversations);
  } else {
    state.conversations = state.conversations.map(function(item) {
      return item.id === conversation.id ? mergeConversationForState(item, conversation) : item;
    });
  }
  if (options && options.select) {
    state.selectedConversationId = conversation.id;
  }
}

function mergeConversationForState(existing, incoming) {
  if (!existing) return incoming;
  var existingMessages = Array.isArray(existing.messages) ? existing.messages : [];
  var incomingMessages = Array.isArray(incoming.messages) ? incoming.messages : [];
  if (existingMessages.length > 0 && incomingMessages.length === 0) {
    return Object.assign({}, incoming, { messages: existingMessages });
  }
  return incoming;
}

function pushLiveStatus(live, line) {
  live.statusLines = live.statusLines.concat([line]).slice(-4);
}

function upsertLiveApproval(live, approval) {
  var existing = live.approvals.findIndex(function(item) {
    return item.id === approval.id;
  });
  if (existing === -1) {
    live.approvals = live.approvals.concat([approval]);
  } else {
    live.approvals = live.approvals.map(function(item) {
      return item.id === approval.id ? approval : item;
    });
  }
  upsertLiveApprovalBlock(live, approval);
}

function appendLiveBlock(live, block) {
  live.blocks = (live.blocks || []).concat([block]);
}

function appendLiveTextBlock(live, type, text) {
  if (!text) return;
  live.blocks = live.blocks || [];
  var last = live.blocks[live.blocks.length - 1];
  if (last && last.type === type) {
    last.text = (last.text || "") + text;
    live.blocks = live.blocks.slice(0, -1).concat([last]);
    return;
  }
  appendLiveBlock(live, {
    type: type,
    text: text
  });
}

function upsertLiveApprovalBlock(live, approval) {
  live.blocks = live.blocks || [];
  var existing = live.blocks.findIndex(function(block) {
    return block.type === "approval" && block.approval && block.approval.id === approval.id;
  });
  var block = {
    type: "approval",
    approval: approval
  };
  if (existing === -1) {
    appendLiveBlock(live, block);
    return;
  }
  live.blocks = live.blocks.map(function(item, index) {
    return index === existing ? block : item;
  });
}

function updateLiveToolBlock(live, callId, resultSummary, isError) {
  live.blocks = live.blocks || [];
  var existing = -1;
  if (callId) {
    existing = live.blocks.findIndex(function(block) {
      return block.type === "tool" && block.id === callId;
    });
  }
  if (existing === -1) {
    for (var i = live.blocks.length - 1; i >= 0; i--) {
      if (live.blocks[i].type === "tool" && !live.blocks[i].done) {
        existing = i;
        break;
      }
    }
  }
  if (existing === -1) {
    appendLiveBlock(live, {
      type: "tool",
      id: callId || "",
      label: "tool result",
      result: resultSummary,
      done: true,
      error: isError
    });
    return;
  }
  live.blocks = live.blocks.map(function(block, index) {
    return index === existing
      ? Object.assign({}, block, {
          result: resultSummary,
          done: true,
          error: isError
        })
      : block;
  });
}

function pendingLabel(key) {
  return state.pendingActions[key] || "";
}

function setPending(key, label) {
  state.pendingActions = Object.assign({}, state.pendingActions, {
    [key]: label
  });
}

function clearPending(key) {
  const next = Object.assign({}, state.pendingActions);
  delete next[key];
  state.pendingActions = next;
}

async function withPending(key, label, work) {
  if (pendingLabel(key)) return false;
  setPending(key, label);
  render();
  try {
    await work();
    return true;
  } finally {
    clearPending(key);
    render();
  }
}

function ticketActionKey(ticketId) {
  return "ticket:" + ticketId;
}

function actionKeyForTarget(action, target) {
  if (action === "save-proposal" || action === "approve-ticket" || action === "start-implementation" || action === "reject-ticket" || action === "activate-runtime" || action === "delete-ticket") {
    return ticketActionKey(target.dataset.ticketId || "");
  }
  if (action === "activate-version") return "runtime-version:" + (target.dataset.versionId || "");
  if (action === "rollback-version") return "version:" + (target.dataset.versionId || "");
  if (action === "delete-runtime-version") return "runtime-delete:" + (target.dataset.versionId || "");
  if (action === "delete-self-version") return "self-delete:" + (target.dataset.versionId || "");
  if (action === "append-evolution-context") return "evolution-context";
  if (action === "import-skill") return "skill-import";
  if (action === "send-session-message") return "session:" + (target.dataset.conversationId || "");
  if (action === "new-session") return "new-session";
  if (action === "delete-conversation") return "conversation:" + (target.dataset.conversationId || "");
  if (action === "refresh") return "refresh";
  return "";
}

function disabledAttr(disabled) {
  return disabled ? " disabled" : "";
}

function pendingClass(pending) {
  return pending ? " pending" : "";
}

function renderMain(ticket, conversation, tickets) {
  if (state.loading && !hasLoadedState()) return '<div class="empty">Loading...</div>';
  if (state.error) return '<div class="panel"><div class="panel-body"><span class="badge danger">' + escapeHtml(state.error) + '</span></div></div>';
  if (state.view === "sessions") return renderConversation(conversation);
  if (state.view === "skills") return renderSkills();
  return renderEvolution(ticket, tickets);
}

function renderActionError() {
  if (!state.actionError || state.error) return "";
  return '<div class="action-status danger action-error" role="alert">' +
    '<span>' + escapeHtml(state.actionError) + '</span>' +
    '<button class="ghost" data-action="dismiss-action-error">Dismiss</button>' +
  '</div>';
}

function renderSkills() {
  const skills = (state.skills && state.skills.skills) || [];
  const issues = (state.skills && state.skills.issues) || [];
  const pending = pendingLabel("skill-import");
  const importFiles = state.skillImportFiles || [];
  const importLabel = importFiles.length === 0
    ? "No folder chosen"
    : state.skillImportFolderName + " (" + importFiles.length + " file" + (importFiles.length === 1 ? "" : "s") + ")";
  return '<div class="split ticket-workspace skills-workspace">' +
    '<section class="panel ticket-panel">' +
      '<div class="panel-header"><span class="panel-title">Skill Index</span><span class="badge">' + skills.length + '</span></div>' +
      '<div class="panel-body"><div class="skills-list">' +
        (issues.length === 0 ? "" : '<div class="action-status warn"><span>' + escapeHtml(issues.length + " scanner warning" + (issues.length === 1 ? "" : "s")) + '</span></div>') +
        (skills.length === 0 ? '<div class="empty">No skills.</div>' : skills.map(renderSkillRow).join("")) +
      '</div></div>' +
    '</section>' +
    '<section class="panel">' +
      '<div class="panel-header"><span class="panel-title">Import</span></div>' +
      '<div class="panel-body">' +
        '<div class="field"><label>Folder</label><div class="file-picker"><input id="skill-import-files" type="file" multiple webkitdirectory directory><button type="button" class="file-picker-btn" data-target="skill-import-files">Choose Folder</button><span class="file-picker-label" id="skill-import-files-label">' + escapeHtml(importLabel) + '</span></div></div>' +
        '<label class="checkbox-line"><input id="skill-import-overwrite" type="checkbox"' + (state.skillImportOverwrite ? " checked" : "") + '> <span>Overwrite existing</span></label>' +
        '<div class="toolbar"><button class="primary' + pendingClass(pending) + '" data-action="import-skill"' + disabledAttr(!!pending) + '>' + (pending || "Import") + '</button></div>' +
      '</div>' +
    '</section>' +
  '</div>';
}

function renderSkillRow(skill) {
  return '<div class="skill-row">' +
    '<div class="skill-title">' + escapeHtml(skill.name) + '</div>' +
    '<div class="item-meta"><span class="badge">' + escapeHtml(skill.source) + '</span><span class="skill-location" title="' + escapeHtml(skill.location) + '">' + escapeHtml(skill.location) + '</span>' + (skill.disableModelInvocation ? '<span class="badge warn">manual</span>' : '') + '</div>' +
    '<div class="skill-description">' + escapeHtml(skill.description) + '</div>' +
  '</div>';
}

function renderEvolution(ticket, tickets) {
  if (state.evolutionPane === "context" && ticket) {
    return renderEvolutionContextPage(ticket);
  }
  return renderEvolutionTicketWorkspace(ticket, tickets);
}

function renderEvolutionTicketWorkspace(ticket, tickets) {
  return '<div class="split ticket-workspace">' +
    '<section class="panel ticket-panel">' +
      '<div class="panel-header"><span class="panel-title">Tickets</span><span class="badge">' + tickets.length + '</span></div>' +
      '<div class="panel-body"><div class="ticket-list">' +
        (tickets.length === 0 ? '<div class="empty">No tickets.</div>' : tickets.map(renderTicketRow).join("")) +
      '</div></div>' +
    '</section>' +
    '<section class="stack">' + renderTicketDetail(ticket) + '</section>' +
  '</div>';
}

function renderEvolutionContextPage(ticket) {
  const live = state.activeEvolutionTicketId === ticket.id
    ? liveRunFor(EVOLUTION_CONVERSATION_ID)
    : null;
  const notePending = pendingLabel("evolution-context");
  const loadPending = pendingLabel("evolution-context-load");
  const contextMessages = evolutionContextMessages(ticket.id);
  const messages = renderCachedContextMessageSequence(contextMessages, 30) + renderLiveMessage(live, EVOLUTION_CONVERSATION_ID);
  return '<div class="panel evolution-context-page">' +
    '<div class="panel-header"><span class="panel-title">' + escapeHtml(ticket.title) + '</span><span class="badge ' + badgeClass(ticket.status) + '">' + escapeHtml(ticket.status) + '</span></div>' +
      '<div class="panel-body">' +
        '<div class="item-meta"><span title="' + escapeHtml(ticket.id) + '">' + escapeHtml(ticketDisplayId(ticket)) + '</span><span>' + escapeHtml(ticket.target) + '</span><span>' + contextMessages.length + ' context messages</span></div>' +
        (loadPending ? '<div class="action-status"><span class="spinner"></span><span>' + escapeHtml(loadPending) + '</span></div>' : '') +
        '<div class="messages">' + (messages.length === 0 ? '<div class="empty">No ticket context yet.</div>' : messages) + '</div>' +
        '<div class="field"><label for="evolution-context-message">Note</label><textarea id="evolution-context-message" style="min-height:78px"' + disabledAttr(!!notePending) + '></textarea></div>' +
        '<div class="toolbar"><button class="' + pendingClass(notePending).trim() + '" data-action="append-evolution-context"' + disabledAttr(!!notePending) + '>' + (notePending || "Add Note") + '</button></div>' +
        renderTicketActions(ticket, { showContextButton: false }) +
    '</div>' +
  '</div>';
}

function renderTicketRow(ticket) {
  const activeRun = state.activeEvolutionTicketId === ticket.id;
  const version = runtimeVersionForTicket(ticket);
  const versionText = version
    ? '<span class="' + (isRuntimeVersionActive(version.id) ? 'badge ok' : '') + '">' + escapeHtml(runtimeVersionLabel(version)) + (isRuntimeVersionActive(version.id) ? ' active' : '') + '</span>'
    : '';
  return '<div class="ticket-row ' + (ticket.id === state.selectedTicketId ? "active" : "") + '" data-ticket-id="' + escapeHtml(ticket.id) + '">' +
    '<span class="line"><strong>' + escapeHtml(ticket.title) + '</strong><span class="badge ' + badgeClass(ticket.status) + '">' + escapeHtml(ticket.status) + '</span></span>' +
    '<span class="item-meta"><span title="' + escapeHtml(ticket.id) + '">' + escapeHtml(ticketDisplayId(ticket)) + '</span>' + versionText + (activeRun ? '<span>running</span>' : '') +
      '<button class="session-delete" title="Delete ticket" aria-label="Delete ticket" data-action="delete-ticket" data-ticket-id="' + escapeHtml(ticket.id) + '">×</button>' +
    '</span>' +
  '</div>';
}

function renderTicketDetail(ticket) {
  if (!ticket) {
    return '<div class="panel"><div class="panel-body"><div class="empty">Select a ticket to view details.</div></div></div>';
  }
  const proposal = ticket.proposal;
  const version = runtimeVersionForTicket(ticket);
  const selfInstructionVersion = selfInstructionVersionForTicket(ticket);
  const versionField = ticket.target === "self_instructions"
    ? '<div class="field"><label>Self-Instruction Version</label>' + (
        selfInstructionVersion
          ? '<span class="badge ok" title="' + escapeHtml(selfInstructionVersion.id) + '">' + escapeHtml(selfInstructionVersion.topic || selfInstructionVersion.label || selfInstructionVersion.id) + '</span>'
          : '<span class="badge warn">no snapshot</span>'
      ) + '</div>'
    : '<div class="field"><label>Runtime Version</label>' + (
        version
          ? '<span class="badge ' + (isRuntimeVersionActive(version.id) ? 'ok' : '') + '" title="' + escapeHtml(version.id) + '">' + escapeHtml(runtimeVersionLabel(version)) + (isRuntimeVersionActive(version.id) ? ' active' : '') + '</span>'
          : '<span class="badge warn">no snapshot</span>'
      ) + '</div>';
  return '<div class="panel">' +
    '<div class="panel-header"><span class="panel-title">' + escapeHtml(ticket.title) + '</span><span class="badge ' + badgeClass(ticket.severity) + '">' + escapeHtml(ticket.severity) + '</span></div>' +
    '<div class="panel-body">' +
      '<div class="two">' +
        '<div class="field"><label>Status</label><span class="badge ' + badgeClass(ticket.status) + '">' + escapeHtml(ticket.status) + '</span></div>' +
        '<div class="field"><label>Target</label><span class="badge">' + escapeHtml(ticket.target) + '</span></div>' +
      '</div>' +
      '<div class="two">' +
        '<div class="field"><label>Ticket</label><span class="badge" title="' + escapeHtml(ticket.id) + '">' + escapeHtml(ticketDisplayId(ticket)) + '</span></div>' +
        versionField +
      '</div>' +
      fieldInput("ticket-title", "Title", ticket.title, " maxlength=\\"25\\"") +
      fieldInput("proposal-version-topic", "Version topic", proposal.versionTopic || ticket.title) +
      fieldTextarea("proposal-summary", "Summary", proposal.summary, 90) +
      fieldTextarea("proposal-diagnosis", "Diagnosis", proposal.diagnosis, 120) +
      fieldTextarea("proposal-instructions", "Proposed self-instructions", proposal.proposedSelfInstructions || "", 260) +
      '<div class="two">' +
        fieldTextarea("proposal-risk", "Risk", proposal.risk, 100) +
        fieldTextarea("proposal-rollback", "Rollback", proposal.rollbackPlan, 100) +
      '</div>' +
      renderTicketActions(ticket) +
      renderValidation(proposal.validation) +
      '<div class="panel"><div class="panel-header"><span class="panel-title">Timeline</span></div><div class="panel-body"><div class="timeline">' + ticket.timeline.slice().reverse().map(renderTimeline).join("") + '</div></div></div>' +
    '</div>' +
  '</div>';
}

function renderTicketActions(ticket, options) {
  const key = ticketActionKey(ticket.id);
  const pending = pendingLabel(key);
  const evolutionRunning = liveRunFor(EVOLUTION_CONVERSATION_ID) !== null;
  const activeEvolutionRunning = evolutionRunning && state.activeEvolutionTicketId === ticket.id;
  const busy = !!pending || ticket.status === "applying" || evolutionRunning;
  const buttons = [];
  const validationPassed = ticket.proposal.validation && ticket.proposal.validation.status === "passed";
  const canSave = ticket.status !== "applying" && ticket.status !== "applied" && ticket.status !== "rejected" && ticket.status !== "rolled_back";
  if (!options || options.showContextButton !== false) {
    buttons.push(actionButton("open-ticket-context", ticket.id, "Context", "", false));
  }
  if (canSave) {
    buttons.push(actionButton("save-proposal", ticket.id, pending === "Saving proposal..." ? "Saving..." : "Save", "", busy));
  }
  if (ticket.status === "proposal_ready" || ticket.status === "waiting_for_approval") {
    buttons.push(actionButton("approve-ticket", ticket.id, pending && pending.indexOf("Approving") === 0 ? "Approving..." : "Approve", "primary", busy || !validationPassed));
    buttons.push(actionButton("reject-ticket", ticket.id, pending === "Rejecting proposal..." ? "Rejecting..." : "Reject", "danger", busy));
  } else if (ticket.status === "approved") {
    buttons.push(actionButton("start-implementation", ticket.id, pending ? "Running..." : "Start Implementation", "primary", busy));
  } else if (ticket.status === "failed") {
    buttons.push(actionButton("start-implementation", ticket.id, pending ? "Retrying..." : "Retry Implementation", "primary", busy));
    buttons.push(actionButton("reject-ticket", ticket.id, pending === "Rejecting proposal..." ? "Rejecting..." : "Reject", "danger", busy));
  } else if (ticket.status === "applying") {
    buttons.push('<button class="primary pending" disabled>Running</button>');
  } else if (ticket.status === "applied" && requiresRuntimeActivation(ticket)) {
    const runtimeActivation = state.snapshot && state.snapshot.runtimeActivation;
    const activationConfigured = runtimeActivation && runtimeActivation.configured;
    const version = runtimeVersionForTicket(ticket);
    if (!version) {
      buttons.push('<button disabled>No Version Snapshot</button>');
    } else if (isRuntimeVersionActive(version.id)) {
      buttons.push('<button class="primary" disabled>Active Version</button>');
    } else if (isRuntimeVersionPendingActivation(version.id)) {
      buttons.push('<button class="primary" data-action="confirm-runtime-version" data-ticket-id="' + escapeHtml(ticket.id) + '" data-version-id="' + escapeHtml(version.id) + '"' + disabledAttr(busy || !activationConfigured) + '>' + escapeHtml(pending ? "Confirming..." : "Confirm Version") + '</button>');
    } else {
      buttons.push(actionButton("activate-runtime", ticket.id, pending ? "Activating..." : "Activate Version", "primary", busy || !activationConfigured));
    }
  } else if (ticket.status === "applied") {
    buttons.push('<button disabled>Applied</button>');
  } else if (ticket.status === "rejected") {
    buttons.push('<button disabled>Rejected</button>');
  }
  return renderTicketActionStatus(ticket, pending, activeEvolutionRunning, evolutionRunning) +
    '<div class="toolbar">' + buttons.join("") + '</div>';
}

function actionButton(action, ticketId, label, className, disabled) {
  const css = (className || "") + (disabled ? "" : "");
  return '<button class="' + escapeHtml(css) + '" data-action="' + action + '" data-ticket-id="' + escapeHtml(ticketId) + '"' + disabledAttr(disabled) + '>' + escapeHtml(label) + '</button>';
}

function renderTicketActionStatus(ticket, pending, activeEvolutionRunning, evolutionRunning) {
  if (pending) {
    return '<div class="action-status"><span class="spinner"></span><span>' + escapeHtml(pending) + '</span></div>';
  }
  if (ticket.status === "applying" || activeEvolutionRunning) {
    return '<div class="action-status"><span class="spinner"></span><span>Implementation is running in Self-evaluation.</span></div>';
  }
  if (evolutionRunning) {
    return '<div class="action-status warn"><span>Another implementation is running. Actions are paused until it finishes.</span></div>';
  }
  if (ticket.status === "applied" && requiresRuntimeActivation(ticket)) {
    const runtimeActivation = state.snapshot && state.snapshot.runtimeActivation;
    const version = runtimeVersionForTicket(ticket);
    if (!version) {
      return '<div class="action-status warn"><span>This applied ticket predates runtime version snapshots, so it is not selectable as a version.</span></div>';
    }
    if (isRuntimeVersionActive(version.id)) {
      return '<div class="action-status"><span>' + escapeHtml(runtimeVersionLabel(version)) + ' is the active runtime version.</span></div>';
    }
    if (!runtimeActivation || !runtimeActivation.configured) {
      return '<div class="action-status warn"><span>Runtime activation is disabled on the server.</span></div>';
    }
    return '<div class="action-status warn"><span>' + escapeHtml(runtimeVersionLabel(version)) + ' is ready. Activate it to select and apply this runtime version.</span></div>';
  }
  if (ticket.status === "approved") {
    return '<div class="action-status warn"><span>Approved. Implementation has not started yet.</span></div>';
  }
  if (ticket.status === "failed") {
    return '<div class="action-status warn"><span>Last implementation failed. Review the timeline before retrying.</span></div>';
  }
  return "";
}

function requiresRuntimeActivation(ticket) {
  return ticket.target !== "self_instructions";
}

function fieldInput(id, label, value) {
  var extraAttrs = arguments.length > 3 && arguments[3] !== undefined ? arguments[3] : "";
  return '<div class="field"><label for="' + id + '">' + label + '</label><input id="' + id + '" value="' + escapeHtml(value) + '"' + extraAttrs + '></div>';
}

function fieldTextarea(id, label, value, height) {
  return '<div class="field"><label for="' + id + '">' + label + '</label><textarea id="' + id + '" style="min-height:' + height + 'px">' + escapeHtml(value) + '</textarea></div>';
}

function renderValidation(validation) {
  if (!validation) return "";
  return '<div class="panel"><div class="panel-header"><span class="panel-title">Validation</span><span class="badge ' + badgeClass(validation.status) + '">' + escapeHtml(validation.status) + '</span></div><div class="panel-body">' +
    validation.checks.map(function(check) {
      return '<div class="kv"><span>' + escapeHtml(check.name) + '</span><span class="' + (check.passed ? "" : "badge danger") + '">' + escapeHtml(check.message) + '</span></div>';
    }).join("") +
  '</div></div>';
}

function renderTimeline(event) {
  var msg = timelineMessageForDisplay(event);
  return '<div class="timeline-row"><strong>' + escapeHtml(event.type) + '</strong><br>' + escapeHtml(msg) + '<br><span>' + fmtTime(event.ts) + (event.actor ? ' by ' + escapeHtml(event.actor) : '') + '</span></div>';
}

function timelineMessageForDisplay(event) {
  var msg = event.message || '';
  if ((event.type === "implementation.completed" || event.type === "implementation.failed") && msg.length > 180) {
    var firstLine = msg.split(/\\r?\\n/).map(function(line) {
      return line.trim();
    }).find(function(line) {
      return line.length > 0;
    });
    return truncate(firstLine || msg, 180);
  }
  return msg;
}

function renderConversation(conversation) {
  if (!conversation && state.pendingNewSession) {
    return '<div class="panel"><div class="panel-body">' +
      '<div class="messages"><div class="empty">New session. Type a message to start.</div></div>' +
      '<div class="field"><label for="session-message">Message</label><textarea id="session-message" style="min-height:110px">' + escapeHtml(getDraft(PENDING_NEW_SESSION)) + '</textarea></div>' +
      '<div class="toolbar"><button class="primary" data-action="send-session-message" data-conversation-id="' + PENDING_NEW_SESSION + '">⬆</button></div>' +
    '</div></div>';
  }
  if (!conversation) {
    return '<div class="panel"><div class="panel-body"><div class="empty">No session selected.</div></div></div>';
  }
  const live = liveRunFor(conversation.id);
  const messages = renderCachedMessageSequence(conversation.messages) + renderLiveMessage(live, conversation.id);
  return '<div class="panel"><div class="panel-body">' +
    '<div class="messages">' + (messages.length === 0 ? '<div class="empty">No messages.</div>' : messages) + '</div>' +
    '<div class="field"><label for="session-message">Message</label><textarea id="session-message" style="min-height:110px">' + escapeHtml(getDraft(conversation.id)) + '</textarea></div>' +
    '<div class="toolbar"><button class="primary" data-action="send-session-message" data-conversation-id="' + escapeHtml(conversation.id) + '">⬆</button></div>' +
  '</div></div>';
}

function contextEntryToWebMessage(entry) {
  const message = entry.message || {};
  return {
    role: message.role,
    content: message.content,
    createdAt: entry.createdAt || "",
    toolCallId: message.toolCallId,
    toolCalls: message.toolCalls,
    reasoningContent: message.reasoningContent
  };
}

function renderMessageSequence(messages) {
  var html = "";
  var assistantRun = null;
  var flushAssistantRun = function() {
    if (assistantRun === null) return;
    html += renderAssistantRunMessage(assistantRun);
    assistantRun = null;
  };

  messages.forEach(function(message) {
    if (message.role === "user") {
      flushAssistantRun();
      html += renderMessage(message);
      return;
    }
    if (message.role === "assistant" || message.role === "tool") {
      if (assistantRun === null) {
        assistantRun = createAssistantRun(message);
      }
      appendAssistantRunMessage(assistantRun, message);
      return;
    }
    flushAssistantRun();
    html += renderMessage(message);
  });
  flushAssistantRun();
  return html;
}

function messageFingerprint(message) {
  if (!message) return "";
  return [
    message.role || "",
    message.createdAt || "",
    message.toolCallId || "",
    String(message.content || "").length,
    String(message.reasoningContent || "").length,
    message.toolCalls ? message.toolCalls.length : 0
  ].join(":");
}

function messageSequenceFingerprint(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "0";
  var first = messages[0];
  var last = messages[messages.length - 1];
  return [
    messages.length,
    messageFingerprint(first),
    messageFingerprint(last)
  ].join("|");
}

function renderCachedMessageSequence(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  var fingerprint = messageSequenceFingerprint(messages);
  var cached = renderedMessageSequenceCache.get(messages);
  if (cached && cached.fingerprint === fingerprint) {
    return cached.html;
  }
  var html = renderMessageSequence(messages);
  renderedMessageSequenceCache.set(messages, {
    fingerprint: fingerprint,
    html: html
  });
  return html;
}

function contextEntryFingerprint(entry) {
  if (!entry) return "";
  var message = entry.message || {};
  return [
    entry.createdAt || "",
    messageFingerprint(message)
  ].join(":");
}

function contextMessageSequenceFingerprint(entries, startIndex) {
  if (!Array.isArray(entries) || entries.length === 0) return "0";
  var firstVisible = entries[startIndex] || null;
  var last = entries[entries.length - 1];
  return [
    entries.length,
    startIndex,
    contextEntryFingerprint(firstVisible),
    contextEntryFingerprint(last)
  ].join("|");
}

function renderCachedContextMessageSequence(entries, maxMessages) {
  if (!Array.isArray(entries) || entries.length === 0) return "";
  var startIndex = Math.max(0, entries.length - maxMessages);
  var fingerprint = contextMessageSequenceFingerprint(entries, startIndex);
  var cached = renderedContextMessageSequenceCache.get(entries);
  if (cached && cached.fingerprint === fingerprint) {
    return cached.html;
  }
  var messages = [];
  for (var index = startIndex; index < entries.length; index += 1) {
    messages.push(contextEntryToWebMessage(entries[index]));
  }
  var html = renderMessageSequence(messages);
  renderedContextMessageSequenceCache.set(entries, {
    fingerprint: fingerprint,
    html: html
  });
  return html;
}

function createAssistantRun(message) {
  return {
    createdAt: message.createdAt || "",
    blocks: [],
    toolIndexById: {}
  };
}

function appendAssistantRunMessage(run, message) {
  if (!run.createdAt && message.createdAt) {
    run.createdAt = message.createdAt;
  }

  if (message.role === "assistant") {
    if (message.reasoningContent && message.reasoningContent.trim().length > 0) {
      run.blocks.push({
        type: "reasoning",
        text: message.reasoningContent
      });
    }
    if (message.content && message.content.trim().length > 0) {
      run.blocks.push({
        type: "text",
        text: message.content
      });
    }
    if (message.toolCalls && message.toolCalls.length > 0) {
      message.toolCalls.forEach(function(toolCall) {
        var label = formatToolCallDisplay(toolCall);
        var block = {
          type: "tool",
          id: toolCall.id || "",
          label: label,
          result: "",
          done: false,
          error: false
        };
        run.toolIndexById[block.id] = run.blocks.length;
        run.blocks.push(block);
      });
    }
    return;
  }

  if (message.role === "tool") {
    var toolCallId = message.toolCallId || "";
    var result = compactToolResult(message.content);
    var error = isToolResultError(message.content);
    var existingIndex = toolCallId ? run.toolIndexById[toolCallId] : undefined;
    if (existingIndex !== undefined && run.blocks[existingIndex]) {
      run.blocks[existingIndex] = Object.assign({}, run.blocks[existingIndex], {
        result: result,
        done: true,
        error: error
      });
      return;
    }
    run.blocks.push({
      type: "tool",
      id: toolCallId,
      label: "tool result",
      result: result,
      done: true,
      error: error
    });
  }
}

function renderAssistantRunMessage(run) {
  return '<div class="message assistant"><div class="message-role">assistant ' + fmtTime(run.createdAt) + '</div>' + renderRunBlocks(run.blocks || []) + '</div>';
}

function renderMarkdown(value) {
  var codeBlocks = [];
  var text = extractFencedCodeBlocks(String(value || ""), codeBlocks);
  var lines = normalizeNewlines(text).split("\\n");
  var html = [];
  var index = 0;
  while (index < lines.length) {
    var line = lines[index];
    var trimmed = line.trim();
    if (trimmed.length === 0) {
      index += 1;
      continue;
    }

    var codeIndex = markdownMarkerIndex(trimmed, "CODE");
    if (codeIndex >= 0 && codeBlocks[codeIndex] !== undefined) {
      html.push(renderCodeBlock(codeBlocks[codeIndex]));
      index += 1;
      continue;
    }

    if (isTableHeaderAt(lines, index)) {
      var table = renderTable(lines, index);
      html.push(table.html);
      index = table.nextIndex;
      continue;
    }

    var heading = parseHeading(line);
    if (heading !== null) {
      html.push('<h' + heading.level + ' class="md-heading md-heading-' + heading.level + '">' + processInline(heading.text) + '</h' + heading.level + '>');
      index += 1;
      continue;
    }

    if (isHorizontalRuleLine(line)) {
      html.push('<hr class="md-hr">');
      index += 1;
      continue;
    }

    var unordered = unorderedListItem(line);
    if (unordered !== null) {
      var unorderedList = renderList(lines, index, false);
      html.push(unorderedList.html);
      index = unorderedList.nextIndex;
      continue;
    }

    var ordered = orderedListItem(line);
    if (ordered !== null) {
      var orderedList = renderList(lines, index, true);
      html.push(orderedList.html);
      index = orderedList.nextIndex;
      continue;
    }

    if (isBlockquoteLine(line)) {
      var quote = renderBlockquote(lines, index);
      html.push(quote.html);
      index = quote.nextIndex;
      continue;
    }

    if (looksLikeAsciiDiagramLine(line)) {
      var diagram = renderAsciiDiagram(lines, index);
      html.push(diagram.html);
      index = diagram.nextIndex;
      continue;
    }

    var paragraph = renderParagraph(lines, index);
    html.push(paragraph.html);
    index = paragraph.nextIndex;
  }
  return html.join("");
}

function normalizeNewlines(value) {
  return String(value || "").split("\\r\\n").join("\\n").split("\\r").join("\\n");
}

function markdownMarker(kind, index) {
  return "%%PIBOT_MD_" + kind + "_" + index + "%%";
}

function markdownMarkerIndex(value, kind) {
  var prefix = "%%PIBOT_MD_" + kind + "_";
  var suffix = "%%";
  if (value.indexOf(prefix) !== 0) return -1;
  if (value.slice(value.length - suffix.length) !== suffix) return -1;
  var raw = value.slice(prefix.length, value.length - suffix.length);
  if (!isUnsignedInteger(raw)) return -1;
  return Number(raw);
}

function isUnsignedInteger(value) {
  if (value.length === 0) return false;
  for (var i = 0; i < value.length; i += 1) {
    var code = value.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function extractFencedCodeBlocks(value, blocks) {
  var fence = String.fromCharCode(96, 96, 96);
  var lines = normalizeNewlines(value).split("\\n");
  var output = [];
  var inBlock = false;
  var language = "";
  var buffer = [];
  for (var i = 0; i < lines.length; i += 1) {
    var line = lines[i];
    if (!inBlock && line.indexOf(fence) === 0) {
      inBlock = true;
      language = line.slice(fence.length).trim();
      buffer = [];
      continue;
    }
    if (inBlock && line.indexOf(fence) === 0) {
      blocks.push({
        language: language,
        code: buffer.join("\\n")
      });
      output.push(markdownMarker("CODE", blocks.length - 1));
      inBlock = false;
      language = "";
      buffer = [];
      continue;
    }
    if (inBlock) {
      buffer.push(line);
    } else {
      output.push(line);
    }
  }
  if (inBlock) {
    output.push(fence + language);
    buffer.forEach(function(bufferLine) {
      output.push(bufferLine);
    });
  }
  return output.join("\\n");
}

function renderCodeBlock(block) {
  var language = block.language && block.language.trim().length > 0
    ? '<div class="md-code-lang">' + escapeHtml(block.language.trim()) + '</div>'
    : "";
  return '<div class="md-codeblock">' + language + '<pre><code>' + escapeHtml(block.code || "") + '</code></pre></div>';
}

function isTableHeaderAt(lines, index) {
  var separatorIndex = nextNonEmptyLineIndex(lines, index + 1);
  return separatorIndex < lines.length &&
    isPipeRow(lines[index]) &&
    isTableSeparatorRow(lines[separatorIndex]);
}

function nextNonEmptyLineIndex(lines, index) {
  var current = index;
  while (current < lines.length && lines[current].trim().length === 0) {
    current += 1;
  }
  return current;
}

function isPipeRow(line) {
  var trimmed = line.trim();
  return trimmed.length >= 3 &&
    trimmed.charAt(0) === "|" &&
    trimmed.charAt(trimmed.length - 1) === "|" &&
    splitTableRow(trimmed).length > 1;
}

function isTableSeparatorRow(line) {
  var cells = splitTableRow(line);
  if (cells.length === 0) return false;
  return cells.every(function(cell) {
    var trimmed = cell.trim();
    var dashCount = 0;
    if (trimmed.length === 0) return false;
    for (var i = 0; i < trimmed.length; i += 1) {
      var ch = trimmed.charAt(i);
      if (ch === "-") {
        dashCount += 1;
      } else if (ch !== ":" && ch !== " ") {
        return false;
      }
    }
    return dashCount >= 1;
  });
}

function splitTableRow(line) {
  var trimmed = line.trim();
  if (trimmed.charAt(0) === "|") trimmed = trimmed.slice(1);
  if (trimmed.charAt(trimmed.length - 1) === "|") trimmed = trimmed.slice(0, -1);
  var cells = [];
  var cell = "";
  var escaping = false;
  for (var i = 0; i < trimmed.length; i += 1) {
    var ch = trimmed.charAt(i);
    if (escaping) {
      cell += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\\\") {
      escaping = true;
      cell += ch;
      continue;
    }
    if (ch === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function renderTable(lines, startIndex) {
  var separatorIndex = nextNonEmptyLineIndex(lines, startIndex + 1);
  var headers = splitTableRow(lines[startIndex]);
  var alignments = splitTableRow(lines[separatorIndex]).map(tableAlignment);
  var rows = [];
  var index = separatorIndex + 1;
  while (index < lines.length) {
    if (lines[index].trim().length === 0) {
      var nextIndex = nextNonEmptyLineIndex(lines, index + 1);
      if (nextIndex < lines.length && isPipeRow(lines[nextIndex])) {
        index = nextIndex;
        continue;
      }
      break;
    }
    if (!isPipeRow(lines[index])) {
      break;
    }
    rows.push(splitTableRow(lines[index]));
    index += 1;
  }
  var head = headers.map(function(cell, cellIndex) {
    return '<th' + tableAlignAttr(alignments[cellIndex]) + '>' + processInline(cell) + '</th>';
  }).join("");
  var body = rows.map(function(row) {
    var cells = headers.map(function(_header, cellIndex) {
      return '<td' + tableAlignAttr(alignments[cellIndex]) + '>' + processInline(row[cellIndex] || "") + '</td>';
    }).join("");
    return '<tr>' + cells + '</tr>';
  }).join("");
  return {
    html: '<div class="md-table-wrapper"><table class="md-table"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>',
    nextIndex: index
  };
}

function tableAlignment(value) {
  var trimmed = value.trim();
  var left = trimmed.charAt(0) === ":";
  var right = trimmed.charAt(trimmed.length - 1) === ":";
  if (left && right) return "center";
  if (right) return "right";
  return "";
}

function tableAlignAttr(value) {
  if (value === "center" || value === "right") {
    return ' style="text-align:' + value + '"';
  }
  return "";
}

function parseHeading(line) {
  var trimmed = line.trim();
  var level = 0;
  while (level < trimmed.length && trimmed.charAt(level) === "#" && level < 6) {
    level += 1;
  }
  if (level === 0) return null;
  if (trimmed.charAt(level) !== " ") return null;
  return {
    level: level,
    text: trimmed.slice(level + 1)
  };
}

function isHorizontalRuleLine(line) {
  var trimmed = line.trim();
  if (trimmed.length < 3) return false;
  var marker = trimmed.charAt(0);
  if (marker !== "-" && marker !== "*" && marker !== "_") return false;
  for (var i = 0; i < trimmed.length; i += 1) {
    if (trimmed.charAt(i) !== marker) return false;
  }
  return true;
}

function leadingTrim(value) {
  var index = 0;
  while (index < value.length && value.charAt(index) === " ") {
    index += 1;
  }
  return value.slice(index);
}

function unorderedListItem(line) {
  var trimmed = leadingTrim(line);
  if (trimmed.length < 3) return null;
  var marker = trimmed.charAt(0);
  if ((marker === "-" || marker === "*" || marker === "+") && trimmed.charAt(1) === " ") {
    return trimmed.slice(2);
  }
  return null;
}

function orderedListItem(line) {
  var trimmed = leadingTrim(line);
  var index = 0;
  while (index < trimmed.length) {
    var code = trimmed.charCodeAt(index);
    if (code < 48 || code > 57) break;
    index += 1;
  }
  if (index === 0 || trimmed.charAt(index) !== "." || trimmed.charAt(index + 1) !== " ") {
    return null;
  }
  return trimmed.slice(index + 2);
}

function renderList(lines, startIndex, ordered) {
  var tag = ordered ? "ol" : "ul";
  var items = [];
  var index = startIndex;
  while (index < lines.length) {
    var item = ordered ? orderedListItem(lines[index]) : unorderedListItem(lines[index]);
    if (item === null) break;
    items.push('<li>' + processInline(item) + '</li>');
    index += 1;
  }
  return {
    html: '<' + tag + ' class="md-list">' + items.join("") + '</' + tag + '>',
    nextIndex: index
  };
}

function isBlockquoteLine(line) {
  var trimmed = leadingTrim(line);
  return trimmed.charAt(0) === ">";
}

function renderBlockquote(lines, startIndex) {
  var parts = [];
  var index = startIndex;
  while (index < lines.length && isBlockquoteLine(lines[index])) {
    var trimmed = leadingTrim(lines[index]).slice(1);
    if (trimmed.charAt(0) === " ") trimmed = trimmed.slice(1);
    parts.push(processInline(trimmed));
    index += 1;
  }
  return {
    html: '<blockquote class="md-blockquote">' + parts.join("<br>") + '</blockquote>',
    nextIndex: index
  };
}

function looksLikeAsciiDiagramLine(line) {
  var trimmed = line.trim();
  if (trimmed.length < 3) return false;
  var structural = 0;
  var hasBoxDrawing = false;
  for (var i = 0; i < trimmed.length; i += 1) {
    var ch = trimmed.charAt(i);
    var code = trimmed.charCodeAt(i);
    if (code >= 0x2500 && code <= 0x257f) {
      structural += 1;
      hasBoxDrawing = true;
      continue;
    }
    if ("+-_|/\\\\<>=[]{}:*".indexOf(ch) >= 0) {
      structural += 1;
    }
  }
  return hasBoxDrawing || (structural >= 3 && structural / trimmed.length >= 0.35);
}

function renderAsciiDiagram(lines, startIndex) {
  var parts = [];
  var index = startIndex;
  while (index < lines.length && looksLikeAsciiDiagramLine(lines[index])) {
    parts.push(lines[index]);
    index += 1;
  }
  return {
    html: '<pre class="md-pre"><code>' + escapeHtml(parts.join("\\n")) + '</code></pre>',
    nextIndex: index
  };
}

function renderParagraph(lines, startIndex) {
  var parts = [];
  var index = startIndex;
  while (index < lines.length) {
    var line = lines[index];
    if (line.trim().length === 0) break;
    if (parts.length > 0 && startsMarkdownBlock(lines, index)) break;
    parts.push(processInline(line.trim()));
    index += 1;
  }
  return {
    html: '<p>' + parts.join("<br>") + '</p>',
    nextIndex: index
  };
}

function startsMarkdownBlock(lines, index) {
  var line = lines[index];
  var trimmed = line.trim();
  return markdownMarkerIndex(trimmed, "CODE") >= 0 ||
    isTableHeaderAt(lines, index) ||
    parseHeading(line) !== null ||
    isHorizontalRuleLine(line) ||
    unorderedListItem(line) !== null ||
    orderedListItem(line) !== null ||
    isBlockquoteLine(line) ||
    looksLikeAsciiDiagramLine(line);
}

function processInline(value) {
  var text = escapeHtml(value || "");
  text = applyInlineCode(text);
  text = applyPairedDelimiter(text, "**", "<strong>", "</strong>");
  text = applyPairedDelimiter(text, "__", "<strong>", "</strong>");
  return text;
}

function applyInlineCode(value) {
  var tick = String.fromCharCode(96);
  var parts = value.split(tick);
  if (parts.length < 3 || parts.length % 2 === 0) return value;
  var output = parts[0];
  for (var i = 1; i < parts.length; i += 1) {
    if (i % 2 === 1) {
      output += '<code class="md-inline-code">' + parts[i] + '</code>';
    } else {
      output += parts[i];
    }
  }
  return output;
}

function applyPairedDelimiter(value, delimiter, openTag, closeTag) {
  var parts = value.split(delimiter);
  if (parts.length < 3 || parts.length % 2 === 0) return value;
  var output = parts[0];
  for (var i = 1; i < parts.length; i += 1) {
    output += (i % 2 === 1 ? openTag : closeTag) + parts[i];
  }
  return output;
}

function renderRunBlocks(blocks, options) {
  if (!blocks || blocks.length === 0) return "";
  return '<div class="run-blocks">' + blocks.map(function(block, index) {
    return renderRunBlock(block, {
      live: options && options.live,
      isLast: index === blocks.length - 1
    });
  }).join("") + '</div>';
}

function renderRunBlock(block, options) {
  if (block.type === "reasoning") {
    return renderReasoningDetails(block.text || "", {
      live: options && options.live,
      open: options && options.live && options.isLast
    });
  }
  if (block.type === "text") {
    var maxChars = options && options.live ? LIVE_ASSISTANT_MAX_CHARS : undefined;
    var text = maxChars === undefined
      ? renderMarkdown(block.text || "")
      : renderLiveText(block.text || "", maxChars);
    return '<div class="assistant-text-block">' + text + '</div>';
  }
  if (block.type === "tool") {
    return renderToolBlock(block);
  }
  if (block.type === "approval" && block.approval) {
    return renderLiveApproval(block.approval);
  }
  return "";
}

function renderToolBlock(tool) {
  var cls = tool.error ? "tool-chip error" : (tool.done || tool.result ? "tool-chip done" : "tool-chip");
  var prefix = tool.done || tool.result ? (tool.error ? "✗ " : "✓ ") : "⌛ ";
  var text = tool.label || "tool";
  if (tool.result) {
    text += " | " + tool.result;
  }
  return '<div class="tool-stream"><span class="' + cls + '" title="' + escapeHtml(text) + '">' + prefix + escapeHtml(text) + '</span></div>';
}

function renderToolStream(tools) {
  if (!tools || tools.length === 0) return "";
  var chips = tools.map(function(tool) {
    var cls = tool.error ? "tool-chip error" : (tool.result ? "tool-chip done" : "tool-chip");
    var text = tool.label || "tool";
    if (tool.result) {
      text += " | " + tool.result;
    }
    return '<span class="' + cls + '" title="' + escapeHtml(text) + '">' + escapeHtml(text) + '</span>';
  }).join("");
  return '<div class="tool-stream">' + chips + '</div>';
}

function renderMessage(message) {
  var reasoning = "";
  if (message.reasoningContent && message.reasoningContent.trim().length > 0) {
    reasoning = renderReasoningDetails(message.reasoningContent);
  }
  var body = "";
  if (message.content && message.content.trim().length > 0) {
    body = '<div class="assistant-text-block">' + renderMarkdown(message.content) + '</div>';
  }
  if (message.toolCalls && message.toolCalls.length > 0) {
    var calls = message.toolCalls.map(function(tc) {
      var summary = formatToolCallSummary(tc);
      return '<div class="tool-call"><span class="tool-call-name">' + escapeHtml(tc.name) + '</span>' + (summary ? ' <span class="tool-call-summary">' + escapeHtml(summary) + '</span>' : '') + '</div>';
    }).join("");
    body += '<div class="tool-calls">' + calls + '</div>';
  }
  if (message.role === "tool") {
    body = '<div class="tool-result">' + escapeHtml(compactToolResult(message.content)).replace(/\\n/g, "<br>") + '</div>';
  }
  return '<div class="message ' + escapeHtml(message.role) + '"><div class="message-role">' + escapeHtml(message.role) + ' ' + fmtTime(message.createdAt) + '</div>' + reasoning + body + '</div>';
}

function formatToolCallDisplay(tc) {
  var summary = formatToolCallSummary(tc);
  return tc.name + (summary ? " " + summary : "");
}

function formatToolCallSummary(tc) {
  try {
    var args = JSON.parse(tc.argumentsJson);
    if (tc.name === "read") return args.path || "";
    if (tc.name === "bash") return truncate(args.command || "", 120);
    if (tc.name === "grep") return args.pattern || "";
    if (tc.name === "edit") return args.path || "";
    if (tc.name === "write") return args.path || "";
    if (tc.name === "agent_spawn") return (args.role || "") + " " + truncate(args.task || "", 80);
    if (tc.name === "memory_read") return (args.scope || "") + "/" + (args.document || "");
    if (tc.name === "memory_write") return (args.scope || "") + "/" + (args.document || "") + " " + truncate(args.reason || "", 80);
    return "";
  } catch (e) {
    return "";
  }
}

function compactToolResult(content) {
  if (!content || content.trim().length === 0) return "";
  try {
    var result = JSON.parse(content);
    if (result.ok === true) {
      var output = result.output;
      if (output && output.content) return "Read " + output.path + " (" + output.totalLines + " lines)";
      if (output && output.exitCode !== undefined) return "Command exited with code " + output.exitCode;
      if (output && output.changed !== undefined) return output.changed ? "File changed" : "No change";
      if (output && output.written !== undefined) return output.written ? "File written" : "File not written";
      if (result.matches !== undefined) return result.matches + " matches";
      if (result.message !== undefined) return result.message;
      if (result.conversation !== undefined) return "Conversation: " + result.conversation.title;
      return "OK";
    } else {
      return "Error: " + (result.error ? result.error.code || result.error.message : "unknown");
    }
  } catch (e) {
    return truncate(content, 200);
  }
}

function isToolResultError(content) {
  try {
    var result = JSON.parse(content);
    return result.ok === false;
  } catch (e) {
    return false;
  }
}

function visibleLiveText(value, maxChars) {
  var text = String(value || "");
  if (text.length <= maxChars) {
    return text;
  }
  return "...\\n" + text.slice(text.length - maxChars);
}

function renderLiveText(value, maxChars) {
  return escapeHtml(visibleLiveText(value, maxChars)).replace(/\\n/g, "<br>");
}

function liveMessageElementFor(conversationId) {
  var elements = app.querySelectorAll("[data-live-conversation-id]");
  for (var index = 0; index < elements.length; index += 1) {
    if (elements[index].dataset.liveConversationId === conversationId) {
      return elements[index];
    }
  }
  return null;
}

function renderLiveMessageContents(live) {
  const hasBlocks = live && live.blocks && live.blocks.length > 0;
  const body = hasBlocks
    ? renderRunBlocks(live.blocks, { live: true })
    : '<span class="empty">Thinking...</span>';
  var status = "";
  if (live && live.statusLines.length > 0) {
    status = '<div class="live-status">' + live.statusLines.map(escapeHtml).join("<br>") + '</div>';
  }
  return '<div class="message-role">assistant live</div>' + body + status;
}

function renderLiveRunElement(conversationId) {
  const live = liveRunFor(conversationId);
  const element = liveMessageElementFor(conversationId);
  if (!live || !element) return false;
  const mainScroll = getMainScrollContainer();
  const shouldStick = mainScroll &&
    state.autoScrollMain &&
    !mainScroll.classList.contains("ticket-workspace-content") &&
    isNearBottom(mainScroll);
  element.innerHTML = renderLiveMessageContents(live);
  if (shouldStick) {
    mainScroll.scrollTop = mainScroll.scrollHeight;
  }
  return true;
}

function renderReasoningDetails(value, options) {
  const live = options && options.live;
  const open = options && options.open;
  const content = live
    ? renderLiveText(value, LIVE_REASONING_MAX_CHARS)
    : escapeHtml(value).replace(/\\n/g, "<br>");
  return '<details class="reasoning' + (live ? ' live-reasoning' : '') + '"' + (open ? ' open' : '') + '><summary>Thinking process</summary><div class="reasoning-body">' + content + '</div></details>';
}

function renderLiveMessage(live, conversationId) {
  if (live === null) return "";
  return '<div class="message assistant live" data-live-conversation-id="' + escapeHtml(conversationId || "") + '">' + renderLiveMessageContents(live) + '</div>';
}

function renderLiveApprovals(live) {
  if (!live.approvals || live.approvals.length === 0) return "";
  return '<div class="approval-list">' + live.approvals.map(renderLiveApproval).join("") + '</div>';
}

function renderLiveApproval(approval) {
  var pending = approval.status === "pending";
  var pendingKey = "approval:" + approval.id;
  var label = pendingLabel(pendingKey);
  var details = approval.details && approval.details.length > 0
    ? '<div class="approval-details">' + approval.details.map(function(detail) {
        return '<div>' + escapeHtml(detail) + '</div>';
      }).join("") + '</div>'
    : "";
  var status = pending
    ? '<span class="badge warn">' + escapeHtml(approval.risk || "approval") + '</span>'
    : '<span class="badge ' + (approval.status === "approved" ? "ok" : "danger") + '">' + escapeHtml(approval.status) + '</span>';
  var runActions = approval.runScopeAllowed
    ? '<button data-action="approve-web-approval" data-approval-scope="run" data-approval-id="' + escapeHtml(approval.id) + '"' + disabledAttr(!!label) + '>Allow for run</button><button data-action="reject-web-approval" data-approval-scope="run" data-approval-id="' + escapeHtml(approval.id) + '"' + disabledAttr(!!label) + '>Deny for run</button>'
    : '';
  var actions = pending
    ? '<div class="toolbar"><button class="primary" data-action="approve-web-approval" data-approval-scope="once" data-approval-id="' + escapeHtml(approval.id) + '"' + disabledAttr(!!label) + '>Allow once</button>' + runActions + '<button class="danger" data-action="reject-web-approval" data-approval-scope="once" data-approval-id="' + escapeHtml(approval.id) + '"' + disabledAttr(!!label) + '>Reject once</button></div>'
    : '<div class="approval-summary">' + escapeHtml(approval.resolvedMessage || approval.status) + '</div>';
  return '<div class="approval-request' + (pending ? '' : ' resolved') + '">' +
    '<div class="approval-head"><span class="approval-title">' + escapeHtml(approval.title || "Approval required") + '</span>' + status + '</div>' +
    '<div class="approval-summary">' + escapeHtml(approval.summary || "") + '</div>' +
    details +
    actions +
  '</div>';
}

function renderInspector(ticket) {
  const snapshot = state.snapshot || { selfInstructions: "", selfVersions: [], runtimeVersions: [], signals: [] };
  if (!ticket) {
    return renderRuntimeVersionsPanel(snapshot) +
      '<div class="panel" style="margin-top:12px"><div class="panel-header"><span class="panel-title">Self-Instructions</span></div><div class="panel-body"><div class="codebox">' + escapeHtml(snapshot.selfInstructions || "") + '</div></div></div>' +
      renderSelfInstructionVersionsPanel(snapshot);
  }
  const version = runtimeVersionForTicket(ticket);
  const selfInstructionVersion = selfInstructionVersionForTicket(ticket);
  return '<div class="panel"><div class="panel-header"><span class="panel-title">Ticket</span></div><div class="panel-body">' +
    '<div class="kv"><span>Ticket</span><span title="' + escapeHtml(ticket.id) + '">' + escapeHtml(ticketDisplayId(ticket)) + '</span></div>' +
    '<div class="kv"><span>Raw ID</span><span>' + escapeHtml(ticket.id) + '</span></div>' +
    '<div class="kv"><span>Created</span><span>' + fmtTime(ticket.createdAt) + '</span></div>' +
    '<div class="kv"><span>Updated</span><span>' + fmtTime(ticket.updatedAt) + '</span></div>' +
    '<div class="kv"><span>Signals</span><span>' + ticket.signalIds.length + '</span></div>' +
    (version ? '<div class="kv"><span>Version</span><span title="' + escapeHtml(version.id) + '">' + escapeHtml(runtimeVersionLabel(version)) + (isRuntimeVersionActive(version.id) ? ' active' : '') + '</span></div>' : '') +
    (selfInstructionVersion ? '<div class="kv"><span>Version</span><span title="' + escapeHtml(selfInstructionVersion.id) + '">' + escapeHtml(selfInstructionVersion.topic || selfInstructionVersion.label || selfInstructionVersion.id) + '</span></div>' : '') +
    (ticket.activation ? '<div class="kv"><span>Activation</span><span>' + fmtTime(ticket.activation.requestedAt) + '</span></div>' : '') +
  '</div></div>' +
  renderRuntimeVersionsPanel(snapshot) +
  renderSelfInstructionVersionsPanel(snapshot);
}

function renderRuntimeVersionsPanel(snapshot) {
  const versions = (snapshot.runtimeVersions || []).slice().reverse();
  return '<div class="panel" style="margin-top:12px"><div class="panel-header"><span class="panel-title">Runtime Versions</span><span class="panel-actions"><span class="badge">' + versions.length + '</span></span></div><div class="panel-body">' +
    (versions.length === 0 ? '<div class="empty">No runtime versions yet.</div>' : versions.map(renderRuntimeVersion).join("")) +
  '</div></div>';
}

function renderRuntimeVersion(version) {
  const active = isRuntimeVersionActive(version.id);
  const pendingActivation = isRuntimeVersionPendingActivation(version.id);
  const pending = pendingLabel("runtime-version:" + version.id);
  const confirmPending = pendingLabel("runtime-confirm:" + version.id);
  const label = runtimeVersionLabel(version);
  const sourceTicket = ticketById(version.sourceTicketId);
  const sourceLabel = sourceTicket ? ticketDisplayId(sourceTicket) : version.sourceTicketId;
  const action = pendingActivation
    ? '<button class="' + pendingClass(confirmPending).trim() + '" data-action="confirm-runtime-version" data-version-id="' + escapeHtml(version.id) + '"' + disabledAttr(!!confirmPending) + '>' + (confirmPending || "Confirm Version") + '</button>'
    : '<button class="' + (active ? 'primary' : pendingClass(pending).trim()) + '" data-action="activate-version" data-version-id="' + escapeHtml(version.id) + '"' + disabledAttr(active || !!pending) + '>' + (active ? "Active Version" : (pending || "Activate Version")) + '</button>';
  const deleteButton = '<button class="session-delete" title="Delete runtime version" aria-label="Delete runtime version" data-action="delete-runtime-version" data-version-id="' + escapeHtml(version.id) + '"' + disabledAttr(active || pendingActivation || !!pending || !!confirmPending) + '>×</button>';
  return '<div class="item runtime-version-item">' + deleteButton +
    '<div class="item-title">' + escapeHtml(runtimeVersionTitle(version)) + '</div>' +
    '<div class="item-meta"><span>' + escapeHtml(label) + '</span><span>' + fmtShortTime(version.createdAt) + '</span></div>' +
    '<div class="item-meta"><span title="' + escapeHtml(version.sourceTicketId) + '">' + escapeHtml(sourceLabel) + '</span></div>' +
    action + '</div>';
}

function renderSelfInstructionVersionsPanel(snapshot) {
  const versions = (snapshot.selfVersions || []).slice().reverse();
  return '<div class="panel" style="margin-top:12px"><div class="panel-header"><span class="panel-title">Self-Instruction Versions</span><span class="badge">' + versions.length + '</span></div><div class="panel-body">' +
    (versions.length === 0 ? '<div class="empty">No self-instruction versions.</div>' : versions.map(renderVersion).join("")) +
  '</div></div>';
}

function renderVersion(version) {
  const pending = pendingLabel("version:" + version.id);
  return '<div class="item"><div class="item-title">' + escapeHtml(version.topic || version.label) + '</div><div class="item-meta"><span>' + escapeHtml(version.label) + '</span></div><div class="item-meta"><span>' + escapeHtml(version.id) + '</span></div><div class="item-meta"><span>' + fmtTime(version.createdAt) + '</span></div><div class="item-toolbar"><button class="' + pendingClass(pending).trim() + '" data-action="rollback-version" data-version-id="' + escapeHtml(version.id) + '"' + disabledAttr(!!pending) + '>' + (pending || "Activate Version") + '</button><button class="session-delete" title="Delete self-instruction version" aria-label="Delete self-instruction version" data-action="delete-self-version" data-version-id="' + escapeHtml(version.id) + '"' + disabledAttr(!!pending) + '>×</button></div></div>';
}

async function renameConversation(conversationId, title, options) {
  const result = await api("/api/conversations/" + encodeURIComponent(conversationId), {
    method: "PATCH",
    body: JSON.stringify({ title: title })
  });
  const shouldSelect = !(options && options.select === false);
  upsertConversation(result.conversation, shouldSelect ? { select: true } : undefined);
  if (shouldSelect) {
    state.selectedConversationId = result.conversation.id;
    state.view = "sessions";
  }
  render();
}

async function promptRenameConversation(conversationId) {
  const conversation = state.conversations.find(function(item) { return item.id === conversationId; });
  if (!conversation) return false;
  const title = window.prompt("Rename session", conversation.title);
  if (title === null) return false;
  const trimmed = title.trim();
  if (!trimmed || trimmed === conversation.title) return false;
  await renameConversation(conversationId, trimmed);
  return true;
}

function generateAutoTitle(content) {
  var trimmed = content.trim();
  if (!trimmed) return "";
  // Strip common markdown formatting noise
  var bt = String.fromCharCode(96);
  var cleaned = trimmed
    .replace(new RegExp("^" + bt + "{3}[\\s\\S]*?" + bt + "{3}", "g"), "")
    .replace(new RegExp(bt + "{1,3}([^" + bt + "]+)" + bt + "{1,3}", "g"), "$1")
    .replace(/^[#*>-]+\s*/gm, "")
    .trim();
  if (!cleaned) cleaned = trimmed;
  var pibotIntentTitle = generatePibotIntentTitle(cleaned);
  if (pibotIntentTitle) return pibotIntentTitle;
  // Take the first sentence or line (support CJK punctuation)
  var newline = String.fromCharCode(10);
  var sentenceParts = cleaned.split(new RegExp("[.!?\\u3002\\uff01\\uff1f" + newline + "]"));
  var firstSentence = "";
  for (var i = 0; i < sentenceParts.length; i++) {
    var part = sentenceParts[i].trim();
    if (part) { firstSentence = part; break; }
  }
  if (!firstSentence) firstSentence = cleaned.substring(0, 40).trim();
  // Truncate to a concise title (target ~25 chars max)
  var maxLen = 25;
  if (firstSentence.length > maxLen) {
    var truncated = firstSentence.substring(0, maxLen);
    // Try to break at word boundary for Latin scripts
    var lastSpace = truncated.lastIndexOf(" ");
    if (lastSpace > 10) {
      truncated = truncated.substring(0, lastSpace);
    }
    return truncated + "\u2026";
  }
  return firstSentence;
}

function generatePibotIntentTitle(content) {
  var text = String(content || "").trim();
  if (!/(pibot|自进化|self[-\s]?evolution|web\s?ui|webui|会话|session|页面|界面|标题|命名)/iu.test(text)) {
    return "";
  }
  var mentionsPibotOrWebUi = /(pibot|自进化|self[-\s]?evolution|web\s?ui|webui)/iu.test(text);
  var mentionsTitle = /(会话.*(命名|标题)|命名.*会话|标题.*会话|session.*title|title.*session|rename|重命名)/iu.test(text);
  var mentionsFirstTurnPage = /(第一个问题|首个问题|第一轮|首轮|回答结束|结束时|页面.*(出问题|异常|坏|错|空白|刷新)|界面.*(出问题|异常|坏|错|空白|刷新))/iu.test(text);
  var wantsFix = /(修复|解决|改进|改善|不好|出问题|异常|坏|错|fix|improve|broken|bad)/iu.test(text);
  if (mentionsTitle && mentionsFirstTurnPage) return "修复会话命名与页面";
  if (mentionsTitle && (mentionsPibotOrWebUi || wantsFix)) return "修复会话命名";
  if (mentionsFirstTurnPage && (mentionsPibotOrWebUi || wantsFix)) return "修复首轮页面刷新";
  if (mentionsPibotOrWebUi && wantsFix) return "改进 pibot 自进化";
  return "";
}

function maybeAutoNameConversation(conversationId, content) {
  improveConversationTitle(conversationId, content).catch(function() {});
}

async function improveConversationTitle(conversationId, content) {
  var conversation = state.conversations.find(function(item) { return item.id === conversationId; });
  if (!shouldAutoGenerateConversationTitle(conversation, content)) return;
  var modelTitle = await fetchModelGeneratedTitle(conversationId, content);
  conversation = state.conversations.find(function(item) { return item.id === conversationId; });
  if (!shouldAutoGenerateConversationTitle(conversation, content)) return;
  if (modelTitle && modelTitle !== conversation.title) {
    await renameConversation(conversationId, modelTitle, { select: false });
    return;
  }
}

function shouldAutoGenerateConversationTitle(conversation, content) {
  if (!conversation) return false;
  // Allow auto-generation for early conversations (up to ~3 exchanges);
  // the heuristic-title match below prevents overwriting manually renamed titles.
  if (Array.isArray(conversation.messages) && conversation.messages.length > 6) return false;
  var title = String(conversation.title || "").trim();
  if (isPlaceholderConversationTitle(title)) return true;
  var heuristicTitle = generateAutoTitle(content);
  return !!heuristicTitle && title === heuristicTitle;
}

function isPlaceholderConversationTitle(title) {
  var normalized = String(title || "").trim();
  return normalized === "Web session" || normalized === "Untitled session";
}

async function fetchModelGeneratedTitle(conversationId, content) {
  var timeout = null;
  try {
    var controller = new AbortController();
    timeout = setTimeout(function() { controller.abort(); }, 20000);
    var response = await fetch("/api/conversations/" + encodeURIComponent(conversationId) + "/generate-title", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: content }),
      signal: controller.signal
    });
    if (!response.ok) return "";
    var data = await response.json();
    if (data.generated && data.title) {
      return String(data.title).trim();
    }
    return "";
  } catch (e) {
    return "";
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

document.addEventListener("wheel", function(event) {
  const scrollEl = mainScrollContainerForEventTarget(event.target);
  if (!scrollEl) return;
  markMainScrollActivity();
  if (event.deltaY < 0) {
    state.autoScrollMain = false;
    return;
  }
  if (event.deltaY > 0) {
    window.requestAnimationFrame(function() {
      updateMainAutoScroll(scrollEl);
    });
  }
}, { passive: true });

document.addEventListener("scroll", function(event) {
  const scrollEl = mainScrollContainerForEventTarget(event.target);
  if (!scrollEl) return;
  updateMainAutoScroll(scrollEl);
}, true);

document.addEventListener("keydown", function(event) {
  if (!["ArrowUp", "PageUp", "Home", "ArrowDown", "PageDown", "End"].includes(event.key)) {
    return;
  }
  const scrollEl = getMainScrollContainer();
  if (!scrollEl) return;
  markMainScrollActivity();
  if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") {
    state.autoScrollMain = false;
    return;
  }
  window.requestAnimationFrame(function() {
    updateMainAutoScroll(scrollEl);
  });
});

document.addEventListener("keydown", function(event) {
  if (event.key !== "Enter") return;
  if (event.isComposing || composingTextFieldId) return;
  if (event.shiftKey) return;
  const textarea = event.target;
  if (!textarea || textarea.id !== "session-message") return;
  if (textarea.disabled) return;
  event.preventDefault();
  const conversationId = state.selectedConversationId;
  if (!conversationId) return;
  state.actionError = null;
  sendSessionMessageFromInput(conversationId).catch(function(error) {
    state.actionError = errorMessage(error);
    render();
  });
});

document.addEventListener("input", function(event) {
  const target = event.target;
  if (!target || target.id !== "session-message") return;
  if (!state.selectedConversationId) return;
  state.drafts[state.selectedConversationId] = target.value;
});

document.addEventListener("compositionstart", function(event) {
  const target = event.target;
  if (!isTextField(target) || !target.id) return;
  composingTextFieldId = target.id;
});

document.addEventListener("compositionend", function(event) {
  const target = event.target;
  if (target && target.id === "session-message" && state.selectedConversationId) {
    state.drafts[state.selectedConversationId] = target.value;
  }
  if (!target || target.id === composingTextFieldId) {
    composingTextFieldId = "";
  }
  if (renderDeferredDuringComposition) {
    renderDeferredDuringComposition = false;
    scheduleRender();
  }
});

document.addEventListener("click", function(event) {
  const btn = event.target.closest(".file-picker-btn");
  if (!btn) return;
  const targetId = btn.dataset.target;
  if (!targetId) return;
  const input = document.getElementById(targetId);
  if (input) input.click();
});

document.addEventListener("change", function(event) {
  const input = event.target.closest("#skill-import-files");
  if (input) {
    const label = document.getElementById("skill-import-files-label");
    if (!input.files || input.files.length === 0) {
      state.skillImportFiles = [];
      state.skillImportFolderName = "";
      if (label) label.textContent = "No folder chosen";
      return;
    }
    const files = Array.from(input.files);
    const first = files[0];
    const relative = first.webkitRelativePath || first.name;
    const folderName = relative.indexOf("/") !== -1 ? relative.slice(0, relative.indexOf("/")) : relative;
    state.skillImportFiles = files;
    state.skillImportFolderName = folderName;
    if (label) {
      label.textContent = folderName + " (" + files.length + " file" + (files.length === 1 ? "" : "s") + ")";
    }
    return;
  }
  const overwrite = event.target.closest("#skill-import-overwrite");
  if (overwrite) {
    state.skillImportOverwrite = !!overwrite.checked;
  }
});

document.addEventListener("change", async function(event) {
  const select = event.target.closest("#model-selector");
  if (!select || !select.value || !state.models) return;
  if (select.value === state.models.active) return;
  state.actionError = null;
  try {
    await withPending("model-select", "Switching model...", async function() {
      state.models = await api("/api/models/select", {
        method: "POST",
        body: JSON.stringify({ model: select.value })
      });
    });
  } catch (error) {
    state.actionError = errorMessage(error);
    render();
  }
});

document.addEventListener("click", async function(event) {
  const target = event.target.closest("[data-view],[data-ticket-id],[data-conversation-id],[data-action]");
  if (!target) return;
  if (target.dataset.view) {
    saveDraft();
    state.actionError = null;
    state.view = target.dataset.view;
    if (state.view === "evolution") {
      state.evolutionPane = "tickets";
    }
    state.autoScrollMain = true;
    render();
    return;
  }
  if (target.dataset.ticketId && !target.dataset.action) {
    saveDraft();
    state.actionError = null;
    state.view = "evolution";
    state.selectedTicketId = target.dataset.ticketId;
    state.evolutionPane = "tickets";
    state.autoScrollMain = true;
    render();
    return;
  }
  if (target.dataset.conversationId && !target.dataset.action) {
    saveDraft();
    state.actionError = null;
    state.view = "sessions";
    state.selectedConversationId = target.dataset.conversationId;
    state.pendingNewSession = false;
    state.autoScrollMain = true;
    if (event.detail >= 2) {
      try {
        const renamed = await promptRenameConversation(target.dataset.conversationId);
        if (renamed) await refresh();
        else render();
      } catch (error) {
        state.actionError = errorMessage(error);
        render();
      }
      return;
    }
    render();
    return;
  }
  if (!target.dataset.action) return;
  if (target.disabled) return;
  if (target.dataset.action !== "dismiss-action-error") {
    state.actionError = null;
  }
  const pendingKey = actionKeyForTarget(target.dataset.action, target);
  if (pendingKey && pendingLabel(pendingKey)) return;
  try {
    const shouldRefresh = await handleAction(target);
    if (shouldRefresh !== false) {
      await refresh();
    }
  } catch (error) {
    await refresh({ showLoading: false });
    state.actionError = errorMessage(error);
    render();
  }
});

async function streamSessionMessage(conversationId, content) {
  const live = ensureLiveRun(conversationId);
  live.assistantText = "";
  live.toolChips = [];
  live.statusLines = ["Sending..."];
  state.selectedConversationId = conversationId;
  state.view = "sessions";
  state.autoScrollMain = true;
  render();

  try {
    const response = await fetch("/api/conversations/" + encodeURIComponent(conversationId) + "/messages?stream=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "user", content: content })
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    if (response.status === 202) {
      await streamDetachedRun(conversationId, await response.json());
      return;
    }
    if (!response.body) {
      clearLiveRun(conversationId);
      await refresh();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split("\\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        applyStreamLine(conversationId, line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      applyStreamLine(conversationId, buffer);
    }
  } catch (error) {
    clearLiveRun(conversationId);
    renderRunNow(conversationId);
    throw error;
  }
}

async function streamDetachedRun(conversationId, accepted) {
  var runId = accepted.runId;
  var eventsUrl = accepted.eventsUrl || ("/api/runs/" + encodeURIComponent(runId) + "/events");
  var cursor = Number.isSafeInteger(accepted.eventCursor) ? accepted.eventCursor : 0;
  var lastEventId = runId + ":" + cursor;
  var terminal = false;
  var retryMs = 500;

  while (!terminal) {
    try {
      const response = await fetch(eventsUrl, {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          "Last-Event-ID": lastEventId
        }
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      if (!response.body) {
        throw new Error("Detached run event stream is unavailable");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!terminal) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        const normalized = buffer.replace(/\\r\\n/g, "\\n");
        const blocks = normalized.split("\\n\\n");
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          const parsed = parseSseEvent(block);
          if (!parsed) continue;
          if (parsed.id) lastEventId = parsed.id;
          terminal = parsed.event.type === "done" || parsed.event.type === "error";
          applyStreamEvent(conversationId, parsed.event);
        }
      }
      buffer += decoder.decode();
      if (!terminal && buffer.trim().length > 0) {
        const parsed = parseSseEvent(buffer);
        if (parsed) {
          if (parsed.id) lastEventId = parsed.id;
          terminal = parsed.event.type === "done" || parsed.event.type === "error";
          applyStreamEvent(conversationId, parsed.event);
        }
      }
      if (terminal) return;

      const snapshot = await api("/api/runs/" + encodeURIComponent(runId));
      const status = snapshot.run && snapshot.run.status;
      if (["succeeded", "failed", "blocked", "cancelled"].includes(status)) {
        clearLiveRun(conversationId);
        await refresh({ showLoading: false });
        if (status !== "succeeded") {
          throw new Error(snapshot.run.terminalReason || ("Detached run " + status));
        }
        return;
      }
    } catch (error) {
      if (terminal) throw error;
      const live = ensureLiveRun(conversationId);
      pushLiveStatus(live, "Connection lost; reconnecting to background run...");
      scheduleLiveRender(conversationId);
      await sleep(retryMs);
      retryMs = Math.min(retryMs * 2, 5000);
      continue;
    }
    retryMs = 500;
  }
}

function parseSseEvent(block) {
  const lines = block.split("\\n");
  let id = "";
  const data = [];
  for (const line of lines) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("id:")) {
      id = line.slice(3).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  if (data.length === 0) return null;
  return { id: id, event: JSON.parse(data.join("\\n")) };
}

async function sendSessionControlMessage(conversationId, content) {
  const result = await api("/api/conversations/" + encodeURIComponent(conversationId) + "/messages", {
    method: "POST",
    body: JSON.stringify({ role: "user", content: content })
  });
  if (result.conversation) {
    upsertConversation(result.conversation);
  }
  if (result.evolution) {
    state.snapshot = Object.assign({}, result.evolution, {
      context: result.context || result.evolution.context,
      runtimeActivation: result.evolution.runtimeActivation || (state.snapshot && state.snapshot.runtimeActivation)
    });
  }
  scheduleRunRender(conversationId);
}

async function sendApprovalDecision(approvalId, approved, scope) {
  var pendingKey = "approval:" + approvalId;
  await withPending(pendingKey, approved ? "Approving..." : "Rejecting...", async function() {
    const result = await api("/api/approvals/" + encodeURIComponent(approvalId), {
      method: "POST",
      body: JSON.stringify({ approved: approved, scope: scope || "once" })
    });
    if (result.approval && result.approval.conversationId) {
      var live = ensureLiveRun(result.approval.conversationId);
      upsertLiveApproval(live, result.approval);
      scheduleLiveRender(result.approval.conversationId);
    }
  });
}

async function importSelectedSkill() {
  const selectedFiles = (state.skillImportFiles || []).slice();
  if (selectedFiles.length === 0) {
    throw new Error("Select a Skill folder first.");
  }
  const files = [];
  for (var index = 0; index < selectedFiles.length; index++) {
    const file = selectedFiles[index];
    files.push({
      path: file.webkitRelativePath || file.name,
      content: await file.text()
    });
  }
  const result = await api("/api/skills/import", {
    method: "POST",
    body: JSON.stringify({
      files: files,
      overwrite: state.skillImportOverwrite
    })
  });
  if (result.skills) {
    state.skills = result.skills;
  }
  state.skillImportFiles = [];
  state.skillImportFolderName = "";
  state.skillImportOverwrite = false;
}

async function streamEvolutionImplementation(ticketId) {
  const live = ensureLiveRun(EVOLUTION_CONVERSATION_ID);
  live.assistantText = "";
  live.reasoningText = "";
  live.approvals = [];
  live.blocks = [];
  live.toolChips = [];
  live.statusLines = ["Starting implementation..."];
  state.activeEvolutionTicketId = ticketId;
  state.selectedTicketId = ticketId;
  state.evolutionPane = "context";
  state.view = "evolution";
  state.autoScrollMain = true;
  render();

  try {
    const response = await fetch("/api/evolution/tickets/" + encodeURIComponent(ticketId) + "/implementation?stream=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    if (response.status === 202) {
      await streamDetachedRun(EVOLUTION_CONVERSATION_ID, await response.json());
      return;
    }
    if (!response.body) {
      clearLiveRun(EVOLUTION_CONVERSATION_ID);
      await refresh();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split("\\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        applyStreamLine(EVOLUTION_CONVERSATION_ID, line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      applyStreamLine(EVOLUTION_CONVERSATION_ID, buffer);
    }
  } catch (error) {
    clearLiveRun(EVOLUTION_CONVERSATION_ID);
    renderRunNow(EVOLUTION_CONVERSATION_ID);
    throw error;
  } finally {
    state.activeEvolutionTicketId = null;
  }
}

function applyStreamLine(conversationId, line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  const event = JSON.parse(trimmed);
  applyStreamEvent(conversationId, event);
}

function applyStreamEvent(conversationId, event) {
  if (event.type === "run_start") {
    const live = ensureLiveRun(conversationId);
    live.runId = event.runId || null;
    live.userTurnId = event.userTurnId || null;
    live.assistantText = "";
    live.reasoningText = "";
    live.approvals = [];
    live.blocks = [];
    live.toolChips = [];
    live.statusLines = [];
    scheduleRunRender(conversationId);
    return;
  }
  if (event.type === "conversation") {
    upsertConversation(event.conversation);
    if (
      liveRunFor(conversationId) &&
      liveMessageElementFor(conversationId) &&
      lastConversationMessageRole(event.conversation) !== "user"
    ) {
      scheduleLiveRender(conversationId);
      return;
    }
    scheduleRunRender(conversationId);
    return;
  }
  if (event.type === "agent_event") {
    applyAgentLoopStreamEvent(conversationId, event.event);
    return;
  }
  if (event.type === "status") {
    const live = ensureLiveRun(conversationId);
    pushLiveStatus(live, event.message || "Working...");
    scheduleLiveRender(conversationId);
    return;
  }
  if (event.type === "approval_requested") {
    const live = ensureLiveRun(conversationId);
    upsertLiveApproval(live, event.approval);
    pushLiveStatus(live, "Approval required.");
    scheduleLiveRender(conversationId);
    return;
  }
  if (event.type === "approval_resolved") {
    const live = ensureLiveRun(conversationId);
    upsertLiveApproval(live, event.approval);
    pushLiveStatus(live, event.approval.resolvedMessage || "Approval completed.");
    scheduleLiveRender(conversationId);
    return;
  }
  if (event.type === "done") {
    if (event.conversation) {
      upsertConversation(event.conversation);
    }
    if (event.evolution) {
      state.snapshot = Object.assign({}, event.evolution, {
        context: event.context || event.evolution.context,
        runtimeActivation: event.evolution.runtimeActivation || (state.snapshot && state.snapshot.runtimeActivation)
      });
      if (event.run && event.run.evolutionTicketId) {
        state.selectedTicketId = event.run.evolutionTicketId;
      }
    } else if (event.context) {
      state.snapshot = Object.assign({}, state.snapshot || {}, {
        context: event.context
      });
    }
    clearLiveRun(conversationId);
    if (conversationId === EVOLUTION_CONVERSATION_ID && state.view === "evolution") {
      render();
    } else {
      renderRunNow(conversationId);
    }
    return;
  }
  if (event.type === "error") {
    clearLiveRun(conversationId);
    throw new Error(event.error || "Agent stream failed");
  }
}

function applyAgentLoopStreamEvent(conversationId, event) {
  const live = ensureLiveRun(conversationId);
  if (event.type === "message_delta") {
    live.assistantText += event.text || "";
    appendLiveTextBlock(live, "text", event.text || "");
    live.statusLines = live.statusLines.filter(function(line) {
      return line !== "Thinking..." && line !== "Sending...";
    });
    scheduleLiveRender(conversationId, { delayMs: LIVE_STREAM_RENDER_DELAY_MS });
    return;
  }
  if (event.type === "reasoning_delta") {
    live.reasoningText += event.text || "";
    appendLiveTextBlock(live, "reasoning", event.text || "");
    scheduleLiveRender(conversationId, { delayMs: LIVE_REASONING_RENDER_DELAY_MS });
    return;
  }
  if (event.type === "tool_start") {
    var summary = event.call.summary || event.call.name;
    live.toolChips.push({ text: summary, done: false, error: false });
    appendLiveBlock(live, {
      type: "tool",
      id: event.call.id || "",
      label: summary,
      result: "",
      done: false,
      error: false
    });
    scheduleLiveRender(conversationId);
    return;
  }
  if (event.type === "tool_end") {
    var resultSummary = event.result.summary || (event.result.ok ? "OK" : "Failed");
    var isError = !event.result.ok;
    // Replace the pending chip with a completed one
    var lastPending = -1;
    for (var i = live.toolChips.length - 1; i >= 0; i--) {
      if (!live.toolChips[i].done) {
        lastPending = i;
        break;
      }
    }
    if (lastPending >= 0) {
      live.toolChips[lastPending] = { text: resultSummary, done: true, error: isError };
    } else {
      live.toolChips.push({ text: resultSummary, done: true, error: isError });
    }
    updateLiveToolBlock(live, event.call && event.call.id, resultSummary, isError);
    scheduleLiveRender(conversationId);
    return;
  }
  if (event.type === "agent_end" && event.error) {
    pushLiveStatus(live, "Agent error (" + event.error.code + "). " + event.error.message);
    scheduleLiveRender(conversationId);
  }
}

async function sendSessionMessageFromInput(conversationId) {
  const textarea = document.getElementById("session-message");
  if (!textarea) return;
  const content = textarea.value;
  if (content.trim().length === 0) return;
  textarea.value = "";
  delete state.drafts[conversationId];
  if (conversationId === PENDING_NEW_SESSION) {
    const autoTitle = "Web session";
    const result = await api("/api/conversations", { method: "POST", body: JSON.stringify({ title: autoTitle }) });
    upsertConversation(result.conversation);
    state.pendingNewSession = false;
    state.selectedConversationId = result.conversation.id;
    conversationId = result.conversation.id;
  }
  if (liveRunFor(conversationId) !== null) {
    await sendSessionControlMessage(conversationId, content);
    return;
  }
  await streamSessionMessage(conversationId, content);
}

async function handleAction(target) {
  const action = target.dataset.action;
  if (action === "dismiss-action-error") {
    state.actionError = null;
    render();
    return false;
  }
  if (action === "refresh") {
    await withPending("refresh", "Refreshing...", async function() {
      await refresh({ showLoading: false });
    });
    return false;
  }
  if (action === "check-models") {
    await withPending("model-check", "Checking models...", async function() {
      const result = await api("/api/models/check", {
        method: "POST",
        body: JSON.stringify({})
      });
      state.models = result;
      const failures = result.catalog && Array.isArray(result.catalog.results)
        ? result.catalog.results.filter(function(item) { return item.status === "error"; })
        : [];
      const changed = result.catalog && result.catalog.synchronized === false;
      state.actionError = failures.length > 0
        ? "Model catalog check failed for: " + failures.map(function(item) { return item.provider; }).join(", ")
        : changed
        ? "Provider model catalogs differ from the local cache. Use Sync models to apply them."
        : null;
    });
    return false;
  }
  if (action === "sync-models") {
    await withPending("model-sync", "Syncing models...", async function() {
      const result = await api("/api/models/sync", {
        method: "POST",
        body: JSON.stringify({})
      });
      state.models = result;
      const failures = result.catalog && Array.isArray(result.catalog.results)
        ? result.catalog.results.filter(function(item) { return item.status === "error"; })
        : [];
      state.actionError = failures.length > 0
        ? "Model catalog sync failed for: " + failures.map(function(item) { return item.provider; }).join(", ") + ". Previous cached models were kept."
        : null;
    });
    return false;
  }
  if (action === "back-evolution") {
    state.evolutionPane = "tickets";
    state.autoScrollMain = true;
    render();
    return false;
  }
  if (action === "open-ticket-detail") {
    const ticketId = target.dataset.ticketId;
    if (ticketId) {
      state.selectedTicketId = ticketId;
    }
    state.evolutionPane = "tickets";
    state.autoScrollMain = true;
    render();
    return false;
  }
  if (action === "open-ticket-context") {
    const ticketId = target.dataset.ticketId;
    if (ticketId) {
      state.selectedTicketId = ticketId;
    }
    state.evolutionPane = "context";
    state.autoScrollMain = true;
    render();
    await withPending("evolution-context-load", "Loading context...", async function() {
      await ensureEvolutionContextLoaded();
    });
    return false;
  }
  if (action === "append-evolution-context") {
    const ticket = selectedTicket();
    if (!ticket) return;
    const content = document.getElementById("evolution-context-message").value;
    if (content.trim().length === 0) return;
    await withPending("evolution-context", "Adding note...", async function() {
      const result = await api("/api/evolution/context/messages", {
        method: "POST",
        body: JSON.stringify({ ticketId: ticket.id, content: content })
      });
      updateEvolutionContext(result.context);
    });
    return false;
  }
  if (action === "import-skill") {
    const overwrite = document.getElementById("skill-import-overwrite");
    if (overwrite) {
      state.skillImportOverwrite = !!overwrite.checked;
    }
    await withPending("skill-import", "Importing...", async function() {
      await importSelectedSkill();
    });
    return false;
  }
  if (action === "save-proposal") {
    const ticketId = target.dataset.ticketId;
    const titleInput = document.getElementById("ticket-title");
    if (titleInput && titleInput.value.length > 25) {
      alert("Ticket title must be at most 25 characters.");
      return;
    }
    const body = {
      title: titleInput ? titleInput.value : "",
      summary: document.getElementById("proposal-summary").value,
      diagnosis: document.getElementById("proposal-diagnosis").value,
      versionTopic: document.getElementById("proposal-version-topic").value,
      proposedSelfInstructions: document.getElementById("proposal-instructions").value,
      risk: document.getElementById("proposal-risk").value,
      rollbackPlan: document.getElementById("proposal-rollback").value
    };
    await withPending(ticketActionKey(ticketId), "Saving proposal...", async function() {
      const result = await api("/api/evolution/tickets/" + encodeURIComponent(ticketId) + "/proposal", {
        method: "POST",
        body: JSON.stringify(body)
      });
      upsertTicket(result.ticket);
      updateEvolutionContext(result.context);
    });
    return;
  }
  if (action === "approve-ticket") {
    const ticketId = target.dataset.ticketId;
    await withPending(ticketActionKey(ticketId), "Approving proposal...", async function() {
      const result = await api("/api/evolution/tickets/" + encodeURIComponent(ticketId) + "/approve", { method: "POST", body: JSON.stringify({ actor: "webui" }) });
      upsertTicket(result.ticket);
      updateEvolutionContext(result.context);
      if (result.ticket) {
        setPending(ticketActionKey(ticketId), "Running isolated implementation...");
        patchTicket(ticketId, { status: "applying", updatedAt: new Date().toISOString() });
        render();
        await streamEvolutionImplementation(result.ticket.id);
      }
    });
    return;
  }
  if (action === "start-implementation") {
    const ticketId = target.dataset.ticketId;
    await withPending(ticketActionKey(ticketId), "Running isolated implementation...", async function() {
      patchTicket(ticketId, { status: "applying", updatedAt: new Date().toISOString() });
      render();
      await streamEvolutionImplementation(ticketId);
    });
    return;
  }
  if (action === "reject-ticket") {
    const ticketId = target.dataset.ticketId;
    await withPending(ticketActionKey(ticketId), "Rejecting proposal...", async function() {
      const result = await api("/api/evolution/tickets/" + encodeURIComponent(ticketId) + "/reject", { method: "POST", body: JSON.stringify({ actor: "webui" }) });
      upsertTicket(result.ticket);
      updateEvolutionContext(result.context);
    });
    return;
  }
  if (action === "activate-runtime") {
    const ticketId = target.dataset.ticketId;
    const key = ticketActionKey(ticketId);
    await withPending(key, "Activating runtime version...", async function() {
      const result = await api("/api/evolution/tickets/" + encodeURIComponent(ticketId) + "/activation", { method: "POST", body: JSON.stringify({ actor: "webui" }) });
      if (result.ticket) upsertTicket(result.ticket);
      updateEvolutionContext(result.context);
      if (result.runtimeActivation) {
        state.snapshot = Object.assign({}, state.snapshot || {}, {
          runtimeActivation: result.runtimeActivation,
          activeRuntimeVersion: result.activeRuntimeVersion || (state.snapshot && state.snapshot.activeRuntimeVersion),
          pendingRuntimeActivation: result.pendingRuntimeActivation || (state.snapshot && state.snapshot.pendingRuntimeActivation)
        });
      }
      if (!result.alreadyActive) {
        await waitForRuntimeActivation(key, result.runtimeActivation);
      }
    });
    return false;
  }
  if (action === "activate-version") {
    const versionId = target.dataset.versionId;
    const key = "runtime-version:" + versionId;
    await withPending(key, "Activating version...", async function() {
      const result = await api("/api/evolution/runtime-code/versions/" + encodeURIComponent(versionId) + "/activate", { method: "POST", body: JSON.stringify({ actor: "webui" }) });
      if (result.ticket) upsertTicket(result.ticket);
      updateEvolutionContext(result.context);
      state.snapshot = Object.assign({}, state.snapshot || {}, {
        activeRuntimeVersion: result.activeRuntimeVersion || (state.snapshot && state.snapshot.activeRuntimeVersion),
        pendingRuntimeActivation: result.pendingRuntimeActivation || (state.snapshot && state.snapshot.pendingRuntimeActivation),
        runtimeActivation: result.runtimeActivation || (state.snapshot && state.snapshot.runtimeActivation)
      });
      if (!result.alreadyActive) {
        await waitForRuntimeActivation(key, result.runtimeActivation);
      }
    });
    return false;
  }
  if (action === "confirm-runtime-version") {
    const ticketId = target.dataset.ticketId || "";
    const versionId = target.dataset.versionId || pendingRuntimeActivationVersionId();
    const key = ticketId ? ticketActionKey(ticketId) : "runtime-confirm:" + versionId;
    await withPending(key, "Confirming version...", async function() {
      const path = versionId
        ? "/api/evolution/runtime-code/versions/" + encodeURIComponent(versionId) + "/confirm"
        : "/api/evolution/runtime-code/activation/confirm";
      const result = await api(path, { method: "POST", body: JSON.stringify({ actor: "webui", versionId: versionId }) });
      if (result.ticket) upsertTicket(result.ticket);
      updateEvolutionContext(result.context);
      state.snapshot = Object.assign({}, state.snapshot || {}, {
        activeRuntimeVersion: result.activeRuntimeVersion || (state.snapshot && state.snapshot.activeRuntimeVersion),
        pendingRuntimeActivation: null
      });
    });
    return false;
  }
  if (action === "rollback-version") {
    const versionId = target.dataset.versionId;
    await withPending("version:" + versionId, "Activating version...", async function() {
      await api("/api/evolution/self-instructions/rollback", { method: "POST", body: JSON.stringify({ actor: "webui", versionId: versionId }) });
    });
    return;
  }
  if (action === "delete-ticket") {
    const ticketId = target.dataset.ticketId;
    const ticket = ticketById(ticketId);
    const label = ticket ? ticket.title : ticketId;
    if (!window.confirm('Delete ticket "' + label + '" and its associated version data?')) return;
    await withPending(ticketActionKey(ticketId), "Deleting ticket...", async function() {
      const result = await api("/api/evolution/tickets/" + encodeURIComponent(ticketId), { method: "DELETE" });
      updateEvolutionContext(result.context);
      if (state.selectedTicketId === ticketId) {
        state.selectedTicketId = null;
      }
    });
    return;
  }
  if (action === "delete-runtime-version") {
    const versionId = target.dataset.versionId;
    if (!window.confirm('Delete runtime version "' + versionId + '" and its archived files?')) return;
    await withPending("runtime-delete:" + versionId, "Deleting version...", async function() {
      await api("/api/evolution/runtime-code/versions/" + encodeURIComponent(versionId), { method: "DELETE" });
      await refresh({ showLoading: false });
    });
    return;
  }
  if (action === "delete-self-version") {
    const versionId = target.dataset.versionId;
    if (!window.confirm('Delete self-instruction version "' + versionId + '"?')) return;
    await withPending("self-delete:" + versionId, "Deleting version...", async function() {
      await api("/api/evolution/self-instructions/versions/" + encodeURIComponent(versionId), { method: "DELETE" });
    });
    return;
  }
  if (action === "new-session") {
    state.pendingNewSession = true;
    state.selectedConversationId = PENDING_NEW_SESSION;
    state.view = "sessions";
    state.autoScrollMain = true;
    render();
    return;
  }
  if (action === "rename-conversation") {
    await promptRenameConversation(target.dataset.conversationId);
    return;
  }
  if (action === "delete-conversation") {
    const conversationId = target.dataset.conversationId;
    const conversation = state.conversations.find(function(item) { return item.id === conversationId; });
    const label = conversation ? conversation.title : conversationId;
    if (!window.confirm('Delete session "' + label + '"?')) return;
    await withPending("conversation:" + conversationId, "Deleting session...", async function() {
      await api("/api/conversations/" + encodeURIComponent(conversationId), {
        method: "DELETE"
      });
      if (state.selectedConversationId === conversationId) {
        state.selectedConversationId = null;
      }
      state.view = "sessions";
    });
    return;
  }
  if (action === "send-session-message") {
    await sendSessionMessageFromInput(target.dataset.conversationId);
    return;
  }
  if (action === "approve-web-approval" || action === "reject-web-approval") {
    await sendApprovalDecision(
      target.dataset.approvalId,
      action === "approve-web-approval",
      target.dataset.approvalScope || "once"
    );
    return;
  }
}

function readHash() {
  const hash = window.location.hash || "";
  const match = hash.match(/ticket=([^&]+)/);
  if (match) {
    state.view = "evolution";
    state.selectedTicketId = decodeURIComponent(match[1]);
    state.evolutionPane = hash.indexOf("pane=context") >= 0 ? "context" : "tickets";
  }
}

readHash();
window.addEventListener("hashchange", function() {
  readHash();
  render();
});
render();
refresh();
`;
