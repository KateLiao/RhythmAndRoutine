import { z } from "zod";

export const rhythmTagSchema = z.enum([
  "smooth",
  "resistant",
  "barely_completed",
  "high_energy",
  "low_energy",
  "interrupted",
  "not_started",
]);

/**
 * 节奏匹配条件结构化对象，描述任务适合执行的时段、能量状态等偏好。
 * @field preferredTimeOfDay - 偏好时段（morning/afternoon/evening/anytime）
 * @field notes - 附加匹配说明
 */
export const rhythmConditionSchema = z.object({
  preferredTimeOfDay: z.enum(["morning", "afternoon", "evening", "anytime"]).optional(),
  notes: z.string().max(200).optional(),
});

/**
 * 任务规划草案 schema，用于 Agent 规划输出的结构化校验。
 */
export const taskDraftSchema = z.object({
  title: z.string().min(1).max(120),
  intent: z.string().max(600).optional(),
  completionCriteria: z.array(z.string().min(1)).max(8).default([]),
  suggestedSteps: z.array(z.string().min(1)).max(10).default([]),
  estimatedMinutes: z.number().int().positive().max(1440).optional(),
  energyLevel: z.enum(["low", "medium", "high"]).optional(),
  focusLevel: z.enum(["low", "medium", "high"]).optional(),
  /** 节奏匹配条件：描述任务适合执行的时段和能量偏好 */
  rhythmConditions: z.array(rhythmConditionSchema).max(4).default([]),
});

export const planningDraftSchema = z.object({
  goal: z.object({
    title: z.string().min(1).max(120),
    description: z.string().max(1200),
    category: z.enum(["project", "skill", "routine", "mixed"]),
    project: z.string().max(160).optional(),
    skill: z.string().max(160).optional(),
    targetDate: z.iso.date().optional(),
  }),
  outcomes: z.array(z.object({ description: z.string().min(1).max(600) })).min(1).max(5),
  milestones: z.array(z.object({
    title: z.string().min(1).max(120),
    description: z.string().max(600).optional(),
    tasks: z.array(taskDraftSchema).max(12),
  })).min(1).max(8),
  routines: z.array(z.object({
    title: z.string().min(1).max(120),
    recurrenceRule: z.string().min(1).max(200),
    reason: z.string().max(600).optional(),
    linkedGoal: z.string().max(120).optional(),
    startDate: z.iso.date(),
    endDate: z.iso.date().optional(),
    durationMinutes: z.number().int().positive().max(1440).default(20),
    preferredStartTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    preferredEndTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    preferredTime: z.enum(["morning", "afternoon", "evening", "night"]).optional(),
    minimumVersion: z.string().max(300).refine((value) => !/^时段.+有效期/.test(value), "最低可执行版本应描述退阶动作，而不是时段或有效期").optional(),
  })).max(8).default([]),
});

export const changeOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create"), entity: z.string(), payload: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("update"), entity: z.string(), entityId: z.string(), before: z.record(z.string(), z.unknown()), after: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("archive"), entity: z.string(), entityId: z.string(), before: z.record(z.string(), z.unknown()) }),
]);

export const changeSetDraftSchema = z.object({
  title: z.string().min(1).max(160),
  reason: z.string().min(1).max(1000),
  riskLevel: z.enum(["low", "medium", "high"]),
  operations: z.array(changeOperationSchema).min(1).max(120),
});

/**
 * AI 生成的回顾结果 schema，用于 review capability 结构化输出校验。
 * 日/周回顾共用同一套增强结构：必有字段两者都填；可选区块日回顾通常留空，
 * 周回顾按需填充（详见 design.md D5）。系统不得在任何字段中宣布
 * Task / Milestone / Outcome 已完成，只能给出「建议检查/建议确认」的文案。
 * @field summary - 本周期总结（1-3 句）
 * @field findings - 从数据中提取的事实性发现列表
 * @field suggestions - 下一周期的可操作建议列表
 * @field source - 标记内容来源（ai 或 rules）
 * @field sessionHighlights - 本周期内值得记录的执行亮点/阻力（日回顾主用，周回顾可选）
 * @field rhythmNotes - 对照真实 Rhythm Signal 的节奏解读（周回顾主用）
 * @field taskProgressNotes - 任务进展观察，仅描述证据，不宣布完成（周回顾主用）
 * @field routineNotes - Routine 坚持情况观察（周回顾主用）
 * @field goalCheckSuggestions - 建议用户检查的目标/阶段节点，措辞为「建议」而非「已完成」
 * @field nextCycleSuggestions - 下一周期的轻量调整建议（日=今晚/明天；周=下周，均非 ChangeSet）
 */
