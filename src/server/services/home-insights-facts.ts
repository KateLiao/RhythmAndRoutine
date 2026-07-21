import type { Goal, ScheduleItem } from "@/lib/demo-data";
import { scheduleInvestedMinutes } from "@/lib/demo-data";
import type { RhythmSignalRecord } from "@/lib/client-api";
import { buildMomentCandidates } from "@/lib/home-insights/compute-moment";
import { currentMinutes } from "@/lib/home-insights/helpers";
import { zonedDateKey, zonedPeriod, formatAgentTemporalAnchor } from "@/lib/timezone";
import { listGoals } from "@/server/services/goals";
import { listScheduleBlocks } from "@/server/services/schedule";
import { getDb } from "@/lib/db";
import { hashFacts } from "@/server/services/home-insights-hash";

export type MomentFacts = {
  temporalAnchor: string;
  timezone: string;
  dateKey: string;
  productConstraints: {
    executionRecording: string;
  };
  todayBlocks: Array<Record<string, unknown>>;
  completedHighFocusCount: number;
  unfinishedCount: number;
  readyTasksWithoutSchedule: Array<{ goalId: string; taskId: string; title: string; estimatedMinutes?: number | null }>;
  ruleCandidates: Array<Record<string, unknown>>;
};

/** 写入 LLM 提示的产品约束：用户只在结束后记录执行 */
export const HOME_INSIGHT_EXECUTION_WORKFLOW = "用户不在任务开始时打卡。日程块表示计划时段；用户在完成（或放弃）后通过「记录执行」复盘。status=planned 且计划开始已过，不代表未开始。禁止建议「改到此刻开始」或假设用户还没做。优先：继续执行、完成后来记录、安排后续块、插入缓冲。";

export type SlowFacts = {
  temporalAnchor: string;
  timezone: string;
  weekRange: { start: string; end: string };
  weekMetrics: { plannedMinutes: number; completedMinutes: number; missed: number };
  goalInvestment: Array<{ goalId: string; title: string; investedMinutes: number }>;
  rhythmSignals: RhythmSignalRecord[];
  executionByPeriod: Record<string, { done: number; total: number }>;
  recentReviewFindings: string[];
};

export type HomeInsightFactsBundle = {
  now: Date;
  timezone: string;
  goals: Goal[];
  schedule: ScheduleItem[];
  rhythmSignals: RhythmSignalRecord[];
  momentFacts: MomentFacts;
  slowFacts: SlowFacts;
  momentFactsHash: string;
  slowFactsHash: string;
};

/**
 * 将服务端日程块 ISO 时间格式化为 HH:mm。
 * @param iso - ISO 时间字符串
 * @param timezone - 用户时区
 */
function blockClock(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone }).format(new Date(iso));
}

/**
 * 将执行记录中的时间字段规范为 ISO 字符串。
 * @param value - Date 或 ISO 字符串
 */
