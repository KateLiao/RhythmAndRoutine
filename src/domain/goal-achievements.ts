export type GoalLifecycleStatus = "active" | "paused" | "completed" | "archived";
export type AchievementModule = "core" | "project" | "skill" | "routine";
export type AchievementTier = "basic" | "advanced" | "rare";
export type AchievementEvaluator =
  | "first_investment"
  | "active_days"
  | "invested_minutes"
  | "first_milestone"
  | "first_outcome"
  | "return_after_gap"
  | "confirmed_tasks"
  | "longest_session"
  | "routine_completed"
  | "routine_active_weeks";

export type GoalEvidenceRef = {
  type: "schedule" | "routine" | "task" | "milestone" | "outcome";
  id: string;
  occurredAt: string;
  dateKey?: string;
  minutes?: number;
  estimated?: boolean;
};

export type GoalExecutionFacts = {
  goalId: string;
  lifecycleStatus: GoalLifecycleStatus;
  investedMinutes: number;
  weekInvestedMinutes: number;
  activeDateKeys: string[];
  weekActiveDateKeys: string[];
  completedSessions: number;
  longestSessionMinutes: number;
  confirmedTaskCount: number;
  confirmedMilestoneCount: number;
  confirmedOutcomeCount: number;
  routineCompletedCount: number;
  routineActiveWeekKeys: string[];
  returnedAfterGap: boolean;
  weekPlannedMinutes: number;
  evidenceRefs: GoalEvidenceRef[];
};

export type AchievementDefinition = {
  id: string;
  version: number;
  title: string;
  description: string;
  conditionLabel: string;
  applicableModules: AchievementModule[];
  evaluator: AchievementEvaluator;
  threshold: number;
  tier: AchievementTier;
  icon: "spark" | "calendar" | "hourglass" | "flag" | "gem" | "return" | "package" | "focus" | "repeat";
};

export type AchievementEvaluation = {
  definition: AchievementDefinition;
  met: boolean;
  current: number;
  target: number;
  evidenceRefs: GoalEvidenceRef[];
};

export type AchievementView = {
  id: string;
  recordId?: string;
  title: string;
  description: string;
  conditionLabel: string;
  module: AchievementModule;
  tier: AchievementTier;
  icon: AchievementDefinition["icon"];
  state: "unlocked" | "in_progress" | "locked" | "revoked";
  current: number;
  target: number;
  unlockedAt?: string;
  evidenceSummary?: string;
};

export type GoalExecutionOverview = {
  lifecycleStatus: GoalLifecycleStatus;
  investedMinutes: number;
  weekInvestedMinutes: number;
  weekPlannedMinutes: number;
  weekActiveDays: number;
  activeDays: number;
  completedSessions: number;
  actionHint: GoalActionHint | null;
  planningHints: string[];
  recentAchievement: AchievementView | null;
  achievements: AchievementView[];
};

export type GoalActionHint = {
  kind: "milestone_review" | "overdue" | "schedule_next" | "steady";
  label: string;
  detail: string;
};

