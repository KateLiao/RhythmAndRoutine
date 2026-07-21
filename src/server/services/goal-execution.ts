import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { AchievementEventType, GoalStatus, MilestoneStatus, ScheduleBlockStatus } from "@/generated/prisma/enums";
import {
  definitionsForModules,
  deriveGoalActionHint,
  derivePlanningHints,
  evaluateAchievement,
  resolveAchievementModules,
  type AchievementEvaluation,
  type AchievementView,
  type GoalEvidenceRef,
  type GoalExecutionFacts,
  type GoalExecutionOverview,
  type GoalLifecycleStatus,
} from "@/domain/goal-achievements";
import { getDb } from "@/lib/db";
import { DomainError } from "@/server/api-response";
import { zonedDateKey, zonedPeriod } from "@/lib/timezone";
import { achievementCorrectionSchema } from "@/server/validation";

export type GoalProjection = {
  id: string;
  status: GoalStatus;
  category: string | null;
  project: string | null;
  skill: string | null;
  targetDate: Date | null;
  outcomes: Array<{ id: string; completedAt: Date | null }>;
  milestones: Array<{ id: string; status: MilestoneStatus; targetDate: Date | null; completedAt: Date | null; completionCriteria?: Prisma.JsonValue | null; version?: number }>;
  tasks: Array<{ id: string; completedAt: Date | null; completionRecord: Prisma.JsonValue | null }>;
  routines: Array<{
    id: string;
    durationMinutes: number;
    archivedAt: Date | null;
    executionRecords: Array<{ id: string; occurrenceDate: Date; plannedStartAt: Date | null; plannedEndAt: Date | null; status: string; actualMinutes: number | null }>;
  }>;
};

export type ScheduleProjection = {
  id: string;
  userId: string;
  goalId: string | null;
  taskId: string | null;
  routineId: string | null;
  startsAt: Date;
  endsAt: Date;
  status: ScheduleBlockStatus;
  rescheduledFromId: string | null;
  deletedAt: Date | null;
  linkedTasks: Array<{ taskId: string }>;
  executionRecord: { actualMinutes: number | null } | null;
};

type PersistedAchievement = {
  id: string;
  goalId: string;
  achievementId: string;
  unlockedAt: Date;
  evidence: Prisma.JsonValue;
  revokedAt: Date | null;
};

export const goalExecutionInclude = {
  outcomes: { where: { archivedAt: null }, select: { id: true, completedAt: true } },
  milestones: { select: { id: true, status: true, targetDate: true, completedAt: true, completionCriteria: true, version: true } },
  tasks: { where: { archivedAt: null }, select: { id: true, completedAt: true, completionRecord: true } },
  routines: {
    where: { archivedAt: null },
    select: {
      id: true,
      durationMinutes: true,
      archivedAt: true,
      executionRecords: { select: { id: true, occurrenceDate: true, plannedStartAt: true, plannedEndAt: true, status: true, actualMinutes: true } },
    },
  },
} satisfies Prisma.GoalInclude;

export const scheduleProjectionSelect = {
  id: true,
  userId: true,
  goalId: true,
  taskId: true,
  routineId: true,
  startsAt: true,
  endsAt: true,
  status: true,
  rescheduledFromId: true,
  deletedAt: true,
  linkedTasks: { select: { taskId: true } },
  executionRecord: { select: { actualMinutes: true } },
} satisfies Prisma.ScheduleBlockSelect;

export function normalizeGoalLifecycleStatus(status: string): GoalLifecycleStatus {
  switch (status.toLowerCase()) {
    case "paused": return "paused";
    case "completed": return "completed";
    case "archived": return "archived";
    case "draft":
    case "active":
    default: return "active";
  }
}

