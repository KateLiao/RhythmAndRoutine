import type { HomeInsightsInput, MomentCandidate, MomentCard } from "./types";
import {
  currentMinutes,
  formatClock,
  isHighFocusBlock,
  parseClock,
  roundToQuarterHour,
  scheduleForDate,
  timeOfDayHeadline,
  todayKey,
} from "./helpers";

/**
 * 构建今日此刻建议的候选列表（按 priority 升序）。
 * @param input - 洞察计算输入
 */
export function buildMomentCandidates(input: HomeInsightsInput): MomentCandidate[] {
  const { now, timezone, goals, schedule } = input;
  const date = todayKey(now, timezone);
  const today = scheduleForDate(schedule, date, timezone);
  const nowMin = currentMinutes(now, timezone);
  const candidates: MomentCandidate[] = [];

  const unfinished = today.filter((item) => item.status === "planned" || item.status === "missed");
  const completed = today.filter((item) => item.status === "completed");

  for (const item of unfinished) {
    const startMin = parseClock(item.start);
    if (nowMin > startMin + 10 && item.kind !== "routine") {
      candidates.push({
        priority: 10,
        headline: timeOfDayHeadline(now, timezone),
        judgment: `「${item.title}」的计划时段已过。如果正在做或已经做完，不必改时间。`,
        reason: "这里的安排是计划时段，不是开始打卡。完成后再点「记录执行」，系统才能了解你的真实节奏。",
        nextLabel: `记录「${item.title}」的执行情况`,
        action: {
          type: "open_execution_feedback",
          scheduleId: item.id,
          label: "记录执行",
        },
      });
    }
  }

  const upcoming = unfinished
    .filter((item) => {
      const startMin = parseClock(item.start);
      return startMin >= nowMin && startMin <= nowMin + 120;
    })
    .sort((a, b) => a.start.localeCompare(b.start));

  if (upcoming[0]) {
    const item = upcoming[0];
    const startMin = parseClock(item.start);
    if (startMin <= nowMin + 30) {
      candidates.push({
        priority: 20,
        headline: timeOfDayHeadline(now, timezone),
        judgment: `当前时段安排的是「${item.title}」。`,
        reason: "按计划推进即可；做完后记得记录执行，不必为了「对齐此刻」去改时间。",
        nextLabel: item.title,
        action: {
          type: "open_execution_feedback",
          scheduleId: item.id,
          label: "做完后记录",
        },
      });
    } else {
      candidates.push({
        priority: 25,
        headline: timeOfDayHeadline(now, timezone),
        judgment: `接下来 ${item.start} 有「${item.title}」。`,
        reason: "在开始前留 10 分钟缓冲，切换成本会更低。",
        nextLabel: item.title,
        action: {
          type: "open_schedule_form",
          goalId: item.goalId || undefined,
          taskId: item.taskId,
          date,
          start: item.start,
          end: item.end,
          label: "查看安排",
        },
      });
    }
  }

  const morningHighFocusDone = completed.some((item) => isHighFocusBlock(goals, item) && parseClock(item.end) <= 13 * 60);
  const afternoonDeep = unfinished.filter((item) => isHighFocusBlock(goals, item) && parseClock(item.start) >= 13 * 60);
  if (morningHighFocusDone && afternoonDeep.length > 0) {
    const bufferStart = roundToQuarterHour(nowMin + 5);
    candidates.push({
      priority: 30,
      headline: "下午适合稳稳推进",
      judgment: `你上午已经完成 ${completed.filter((i) => isHighFocusBlock(goals, i)).length} 个高专注块。`,
      reason: "连续高强度容易透支，先插入 30 分钟低阻力任务或缓冲，再进入下一个深度块。",
      nextLabel: "30 分钟缓冲 / 低阻力",
      action: {
        type: "create_schedule",
        title: "缓冲 / 低阻力恢复",
        start: formatClock(bufferStart),
        end: formatClock(bufferStart + 30),
        date,
        label: "插入缓冲",
      },
    });
  }

  const readyTasks = goals
    .flatMap((goal) => (goal.tasks ?? []).filter((t) => t.status === "ready" || t.status === "scheduled").map((t) => ({ goal, task: t })))
    .filter(({ task }) => !today.some((block) => block.taskId === task.id || block.taskIds?.includes(task.id)));

  if (readyTasks[0]) {
    const { goal, task } = readyTasks[0];
    const start = roundToQuarterHour(nowMin + 15);
    const minutes = task.estimatedMinutes ?? 45;
    candidates.push({
      priority: 40,
      headline: timeOfDayHeadline(now, timezone),
      judgment: `「${task.title}」还没排进今天。`,
      reason: "给 ready 任务占一个具体时间块，比留在清单里更容易启动。",
      nextLabel: `${formatClock(start)} ${task.title}`,
      action: {
        type: "create_schedule",
        title: task.title,
        start: formatClock(start),
        end: formatClock(start + Math.min(120, Math.max(30, minutes))),
        date,
        goalId: goal.id,
        taskId: task.id,
        label: "安排到此刻",
      },
    });
  }

  if (unfinished.length >= 5) {
    const deferTarget = unfinished[unfinished.length - 1];
    candidates.push({
      priority: 50,
      headline: "今天安排有点满",
      judgment: `今天还有 ${unfinished.length} 个未完成块。`,
      reason: "把优先级最低的一块改到明天，给今天留出可完成的空间。",
      nextLabel: `延后「${deferTarget.title}」`,
      action: {
        type: "open_schedule_form",
        goalId: deferTarget.goalId || undefined,
        taskId: deferTarget.taskId,
        date,
        start: deferTarget.start,
        end: deferTarget.end,
        label: "调整这一块",
      },
    });
  }

  return candidates.sort((a, b) => a.priority - b.priority);
}

/**
 * 计算「此刻建议」卡片内容。
 * @param input - 洞察计算输入
 */
export function computeMomentCard(input: HomeInsightsInput): MomentCard {
  const candidates = buildMomentCandidates(input);
  const index = candidates.length ? (input.alternateMomentIndex ?? 0) % candidates.length : 0;
  const picked = candidates[index];

  if (!picked) {
    return {
      kind: "empty",
      headline: "先从一个小时间块开始",
      judgment: "你今天还没有足够的执行记录。",
      reason: "可以先安排一个 30 分钟的小任务，让系统开始了解你的节奏。",
      alternateCount: 0,
    };
  }

  return {
    kind: "action",
    headline: picked.headline,
    judgment: picked.judgment,
    reason: picked.reason,
    nextLabel: picked.nextLabel,
    action: picked.action,
    alternateCount: candidates.length,
  };
}