export const reviewResultSchema = z.object({
  summary: z.string().min(1).max(600),
  findings: z.array(z.string().min(1).max(300)).min(1).max(8),
  suggestions: z.array(z.string().min(1).max(300)).min(1).max(6),
  source: z.enum(["ai", "rules"]).default("ai"),
  sessionHighlights: z.array(z.string().min(1).max(300)).max(6).default([]),
  rhythmNotes: z.array(z.string().min(1).max(300)).max(6).default([]),
  taskProgressNotes: z.array(z.string().min(1).max(300)).max(6).default([]),
  routineNotes: z.array(z.string().min(1).max(300)).max(6).default([]),
  goalCheckSuggestions: z.array(z.string().min(1).max(300)).max(6).default([]),
  nextCycleSuggestions: z.array(z.string().min(1).max(300)).max(6).default([]),
});

/**
 * AI 从执行记录中提取的节奏信号 schema，用于 Agent 结构化输出校验。
 * @field signals - 节奏信号数组，每条包含类型、陈述、置信度和证据
 */
export const rhythmSignalExtractionSchema = z.object({
  signals: z.array(z.object({
    type: z.string().min(1).max(60),
    statement: z.string().min(1).max(400),
    confidence: z.number().min(0).max(1),
    evidenceSummary: z.string().max(300).optional(),
  })).min(0).max(10),
});

export type PlanningDraft = z.infer<typeof planningDraftSchema>;
export type ChangeSetDraft = z.infer<typeof changeSetDraftSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;
export type RhythmSignalExtraction = z.infer<typeof rhythmSignalExtractionSchema>;

/**
 * AI 任务完成总结 schema：先总结执行投入，再评价整体完成情况。
 * @field executionSummary - 基于时间块执行记录的投入与过程总结
 * @field overallEvaluation - 对照完成标准给出的整体完成评价
 * @field source - 内容来源（ai 或 rules）
 */
export const taskCompletionSummarySchema = z.object({
  executionSummary: z.string().min(1).max(1200),
  overallEvaluation: z.string().min(1).max(1200),
  source: z.enum(["ai", "rules"]).default("ai"),
});

export type TaskCompletionSummary = z.infer<typeof taskCompletionSummarySchema>;

/** 持久化到 Task.completionRecord 的结构 */
export type TaskCompletionRecord = TaskCompletionSummary & {
  investedMinutes: number;
  completedSessions: number;
  generatedAt: string;
};

const insightClockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const insightDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const insightActionLabelSchema = z.string().min(1).max(40);

/**
 * 为 proposedChange 补齐缺失的 label，并把 null 可选字段清成 undefined。
 * @param change - 原始 proposedChange
 * @param fallbackLabel - 回退文案（通常来自 nextLabel）
 */
function withActionLabel(change: Record<string, unknown>, fallbackLabel: string) {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(change)) {
    if (value === null) continue;
    next[key] = value;
  }
  if (!next.scheduleId && typeof next.blockId === "string") next.scheduleId = next.blockId;
  if (!next.scheduleId && typeof next.id === "string" && next.type === "open_execution_feedback") {
    next.scheduleId = next.id;
  }
  if (typeof next.label === "string" && next.label.trim()) return next;
  return { ...next, label: fallbackLabel.slice(0, 40) || "接受安排" };
}

/**
 * 归一化单条此刻建议卡片字段，兼容模型常见别名与缺省。
 * @param card - 原始卡片对象
 */