export function projectGoalExecutionFacts(
  goal: GoalProjection,
  scheduleBlocks: ScheduleProjection[],
  timezone: string,
  now = new Date(),
): GoalExecutionFacts {
  const taskIds = new Set(goal.tasks.map((task) => task.id));
  const routineIds = new Set(goal.routines.map((routine) => routine.id));
  const routineDurations = new Map(goal.routines.map((routine) => [routine.id, routine.durationMinutes]));
  const supersededIds = new Set(scheduleBlocks.map((block) => block.rescheduledFromId).filter((id): id is string => Boolean(id)));
  const week = zonedPeriod(now, timezone, "weekly");
  const events = new Map<string, GoalEvidenceRef>();
  let weekPlannedMinutes = 0;

  for (const block of scheduleBlocks) {
    if (block.deletedAt || supersededIds.has(block.id)) continue;
    const linkedTaskIds = [block.taskId, ...block.linkedTasks.map((link) => link.taskId)].filter((id): id is string => Boolean(id));
    const belongs = block.goalId === goal.id || linkedTaskIds.some((id) => taskIds.has(id)) || Boolean(block.routineId && routineIds.has(block.routineId));
    if (!belongs) continue;
    const duration = Math.max(0, Math.round((block.endsAt.getTime() - block.startsAt.getTime()) / 60_000));
    const excludedFromPlan = block.status === ScheduleBlockStatus.CANCELLED || block.status === ScheduleBlockStatus.RESCHEDULED || block.status === ScheduleBlockStatus.MISSED;
    if (block.startsAt >= week.start && block.startsAt < week.end && !excludedFromPlan) {
      weekPlannedMinutes += duration;
    }
    if (block.status !== ScheduleBlockStatus.COMPLETED) continue;
    const actualMinutes = block.executionRecord?.actualMinutes;
    const minutes = actualMinutes != null && actualMinutes > 0 ? actualMinutes : duration;
    const dateKey = zonedDateKey(block.startsAt, timezone);
    const eventKey = block.routineId ? `routine:${block.routineId}:${dateKey}` : `schedule:${block.id}`;
    events.set(eventKey, { type: block.routineId ? "routine" : "schedule", id: eventKey, occurredAt: block.startsAt.toISOString(), dateKey, minutes, estimated: !(actualMinutes != null && actualMinutes > 0) });
  }

  for (const routine of goal.routines) {
    for (const record of routine.executionRecords) {
      if (record.status.toLowerCase() !== "completed") continue;
      const dateKey = zonedDateKey(record.occurrenceDate, timezone);
      const eventKey = `routine:${routine.id}:${dateKey}`;
      const existing = events.get(eventKey);
      const plannedMinutes = record.plannedStartAt && record.plannedEndAt ? Math.max(0, Math.round((record.plannedEndAt.getTime() - record.plannedStartAt.getTime()) / 60_000)) : 0;
      const hasActual = record.actualMinutes != null && record.actualMinutes > 0;
      const minutes = hasActual ? record.actualMinutes! : existing?.minutes ?? (plannedMinutes > 0 ? plannedMinutes : routineDurations.get(routine.id) ?? 0);
      if (!existing || hasActual) events.set(eventKey, { type: "routine", id: eventKey, occurredAt: record.occurrenceDate.toISOString(), dateKey, minutes, estimated: !hasActual });
    }
  }

  const executionRefs = [...events.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const activeDateKeys = [...new Set(executionRefs.map((ref) => zonedDateKey(new Date(ref.occurredAt), timezone)))].sort();
  const weekRefs = executionRefs.filter((ref) => { const date = new Date(ref.occurredAt); return date >= week.start && date < week.end; });
  const routineRefs = executionRefs.filter((ref) => ref.type === "routine");
  const taskRefs: GoalEvidenceRef[] = goal.tasks.filter((task) => task.completedAt && task.completionRecord != null).map((task) => ({ type: "task", id: task.id, occurredAt: task.completedAt!.toISOString() }));
  const milestoneRefs: GoalEvidenceRef[] = goal.milestones.filter((milestone) => milestone.status === MilestoneStatus.COMPLETED && milestone.completedAt).map((milestone) => ({ type: "milestone", id: milestone.id, occurredAt: milestone.completedAt!.toISOString() }));
  const outcomeRefs: GoalEvidenceRef[] = goal.outcomes.filter((outcome) => outcome.completedAt).map((outcome) => ({ type: "outcome", id: outcome.id, occurredAt: outcome.completedAt!.toISOString() }));
  const returnedAfterGap = activeDateKeys.some((dateKey, index) => index > 0 && daysBetween(activeDateKeys[index - 1]!, dateKey) >= 14);

  return {
    goalId: goal.id,
    lifecycleStatus: normalizeGoalLifecycleStatus(goal.status),
    investedMinutes: executionRefs.reduce((sum, ref) => sum + (ref.minutes ?? 0), 0),
    weekInvestedMinutes: weekRefs.reduce((sum, ref) => sum + (ref.minutes ?? 0), 0),
    activeDateKeys,
    weekActiveDateKeys: [...new Set(weekRefs.map((ref) => zonedDateKey(new Date(ref.occurredAt), timezone)))].sort(),
    completedSessions: executionRefs.length,
    longestSessionMinutes: executionRefs.reduce((longest, ref) => Math.max(longest, ref.minutes ?? 0), 0),
    confirmedTaskCount: taskRefs.length,
    confirmedMilestoneCount: milestoneRefs.length,
    confirmedOutcomeCount: outcomeRefs.length,
    routineCompletedCount: routineRefs.length,
    routineActiveWeekKeys: [...new Set(routineRefs.map((ref) => mondayDateKey(zonedDateKey(new Date(ref.occurredAt), timezone))))].sort(),
    returnedAfterGap,
    weekPlannedMinutes,
    evidenceRefs: [...executionRefs, ...taskRefs, ...milestoneRefs, ...outcomeRefs].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)),
  };
}

