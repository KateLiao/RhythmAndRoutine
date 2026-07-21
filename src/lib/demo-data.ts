import {
  definitionsForModules,
  deriveGoalActionHint,
  derivePlanningHints,
  evaluateAchievement,
  resolveAchievementModules,
  type AchievementView,
  type GoalExecutionFacts,
  type GoalExecutionOverview,
  type GoalLifecycleStatus,
} from "@/domain/goal-achievements";
import { evaluateMilestoneCriteria, type MilestoneCriteria } from "@/domain/milestone-suggestions";
import { zonedDateKey, zonedDateTimeToUtc, zonedPeriod } from "@/lib/timezone";

export type Goal = {
  id: string;
  title: string;
  description: string;
  status: GoalLifecycleStatus;
  color: "violet" | "sage" | "coral";
  weeklyMinutes: number;
  completedMinutes: number;
  tasksDone: number;
  tasksTotal: number;
  version?: number;
  category?: "project" | "skill" | "routine" | "mixed"; project?: string | null; skill?: string | null; targetDate?: string | null;
  execution?: GoalExecutionOverview;
  achievementHistory?: Array<{ achievementId: string; unlockedAt: string }>;
  tasks?: Array<{ id: string; title: string; status: string; version: number; estimatedMinutes?: number | null; intent?: string | null; completionCriteria?: string[] | null; suggestedSteps?: string[] | null; energyLevel?: string | null; focusLevel?: string | null; rhythmConditions?: unknown; milestoneId?: string | null; completedAt?: string | null; completionRecord?: TaskCompletionRecord | null }>;
  routines?: Array<{ id: string; title: string; status: string; version: number; recurrenceRule: string; startDate: string; endDate?: string | null; durationMinutes: number; preferredStartTime?: string | null; preferredEndTime?: string | null; preferredTimeOfDay?: string | null; priority?: string; displayMode?: string; minimumVersion?: string | null; description?: string | null; executionRecords?: RoutineExecution[] }>;
  outcomes?: Array<{ id: string; description: string; completedAt?: string | null; version: number }>;
  milestones?: Array<{ id: string; title: string; description?: string | null; status: string; version: number; targetDate?: string | null; completedAt?: string | null; completionCriteria?: MilestoneCriteria | null; reviewSuggestions?: MilestoneReviewSuggestion[] }>;
};

export type MilestoneReviewSuggestion = {
  id: string;
  milestoneId: string;
  milestoneVersion: number;
  reason: string;
  status: "pending" | "snoozed" | "dismissed" | "accepted" | "superseded";
  suggestedAt: string;
  snoozedUntil?: string | null;
  decisionReason?: string | null;
  decidedAt?: string | null;
  evidence?: unknown;
};

export type TaskCompletionRecord = {
  investedMinutes: number;
  completedSessions: number;
  executionSummary: string;
  overallEvaluation: string;
  source: "ai" | "rules";
  generatedAt: string;
};

export type ScheduleItem = {
  id: string;
  title: string;
  goalId: string;
  start: string;
  end: string;
  kind: "task" | "routine" | "review" | "personal";
  status: "completed" | "planned" | "in_progress" | "missed" | "rescheduled" | "cancelled";
  energy: "high" | "medium" | "low";
  feedback?: string;
  version?: number;
  date?: string;
  taskId?: string;
  taskIds?: string[];
  routineId?: string;
  occurrenceDate?: string;
  source?: string;
  displayMode?: string;
  changeReason?: string | null;
  rescheduledFromId?: string | null;
  execution?: { result: string; feedbackVersion?: number; actualMinutes?: number | null; actualStartedAt?: string | null; actualEndedAt?: string | null; quality?: string | null; focusState?: string | null; obstacle?: string | null; deviationReason?: string | null; nextAction?: string | null; note?: string | null; comfortable?: boolean | null; timeFit?: string | null; tags: string[] };
};

export type RoutineExecution = { id: string; occurrenceDate: string; plannedStartAt?: string | null; plannedEndAt?: string | null; status: string; result?: string | null; feedbackVersion?: number; actualMinutes?: number | null; quality?: string | null; focusState?: string | null; feedbackTags: string[]; note?: string | null; rescheduledStartAt?: string | null; rescheduledEndAt?: string | null; createdAt: string; updatedAt: string };

