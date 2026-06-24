import { getDb } from "@/lib/db";
import { zonedDateTimeToUtc, zonedParts } from "@/lib/timezone";
import { listScheduleBlocks } from "@/server/services/schedule";
import type { ContextDataSource } from "./context-builder";
import type { ContextReference } from "./types";

export class PrismaContextSource implements ContextDataSource {
  async getUser(userId: string) {
    const user = await getDb().user.findUniqueOrThrow({ where: { id: userId } });
    return { id: user.id, timezone: user.timezone, preferences: { dailyReviewTime: user.dailyReviewTime, weeklyReviewDay: user.weeklyReviewDay, weeklyReviewTime: user.weeklyReviewTime, defaultModel: user.defaultModel } };
  }
  async getGoalContext(userId: string, entityId?: string) {
    const data = await getDb().goal.findMany({ where: { userId, archivedAt: null, ...(entityId ? { id: entityId } : {}) }, include: { outcomes: true, milestones: true, tasks: { where: { archivedAt: null } }, routines: { where: { archivedAt: null } } }, take: entityId ? 1 : 12, orderBy: { updatedAt: "desc" } });
    return { data, references: data.map((item) => ref("goal", item.id, item.version, entityId ? "用户当前选中的目标" : "近期目标")) };
  }
  async getScheduleWindow(userId: string, days: number) {
    const user = await getDb().user.findUniqueOrThrow({ where: { id: userId }, select: { timezone: true } });
    const timezone = user.timezone;
    const local = zonedParts(new Date(), timezone);
    const anchor = new Date(Date.UTC(local.year, local.month - 1, local.day));
    anchor.setUTCDate(anchor.getUTCDate() - 2);
    const endAnchor = new Date(anchor);
    endAnchor.setUTCDate(endAnchor.getUTCDate() + days);
    const dateKey = (value: Date) => `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
    const from = zonedDateTimeToUtc(dateKey(anchor), "00:00:00", timezone);
    const to = zonedDateTimeToUtc(dateKey(endAnchor), "00:00:00", timezone);
    const data = await listScheduleBlocks(userId, from, to);
    return { data, references: data.map((item) => ref("schedule", item.id, "version" in item ? item.version : undefined, "近期日程窗口（含 Routine 虚拟实例）")) };
  }
  async getExecutionHistory(userId: string, days: number) {
    const from = new Date(); from.setDate(from.getDate() - days);
    const [scheduleExecutions, routineExecutions] = await Promise.all([
      getDb().executionRecord.findMany({ where: { scheduleBlock: { userId, startsAt: { gte: from } } }, include: { rhythmFeedback: true, scheduleBlock: { select: { id: true, title: true, startsAt: true, taskId: true, routineId: true } } }, orderBy: { updatedAt: "desc" }, take: 100 }),
      getDb().routineExecutionRecord.findMany({ where: { routine: { goal: { userId } }, updatedAt: { gte: from } }, include: { routine: { select: { id: true, title: true } } }, orderBy: { updatedAt: "desc" }, take: 100 }),
    ]);
    const data = [
      ...scheduleExecutions,
      ...routineExecutions.map((record) => ({
        id: record.id,
        source: "routine_occurrence" as const,
        routineId: record.routineId,
        routineTitle: record.routine.title,
        occurrenceDate: record.occurrenceDate.toISOString(),
        status: record.status,
        actualMinutes: record.actualMinutes,
        feedbackTags: record.feedbackTags,
        note: record.note,
        updatedAt: record.updatedAt.toISOString(),
      })),
    ];
    return { data, references: data.map((item) => ref("execution", item.id, undefined, "近期真实执行记录")) };
  }
  async getRecentReviews(userId: string, limit: number) {
    const data = await getDb().review.findMany({ where: { userId }, orderBy: { periodEnd: "desc" }, take: limit });
    return { data, references: data.map((item) => ref("review", item.id, undefined, "最近回顾")) };
  }
  async getRhythmSignals(userId: string, limit: number) {
    const data = await getDb().rhythmSignal.findMany({ where: { userId, OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }] }, orderBy: [{ confidence: "desc" }, { updatedAt: "desc" }], take: limit });
    return { data, references: data.map((item) => ref("rhythm_signal", item.id, undefined, "当前有效节奏信号")) };
  }
}

function ref(entityType: string, entityId: string, version: number | undefined, reason: string): ContextReference { return { entityType, entityId, version, reason }; }