export async function getGoalExecutionOverviews(
  userId: string,
  goals: GoalProjection[],
  now = new Date(),
): Promise<Map<string, GoalExecutionOverview>> {
  if (!goals.length) return new Map();
  const db = getDb();
  const [user, scheduleBlocks, routineExecutions, persistedAchievements, pendingSuggestions] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { timezone: true } }),
    db.scheduleBlock.findMany({ where: { userId }, select: scheduleProjectionSelect }),
    db.routineExecutionRecord.findMany({
      where: { routine: { goal: { userId, id: { in: goals.map((goal) => goal.id) } } } },
      select: { id: true, routineId: true, occurrenceDate: true, plannedStartAt: true, plannedEndAt: true, status: true, actualMinutes: true },
    }),
    db.goalAchievement.findMany({ where: { goalId: { in: goals.map((goal) => goal.id) } }, orderBy: { unlockedAt: "desc" } }),
    db.milestoneReviewSuggestion.groupBy({ by: ["milestoneId"], where: { milestone: { goalId: { in: goals.map((goal) => goal.id) }, status: { in: [MilestoneStatus.PENDING, MilestoneStatus.READY_FOR_REVIEW] } }, status: "PENDING" }, _count: { _all: true } }),
  ]);
  const timezone = user?.timezone ?? "Asia/Shanghai";
  const achievementsByGoal = groupBy(persistedAchievements, (achievement) => achievement.goalId);
  const routineExecutionsByRoutine = groupBy(routineExecutions, (record) => record.routineId);
  const suggestionCountByMilestone = new Map(pendingSuggestions.map((row) => [row.milestoneId, row._count._all]));
  const overviews = new Map<string, GoalExecutionOverview>();

  for (const goal of goals) {
    const projectionGoal: GoalProjection = { ...goal, routines: goal.routines.map((routine) => ({ ...routine, executionRecords: routineExecutionsByRoutine.get(routine.id) ?? [] })) };
    const facts = projectGoalExecutionFacts(projectionGoal, scheduleBlocks, timezone, now);
    const modules = resolveAchievementModules({ category: goal.category, project: goal.project, skill: goal.skill, hasRoutine: goal.routines.length > 0 });
    const persisted = new Map((achievementsByGoal.get(goal.id) ?? []).map((achievement) => [achievement.achievementId, achievement]));
    const achievements = definitionsForModules(modules).map((definition) => achievementView(evaluateAchievement(definition, facts), persisted.get(definition.id)));
    const pendingMilestoneSuggestions = goal.milestones.reduce((sum, milestone) => sum + (suggestionCountByMilestone.get(milestone.id) ?? 0), 0);
    const overdueMilestones = goal.milestones.filter((milestone) => milestone.status === MilestoneStatus.PENDING && milestone.targetDate && milestone.targetDate < now).length;
    overviews.set(goal.id, {
      lifecycleStatus: facts.lifecycleStatus,
      investedMinutes: facts.investedMinutes,
      weekInvestedMinutes: facts.weekInvestedMinutes,
      weekPlannedMinutes: facts.weekPlannedMinutes,
      weekActiveDays: facts.weekActiveDateKeys.length,
      activeDays: facts.activeDateKeys.length,
      completedSessions: facts.completedSessions,
      actionHint: deriveGoalActionHint({ lifecycleStatus: facts.lifecycleStatus, pendingMilestoneSuggestions, overdueMilestones, weekPlannedMinutes: facts.weekPlannedMinutes, weekInvestedMinutes: facts.weekInvestedMinutes }),
      planningHints: derivePlanningHints({ outcomeCount: goal.outcomes.length, milestoneCount: goal.milestones.length, category: goal.category, targetDate: goal.targetDate, hasExecution: facts.completedSessions > 0 }),
      recentAchievement: achievements.filter((achievement) => achievement.state === "unlocked").sort((a, b) => (b.unlockedAt ?? "").localeCompare(a.unlockedAt ?? ""))[0] ?? null,
      achievements,
    });
  }

  return overviews;
}