export const initialGoals: Goal[] = [
  {
    id: "rr-mvp",
    title: "完成 Rhythm & Routine MVP",
    description: "跑通目标、日程、执行反馈与 AI 动态调整的完整闭环。",
    status: "active",
    color: "violet",
    weeklyMinutes: 720,
    completedMinutes: 355,
    tasksDone: 4,
    tasksTotal: 9,
    tasks: [
      { id: "task-schema", title: "梳理数据库实体关系", status: "completed", version: 1, estimatedMinutes: 90, intent: "明确核心业务实体和确认边界", completionCriteria: ["核心实体关系可支持 MVP 流程"], suggestedSteps: ["核对领域对象", "检查归档与版本字段"], energyLevel: "high", focusLevel: "high" },
      { id: "task-manual", title: "实现完整手动编辑流程", status: "ready", version: 1, estimatedMinutes: 90, intent: "确保 AI 不可用时产品仍然完整可用", completionCriteria: ["目标、任务、日历和反馈均可手动维护"], suggestedSteps: ["逐页检查编辑入口", "验证本地兜底存储"], energyLevel: "high", focusLevel: "high" },
      { id: "task-agent", title: "验收 Agent ChangeSet 闭环", status: "ready", version: 1, estimatedMinutes: 60, intent: "验证 AI 建议不会绕过人工确认", completionCriteria: ["ChangeSet 可确认、拒绝并安全应用"], suggestedSteps: ["生成调整建议", "核对变更摘要", "确认后检查日历"], energyLevel: "medium", focusLevel: "high" },
    ],
    routines: [{ id: "routine-review", title: "一天的轻回顾", status: "active", version: 1, recurrenceRule: "FREQ=DAILY;BYHOUR=21;BYMINUTE=30", startDate: new Date().toISOString(), durationMinutes: 15, preferredStartTime: "21:30", displayMode: "subtle", executionRecords: [] }],
    outcomes: [{ id: "outcome-mvp", description: "完成一个可日常使用的 AI Native 个人目标推进产品 MVP", completedAt: null, version: 1 }],
    milestones: [
      { id: "milestone-core", title: "基础业务闭环", description: "手动创建目标、安排日程并记录执行反馈。", status: "pending", version: 1 },
      { id: "milestone-agent", title: "小律规划与调整", description: "AI 建议经确认后进入正式计划。", status: "pending", version: 1 },
    ],
  },
  {
    id: "fitness",
    title: "保持稳定的力量训练",
    description: "每周完成 3–4 次训练，让节奏比意志力更可靠。",
    status: "active",
    color: "sage",
    weeklyMinutes: 240,
    completedMinutes: 155,
    tasksDone: 2,
    tasksTotal: 3,
    routines: [{ id: "routine-push", title: "Push 训练", status: "active", version: 1, recurrenceRule: "FREQ=WEEKLY;BYDAY=TU,SA;BYHOUR=19;BYMINUTE=0", startDate: new Date().toISOString(), durationMinutes: 75, preferredStartTime: "19:00", displayMode: "subtle", executionRecords: [] }],
  },
  {
    id: "english",
    title: "英语项目表达",
    description: "能自然讲清自己的项目经历和产品判断。",
    status: "active",
    color: "coral",
    weeklyMinutes: 120,
    completedMinutes: 0,
    tasksDone: 0,
    tasksTotal: 0,
  },
];

/**
 * 解析日程块关联的全部任务 ID（兼容旧的单 taskId 字段）。
 * @param item - 日程块
 */
export function resolveScheduleTaskIds(item: ScheduleItem): string[] {
  if (item.taskIds?.length) return item.taskIds;
  return item.taskId ? [item.taskId] : [];
}

/**
 * 判断日程块是否与指定任务有关联。
 * @param item - 日程块
 * @param taskId - 任务 ID
 */
export function scheduleLinksTask(item: ScheduleItem, taskId: string): boolean {
  return resolveScheduleTaskIds(item).includes(taskId);
}

