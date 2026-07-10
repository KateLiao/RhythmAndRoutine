import type { HomeInsightProposedChange, SlowInsightsGeneration } from "@/domain/schemas";
import { momentInsightCardSchema, slowInsightsGenerationSchema } from "@/domain/schemas";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { buildHomeInsightFacts } from "@/server/services/home-insights-facts";
import { generateMomentInsight, generateSlowInsight } from "@/server/services/home-insights-generate";
import type { InsightGenerationTrigger } from "@/server/services/home-insights-schedule";
import {
  cleanupOldInsightSnapshots,
  getLatestInsightSnapshot,
  saveMomentGenerationSnapshot,
  saveSlowGenerationSnapshot,
} from "@/server/services/home-insights-snapshots";

export type ApiMomentInsight = {
  kind: "action" | "empty" | "exhausted";
  headline: string;
  judgment: string;
  reason?: string;
  nextLabel?: string;
  proposedChange?: HomeInsightProposedChange;
  actionLabel?: string;
  alternateCount: number;
  alternateIndex: number;
  exhausted: boolean;
  source?: "ai" | "rules";
  generatedAt?: string;
  trigger?: string | null;
};

export type ApiHomeInsightsResponse = {
  moment: ApiMomentInsight;
  rhythm: {
    kind: "insight" | "empty";
    statement: string;
    evidence?: string;
    impact?: string;
    signalId?: string;
    source?: "ai" | "rules";
    generatedAt?: string;
    trigger?: string | null;
  };
  weekly: {
    kind: "track" | "empty";
    statusLabel: string;
    status: string;
    summary: string;
    suggestion?: string;
    plannedMinutes?: number;
    completedMinutes?: number;
    source?: "ai" | "rules";
    generatedAt?: string;
    trigger?: string | null;
  };
  meta: {
    regeneratedMoment: boolean;
    regeneratedSlow: boolean;
    momentGeneratedAt?: string;
    slowGeneratedAt?: string;
  };
};

const momentPayloadSchema = momentInsightCardSchema;
const slowPayloadSchema = slowInsightsGenerationSchema;

/**
 * 从快照与 alternateIndex 解析当前应展示的此刻建议卡。
 * @param snapshot - moment 快照
 */
function resolveMomentFromSnapshot(snapshot: NonNullable<Awaited<ReturnType<typeof getLatestInsightSnapshot>>>) {
  const primary = momentPayloadSchema.parse(snapshot.payload);
  const alternates = Array.isArray(snapshot.alternateCandidates)
    ? (snapshot.alternateCandidates as unknown[]).map((item) => momentPayloadSchema.parse(item))
    : [];
  const totalSlots = 1 + alternates.length;
  const index = snapshot.alternateIndex;
  const generatedAt = snapshot.generatedAt.toISOString();
  if (index >= totalSlots) {
    return {
      kind: "exhausted" as const,
      headline: "本轮建议已经看完",
      judgment: "先按当前安排推进，完成或记录一次执行后，系统会结合新数据生成下一批建议。",
      alternateCount: alternates.length,
      alternateIndex: index,
      exhausted: true,
      source: snapshot.source as "ai" | "rules",
      generatedAt,
      trigger: snapshot.trigger,
    };
  }
  const active: z.infer<typeof momentInsightCardSchema> = index === 0 ? primary : alternates[index - 1];
  return {
    kind: "action" as const,
    headline: active.headline,
    judgment: active.judgment,
    reason: active.reason,
    nextLabel: active.nextLabel,
    proposedChange: active.proposedChange,
    actionLabel: active.proposedChange.label,
    alternateCount: alternates.length,
    alternateIndex: index,
    exhausted: false,
    source: snapshot.source as "ai" | "rules",
    generatedAt,
    trigger: snapshot.trigger,
  };
}

/**
 * 构建数据不足时的此刻建议空状态。
 */
function emptyMomentCard(): ApiMomentInsight {
  return {
    kind: "empty",
    headline: "先从一个小时间块开始",
    judgment: "你今天还没有足够的执行记录。",
    reason: "可以先安排一个 30 分钟的小任务，让系统开始了解你的节奏。",
    alternateCount: 0,
    alternateIndex: 0,
    exhausted: false,
  };
}

/**
 * 将 API 响应组装为统一结构。
 * @param facts - 事实包
 * @param momentSnapshot - moment 快照
 * @param slowSnapshot - slow 快照
 * @param regenerated - 本次是否新生成
 */
function buildResponse(
  facts: Awaited<ReturnType<typeof buildHomeInsightFacts>>,
  momentSnapshot: Awaited<ReturnType<typeof getLatestInsightSnapshot>>,
  slowSnapshot: Awaited<ReturnType<typeof getLatestInsightSnapshot>>,
  regenerated: { moment: boolean; slow: boolean },
): ApiHomeInsightsResponse {
  const moment = momentSnapshot ? resolveMomentFromSnapshot(momentSnapshot) : emptyMomentCard();
  const slowPayload = slowSnapshot ? slowPayloadSchema.parse(slowSnapshot.payload) as SlowInsightsGeneration : null;
  const slowGeneratedAt = slowSnapshot?.generatedAt.toISOString();

  return {
    moment,
    rhythm: slowPayload ? {
      kind: "insight",
      statement: slowPayload.rhythm.statement,
      evidence: slowPayload.rhythm.evidence,
      impact: slowPayload.rhythm.impact,
      signalId: slowPayload.rhythm.relatedSignalId,
      source: slowSnapshot?.source as "ai" | "rules",
      generatedAt: slowGeneratedAt,
      trigger: slowSnapshot?.trigger,
    } : {
      kind: "empty",
      statement: "完成几次执行反馈后，这里会出现你的节奏规律。",
      evidence: "例如：你更适合在哪些时间段做深度任务，哪些 Routine 容易被跳过。",
    },
    weekly: slowPayload ? {
      kind: "track",
      statusLabel: slowPayload.weekly.statusLabel,
      status: slowPayload.weekly.status,
      summary: slowPayload.weekly.summary,
      suggestion: slowPayload.weekly.suggestion,
      plannedMinutes: facts.slowFacts.weekMetrics.plannedMinutes,
      completedMinutes: facts.slowFacts.weekMetrics.completedMinutes,
      source: slowSnapshot?.source as "ai" | "rules",
      generatedAt: slowGeneratedAt,
      trigger: slowSnapshot?.trigger,
    } : {
      kind: "empty",
      statusLabel: "—",
      status: "balanced",
      summary: "还没有足够的本周数据。",
      suggestion: "安排并完成几个日程块后，这里会显示你的本周负荷、目标投入和执行偏差。",
    },
    meta: {
      regeneratedMoment: regenerated.moment,
      regeneratedSlow: regenerated.slow,
      momentGeneratedAt: momentSnapshot?.generatedAt.toISOString(),
      slowGeneratedAt,
    },
  };
}