export async function evaluateGoalAchievements(goalIds?: string[]): Promise<{ evaluatedGoals: number; unlocked: number; restored: number }> {
  const db = getDb();
  const goals = await db.goal.findMany({ where: { archivedAt: null, ...(goalIds?.length ? { id: { in: goalIds } } : {}) }, include: goalExecutionInclude });
  if (!goals.length) return { evaluatedGoals: 0, unlocked: 0, restored: 0 };
  const userIds = [...new Set(goals.map((goal) => goal.userId))];
  const users = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, timezone: true } });
  const timezoneByUser = new Map(users.map((user) => [user.id, user.timezone]));
  const blocks = await db.scheduleBlock.findMany({ where: { userId: { in: userIds } }, select: scheduleProjectionSelect });
  const existing = await db.goalAchievement.findMany({ where: { goalId: { in: goals.map((goal) => goal.id) } } });
  const existingByKey = new Map(existing.map((achievement) => [`${achievement.goalId}:${achievement.achievementId}`, achievement]));
  let unlocked = 0;
  let restored = 0;

  for (const goal of goals) {
    // Keep every block for this user in the projection. A reschedule successor may
    // lose its original goal/task link, but it must still supersede the predecessor.
    const facts = projectGoalExecutionFacts(goal, blocks.filter((block) => block.userId === goal.userId), timezoneByUser.get(goal.userId) ?? "Asia/Shanghai");
    const modules = resolveAchievementModules({ category: goal.category, project: goal.project, skill: goal.skill, hasRoutine: goal.routines.length > 0 });
    for (const definition of definitionsForModules(modules)) {
      const evaluation = evaluateAchievement(definition, facts);
      if (!evaluation.met) continue;
      const evidence = achievementEvidence(evaluation);
      const existingAchievement = existingByKey.get(`${goal.id}:${definition.id}`);
      if (!existingAchievement) {
        const achievement = await db.goalAchievement.create({
          data: {
            goalId: goal.id,
            achievementId: definition.id,
            definitionVersion: definition.version,
            unlockedAt: achievementOccurredAt(evaluation),
            evidence,
            events: { create: { type: AchievementEventType.UNLOCKED, evidence, idempotencyKey: `${goal.id}:${definition.id}:unlocked:v${definition.version}` } },
          },
        });
        existingByKey.set(`${goal.id}:${definition.id}`, achievement);
        unlocked += 1;
      } else if (existingAchievement.revokedAt) {
        const fingerprint = digest(evidence);
        await db.$transaction([
          db.goalAchievement.update({ where: { id: existingAchievement.id }, data: { definitionVersion: definition.version, unlockedAt: achievementOccurredAt(evaluation), evidence, revokedAt: null, revokeReason: null } }),
          db.goalAchievementEvent.upsert({ where: { idempotencyKey: `${goal.id}:${definition.id}:restored:${fingerprint}` }, update: {}, create: { goalAchievementId: existingAchievement.id, type: AchievementEventType.RESTORED, evidence, idempotencyKey: `${goal.id}:${definition.id}:restored:${fingerprint}` } }),
        ]);
        restored += 1;
      }
    }
  }

  return { evaluatedGoals: goals.length, unlocked, restored };
}

export async function evaluateGoalAchievementsBestEffort(goalIds: string[]): Promise<void> {
  try {
    await evaluateGoalAchievements(goalIds);
  } catch (error) {
    console.error("[goal-achievements] evaluation failed", error);
  }
}