/**
 * 判断日程块是否属于指定目标：直接 goalId，或关联了该目标下任一任务。
 * 个人日程（无 goal、无任务）不算；仅用标题匹配不算。
 * @param item - 日程块
 * @param goal - 目标（需带 tasks 列表以便按任务反查）
 */
export function scheduleBelongsToGoal(item: ScheduleItem, goal: Pick<Goal, "id" | "tasks">): boolean {
  if (item.kind === "personal") return false;
  if (item.goalId && item.goalId === goal.id) return true;
  const taskIds = new Set((goal.tasks ?? []).map((task) => task.id));
  if (!taskIds.size) return false;
  return resolveScheduleTaskIds(item).some((taskId) => taskIds.has(taskId));
}

/**
 * 计算单个日程块的真实投入分钟数（优先实际耗时，否则用计划时长）。
 * @param item - 日程块
 */
export function scheduleInvestedMinutes(item: ScheduleItem): number {
  if (item.status !== "completed") return 0;
  const actual = item.execution?.actualMinutes;
  if (actual != null && actual > 0) return actual;
  return durationMinutes(item.start, item.end);
}

/**
 * 汇总任务关联日程块的真实投入总分钟数。
 * @param taskId - 任务 ID
 * @param schedule - 全部日程块
 */
export function taskInvestedMinutes(taskId: string, schedule: ScheduleItem[]): number {
  return schedule
    .filter((item) => scheduleLinksTask(item, taskId))
    .reduce((sum, item) => sum + scheduleInvestedMinutes(item), 0);
}

/**
 * 用已加载日程回填目标的本周计划/真实投入分钟（个人日程不计入）。
 * @param goals - 目标列表
 * @param schedule - 日程块
 * @param weekDateKeys - 本周日期键集合（YYYY-MM-DD）
 */
export function enrichGoalsWithScheduleStats(
  goals: Goal[],
  schedule: ScheduleItem[],
  weekDateKeys: Set<string>,
): Goal[] {
  return goals.map((goal) => {
    const goalBlocks = schedule.filter((item) => scheduleBelongsToGoal(item, goal) && item.status !== "cancelled" && item.status !== "rescheduled");
    const weekBlocks = goalBlocks.filter((item) => weekDateKeys.has(item.date ?? ""));
    const weeklyMinutes = weekBlocks.reduce((sum, item) => sum + durationMinutes(item.start, item.end), 0);
    const completedMinutes = weekBlocks
      .filter((item) => item.status === "completed")
      .reduce((sum, item) => sum + scheduleInvestedMinutes(item), 0);
    return { ...goal, weeklyMinutes, completedMinutes };
  });
}

/**
 * Browser-local mode uses the same achievement registry and visible overview
 * contract as database mode. Newly unlocked achievements are written into the
 * goal object so the existing `rr.goals` persistence keeps their first unlock
 * time stable across refreshes.
 */
