import { z } from "zod";

export const createGoalSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1200).default(""),
  category: z.enum(["project", "skill", "routine", "mixed"]).default("mixed"),
  project: z.string().trim().max(120).optional(),
  skill: z.string().trim().max(120).optional(),
  targetDate: z.iso.datetime().nullable().optional(),
});

export const createOutcomeSchema = z.object({ description: z.string().trim().min(1).max(600) });
export const updateOutcomeSchema = createOutcomeSchema.partial().extend({ completed: z.boolean().optional(), expectedVersion: z.number().int().positive() });
export const createMilestoneSchema = z.object({ title: z.string().trim().min(1).max(120), description: z.string().trim().max(600).optional() });
export const updateMilestoneSchema = createMilestoneSchema.partial().extend({ status: z.enum(["pending", "ready_for_review", "completed", "rejected", "archived"]).optional(), expectedVersion: z.number().int().positive() });

export const updateGoalSchema = createGoalSchema.partial().extend({
  status: z.enum(["draft", "active", "paused", "completed", "archived"]).optional(),
  expectedVersion: z.number().int().positive(),
});

export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(120),
  intent: z.string().trim().max(600).optional(),
  completionCriteria: z.array(z.string().trim().min(1)).max(8).default([]),
  suggestedSteps: z.array(z.string().trim().min(1)).max(10).default([]),
  estimatedMinutes: z.number().int().positive().max(1440).optional(),
  energyLevel: z.enum(["low", "medium", "high"]).optional(),
  focusLevel: z.enum(["low", "medium", "high"]).optional(),
  rhythmConditions: z.array(z.string().trim().min(1)).max(8).default([]),
  milestoneId: z.string().optional(),
  parentTaskId: z.string().optional(),
});

export const updateTaskSchema = createTaskSchema.partial().extend({
  status: z.enum(["draft", "ready", "scheduled", "in_progress", "completed", "blocked", "cancelled", "archived"]).optional(),
  expectedVersion: z.number().int().positive(),
});

export const createRoutineSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(600).nullable().optional(),
  recurrenceRule: z.string().trim().min(1).max(200),
  startDate: z.iso.datetime(),
  endDate: z.iso.datetime().nullable().optional(),
  durationMinutes: z.number().int().positive().max(1440).optional(),
  preferredStartTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  preferredEndTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  preferredTimeOfDay: z.enum(["morning", "afternoon", "evening", "night"]).optional(),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  displayMode: z.enum(["subtle", "normal", "hidden_from_calendar"]).default("subtle"),
  minimumVersion: z.string().trim().max(300).refine((value) => !/^时段.+有效期/.test(value), "最低可执行版本应描述状态不好时仍能完成的小动作，而不是时间或有效期。").nullable().optional(),
});

export const updateRoutineSchema = createRoutineSchema.partial().extend({
  status: z.enum(["draft", "active", "paused", "completed", "archived"]).optional(),
  expectedVersion: z.number().int().positive(),
});

export const routineExecutionSchema = z.object({
  routineId: z.string().min(1),
  occurrenceDate: z.iso.datetime(),
  plannedStartAt: z.iso.datetime().optional(),
  plannedEndAt: z.iso.datetime().optional(),
  status: z.enum(["completed", "skipped", "missed", "rescheduled"]),
  actualMinutes: z.number().int().nonnegative().max(1440).optional(),
  feedbackTags: z.array(z.enum(["smooth", "resistant", "barely_completed", "high_energy", "low_energy", "interrupted", "not_started"])).max(4).default([]),
  note: z.string().trim().max(600).optional(),
  rescheduledStartAt: z.iso.datetime().optional(),
  rescheduledEndAt: z.iso.datetime().optional(),
});

const scheduleBlockFields = z.object({
  title: z.string().trim().min(1).max(160),
  goalId: z.string().nullable().optional(),
  taskId: z.string().nullable().optional(),
  taskIds: z.array(z.string()).max(20).optional(),
  routineId: z.string().nullable().optional(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  flexibility: z.enum(["fixed", "flexible"]).default("flexible"),
});

export const createScheduleBlockSchema = scheduleBlockFields.refine((value) => new Date(value.endsAt) > new Date(value.startsAt), { message: "结束时间必须晚于开始时间。", path: ["endsAt"] });

export const updateScheduleBlockSchema = scheduleBlockFields.partial().extend({
  status: z.enum(["planned", "in_progress", "completed", "missed", "rescheduled", "cancelled"]).optional(),
  changeReason: z.string().trim().max(500).optional(),
  expectedVersion: z.number().int().positive(),
  /** 日历拖动等场景：直接更新起止时间，不创建后继日程块 */
  moveInPlace: z.boolean().optional(),
}).refine((value) => !value.startsAt || !value.endsAt || new Date(value.endsAt) > new Date(value.startsAt), { message: "结束时间必须晚于开始时间。", path: ["endsAt"] });

export const executionFeedbackSchema = z.object({
  result: z.enum(["completed", "not_completed", "rescheduled"]),
  actualMinutes: z.number().int().nonnegative().max(1440).optional(),
  deviationReason: z.string().trim().max(600).optional(),
  tags: z.array(z.enum(["smooth", "resistant", "barely_completed", "high_energy", "low_energy", "interrupted", "not_started"])).min(1).max(4),
  note: z.string().trim().max(600).optional(),
  comfortable: z.boolean().optional(),
  timeFit: z.enum(["good", "neutral", "poor"]).optional(),
  actualStartedAt: z.iso.datetime().optional(),
  actualEndedAt: z.iso.datetime().optional(),
  quality: z.string().trim().max(120).optional(),
  obstacle: z.string().trim().max(600).optional(),
  nextAction: z.string().trim().max(600).optional(),
});
