import { capabilityPolicies } from "./capabilities";
import type { Capability, ToolRisk } from "./types";

export type CapabilityCatalogEntry = {
  id: Capability;
  intents: string[];
  contextSources: Array<"goals" | "schedule" | "executions" | "reviews" | "rhythmSignals">;
  tools: string[];
  output: string;
  confirmation: "none" | "changeset" | "user_judgment";
  maxSteps: number;
  maxRunTokens: number;
  failureModes: string[];
  evidence: string[];
};

const definitions: Record<Capability, Omit<CapabilityCatalogEntry, "id" | "tools" | "maxSteps" | "maxRunTokens">> = {
  goal_clarification: {
    intents: ["澄清目标", "定义成功标准", "补充范围或约束"],
    contextSources: ["goals"],
    output: "澄清问题或目标定义建议",
    confirmation: "none",
    failureModes: ["重复询问已有信息", "把非阻塞缺口当成必须澄清", "页面弱先验覆盖消息"],
    evidence: ["AgentRun.capability", "AgentStep.inputSummary", "ToolCall"],
  },
  planning: {
    intents: ["目标拆解", "制定行动计划", "形成 Outcome/Milestone/Task/Routine"],
    contextSources: ["goals", "schedule"],
    output: "结构化规划或待确认 ChangeSet",
    confirmation: "changeset",
    failureModes: ["遗漏必要步骤", "拆解缺少依赖", "未校验候选时间", "把重复安排写成一次性日程"],
    evidence: ["ExecutionPlan", "ToolCall", "ChangeSet", "AgentStep"],
  },
  review: {
    intents: ["日回顾", "周回顾", "复盘执行和阻力"],
    contextSources: ["schedule", "executions", "reviews", "rhythmSignals"],
    output: "事实、模式判断与建议；可选待确认调整草案",
    confirmation: "user_judgment",
    failureModes: ["用计划代替执行事实", "替用户确认阶段成果", "事实与建议混写"],
    evidence: ["ExecutionRecord", "Review", "RhythmSignal", "AgentStep"],
  },
  adjustment: {
    intents: ["新增或改期日程", "调整任务", "建立或调整 Routine"],
    contextSources: ["goals", "schedule", "executions", "reviews", "rhythmSignals"],
    output: "待确认 ChangeSet",
    confirmation: "changeset",
    failureModes: ["对象或时间不明确", "资源冲突", "候选证据陈旧", "重复写入"],
    evidence: ["ScheduleWindow", "CandidateValidation", "ToolCall", "ChangeSet"],
  },
  progress_evaluation: {
    intents: ["判断是否在轨", "检查投入和偏离", "判断是否值得检查里程碑"],
    contextSources: ["goals", "executions", "reviews", "rhythmSignals"],
    output: "带证据的进展判断",
    confirmation: "user_judgment",
    failureModes: ["用任务数量制造进度", "用投入替代成果", "忽略数据缺口"],
    evidence: ["GoalExecutionFacts", "ExecutionRecord", "Review", "AgentStep"],
  },
};

export const capabilityCatalog: Record<Capability, CapabilityCatalogEntry> = Object.fromEntries(
  (Object.keys(definitions) as Capability[]).map((id) => {
    const policy = capabilityPolicies[id];
    return [id, { id, ...definitions[id], tools: [...policy.allowedTools], maxSteps: policy.maxSteps, maxRunTokens: policy.maxRunTokens }];
  }),
) as Record<Capability, CapabilityCatalogEntry>;

export type ToolCatalogEntry = {
  name: string;
  access: ToolRisk;
  parallelSafe: boolean;
  requiredEvidence: string[];
};

export const toolCatalog: ToolCatalogEntry[] = [
  ["read_goal_context", "read", true, []],
  ["read_schedule_window", "read", true, []],
  ["read_similar_schedule_history", "read", true, []],
  ["validate_schedule_candidates", "read", false, ["read_schedule_window"]],
  ["read_execution_history", "read", true, []],
  ["read_recent_reviews", "read", true, []],
  ["read_rhythm_signals", "read", true, []],
  ["propose_planning", "draft_write", false, []],
  ["propose_change_set", "draft_write", false, []],
].map(([name, access, parallelSafe, requiredEvidence]) => ({ name: String(name), access: access as ToolRisk, parallelSafe: Boolean(parallelSafe), requiredEvidence: requiredEvidence as string[] }));