export function enrichLocalGoalsWithExecution(goals: Goal[], schedule: ScheduleItem[], timezone: string, now = new Date()): Goal[] {
  const week = zonedPeriod(now, timezone, "weekly");
  return goals.map((goal) => {
    const lifecycleStatus: GoalLifecycleStatus = String(goal.status) === "draft" ? "active" : goal.status;
    const executionEvents = new Map<string, { type: "schedule" | "routine"; id: string; occurredAt: string; dateKey: string; minutes: number; estimated: boolean }>();
    let weekPlannedMinutes = 0;
    for (const item of schedule) {
      if (!scheduleBelongsToGoal(item, goal) || item.status === "cancelled" || item.status === "rescheduled") continue;
      const startsAt = localScheduleDate(item, timezone);
      const duration = durationMinutes(item.start, item.end);
      if (startsAt >= week.start && startsAt < week.end && item.status !== "missed") weekPlannedMinutes += duration;
      if (item.status !== "completed") continue;
      const dateKey = item.date ?? zonedDateKey(startsAt, timezone);
      const id = item.routineId ? `routine:${item.routineId}:${dateKey}` : `schedule:${item.id}`;
      const actual = item.execution?.actualMinutes;
      executionEvents.set(id, { type: item.routineId ? "routine" : "schedule", id, occurredAt: startsAt.toISOString(), dateKey, minutes: actual != null && actual > 0 ? actual : duration, estimated: !(actual != null && actual > 0) });
    }
    for (const routine of goal.routines ?? []) {
      for (const record of routine.executionRecords ?? []) {
        if (record.status !== "completed") continue;
        const dateKey = zonedDateKey(new Date(record.occurrenceDate), timezone);
        const id = `routine:${routine.id}:${dateKey}`;
        const existing = executionEvents.get(id);
        const actual = record.actualMinutes;
        const minutes = actual != null && actual > 0 ? actual : existing?.minutes ?? routine.durationMinutes;
        if (!existing || actual != null && actual > 0) executionEvents.set(id, { type: "routine", id, occurredAt: record.occurrenceDate, dateKey, minutes, estimated: !(actual != null && actual > 0) });
      }
    }

    const executionRefs = [...executionEvents.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const activeDateKeys = [...new Set(executionRefs.map((ref) => ref.dateKey))].sort();
    const weekRefs = executionRefs.filter((ref) => { const date = new Date(ref.occurredAt); return date >= week.start && date < week.end; });
    const taskRefs = (goal.tasks ?? []).filter((task) => task.completionRecord).map((task) => ({ type: "task" as const, id: task.id, occurredAt: task.completedAt ?? task.completionRecord!.generatedAt }));
    const milestoneRefs = (goal.milestones ?? []).filter((milestone) => milestone.status === "completed").map((milestone) => ({ type: "milestone" as const, id: milestone.id, occurredAt: milestone.completedAt ?? now.toISOString() }));
    const outcomeRefs = (goal.outcomes ?? []).filter((outcome) => outcome.completedAt).map((outcome) => ({ type: "outcome" as const, id: outcome.id, occurredAt: outcome.completedAt! }));
    const routineRefs = executionRefs.filter((ref) => ref.type === "routine");
    const facts: GoalExecutionFacts = {
      goalId: goal.id,
      lifecycleStatus,
      investedMinutes: executionRefs.reduce((sum, ref) => sum + ref.minutes, 0),
      weekInvestedMinutes: weekRefs.reduce((sum, ref) => sum + ref.minutes, 0),
      activeDateKeys,
      weekActiveDateKeys: [...new Set(weekRefs.map((ref) => ref.dateKey))].sort(),
      completedSessions: executionRefs.length,
      longestSessionMinutes: executionRefs.reduce((longest, ref) => Math.max(longest, ref.minutes), 0),
      confirmedTaskCount: taskRefs.length,
      confirmedMilestoneCount: milestoneRefs.length,
      confirmedOutcomeCount: outcomeRefs.length,
      routineCompletedCount: routineRefs.length,
      routineActiveWeekKeys: [...new Set(routineRefs.map((ref) => localMondayKey(ref.dateKey)))].sort(),
      returnedAfterGap: activeDateKeys.some((key, index) => index > 0 && localDaysBetween(activeDateKeys[index - 1]!, key) >= 14),
      weekPlannedMinutes,
      evidenceRefs: [...executionRefs, ...taskRefs, ...milestoneRefs, ...outcomeRefs].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)),
    };

    const milestones = syncLocalMilestoneSuggestions(goal.milestones ?? [], facts, now);
    const modules = resolveAchievementModules({ category: goal.category, project: goal.project, skill: goal.skill, hasRoutine: Boolean(goal.routines?.length) });
    const history = [...(goal.achievementHistory ?? [])];
    const historyById = new Map(history.map((item) => [item.achievementId, item]));
    const achievements: AchievementView[] = definitionsForModules(modules).map((definition) => {
      const evaluation = evaluateAchievement(definition, facts);
      let unlocked = historyById.get(definition.id);
      if (evaluation.met && !unlocked) {
        unlocked = { achievementId: definition.id, unlockedAt: localAchievementUnlockedAt(evaluation.evidenceRefs, now) };
        history.push(unlocked);
        historyById.set(definition.id, unlocked);
      }
      const evidenceSummary = localAchievementEvidence(definition.evaluator, evaluation.current, evaluation.target);
      return {
        id: definition.id,
        title: definition.title,
        description: definition.description,
        conditionLabel: definition.conditionLabel,
        module: definition.applicableModules[0]!,
        tier: definition.tier,
        icon: definition.icon,
        state: unlocked ? "unlocked" : evaluation.current > 0 ? "in_progress" : "locked",
        current: evaluation.current,
        target: evaluation.target,
        unlockedAt: unlocked?.unlockedAt,
        evidenceSummary,
      };
    });
    const visibleSuggestions = milestones.flatMap((milestone) => milestone.reviewSuggestions ?? []).filter((suggestion) => suggestion.status === "pending" || suggestion.status === "snoozed" && Boolean(suggestion.snoozedUntil && new Date(suggestion.snoozedUntil) <= now));
    const overdueMilestones = milestones.filter((milestone) => milestone.status === "pending" && milestone.targetDate && new Date(milestone.targetDate) < now).length;
    const recentAchievement = achievements.filter((achievement) => achievement.state === "unlocked").sort((a, b) => (b.unlockedAt ?? "").localeCompare(a.unlockedAt ?? ""))[0] ?? null;
    const execution: GoalExecutionOverview = {
      lifecycleStatus,
      investedMinutes: facts.investedMinutes,
      weekInvestedMinutes: facts.weekInvestedMinutes,
      weekPlannedMinutes,
      weekActiveDays: facts.weekActiveDateKeys.length,
      activeDays: activeDateKeys.length,
      completedSessions: facts.completedSessions,
      actionHint: deriveGoalActionHint({ lifecycleStatus, pendingMilestoneSuggestions: visibleSuggestions.length, overdueMilestones, weekPlannedMinutes, weekInvestedMinutes: facts.weekInvestedMinutes }),
      planningHints: derivePlanningHints({ outcomeCount: goal.outcomes?.length ?? 0, milestoneCount: goal.milestones?.length ?? 0, category: goal.category, targetDate: goal.targetDate, hasExecution: facts.completedSessions > 0 }),
      recentAchievement,
      achievements,
    };
    return { ...goal, status: lifecycleStatus, weeklyMinutes: weekPlannedMinutes, completedMinutes: facts.weekInvestedMinutes, milestones, achievementHistory: history, execution };
  });
}

