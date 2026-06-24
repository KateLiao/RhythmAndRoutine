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
 * @field summary - 本周期总结（1-3 句）
 * @field findings - 从数据中提取的事实性发现列表
 * @field suggestions - 下一周期的可操作建议列表
 * @field source - 标记内容来源（ai 或 rules）
 */
export const reviewResultSchema = z.object({
  summary: z.string().min(1).max(600),
  findings: z.array(z.string().min(1).max(300)).min(1).max(8),
  suggestions: z.array(z.string().min(1).max(300)).min(1).max(6),
  source: z.enum(["ai", "rules"]).default("ai"),
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
