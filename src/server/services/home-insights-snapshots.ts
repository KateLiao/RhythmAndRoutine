import { getDb } from "@/lib/db";
import type { MomentInsightGeneration, SlowInsightsGeneration } from "@/domain/schemas";
import { retentionLimitsForKind } from "@/server/services/home-insights-retention";
import type { InsightGenerationTrigger } from "@/server/services/home-insights-schedule";

export type InsightSnapshotKind = "moment" | "slow";

/**
 * 读取指定类型的最新首页洞察快照。
 * @param userId - 用户 ID
 * @param kind - moment 或 slow
 */
export async function getLatestInsightSnapshot(userId: string, kind: InsightSnapshotKind) {
  return getDb().homeInsightSnapshot.findFirst({
    where: { userId, kind },
    orderBy: { generatedAt: "desc" },
  });
}

/**
 * 追加写入首页洞察快照（不删除历史记录）。
 * @param userId - 用户 ID
 * @param kind - moment 或 slow
 * @param input - 快照字段
 */
export async function appendInsightSnapshot(userId: string, kind: InsightSnapshotKind, input: {
  factsHash: string;
  payload: unknown;
  proposedChange?: unknown;
  alternateCandidates?: unknown;
  source: "ai" | "rules";
  modelId?: string;
  trigger: InsightGenerationTrigger;
}) {
  return getDb().homeInsightSnapshot.create({
    data: {
      userId,
      kind,
      factsHash: input.factsHash,
      payload: input.payload as object,
      proposedChange: input.proposedChange as object | undefined,
      alternateCandidates: input.alternateCandidates as object | undefined,
      alternateIndex: 0,
      source: input.source,
      modelId: input.modelId,
      trigger: input.trigger,
    },
  });
}

/**
 * 保存 LLM/规则生成的此刻建议快照。
 * @param userId - 用户 ID
 * @param factsHash - momentFacts 哈希（审计用）
 * @param generation - 结构化生成结果
 * @param source - ai 或 rules
 * @param trigger - 生成触发来源
 * @param modelId - 可选模型 ID
 */
export async function saveMomentGenerationSnapshot(
  userId: string,
  factsHash: string,
  generation: MomentInsightGeneration,
  source: "ai" | "rules",
  trigger: InsightGenerationTrigger,
  modelId?: string,
) {
  return appendInsightSnapshot(userId, "moment", {
    factsHash,
    payload: generation.primary,
    proposedChange: generation.primary.proposedChange,
    alternateCandidates: generation.alternateCandidates,
    source,
    modelId,
    trigger,
  });
}

/**
 * 保存慢路径洞察快照（节奏发现 + 本周轨道）。
 * @param userId - 用户 ID
 * @param factsHash - slowFacts 哈希（审计用）
 * @param generation - 结构化生成结果
 * @param source - ai 或 rules
 * @param trigger - 生成触发来源
 * @param modelId - 可选模型 ID
 */
export async function saveSlowGenerationSnapshot(
  userId: string,
  factsHash: string,
  generation: SlowInsightsGeneration,
  source: "ai" | "rules",
  trigger: InsightGenerationTrigger,
  modelId?: string,
) {
  return appendInsightSnapshot(userId, "slow", {
    factsHash,
    payload: generation,
    source,
    modelId,
    trigger,
  });
}

/**
 * 按保留策略清理用户过旧的首页洞察快照。
 * @param userId - 用户 ID
 */
export async function cleanupOldInsightSnapshots(userId: string) {
  const db = getDb();
  for (const kind of ["moment", "slow"] as const) {
    const { retentionDays, maxCount } = retentionLimitsForKind(kind);
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    await db.homeInsightSnapshot.deleteMany({
      where: { userId, kind, generatedAt: { lt: cutoff } },
    });
    const rows = await db.homeInsightSnapshot.findMany({
      where: { userId, kind },
      orderBy: { generatedAt: "desc" },
      select: { id: true },
      skip: maxCount,
    });
    if (rows.length) {
      await db.homeInsightSnapshot.deleteMany({
        where: { id: { in: rows.map((row) => row.id) } },
      });
    }
  }
}

/**
 * 递增此刻建议的 alternateIndex 并写库。
 * @param userId - 用户 ID
 */
export async function bumpMomentAlternateIndex(userId: string) {
  const snapshot = await getLatestInsightSnapshot(userId, "moment");
  if (!snapshot) return null;
  return getDb().homeInsightSnapshot.update({
    where: { id: snapshot.id },
    data: { alternateIndex: snapshot.alternateIndex + 1 },
  });
}

/**
 * 记录用户对此刻建议的响应（接受/忽略等）。
 * @param userId - 用户 ID
 * @param response - 用户响应类型
 * @param applied - 是否已应用
 */
export async function recordMomentUserResponse(userId: string, response: string, applied = false) {
  const snapshot = await getLatestInsightSnapshot(userId, "moment");
  if (!snapshot) return null;
  return getDb().homeInsightSnapshot.update({
    where: { id: snapshot.id },
    data: { userResponse: response, ...(applied ? { appliedAt: new Date() } : {}) },
  });
}
