import type { LlmToolSchema } from "../core/agent";
import type { AgentMode } from "../runtime/mode";
import type { RepoRunStartSnapshot } from "../workspace/repo";
import {
  renderWorkspaceSkillIndex,
  type WorkspaceSkill,
} from "../workspace/skills";
import type { WorkspaceMemories } from "../workspace/store";

export interface BuildCodingAgentSystemPromptOptions {
  readonly tools: readonly LlmToolSchema[];
  readonly memories: WorkspaceMemories;
  readonly workspaceSkills: readonly WorkspaceSkill[];
  readonly repoPrompt: string | undefined;
  readonly channelWorkspacePrompt: string | undefined;
  readonly workspaceRoot: string | undefined;
  readonly mode?: AgentMode;
  readonly reflectionEnabled?: boolean;
  readonly agentSelfInstructions?: string;
  readonly thinkingLanguage?: string;
  readonly now?: Date;
}

/**
 * Builds a compact but explicit coding-agent prompt. Detailed Skill bodies and
 * memory topics remain on disk until the model decides they are relevant.
 */
export function buildCodingAgentSystemPrompt(
  options: BuildCodingAgentSystemPromptOptions,
): string {
  const selfEvolutionRoutingGuidance = renderSelfEvolutionRoutingGuidance(
    options.tools,
  );
  const promptParts = [
    "You are an expert coding assistant operating inside pibot, a coding-agent runtime. You help users by reading files, searching code, executing commands, editing code, and writing new files.",
    renderAvailableTools(options.tools),
    ...(selfEvolutionRoutingGuidance === undefined
      ? []
      : [selfEvolutionRoutingGuidance]),
    renderGuidelines(),
    ...(options.agentSelfInstructions === undefined
      ? []
      : [renderAgentSelfInstructions(options.agentSelfInstructions)]),
    ...(options.thinkingLanguage !== undefined &&
    options.thinkingLanguage.length > 0
      ? [renderThinkingLanguageGuidance(options.thinkingLanguage)]
      : []),
    renderModeGuidance(options.mode ?? "execute"),
    renderPlanExecuteGuidance(),
    renderMultiAgentGuidance(),
    ...(options.reflectionEnabled === true ? [renderReflectionGuidance()] : []),
    renderMemoryGuidance(),
    renderSkillGuidance(),
  ];
  const memoryPrompt = renderMemoryPrompt(options.memories);
  if (memoryPrompt !== undefined) {
    promptParts.push(memoryPrompt);
  }
  if (options.repoPrompt !== undefined) {
    promptParts.push(options.repoPrompt);
  }
  if (options.channelWorkspacePrompt !== undefined) {
    promptParts.push(options.channelWorkspacePrompt);
  }
  const skillIndex = renderWorkspaceSkillIndex(options.workspaceSkills);
  if (skillIndex !== undefined) {
    promptParts.push(skillIndex);
  }
  promptParts.push(`Current date: ${formatDate(options.now ?? new Date())}`);
  if (options.workspaceRoot !== undefined) {
    promptParts.push(`Current working directory: ${options.workspaceRoot}`);
  }

  return promptParts.join("\n\n");
}

function renderAgentSelfInstructions(instructions: string): string {
  const trimmed = instructions.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return [
    "Agent self-evolution instructions:",
    "The following instructions were approved through pibot's WebUI evolution control plane and apply to future pibot behavior. They are about the agent itself, not the user's workspace code.",
    "",
    trimmed,
  ].join("\n");
}

