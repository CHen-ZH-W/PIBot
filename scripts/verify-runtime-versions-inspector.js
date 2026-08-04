// DOM 级验证：执行完整 WEBUI_SCRIPT，渲染 inspector，检查 Runtime Versions 框 UI
// 自进化工单 evo_20260804-070455_1f0d
// 用法: node scripts/verify-runtime-versions-inspector.js
"use strict";
const path = require("node:path");
const vm = require("node:vm");
const { WEBUI_SCRIPT } = require(path.join(__dirname, "..", "dist", "web", "static"));

const appElement = {
  innerHTML: "",
  value: "",
  selectionStart: 0,
  selectionEnd: 0,
  classList: { contains() { return false; }, add() {} },
  querySelector() { return null; },
  querySelectorAll() { return []; },
};

const apiState = {
  evolution: {
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
    signals: [],
    context: { messages: [], ticketContexts: [] },
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
  },
  runtime: { instanceId: "test-runtime" },
  conversations: [],
  skills: { skills: [], disabledSkills: [], issues: [] },
};

const context = {
  AbortController,
  URL,
  console,
  fetch: async (path) => {
    if (path === "/api/state") {
      return { ok: true, statusText: "OK", json: async () => apiState };
    }
    return { ok: true, statusText: "OK", json: async () => ({}) };
  },
  document: {
    activeElement: null,
    getElementById(id) { return id === "app" ? appElement : null; },
    addEventListener() {},
  },
  window: {
    location: { hash: "", href: "http://127.0.0.1/" },
    addEventListener() {},
    requestAnimationFrame(callback) { callback(); },
    setTimeout(callback) { callback(); return 0; },
    clearTimeout() {},
    confirm() { return true; },
    prompt() { return null; },
  },
};
vm.createContext(context);
new vm.Script(WEBUI_SCRIPT, { filename: "WEBUI_SCRIPT.js" }).runInContext(context);

(async function main() {
  // 等待 refresh() 完成（fetch /api/state -> render）
  await new Promise((resolve) => setTimeout(resolve, 50));
  await Promise.resolve();

  let failures = 0;
  function assert(cond, msg) {
    if (!cond) { failures++; console.error("FAIL: " + msg); }
    else { console.log("PASS: " + msg); }
  }

  // 进入 evolution 视图，选中第一个 ticket，渲染 inspector
  const state = vm.runInContext("state", context);
  state.view = "evolution";
  state.evolutionPane = "tickets";
  state.selectedTicketId = "evo_20260804-064837_d8b3";
  const inspectorHtml = context.renderInspector(context.ticketById("evo_20260804-064837_d8b3"));

  // --- Runtime Versions panel ---
  const rvPanelStart = inspectorHtml.indexOf("Runtime Versions");
  assert(rvPanelStart !== -1, "inspector 含 Runtime Versions panel");
  const rvPanel = inspectorHtml.slice(rvPanelStart);
  const rvHeaderEnd = rvPanel.indexOf('<div class="panel-body">');
  const rvHeader = rvPanel.slice(0, rvHeaderEnd);
  assert(rvHeader.indexOf('data-action="delete-runtime-version"') === -1, "panel-header 不再放 × 删除按钮（已移入每个版本条目右上角）");
  assert(rvHeader.indexOf('class="panel-actions"') !== -1, "header 右侧使用 panel-actions 容器");

  // --- Runtime Versions item 结构 ---
  assert(rvPanel.indexOf("item-toolbar") === -1, "Runtime Versions 版本行无 item-toolbar");
  assert(rvPanel.indexOf("runtime-version-item") !== -1, "版本条目使用 runtime-version-item 类（供右上角定位）");
  // 更精确：panel 内 3 个版本条目各有 1 个 ×（共 3 个）
  const panelSection = inspectorHtml.slice(inspectorHtml.indexOf("Runtime Versions"), inspectorHtml.indexOf("Self-Instruction Versions") === -1 ? inspectorHtml.length : inspectorHtml.indexOf("Self-Instruction Versions"));
  const deleteCount = (panelSection.match(/data-action="delete-runtime-version"/g) || []).length;
  assert(deleteCount === 3, "Runtime Versions panel 内 3 个版本条目各有 1 个 × 删除按钮");
  for (const vid of ["runtime-v0033-20260804-065955", "runtime-v0032-20260804-063125", "runtime-v0031-20260804-060503"]) {
    assert(panelSection.indexOf('data-action="delete-runtime-version" data-version-id="' + vid + '"') !== -1, "× 删除按钮指向版本条目 " + vid);
  }
  const delActive = panelSection.match(/data-action="delete-runtime-version" data-version-id="runtime-v0033-20260804-065955"[^>]*/);
  assert(delActive !== null && delActive[0].indexOf("disabled") !== -1, "active 版本（v0033）条目 × 禁用");
  assert(panelSection.indexOf('badge ok">active') === -1, "Runtime Versions panel 无绿色 active badge");
  assert(panelSection.indexOf('badge warn">trial') === -1, "Runtime Versions panel 无 trial badge（去掉所有状态显示）");

  // --- tickets 框保持现状 ---
  const ticketRowHtml = context.renderTicketRow(context.ticketById("evo_20260804-064837_d8b3"));
  assert(ticketRowHtml.indexOf('data-action="delete-ticket"') !== -1, "tickets 框行内 × 保留");

  // --- Self-Instruction Versions 保持现状 ---
  const selfPanel = context.renderSelfInstructionVersionsPanel({ selfVersions: [] });
  assert(selfPanel.indexOf("Self-Instruction Versions") !== -1, "Self-Instruction Versions panel 正常渲染");

  console.log(failures === 0 ? "\nDOM 级验证全部通过。" : `\n${failures} 项失败。`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
