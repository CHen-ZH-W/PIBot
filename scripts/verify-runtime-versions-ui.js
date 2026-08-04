// 验证 Runtime Versions 框 UI 改动的渲染输出（自进化工单 evo_20260804-070455_1f0d）
// 用法: node scripts/verify-runtime-versions-ui.js
// 提取编译后 WEBUI_SCRIPT 中的顶层函数，mock 依赖后执行渲染函数，断言输出 HTML 结构。
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const dist = path.join(__dirname, "..", "dist", "web", "static.js");
const mod = require(dist);
const js = mod.WEBUI_SCRIPT || mod.WEBUI_JS;

function extractTopLevelFunctions(code) {
  const lines = code.split("\n");
  const funcs = new Map(); // name -> body
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
    if (m && line.indexOf("function " + m[1]) !== -1) {
      const name = m[1];
      let depth = 0;
      let started = false;
      let j = i;
      for (; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === "{") { depth++; started = true; }
          else if (ch === "}") { depth--; }
        }
        if (started && depth === 0) break;
      }
      const full = j > i ? lines.slice(i, j + 1).join("\n") : lines[i];
      funcs.set(name, full);
      i = j;
    }
    i++;
  }
  return funcs;
}

const funcs = extractTopLevelFunctions(js);

// 提取需要的顶层 const 单行定义
function extractConst(name) {
  const re = new RegExp("^const " + name + " = ([^;]+);", "m");
  const m = js.match(re);
  return m ? "const " + name + " = " + m[1] + ";" : null;
}
const consts = [
  "EVOLUTION_CONVERSATION_ID",
  "PENDING_NEW_SESSION",
]
  .map(extractConst)
  .filter(Boolean)
  .join("\n");

// 需要的函数（含递归依赖）
const needed = [
  "renderRuntimeVersionsPanel",
  "renderRuntimeVersion",
  "renderTicketRow",
  "renderSelfInstructionVersionsPanel",
  "renderVersion",
  "escapeHtml",
  "runtimeVersionLabel",
  "runtimeVersionTitle",
  "fmtShortTime",
  "fmtTime",
  "ticketDisplayId",
  "ticketById",
  "isRuntimeVersionActive",
  "isRuntimeVersionPendingActivation",
  "pendingLabel",
  "pendingClass",
  "disabledAttr",
  "runtimeVersions",
  "activeRuntimeVersion",
  "activeRuntimeVersionId",
  "pendingRuntimeActivation",
  "pendingRuntimeActivationVersionId",
  "runtimeVersionForTicket",
  "badgeClass",
  "liveRunFor",
];

function collectDeps(name, deps) {
  if (deps.has(name) || !funcs.has(name)) return;
  deps.add(name);
  const body = funcs.get(name);
  for (const fn of funcs.keys()) {
    if (fn === name) continue;
    const re = new RegExp("\\b" + fn + "\\s*\\(", "g");
    if (re.test(body)) collectDeps(fn, deps);
  }
}

const deps = new Set();
for (const n of needed) collectDeps(n, deps);

const code = consts + "\n" + Array.from(deps)
  .map((n) => funcs.get(n))
  .join("\n");

