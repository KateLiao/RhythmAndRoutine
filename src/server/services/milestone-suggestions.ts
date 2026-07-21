import { createHash } from "node:crypto";
import { MilestoneStatus, MilestoneSuggestionStatus } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { evaluateMilestoneCriteria, type MilestoneCriteria } from "@/domain/milestone-suggestions";
import { getDb } from "@/lib/db";
import { DomainError } from "@/server/api-response";
import { evaluateGoalAchievementsBestEffort, goalExecutionInclude, projectGoalExecutionFacts, scheduleProjectionSelect } from "@/server/services/goal-execution";
import { milestoneCriteriaSchema, milestoneSuggestionDecisionSchema } from "@/server/validation";

const SNOOZE_DAYS = 7;
const DISMISS_COOLDOWN_DAYS = 14;

export async function evaluateMilestoneSuggestions(goalIds?: string[], now = new Date()): Promise<{ evaluated: number; created: number; reopened: number; superseded: number }> {
  const db = getDb();
  const goals = await db.goal.findMany({
    where: { archivedAt: null, ...(goalIds?.length ? { id: { in: goalIds } } : {}) },
    include: goalExecutionInclude,
  });
  if (!goals.length) return { evaluated: 0, created: 0, reopened: 0, superseded: 0 };

  const userIds = [...new Set(goals.map((goal) => goal.userId))];
  const [users, blocks, existingSuggestions] = await Promise.all([
    db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, timezone: true } }),
    db.scheduleBlock.findMany({ where: { userId: { in: userIds } }, select: scheduleProjectionSelect }),
    db.milestoneReviewSuggestion.findMany({ where: { milestoneId: { in: goals.flatMap((goal) => goal.milestones.map((milestone) => milestone.id)) } }, orderBy: { suggestedAt: "desc" } }),
  ]);
  const timezoneByUser = new Map(users.map((user) => [user.id, user.timezone]));
  const suggestionsByMilestone = groupBy(existingSuggestions, (suggestion) => suggestion.milestoneId);
  let evaluated = 0;
  let created = 0;
  let reopened = 0;
  let superseded = 0;

  for (const goal of goals) {
    const facts = projectGoalExecutionFacts(goal, blocks.filter((block) => block.userId === goal.userId), timezoneByUser.get(goal.userId) ?? "Asia/Shanghai", now);
    for (const milestone of goal.milestones) {
      if (milestone.status !== MilestoneStatus.PENDING && milestone.status !== MilestoneStatus.READY_FOR_REVIEW) continue;
      const parsed = milestoneCriteriaSchema.safeParse(milestone.completionCriteria);
      if (!parsed.success) continue;
      const result = evaluateMilestoneCriteria(parsed.data as MilestoneCriteria, facts);
      if (!result) continue;
      evaluated += 1;
      if (!result.met) continue;

      const milestoneVersion = milestone.version ?? 1;
      const evidence = buildEvidence(milestoneVersion, parsed.data as MilestoneCriteria, result);
      const fingerprint = hashStable(evidence);
      const existing = (suggestionsByMilestone.get(milestone.id) ?? []).find((suggestion) => suggestion.evidenceFingerprint === fingerprint);
      if (existing) {
        if (existing.status === MilestoneSuggestionStatus.SNOOZED && (!existing.snoozedUntil || existing.snoozedUntil <= now)
          || existing.status === MilestoneSuggestionStatus.DISMISSED && existing.snoozedUntil && existing.snoozedUntil <= now) {
          const reopenedSuggestion = await db.milestoneReviewSuggestion.update({
            where: { id: existing.id },
            data: { status: MilestoneSuggestionStatus.PENDING, suggestedAt: now, snoozedUntil: null, decidedAt: null },
          });
          suggestionsByMilestone.set(milestone.id, [reopenedSuggestion, ...(suggestionsByMilestone.get(milestone.id) ?? []).filter((item) => item.id !== existing.id)]);
          reopened += 1;
        }
        continue;
      }

      const stale = (suggestionsByMilestone.get(milestone.id) ?? []).filter((suggestion) => suggestion.status === MilestoneSuggestionStatus.PENDING || suggestion.status === MilestoneSuggestionStatus.SNOOZED);
      if (stale.length) {
        const update = await db.milestoneReviewSuggestion.updateMany({
          where: { id: { in: stale.map((suggestion) => suggestion.id) } },
          data: { status: MilestoneSuggestionStatus.SUPERSEDED, decidedAt: now, decisionReason: "有更新的完成证据" },
        });
        superseded += update.count;
      }
      const suggestion = await db.milestoneReviewSuggestion.create({
        data: {
          milestoneId: milestone.id,
          milestoneVersion,
          evidenceFingerprint: fingerprint,
          evidence,
          reason: buildReason(result.results),
          suggestedAt: now,
        },
      });
      suggestionsByMilestone.set(milestone.id, [suggestion, ...(suggestionsByMilestone.get(milestone.id) ?? [])]);
      created += 1;
    }
  }

  return { evaluated, created, reopened, superseded };
}

export async function evaluateMilestoneSuggestionsBestEffort(goalIds: string[]): Promise<void> {
  try {
    await evaluateMilestoneSuggestions(goalIds);
  } catch (error) {
    console.error("[milestone-suggestions] evaluation failed", error);
  }
}

