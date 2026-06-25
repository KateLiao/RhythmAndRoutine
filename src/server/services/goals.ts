import { GoalStatus, MilestoneStatus, RoutineStatus, ScheduleBlockStatus, TaskStatus } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";
import { DomainError } from "@/server/api-response";
import { ensureLocalUser } from "@/server/auth";
import { createGoalSchema, createMilestoneSchema, createOutcomeSchema, createRoutineSchema, createTaskSchema, updateGoalSchema, updateMilestoneSchema, updateOutcomeSchema, updateRoutineSchema, updateTaskSchema } from "@/server/validation";

const goalStatusMap = { draft: GoalStatus.DRAFT, active: GoalStatus.ACTIVE, paused: GoalStatus.PAUSED, completed: GoalStatus.COMPLETED, archived: GoalStatus.ARCHIVED } as const;
const taskStatusMap = { draft: TaskStatus.DRAFT, ready: TaskStatus.READY, scheduled: TaskStatus.SCHEDULED, in_progress: TaskStatus.IN_PROGRESS, completed: TaskStatus.COMPLETED, blocked: TaskStatus.BLOCKED, cancelled: TaskStatus.CANCELLED, archived: TaskStatus.ARCHIVED } as const;
const routineStatusMap = { draft: RoutineStatus.DRAFT, active: RoutineStatus.ACTIVE, paused: RoutineStatus.PAUSED, completed: RoutineStatus.COMPLETED, archived: RoutineStatus.ARCHIVED } as const;
const milestoneStatusMap = { pending: MilestoneStatus.PENDING, ready_for_review: MilestoneStatus.READY_FOR_REVIEW, completed: MilestoneStatus.COMPLETED, rejected: MilestoneStatus.REJECTED, archived: MilestoneStatus.ARCHIVED } as const;

const goalInclude = {
  outcomes: { where: { archivedAt: null } },
  milestones: { orderBy: { position: "asc" as const } },
  tasks: { where: { archivedAt: null }, orderBy: { position: "asc" as const } },
  routines: { where: { archivedAt: null }, include: { executionRecords: { orderBy: { occurrenceDate: "desc" as const }, take: 60 } } },
  _count: { select: { scheduleBlocks: true } },
};

export async function listGoals(userId: string) {
  await ensureLocalUser();
  const goals = await getDb().goal.findMany({ where: { userId, archivedAt: null }, include: goalInclude, orderBy: { updatedAt: "desc" } });
  return goals.map(serializeGoal);
}

export async function getGoal(userId: string, id: string) {
  const goal = await getDb().goal.findFirst({ where: { id, userId, archivedAt: null }, include: goalInclude });
  if (!goal) throw new DomainError("GOAL_NOT_FOUND", "没有找到这个目标。", 404);
  return serializeGoal(goal);
}

export async function createGoal(userId: string, raw: unknown) {
  await ensureLocalUser();
  const input = createGoalSchema.parse(raw);
  const goal = await getDb().goal.create({
    data: { userId, title: input.title, description: input.description, category: input.category, project: input.project, skill: input.skill, targetDate: input.targetDate ? new Date(input.targetDate) : null, status: GoalStatus.DRAFT },
    include: goalInclude,
  });
  return serializeGoal(goal);
}

export async function updateGoal(userId: string, id: string, raw: unknown) {
  const input = updateGoalSchema.parse(raw);
  const result = await getDb().goal.updateMany({
    where: { id, userId, version: input.expectedVersion, archivedAt: null },
    data: {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.category !== undefined && { category: input.category }),
      ...(input.project !== undefined && { project: input.project }), ...(input.skill !== undefined && { skill: input.skill }),
      ...(input.targetDate !== undefined && { targetDate: input.targetDate ? new Date(input.targetDate) : null }),
      ...(input.status !== undefined && { status: goalStatusMap[input.status] }),
      version: { increment: 1 },
    },
  });
  if (!result.count) throw new DomainError("VERSION_CONFLICT", "目标已经发生变化，请刷新后再保存。", 409);
  return getGoal(userId, id);
}

export async function archiveGoal(userId: string, id: string, expectedVersion: number) {
  const result = await getDb().goal.updateMany({
    where: { id, userId, version: expectedVersion, archivedAt: null },
    data: { status: GoalStatus.ARCHIVED, archivedAt: new Date(), version: { increment: 1 } },
  });
  if (!result.count) throw new DomainError("VERSION_CONFLICT", "目标已经发生变化，请刷新后再归档。", 409);
}

