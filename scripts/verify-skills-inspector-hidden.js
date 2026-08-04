// DOM + computed-CSS 级验证：skills 页面隐藏 Inspector
// 自进化工单 evo_20260804-113229_e6e0
// 用法: node scripts/verify-skills-inspector-hidden.js （需先 npm run build）
"use strict";
const path = require("node:path");
const vm = require("node:vm");
const { WEBUI_CSS, WEBUI_SCRIPT } = require(path.join(__dirname, "..", "dist", "web", "static"));

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
    tickets: [],
    signals: [],
    context: { messages: [], ticketContexts: [] },
    runtimeVersions: [],
    selfVersions: [],
  },
  runtime: { instanceId: "test-runtime" },
  conversations: [],
  skills: {
    skills: [{ name: "grilling", description: "Stress-test a plan.", source: "pibot", location: ".pibot/skills/grilling/SKILL.md", disableModelInvocation: false }],
    disabledSkills: [],
    issues: [],
  },
};

const context = {
  AbortController,
  URL,
  console,
  fetch: async (p) => {
    if (p === "/api/state") {
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

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error("FAIL: " + msg); }
  else { console.log("PASS: " + msg); }
}

// ---- 解析顶层 CSS 规则（跳过 @media 嵌套块） ----
function parseTopLevelRules(css) {
  const rules = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    const braceOpen = css.indexOf("{", i);
    if (braceOpen === -1) break;
    const selector = css.slice(i, braceOpen).trim();
    // 只收集顶层规则（selector 不以 @ 开头）
    if (selector.startsWith("@")) {
      // 跳过整个块（包括嵌套）
      let depth = 0;
      let j = braceOpen;
      for (; j < n; j++) {
        if (css[j] === "{") depth++;
        else if (css[j] === "}") { depth--; if (depth === 0) { j++; break; } }
      }
      i = j;
      continue;
    }
    let depth = 0;
    let j = braceOpen;
    let body = "";
    for (; j < n; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") {
        depth--;
        if (depth === 0) { body = css.slice(braceOpen + 1, j); j++; break; }
      } else if (depth === 1) {
        body += css[j];
      }
    }
    rules.push({ selector, body });
    i = j;
  }
  return rules;
}

function specificClasses(selector) {
  // 统计类/属性选择器数量（忽略 :hover 等伪类中的类）
  const classes = (selector.match(/\.[A-Za-z0-9_-]+/g) || []).length;
  const attrs = (selector.match(/\[[^\]]+\]/g) || []).length;
  return classes + attrs;
}

(async function main() {
  await new Promise((resolve) => setTimeout(resolve, 30));
  await Promise.resolve();

  const state = vm.runInContext("state", context);
  const render = vm.runInContext("render", context);

  // ---- DOM 级：各视图的 shell 类 ----
  state.loading = false;
  state.view = "skills";
  render();
  assert(appElement.innerHTML.indexOf('class="shell skills-shell"') !== -1, "skills 视图 shell 使用 skills-shell 类");
  assert(appElement.innerHTML.indexOf("Skill Index") !== -1, "skills 视图仍渲染 Skill Index 主面板");

  state.view = "sessions";
  render();
  assert(appElement.innerHTML.indexOf('class="shell sessions-shell"') !== -1, "sessions 视图 shell 仍为 sessions-shell（回归）");

  state.view = "evolution";
  state.evolutionPane = "tickets";
  render();
  assert(appElement.innerHTML.indexOf('class="shell"') !== -1, "evolution tickets 视图 shell 无后缀类（回归）");

  state.evolutionPane = "context";
  render();
  assert(appElement.innerHTML.indexOf('class="shell evolution-focus-shell"') !== -1, "evolution context 视图 shell 仍为 evolution-focus-shell（回归）");

  // 所有视图的 inspector aside DOM 保留（与其他隐藏模式一致：CSS 隐藏而非删除 DOM）
  state.view = "skills";
  render();
  assert(appElement.innerHTML.indexOf('<aside class="inspector">') !== -1, "skills 视图 inspector DOM 保留（CSS 隐藏）");

  // ---- computed-CSS 级：skills-shell 规则 + specificity ----
  const rules = parseTopLevelRules(WEBUI_CSS);

  const skillsShellRule = rules.find((r) => r.selector === ".shell.skills-shell");
  assert(!!skillsShellRule, "CSS 含顶层规则 .shell.skills-shell");
  assert(
    !!skillsShellRule && /grid-template-columns:\s*248px minmax\(0, 1fr\);/u.test(skillsShellRule.body),
    ".shell.skills-shell 将网格收窄为 248px + 1fr（不含 360px inspector 列）",
  );

  const skillsInspectorRule = rules.find((r) => r.selector === ".shell.skills-shell .inspector");
  assert(!!skillsInspectorRule, "CSS 含顶层规则 .shell.skills-shell .inspector");
  assert(
    !!skillsInspectorRule && /display:\s*none;/u.test(skillsInspectorRule.body),
    ".shell.skills-shell .inspector 声明 display: none",
  );

  // specificity：skills-shell .inspector (0,2,0) 必须高于基础 .inspector (0,1,0)，否则 display:none 会被覆盖
  const baseInspectorRules = rules.filter((r) => {
    const sels = r.selector.split(",").map((s) => s.trim());
    return sels.some((s) => s === ".inspector");
  });
  assert(baseInspectorRules.length > 0, "CSS 含基础 .inspector 规则（对照）");
  const skillsSpec = specificClasses(".shell.skills-shell .inspector");
  const baseSpec = specificClasses(".inspector");
  assert(
    skillsSpec > baseSpec,
    `specificity 覆盖成立：.shell.skills-shell .inspector (${skillsSpec} 类) > .inspector (${baseSpec} 类)，skills 视图下 display:none 生效`,
  );

  // 对照：sessions-shell / evolution-focus-shell 同样以 (0,2,0) 覆盖，证明同模式一致
  const sessionsInspectorRule = rules.find((r) => r.selector === ".shell.sessions-shell .inspector");
  assert(
    !!sessionsInspectorRule && /display:\s*none;/u.test(sessionsInspectorRule.body || ""),
    "对照：.shell.sessions-shell .inspector 声明 display: none（既有模式保持）",
  );

  console.log(failures === 0 ? "\nskills 页面隐藏 Inspector 的 DOM/CSS 级验证全部通过。" : `\n${failures} 项失败。`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
