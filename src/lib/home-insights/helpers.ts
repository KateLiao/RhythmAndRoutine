import type { Goal, ScheduleItem } from "./types";
import { zonedDateKey, zonedParts, zonedPeriod } from "@/lib/timezone";

/**
 * 将 HH:mm 解析为当日分钟数。
 * @param value - 时间字符串，如 09:30
 */
export function parseClock(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + (minutes ?? 0);
}

/**
 * 计算两个时刻之间的分钟数。
 * @param start - 开始时间 HH:mm
 * @param end - 结束时间 HH:mm
 */
export function blockDurationMinutes(start: string, end: string): number {
  const diff = parseClock(end) - parseClock(start);
  return diff > 0 ? diff : diff + 24 * 60;
}

/**
 * 将分钟数对齐到 15 分钟网格。
 * @param minutes - 当日分钟数
 */
export function roundToQuarterHour(minutes: number): number {
  return Math.min(24 * 60 - 15, Math.max(0, Math.round(minutes / 15) * 15));
}

/**
 * 分钟数转 HH:mm。
 * @param minutes - 当日分钟数
 */
export function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * 返回用户时区下的今日日期键。
 * @param now - 当前时刻
 * @param timezone - IANA 时区
 */
export function todayKey(now: Date, timezone: string): string {
  return zonedDateKey(now, timezone);
}

/**
 * 返回用户时区下的当前分钟数。
 * @param now - 当前时刻
 * @param timezone - IANA 时区
 */
export function currentMinutes(now: Date, timezone: string): number {
  const parts = zonedParts(now, timezone);
  return parts.hour * 60 + parts.minute;
}

/**
 * 筛选指定日期的有效日程块。
 * @param schedule - 全部日程
 * @param date - YYYY-MM-DD
 * @param timezone - 用户时区（用于无 date 字段的块）
 */
export function scheduleForDate(schedule: ScheduleItem[], date: string, timezone: string): ScheduleItem[] {
  return schedule
    .filter((item) => item.status !== "cancelled" && item.status !== "rescheduled")
    .filter((item) => (!item.date && date === todayKey(new Date(), timezone)) || item.date === date)
    .sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * 判断任务是否为高专注。
 * @param goals - 目标列表
 * @param item - 日程块
 */
export function isHighFocusBlock(goals: Goal[], item: ScheduleItem): boolean {
  if (item.kind === "personal") return false;
  const task = goals.flatMap((g) => g.tasks ?? []).find((t) => t.id === item.taskId || item.taskIds?.includes(t.id));
  return task?.focusLevel === "high" || item.energy === "high";
}

/**
 * 获取本周时间窗口内的日程块。
 * @param schedule - 全部日程
 * @param now - 当前时刻
 * @param timezone - 用户时区
 */
export function scheduleInWeek(schedule: ScheduleItem[], now: Date, timezone: string): ScheduleItem[] {
  const { start, end } = zonedPeriod(now, timezone, "weekly");
  return schedule.filter((item) => {
    if (item.status === "cancelled" || item.status === "rescheduled") return false;
    const date = item.date ?? todayKey(now, timezone);
    const blockStart = new Date(`${date}T${item.start}:00`);
    return blockStart >= start && blockStart < end;
  });
}

/**
 * 格式化分钟为可读时长。
 * @param minutes - 总分钟数
 */
export function formatDurationZh(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * 根据当前时刻生成时段问候语。
 * @param now - 当前时刻
 * @param timezone - 用户时区
 */
export function timeOfDayHeadline(now: Date, timezone: string): string {
  const hour = zonedParts(now, timezone).hour;
  if (hour < 6) return "夜深了，适合收尾";
  if (hour < 12) return "上午适合专注推进";
  if (hour < 14) return "午间适合缓冲整理";
  if (hour < 18) return "下午适合稳稳推进";
  return "晚上适合轻量收尾";
}