// mock state
const state = {
  pendingActions: {},
  activeEvolutionTicketId: null,
  liveRuns: {},
  snapshot: {
    runtimeVersions: [
      {
        id: "runtime-v0031-20260804-060503",
        number: 31,
        createdAt: "2026-08-04T06:05:03.000Z",
        label: "v0031",
        topic: "topic31",
        sourceTicketId: "evo_20260804-060503_5f70",
      },
      {
        id: "runtime-v0032-20260804-063125",
        number: 32,
        createdAt: "2026-08-04T06:31:25.000Z",
        label: "v0032",
        topic: "topic32",
        sourceTicketId: "evo_20260804-062827_e4c9",
      },
      {
        id: "runtime-v0033-20260804-065955",
        number: 33,
        createdAt: "2026-08-04T06:59:55.631Z",
        label: "v0033",
        topic: "topic33",
        sourceTicketId: "evo_20260804-064837_d8b3",
      },
    ],
    activeRuntimeVersion: { versionId: "runtime-v0033-20260804-065955" },
    pendingRuntimeActivation: null,
    tickets: [
      {
        id: "evo_20260804-064837_d8b3",
        createdAt: "2026-08-04T06:48:37.000Z",
        updatedAt: "2026-08-04T06:59:55.000Z",
        title: "支持工单/版本删除",
        status: "applied",
        target: "runtime_code",
        severity: "warning",
        signalIds: [],
        timeline: [],
        rollout: { versionId: "runtime-v0033-20260804-065955" },
      },
      {
        id: "evo_20260804-062827_e4c9",
        createdAt: "2026-08-04T06:28:27.000Z",
        updatedAt: "2026-08-04T06:31:25.000Z",
        title: "WebUI skills框移除数量显示",
        status: "applied",
        target: "runtime_code",
        severity: "warning",
        signalIds: [],
        timeline: [],
        rollout: { versionId: "runtime-v0032-20260804-063125" },
      },
    ],
  },
};

const sandbox = {
  state,
  window: { setTimeout: setTimeout, clearTimeout: clearTimeout },
  document: { activeElement: null },
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  Math: Math,
  Number: Number,
  String: String,
  Date: Date,
  RegExp: RegExp,
  JSON: JSON,
  pendingLabel: (key) => state.pendingActions[key] || "",
  setPending: (key, label) => { state.pendingActions[key] = label; },
  clearPending: (key) => { delete state.pendingActions[key]; },
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exitCode = 1;
  } else {
    console.log("PASS: " + msg);
  }
}

// 场景 1：正常列表（最新版本 active），× 位于每个版本条目右上角（行内）
const html = sandbox.renderRuntimeVersionsPanel(state.snapshot);
assert(html.indexOf('class="panel-title">Runtime Versions</span><span class="panel-actions"><span class="badge">3</span>') !== -1, "panel-header 右侧 panel-actions 含数量 badge");
assert(html.indexOf('data-action="delete-runtime-version"') !== -1, "× 删除按钮在 panel 内（每个版本条目右上角）");
const header = html.slice(0, html.indexOf('<div class="panel-body">'));
assert(header.indexOf('data-action="delete-runtime-version"') === -1, "panel-header 不再放 × 删除按钮（已移入版本条目）");
assert(header.indexOf('data-version-id="runtime-v0033-20260804-065955"') === -1, "header 不再有指向版本的 × 按钮");

// 场景 2：每个版本行右上角有 ×，无 item-toolbar、无 active/trial 状态显示
const rowHtml = sandbox.renderRuntimeVersion(state.snapshot.runtimeVersions[2]);
assert(rowHtml.indexOf("item-toolbar") === -1, "版本行不使用 item-toolbar（× 直接定位条目右上角）");
assert(rowHtml.indexOf('data-action="delete-runtime-version"') !== -1, "版本行内有 × 删除按钮");
assert(rowHtml.indexOf('data-version-id="runtime-v0033-20260804-065955"') !== -1, "版本行 × 指向本行版本 v0033");
assert(rowHtml.indexOf("runtime-version-item") !== -1, "版本行使用 runtime-version-item 类（供右上角定位）");
assert(rowHtml.indexOf('badge ok">active') === -1, "版本行无绿色 active badge");
assert(rowHtml.indexOf("badge warn\">trial") === -1, "版本行无 trial badge");
assert(rowHtml.indexOf('class="primary"') !== -1, "active 版本按钮保留 primary（橙色非绿）");
assert(rowHtml.indexOf(">Active Version</button>") !== -1, "active 版本按钮文案 Active Version");
assert(rowHtml.indexOf(">Activate Version</button>") === -1, "active 版本不显示 Activate Version");
const rowDeleteBtn = rowHtml.slice(rowHtml.indexOf('data-action="delete-runtime-version"'), rowHtml.indexOf(">×</button>") + ">×</button>".length);
assert(rowDeleteBtn.indexOf("disabled") !== -1, "active 版本行 × 禁用");

