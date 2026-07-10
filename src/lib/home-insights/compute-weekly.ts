import type { Goal, HomeInsightsInput, WeeklyCard, WeeklyStatus } from "./types";
import { blockDurationMinutes, formatDurationZh, scheduleInWeek } from "./helpers";

const STATUS_LABELS: Record<WeeklyStatus, string> = {
  relaxed: "偏松",
  balanced: "适中",
  full: "适中偏满",
  overload: "过载",
  off_track: "偏航",
};

/**
 * 计算单块对本周统计的贡献分钟数。
 * @param item - 日程块
 * @param useActual - 是否优先用实际耗时
 */
function minutesForBlock(item: import("./types").ScheduleItem, useActual: boolean): number {
  if (useActual && item.status === "completed") {
    const actual = item.execution?.actualMinutes;
    if (actual && actual > 0) return actual;
  }
  return blockDurationMinutes(item.start, item.end);
}

/**
 * 判断本周轨道状态。
 * @param planned - 计划分钟
 * @param completed - 完成分钟
 * @param missed - 错过块数
 * @param offTrackGoal - 是否有目标投入不足
 */
function resolveWeeklyStatus(planned: number, completed: number, missed: number, offTrackGoal: boolean): WeeklyStatus {
  if (offTrackGoal) return "off_track";
  const completionRate = planned > 0 ? completed / planned : 0;
  if (planned > 28 * 60) return "overload";
  if (missed >= 4 || completionRate < 0.35) return "overload";
  if (planned > 22 * 60) return "full";
  if (planned < 8 * 60 && completed < 4 * 60) return "relaxed";
  return "balanced";
}

/**
 * 找出本周投入明显不足的目标。
 * @param goals - 目标列表
 * @param byGoal - 各目标完成分钟
 */
function findUnderInvestedGoal(goals: Goal[], byGoal: Map<string, number>): { title: string; gap: string } | null {
  for (const goal of goals.filter((g) => g.status === "active")) {
    const invested = byGoal.get(goal.id) ?? 0;
    const target = goal.weeklyMinutes > 0 ? goal.weeklyMinutes : (goal.tasksTotal ?? 0) * 60;
    if (target > 0 && invested < target * 0.4) {
      return { title: goal.title, gap: `计划约 ${formatDurationZh(target)}，目前仅 ${formatDurationZh(invested)}` };
    }
  }
  const readyCount = goals.flatMap((g) => g.tasks ?? []).filter((t) => t.status === "ready").length;
  if (readyCount >= 3) {
    return { title: "多个 ready 任务", gap: `${readyCount} 个任务尚未形成稳定投入` };
  }
  return null;
}

/**
 * 计算「本周轨道」卡片内容。
 * @param input - 洞察计算输入
 */
export function computeWeeklyCard(input: HomeInsightsInput): WeeklyCard {
  const weekBlocks = scheduleInWeek(input.schedule, input.now, input.timezone);
  if (weekBlocks.length < 2) {
    return {
      kind: "empty",
      status: "balanced",
      statusLabel: STATUS_LABELS.balanced,
      plannedMinutes: 0,
      completedMinutes: 0,
      summary: "还没有足够的本周数据。",
      suggestion: "安排并完成几个日程块后，这里会显示你的本周负荷、目标投入和执行偏差。",
    };
  }

  const plannedMinutes = weekBlocks.reduce((sum, item) => sum + blockDurationMinutes(item.start, item.end), 0);
  const completedMinutes = weekBlocks
    .filter((item) => item.status === "completed")
    .reduce((sum, item) => sum + minutesForBlock(item, true), 0);
  const missed = weekBlocks.filter((item) => item.status === "missed").length;

  const byGoal = new Map<string, number>();
  for (const item of weekBlocks.filter((i) => i.status === "completed" && i.goalId)) {
    byGoal.set(item.goalId, (byGoal.get(item.goalId) ?? 0) + minutesForBlock(item, true));
  }

  const under = findUnderInvestedGoal(input.goals, byGoal);
  const status = resolveWeeklyStatus(plannedMinutes, completedMinutes, missed, Boolean(under));

  const stableGoals = input.goals
    .filter((g) => g.status === "active" && (byGoal.get(g.id) ?? 0) >= 60)
    .map((g) => g.title);

  let summary = `已安排 ${formatDurationZh(plannedMinutes)}，完成 ${formatDurationZh(completedMinutes)}。`;
  if (stableGoals.length) summary += `${stableGoals[0]} 推进稳定`;
  if (under) summary += `，但 ${under.title} 低于计划`;

  let suggestion: string | undefined;
  if (under) suggestion = `本周剩余时间可补：关注 ${under.title}（${under.gap}）。`;
  else if (status === "overload") suggestion = "本周延期或未完成偏多，建议改期或明确放弃部分块。";
  else if (status === "relaxed") suggestion = "本周安排偏松，可以给重点目标多占 1–2 个时间块。";

  return {
    kind: "track",
    status,
    statusLabel: STATUS_LABELS[status],
    plannedMinutes,
    completedMinutes,
    summary,
    suggestion,
  };
}