export async function createOutcome(userId: string, goalId: string, raw: unknown) {
  await assertGoalOwner(userId, goalId);
  const input = createOutcomeSchema.parse(raw);
  return getDb().outcome.create({ data: { goalId, description: input.description } });
}

export async function updateOutcome(userId: string, outcomeId: string, raw: unknown) {
  const input = updateOutcomeSchema.parse(raw);
  const result = await getDb().outcome.updateMany({
    where: { id: outcomeId, version: input.expectedVersion, goal: { userId, archivedAt: null } },
    data: { ...(input.description !== undefined && { description: input.description }), ...(input.completed !== undefined && { completedAt: input.completed ? new Date() : null }), version: { increment: 1 } },
  });
  if (!result.count) throw new DomainError("VERSION_CONFLICT", "结果指标已经发生变化，请刷新后再保存。", 409);
  const outcome = await getDb().outcome.findFirst({ where: { id: outcomeId, goal: { userId } } });
  if (!outcome) throw new DomainError("OUTCOME_NOT_FOUND", "没有找到这个结果指标。", 404);
  return outcome;
}

export async function deleteOutcome(userId: string, outcomeId: string, expectedVersion: number) {
  const result = await getDb().outcome.updateMany({ where: { id: outcomeId, version: expectedVersion, archivedAt: null, goal: { userId, archivedAt: null } }, data: { archivedAt: new Date(), version: { increment: 1 } } });
  if (!result.count) throw new DomainError("VERSION_CONFLICT", "结果指标已经发生变化，请刷新后再归档。", 409);
}

export async function createMilestone(userId: string, goalId: string, raw: unknown) {
  await assertGoalOwner(userId, goalId);
  const input = createMilestoneSchema.parse(raw);
  const last = await getDb().milestone.aggregate({ where: { goalId }, _max: { position: true } });
  return getDb().milestone.create({ data: { goalId, ...input, position: (last._max.position ?? -1) + 1 } });
}

export async function updateMilestone(userId: string, milestoneId: string, raw: unknown) {
  const input = updateMilestoneSchema.parse(raw);
  const result = await getDb().milestone.updateMany({
    where: { id: milestoneId, version: input.expectedVersion, goal: { userId, archivedAt: null } },
    data: { ...(input.title !== undefined && { title: input.title }), ...(input.description !== undefined && { description: input.description }), ...(input.status !== undefined && { status: milestoneStatusMap[input.status], completedAt: input.status === "completed" ? new Date() : null }), version: { increment: 1 } },
  });
  if (!result.count) throw new DomainError("VERSION_CONFLICT", "里程碑已经发生变化，请刷新后再保存。", 409);
  const milestone = await getDb().milestone.findFirst({ where: { id: milestoneId, goal: { userId } } });
  if (!milestone) throw new DomainError("MILESTONE_NOT_FOUND", "没有找到这个里程碑。", 404);
  return milestone;
}

export async function archiveMilestone(userId: string, milestoneId: string, expectedVersion: number) {
  const result = await getDb().milestone.updateMany({ where: { id: milestoneId, version: expectedVersion, goal: { userId, archivedAt: null } }, data: { status: MilestoneStatus.ARCHIVED, version: { increment: 1 } } });
  if (!result.count) throw new DomainError("VERSION_CONFLICT", "里程碑已经发生变化，请刷新后再归档。", 409);
}

export async function createTask(userId: string, goalId: string, raw: unknown) {
  await assertGoalOwner(userId, goalId);
  const input = createTaskSchema.parse(raw);
  const task = await getDb().task.create({ data: { goalId, ...input, completionCriteria: input.completionCriteria, suggestedSteps: input.suggestedSteps, rhythmConditions: input.rhythmConditions, status: TaskStatus.READY } });
  return serializeTask(task);
}