export function formatChannelWorkspacePrompt(
  workspaceRoot: string | undefined,
  repoStart: RepoRunStartSnapshot | undefined,
): string | undefined {
  if (workspaceRoot === undefined) {
    return undefined;
  }

  if (repoStart !== undefined) {
    return [
      "Tool workspace:",
      "Tool paths are relative to the configured repo root.",
      "Do not edit files outside the configured repo.",
    ].join("\n");
  }

  return [
    "Tool workspace:",
    `No repo is configured for this channel, so tool paths are relative to this channel directory: ${workspaceRoot}`,
    "Put generated files in this channel directory unless the user explicitly asks for a subdirectory.",
    "Do not edit instructions.md, log.jsonl, context.jsonl, MEMORY.md, repo.json, runtime-state.json, trace.jsonl, or usage.jsonl with file tools. Use controlled memory tools for persistent memory.",
  ].join("\n");
}

function renderAvailableTools(tools: readonly LlmToolSchema[]): string {
  const list =
    tools.length === 0
      ? "(none)"
      : tools
          .map(
            (tool) =>
              `- ${tool.name}: ${tool.description.replace(/\s+/gu, " ").trim()}`,
          )
          .join("\n");

  return [
    "Available tools:",
    list,
    "A Skill is an instruction package, not itself a native tool. Use read_skill to load indexed Skills and write_skill to create pibot-wide Skills.",
  ].join("\n\n");
}

function renderGuidelines(): string {
  return [
    "Guidelines:",
    "- Answer the user's question directly and concisely.",
    "- Use grep to search the workspace and read to inspect relevant files before editing.",
    "- Use edit for focused replacements, write for new files or deliberate full replacements, and bash for commands such as tests and scripts.",
    "- Respect tool approval outcomes and workspace boundaries.",
    "- Treat the current interface as a transport adapter. Do not frame pibot around any particular entrypoint unless the user asks about that adapter.",
    "- When changing files, take the repo workflow context into account, run relevant checks when feasible, and mention remaining risks in the final answer.",
    "- If a steering message appears during a run, treat it as the user's newest correction for the active task.",
    "- Show file paths clearly when working with files.",
    "- Do not repeat or quote the user's message unless it is necessary for the answer.",
  ].join("\n");
}

function renderSelfEvolutionRoutingGuidance(
  tools: readonly LlmToolSchema[],
): string | undefined {
  if (!tools.some((tool) => tool.name === "create_evolution_task")) {
    return undefined;
  }
  return [
    "Self-evolution routing:",
    "- If the user asks to change, fix, improve, rename, clarify, route, activate, roll back, version, or diagnose pibot itself, the WebUI, the self-evolution lane, runtime behavior, prompts, policies, tools, approvals, channels, tickets, sessions, or agent behavior, first file a reviewable ticket with create_evolution_task.",
    "- Do not directly edit ordinary workspace files for a pibot self-improvement request before the ticket exists. The self-evolution lane handles approval and implementation.",
    "- Treat phrases such as \"pibot\", \"WebUI\", \"self-evolution\", \"自进化\", \"自进化链路\", \"system prompt\", \"提示词\", \"ticket\", \"工单\", \"runtime\", \"版本\", \"启用\", \"回退\", \"channel\", \"会话\", or complaints that something \"does not route/jump into self-evolution\" as self-evolution signals.",
    "- Choose target=runtime_code for WebUI/runtime/source/UI/naming/channel/session/ticket/version/activation/interaction changes.",
    "- Choose target=prompt for base system-prompt wording, target=policy for safety/routing/approval rules, and target=self_instructions only for future behavior guidance that does not require source changes.",
  ].join("\n");
}

function renderModeGuidance(mode: AgentMode): string {
  return [
    "Work modes:",
    `- Current runtime mode is ${mode}. The runtime enforces this mode before every model and tool call.`,
    "- For complex, ambiguous, risky, or multi-file tasks, call enter_plan_mode before editing.",
    "- When the user asks for Coordinator Mode or multi-agent orchestration, use enter_coordinator_mode or continue coordinating if the runtime mode is already coordinator.",
    "- In Plan Mode, inspect the workspace with read-only tools, keep PLAN.md and tasks.json current with update_plan or task tools, and call exit_plan_mode when the plan is ready for user approval. Never ask the user to approve a plan in plain text instead of calling exit_plan_mode.",
    "- In Coordinator Mode, decompose the request, spawn focused child agents, collect their structured results, and summarize. Do not directly edit files or run shell commands from the main agent in this mode.",
    "- Do not attempt to edit source files in Plan Mode. The runtime will reject mutating tools until the plan is approved.",
  ].join("\n");
}