/**
 * 生成并落库 moment 快照；AI 失败降级为 rules 时不覆盖已有 AI 快照。
 * @param userId - 用户 ID
 * @param trigger - 触发来源
 */
export async function regenerateMomentInsight(userId: string, trigger: InsightGenerationTrigger) {
  const user = await getDb().user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const timezone = user?.timezone ?? "Asia/Shanghai";
  const facts = await buildHomeInsightFacts(userId, timezone);
  const existing = await getLatestInsightSnapshot(userId, "moment");
  const result = await generateMomentInsight(facts);
  if (!result) {
    return { snapshot: existing, regenerated: false };
  }
  if (result.source === "rules" && existing?.source === "ai") {
    return { snapshot: existing, regenerated: false };
  }
  const saved = await saveMomentGenerationSnapshot(
    userId,
    facts.momentFactsHash,
    result.generation,
    result.source,
    trigger,
  );
  await cleanupOldInsightSnapshots(userId);
  return { snapshot: saved, regenerated: true };
}

/**
 * 生成并落库 slow 快照；AI 失败降级为 rules 时不覆盖已有 AI 快照。
 * @param userId - 用户 ID
 * @param trigger - 触发来源
 */
export async function regenerateSlowInsight(userId: string, trigger: InsightGenerationTrigger) {
  const user = await getDb().user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const timezone = user?.timezone ?? "Asia/Shanghai";
  const facts = await buildHomeInsightFacts(userId, timezone);
  const existing = await getLatestInsightSnapshot(userId, "slow");
  const result = await generateSlowInsight(facts);
  if (result.source === "rules" && existing?.source === "ai") {
    return { snapshot: existing, regenerated: false };
  }
  const saved = await saveSlowGenerationSnapshot(
    userId,
    facts.slowFactsHash,
    result.generation,
    result.source,
    trigger,
  );
  await cleanupOldInsightSnapshots(userId);
  return { snapshot: saved, regenerated: true };
}

/**
 * 获取首页三张洞察卡片：只读最新快照；缺失时冷启动生成一次。
 * @param userId - 用户 ID
 */
export async function getHomeInsights(userId: string): Promise<ApiHomeInsightsResponse> {
  const user = await getDb().user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const timezone = user?.timezone ?? "Asia/Shanghai";
  const facts = await buildHomeInsightFacts(userId, timezone);

  let momentSnapshot = await getLatestInsightSnapshot(userId, "moment");
  let slowSnapshot = await getLatestInsightSnapshot(userId, "slow");
  const regenerated = { moment: false, slow: false };

  if (!momentSnapshot) {
    const result = await regenerateMomentInsight(userId, "cold_start");
    momentSnapshot = result.snapshot;
    regenerated.moment = result.regenerated;
  }
  if (!slowSnapshot) {
    const result = await regenerateSlowInsight(userId, "cold_start");
    slowSnapshot = result.snapshot;
    regenerated.slow = result.regenerated;
  }

  return buildResponse(facts, momentSnapshot, slowSnapshot, regenerated);
}

/**
 * 手动或定时触发指定 kind 的洞察重生成。
 * @param userId - 用户 ID
 * @param target - moment 或 slow
 * @param trigger - scheduled 或 manual
 */
export async function regenerateHomeInsightTarget(
  userId: string,
  target: "moment" | "slow",
  trigger: InsightGenerationTrigger,
) {
  const user = await getDb().user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const timezone = user?.timezone ?? "Asia/Shanghai";
  const facts = await buildHomeInsightFacts(userId, timezone);

  let momentSnapshot = await getLatestInsightSnapshot(userId, "moment");
  let slowSnapshot = await getLatestInsightSnapshot(userId, "slow");
  const regenerated = { moment: false, slow: false };

  if (target === "moment") {
    const result = await regenerateMomentInsight(userId, trigger);
    momentSnapshot = result.snapshot;
    regenerated.moment = result.regenerated;
  } else {
    const result = await regenerateSlowInsight(userId, trigger);
    slowSnapshot = result.snapshot;
    regenerated.slow = result.regenerated;
  }

  if (!momentSnapshot) {
    const result = await regenerateMomentInsight(userId, "cold_start");
    momentSnapshot = result.snapshot;
    regenerated.moment = result.regenerated;
  }
  if (!slowSnapshot) {
    const result = await regenerateSlowInsight(userId, "cold_start");
    slowSnapshot = result.snapshot;
    regenerated.slow = result.regenerated;
  }

  return buildResponse(facts, momentSnapshot, slowSnapshot, regenerated);
}