export async function updateTask(userId: string, taskId: string, raw: unknown) {
  const input = updateTaskSchema.parse(raw);
  const result = await getDb().task.updateMany({
    where: { id: taskId, version: input.expectedVersion, archivedAt: null, goal: { userId } },
    data: {
      ...(input.title !== undefined && { title: input.title }), ...(input.intent !== undefined && { intent: input.intent }),
      ...(input.completionCriteria !== undefined && { completionCriteria: input.completionCriteria }), ...(input.suggestedSteps !== undefined && { suggestedSteps: input.suggestedSteps }),
      ...(input.estimatedMinutes !== undefined && { estimatedMinutes: input.estimatedMinutes }), ...(input.energyLevel !== undefined && { energyLevel: input.energyLevel }),
      ...(input.focusLevel !== undefined && { focusLevel: input.focusLevel }),
      ...(input.status !== undefined && {
        status: taskStatusMap[input.status],
        completedAt: input.status === "completed" ? new Date() : ["ready", "draft", "scheduled", "in_progress", "blocked"].includes(input.status) ? null : undefined,
      }),
      ...(input.rhythmConditions !== undefined && { rhythmConditions: input.rhythmConditions }), ...(input.milestoneId !== undefined && { milestoneId: input.milestoneId }), ...(input.parentTaskId !== undefined && { parentTaskId: input.parentTaskId }),
      version: { increment: 1 },
    },
  });
  if (!result.count) throw new DomainError("VERSION_CONFLICT", "任务已经发生变化，请刷新后再保存。", 409);
  const task = await getDb().task.findFirst({ where: { id: taskId, goal: { userId } } });
  if (!task) throw new DomainError("TASK_NOT_FOUND", "没有找到这个任务。", 404);
  return serializeTask(task);
}

export async function archiveTask(userId: string, taskId: string, expectedVersion: number) {
  const result = await getDb().task.updateMany({ where: { id: taskId, version: expectedVersion, archivedAt: null, goal: { userId } }, data: { status: TaskStatus.ARCHIVED, archivedAt: new Date(), version: { increment: 1 } } });
  if (!result.count) throw new DomainError("VERSION_CONFLICT", "任务已经发生变化，请刷新后再归档。", 409);
}

export async function createRoutine(userId: string, goalId: string, raw: unknown) {
  await assertGoalOwner(userId, goalId);
  const input = createRoutineSchema.parse(raw);
  const routine = await getDb().routine.create({ data: { ...input, goalId, startDate: new Date(input.startDate), endDate: input.endDate ? new Date(input.endDate) : null, status: RoutineStatus.ACTIVE } });
  return serializeRoutine(routine);
}

export async function updateRoutine(userId: string, routineId: string, raw: unknown) {
  const input = updateRoutineSchema.parse(raw);
  const result = await getDb().$transaction(async (tx) => {
    const current = await tx.routine.findFirst({
      where: { id: routineId, version: input.expectedVersion, archivedAt: null, goal: { userId } },
      select: { id: true, startDate: true, endDate: true, status: true },
    });
    if (!current) return null;
    const nextStatus = input.status !== undefined ? routineStatusMap[input.status] : current.status;
    const nextStartDate = input.startDate !== undefined ? new Date(input.startDate) : current.startDate;
    const nextEndDate = input.endDate !== undefined ? input.endDate ? new Date(input.endDate) : null : current.endDate;
    await tx.routine.update({
      where: { id: routineId },
      data: { ...(input.title !== undefined && { title: input.title }), ...(input.description !== undefined && { description: input.description }), ...(input.recurrenceRule !== undefined && { recurrenceRule: input.recurrenceRule }), ...(input.startDate !== undefined && { startDate: nextStartDate }), ...(input.endDate !== undefined && { endDate: nextEndDate }), ...(input.durationMinutes !== undefined && { durationMinutes: input.durationMinutes }), ...(input.preferredStartTime !== undefined && { preferredStartTime: input.preferredStartTime }), ...(input.preferredEndTime !== undefined && { preferredEndTime: input.preferredEndTime }), ...(input.preferredTimeOfDay !== undefined && { preferredTimeOfDay: input.preferredTimeOfDay }), ...(input.priority !== undefined && { priority: input.priority }), ...(input.displayMode !== undefined && { displayMode: input.displayMode }), ...(input.minimumVersion !== undefined && { minimumVersion: input.minimumVersion }), ...(input.status !== undefined && { status: nextStatus }), version: { increment: 1 } },
    });
    await pruneFutureRoutineScheduleBlocks(tx, userId, routineId, { status: nextStatus, startDate: nextStartDate, endDate: nextEndDate });
    return true;
  });
  if (!result) throw new DomainError("VERSION_CONFLICT", "Routine 已经发生变化，请刷新后再保存。", 409);
  const routine = await getDb().routine.findFirst({ where: { id: routineId, goal: { userId } } });
  if (!routine) throw new DomainError("ROUTINE_NOT_FOUND", "没有找到这个 Routine。", 404);
  return serializeRoutine(routine);
}

