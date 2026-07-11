import { ReviewStatus, ReviewType } from "@/generated/prisma/enums";
import type { ScheduleBlockStatus } from "@/generated/prisma/enums";
import { getDb } from "@/lib/db";
import { DomainError } from "@/server/api-response";
import { ensureLocalUser } from "@/server/auth";
import { reviewResultSchema, rhythmSignalExtractionSchema } from "@/domain/schemas";
import type { ReviewResult } from "@/domain/schemas";
import { isReadyForCompletionSuggest } from "@/server/services/schedule";
import { expandRoutineOccurrences } from "@/server/services/routines";
import { zonedDateKey } from "@/lib/timezone";

/** 写入 prompt 的产品约束：结束后才记录执行；不得捏造；不得替用户宣布完成。 */
const PRODUCT_CONSTRAINTS = "用户只在日程结束后记录执行结果；status=planned 且计划时间已过，不代表用户没有开始，只是还没回来记录。禁止编造未在数据中出现的内容。必须区分「事实」与「你的判断」。不得在任何字段中宣布 Task、Milestone 或 Outcome 已经完成——最多只能说「建议检查」或「建议确认」，最终是否完成由用户自己确认。";

/** 单条日程块携带的原始执行与反馈事实，daily/weekly facts 组装共用。 */
type PeriodBlock = {
  id: string;
  title: string;
  status: ScheduleBlockStatus;
  startsAt: Date;
  endsAt: Date;
  goalId: string | null;
  taskId: string | null;
  routineId: string | null;
  executionRecord: {
    actualMinutes: number | null;
    result: string;
    quality: string | null;
    obstacle: string | null;
    deviationReason: string | null;
    nextAction: string | null;
    rhythmFeedback: { tags: string[]; note: string | null; comfortable: boolean | null; timeFit: string | null } | null;
  } | null;
  task: { id: string; title: string } | null;
  routine: { id: string; title: string } | null;
  goal: { id: string; title: string } | null;
};

type PeriodMetrics = {
  total: number;
  completed: number;
  missed: number;
  rescheduled: number;
  cancelled: number;
  investedMinutes: number;
  smoothCount: number;
  resistanceCount: number;
};

const RESISTANCE_TAGS = new Set(["resistant", "interrupted", "barely_completed"]);

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
 * 生成日或周回顾。优先使用 AI 按 D4/D5 契约生成结构化评估正文，并同步提取节奏信号；
 * AI 调用失败时回退到规则引擎，并在 source 中标明来源。
 * @param userId - 用户 ID
 * @param type - 回顾类型（daily / weekly）
 * @param periodStart - 回顾周期起始时间（UTC）
 * @param periodEnd - 回顾周期结束时间（UTC）
 */