export const ACHIEVEMENT_DEFINITIONS: readonly AchievementDefinition[] = [
  { id: "core.first_investment", version: 1, title: "第一次让它发生", description: "目标不再只存在于计划里。", conditionLabel: "完成第一次真实投入", applicableModules: ["core"], evaluator: "first_investment", threshold: 1, tier: "basic", icon: "spark" },
  { id: "core.active_days_3", version: 1, title: "三次回到这里", description: "在三个不同日期重新回到这个目标。", conditionLabel: "累计 3 个有效执行日", applicableModules: ["core"], evaluator: "active_days", threshold: 3, tier: "basic", icon: "calendar" },
  { id: "core.invested_300", version: 1, title: "五小时的形状", description: "真实投入开始形成可以回看的积累。", conditionLabel: "累计真实投入 300 分钟", applicableModules: ["core"], evaluator: "invested_minutes", threshold: 300, tier: "advanced", icon: "hourglass" },
  { id: "core.first_milestone", version: 1, title: "阶段抵达", description: "你亲自确认了第一个阶段成果。", conditionLabel: "确认第一个里程碑", applicableModules: ["core"], evaluator: "first_milestone", threshold: 1, tier: "advanced", icon: "flag" },
  { id: "core.first_outcome", version: 1, title: "结果兑现", description: "目标第一次留下了被确认的结果。", conditionLabel: "确认第一个结果指标", applicableModules: ["core"], evaluator: "first_outcome", threshold: 1, tier: "rare", icon: "gem" },
  { id: "core.return_after_gap", version: 1, title: "重新接上节奏", description: "中断并不清零，回来本身值得记住。", conditionLabel: "间隔至少 14 天后再次有效执行", applicableModules: ["core"], evaluator: "return_after_gap", threshold: 1, tier: "advanced", icon: "return" },
  { id: "project.first_delivery", version: 1, title: "第一块交付", description: "完成了一项有总结记录的交付。", conditionLabel: "确认完成第一个带总结的任务", applicableModules: ["project"], evaluator: "confirmed_tasks", threshold: 1, tier: "basic", icon: "package" },
  { id: "project.deep_work_90", version: 1, title: "深入问题腹地", description: "一次完整的深度投入让复杂问题开始松动。", conditionLabel: "单次真实投入达到 90 分钟", applicableModules: ["project"], evaluator: "longest_session", threshold: 90, tier: "advanced", icon: "focus" },
  { id: "project.invested_600", version: 1, title: "做出十小时", description: "项目通过十小时真实工作逐渐成形。", conditionLabel: "累计真实投入 600 分钟", applicableModules: ["project"], evaluator: "invested_minutes", threshold: 600, tier: "rare", icon: "hourglass" },
  { id: "skill.practice_days_7", version: 1, title: "七日手感", description: "七次重新进入练习，比连续打卡更可靠。", conditionLabel: "累计 7 个有效练习日，无需连续", applicableModules: ["skill"], evaluator: "active_days", threshold: 7, tier: "advanced", icon: "calendar" },
  { id: "skill.invested_300", version: 1, title: "五小时练习场", description: "技能已经拥有五小时真实练习。", conditionLabel: "累计真实练习 300 分钟", applicableModules: ["skill"], evaluator: "invested_minutes", threshold: 300, tier: "advanced", icon: "hourglass" },
  { id: "skill.focus_session_45", version: 1, title: "一次完整练习", description: "完成了一次足够进入状态的练习。", conditionLabel: "单次真实练习达到 45 分钟", applicableModules: ["skill"], evaluator: "longest_session", threshold: 45, tier: "basic", icon: "focus" },
  { id: "routine.first_occurrence", version: 1, title: "第一次自然发生", description: "Routine 第一次真正发生。", conditionLabel: "完成第一次 Routine", applicableModules: ["routine"], evaluator: "routine_completed", threshold: 1, tier: "basic", icon: "repeat" },
  { id: "routine.completed_3", version: 1, title: "节奏开始成形", description: "三次发生让 Routine 不再只是设想。", conditionLabel: "累计完成 3 次 Routine", applicableModules: ["routine"], evaluator: "routine_completed", threshold: 3, tier: "basic", icon: "repeat" },
  { id: "routine.active_weeks_2", version: 1, title: "两周都有回应", description: "在两个不同自然周里都让它发生。", conditionLabel: "两个不同自然周至少各完成 1 次", applicableModules: ["routine"], evaluator: "routine_active_weeks", threshold: 2, tier: "advanced", icon: "calendar" },
  { id: "routine.completed_10", version: 1, title: "十次之后", description: "节奏已经留下十次真实记录。", conditionLabel: "累计完成 10 次 Routine", applicableModules: ["routine"], evaluator: "routine_completed", threshold: 10, tier: "rare", icon: "repeat" },
] as const;

export function resolveAchievementModules(input: { category?: string | null; project?: string | null; skill?: string | null; hasRoutine: boolean }): AchievementModule[] {
  const modules = new Set<AchievementModule>(["core"]);
  if (input.category === "project" || Boolean(input.project?.trim())) modules.add("project");
  if (input.category === "skill" || Boolean(input.skill?.trim())) modules.add("skill");
  if (input.category === "routine" || input.hasRoutine) modules.add("routine");
  return [...modules];
}

export function definitionsForModules(modules: AchievementModule[]): AchievementDefinition[] {
  const enabled = new Set(modules);
  return ACHIEVEMENT_DEFINITIONS.filter((definition) => definition.applicableModules.some((module) => enabled.has(module)));
}

