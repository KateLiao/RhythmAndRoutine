import { zonedDateKey, zonedDateTimeToUtc, zonedParts, zonedPeriod } from "@/lib/timezone";

export type ReviewScheduleSettings = {
  timezone: string;
  dailyReviewTime: string;
  weeklyReviewDay: number;
  weeklyReviewTime: string;
};

type ReviewPeriodRecord = {
  type: string;
  periodStart: string;
  periodEnd: string;
};

export type DueReviewPeriod = {
  type: "daily" | "weekly";
  periodStart: Date;
  periodEnd: Date;
};

/**
 * 计算用户最近已经到期的日回顾与周回顾周期，每种类型只返回一份。
 * @param settings - 用户时区及日、周回顾触发设置
 * @param now - 用于判定是否到期的当前时刻
 * @returns 最近到期的日回顾与周回顾周期
 */
export function resolveMostRecentDueReviewPeriods(
  settings: ReviewScheduleSettings,
  now: Date,
): { daily: DueReviewPeriod; weekly: DueReviewPeriod } {
  const localNow = zonedParts(now, settings.timezone);
  const todayKey = zonedDateKey(now, settings.timezone);
  const dailyDueToday = zonedDateTimeToUtc(todayKey, settings.dailyReviewTime, settings.timezone);
  const dailyDateKey = now >= dailyDueToday ? todayKey : shiftDateKey(todayKey, -1);

  const daysSinceWeeklyTrigger = (localNow.weekday - settings.weeklyReviewDay + 7) % 7;
  let weeklyDateKey = shiftDateKey(todayKey, -daysSinceWeeklyTrigger);
  const weeklyDue = zonedDateTimeToUtc(weeklyDateKey, settings.weeklyReviewTime, settings.timezone);
  if (now < weeklyDue) weeklyDateKey = shiftDateKey(weeklyDateKey, -7);

  return {
    daily: toDueReviewPeriod("daily", dailyDateKey, settings.timezone),
    weekly: toDueReviewPeriod("weekly", weeklyDateKey, settings.timezone),
  };
}

/**
 * 在回顾列表中选出当前应展示的日/周回顾：优先匹配最近到期周期，忽略尚未到期的“今天/本周”抢先生成。
 * @param reviews - 已加载的回顾记录
 * @param type - 日回顾或周回顾
 * @param settings - 用户时区与回顾触发设置
 * @param now - 当前时刻，测试时可注入
 * @returns 应展示的回顾；没有可用记录时返回 null
 */
export function selectCurrentReview<T extends ReviewPeriodRecord>(
  reviews: T[],
  type: "daily" | "weekly",
  settings: ReviewScheduleSettings,
  now = new Date(),
): T | null {
  const ofType = reviews.filter((review) => review.type === type);
  if (!ofType.length) return null;

  const due = resolveMostRecentDueReviewPeriods(settings, now)[type];
  const dueStart = due.periodStart.toISOString();
  const matched = ofType.find((review) => review.periodStart === dueStart);
  if (matched) return matched;

  return ofType
    .filter((review) => review.periodEnd <= due.periodEnd.toISOString())
    .sort((a, b) => b.periodStart.localeCompare(a.periodStart))[0] ?? null;
}

/**
 * 解析手动生成或重新生成应使用的周期：已有当前回顾则重写该周期，否则使用最近到期周期。
 * @param type - 日回顾或周回顾
 * @param settings - 用户时区与回顾触发设置
 * @param current - 当前 Tab 正在展示的回顾；无则传 null
 * @param now - 当前时刻
 * @returns UTC 周期起止时间
 */
export function resolveManualReviewPeriod(
  type: "daily" | "weekly",
  settings: ReviewScheduleSettings,
  current: Pick<ReviewPeriodRecord, "periodStart" | "periodEnd"> | null,
  now = new Date(),
): { periodStart: Date; periodEnd: Date } {
  if (current) {
    return { periodStart: new Date(current.periodStart), periodEnd: new Date(current.periodEnd) };
  }
  const due = resolveMostRecentDueReviewPeriods(settings, now)[type];
  return { periodStart: due.periodStart, periodEnd: due.periodEnd };
}

/**
 * 构造与回顾生成服务共用的周期幂等键。
 * @param userId - 用户 ID
 * @param type - 回顾类型
 * @param periodStart - 周期起始时刻
 * @param periodEnd - 周期结束时刻
 * @returns 可唯一标识用户、类型与周期的幂等键
 */
export function buildReviewIdempotencyKey(
  userId: string,
  type: "daily" | "weekly",
  periodStart: Date,
  periodEnd: Date,
): string {
  return `${userId}:${type}:${periodStart.toISOString()}:${periodEnd.toISOString()}`;
}

/**
 * 将本地触发日期转换为对应日/周周期。
 * @param type - 回顾类型
 * @param localDateKey - 触发日在用户时区下的日期键
 * @param timezone - 用户 IANA 时区
 * @returns UTC 表示的周期起止时间
 */
function toDueReviewPeriod(
  type: "daily" | "weekly",
  localDateKey: string,
  timezone: string,
): DueReviewPeriod {
  const localNoon = zonedDateTimeToUtc(localDateKey, "12:00", timezone);
  const { start, end } = zonedPeriod(localNoon, timezone, type);
  return { type, periodStart: start, periodEnd: end };
}

/**
 * 按自然日移动 YYYY-MM-DD 日期键，不受运行机器时区影响。
 * @param dateKey - 原始日期键
 * @param days - 需要移动的自然日数量，可为负数
 * @returns 移动后的日期键
 */
function shiftDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}