export async function decideMilestoneSuggestion(userId: string, suggestionId: string, raw: unknown) {
  const input = milestoneSuggestionDecisionSchema.parse(raw);
  const db = getDb();
  const suggestion = await db.milestoneReviewSuggestion.findFirst({
    where: { id: suggestionId, milestone: { goal: { userId, archivedAt: null } } },
    include: { milestone: { select: { id: true, goalId: true, version: true, status: true } } },
  });
  if (!suggestion) throw new DomainError("MILESTONE_SUGGESTION_NOT_FOUND", "没有找到这条里程碑建议。", 404);

  const now = new Date();
  if (input.action === "confirm") {
    ensureActionableSuggestion(suggestion.status);
    await db.$transaction(async (tx) => {
      const updated = await tx.milestone.updateMany({
        where: { id: suggestion.milestone.id, version: suggestion.milestoneVersion, status: { in: [MilestoneStatus.PENDING, MilestoneStatus.READY_FOR_REVIEW] } },
        data: { status: MilestoneStatus.COMPLETED, completedAt: now, completedByUserId: userId, version: { increment: 1 } },
      });
      if (!updated.count) throw new DomainError("MILESTONE_SUGGESTION_STALE", "里程碑定义已经变化，请刷新后重新检查证据。", 409);
      await tx.milestoneReviewSuggestion.update({
        where: { id: suggestion.id },
        data: { status: MilestoneSuggestionStatus.ACCEPTED, decidedAt: now, decisionReason: input.reason ?? "用户确认阶段成果已达成", snoozedUntil: null },
      });
      await tx.milestoneReviewSuggestion.updateMany({
        where: { milestoneId: suggestion.milestone.id, id: { not: suggestion.id }, status: { in: [MilestoneSuggestionStatus.PENDING, MilestoneSuggestionStatus.SNOOZED] } },
        data: { status: MilestoneSuggestionStatus.SUPERSEDED, decidedAt: now, decisionReason: "里程碑已由用户确认完成" },
      });
    });
    await evaluateGoalAchievementsBestEffort([suggestion.milestone.goalId]);
  } else if (input.action === "snooze") {
    ensureActionableSuggestion(suggestion.status);
    await db.milestoneReviewSuggestion.update({
      where: { id: suggestion.id },
      data: { status: MilestoneSuggestionStatus.SNOOZED, snoozedUntil: addDays(now, SNOOZE_DAYS), decidedAt: now, decisionReason: input.reason ?? "稍后再判断" },
    });
  } else {
    ensureActionableSuggestion(suggestion.status);
    await db.milestoneReviewSuggestion.update({
      where: { id: suggestion.id },
      data: { status: MilestoneSuggestionStatus.DISMISSED, snoozedUntil: addDays(now, DISMISS_COOLDOWN_DAYS), decidedAt: now, decisionReason: input.reason ?? "当前证据不足以代表阶段完成" },
    });
  }

  const updated = await db.milestoneReviewSuggestion.findUniqueOrThrow({ where: { id: suggestion.id } });
  return serializeSuggestion(updated);
}

function ensureActionableSuggestion(status: MilestoneSuggestionStatus) {
  if (status !== MilestoneSuggestionStatus.PENDING && status !== MilestoneSuggestionStatus.SNOOZED) {
    throw new DomainError("MILESTONE_SUGGESTION_ALREADY_DECIDED", "这条建议已经处理。", 409);
  }
}

function buildEvidence(milestoneVersion: number, criteria: MilestoneCriteria, result: NonNullable<ReturnType<typeof evaluateMilestoneCriteria>>): Prisma.InputJsonObject {
  return {
    criteriaVersion: criteria.version,
    milestoneVersion,
    mode: result.mode,
    criteria: criteria.items.map((item) => ({ id: item.id, evaluator: item.evaluator, sourceIds: [...(item.sourceIds ?? [])].sort(), threshold: item.threshold ?? null })),
    results: result.results.map((entry) => ({ id: entry.id, evaluator: entry.evaluator, current: entry.current, target: entry.target, met: entry.met })),
    sourceRefs: result.evidenceRefs.map((ref) => ({ ...ref })),
  };
}

function buildReason(results: NonNullable<ReturnType<typeof evaluateMilestoneCriteria>>["results"]): string {
  return `以下公开完成标准已有证据：${results.filter((result) => result.met).map((result) => `${result.label}（${result.current}/${result.target}）`).join("；")}。请确认这是否足以代表阶段完成。`;
}

function serializeSuggestion<T extends { status: MilestoneSuggestionStatus; suggestedAt: Date; snoozedUntil: Date | null; decidedAt: Date | null; createdAt: Date; updatedAt: Date }>(suggestion: T) {
  return { ...suggestion, status: suggestion.status.toLowerCase(), suggestedAt: suggestion.suggestedAt.toISOString(), snoozedUntil: suggestion.snoozedUntil?.toISOString() ?? null, decidedAt: suggestion.decidedAt?.toISOString() ?? null, createdAt: suggestion.createdAt.toISOString(), updatedAt: suggestion.updatedAt.toISOString() };
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sortValue(entry)]));
  return value;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const row of rows) result.set(key(row), [...(result.get(key(row)) ?? []), row]);
  return result;
}
