export type ZonedDateParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };

export function zonedParts(date: Date, timeZone: string): ZonedDateParts {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date).map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.weekday) };
}

export function zonedDateTimeToUtc(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number); const [hour, minute, second = 0] = time.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute, second); let candidate = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const shown = zonedParts(new Date(candidate), timeZone);
    const delta = desired - Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second);
    if (!delta) break;
    candidate += delta;
  }
  return new Date(candidate);
}

export function zonedPeriod(now: Date, timeZone: string, type: "daily" | "weekly") {
  const local = zonedParts(now, timeZone); const anchor = new Date(Date.UTC(local.year, local.month - 1, local.day));
  if (type === "weekly") anchor.setUTCDate(anchor.getUTCDate() - ((local.weekday + 6) % 7));
  const endAnchor = new Date(anchor); endAnchor.setUTCDate(endAnchor.getUTCDate() + (type === "weekly" ? 7 : 1));
  const dateKey = (value: Date) => `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
  return { start: zonedDateTimeToUtc(dateKey(anchor), "00:00:00", timeZone), end: zonedDateTimeToUtc(dateKey(endAnchor), "00:00:00", timeZone) };
}

const weekdayZh = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

/**
 * 返回指定时刻在用户时区下的日期键（YYYY-MM-DD）。
 * @param date - 待转换的时刻
 * @param timeZone - IANA 时区，例如 Asia/Shanghai
 */
export function zonedDateKey(date: Date, timeZone: string) {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/**
 * 生成 Agent 时间锚点文案，避免模型臆造「今天」的日期与星期。
 * @param date - 当前时刻
 * @param timeZone - 用户时区
 */
export function formatAgentTemporalAnchor(date: Date, timeZone: string) {
  const parts = zonedParts(date, timeZone);
  const dateKey = zonedDateKey(date, timeZone);
  const weekday = weekdayZh[parts.weekday] ?? `星期${parts.weekday}`;
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(date);
  return `当前时刻（${timeZone}）：${dateKey}（${weekday}）${time}。用户说「今天」「今晚」「本周」时，必须以此为准，不得臆造日期。`;
}

/**
 * 解析 Agent 工具传入的日程窗口；无效时回退到用户时区的「今天」。
 * @param from - ISO 起始时间
 * @param to - ISO 结束时间
 * @param timeZone - 用户时区
 */
export function parseAgentScheduleWindow(from: string, to: string, timeZone: string) {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (!Number.isNaN(fromDate.getTime()) && !Number.isNaN(toDate.getTime()) && fromDate < toDate) {
    return { from: fromDate, to: toDate };
  }
  const today = zonedPeriod(new Date(), timeZone, "daily");
  return { from: today.start, to: today.end };
}