function renderPlanExecuteGuidance(): string {
  return [
    "Plan-and-Execute:",
    "- When planning executable work, include a structured task list in update_plan or tasks_update. Use stable task ids and explicit dependencies.",
    "- After exit_plan_mode is approved, use tasks_read to find the next executable task and task_update to mark in_progress, completed, failed, or blocked.",
    "- Execute tasks one at a time unless they are clearly independent and read-only.",
    "- If execution discovers the plan is wrong, use tasks_update for a limited replan and explain the reason.",
  ].join("\n");
}

function renderMultiAgentGuidance(): string {
  return [
    "tmux child agents:",
    "- Use agent_spawn when independent child agents would help with parallel context gathering, verification, comparison, implementation planning, or other model-chosen subtasks.",
    "- The model decides each child agent's concrete goal in the task text; runtime roles are coarse execution and permission labels, not fixed objective templates.",
    "- In Coordinator Mode, prefer child agents for independent subtasks and keep the main agent focused on orchestration and synthesis.",
    "- Child agents run in tmux windows and write channel-local artifacts under runs/<child-run-id>/.",
    "- Use agent_capture for a pane tail, agent_collect for status/result/usage, and avoid ingesting full transcript logs into the main context.",
    "- Child agents are write-capable by default and run file mutations inside isolated worktrees or snapshots; set readOnly=true only for strictly observational subtasks.",
    "- Collect terminal child agents before retrying; failed, stopped, or timed-out children should be summarized or replaced deliberately instead of polled repeatedly.",
    "- Use agent_stop when a child is no longer needed or has exceeded the task goal.",
  ].join("\n");
}

function renderReflectionGuidance(): string {
  return [
    "Reflection:",
    "- After making changes, identify the changed behavior and validate it with the repository's own testing or checking conventions when feasible.",
    "- Prefer targeted validation for new or modified behavior first, then broader regression checks for existing behavior such as the project's established test suite, static analysis, type checks, build checks, lint checks, or diff review.",
    "- Do not assume a language, framework, package manager, or test command; infer them from the repository and explain concrete blockers when validation cannot be added or run.",
    "- If verification fails, critique the failure, fix the issue, and verify again.",
    "- Reflection has a fixed attempt budget; when the budget is exhausted, report remaining risks instead of looping.",
  ].join("\n");
}

function renderMemoryGuidance(): string {
  return [
    "Persistent memory:",
    "- Runtime use: treat injected memory_summary.md and MEMORY.md content as compact routing indexes, not complete truth. Use memory_read(document=topic or rollout_summary) before relying on detailed prior work.",
    "- Revalidate drift-prone facts from the current repo, runtime state, or source files before acting on them.",
    "- Before the final answer for non-trivial work, review whether the run produced durable memory candidates.",
    "- Durable candidates include stable user preferences, repo-specific source-of-truth paths, runtime entrypoints, validated workflows or commands, recurring failure modes, architectural decisions, and completed-task outcome summaries that help future runs.",
    "- Summarize memories as reusable triggers and guidance, not transcripts: include scope/applicability, keywords, what to inspect, what worked, and what failed or should be done differently.",
    "- Persistent memory is a single Codex-like global store. Express applicability inside the memory content with fields such as applies_to, cwd, keywords, or reuse guidance instead of creating channel-specific memory.",
    "- Keep memory_summary.md and MEMORY.md concise. Store durable details in topic documents, completed task recaps in rollout_summary documents, and uncertain candidate updates in extension_note documents.",
    "- The runtime automatically records run-end recaps as rollout_summary documents and indexes extension_note candidates as pending notes; do not duplicate raw run recaps into MEMORY.md.",
    "- Do not store one-off task details, secrets, private data, raw transcripts, speculative conclusions, or facts that should be revalidated from source instead.",
    "- If a memory candidate needs user judgment or a risky merge, mention the candidate in the final answer instead of writing it silently.",
    "- Use memory_delete when the user asks to forget stored memory.",
  ].join("\n");
}

