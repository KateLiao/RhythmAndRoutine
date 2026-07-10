import { zonedParts } from "@/lib/timezone";

/** moment 定时：每小时整点（用户时区分钟为 00） */
export const MOMENT_SCHEDULE_MINUTE = 0;

/** slow 定时：周三 weekday（0=周日 … 3=周三） */
export const SLOW_SCHEDULE_WEDNESDAY = 3;

/** slow 周三触发时刻 HH:mm */
export const SLOW_SCHEDULE_WEDNESDAY_TIME = "08:00";

/** slow 定时：周日 weekday */
export const SLOW_SCHEDULE_SUNDAY = 0;

/** slow 周日触发时刻 HH:mm */
export const SLOW_SCHEDULE_SUNDAY_TIME = "20:00";

export type InsightGenerationTrigger = "scheduled" | "manual" | "cold_start";

/**
 * 判断当前用户时区时刻是否应触发 moment 定时生成。
 * @param now - 当前时刻
 * @param timezone - 用户时区
 */
export function shouldRunMomentSchedule(now: Date, timezone: string): boolean {
  const parts = zonedParts(now, timezone);
  return parts.minute === MOMENT_SCHEDULE_MINUTE;
}

/**
 * 判断当前用户时区时刻是否应触发 slow 定时生成（周三 08:00 或周日 20:00）。
 * @param now - 当前时刻
 * @param timezone - 用户时区
 */
export function shouldRunSlowSchedule(now: Date, timezone: string): boolean {
  const parts = zonedParts(now, timezone);
  const currentTime = `${pad(parts.hour)}:${pad(parts.minute)}`;
  if (parts.weekday === SLOW_SCHEDULE_WEDNESDAY && currentTime === SLOW_SCHEDULE_WEDNESDAY_TIME) return true;
  if (parts.weekday === SLOW_SCHEDULE_SUNDAY && currentTime === SLOW_SCHEDULE_SUNDAY_TIME) return true;
  return false;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}
