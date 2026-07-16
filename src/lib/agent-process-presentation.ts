/** 单条 Agent 处理步骤。原始事件保持一对一，分组仅用于前端呈现。 */
export type AgentProcessStep = {
  id: string;
  toolCallId?: string;
  label: string;
  status: "pending" | "running" | "done" | "failed" | "confirm" | "cancelled";
  summary?: string;
  detail?: {
    scope?: string;
    result?: string;
    judgment?: string;
    nextAction?: string;
    missingInformation?: string[];
    inputSummary?: string;
    inputPreview?: string;
    rawInputJson?: string;
    toolName?: string;
  };
};

export type AgentProcessStageKind = "understanding" | "context" | "result";

/** 面向用户的阶段投影；steps 中的真实工具调用不会被合并或删除。 */
export type AgentProcessStage = {
  id: AgentProcessStageKind;
  label: string;
  summary: string;
  status: AgentProcessStep["status"];
  steps: AgentProcessStep[];
  technicalSteps: AgentProcessStep[];
};

const PROPOSAL_TOOLS = new Set(["propose_planning", "propose_change_set"]);

function isToolStep(step: AgentProcessStep): boolean {
  return Boolean(step.toolCallId || step.detail?.toolName);
}

function isProposalStep(step: AgentProcessStep): boolean {
  const toolName = step.detail?.toolName;
  return Boolean(
    (toolName && (PROPOSAL_TOOLS.has(toolName) || toolName.startsWith("propose_")))
    || /变更方案|规划方案|变更草案/.test(step.label),
  );
}

function isPlanningStep(step: AgentProcessStep): boolean {
  return step.id.startsWith("planning-") && !isToolStep(step);
}

function isLoopControlStep(step: AgentProcessStep): boolean {
  return /^(verification|decision|recovery)-/.test(step.id);
}

/**
 * 展开态的真实事件时间线：保持事件到达顺序，不按语义阶段重排。
 * 逐轮 verification 属于运行时内部自检，不是用户可观察动作，因此不进入主时间线。
 */
export function buildAgentProcessTimeline(steps: AgentProcessStep[]): AgentProcessStep[] {
  const timeline = steps.filter((step) => !step.id.startsWith("verification-"));
  return timeline.length ? timeline : steps.map(normalizeLegacyTerminalVerification);
}

/** 兼容旧 Run：没有工具的终止判断过去被错误命名为“验证工具结果”。 */
function normalizeLegacyTerminalVerification(step: AgentProcessStep): AgentProcessStep {
  if (!step.id.startsWith("verification-")) return step;
  const text = [step.summary, step.detail?.result, step.detail?.judgment].filter(Boolean).join(" ");
  if (!/没有新的工具调用|没有工具结果需要验证/.test(text)) return step;
  return {
    ...step,
    label: "确认处理结束",
    summary: "信息已足够，已输出最终回复",
    detail: {
      ...step.detail,
      result: "本轮无需继续调用工具。",
      judgment: "现有信息已经足够，模型已完成本次判断。",
      nextAction: "输出最终回复。",
    },
  };
}

/**
 * 技术记录保留完整审计来源，但面向用户只投影一次最终 Loop 判断。
 * 失败的旧 proposal 尝试仍可追溯；与工具失败重复的 recovery、逐轮 verification 不重复展示。
 */
function compactTechnicalSteps(
  orderedSteps: AgentProcessStep[],
  supersededProposalIds: Set<string>,
): AgentProcessStep[] {
  const internalSteps = orderedSteps.filter((step) => !isToolStep(step) && !isPlanningStep(step));
  const finalControlStep = [...internalSteps].reverse().find((step) => step.id.startsWith("decision-"))
    ?? [...internalSteps].reverse().find((step) => step.id.startsWith("verification-"));
  const finalControlId = finalControlStep?.id;

  return orderedSteps
    .filter((step) => (
      supersededProposalIds.has(step.id)
      || (!isToolStep(step) && !isPlanningStep(step) && !isLoopControlStep(step))
      || step.id === finalControlId
    ))
    .map(normalizeLegacyTerminalVerification);
}

/** 阶段状态优先展示当前动作，其次失败、待确认、取消和完成。 */
export function processStageStatus(steps: AgentProcessStep[]): AgentProcessStep["status"] {
  if (steps.some((step) => step.status === "running")) return "running";
  if (steps.some((step) => step.status === "failed")) return "failed";
  if (steps.some((step) => step.status === "confirm")) return "confirm";
  if (steps.some((step) => step.status === "cancelled")) return "cancelled";
  if (steps.some((step) => step.status === "pending")) return "pending";
  return "done";
}

function lastUsefulSummary(steps: AgentProcessStep[], fallback: string): string {
  const current = steps.find((step) => step.status === "running");
  const last = current ?? [...steps].reverse().find((step) => step.summary || step.label);
  return last?.summary || last?.label || fallback;
}