function normalizeMomentCard(card: unknown): unknown {
  if (!card || typeof card !== "object") return card;
  const raw = card as Record<string, unknown>;
  const nextLabel = typeof raw.nextLabel === "string" && raw.nextLabel.trim()
    ? raw.nextLabel
    : typeof raw.actionLabel === "string" && raw.actionLabel.trim()
      ? raw.actionLabel
      : "接受安排";
  const reason = typeof raw.reason === "string" && raw.reason.trim()
    ? raw.reason
    : typeof raw.reasoning === "string" ? raw.reasoning : undefined;
  const judgment = typeof raw.judgment === "string" && raw.judgment.trim()
    ? raw.judgment
    : reason;
  const proposedChange = raw.proposedChange && typeof raw.proposedChange === "object"
    ? withActionLabel(raw.proposedChange as Record<string, unknown>, nextLabel)
    : raw.proposedChange;
  return {
    ...raw,
    judgment,
    reason: reason ?? judgment,
    nextLabel,
    proposedChange,
  };
}

/**
 * 归一化此刻建议 LLM 输出（primarySuggestion 等别名 → primary）。
 * @param value - 模型原始 JSON
 */
function normalizeMomentGeneration(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const raw = value as Record<string, unknown>;
  const primary = raw.primary ?? raw.primarySuggestion ?? raw.suggestion ?? raw.main;
  const alternates = raw.alternateCandidates ?? raw.alternates ?? raw.candidates ?? [];
  return {
    primary: normalizeMomentCard(primary),
    alternateCandidates: Array.isArray(alternates) ? alternates.map(normalizeMomentCard) : [],
  };
}

/** 首页此刻建议的可执行日程变更 */
export const homeInsightProposedChangeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("reschedule"),
    scheduleId: z.string(),
    start: insightClockSchema,
    end: insightClockSchema,
    date: insightDateSchema,
    label: insightActionLabelSchema,
  }),
  z.object({
    type: z.literal("create_schedule"),
    title: z.string().max(120),
    start: insightClockSchema,
    end: insightClockSchema,
    date: insightDateSchema,
    goalId: z.string().nullish().transform((value) => value ?? undefined),
    taskId: z.string().nullish().transform((value) => value ?? undefined),
    label: insightActionLabelSchema,
  }),
  z.object({
    type: z.literal("open_schedule_form"),
    start: insightClockSchema,
    end: insightClockSchema,
    date: insightDateSchema,
    goalId: z.string().nullish().transform((value) => value ?? undefined),
    taskId: z.string().nullish().transform((value) => value ?? undefined),
    label: insightActionLabelSchema,
  }),
  z.object({
    type: z.literal("open_execution_feedback"),
    scheduleId: z.string(),
    label: insightActionLabelSchema,
  }),
]);

/** 单条此刻建议卡片（主卡或候选） */
export const momentInsightCardSchema = z.object({
  headline: z.string().min(1).max(80),
  judgment: z.string().min(1).max(320),
  reason: z.string().min(1).max(320),
  nextLabel: z.string().min(1).max(120),
  proposedChange: homeInsightProposedChangeSchema,
});

/** LLM 生成的此刻建议包（主卡 + 候选）；先归一化别名再校验；无效候选丢弃不拖垮主卡 */
export const momentInsightGenerationSchema = z.preprocess(
  normalizeMomentGeneration,
  z.object({
    primary: momentInsightCardSchema,
    alternateCandidates: z.array(z.unknown()).max(4).default([]).transform((items) =>
      items.flatMap((item) => {
        const parsed = momentInsightCardSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
  }),
);

/** LLM 生成的慢路径洞察（节奏发现 + 本周轨道） */
export const slowInsightsGenerationSchema = z.object({
  rhythm: z.object({
    statement: z.string().min(1).max(400),
    evidence: z.string().min(1).max(400),
    impact: z.string().min(1).max(300),
    relatedSignalId: z.string().optional(),
  }),
  weekly: z.object({
    statusLabel: z.string().min(1).max(20),
    status: z.enum(["relaxed", "balanced", "full", "overload", "off_track"]),
    summary: z.string().min(1).max(400),
    suggestion: z.string().max(300).optional(),
  }),
});

export type HomeInsightProposedChange = z.infer<typeof homeInsightProposedChangeSchema>;
export type MomentInsightGeneration = z.infer<typeof momentInsightGenerationSchema>;
export type SlowInsightsGeneration = z.infer<typeof slowInsightsGenerationSchema>;