function syncLocalMilestoneSuggestions(milestones: NonNullable<Goal["milestones"]>, facts: GoalExecutionFacts, now: Date): NonNullable<Goal["milestones"]> {
  return milestones.map((milestone) => {
    if (milestone.status !== "pending" || !milestone.completionCriteria) return milestone;
    const evaluation = evaluateMilestoneCriteria(milestone.completionCriteria, facts);
    if (!evaluation?.met) return milestone;
    const evidence = {
      milestoneVersion: milestone.version,
      criteria: milestone.completionCriteria,
      results: evaluation.results.map((result) => ({ id: result.id, current: result.current, target: result.target, met: result.met })),
      sourceRefs: evaluation.evidenceRefs,
    };
    const fingerprint = localStableFingerprint(evidence);
    const suggestions = [...(milestone.reviewSuggestions ?? [])];
    const existingIndex = suggestions.findIndex((suggestion) => suggestion.id === `local:${milestone.id}:${fingerprint}`);
    if (existingIndex >= 0) {
      const existing = suggestions[existingIndex]!;
      if ((existing.status === "snoozed" || existing.status === "dismissed") && existing.snoozedUntil && new Date(existing.snoozedUntil) <= now) {
        suggestions[existingIndex] = { ...existing, status: "pending", suggestedAt: now.toISOString(), snoozedUntil: null, decidedAt: null };
        return { ...milestone, reviewSuggestions: suggestions };
      }
      return milestone;
    }
    const superseded = suggestions.map((suggestion) => suggestion.status === "pending" || suggestion.status === "snoozed" ? { ...suggestion, status: "superseded" as const, decidedAt: now.toISOString(), decisionReason: "有更新的完成证据" } : suggestion);
    const matched = evaluation.results.filter((result) => result.met).map((result) => `${result.label}（${result.current}/${result.target}）`).join("；");
    return {
      ...milestone,
      reviewSuggestions: [{ id: `local:${milestone.id}:${fingerprint}`, milestoneId: milestone.id, milestoneVersion: milestone.version, reason: `以下公开完成标准已有证据：${matched}。请确认这是否足以代表阶段完成。`, status: "pending", suggestedAt: now.toISOString(), evidence }, ...superseded],
    };
  });
}