/** Explicit correction path. Ordinary edits and threshold regressions never revoke. */
export async function revokeGoalAchievementForCorrection(userId: string, achievementId: string, raw: unknown) {
  const input = achievementCorrectionSchema.parse(raw);
  const db = getDb();
  const achievement = await db.goalAchievement.findFirst({ where: { id: achievementId, goal: { userId } } });
  if (!achievement) throw new DomainError("ACHIEVEMENT_NOT_FOUND", "没有找到这条成就记录。", 404);
  if (achievement.revokedAt) return achievement;
  const occurredAt = new Date();
  const idempotencyKey = `${achievement.id}:revoked:${digest({ unlockedAt: achievement.unlockedAt, evidence: achievement.evidence, reason: input.reason })}`;
  const [, event] = await db.$transaction([
    db.goalAchievement.update({ where: { id: achievement.id }, data: { revokedAt: occurredAt, revokeReason: input.reason } }),
    db.goalAchievementEvent.upsert({ where: { idempotencyKey }, update: {}, create: { goalAchievementId: achievement.id, type: AchievementEventType.REVOKED, occurredAt, evidence: achievement.evidence as Prisma.InputJsonValue, reason: input.reason, idempotencyKey } }),
  ]);
  return { id: achievement.id, revokedAt: occurredAt.toISOString(), revokeReason: input.reason, eventId: event.id };
}

function achievementView(evaluation: AchievementEvaluation, persisted?: PersistedAchievement): AchievementView {
  const achievementModule = evaluation.definition.applicableModules[0]!;
  if (persisted?.revokedAt) return { ...viewBase(evaluation, achievementModule), recordId: persisted.id, state: "revoked", unlockedAt: persisted.unlockedAt.toISOString(), evidenceSummary: "曾解锁，已因数据更正撤销" };
  if (persisted) return { ...viewBase(evaluation, achievementModule), recordId: persisted.id, state: "unlocked", unlockedAt: persisted.unlockedAt.toISOString(), evidenceSummary: summarizeAchievementEvidence(evaluation) };
  return { ...viewBase(evaluation, achievementModule), state: evaluation.current > 0 ? "in_progress" : "locked", evidenceSummary: summarizeAchievementEvidence(evaluation) };
}

function viewBase(evaluation: AchievementEvaluation, achievementModule: AchievementView["module"]): Omit<AchievementView, "state"> {
  return { id: evaluation.definition.id, title: evaluation.definition.title, description: evaluation.definition.description, conditionLabel: evaluation.definition.conditionLabel, module: achievementModule, tier: evaluation.definition.tier, icon: evaluation.definition.icon, current: evaluation.current, target: evaluation.target };
}

function summarizeAchievementEvidence(evaluation: AchievementEvaluation): string {
  if (evaluation.definition.evaluator === "invested_minutes" || evaluation.definition.evaluator === "longest_session") return `${evaluation.current} / ${evaluation.target} 分钟`;
  if (evaluation.definition.evaluator === "active_days") return `${evaluation.current} / ${evaluation.target} 个有效执行日`;
  if (evaluation.definition.evaluator === "routine_active_weeks") return `${evaluation.current} / ${evaluation.target} 个自然周`;
  return `${evaluation.current} / ${evaluation.target}`;
}

function achievementEvidence(evaluation: AchievementEvaluation): Prisma.InputJsonObject {
  const refs = evaluation.evidenceRefs.slice(-20).map((ref) => ({ ...ref }));
  return { definitionVersion: evaluation.definition.version, current: evaluation.current, target: evaluation.target, totalEvidenceRefs: evaluation.evidenceRefs.length, sourceRefs: refs };
}

function achievementOccurredAt(evaluation: AchievementEvaluation): Date {
  const refs = [...evaluation.evidenceRefs].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  if (!refs.length) return new Date();
  if (evaluation.definition.evaluator === "invested_minutes") {
    let total = 0;
    for (const ref of refs) { total += ref.minutes ?? 0; if (total >= evaluation.target) return new Date(ref.occurredAt); }
  }
  if (evaluation.definition.evaluator === "active_days") {
    const dates = new Map<string, GoalEvidenceRef>();
    for (const ref of refs) dates.set(ref.dateKey ?? ref.occurredAt.slice(0, 10), ref);
    return new Date([...dates.values()][evaluation.target - 1]?.occurredAt ?? refs.at(-1)!.occurredAt);
  }
  if (evaluation.definition.evaluator === "longest_session") return new Date(refs.find((ref) => (ref.minutes ?? 0) >= evaluation.target)?.occurredAt ?? refs.at(-1)!.occurredAt);
  return new Date(refs[Math.min(evaluation.target - 1, refs.length - 1)]!.occurredAt);
}

function mondayDateKey(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  const weekday = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - ((weekday + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00.000Z`).getTime() - new Date(`${a}T00:00:00.000Z`).getTime()) / 86_400_000);
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const row of rows) result.set(key(row), [...(result.get(key(row)) ?? []), row]);
  return result;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
