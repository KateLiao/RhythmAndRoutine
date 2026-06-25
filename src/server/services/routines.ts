import { getDb } from "@/lib/db";
import { zonedDateTimeToUtc, zonedParts } from "@/lib/timezone";
import { DomainError } from "@/server/api-response";
import { routineExecutionSchema } from "@/server/validation";

const weekdayMap: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

export type ExpandedRoutineOccurrence = {
  id: string;
  title: string;
  goalId: string;
  routineId: string;
  startsAt: string;
  endsAt: string;
  occurrenceDate: string;
  status: "planned" | "completed" | "missed" | "rescheduled" | "cancelled";
  version: number;
  source: "routine_occurrence";
  blockKind: "routine_occurrence";
  displayMode: string;
  executionRecord?: { result: string; actualMinutes: number | null; rhythmFeedback: { tags: string[]; note: string | null } };
};

/** Expand active Routine definitions for a calendar window without creating ScheduleBlock rows. */
export async function expandRoutineOccurrences(userId: string, from: Date, to: Date): Promise<ExpandedRoutineOccurrence[]> {
  if (!(from < to) || to.getTime() - from.getTime() > 93 * 86400000) throw new DomainError("INVALID_RANGE", "Routine 展开范围必须在 93 天以内。", 400);
  const user = await getDb().user.findFirst({ where: { id: userId }, select: { timezone: true } });
  const timezone = user?.timezone ?? "Asia/Shanghai";
  const routines = await getDb().routine.findMany({
    where: { status: "ACTIVE", archivedAt: null, startDate: { lt: to }, OR: [{ endDate: null }, { endDate: { gte: from } }], goal: { userId } },
    include: { executionRecords: { where: { occurrenceDate: { gte: from, lt: to } } } },
  });
  return routines.flatMap((routine) => {
    if (routine.displayMode === "hidden_from_calendar") return [];
    const rule = parseRecurrenceRule(routine.recurrenceRule);
    const dates = enumerateOccurrenceDates(routine.startDate, routine.endDate, from, to, rule, timezone);
    return dates.map((dateKey) => {
      const originalStart = zonedDateTimeToUtc(dateKey, routine.preferredStartTime ?? rule.time, timezone);
      const occurrenceDate = zonedDateTimeToUtc(dateKey, "00:00", timezone);
      const record = routine.executionRecords.find((entry) => entry.occurrenceDate.getTime() === occurrenceDate.getTime());
      const startsAt = record?.rescheduledStartAt ?? originalStart;
      const endsAt = record?.rescheduledEndAt ?? new Date(startsAt.getTime() + routine.durationMinutes * 60000);
      const expired = endsAt < new Date();
      const status: ExpandedRoutineOccurrence["status"] = record?.status === "completed" ? "completed" : record?.status === "rescheduled" ? "rescheduled" : record?.status === "skipped" ? "cancelled" : record?.status === "missed" || expired ? "missed" : "planned";
      return {
        id: `routine:${routine.id}:${dateKey}`,
        title: routine.title,
        goalId: routine.goalId,
        routineId: routine.id,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        occurrenceDate: occurrenceDate.toISOString(),
        status,
        version: routine.version,
        source: "routine_occurrence" as const,
        blockKind: "routine_occurrence" as const,
        displayMode: routine.displayMode,
        ...(record && { executionRecord: { result: record.status, actualMinutes: record.actualMinutes, rhythmFeedback: { tags: record.feedbackTags, note: record.note } } }),
      };
    });
  }).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/** Persist only a user interaction with one virtual occurrence. */
export async function recordRoutineExecution(userId: string, raw: unknown) {
  const input = routineExecutionSchema.parse(raw);
  const routine = await getDb().routine.findFirst({ where: { id: input.routineId, archivedAt: null, goal: { userId } } });
  if (!routine) throw new DomainError("ROUTINE_NOT_FOUND", "没有找到这个 Routine。", 404);
  return getDb().routineExecutionRecord.upsert({
    where: { routineId_occurrenceDate: { routineId: routine.id, occurrenceDate: new Date(input.occurrenceDate) } },
    create: { routineId: routine.id, occurrenceDate: new Date(input.occurrenceDate), plannedStartAt: input.plannedStartAt ? new Date(input.plannedStartAt) : null, plannedEndAt: input.plannedEndAt ? new Date(input.plannedEndAt) : null, status: input.status, actualMinutes: input.actualMinutes, feedbackTags: input.feedbackTags, note: input.note, rescheduledStartAt: input.rescheduledStartAt ? new Date(input.rescheduledStartAt) : null, rescheduledEndAt: input.rescheduledEndAt ? new Date(input.rescheduledEndAt) : null },
    update: { status: input.status, actualMinutes: input.actualMinutes, feedbackTags: input.feedbackTags, note: input.note, rescheduledStartAt: input.rescheduledStartAt ? new Date(input.rescheduledStartAt) : null, rescheduledEndAt: input.rescheduledEndAt ? new Date(input.rescheduledEndAt) : null },
  });
}

export function parseRecurrenceRule(value: string) {
  const parts = Object.fromEntries(value.split(";").map((part) => { const [key, rawValue = ""] = part.split("="); return [key.toUpperCase(), rawValue]; }));
  return {
    frequency: ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(parts.FREQ) ? parts.FREQ : "DAILY",
    interval: Math.max(1, Number(parts.INTERVAL) || 1),
    weekdays: (parts.BYDAY || "").split(",").map((day) => weekdayMap[day]).filter((day) => day !== undefined),
    monthDays: (parts.BYMONTHDAY || "").split(",").map(Number).filter((day) => day >= 1 && day <= 31),
    count: Math.max(0, Number(parts.COUNT) || 0),
    until: parts.UNTIL || "",
    time: `${String(Math.min(23, Math.max(0, Number(parts.BYHOUR) || 9))).padStart(2, "0")}:${String(Math.min(59, Math.max(0, Number(parts.BYMINUTE) || 0))).padStart(2, "0")}`,
  };
}

function enumerateOccurrenceDates(startDate: Date, endDate: Date | null, from: Date, to: Date, rule: ReturnType<typeof parseRecurrenceRule>, timezone: string) {
  const start = zonedParts(startDate, timezone);
  const rangeStart = zonedParts(from, timezone);
  const rangeEnd = zonedParts(to, timezone);
  const anchor = new Date(Date.UTC(start.year, start.month - 1, start.day));
  const cursor = new Date(Date.UTC(rangeStart.year, rangeStart.month - 1, rangeStart.day));
  const last = new Date(Date.UTC(rangeEnd.year, rangeEnd.month - 1, rangeEnd.day));
  const hardEnd = endDate ? zonedParts(endDate, timezone) : null;
  const endAnchor = hardEnd ? new Date(Date.UTC(hardEnd.year, hardEnd.month - 1, hardEnd.day)) : null;
  const until = rule.until ? new Date(`${rule.until.slice(0, 4)}-${rule.until.slice(4, 6)}-${rule.until.slice(6, 8)}T12:00:00Z`) : null;
  const result: string[] = [];
  let occurrenceIndex = 0;
  for (const day = new Date(anchor); day < last; day.setUTCDate(day.getUTCDate() + 1)) {
    if (endAnchor && day > endAnchor || until && day > until) break;
    const diffDays = Math.floor((day.getTime() - anchor.getTime()) / 86400000);
    const diffMonths = (day.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + day.getUTCMonth() - anchor.getUTCMonth();
    const matches = rule.frequency === "DAILY"
      ? diffDays % rule.interval === 0
      : rule.frequency === "WEEKLY"
        ? Math.floor(diffDays / 7) % rule.interval === 0 && (rule.weekdays.length ? rule.weekdays.includes(day.getUTCDay()) : day.getUTCDay() === anchor.getUTCDay())
        : rule.frequency === "MONTHLY"
          ? diffMonths % rule.interval === 0 && (rule.monthDays.length ? rule.monthDays.includes(day.getUTCDate()) : day.getUTCDate() === anchor.getUTCDate())
          : day.getUTCFullYear() >= anchor.getUTCFullYear() && (day.getUTCFullYear() - anchor.getUTCFullYear()) % rule.interval === 0 && day.getUTCMonth() === anchor.getUTCMonth() && day.getUTCDate() === anchor.getUTCDate();
    if (!matches) continue;
    occurrenceIndex += 1;
    if (rule.count && occurrenceIndex > rule.count) break;
    if (day < cursor) continue;
    result.push(`${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, "0")}-${String(day.getUTCDate()).padStart(2, "0")}`);
  }
  return result;
}