async function pruneFutureRoutineScheduleBlocks(tx: Prisma.TransactionClient, userId: string, routineId: string, next: { status: RoutineStatus; startDate: Date; endDate: Date | null }) {
  const baseWhere = {
    userId,
    routineId,
    deletedAt: null,
    status: ScheduleBlockStatus.PLANNED,
    startsAt: { gte: new Date() },
    executionRecord: { is: null },
  } satisfies Prisma.ScheduleBlockWhereInput;
  const data = { deletedAt: new Date(), status: ScheduleBlockStatus.CANCELLED, changeReason: "Routine 设置变更，删除未发生实例", version: { increment: 1 } } satisfies Prisma.ScheduleBlockUpdateManyMutationInput;
  if (next.status !== RoutineStatus.ACTIVE) {
    await tx.scheduleBlock.updateMany({ where: baseWhere, data });
    return;
  }
  const outsideRange: Prisma.ScheduleBlockWhereInput[] = [{ startsAt: { lt: next.startDate } }];
  if (next.endDate) outsideRange.push({ startsAt: { gt: next.endDate } });
  await tx.scheduleBlock.updateMany({ where: { ...baseWhere, OR: outsideRange }, data });
}

export async function archiveRoutine(userId: string, routineId: string, expectedVersion: number) {
  const result = await getDb().routine.updateMany({ where: { id: routineId, version: expectedVersion, archivedAt: null, goal: { userId } }, data: { status: RoutineStatus.ARCHIVED, archivedAt: new Date(), version: { increment: 1 } } });
  if (!result.count) throw new DomainError("VERSION_CONFLICT", "Routine 已经发生变化，请刷新后再归档。", 409);
}

async function assertGoalOwner(userId: string, goalId: string) {
  const goal = await getDb().goal.findFirst({ where: { id: goalId, userId, archivedAt: null }, select: { id: true } });
  if (!goal) throw new DomainError("GOAL_NOT_FOUND", "没有找到关联目标。", 404);
}

function serializeGoal(goal: Prisma.GoalGetPayload<{ include: typeof goalInclude }>) {
  return {
    ...goal, status: goal.status.toLowerCase(), targetDate: goal.targetDate?.toISOString() ?? null,
    createdAt: goal.createdAt.toISOString(), updatedAt: goal.updatedAt.toISOString(),
    outcomes: goal.outcomes.map((outcome) => ({ ...outcome, completedAt: outcome.completedAt?.toISOString() ?? null, createdAt: outcome.createdAt.toISOString(), updatedAt: outcome.updatedAt.toISOString() })),
    milestones: goal.milestones.map((milestone) => ({ ...milestone, status: milestone.status.toLowerCase(), targetDate: milestone.targetDate?.toISOString() ?? null, completedAt: milestone.completedAt?.toISOString() ?? null, createdAt: milestone.createdAt.toISOString(), updatedAt: milestone.updatedAt.toISOString() })),
    tasks: goal.tasks.map(serializeTask), routines: goal.routines.map(serializeRoutine),
  };
}

function serializeTask<T extends { status: string; createdAt: Date; updatedAt: Date; completedAt: Date | null; archivedAt: Date | null }>(task: T) {
  return { ...task, status: task.status.toLowerCase(), createdAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString(), completedAt: task.completedAt?.toISOString() ?? null, archivedAt: task.archivedAt?.toISOString() ?? null };
}

function serializeRoutine<T extends { status: string; startDate: Date; endDate: Date | null; createdAt: Date; updatedAt: Date; archivedAt: Date | null; executionRecords?: Array<{ occurrenceDate: Date; plannedStartAt: Date | null; plannedEndAt: Date | null; rescheduledStartAt: Date | null; rescheduledEndAt: Date | null; createdAt: Date; updatedAt: Date }> }>(routine: T) {
  return { ...routine, status: routine.status.toLowerCase(), startDate: routine.startDate.toISOString(), endDate: routine.endDate?.toISOString() ?? null, createdAt: routine.createdAt.toISOString(), updatedAt: routine.updatedAt.toISOString(), archivedAt: routine.archivedAt?.toISOString() ?? null, executionRecords: routine.executionRecords?.map((record) => ({ ...record, occurrenceDate: record.occurrenceDate.toISOString(), plannedStartAt: record.plannedStartAt?.toISOString() ?? null, plannedEndAt: record.plannedEndAt?.toISOString() ?? null, rescheduledStartAt: record.rescheduledStartAt?.toISOString() ?? null, rescheduledEndAt: record.rescheduledEndAt?.toISOString() ?? null, createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString() })) };
}
