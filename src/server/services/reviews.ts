import { ReviewStatus, ReviewType } from "@/generated/prisma/enums";
import { getDb } from "@/lib/db";
import { DomainError } from "@/server/api-response";
import { ensureLocalUser } from "@/server/auth";
import { reviewResultSchema, rhythmSignalExtractionSchema } from "@/domain/schemas";
import type { ReviewResult } from "@/domain/schemas";

/**
 * 列出用户最近的回顾记录。
 * @param userId - 用户 ID
 * @param limit - 最多返回条数（上限 50）
 */
export async function listReviews(userId: string, limit = 12) {
  await ensureLocalUser();
  const reviews = await getDb().review.findMany({ where: { userId }, orderBy: { periodEnd: "desc" }, take: Math.min(limit, 50) });
  return reviews.map(serializeReview);
}

/**
 * 生成日或周回顾。优先使用 AI 生成结构化摘要、发现和建议，并同步提取节奏信号；
 * AI 调用失败时回退到规则引擎，并在 metrics.source 中标明来源。
 * @param userId - 用户 ID
 * @param type - 回顾类型（daily / weekly）
 * @param periodStart - 回顾周期起始时间（UTC）
 * @param periodEnd - 回顾周期结束时间（UTC）
 */
export async function generateReview(userId: string, type: "daily" | "weekly", periodStart: Date, periodEnd: Date) {
  await ensureLocalUser();
  const idempotencyKey = `${userId}:${type}:${periodStart.toISOString()}:${periodEnd.toISOString()}`;
  await getDb().review.upsert({ where: { idempotencyKey }, create: { userId, type: type === "daily" ? ReviewType.DAILY : ReviewType.WEEKLY, periodStart, periodEnd, status: ReviewStatus.GENERATING, idempotencyKey }, update: { status: ReviewStatus.GENERATING } });

  try {
    const blocks = await getDb().scheduleBlock.findMany({
      where: { userId, deletedAt: null, startsAt: { gte: periodStart, lt: periodEnd } },
      include: { executionRecord: { include: { rhythmFeedback: true } }, routine: true, task: true }, orderBy: { startsAt: "asc" },
    });

    const completed = blocks.filter((block) => block.status === "COMPLETED");
    const missed = blocks.filter((block) => block.status === "MISSED" || block.status === "RESCHEDULED");
    const investedMinutes = completed.reduce((sum, block) => sum + (block.executionRecord?.actualMinutes ?? Math.max(0, Math.round((block.endsAt.getTime() - block.startsAt.getTime()) / 60000))), 0);
    const feedbackTags = blocks.flatMap((block) => block.executionRecord?.rhythmFeedback?.tags ?? []);
    const smoothCount = feedbackTags.filter((tag) => tag === "smooth").length;
    const resistanceCount = feedbackTags.filter((tag) => tag === "resistant" || tag === "interrupted" || tag === "barely_completed").length;
    const metrics = { total: blocks.length, completed: completed.length, missed: missed.length, investedMinutes, routinesCompleted: completed.filter((block) => block.routineId).length };

    // 尝试 AI 生成，失败时回退到规则
    const aiResult = await tryAIReview(blocks, metrics, smoothCount, resistanceCount, type, periodStart, periodEnd);
    const content: ReviewResult = aiResult ?? buildRulesReview(metrics, smoothCount, resistanceCount, missed.length);

    const review = await getDb().review.upsert({
      where: { idempotencyKey },
      create: { userId, type: type === "daily" ? ReviewType.DAILY : ReviewType.WEEKLY, periodStart, periodEnd, status: ReviewStatus.AWAITING_CONFIRMATION, summary: content.summary, metrics: { ...metrics, source: content.source }, findings: content.findings, suggestions: content.suggestions, idempotencyKey },
      update: { status: ReviewStatus.AWAITING_CONFIRMATION, summary: content.summary, metrics: { ...metrics, source: content.source }, findings: content.findings, suggestions: content.suggestions },
    });

    // 提取节奏信号（AI 优先，降级为规则）
    const signals = aiResult
      ? await tryAIRhythmSignals(blocks, metrics, smoothCount, resistanceCount, review.id, periodStart, periodEnd)
        ?? buildRulesSignals(smoothCount, resistanceCount, metrics, review.id, periodStart, periodEnd)
      : buildRulesSignals(smoothCount, resistanceCount, metrics, review.id, periodStart, periodEnd);

    for (const signal of signals) {
      const existing = await getDb().rhythmSignal.findFirst({ where: { userId, type: signal.type, validUntil: null }, orderBy: { updatedAt: "desc" } });
      if (existing) await getDb().rhythmSignal.update({ where: { id: existing.id }, data: { statement: signal.statement, confidence: signal.confidence, evidence: signal.evidence, validFrom: new Date() } });
      else await getDb().rhythmSignal.create({ data: { userId, type: signal.type, statement: signal.statement, confidence: signal.confidence, evidence: signal.evidence } });
    }

    return serializeReview(review);
  } catch (error) {
    await getDb().review.update({ where: { idempotencyKey }, data: { status: ReviewStatus.FAILED, summary: error instanceof Error ? error.message.slice(0, 500) : "回顾生成失败" } });
    throw error;
  }
}