export async function generateReview(userId: string, type: "daily" | "weekly", periodStart: Date, periodEnd: Date) {
  const user = await ensureLocalUser();
  const timezone = user.timezone;
  const idempotencyKey = `${userId}:${type}:${periodStart.toISOString()}:${periodEnd.toISOString()}`;
  await getDb().review.upsert({ where: { idempotencyKey }, create: { userId, type: type === "daily" ? ReviewType.DAILY : ReviewType.WEEKLY, periodStart, periodEnd, status: ReviewStatus.GENERATING, idempotencyKey }, update: { status: ReviewStatus.GENERATING } });

  try {
    const blocks = await fetchPeriodBlocks(userId, periodStart, periodEnd);
    const metrics = computePeriodMetrics(blocks);
    const activeRhythmSignals = await fetchActiveRhythmSignals(userId, 5);

    let content: ReviewResult;
    let readyForCompletionTasks: Array<{ taskId: string; title: string; goalId: string; goalTitle: string | null }> = [];

    if (type === "daily") {
      const facts = assembleDailyFacts(blocks, periodStart, periodEnd, metrics, activeRhythmSignals);
      const aiResult = await tryAIDailyReview(facts);
      content = aiResult ?? buildRulesDailyReview(facts);
    } else {
      const facts = await assembleWeeklyFacts(userId, blocks, periodStart, periodEnd, timezone, metrics, activeRhythmSignals);
      readyForCompletionTasks = facts.taskProgress
        .filter((task) => task.readyForCompletionSuggest)
        .map((task) => ({ taskId: task.taskId, title: task.title, goalId: task.goalId, goalTitle: task.goalTitle }));
      const aiResult = await tryAIWeeklyReview(facts);
      content = aiResult ?? buildRulesWeeklyReview(facts);
    }

    const reviewContent = {
      sessionHighlights: content.sessionHighlights,
      rhythmNotes: content.rhythmNotes,
      taskProgressNotes: content.taskProgressNotes,
      routineNotes: content.routineNotes,
      goalCheckSuggestions: content.goalCheckSuggestions,
      nextCycleSuggestions: content.nextCycleSuggestions,
      readyForCompletionTasks,
    };

    const review = await getDb().review.upsert({
      where: { idempotencyKey },
      create: { userId, type: type === "daily" ? ReviewType.DAILY : ReviewType.WEEKLY, periodStart, periodEnd, status: ReviewStatus.AWAITING_CONFIRMATION, summary: content.summary, metrics: { ...metrics, source: content.source }, findings: content.findings, suggestions: content.suggestions, content: reviewContent, idempotencyKey },
      update: { status: ReviewStatus.AWAITING_CONFIRMATION, summary: content.summary, metrics: { ...metrics, source: content.source }, findings: content.findings, suggestions: content.suggestions, content: reviewContent },
    });

    // 提取节奏信号（AI 优先，降级为规则）；失败不影响主回顾已写入的结果。
    try {
      const signals = await tryAIRhythmSignals(blocks, metrics, review.id, periodStart, periodEnd)
        ?? buildRulesSignals(metrics, review.id, periodStart, periodEnd);
      for (const signal of signals) {
        const existing = await getDb().rhythmSignal.findFirst({ where: { userId, type: signal.type, validUntil: null }, orderBy: { updatedAt: "desc" } });
        if (existing) await getDb().rhythmSignal.update({ where: { id: existing.id }, data: { statement: signal.statement, confidence: signal.confidence, evidence: signal.evidence, validFrom: new Date() } });
        else await getDb().rhythmSignal.create({ data: { userId, type: signal.type, statement: signal.statement, confidence: signal.confidence, evidence: signal.evidence } });
      }
    } catch (signalError) {
      console.warn("[reviews] rhythm signal extraction failed, review already saved", signalError);
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

// ── 数据组装（规则层，零 LLM） ──────────────────────────────────────────────────

/**
 * 查询周期内的全部日程块（含执行记录、反馈、关联任务/Routine/目标标题）。
 * @param userId - 用户 ID
 * @param periodStart - 周期起始（UTC）
 * @param periodEnd - 周期结束（UTC）
 */
async function fetchPeriodBlocks(userId: string, periodStart: Date, periodEnd: Date): Promise<PeriodBlock[]> {
  return getDb().scheduleBlock.findMany({
    where: { userId, deletedAt: null, startsAt: { gte: periodStart, lt: periodEnd } },
    include: {
      executionRecord: { include: { rhythmFeedback: true } },
      task: { select: { id: true, title: true } },
      routine: { select: { id: true, title: true } },
      goal: { select: { id: true, title: true } },
    },
    orderBy: { startsAt: "asc" },
  });
}

/**
 * 由规则计算周期指标：完成/未完成/改期/取消数、真实投入分钟、顺畅与阻力反馈次数。
 * LLM 只解释这些数字，不重新计算，确保结论可核对。
 * @param blocks - 周期内日程块
 */
function computePeriodMetrics(blocks: PeriodBlock[]): PeriodMetrics {
  const completed = blocks.filter((block) => block.status === "COMPLETED");
  const missed = blocks.filter((block) => block.status === "MISSED");
  const rescheduled = blocks.filter((block) => block.status === "RESCHEDULED");
  const cancelled = blocks.filter((block) => block.status === "CANCELLED");
  const investedMinutes = completed.reduce((sum, block) => sum + blockInvestedMinutes(block), 0);
  const feedbackTags = blocks.flatMap((block) => block.executionRecord?.rhythmFeedback?.tags ?? []);
  const smoothCount = feedbackTags.filter((tag) => tag === "smooth").length;
  const resistanceCount = feedbackTags.filter((tag) => RESISTANCE_TAGS.has(tag)).length;
  return { total: blocks.length, completed: completed.length, missed: missed.length, rescheduled: rescheduled.length, cancelled: cancelled.length, investedMinutes, smoothCount, resistanceCount };
}

/**
 * 计算单个日程块的真实投入分钟数：优先取执行记录的 actualMinutes，否则回退到计划时长。
 * @param block - 日程块
 */
function blockInvestedMinutes(block: { startsAt: Date; endsAt: Date; executionRecord: { actualMinutes: number | null } | null }) {
  return block.executionRecord?.actualMinutes ?? Math.max(0, Math.round((block.endsAt.getTime() - block.startsAt.getTime()) / 60000));
}

/**
 * 读取当前有效的节奏信号，按置信度排序取前 N 条，供日/周回顾对照引用。
 * @param userId - 用户 ID
 * @param limit - 最多条数
 */
async function fetchActiveRhythmSignals(userId: string, limit: number) {
  const signals = await getDb().rhythmSignal.findMany({
    where: { userId, validUntil: null },
    orderBy: { confidence: "desc" },
    take: limit,
  });
  return signals.map((signal) => ({ type: signal.type, statement: signal.statement, confidence: signal.confidence ?? undefined }));
}

// ── 日回顾 facts（D4） ──────────────────────────────────────────────────────────

type DailyFacts = {
  period: { type: "daily"; periodStart: string; periodEnd: string };
  periodMetrics: PeriodMetrics;
  todayBlocks: Array<{
    startsAt: string; endsAt: string; kind: string; title: string; status: string;
    plannedMinutes: number; actualMinutes: number | null; result: string | null;
    tags: string[]; note: string | undefined; comfortable: boolean | undefined; timeFit: string | undefined;
    quality: string | undefined; obstacle: string | undefined; deviationReason: string | undefined; nextAction: string | undefined;
  }>;
  pendingFeedbackCount: number;
  activeRhythmSignals: Array<{ type: string; statement: string; confidence?: number }>;
};

/**
 * 组装日回顾的 LLM 输入：全量当日块执行详情 + 待反馈数 + 少量有效节奏信号。
 * 不含 Goal/Milestone 全树、跨日任务累计、上周对比（日回顾不做阶段评估）。
 * @param blocks - 周期内日程块
 * @param periodStart - 周期起始
 * @param periodEnd - 周期结束
 * @param metrics - 已算好的周期指标
 * @param activeRhythmSignals - 当前有效节奏信号
 */
function assembleDailyFacts(blocks: PeriodBlock[], periodStart: Date, periodEnd: Date, metrics: PeriodMetrics, activeRhythmSignals: Array<{ type: string; statement: string; confidence?: number }>): DailyFacts {
  const now = new Date();
  const todayBlocks = blocks.map((block) => ({
    startsAt: block.startsAt.toISOString(),
    endsAt: block.endsAt.toISOString(),
    kind: block.routineId ? "routine" : block.taskId ? "task" : "personal",
    title: block.task?.title ?? block.routine?.title ?? block.title,
    status: block.status.toLowerCase(),
    plannedMinutes: Math.max(0, Math.round((block.endsAt.getTime() - block.startsAt.getTime()) / 60000)),
    actualMinutes: block.executionRecord?.actualMinutes ?? null,
    result: block.executionRecord?.result ?? null,
    tags: block.executionRecord?.rhythmFeedback?.tags ?? [],
    note: block.executionRecord?.rhythmFeedback?.note ?? undefined,
    comfortable: block.executionRecord?.rhythmFeedback?.comfortable ?? undefined,
    timeFit: block.executionRecord?.rhythmFeedback?.timeFit ?? undefined,
    quality: block.executionRecord?.quality ?? undefined,
    obstacle: block.executionRecord?.obstacle ?? undefined,
    deviationReason: block.executionRecord?.deviationReason ?? undefined,
    nextAction: block.executionRecord?.nextAction ?? undefined,
  }));
  const pendingFeedbackCount = blocks.filter((block) => block.status === "PLANNED" && block.endsAt < now).length;
  return {
    period: { type: "daily", periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() },
    periodMetrics: metrics,
    todayBlocks,
    pendingFeedbackCount,
    activeRhythmSignals,
  };
}

// ── 周回顾 facts + 上下文压缩（D4 / D10，design.md §3.3.1） ──────────────────────

const NOTE_EXCERPT_LIMIT = 12;
const REPRESENTATIVE_BLOCK_LIMIT = 15;
const TASK_PROGRESS_LIMIT = 10;
const ROUTINE_STABILITY_LIMIT = 8;
const GOAL_PROGRESS_LIMIT = 5;
const DAILY_FINDINGS_LIMIT = 12;
const SPARSE_DAILY_REVIEW_THRESHOLD = 4;
const EXCERPT_TEXT_LIMIT = 80;

type BlockExcerpt = { title: string; status: string; tags: string[]; note?: string };

type TaskProgressFact = {
  taskId: string; title: string; status: string; estimatedMinutes: number | null;
  investedMinutes: number; completedSessions: number; readyForCompletionSuggest: boolean;
  goalId: string; goalTitle: string | null;
};

type RoutineStabilityFact = { routineId: string; title: string; planned: number; completed: number; missed: number; skipped: number; topTags: string[] };

type ScheduleDeviationFact = { missedCount: number; rescheduledCount: number; cancelledCount: number; topReasons: string[]; topObstacles: string[] };

type GoalProgressHintFact = { goalId: string; title: string; investedMinutes: number; milestonesToCheck: Array<{ title: string; status: string }>; outcomesToCheck: string[] };

type WeeklyFacts = {
  period: { type: "weekly"; periodStart: string; periodEnd: string };
  periodMetrics: PeriodMetrics;
  dailyAggregation: Array<{ date: string; done: number; total: number; investedMinutes: number; smooth: number; resistance: number }>;
  noteExcerpts: BlockExcerpt[];
  representativeBlocks: BlockExcerpt[];
  taskProgress: TaskProgressFact[];
  routineStability: RoutineStabilityFact[];
  scheduleDeviation: ScheduleDeviationFact;
  goalProgressHints: GoalProgressHintFact[];
  activeRhythmSignals: Array<{ type: string; statement: string; confidence?: number }>;
  recentDailyReviewFindings: string[];
};

/**
 * 组装周回顾的 LLM 输入。核心是 design.md §3.3.1 描述的确定性压缩：
 * 数字先由规则算好，日回顾 findings 优先作先验，用户 note / 异常样本优先进入
 * 有限摘录池，普通完成块只进聚合计数——绝不把整周逐条日程原文塞进 prompt。
 * @param userId - 用户 ID
 * @param blocks - 周期内日程块
 * @param periodStart - 周期起始
 * @param periodEnd - 周期结束
 * @param timezone - 用户时区（用于按天聚合分组）
 * @param metrics - 已算好的周期指标
 * @param activeRhythmSignals - 当前有效节奏信号
 */
async function assembleWeeklyFacts(
  userId: string,
  blocks: PeriodBlock[],
  periodStart: Date,
  periodEnd: Date,
  timezone: string,
  metrics: PeriodMetrics,
  activeRhythmSignals: Array<{ type: string; statement: string; confidence?: number }>,
): Promise<WeeklyFacts> {
  const dailyReviews = await getDb().review.findMany({
    where: { userId, type: ReviewType.DAILY, periodStart: { gte: periodStart, lt: periodEnd } },
    orderBy: { periodStart: "asc" },
  });
  const recentDailyReviewFindings = dedupeStrings(
    dailyReviews.flatMap((review) => (Array.isArray(review.findings) ? (review.findings as unknown[]).map(String).slice(0, 3) : [])),
  ).slice(0, DAILY_FINDINGS_LIMIT);
  const hasEnoughDailyReviews = dailyReviews.length >= SPARSE_DAILY_REVIEW_THRESHOLD;

  const ranked = rankBlocksForWeeklyExcerpt(blocks);
  const noteExcerpts = ranked.filter((entry) => entry.score > 0).slice(0, NOTE_EXCERPT_LIMIT).map((entry) => entry.excerpt);
  const representativeBlocks = hasEnoughDailyReviews ? [] : ranked.slice(0, REPRESENTATIVE_BLOCK_LIMIT).map((entry) => entry.excerpt);

  const [taskProgress, routineStability, goalProgressHints] = await Promise.all([
    buildTaskProgress(userId, blocks),
    buildRoutineStability(userId, periodStart, periodEnd),
    buildGoalProgressHints(userId, blocks),
  ]);

  return {
    period: { type: "weekly", periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() },
    periodMetrics: metrics,
    dailyAggregation: buildDailyAggregation(blocks, periodStart, periodEnd, timezone),
    noteExcerpts,
    representativeBlocks,
    taskProgress,
    routineStability,
    scheduleDeviation: buildScheduleDeviation(blocks),
    goalProgressHints,
    activeRhythmSignals,
    recentDailyReviewFindings,
  };
}

/**
 * 按用户时区把周期内日程块聚合为每天一行的固定小结构，供周回顾替代逐块列表。
 * @param blocks - 周期内日程块
 * @param periodStart - 周期起始
 * @param periodEnd - 周期结束
 * @param timezone - 用户时区
 */
function buildDailyAggregation(blocks: PeriodBlock[], periodStart: Date, periodEnd: Date, timezone: string) {
  const rows = new Map<string, { done: number; total: number; investedMinutes: number; smooth: number; resistance: number }>();
  for (const cursor = new Date(periodStart); cursor < periodEnd; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    rows.set(zonedDateKey(cursor, timezone), { done: 0, total: 0, investedMinutes: 0, smooth: 0, resistance: 0 });
  }
  for (const block of blocks) {
    const key = zonedDateKey(block.startsAt, timezone);
    const row = rows.get(key) ?? { done: 0, total: 0, investedMinutes: 0, smooth: 0, resistance: 0 };
    row.total += 1;
    if (block.status === "COMPLETED") {
      row.done += 1;
      row.investedMinutes += blockInvestedMinutes(block);
    }
    const tags = block.executionRecord?.rhythmFeedback?.tags ?? [];
    if (tags.includes("smooth")) row.smooth += 1;
    if (tags.some((tag) => RESISTANCE_TAGS.has(tag))) row.resistance += 1;
    rows.set(key, row);
  }
  return Array.from(rows.entries()).map(([date, row]) => ({ date, ...row }));
}

/**
 * 为周回顾摘录池打分排序：有用户 note 优先，其次是有阻碍说明的未完成/改期块，
 * 再次是带阻力标签的块，普通完成块分数最低但仍保留以支撑「代表块」场景。
 * @param blocks - 周期内日程块
 */
function rankBlocksForWeeklyExcerpt(blocks: PeriodBlock[]) {
  return blocks
    .map((block) => {
      const tags = block.executionRecord?.rhythmFeedback?.tags ?? [];
      const note = block.executionRecord?.rhythmFeedback?.note ?? undefined;
      const hasObstacleOnException = (block.status === "MISSED" || block.status === "RESCHEDULED") && Boolean(block.executionRecord?.obstacle || block.executionRecord?.deviationReason);
      const hasResistanceTag = tags.some((tag) => RESISTANCE_TAGS.has(tag));
      const score = note ? 100 : hasObstacleOnException ? 50 : hasResistanceTag ? 30 : 1;
      const excerpt: BlockExcerpt = {
        title: block.task?.title ?? block.routine?.title ?? block.title,
        status: block.status.toLowerCase(),
        tags,
        note: note ? truncate(note, EXCERPT_TEXT_LIMIT) : undefined,
      };
      return { score, excerpt };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * 查询本周有日程活动的任务，计算其全量投入与「建议确认完成」信号。
 * 只描述证据，不修改任务状态；是否完成仍由用户主动确认。
 * @param userId - 用户 ID
 * @param periodBlocks - 本周期内的日程块，用于定位本周有活动的任务
 */
async function buildTaskProgress(userId: string, periodBlocks: PeriodBlock[]): Promise<TaskProgressFact[]> {
  const taskIds = [...new Set(periodBlocks.map((block) => block.taskId).filter((id): id is string => Boolean(id)))];
  if (!taskIds.length) return [];
  const tasks = await getDb().task.findMany({
    where: { id: { in: taskIds }, archivedAt: null },
    select: { id: true, title: true, status: true, estimatedMinutes: true, goalId: true, goal: { select: { title: true } } },
  });
  const results: TaskProgressFact[] = [];
  for (const task of tasks) {
    const allBlocks = await getDb().scheduleBlock.findMany({
      where: { userId, deletedAt: null, OR: [{ taskId: task.id }, { linkedTasks: { some: { taskId: task.id } } }] },
      select: { status: true, startsAt: true, endsAt: true, executionRecord: { select: { actualMinutes: true } } },
    });
    const investedByBlock = allBlocks.map((block) => ({ status: block.status, investedMinutes: blockInvestedMinutes(block) }));
    const completedBlocks = investedByBlock.filter((block) => block.status === "COMPLETED");
    const investedMinutes = completedBlocks.reduce((sum, block) => sum + block.investedMinutes, 0);
    results.push({
      taskId: task.id,
      title: task.title,
      status: task.status.toLowerCase(),
      estimatedMinutes: task.estimatedMinutes,
      investedMinutes,
      completedSessions: completedBlocks.length,
      readyForCompletionSuggest: isReadyForCompletionSuggest({ status: task.status, estimatedMinutes: task.estimatedMinutes }, investedByBlock),
      goalId: task.goalId,
      goalTitle: task.goal?.title ?? null,
    });
  }
  return results.sort((a, b) => b.investedMinutes - a.investedMinutes).slice(0, TASK_PROGRESS_LIMIT);
}

/**
 * 汇总本周期内各 Routine 的坚持情况（计划/完成/未完成/跳过次数与高频反馈标签）。
 * Routine 发生实例来自虚拟展开（`expandRoutineOccurrences`），不是 ScheduleBlock 表行。
 * @param userId - 用户 ID
 * @param periodStart - 周期起始
 * @param periodEnd - 周期结束
 */
async function buildRoutineStability(userId: string, periodStart: Date, periodEnd: Date): Promise<RoutineStabilityFact[]> {
  const occurrences = await expandRoutineOccurrences(userId, periodStart, periodEnd);
  if (!occurrences.length) return [];
  const byRoutine = new Map<string, { title: string; planned: number; completed: number; missed: number; skipped: number; tags: string[] }>();
  for (const occurrence of occurrences) {
    const entry = byRoutine.get(occurrence.routineId) ?? { title: occurrence.title, planned: 0, completed: 0, missed: 0, skipped: 0, tags: [] };
    entry.planned += 1;
    if (occurrence.status === "completed") entry.completed += 1;
    else if (occurrence.status === "missed") entry.missed += 1;
    else if (occurrence.status === "cancelled") entry.skipped += 1;
    if (occurrence.executionRecord?.rhythmFeedback?.tags) entry.tags.push(...occurrence.executionRecord.rhythmFeedback.tags);
    byRoutine.set(occurrence.routineId, entry);
  }
  return Array.from(byRoutine.entries())
    .map(([routineId, entry]) => ({ routineId, title: entry.title, planned: entry.planned, completed: entry.completed, missed: entry.missed, skipped: entry.skipped, topTags: topCounts(entry.tags, 3) }))
    .slice(0, ROUTINE_STABILITY_LIMIT);
}

/**
 * 汇总本周期的日程偏差：未完成/改期/取消计数，以及高频改期原因与执行阻碍。
 * 不附带全部偏差块原文，只给计数与 Top3 归因。
 * @param blocks - 周期内日程块
 */
function buildScheduleDeviation(blocks: PeriodBlock[]): ScheduleDeviationFact {
  const missed = blocks.filter((block) => block.status === "MISSED");
  const rescheduled = blocks.filter((block) => block.status === "RESCHEDULED");
  const cancelled = blocks.filter((block) => block.status === "CANCELLED");
  const reasons = [...missed, ...rescheduled].map((block) => block.executionRecord?.deviationReason).filter((value): value is string => Boolean(value));
  const obstacles = blocks.map((block) => block.executionRecord?.obstacle).filter((value): value is string => Boolean(value));
  return {
    missedCount: missed.length,
    rescheduledCount: rescheduled.length,
    cancelledCount: cancelled.length,
    topReasons: topCounts(reasons, 3),
    topObstacles: topCounts(obstacles, 3),
  };
}

/**
 * 为本周期有活动的目标提取「建议检查」线索：本周投入、待检查 Milestone、未完成 Outcome。
 * 只输出证据，不判定目标是否达成。
 * @param userId - 用户 ID
 * @param periodBlocks - 周期内日程块，用于定位活跃目标与计算周期投入
 */
async function buildGoalProgressHints(userId: string, periodBlocks: PeriodBlock[]): Promise<GoalProgressHintFact[]> {
  const goalIds = [...new Set(periodBlocks.map((block) => block.goalId).filter((id): id is string => Boolean(id)))];
  if (!goalIds.length) return [];
  const goals = await getDb().goal.findMany({
    where: { id: { in: goalIds }, userId, archivedAt: null },
    select: {
      id: true,
      title: true,
      milestones: { where: { status: { in: ["PENDING", "READY_FOR_REVIEW"] } }, select: { title: true, status: true } },
      outcomes: { where: { completedAt: null }, select: { description: true } },
    },
  });
  return goals
    .map((goal) => {
      const investedMinutes = periodBlocks
        .filter((block) => block.goalId === goal.id && block.status === "COMPLETED")
        .reduce((sum, block) => sum + blockInvestedMinutes(block), 0);
      return {
        goalId: goal.id,
        title: goal.title,
        investedMinutes,
        milestonesToCheck: goal.milestones.map((milestone) => ({ title: milestone.title, status: milestone.status.toLowerCase() })),
        outcomesToCheck: goal.outcomes.map((outcome) => outcome.description),
      };
    })
    .sort((a, b) => b.investedMinutes - a.investedMinutes)
    .slice(0, GOAL_PROGRESS_LIMIT);
}

/**
 * 去重字符串数组，保留首次出现的顺序。
 * @param values - 原始字符串数组
 */
function dedupeStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/**
 * 统计字符串出现次数，返回按频次降序的 Top N 值（不含次数，供 prompt 直接引用）。
 * @param values - 原始字符串数组（可含重复）
 * @param limit - 最多返回条数
 */
function topCounts(values: string[], limit: number) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value]) => value);
}

/**
 * 截断字符串到指定长度，超出部分以省略号标记。
 * @param value - 原始字符串
 * @param limit - 最大长度
 */
function truncate(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

// ── AI 路径 ────────────────────────────────────────────────────────────────────

/**
 * 尝试调用 AI 模型生成日回顾结构化内容。失败时返回 null，由调用方降级到规则引擎。
 * @param facts - 日回顾 facts（D4）
 */
async function tryAIDailyReview(facts: DailyFacts): Promise<ReviewResult | null> {
  try {
    const { resolveCapabilityProvider } = await import("@/agent/provider-config");
    const { OpenAICompatibleAdapter } = await import("@/agent/openai-compatible-adapter");
    const { provider, model } = resolveCapabilityProvider("review");
    const adapter = new OpenAICompatibleAdapter(provider);

    const prompt = `这是一份日回顾请求，聚焦「今天执行得怎样、感受如何、今晚/明天要不要轻调」。
周期：${facts.period.periodStart} 到 ${facts.period.periodEnd}
周期指标：总日程 ${facts.periodMetrics.total} 个，完成 ${facts.periodMetrics.completed}，未完成 ${facts.periodMetrics.missed}，改期 ${facts.periodMetrics.rescheduled}，取消 ${facts.periodMetrics.cancelled}，真实投入 ${facts.periodMetrics.investedMinutes} 分钟，顺畅反馈 ${facts.periodMetrics.smoothCount} 次，阻力反馈 ${facts.periodMetrics.resistanceCount} 次。
${facts.pendingFeedbackCount ? `另有 ${facts.pendingFeedbackCount} 个已结束但用户尚未记录执行结果的日程块。` : ""}

今日日程与执行详情（含用户自然语言补充感受 note 字段）：
${JSON.stringify(facts.todayBlocks, null, 2)}

当前有效的节奏信号（仅供参考对照，不要重复堆砌）：
${JSON.stringify(facts.activeRhythmSignals, null, 2)}

产品约束：${PRODUCT_CONSTRAINTS}

特别注意：如果任意日程块的 note 字段非空，必须在 summary 或 findings 中优先引用、回应它的具体内容，不能只统计标签次数、忽略用户的原话。

请生成结构化回顾：
- summary：1-3 句概述今天执行情况和整体节奏
- findings：从数据中提取的客观发现（而非评判），3-6 条
- suggestions：基于发现的可操作建议，2-4 条
- source：固定填 "ai"
- sessionHighlights：今天值得记录的执行亮点或阻力，2-4 条
- rhythmNotes：若能观察到节奏相关的轻量发现可填 1-2 条，否则留空数组
- nextCycleSuggestions：给今晚或明天的 1-2 条轻量调整建议（不是正式改期指令）
- taskProgressNotes、routineNotes、goalCheckSuggestions：日回顾不做阶段评估，留空数组`;

    return await adapter.generateObject({
      model,
      system: "你是 Rhythm & Routine 的节奏分析助手。基于真实执行数据生成客观、支持性的日回顾，区分事实与判断，优先回应用户的自然语言感受。",
      prompt,
      schema: reviewResultSchema,
      maxOutputTokens: 1400,
    });
  } catch {
    return null;
  }
}

/**
 * 尝试调用 AI 模型生成周回顾结构化内容。输入已经过 design.md §3.3.1 的确定性压缩，
 * 失败时返回 null，由调用方降级到规则引擎。
 * @param facts - 周回顾 facts（D4/D10，已压缩）
 */
async function tryAIWeeklyReview(facts: WeeklyFacts): Promise<ReviewResult | null> {
  try {
    const { resolveCapabilityProvider } = await import("@/agent/provider-config");
    const { OpenAICompatibleAdapter } = await import("@/agent/openai-compatible-adapter");
    const { provider, model } = resolveCapabilityProvider("review");
    const adapter = new OpenAICompatibleAdapter(provider);

    const prompt = `这是一份周回顾请求，聚焦「这一周节奏与目标推进如何、哪些阶段该由用户自己确认」。
周期：${facts.period.periodStart} 到 ${facts.period.periodEnd}
周期指标：总日程 ${facts.periodMetrics.total} 个，完成 ${facts.periodMetrics.completed}，未完成 ${facts.periodMetrics.missed}，改期 ${facts.periodMetrics.rescheduled}，取消 ${facts.periodMetrics.cancelled}，真实投入 ${facts.periodMetrics.investedMinutes} 分钟，顺畅反馈 ${facts.periodMetrics.smoothCount} 次，阻力反馈 ${facts.periodMetrics.resistanceCount} 次。

按天聚合（数字已算好，直接引用，不要重新计算）：
${JSON.stringify(facts.dailyAggregation, null, 2)}

本周精选摘录（已按「用户 note 优先、异常优先」排序精选，不代表全部数据）：
${JSON.stringify(facts.noteExcerpts, null, 2)}
${facts.representativeBlocks.length ? `\n本周日回顾较少，补充代表性日程样本：\n${JSON.stringify(facts.representativeBlocks, null, 2)}` : ""}

任务进展（仅列出本周有活动的任务；readyForCompletionSuggest 只是「建议用户检查」的信号，不代表已完成）：
${JSON.stringify(facts.taskProgress, null, 2)}

Routine 坚持情况：
${JSON.stringify(facts.routineStability, null, 2)}

日程偏差：
${JSON.stringify(facts.scheduleDeviation, null, 2)}

目标投入与待检查线索（milestonesToCheck/outcomesToCheck 只是「建议用户检查」，不代表已达成）：
${JSON.stringify(facts.goalProgressHints, null, 2)}

本周已生成的日回顾发现（已去重，作为背景参考）：
${JSON.stringify(facts.recentDailyReviewFindings, null, 2)}

当前有效的节奏信号：
${JSON.stringify(facts.activeRhythmSignals, null, 2)}

产品约束：${PRODUCT_CONSTRAINTS}

重要：只能基于以上数字与摘录下结论；证据不足的地方要如实说明「数据不足」，禁止脑补。摘录或代表块中若出现用户的自然语言感受（note），至少一条 finding 或 rhythmNotes 需要回应其具体内容。goalCheckSuggestions 与 taskProgressNotes 只能使用「建议检查/建议确认」的措辞，绝不能宣布 Milestone、Outcome 或 Task 已经完成。

请生成结构化回顾：
- summary：1-3 句概述本周执行情况和整体节奏
- findings：客观发现，3-6 条，尽量能指回上面的数字或摘录
- suggestions：可操作建议，2-4 条
- source：固定填 "ai"
- sessionHighlights：可选，本周执行亮点摘要（不需要逐条罗列），0-3 条
- rhythmNotes：对照节奏信号与摘录的节奏解读，2-4 条
- taskProgressNotes：基于任务进展的观察，2-4 条
- routineNotes：基于 Routine 坚持情况的观察，1-3 条
- goalCheckSuggestions：基于目标线索的「建议检查」文案，0-3 条
- nextCycleSuggestions：下周的轻量调整建议，2-3 条（不是正式改期指令）`;

    return await adapter.generateObject({
      model,
      system: "你是 Rhythm & Routine 的节奏分析助手。基于已压缩的真实执行数据生成客观、支持性的周回顾，严格区分事实与判断，绝不替用户宣布任务或目标已完成。",
      prompt,
      schema: reviewResultSchema,
      maxOutputTokens: 2000,
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
  metrics: PeriodMetrics,
  reviewId: string, periodStart: Date, periodEnd: Date,
) {
  try {
    const { resolveCapabilityProvider } = await import("@/agent/provider-config");
    const { OpenAICompatibleAdapter } = await import("@/agent/openai-compatible-adapter");
    const { provider, model } = resolveCapabilityProvider("review");
    const adapter = new OpenAICompatibleAdapter(provider);

    const prompt = `基于以下执行数据，提取有价值的节奏信号（每条需有数据支撑）：
完成率：${metrics.total > 0 ? Math.round((metrics.completed / metrics.total) * 100) : 0}%，投入：${metrics.investedMinutes} 分钟
顺畅次数：${metrics.smoothCount}，阻力次数：${metrics.resistanceCount}
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
 * 规则引擎降级路径：生成日回顾结构化内容，标记 source = "rules"。
 * 有用户 note 时优先引用其原文，而不是只报标签次数。
 * @param facts - 日回顾 facts
 */
function buildRulesDailyReview(facts: DailyFacts): ReviewResult {
  const { periodMetrics: metrics } = facts;
  const notedHighlights = facts.todayBlocks.filter((block) => block.note).map((block) => `「${block.title}」：${block.note}`).slice(0, 4);
  const missedCount = facts.todayBlocks.filter((block) => block.status === "missed" || block.status === "rescheduled").length;
  const findings = [
    ...notedHighlights.map((highlight) => `你记录了感受：${highlight}`),
    ...(metrics.smoothCount ? [`记录到 ${metrics.smoothCount} 次顺畅执行，可以继续观察它们的时间与任务类型。`] : []),
    ...(metrics.resistanceCount ? [`记录到 ${metrics.resistanceCount} 次阻力信号，适合检查任务粒度和时间匹配。`] : []),
    ...(!notedHighlights.length && !metrics.smoothCount && !metrics.resistanceCount ? ["今天的节奏反馈还不够多，明天优先保持轻量记录。"] : []),
  ].slice(0, 6);
  const suggestions = [
    ...(missedCount ? ["先处理今天未完成的日程：改期、拆小或明确放弃。"] : ["保留今天执行顺畅的安排方式。"]),
    ...(facts.pendingFeedbackCount ? [`还有 ${facts.pendingFeedbackCount} 个日程未记录执行结果，记得补上感受。`] : []),
  ];
  return {
    summary: `今天完成 ${metrics.completed}/${metrics.total} 个日程块，真实投入约 ${Math.floor(metrics.investedMinutes / 60)} 小时 ${metrics.investedMinutes % 60} 分钟。`,
    findings: findings.length ? findings : ["数据量较少，建议继续积累执行反馈。"],
    suggestions: suggestions.length ? suggestions : ["维持当前节奏，继续记录反馈。"],
    source: "rules",
    sessionHighlights: notedHighlights,
    rhythmNotes: [],
    taskProgressNotes: [],
    routineNotes: [],
    goalCheckSuggestions: [],
    nextCycleSuggestions: suggestions.slice(0, 2),
  };
}

/**
 * 规则引擎降级路径：生成周回顾结构化内容，标记 source = "rules"。
 * 任务/Routine/目标区块直接从已压缩的规则事实派生，语气统一使用「建议检查/确认」。
 * @param facts - 周回顾 facts（已压缩）
 */
function buildRulesWeeklyReview(facts: WeeklyFacts): ReviewResult {
  const { periodMetrics: metrics } = facts;
  const findings = [
    ...(metrics.smoothCount ? [`本周记录到 ${metrics.smoothCount} 次顺畅执行，可以继续观察它们的时间与任务类型。`] : []),
    ...(metrics.resistanceCount ? [`本周记录到 ${metrics.resistanceCount} 次阻力信号，适合检查任务粒度和时间匹配。`] : []),
    ...(facts.noteExcerpts.filter((excerpt) => excerpt.note).slice(0, 3).map((excerpt) => `你记录了感受：「${excerpt.title}」：${excerpt.note}`)),
    ...(!metrics.smoothCount && !metrics.resistanceCount ? ["本周节奏反馈还不够多，下周优先保持轻量记录。"] : []),
  ].slice(0, 6);
  const suggestions = [
    ...(metrics.missed || metrics.rescheduled ? ["逐个处理未完成日程：改期、拆小或明确放弃。"] : ["保留本周执行顺畅的安排方式。"]),
    ...(metrics.resistanceCount > metrics.smoothCount ? ["下个周期减少同时推进的高专注任务。"] : []),
  ];
  const taskProgressNotes = facts.taskProgress
    .filter((task) => task.readyForCompletionSuggest)
    .slice(0, 4)
    .map((task) => `「${task.title}」累计投入 ${task.investedMinutes} 分钟${task.estimatedMinutes ? `（预计 ${task.estimatedMinutes} 分钟）` : ""}，建议你检查是否可以确认完成。`);
  const routineNotes = facts.routineStability
    .slice(0, 3)
    .map((routine) => `Routine「${routine.title}」本周计划 ${routine.planned} 次，完成 ${routine.completed} 次。`);
  const goalCheckSuggestions = facts.goalProgressHints
    .flatMap((goal) => goal.milestonesToCheck.filter((milestone) => milestone.status === "ready_for_review").map((milestone) => `目标「${goal.title}」的里程碑「${milestone.title}」已进入待确认状态，建议你检查是否可以确认完成。`))
    .slice(0, 3);
  return {
    summary: `本周期完成 ${metrics.completed}/${metrics.total} 个日程块，真实投入约 ${Math.floor(metrics.investedMinutes / 60)} 小时 ${metrics.investedMinutes % 60} 分钟。`,
    findings: findings.length ? findings : ["数据量较少，建议继续积累执行反馈。"],
    suggestions: suggestions.length ? suggestions : ["维持当前节奏，继续记录反馈。"],
    source: "rules",
    sessionHighlights: [],
    rhythmNotes: [],
    taskProgressNotes,
    routineNotes,
    goalCheckSuggestions,
    nextCycleSuggestions: suggestions.slice(0, 2),
  };
}

/**
 * 规则引擎降级路径，基于统计数据生成固定类型的节奏信号。
 */
function buildRulesSignals(metrics: PeriodMetrics, reviewId: string, periodStart: Date, periodEnd: Date) {
  const evidence = { reviewId, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(), metrics };
  return [
    ...(metrics.smoothCount >= 2 ? [{ type: "smooth_pattern", statement: `本周期记录到 ${metrics.smoothCount} 次顺畅执行，当前安排中存在值得保护的顺畅窗口。`, confidence: Math.min(0.9, 0.45 + metrics.smoothCount * 0.08), evidence }] : []),
    ...(metrics.resistanceCount >= 2 ? [{ type: "resistance_pattern", statement: `本周期记录到 ${metrics.resistanceCount} 次阻力信号，任务粒度或时间匹配需要调整。`, confidence: Math.min(0.9, 0.45 + metrics.resistanceCount * 0.08), evidence }] : []),
    ...(metrics.total >= 3 ? [{ type: "completion_pattern", statement: `本周期日程完成率为 ${Math.round((metrics.completed / metrics.total) * 100)}%。`, confidence: 0.75, evidence }] : []),
  ];
}

function serializeReview<T extends { type: string; status: string; periodStart: Date; periodEnd: Date; confirmedAt: Date | null; createdAt: Date; updatedAt: Date }>(review: T) { return { ...review, type: review.type.toLowerCase(), status: review.status.toLowerCase(), periodStart: review.periodStart.toISOString(), periodEnd: review.periodEnd.toISOString(), confirmedAt: review.confirmedAt?.toISOString() ?? null, createdAt: review.createdAt.toISOString(), updatedAt: review.updatedAt.toISOString() }; }
