import assert from "node:assert/strict";
import test from "node:test";
import { zonedDateTimeToUtc } from "@/lib/timezone";

/**
 * 与 expandRoutineOccurrences 内时间解析保持一致，用于回归测试改期后完成的时间展示。
 * @param dateKey - 发生日 YYYY-MM-DD
 * @param preferredTime - Routine 默认 HH:mm
 * @param timezone - 用户时区
 * @param record - 可选执行记录
 */
function resolveOccurrenceTimes(
  dateKey: string,
  preferredTime: string,
  durationMinutes: number,
  timezone: string,
  record?: {
    status: string;
    rescheduledStartAt?: Date | null;
    rescheduledEndAt?: Date | null;
    plannedStartAt?: Date | null;
    plannedEndAt?: Date | null;
  },
) {
  const originalStart = zonedDateTimeToUtc(dateKey, preferredTime, timezone);
  const startsAt = record?.rescheduledStartAt ?? record?.plannedStartAt ?? originalStart;
  const endsAt = record?.rescheduledEndAt ?? record?.plannedEndAt ?? new Date(startsAt.getTime() + durationMinutes * 60000);
  const status = record?.status === "completed" ? "completed" : record?.status === "rescheduled" ? "rescheduled" : "planned";
  return { startsAt, endsAt, status };
}

test("completed routine keeps rescheduled slot after marking done", () => {
  const timezone = "Asia/Shanghai";
  const dateKey = "2026-07-13";
  const rescheduledStart = zonedDateTimeToUtc(dateKey, "16:30", timezone);
  const rescheduledEnd = zonedDateTimeToUtc(dateKey, "18:00", timezone);
  const resolved = resolveOccurrenceTimes(dateKey, "09:00", 90, timezone, {
    status: "completed",
    rescheduledStartAt: rescheduledStart,
    rescheduledEndAt: rescheduledEnd,
  });
  assert.equal(resolved.status, "completed");
  assert.equal(resolved.startsAt.getTime(), rescheduledStart.getTime());
  assert.equal(resolved.endsAt.getTime(), rescheduledEnd.getTime());
});

test("completed routine without rescheduled fields falls back to planned slot", () => {
  const timezone = "Asia/Shanghai";
  const dateKey = "2026-07-13";
  const plannedStart = zonedDateTimeToUtc(dateKey, "16:30", timezone);
  const plannedEnd = zonedDateTimeToUtc(dateKey, "18:00", timezone);
  const resolved = resolveOccurrenceTimes(dateKey, "09:00", 90, timezone, {
    status: "completed",
    plannedStartAt: plannedStart,
    plannedEndAt: plannedEnd,
  });
  assert.equal(resolved.startsAt.getTime(), plannedStart.getTime());
  assert.equal(resolved.endsAt.getTime(), plannedEnd.getTime());
});
