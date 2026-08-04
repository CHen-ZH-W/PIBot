import type {
  CreateEvolutionTaskToolInput,
} from "../core/tools";
import type {
  EvolutionScope,
  EvolutionSeverity,
  EvolutionTarget,
} from "../evolution/types";
import type {
  CodingToolDefinition,
  ToolInputParseResult,
  ToolRunContext,
} from "./index";

type UnknownRecord = Readonly<Record<string, unknown>>;

export const createEvolutionTaskTool: CodingToolDefinition<
  "create_evolution_task",
  CreateEvolutionTaskToolInput,
  unknown
> = {
  name: "create_evolution_task",
  riskLevel: "read-only",
  executionMode: "sequential",
  description:
    "Create a self-evolution ticket when the user proposes improving pibot itself. This files a reviewable task in the self-evolution lane; runtime_code tickets can later be approved, implemented in an isolated pibot checkout, validated, and published. Do not use this as a substitute for directly editing ordinary user workspace code.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: {
        type: "string",
        description:
          "Short title for the requested agent self-improvement. Keep within 25 characters; the WebUI ticket card shows 2 lines of fixed height so 20-25 character titles display fully.",
      },
      details: {
        type: "string",
        description:
          "Concrete context, desired behavior, trigger condition, or examples from the conversation.",
      },
      severity: {
        type: "string",
        enum: ["info", "warning", "critical"],
        description: "How urgent the self-evolution task is. Defaults to warning.",
      },
      scope: {
        type: "string",
        enum: ["global_agent", "profile", "adapter", "runtime"],
        description:
          "Which part of pibot behavior the task affects. Defaults are inferred from the request.",
      },
      target: {
        type: "string",
        enum: [
          "self_instructions",
          "prompt",
          "policy",
          "skill",
          "tool",
          "runtime_code",
        ],
        description:
          "What kind of agent-self change is proposed. Use runtime_code for WebUI/runtime/source/UI/naming/channel/interaction changes; use self_instructions only for future operating guidance that does not require source changes. Defaults are inferred from the request.",
      },
    },
    required: ["summary"],
  },
  parse(input) {
    const summary = readTrimmedString(input, "summary");
    if (summary === undefined) {
      return invalidInput("create_evolution_task.summary is required");
    }
    const severity = readEvolutionSeverity(input, "severity");
    if (input.severity !== undefined && severity === undefined) {
      return invalidInput(
        "create_evolution_task.severity must be one of: info, warning, critical",
      );
    }
    const scope = readEvolutionScope(input, "scope");
    if (input.scope !== undefined && scope === undefined) {
      return invalidInput(
        "create_evolution_task.scope must be one of: global_agent, profile, adapter, runtime",
      );
    }
    const target = readEvolutionTarget(input, "target");
    if (input.target !== undefined && target === undefined) {
      return invalidInput(
        "create_evolution_task.target must be one of: self_instructions, prompt, policy, skill, tool, runtime_code",
      );
    }
    return {
      ok: true,
      input: {
        summary,
        ...optionalString("details", readTrimmedString(input, "details")),
        ...optionalEnum("severity", severity),
        ...optionalEnum("scope", scope),
        ...optionalEnum("target", target),
      },
    };
  },
  async execute(input, context) {
    if (context.evolution === undefined) {
      throw toolError("invalid_input", "Self-evolution is not available");
    }
    const inferenceText = [input.summary, input.details]
      .filter((value): value is string => value !== undefined)
      .join("\n");
    const result = await context.evolution.submitManualSignal({
      source: context.evolution.source ?? "webui_user",
      severity: input.severity ?? "warning",
      scope: input.scope ?? inferEvolutionScope(inferenceText),
      target: input.target ?? inferEvolutionTarget(inferenceText),
      summary: input.summary,
      ...(input.details === undefined ? {} : { details: input.details }),
      actor: context.evolution.actor ?? "agent_tool",
    });
    return {
      signalId: result.signal.id,
      ticketId: result.ticket.id,
      ...(result.ticketUrl === undefined ? {} : { ticketUrl: result.ticketUrl }),
      title: result.ticket.title,
      status: result.ticket.status,
      scope: result.ticket.scope,
      target: result.ticket.target,
      message:
        result.ticket.target === "runtime_code"
          ? "已创建 runtime_code 自进化工单。请在 Self-evaluation 中评审并批准，然后启动实现。"
          : "已创建自进化工单。请在 Self-evaluation 中评审、批准、应用或回滚。",
    };
  },
};

function readTrimmedString(
  record: UnknownRecord,
  key: string,
): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function readEvolutionSeverity(
  record: UnknownRecord,
  key: string,
): EvolutionSeverity | undefined {
  const value = record[key];
  return value === "info" || value === "warning" || value === "critical"
    ? value
    : undefined;
}

function readEvolutionScope(
  record: UnknownRecord,
  key: string,
): EvolutionScope | undefined {
  const value = record[key];
  return value === "global_agent" ||
    value === "profile" ||
    value === "adapter" ||
    value === "runtime"
    ? value
    : undefined;
}

function readEvolutionTarget(
  record: UnknownRecord,
  key: string,
): EvolutionTarget | undefined {
  const value = record[key];
  return value === "self_instructions" ||
    value === "prompt" ||
    value === "policy" ||
    value === "skill" ||
    value === "tool" ||
    value === "runtime_code"
    ? value
    : undefined;
}

function inferEvolutionScope(text: string): EvolutionScope {
  if (/工单|ticket/iu.test(text)) {
    return "runtime";
  }
  if (/\bweb\s?ui\b|webui|slack|channel|adapter|会话|频道/iu.test(text)) {
    return "adapter";
  }
  if (/runtime|运行时|sandbox|沙箱|tool|工具|工单|ticket|approval|审批|权限|边界|越界|版本|version|回退|rollback|activate|启用/iu.test(text)) {
    return "runtime";
  }
  return "global_agent";
}

function inferEvolutionTarget(text: string): EvolutionTarget {
  if (/prompt|提示词|system prompt/iu.test(text)) {
    return "prompt";
  }
  if (
    /runtime[_\s-]?code|源码|代码|web\s?ui|webui|server|删除|残留|sandbox|沙箱|tool|工具|工单|ticket|bash|channel|频道|显示|界面|页面|按钮|timeline|时间线|topic|版本|version|回退|rollback|样式|布局|换行|交互|体验|刷新|重启|启用|activate|自进化链路|agent[-\s]?evolution|self[-\s]?evaluation|命名|重命名|名字|名称|rename|label|title/iu.test(
      text,
    )
  ) {
    return "runtime_code";
  }
  if (/policy|策略|审批|approval|权限|边界|越界|工作区之外/iu.test(text)) {
    return "policy";
  }
  return "self_instructions";
}

function optionalString<Key extends string>(
  key: Key,
  value: string | undefined,
): { readonly [Property in Key]: string } | object {
  return value === undefined
    ? {}
    : ({ [key]: value } as { readonly [Property in Key]: string });
}

function optionalEnum<Key extends string, Value extends string>(
  key: Key,
  value: Value | undefined,
): { readonly [Property in Key]: Value } | object {
  return value === undefined
    ? {}
    : ({ [key]: value } as { readonly [Property in Key]: Value });
}

function invalidInput(
  message: string,
): ToolInputParseResult<CreateEvolutionTaskToolInput> {
  return { ok: false, message };
}

function toolError(code: string, message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}
