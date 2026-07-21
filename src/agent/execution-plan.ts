import { capabilityCatalog } from "./capability-catalog";
import { capabilityPolicies } from "./capabilities";
import type { ExecutionPlan, ExecutionPlanStep, IntentResolution } from "./types";

const draftToolByCapability = {
  planning: "propose_planning",
  adjustment: "propose_change_set",
} as const;

export function buildExecutionPlan(resolution: IntentResolution): ExecutionPlan {
  const planId = `plan-${stablePlanKey(resolution)}`;
  const steps: ExecutionPlanStep[] = [];
  let previousOutcomeStep: string | undefined;

  for (const intent of resolution.intents) {
    const catalog = capabilityCatalog[intent.capability];
    const readTools = catalog.tools.filter((tool) => tool.startsWith("read_") || tool === "validate_schedule_candidates");
    const readStepId = `${intent.id}-evidence`;
    steps.push({
      id: readStepId,
      intentId: intent.id,
      objective: `取得完成“${intent.objective}”所需的最小证据`,
      capability: intent.capability,
      dependsOn: [],
      toolHints: readTools,
      access: "read",
      successCondition: "必需上下文可用，缺失来源已显式标记",
      failureStrategy: intent.missingSlots.length ? "ask_user" : "degrade",
    });

    const draftTool = intent.capability === "planning" || intent.capability === "adjustment" ? draftToolByCapability[intent.capability] : undefined;
    const outcomeStepId = `${intent.id}-${draftTool ? "draft" : "answer"}`;
    steps.push({
      id: outcomeStepId,
      intentId: intent.id,
      objective: intent.objective,
      capability: intent.capability,
      dependsOn: [readStepId, ...(previousOutcomeStep ? [previousOutcomeStep] : [])],
      toolHints: draftTool ? [draftTool] : [],
      access: draftTool ? "draft_write" : "read",
      successCondition: draftTool ? "生成待确认 ChangeSet，正式业务数据保持不变" : "给出带证据且区分事实与判断的结果",
      failureStrategy: intent.missingSlots.length ? "ask_user" : "stop",
    });
    previousOutcomeStep = outcomeStepId;

    if (draftTool) {
      const confirmationStepId = `${intent.id}-confirmation`;
      steps.push({
        id: confirmationStepId,
        intentId: intent.id,
        objective: "等待用户确认后再应用业务变更",
        capability: intent.capability,
        dependsOn: [outcomeStepId],
        toolHints: [],
        access: "user_confirmation",
        successCondition: "用户明确确认或拒绝草案",
        failureStrategy: "stop",
      });
      previousOutcomeStep = confirmationStepId;
    }
  }

  return { planId, intentIds: resolution.intents.map((intent) => intent.id), steps };
}

export type PlanValidationIssue = { code: string; stepId?: string; message: string };

export function validateExecutionPlan(plan: ExecutionPlan): { valid: boolean; issues: PlanValidationIssue[] } {
  const issues: PlanValidationIssue[] = [];
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (ids.has(step.id)) issues.push({ code: "DUPLICATE_STEP", stepId: step.id, message: `步骤 ${step.id} 重复。` });
    ids.add(step.id);
  }
  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) if (!ids.has(dependency)) issues.push({ code: "MISSING_DEPENDENCY", stepId: step.id, message: `依赖 ${dependency} 不存在。` });
    const allowlist = capabilityPolicies[step.capability].allowedTools;
    for (const tool of step.toolHints) if (!allowlist.includes(tool)) issues.push({ code: "TOOL_NOT_ALLOWED", stepId: step.id, message: `${tool} 不属于 ${step.capability}。` });
    if (step.access === "draft_write" && !step.toolHints.some((tool) => tool === "propose_planning" || tool === "propose_change_set")) issues.push({ code: "WRITE_TOOL_MISSING", stepId: step.id, message: "写草案步骤缺少 draft_write 工具。" });
    if (step.access === "draft_write" && !plan.steps.some((candidate) => candidate.access === "user_confirmation" && reaches(candidate.id, step.id, plan.steps))) issues.push({ code: "CONFIRMATION_MISSING", stepId: step.id, message: "写草案步骤后缺少用户确认屏障。" });
  }
  if (containsCycle(plan.steps)) issues.push({ code: "CYCLIC_PLAN", message: "执行计划包含循环依赖。" });
  return { valid: issues.length === 0, issues };
}

function containsCycle(steps: ExecutionPlanStep[]) {
  const dependencies = new Map(steps.map((step) => [step.id, step.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if ((dependencies.get(id) ?? []).some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return steps.some((step) => visit(step.id));
}

function reaches(fromId: string, targetId: string, steps: ExecutionPlanStep[]) {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const queue = [...(byId.get(fromId)?.dependsOn ?? [])];
  const visited = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (current === targetId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...(byId.get(current)?.dependsOn ?? []));
  }
  return false;
}

function stablePlanKey(resolution: IntentResolution) {
  const value = resolution.intents.map((intent) => `${intent.id}:${intent.capability}:${intent.objective}`).join("|");
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}