function executionTimeValue(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * 将日程块映射为前端 ScheduleItem 结构，供规则引擎复用。
 * @param blocks - listScheduleBlocks 返回值
 * @param timezone - 用户时区
 */
export function mapServerBlocksToScheduleItems(blocks: Awaited<ReturnType<typeof listScheduleBlocks>>, timezone: string): ScheduleItem[] {
  return blocks.map((block) => {
    const isRoutineOccurrence = block.source === "routine_occurrence";
    const taskIds = isRoutineOccurrence
      ? []
      : "taskIds" in block && block.taskIds?.length
        ? block.taskIds
        : "linkedTasks" in block && block.linkedTasks?.length
          ? block.linkedTasks.map((link) => link.taskId)
          : "taskId" in block && block.taskId
            ? [block.taskId]
            : [];
    const er = block.executionRecord;
    const focusState = er?.rhythmFeedback && "focusState" in er.rhythmFeedback && typeof er.rhythmFeedback.focusState === "string"
      ? er.rhythmFeedback.focusState
      : er && "focusState" in er && typeof er.focusState === "string"
        ? er.focusState
        : undefined;
    return {
      id: block.id,
      title: block.title,
      goalId: block.goalId ?? "",
      taskId: taskIds[0],
      taskIds: taskIds.length ? taskIds : undefined,
      routineId: block.routineId ?? undefined,
      start: blockClock(block.startsAt, timezone),
      end: blockClock(block.endsAt, timezone),
      date: zonedDateKey(new Date(block.startsAt), timezone),
      occurrenceDate: "occurrenceDate" in block ? block.occurrenceDate : undefined,
      source: block.source,
      displayMode: "displayMode" in block ? block.displayMode : undefined,
      kind: block.routineId ? "routine" as const : (!block.goalId && !taskIds.length) ? "personal" as const : "task" as const,
      status: block.status === "completed" ? "completed" as const : block.status === "missed" ? "missed" as const : block.status === "rescheduled" ? "rescheduled" as const : block.status === "cancelled" ? "cancelled" as const : "planned" as const,
      energy: "medium" as const,
      version: block.version,
      execution: er ? {
        result: er.result,
        feedbackVersion: "feedbackVersion" in er ? er.feedbackVersion : undefined,
        actualMinutes: er.actualMinutes,
        actualStartedAt: "actualStartedAt" in er ? executionTimeValue(er.actualStartedAt) : undefined,
        actualEndedAt: "actualEndedAt" in er ? executionTimeValue(er.actualEndedAt) : undefined,
        quality: "quality" in er ? er.quality ?? undefined : undefined,
        obstacle: "obstacle" in er ? er.obstacle ?? undefined : undefined,
        deviationReason: "deviationReason" in er ? er.deviationReason ?? undefined : undefined,
        nextAction: "nextAction" in er ? er.nextAction ?? undefined : undefined,
        tags: er.rhythmFeedback?.tags ?? [],
        note: er.rhythmFeedback?.note ?? undefined,
        comfortable: er.rhythmFeedback && "comfortable" in er.rhythmFeedback ? er.rhythmFeedback.comfortable ?? undefined : undefined,
        timeFit: er.rhythmFeedback && "timeFit" in er.rhythmFeedback ? er.rhythmFeedback.timeFit ?? undefined : undefined,
        focusState,
      } : undefined,
    };
  });
}

/**
 * 将 listGoals 结果映射为带 UI 统计字段的 Goal 列表。
 * @param rawGoals - 服务端目标列表
 */
function mapGoals(rawGoals: Awaited<ReturnType<typeof listGoals>>): Goal[] {
  const colors = ["violet", "sage", "coral"] as const;
  return rawGoals.map((goal, index) => ({
    ...goal,
    description: goal.description ?? "",
    category: (goal.category ?? undefined) as Goal["category"],
    color: colors[index % colors.length],
    weeklyMinutes: 0,
    completedMinutes: 0,
    tasksDone: goal.tasks.filter((task) => String(task.status).toLowerCase() === "completed").length,
    tasksTotal: goal.tasks.length,
    status: goal.status as Goal["status"],
    tasks: goal.tasks.map((task) => ({ ...task, status: String(task.status).toLowerCase() })),
  })) as unknown as Goal[];
}

/**
 * 聚合用户首页洞察所需的 momentFacts 与 slowFacts。
 * @param userId - 用户 ID
 * @param timezone - 用户时区
 */
export async function buildHomeInsightFacts(userId: string, timezone: string): Promise<HomeInsightFactsBundle> {
  const now = new Date();
  const fetchTo = new Date(now.getFullYear(), now.getMonth() + 1, 7);
  const week = zonedPeriod(now, timezone, "weekly");
  const historyFrom = new Date(week.start);
  historyFrom.setDate(historyFrom.getDate() - 14);

  const [rawGoals, rawBlocks, rhythmRows, reviews] = await Promise.all([
    listGoals(userId),
    listScheduleBlocks(userId, historyFrom, fetchTo),
    getDb().rhythmSignal.findMany({
      where: { userId, OR: [{ validUntil: null }, { validUntil: { gt: now } }] },
      orderBy: [{ confidence: "desc" }, { updatedAt: "desc" }],
      take: 8,
    }),
    getDb().review.findMany({
      where: { userId, status: { in: ["DRAFT", "AWAITING_CONFIRMATION", "CONFIRMED"] } },
      orderBy: { createdAt: "desc" },
      take: 4,
      select: { findings: true, type: true },
    }),
  ]);

  const goals = mapGoals(rawGoals);
  const schedule = mapServerBlocksToScheduleItems(rawBlocks, timezone);
  const rhythmSignals: RhythmSignalRecord[] = rhythmRows.map((row) => ({
    id: row.id,
    type: row.type,
    statement: row.statement,
    confidence: row.confidence,
    evidence: row.evidence,
  }));

  const dateKey = zonedDateKey(now, timezone);
  const todayBlocks = schedule.filter((item) => item.date === dateKey && item.status !== "cancelled" && item.status !== "rescheduled");
  const candidates = buildMomentCandidates({ now, timezone, goals, schedule, rhythmSignals });
  const readyTasksWithoutSchedule = goals.flatMap((goal) =>
    (goal.tasks ?? [])
      .filter((task) => (task.status === "ready" || task.status === "scheduled") && !todayBlocks.some((block) => block.taskId === task.id || block.taskIds?.includes(task.id)))
      .map((task) => ({ goalId: goal.id, taskId: task.id, title: task.title, estimatedMinutes: task.estimatedMinutes })),
  );

  const momentFacts: MomentFacts = {
    temporalAnchor: formatAgentTemporalAnchor(now, timezone),
    timezone,
    dateKey,
    productConstraints: {
      executionRecording: HOME_INSIGHT_EXECUTION_WORKFLOW,
    },
    todayBlocks: todayBlocks.map((item) => ({
      id: item.id, title: item.title, start: item.start, end: item.end, status: item.status, kind: item.kind,
      goalId: item.goalId || null, taskId: item.taskId ?? null, focusHigh: item.energy === "high",
    })),
    completedHighFocusCount: todayBlocks.filter((item) => item.status === "completed").length,
    unfinishedCount: todayBlocks.filter((item) => item.status === "planned" || item.status === "missed").length,
    readyTasksWithoutSchedule,
    ruleCandidates: candidates.map((candidate) => ({
      headline: candidate.headline,
      judgment: candidate.judgment,
      reason: candidate.reason,
      nextLabel: candidate.nextLabel,
      action: candidate.action,
    })),
  };

  const weekBlocks = schedule.filter((item) => {
    if (item.status === "cancelled" || item.status === "rescheduled") return false;
    const blockDate = new Date(`${item.date ?? dateKey}T12:00:00`);
    return blockDate >= week.start && blockDate < week.end;
  });
  const plannedMinutes = weekBlocks.reduce((sum, item) => {
    const [sh, sm] = item.start.split(":").map(Number);
    const [eh, em] = item.end.split(":").map(Number);
    return sum + Math.max(0, eh * 60 + em - sh * 60 - sm);
  }, 0);
  const completedMinutes = weekBlocks.filter((item) => item.status === "completed").reduce((sum, item) => sum + scheduleInvestedMinutes(item), 0);
  const goalInvestment = goals.filter((g) => g.status === "active").map((goal) => ({
    goalId: goal.id,
    title: goal.title,
    investedMinutes: weekBlocks.filter((item) => item.goalId === goal.id && item.status === "completed").reduce((sum, item) => sum + scheduleInvestedMinutes(item), 0),
  }));

  const executionByPeriod: Record<string, { done: number; total: number }> = {};
  for (let i = 0; i < 7; i += 1) {
    const day = new Date(`${dateKey}T12:00:00`);
    day.setDate(day.getDate() - i);
    const key = zonedDateKey(day, timezone);
    for (const item of schedule.filter((entry) => entry.date === key && entry.kind !== "personal")) {
      const hour = Number(item.start.split(":")[0]);
      const bucket = hour < 12 ? "上午" : hour < 18 ? "下午" : "晚上";
      const slot = executionByPeriod[bucket] ?? { done: 0, total: 0 };
      slot.total += 1;
      if (item.status === "completed") slot.done += 1;
      executionByPeriod[bucket] = slot;
    }
  }

  const slowFacts: SlowFacts = {
    temporalAnchor: formatAgentTemporalAnchor(now, timezone),
    timezone,
    weekRange: { start: week.start.toISOString(), end: week.end.toISOString() },
    weekMetrics: {
      plannedMinutes,
      completedMinutes,
      missed: weekBlocks.filter((item) => item.status === "missed").length,
    },
    goalInvestment,
    rhythmSignals,
    executionByPeriod,
    recentReviewFindings: reviews.flatMap((review) => {
      const findings = Array.isArray(review.findings) ? review.findings as string[] : [];
      return findings.slice(0, 2);
    }),
  };

  return {
    now,
    timezone,
    goals,
    schedule,
    rhythmSignals,
    momentFacts,
    slowFacts,
    momentFactsHash: hashFacts(buildMomentFactsHashInput(momentFacts, now, timezone)),
    slowFactsHash: hashFacts(buildSlowFactsHashInput(slowFacts)),
  };
}

/**
 * 构建 moment 快照哈希输入：排除每分钟变化的 temporalAnchor，时间按 15 分钟分桶。
 * @param momentFacts - 完整 moment 事实
 * @param now - 当前时刻
 * @param timezone - 用户时区
 */
function buildMomentFactsHashInput(momentFacts: MomentFacts, now: Date, timezone: string) {
  const bucket15 = Math.floor(currentMinutes(now, timezone) / 15);
  return {
    dateKey: momentFacts.dateKey,
    timezone: momentFacts.timezone,
    timeBucket15: bucket15,
    todayBlocks: momentFacts.todayBlocks,
    completedHighFocusCount: momentFacts.completedHighFocusCount,
    unfinishedCount: momentFacts.unfinishedCount,
    readyTasksWithoutSchedule: momentFacts.readyTasksWithoutSchedule,
  };
}

/**
 * 构建 slow 快照哈希输入：排除 temporalAnchor 等每分钟变化的提示字段。
 * @param slowFacts - 完整 slow 事实
 */
function buildSlowFactsHashInput(slowFacts: SlowFacts) {
  return {
    timezone: slowFacts.timezone,
    weekRange: slowFacts.weekRange,
    weekMetrics: slowFacts.weekMetrics,
    goalInvestment: slowFacts.goalInvestment,
    rhythmSignals: slowFacts.rhythmSignals,
    executionByPeriod: slowFacts.executionByPeriod,
    recentReviewFindings: slowFacts.recentReviewFindings,
  };
}
