export type CalendarMode = "today" | "week" | "month";

/**
 * 将 Date 格式化为 YYYY-MM-DD（本地日历日，不含时区转换）。
 * @param date - 日期对象
 */
export function localDateKeyFromDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 由 YYYY-MM-DD 构造中午 12:00 的 Date，避免 DST 跳变。
 * @param dateKey - 日期键
 */
export function dateFromKey(dateKey: string) {
  return new Date(`${dateKey}T12:00:00`);
}

/**
 * 获取包含指定日期的周起始日（周一）。
 * @param dateKey - 锚点日期 YYYY-MM-DD
 */
export function weekStartFromDate(dateKey: string) {
  const date = dateFromKey(dateKey);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return localDateKeyFromDate(date);
}

/**
 * 生成从周一起连续 7 天的日期键。
 * @param weekStartKey - 周一日期键
 */
export function weekDateKeys(weekStartKey: string) {
  const start = dateFromKey(weekStartKey);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return localDateKeyFromDate(date);
  });
}

/**
 * 按视图模式步进锚点日期。
 * @param dateKey - 当前锚点
 * @param mode - 日历视图
 * @param delta - 步进方向（-1 或 1）
 */
export function shiftAnchorDate(dateKey: string, mode: CalendarMode, delta: number) {
  const date = dateFromKey(dateKey);
  if (mode === "today") date.setDate(date.getDate() + delta);
  else if (mode === "week") date.setDate(date.getDate() + delta * 7);
  else date.setMonth(date.getMonth() + delta, 1);
  return localDateKeyFromDate(date);
}

/**
 * 格式化顶栏日期标题。
 * @param dateKey - 锚点日期
 * @param mode - 视图模式
 * @param todayKey - 今天日期键
 * @param timezone - 用户时区
 */
export function formatToolbarTitle(dateKey: string, mode: CalendarMode, todayKey: string, timezone: string) {
  const date = dateFromKey(dateKey);
  const fmt = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("zh-CN", { ...options, timeZone: timezone }).format(date);

  if (mode === "today") {
    if (dateKey === todayKey) return `${fmt({ year: "numeric", month: "long", day: "numeric" })} 今天`;
    return fmt({ year: "numeric", month: "long", day: "numeric", weekday: "short" });
  }

  if (mode === "week") {
    return fmt({ year: "numeric", month: "long" });
  }

  return fmt({ year: "numeric", month: "long" });
}

/**
 * 月历网格起始日（包含月初所在周的周一）。
 * @param year - 年
 * @param month - 月（0-based）
 */
export function monthGridStart(year: number, month: number) {
  const first = new Date(year, month, 1);
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  return gridStart;
}

/**
 * 生成 42 格月历日期。
 * @param year - 年
 * @param month - 月（0-based）
 */
export function monthGridDays(year: number, month: number) {
  const gridStart = monthGridStart(year, month);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    return date;
  });
}