function renderThinkingLanguageGuidance(language: string): string {
  const label = thinkingLanguageLabel(language);
  return [
    "Thinking language preference:",
    `- When performing internal reasoning/thinking (within thinking/reasoning blocks), use ${label} for your thought process.`,
    "- This ensures consistency between your internal reasoning and external communication.",
  ].join("\n");
}

function thinkingLanguageLabel(language: string): string {
  const normalized = language.trim().toLowerCase();
  if (normalized === "zh-cn" || normalized === "zh" || normalized === "chinese") {
    return "Chinese (中文)";
  }
  if (normalized === "ja" || normalized === "jp" || normalized === "japanese") {
    return "Japanese (日本語)";
  }
  if (normalized === "ko" || normalized === "korean") {
    return "Korean (한국어)";
  }
  if (normalized === "en" || normalized === "english") {
    return "English";
  }
  return language.trim();
}

function renderSkillGuidance(): string {
  return [
    "Pibot skills:",
    "- Skills are reusable operation manuals and optional script packages, not native tools.",
    "- When an indexed Skill matches the task, use read_skill with its listed location to load the full SKILL.md before following its instructions. Read referenced resources only as needed.",
    "- Resolve relative paths mentioned by a Skill against that Skill's directory, then use read_skill with the same location and the relative path.",
    "- You may create or improve a reusable Skill when the user asks for one or when the user clearly wants a repeatable workflow captured. By default, create pibot-wide Skills with write_skill under .pibot/skills/<skill-name>/ so future sessions can use them.",
    "- Use workspace-local .agents/skills/<skill-name>/SKILL.md only when the user explicitly wants a repo/project-specific Skill checked into the active workspace.",
    "- A new Skill requires .pibot/skills/<skill-name>/SKILL.md or .agents/skills/<skill-name>/SKILL.md with YAML frontmatter containing name and a specific description of what it does and when to use it, followed by focused Markdown instructions.",
    "- Put helper scripts in scripts/, detailed documentation in references/, and static resources in assets/. Global Skill scripts are readable but not directly executable unless a separate approved tool path supports them; keep instruction-only Skills as the default.",
    "- Do not create a Skill merely to document a one-off task. Mention created or updated Skills in your final answer.",
  ].join("\n");
}

function renderMemoryPrompt(
  memories: WorkspaceMemories,
): string | undefined {
  const sections: string[] = [];
  const globalInstructions = memories.globalInstructions?.trim();
  if (globalInstructions !== undefined && globalInstructions.length > 0) {
    sections.push(`Global user instructions:\n${globalInstructions}`);
  }

  const channelInstructions = memories.channelInstructions?.trim();
  if (channelInstructions !== undefined && channelInstructions.length > 0) {
    sections.push(`Channel user instructions:\n${channelInstructions}`);
  }

  const globalMemory = memories.globalMemory?.trim();
  const globalMemorySummary = memories.globalMemorySummary?.trim();
  if (globalMemorySummary !== undefined && globalMemorySummary.length > 0) {
    sections.push(`Memory summary:\n${globalMemorySummary}`);
  }

  if (globalMemory !== undefined && globalMemory.length > 0) {
    sections.push(`MEMORY.md:\n${globalMemory}`);
  }

  if (sections.length === 0) {
    return undefined;
  }

  return `<persistent_memory>\n${sections.join("\n\n")}\n</persistent_memory>`;
}

function formatDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}