function contextSummary(steps: AgentProcessStep[]): string {
  if (!steps.length) return "等待查阅相关信息";
  const current = steps.find((step) => step.status === "running");
  if (current) return current.summary || current.label;
  const failed = steps.find((step) => step.status === "failed");
  if (failed) return failed.summary || `${failed.label}未完成`;
  if (steps.length === 1) return lastUsefulSummary(steps, "已查阅相关信息");
  return `完成 ${steps.length} 次真实信息调用`;
}

function resultSummary(steps: AgentProcessStep[], technicalSteps: AgentProcessStep[]): string {
  const all = [...steps, ...technicalSteps];
  if (!all.length) return "等待整理处理结果";
  if (all.some((step) => step.status === "confirm")) return "方案已整理好，尚未写入正式计划";
  return lastUsefulSummary(all, "已整理处理结果");
}

/**
 * 将扁平 processSteps 投影为用户可理解的阶段。
 * 工具调用按 toolCallId 原样保留在 steps 中；Loop 校验事件进入 technicalSteps。
 */
export function buildAgentProcessStages(steps: AgentProcessStep[]): AgentProcessStage[] {
  const understandingSteps = steps.filter(isPlanningStep).slice(0, 1);
  const toolSteps = steps.filter(isToolStep);
  const contextSteps = toolSteps.filter((step) => !isProposalStep(step));
  const proposalAttempts = toolSteps.filter(isProposalStep);
  // Proposal 重试在 UX 上是同一阶段的状态推进：主流程只显示最新结果，旧尝试进入技术记录。
  const resultSteps = proposalAttempts.length ? [proposalAttempts.at(-1)!] : [];
  const supersededProposalIds = new Set(proposalAttempts.slice(0, -1).map((step) => step.id));
  const technicalSteps = compactTechnicalSteps(steps, supersededProposalIds);

  const stages: AgentProcessStage[] = [];
  if (understandingSteps.length) {
    stages.push({
      id: "understanding",
      label: "理解你的需求",
      summary: lastUsefulSummary(understandingSteps, "已理解本次处理目标"),
      status: processStageStatus(understandingSteps),
      steps: understandingSteps,
      technicalSteps: [],
    });
  }
  if (contextSteps.length) {
    stages.push({
      id: "context",
      label: "查阅相关信息",
      summary: contextSummary(contextSteps),
      status: processStageStatus(contextSteps),
      steps: contextSteps,
      technicalSteps: [],
    });
  }
  if (resultSteps.length || technicalSteps.length) {
    // 已恢复的旧 proposal 失败不再污染当前阶段状态；最终 Loop 判断仍参与确认/失败状态。
    const resultStatusSteps = [
      ...resultSteps,
      ...technicalSteps.filter((step) => !supersededProposalIds.has(step.id)),
    ];
    stages.push({
      id: "result",
      label: resultSteps.length ? "形成处理方案" : "整理处理结果",
      summary: resultSummary(resultSteps, technicalSteps),
      status: processStageStatus(resultStatusSteps),
      steps: resultSteps,
      technicalSteps,
    });
  }

  // 兼容旧记录：若无法识别事件种类，至少保留一个可展开阶段，不丢展示能力。
  if (!stages.length && steps.length) {
    stages.push({
      id: "result",
      label: "处理过程",
      summary: lastUsefulSummary(steps, "已完成处理"),
      status: processStageStatus(steps),
      steps,
      technicalSteps: [],
    });
  }
  return stages;
}

export function completedAgentProcessCount(steps: AgentProcessStep[]): number {
  return buildAgentProcessTimeline(steps)
    .filter((step) => step.status === "done" || step.status === "failed" || step.status === "cancelled").length;
}

/** 收起态摘要优先说明真实工具调用和确认边界，不复述内部自检文案。 */
export function buildAgentProcessSummary(steps: AgentProcessStep[], active: boolean): string {
  const stages = buildAgentProcessStages(steps);
  const activeStage = stages.find((stage) => stage.status === "running");
  if (active && activeStage) return `${activeStage.label} · ${activeStage.summary}`;
  if (active) return "正在处理";
  if (stages.some((stage) => stage.status === "failed")) return "部分动作未完成，可查看过程";
  if (stages.some((stage) => stage.status === "confirm")) return "方案已整理好，等待你的确认";
  const toolCount = steps.filter(isToolStep).length;
  const resultStage = stages.find((stage) => stage.id === "result");
  if (toolCount && resultStage) return `完成 ${toolCount} 次真实调用，${resultStage.summary}`;
  if (toolCount) return `完成 ${toolCount} 次真实调用`;
  return resultStage?.summary || stages.at(-1)?.summary || "处理已完成";
}