function localStableFingerprint(value: unknown): string {
  const input = JSON.stringify(localSortValue(value));
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) hash = Math.imul(hash ^ input.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

function localSortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(localSortValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, localSortValue(entry)]));
  return value;
}

function localScheduleDate(item: ScheduleItem, timezone: string): Date {
  if (!item.date) return new Date();
  return zonedDateTimeToUtc(item.date, item.start, timezone);
}

function localMondayKey(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function localDaysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00.000Z`).getTime() - new Date(`${a}T00:00:00.000Z`).getTime()) / 86_400_000);
}

function localAchievementUnlockedAt(refs: GoalExecutionFacts["evidenceRefs"], now: Date): string {
  return [...refs].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).at(-1)?.occurredAt ?? now.toISOString();
}

function localAchievementEvidence(evaluator: string, current: number, target: number): string {
  if (evaluator === "invested_minutes" || evaluator === "longest_session") return `${current} / ${target} 分钟`;
  if (evaluator === "active_days") return `${current} / ${target} 个有效执行日`;
  if (evaluator === "routine_active_weeks") return `${current} / ${target} 个自然周`;
  return `${current} / ${target}`;
}

/**
 * 本地模式下生成规则版任务完成总结（AI 不可用时的兜底）。
 * @param task - 任务信息
 * @param schedule - 全部日程块
 */
export function buildLocalTaskCompletionRecord(task: NonNullable<Goal["tasks"]>[number], schedule: ScheduleItem[]): TaskCompletionRecord {
  const blocks = schedule.filter((item) => scheduleLinksTask(item, task.id));
  const completed = blocks.filter((item) => item.status === "completed");
  const missed = blocks.filter((item) => item.status === "missed" || item.status === "rescheduled");
  const investedMinutes = taskInvestedMinutes(task.id, schedule);
  const smooth = completed.filter((item) => item.feedback === "smooth" || item.execution?.tags?.includes("smooth")).length;
  const executionSummary = completed.length
    ? `任务「${task.title}」共安排 ${blocks.length} 次，其中 ${completed.length} 次已完成，累计真实投入 ${investedMinutes} 分钟。${smooth ? `有 ${smooth} 次执行反馈为顺畅。` : ""}${missed.length ? `另有 ${missed.length} 次未完成或改期。` : ""}`
    : `任务「${task.title}」尚未留下已完成的时间块记录，本次由你直接确认完成。`;
  const criteria = task.completionCriteria ?? [];
  const overallEvaluation = criteria.length
    ? `对照完成标准（${criteria.join("；")}），你已确认此任务完成。${task.intent ? `原任务意图是：${task.intent}` : ""}`
    : `你已确认任务「${task.title}」完成。${task.intent ? `它原本指向：${task.intent}` : ""}`;
  return {
    investedMinutes,
    completedSessions: completed.length,
    executionSummary,
    overallEvaluation,
    source: "rules",
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 将 HH:mm 起止时间换算为分钟数。
 * @param start - 开始时间
 * @param end - 结束时间
 */
function durationMinutes(start: string, end: string) {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return Math.max(0, eh * 60 + em - sh * 60 - sm);
}

export const initialSchedule: ScheduleItem[] = [
  {
    id: "s1",
    title: "梳理数据库实体关系",
    goalId: "rr-mvp",
    start: "09:30",
    end: "11:00",
    kind: "task",
    status: "completed",
    energy: "high",
    feedback: "顺畅",
  },
  {
    id: "s2",
    title: "实现目标手动编辑流程",
    goalId: "rr-mvp",
    start: "14:00",
    end: "15:30",
    kind: "task",
    status: "planned",
    energy: "high",
  },
  {
    id: "s3",
    title: "Push 训练",
    goalId: "fitness",
    start: "19:00",
    end: "20:15",
    kind: "routine",
    status: "planned",
    energy: "medium",
  },
  {
    id: "s4",
    title: "一天的轻回顾",
    goalId: "rr-mvp",
    start: "21:30",
    end: "21:45",
    kind: "task",
    status: "planned",
    energy: "low",
  },
];