// 场景 3：无 ticket 上下文（inspector 无选中 ticket 时）也能渲染
const htmlNoTicket = sandbox.renderRuntimeVersionsPanel(state.snapshot);
assert(htmlNoTicket.indexOf("Runtime Versions") !== -1, "无 ticket 上下文 panel 正常渲染");

// 场景 4：trial（pendingActivation）版本无 trial badge、有 confirm 按钮、× 禁用
const trialState = JSON.parse(JSON.stringify(state));
trialState.snapshot.pendingRuntimeActivation = { versionId: "runtime-v0033-20260804-065955" };
trialState.snapshot.activeRuntimeVersion = { versionId: "runtime-v0031-20260804-060503" };
sandbox.state = trialState;
const htmlTrial = sandbox.renderRuntimeVersionsPanel(trialState.snapshot);
const rowTrial = sandbox.renderRuntimeVersion(trialState.snapshot.runtimeVersions[2]);
assert(rowTrial.indexOf('badge warn">trial') === -1, "trial 版本不再显示 trial badge（去掉状态显示）");
assert(rowTrial.indexOf('data-action="confirm-runtime-version"') !== -1, "trial 版本显示 Confirm Version 按钮");
assert(rowTrial.indexOf("disabled") !== -1, "pendingActivation 版本行 × 禁用");

// 场景 5：空列表不渲染 ×
const emptyHtml = sandbox.renderRuntimeVersionsPanel({ runtimeVersions: [] });
assert(emptyHtml.indexOf('data-action="delete-runtime-version"') === -1, "空列表不渲染 × 按钮");
assert(emptyHtml.indexOf("No runtime versions yet.") !== -1, "空列表显示 empty 提示");

// 场景 6：CSS 包含 panel-actions 与 runtime-version-item 右上角定位规则
const css = mod.WEBUI_CSS;
assert(css.indexOf(".panel-header .panel-actions") !== -1, "CSS 含 .panel-header .panel-actions 规则");
assert(css.indexOf(".item.runtime-version-item") !== -1, "CSS 含 .item.runtime-version-item 规则（条目相对定位）");
const cornerRule = css.match(/\.item\.runtime-version-item \.session-delete\s*\{[^}]*\}/);
assert(cornerRule !== null && /position:\s*absolute/.test(cornerRule[0]) && /right:\s*6px/.test(cornerRule[0]), "CSS × 在条目内 absolute 定位到右上角（top/right）");

// 场景 7：tickets 框保持现状（ticket-row 行内 × 保留）
const ticket = state.snapshot.tickets[0];
const ticketRow = sandbox.renderTicketRow(ticket);
assert(ticketRow.indexOf('data-action="delete-ticket"') !== -1, "tickets 框行内 × 删除按钮保留");
assert(ticketRow.indexOf('data-action="delete-runtime-version"') === -1, "tickets 框无 runtime 删除按钮");
assert(ticketRow.indexOf('badge ok') !== -1, "tickets 框绿色 active badge 保留（未改动）");

// 场景 8：Self-Instruction Versions 框保持现状（item-toolbar 行内 × 保留）
const selfHtml = sandbox.renderSelfInstructionVersionsPanel({ selfVersions: [
  { id: "v1", label: "v1", topic: "t1", createdAt: "2026-08-04T06:00:00.000Z" },
] });
assert(selfHtml.indexOf('data-action="delete-self-version"') !== -1, "Self-Instruction Versions 行内 × 保留");
assert(selfHtml.indexOf("item-toolbar") !== -1, "Self-Instruction Versions 保留 item-toolbar");

console.log("\n验证完成。");