/**
 * 确认或驳回一份回顾。
 * @param userId - 用户 ID
 * @param id - 回顾 ID
 * @param confirmed - true=确认，false=退回草稿
 */
export async function confirmReview(userId: string, id: string, confirmed: boolean) {
  const result = await getDb().review.updateMany({ where: { id, userId }, data: { status: confirmed ? ReviewStatus.CONFIRMED : ReviewStatus.DRAFT, confirmedAt: confirmed ? new Date() : null } });
  if (!result.count) throw new DomainError("REVIEW_NOT_FOUND", "没有找到这份回顾。", 404);
  const review = await getDb().review.findUnique({ where: { id } });
  if (!review) throw new DomainError("REVIEW_NOT_FOUND", "没有找到这份回顾。", 404);
  return serializeReview(review);
}

// ── AI 路径 ────────────────────────────────────────────────────────────────────

/**
 * 尝试调用 AI 模型生成结构化回顾内容。
 * 失败时返回 null，由调用方降级到规则引擎。
 */
async function tryAIReview(
  blocks: Array<{
    status: string; title: string; startsAt: Date; endsAt: Date;
    executionRecord: { actualMinutes: number | null; result: string; deviationReason: string | null; obstacle: string | null; rhythmFeedback: { tags: string[]; note: string | null; comfortable: boolean | null; timeFit: string | null } | null } | null;
    task: { title: string } | null;
    routine: { title: string } | null;
  }>,
  metrics: { total: number; completed: number; missed: number; investedMinutes: number },
  smoothCount: number, resistanceCount: number,
  type: "daily" | "weekly", periodStart: Date, periodEnd: Date,
): Promise<ReviewResult | null> {
  try {
    const { resolveCapabilityProvider } = await import("@/agent/provider-config");
    const { OpenAICompatibleAdapter } = await import("@/agent/openai-compatible-adapter");
    const { provider, model } = resolveCapabilityProvider("review");
    const adapter = new OpenAICompatibleAdapter(provider);

    const blockSummary = blocks.slice(0, 30).map((b) => ({
      title: b.task?.title ?? b.routine?.title ?? b.title,
      status: b.status,
      tags: b.executionRecord?.rhythmFeedback?.tags ?? [],
      deviationReason: b.executionRecord?.deviationReason ?? undefined,
      obstacle: b.executionRecord?.obstacle ?? undefined,
    }));

    const prompt = `这是一份${type === "weekly" ? "周" : "日"}回顾请求。
回顾周期：${periodStart.toISOString()} 到 ${periodEnd.toISOString()}
总日程：${metrics.total} 个，完成：${metrics.completed}，未完成/改期：${metrics.missed}，投入：${metrics.investedMinutes} 分钟
顺畅反馈：${smoothCount} 次，阻力反馈：${resistanceCount} 次

执行详情（最多30条）：
${JSON.stringify(blockSummary, null, 2)}

请基于以上真实数据生成结构化回顾：
- summary：1-3句概述本周期执行情况和整体节奏
- findings：从数据中提取的客观发现（而非评判），3-6条
- suggestions：基于发现的可操作建议，2-4条
- source：固定填 "ai"`;

    return await adapter.generateObject({
      model,
      system: "你是 Rhythm & Routine 的节奏分析助手。基于真实执行数据生成客观、支持性的回顾内容，区分事实与判断。",
      prompt,
      schema: reviewResultSchema,
      maxOutputTokens: 1200,
    });
  } catch {
    return null;
  }
}

/**
 * 尝试调用 AI 模型提取节奏信号。失败时返回 null，由调用方降级到规则。
 */
