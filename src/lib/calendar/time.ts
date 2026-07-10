import { MIN_BLOCK_MINUTES, SNAP_MINUTES, TIMELINE_END_HOUR, TIMELINE_START_HOUR } from "./constants";

/**
 * 将 HH:mm 解析为从 0:00 起算的分钟数。
 * @param value - 时钟字符串
 */
export function parseClock(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

/**
 * 将分钟数格式化为 HH:mm。
 * @param totalMinutes - 从 0:00 起算的分钟数
 */
export function formatClock(totalMinutes: number) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * 格式化时间轴刻度标签，支持跨日归一化。
 * @param totalMinutes - 分钟数
 */
export function formatTimelineMinute(totalMinutes: number) {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  return formatClock(normalized);
}

/**
 * 将分钟数吸附到时间轴网格。
 * @param minutes - 原始偏移
 */
export function snapMinutes(minutes: number) {
  return Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;
}

/**
 * 约束分钟值在日视图可见范围内。
 * @param minutes - 待限制分钟
 * @param startHour - 起始小时
 * @param endHour - 结束小时
 */
export function clampTimelineMinutes(minutes: number, startHour = TIMELINE_START_HOUR, endHour = TIMELINE_END_HOUR) {
  const minBound = startHour * 60;
  const maxBound = endHour * 60;
  return Math.max(minBound, Math.min(minutes, maxBound - MIN_BLOCK_MINUTES));
}

/**
 * 约束日程块起止时间，保证最短时长且不越界。
 * @param start - 开始分钟
 * @param end - 结束分钟
 * @param startHour - 日视图起始小时
 * @param endHour - 日视图结束小时
 */
export function clampBlockTimes(start: number, end: number, startHour = TIMELINE_START_HOUR, endHour = TIMELINE_END_HOUR) {
  const minBound = startHour * 60;
  const maxBound = endHour * 60;
  let nextStart = snapMinutes(start);
  let nextEnd = snapMinutes(end);
  if (nextEnd - nextStart < MIN_BLOCK_MINUTES) {
    if (end !== start) nextEnd = nextStart + MIN_BLOCK_MINUTES;
    else nextStart = nextEnd - MIN_BLOCK_MINUTES;
  }
  nextStart = Math.max(minBound, Math.min(nextStart, maxBound - MIN_BLOCK_MINUTES));
  nextEnd = Math.max(nextStart + MIN_BLOCK_MINUTES, Math.min(nextEnd, maxBound));
  return { start: nextStart, end: nextEnd };
}

/**
 * 计算两个时钟时刻之间的分钟差。
 * @param start - 开始 HH:mm
 * @param end - 结束 HH:mm
 */
export function durationMinutes(start: string, end: string) {
  return Math.max(0, parseClock(end) - parseClock(start));
}

/**
 * 获取用户时区下的当前时刻（从 0:00 起算分钟）。
 * @param date - 当前时间
 * @param timezone - IANA 时区
 */
export function timeMinutesInTimezone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

/**
 * 格式化时区下的时钟显示。
 * @param date - 时间
 * @param timezone - IANA 时区
 */
export function formatTimeInTimezone(date: Date, timezone: string) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone }).format(date);
}