export function evaluateAchievement(definition: AchievementDefinition, facts: GoalExecutionFacts): AchievementEvaluation {
  const { current, evidenceRefs } = evaluatorValue(definition.evaluator, facts);
  return {
    definition,
    current: Math.min(current, definition.threshold),
    target: definition.threshold,
    met: current >= definition.threshold,
    evidenceRefs,
  };
}

function evaluatorValue(evaluator: AchievementEvaluator, facts: GoalExecutionFacts): { current: number; evidenceRefs: GoalEvidenceRef[] } {
  switch (evaluator) {
    case "first_investment":
      return { current: facts.completedSessions, evidenceRefs: facts.evidenceRefs.filter((ref) => ref.type === "schedule" || ref.type === "routine").slice(0, 1) };
    case "active_days":
      return { current: facts.activeDateKeys.length, evidenceRefs: facts.evidenceRefs.filter((ref) => ref.type === "schedule" || ref.type === "routine") };
    case "invested_minutes":
      return { current: facts.investedMinutes, evidenceRefs: facts.evidenceRefs.filter((ref) => (ref.minutes ?? 0) > 0) };
    case "first_milestone":
      return { current: facts.confirmedMilestoneCount, evidenceRefs: facts.evidenceRefs.filter((ref) => ref.type === "milestone") };
    case "first_outcome":
      return { current: facts.confirmedOutcomeCount, evidenceRefs: facts.evidenceRefs.filter((ref) => ref.type === "outcome") };
    case "return_after_gap":
      return { current: facts.returnedAfterGap ? 1 : 0, evidenceRefs: facts.evidenceRefs.filter((ref) => ref.type === "schedule" || ref.type === "routine").slice(-2) };
    case "confirmed_tasks":
      return { current: facts.confirmedTaskCount, evidenceRefs: facts.evidenceRefs.filter((ref) => ref.type === "task") };
    case "longest_session":
      return { current: facts.longestSessionMinutes, evidenceRefs: facts.evidenceRefs.filter((ref) => ref.minutes === facts.longestSessionMinutes).slice(0, 1) };
    case "routine_completed":
      return { current: facts.routineCompletedCount, evidenceRefs: facts.evidenceRefs.filter((ref) => ref.type === "routine") };
    case "routine_active_weeks":
      return { current: facts.routineActiveWeekKeys.length, evidenceRefs: facts.evidenceRefs.filter((ref) => ref.type === "routine") };
  }
}

export function deriveGoalActionHint(input: {
  lifecycleStatus: GoalLifecycleStatus;
  pendingMilestoneSuggestions: number;
  overdueMilestones: number;
  weekPlannedMinutes: number;
  weekInvestedMinutes: number;
}): GoalActionHint | null {
  if (input.lifecycleStatus !== "active") return null;
  if (input.pendingMilestoneSuggestions > 0) return { kind: "milestone_review", label: "有里程碑待确认", detail: `${input.pendingMilestoneSuggestions} 个阶段成果等待你的判断` };
  if (input.overdueMilestones > 0) return { kind: "overdue", label: "需要重新校准阶段计划", detail: `${input.overdueMilestones} 个里程碑已过目标日期` };
  if (input.weekPlannedMinutes <= 0) return { kind: "schedule_next", label: "可以安排下一次行动", detail: input.weekInvestedMinutes > 0 ? "本周已经发生过，再为下一步留出时间" : "本周还没有目标日程" };
  return { kind: "steady", label: "按计划推进", detail: input.weekInvestedMinutes > 0 ? "本周已经留下真实投入" : "本周已有安排，等待执行" };
}

export function derivePlanningHints(input: { outcomeCount: number; milestoneCount: number; category?: string | null; targetDate?: string | Date | null; hasExecution: boolean }): string[] {
  const prefix = input.hasExecution ? "这个目标已经开始推进；" : "";
  const hints: string[] = [];
  if (!input.outcomeCount) hints.push(`${prefix}补充成功标准后，小律能更准确地判断成果。`);
  if (!input.milestoneCount) hints.push(`${prefix}可以增加一个阶段检查点，帮助你在途中校准。`);
  if (input.category === "project" && !input.targetDate) hints.push("如果项目有期限，可以补充目标日期；没有固定期限也不影响继续推进。");
  return hints;
}