async function tryAIRhythmSignals(
  blocks: Array<{ status: string; executionRecord: { rhythmFeedback: { tags: string[]; comfortable: boolean | null; timeFit: string | null } | null } | null }>,
  metrics: { total: number; completed: number; investedMinutes: number },
  smoothCount: number, resistanceCount: number,
  reviewId: string, periodStart: Date, periodEnd: Date,
) {
  try {
    const { resolveCapabilityProvider } = await import("@/agent/provider-config");
    const { OpenAICompatibleAdapter } = await import("@/agent/openai-compatible-adapter");
    const { provider, model } = resolveCapabilityProvider("review");
    const adapter = new OpenAICompatibleAdapter(provider);

    const prompt = `基于以下执行数据，提取有价值的节奏信号（每条需有数据支撑）：
完成率：${metrics.total > 0 ? Math.round((metrics.completed / metrics.total) * 100) : 0}%，投入：${metrics.investedMinutes} 分钟
顺畅次数：${smoothCount}，阻力次数：${resistanceCount}
反馈数据：${JSON.stringify(blocks.slice(0, 20).map((b) => ({ tags: b.executionRecord?.rhythmFeedback?.tags ?? [], comfortable: b.executionRecord?.rhythmFeedback?.comfortable, timeFit: b.executionRecord?.rhythmFeedback?.timeFit })))}

请输出 signals 数组，每条包含：type（信号类型，snake_case）、statement（陈述）、confidence（0-1）、evidenceSummary（证据摘要）。
数据不足时返回空数组，不要捏造信号。`;

    const result = await adapter.generateObject({
      model,
      system: "你是节奏信号提取器，只基于真实数据提取有证据支撑的执行模式，不做推断或建议。",
      prompt,
      schema: rhythmSignalExtractionSchema,
      maxOutputTokens: 800,
    });

    return result.signals.map((s) => ({
      type: s.type,
      statement: s.statement,
      confidence: s.confidence,
      evidence: { reviewId, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(), evidenceSummary: s.evidenceSummary, metrics },
    }));
  } catch {
    return null;
  }
}

// ── 规则引擎降级 ────────────────────────────────────────────────────────────────

/**
 * 规则引擎降级路径，生成基础结构化回顾内容，并标记 source = "rules"。
 */
function buildRulesReview(metrics: { completed: number; total: number; investedMinutes: number }, smoothCount: number, resistanceCount: number, missedCount: number): ReviewResult {
  const findings = [
    ...(smoothCount ? [`记录到 ${smoothCount} 次顺畅执行，可以继续观察它们的时间与任务类型。`] : []),
    ...(resistanceCount ? [`记录到 ${resistanceCount} 次阻力信号，适合检查任务粒度和时间匹配。`] : []),
    ...(!smoothCount && !resistanceCount ? ["节奏反馈还不够多，下一周期优先保持轻量记录。"] : []),
  ];
  const suggestions = [
    ...(missedCount ? ["逐个处理未完成日程：改期、拆小或明确放弃。"] : ["保留本周期执行顺畅的安排方式。"]),
    ...(resistanceCount > smoothCount ? ["下个周期减少同时推进的高专注任务。"] : []),
  ];
  return {
    summary: `本周期完成 ${metrics.completed}/${metrics.total} 个日程块，真实投入约 ${Math.floor(metrics.investedMinutes / 60)} 小时 ${metrics.investedMinutes % 60} 分钟。`,
    findings: findings.length ? findings : ["数据量较少，建议继续积累执行反馈。"],
    suggestions: suggestions.length ? suggestions : ["维持当前节奏，继续记录反馈。"],
    source: "rules",
  };
}

/**
 * 规则引擎降级路径，基于统计数据生成固定类型的节奏信号。
 */
function buildRulesSignals(smoothCount: number, resistanceCount: number, metrics: { total: number; completed: number }, reviewId: string, periodStart: Date, periodEnd: Date) {
  const evidence = { reviewId, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(), metrics };
  return [
    ...(smoothCount >= 2 ? [{ type: "smooth_pattern", statement: `本周期记录到 ${smoothCount} 次顺畅执行，当前安排中存在值得保护的顺畅窗口。`, confidence: Math.min(0.9, 0.45 + smoothCount * 0.08), evidence }] : []),
    ...(resistanceCount >= 2 ? [{ type: "resistance_pattern", statement: `本周期记录到 ${resistanceCount} 次阻力信号，任务粒度或时间匹配需要调整。`, confidence: Math.min(0.9, 0.45 + resistanceCount * 0.08), evidence }] : []),
    ...(metrics.total >= 3 ? [{ type: "completion_pattern", statement: `本周期日程完成率为 ${Math.round((metrics.completed / metrics.total) * 100)}%。`, confidence: 0.75, evidence }] : []),
  ];
}

function serializeReview<T extends { type: string; status: string; periodStart: Date; periodEnd: Date; confirmedAt: Date | null; createdAt: Date; updatedAt: Date }>(review: T) { return { ...review, type: review.type.toLowerCase(), status: review.status.toLowerCase(), periodStart: review.periodStart.toISOString(), periodEnd: review.periodEnd.toISOString(), confirmedAt: review.confirmedAt?.toISOString() ?? null, createdAt: review.createdAt.toISOString(), updatedAt: review.updatedAt.toISOString() }; }
