import type { Prisma } from "@/generated/prisma/client";
import { ScheduleBlockStatus, TaskStatus } from "@/generated/prisma/enums";
import { getDb } from "@/lib/db";
import { DomainError } from "@/server/api-response";
import { ensureLocalUser } from "@/server/auth";
import { createScheduleBlockSchema, executionFeedbackSchema, updateScheduleBlockSchema } from "@/server/validation";
import { expandRoutineOccurrences } from "@/server/services/routines";

const statusMap = { planned: ScheduleBlockStatus.PLANNED, in_progress: ScheduleBlockStatus.IN_PROGRESS, completed: ScheduleBlockStatus.COMPLETED, missed: ScheduleBlockStatus.MISSED, rescheduled: ScheduleBlockStatus.RESCHEDULED, cancelled: ScheduleBlockStatus.CANCELLED } as const;

const include = {
  goal: { select: { id: true, title: true } },
  task: { select: { id: true, title: true } },
  routine: { select: { id: true, title: true } },
  linkedTasks: { include: { task: { select: { id: true, title: true } } }, orderBy: { position: "asc" as const } },
  executionRecord: { include: { rhythmFeedback: true } },
};

type ScheduleWriteInput = {
  goalId?: string;
  taskId?: string;
  taskIds?: string[];
  routineId?: string;
  title?: string;
  startsAt?: string;
  endsAt?: string;
  flexibility?: "fixed" | "flexible";
  status?: keyof typeof statusMap;
  changeReason?: string;
  expectedVersion?: number;
  moveInPlace?: boolean;
};

/**
 * 从请求体解析关联任务 ID 列表，taskIds 优先，否则回退到单个 taskId。
 * @param input - 日程创建/更新请求体
 */
function resolveTaskIds(input: { taskId?: string | null; taskIds?: string[] }) {
  const ids = input.taskIds?.length ? [...new Set(input.taskIds)] : input.taskId ? [input.taskId] : [];
  return { taskIds: ids, primaryTaskId: ids[0] ?? null };
}

/**
 * 同步日程块与任务的关联表，并更新主 taskId 字段以保持兼容。
 * @param tx - Prisma 事务客户端
 * @param scheduleBlockId - 日程块 ID
 * @param taskIds - 要关联的任务 ID 列表
 */
async function syncLinkedTasks(tx: Prisma.TransactionClient, scheduleBlockId: string, taskIds: string[]) {
  await tx.scheduleBlockTask.deleteMany({ where: { scheduleBlockId } });
  if (taskIds.length) {
    await tx.scheduleBlockTask.createMany({
      data: taskIds.map((taskId, position) => ({ scheduleBlockId, taskId, position })),
    });
  }
  await tx.scheduleBlock.update({
    where: { id: scheduleBlockId },
    data: { taskId: taskIds[0] ?? null },
  });
}

/**
 * 读取日程块当前关联的全部任务 ID。
 * @param tx - Prisma 事务客户端
 * @param scheduleBlockId - 日程块 ID
 */
async function getLinkedTaskIds(tx: Prisma.TransactionClient, scheduleBlockId: string) {
  const links = await tx.scheduleBlockTask.findMany({
    where: { scheduleBlockId },
    orderBy: { position: "asc" },
    select: { taskId: true },
  });
  return links.map((link) => link.taskId);
}

/**
 * 对日程块关联的全部任务重新聚合状态。
 * @param tx - Prisma 事务客户端
 * @param scheduleBlockId - 日程块 ID
 * @param fallbackTaskId - 兼容旧数据时的主任务 ID
 */
export async function aggregateLinkedTaskStatuses(tx: Prisma.TransactionClient, scheduleBlockId: string, fallbackTaskId?: string | null) {
  const linkedIds = await getLinkedTaskIds(tx, scheduleBlockId);
  const taskIds = [...new Set([...(fallbackTaskId ? [fallbackTaskId] : []), ...linkedIds])];
  for (const taskId of taskIds) await aggregateTaskStatus(tx, taskId);
}

/**
 * 列出指定时间窗口内的日程块。
 * @param userId - 用户 ID
 * @param from - 窗口开始时间（UTC）
 * @param to - 窗口结束时间（UTC）
 */
export async function listScheduleBlocks(userId: string, from: Date, to: Date) {
  await ensureLocalUser();
  const [blocks, occurrences] = await Promise.all([
    getDb().scheduleBlock.findMany({ where: { userId, deletedAt: null, startsAt: { lt: to }, endsAt: { gt: from }, NOT: { source: "routine" } }, include, orderBy: { startsAt: "asc" } }),
    expandRoutineOccurrences(userId, from, to),
  ]);
  return [...blocks.map(serializeBlock), ...occurrences].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/**
 * 手动创建日程块，若绑定 Task 则同步将 Task 状态改为 SCHEDULED。
 * @param userId - 用户 ID
 * @param raw - 未校验的请求体
 */
export async function createScheduleBlock(userId: string, raw: unknown) {
  await ensureLocalUser();
  const input = createScheduleBlockSchema.parse(raw);
  const { taskIds, primaryTaskId } = resolveTaskIds(input);
  await assertRelations(userId, input.goalId ?? undefined, primaryTaskId ?? undefined, input.routineId ?? undefined, taskIds);
  const block = await getDb().$transaction(async (tx) => {
    const blockInput = { ...input };
    delete blockInput.taskIds;
    const created = await tx.scheduleBlock.create({
      data: {
        userId,
        ...blockInput,
        taskId: primaryTaskId,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        source: "manual",
      },
      include,
    });
    await syncLinkedTasks(tx, created.id, taskIds);
    for (const taskId of taskIds) await aggregateTaskStatus(tx, taskId);
    return tx.scheduleBlock.findFirstOrThrow({ where: { id: created.id }, include });
  });
  return serializeBlock(block);
}

/**
 * 更新日程块。如果时间发生变化则走统一改期路径（保留原块为 RESCHEDULED，
 * 新建后继块并引用原块 ID）；否则原地更新属性。
 * @param userId - 用户 ID
 * @param id - 日程块 ID
 * @param raw - 未校验的请求体（须包含 expectedVersion）
 */
export async function updateScheduleBlock(userId: string, id: string, raw: unknown) {
  const input = updateScheduleBlockSchema.parse(raw) as ScheduleWriteInput;
  const resolved = input.taskIds !== undefined || input.taskId !== undefined ? resolveTaskIds(input) : null;
  await assertRelations(userId, input.goalId ?? undefined, resolved?.primaryTaskId ?? input.taskId ?? undefined, input.routineId ?? undefined, resolved?.taskIds);
  const current = await getDb().scheduleBlock.findFirst({ where: { id, userId, version: input.expectedVersion, deletedAt: null } });
  if (!current) throw new DomainError("VERSION_CONFLICT", "日程已经发生变化，请刷新后再保存。", 409);
  const moved = (input.startsAt && new Date(input.startsAt).getTime() !== current.startsAt.getTime()) || (input.endsAt && new Date(input.endsAt).getTime() !== current.endsAt.getTime());
  if (moved && input.moveInPlace) {
    await getDb().$transaction(async (tx) => {
      await tx.scheduleBlock.update({ where: { id }, data: {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.goalId !== undefined && { goalId: input.goalId }),
        ...(resolved && { taskId: resolved.primaryTaskId }),
        ...(input.routineId !== undefined && { routineId: input.routineId }),
        startsAt: input.startsAt ? new Date(input.startsAt) : current.startsAt,
        endsAt: input.endsAt ? new Date(input.endsAt) : current.endsAt,
        ...(input.changeReason !== undefined && { changeReason: input.changeReason }),
        version: { increment: 1 },
      } });
      if (resolved) await syncLinkedTasks(tx, id, resolved.taskIds);
      await aggregateLinkedTaskStatuses(tx, id, resolved?.primaryTaskId ?? current.taskId);
    });
    return getBlock(userId, id);
  }
  if (moved) {
    const next = await getDb().$transaction(async (tx) => {
      const created = await rescheduleScheduleBlockTx(tx, current, {
        title: input.title,
        goalId: input.goalId,
        taskId: resolved?.primaryTaskId ?? input.taskId,
        taskIds: resolved?.taskIds,
        routineId: input.routineId,
        startsAt: input.startsAt ? new Date(input.startsAt) : current.startsAt,
        endsAt: input.endsAt ? new Date(input.endsAt) : current.endsAt,
        changeReason: input.changeReason || "手动移动日程",
        source: "rescheduled",
      });
      await aggregateLinkedTaskStatuses(tx, created.id, created.taskId);
      return created;
    });
    return serializeBlock(next);
  }
  await getDb().$transaction(async (tx) => {
    await tx.scheduleBlock.update({ where: { id }, data: {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.goalId !== undefined && { goalId: input.goalId }),
      ...(resolved && { taskId: resolved.primaryTaskId }),
      ...(input.routineId !== undefined && { routineId: input.routineId }),
      ...(input.flexibility !== undefined && { flexibility: input.flexibility }),
      ...(input.status !== undefined && { status: statusMap[input.status] }),
      ...(input.changeReason !== undefined && { changeReason: input.changeReason }),
      version: { increment: 1 },
    } });
    if (resolved) await syncLinkedTasks(tx, id, resolved.taskIds);
    await aggregateLinkedTaskStatuses(tx, id, resolved?.primaryTaskId ?? current.taskId);
  });
  return getBlock(userId, id);
}

/**
 * 取消日程块：原块保留为 CANCELLED 且在历史/回顾中可见，不设 deletedAt。
 * 适用于已有执行历史的日程。
 * @param userId - 用户 ID
 * @param id - 日程块 ID
 * @param expectedVersion - 乐观锁版本号
 * @param changeReason - 可选取消原因
 */
export async function cancelScheduleBlock(userId: string, id: string, expectedVersion: number, changeReason?: string) {
  await getDb().$transaction(async (tx) => {
    const result = await tx.scheduleBlock.updateMany({ where: { id, userId, version: expectedVersion, deletedAt: null }, data: { status: ScheduleBlockStatus.CANCELLED, changeReason: changeReason ?? "用户取消", version: { increment: 1 } } });
    if (!result.count) throw new DomainError("VERSION_CONFLICT", "日程已经发生变化，请刷新后再取消。", 409);
    await aggregateLinkedTaskStatuses(tx, id);
  });
}

/**
 * 软删除日程块：仅限无执行历史的草稿日程（设 deletedAt + CANCELLED）。
 * 已有执行记录的日程请使用 cancelScheduleBlock。
 * @param userId - 用户 ID
 * @param id - 日程块 ID
 * @param expectedVersion - 乐观锁版本号
 */
export async function deleteScheduleBlock(userId: string, id: string, expectedVersion: number) {
  const block = await getDb().scheduleBlock.findFirst({ where: { id, userId, version: expectedVersion, deletedAt: null }, select: { taskId: true, executionRecord: { select: { id: true } } } });
  if (!block) throw new DomainError("VERSION_CONFLICT", "日程已经发生变化，请刷新后再删除。", 409);
  if (block.executionRecord) throw new DomainError("HAS_EXECUTION_HISTORY", "该日程已有执行记录，请使用取消而非删除。", 409);
  await getDb().$transaction(async (tx) => {
    await tx.scheduleBlock.update({ where: { id }, data: { deletedAt: new Date(), status: ScheduleBlockStatus.CANCELLED, version: { increment: 1 } } });
    await aggregateLinkedTaskStatuses(tx, id, block.taskId);
  });
}

/**
 * 记录执行反馈。若结果为 rescheduled，使用统一改期路径（保留原块，新建后继块）；
 * 完成则联动所有关联任务的状态聚合。
 * @param userId - 用户 ID
 * @param scheduleBlockId - 日程块 ID
 * @param raw - 未校验的执行反馈体
 */
export async function upsertExecutionFeedback(userId: string, scheduleBlockId: string, raw: unknown) {
  const input = executionFeedbackSchema.parse(raw);
  const block = await getDb().scheduleBlock.findFirst({ where: { id: scheduleBlockId, userId, deletedAt: null }, select: { id: true, userId: true, taskId: true, version: true, title: true, goalId: true, routineId: true, endsAt: true, startsAt: true, flexibility: true } });
  if (!block) throw new DomainError("SCHEDULE_BLOCK_NOT_FOUND", "没有找到这个日程块。", 404);

  const status = input.result === "completed" ? ScheduleBlockStatus.COMPLETED : input.result === "rescheduled" ? ScheduleBlockStatus.RESCHEDULED : ScheduleBlockStatus.MISSED;

  await getDb().$transaction(async (tx) => {
    const record = await tx.executionRecord.upsert({
      where: { scheduleBlockId },
      create: { scheduleBlockId, result: input.result, actualMinutes: input.actualMinutes, deviationReason: input.deviationReason, actualStartedAt: input.actualStartedAt ? new Date(input.actualStartedAt) : undefined, actualEndedAt: input.actualEndedAt ? new Date(input.actualEndedAt) : undefined, quality: input.quality, obstacle: input.obstacle, nextAction: input.nextAction },
      update: { result: input.result, actualMinutes: input.actualMinutes, deviationReason: input.deviationReason, actualStartedAt: input.actualStartedAt ? new Date(input.actualStartedAt) : undefined, actualEndedAt: input.actualEndedAt ? new Date(input.actualEndedAt) : undefined, quality: input.quality, obstacle: input.obstacle, nextAction: input.nextAction },
    });
    await tx.rhythmFeedback.upsert({
      where: { executionRecordId: record.id },
      create: { executionRecordId: record.id, tags: input.tags, note: input.note, comfortable: input.comfortable, timeFit: input.timeFit },
      update: { tags: input.tags, note: input.note, comfortable: input.comfortable, timeFit: input.timeFit },
    });
    await tx.scheduleBlock.update({ where: { id: scheduleBlockId }, data: { status, version: { increment: 1 } } });

    if (input.result === "rescheduled") {
      const duration = block.endsAt.getTime() - block.startsAt.getTime();
      const nextDay = new Date(block.startsAt.getTime() + 86400000);
      await rescheduleScheduleBlockTx(tx, block, {
        startsAt: nextDay,
        endsAt: new Date(nextDay.getTime() + duration),
        changeReason: input.deviationReason ?? "执行反馈标记改期",
        source: "rescheduled",
      });
    }

    await aggregateLinkedTaskStatuses(tx, scheduleBlockId, block.taskId);
  });
  return getBlock(userId, scheduleBlockId);
}

/**
 * 统一改期事务逻辑：将原块状态设为 RESCHEDULED，新建后继块并引用 rescheduledFromId。
 * 被手动改期、ChangeSet 改期、执行反馈改期共用，保证行为一致。
 * @param tx - Prisma 事务客户端
 * @param current - 原日程块（包含 id, userId, title, goalId, taskId, routineId, flexibility）
 * @param next - 新日程块的时间与属性
 */
export async function rescheduleScheduleBlockTx(
  tx: Prisma.TransactionClient,
  current: { id: string; userId: string; title: string; goalId: string | null; taskId: string | null; routineId: string | null; flexibility?: string | null },
  next: { startsAt: Date; endsAt: Date; changeReason: string; source?: string; title?: string; goalId?: string | null; taskId?: string | null; taskIds?: string[]; routineId?: string | null },
) {
  const existingTaskIds = next.taskIds ?? await getLinkedTaskIds(tx, current.id);
  const fallbackTaskIds = existingTaskIds.length ? existingTaskIds : current.taskId ? [current.taskId] : [];
  const primaryTaskId = next.taskId !== undefined ? next.taskId : fallbackTaskIds[0] ?? null;

  await tx.scheduleBlock.update({ where: { id: current.id }, data: { status: ScheduleBlockStatus.RESCHEDULED, changeReason: next.changeReason, version: { increment: 1 } } });
  const created = await tx.scheduleBlock.create({
    data: {
      userId: current.userId,
      title: next.title ?? current.title,
      goalId: next.goalId !== undefined ? next.goalId : current.goalId,
      taskId: primaryTaskId,
      routineId: next.routineId !== undefined ? next.routineId : current.routineId,
      startsAt: next.startsAt,
      endsAt: next.endsAt,
      flexibility: current.flexibility ?? "flexible",
      source: next.source ?? "rescheduled",
      rescheduledFromId: current.id,
      changeReason: next.changeReason,
    },
    include,
  });
  await syncLinkedTasks(tx, created.id, fallbackTaskIds);
  return tx.scheduleBlock.findFirstOrThrow({ where: { id: created.id }, include });
}

/**
 * 根据 Task 关联的所有有效日程块状态，聚合计算 Task 状态。
 * 规则：存在 COMPLETED 块 → COMPLETED；存在 PLANNED/IN_PROGRESS 块 → SCHEDULED；
 * 否则全为 MISSED/RESCHEDULED → BLOCKED；无任何块 → READY（回退）。
 * @param tx - Prisma 事务客户端
 * @param taskId - 任务 ID
 */
export async function aggregateTaskStatus(tx: Prisma.TransactionClient, taskId: string) {
  const blocks = await tx.scheduleBlock.findMany({
    where: {
      deletedAt: null,
      OR: [{ taskId }, { linkedTasks: { some: { taskId } } }],
    },
    select: { status: true },
  });
  const statuses = blocks.map((b) => b.status);
  if (!statuses.length) {
    await tx.task.update({ where: { id: taskId }, data: { status: TaskStatus.READY, version: { increment: 1 } } });
    return;
  }
  let next: TaskStatus;
  if (statuses.includes(ScheduleBlockStatus.COMPLETED)) {
    next = TaskStatus.COMPLETED;
  } else if (statuses.some((s) => s === ScheduleBlockStatus.PLANNED || s === ScheduleBlockStatus.IN_PROGRESS)) {
    next = TaskStatus.SCHEDULED;
  } else if (statuses.every((s) => s === ScheduleBlockStatus.MISSED || s === ScheduleBlockStatus.RESCHEDULED)) {
    next = TaskStatus.BLOCKED;
  } else {
    next = TaskStatus.READY;
  }
  await tx.task.update({ where: { id: taskId }, data: { status: next, completedAt: next === TaskStatus.COMPLETED ? new Date() : null, version: { increment: 1 } } });
}

async function getBlock(userId: string, id: string) {
  const block = await getDb().scheduleBlock.findFirst({ where: { id, userId, deletedAt: null }, include });
  if (!block) throw new DomainError("SCHEDULE_BLOCK_NOT_FOUND", "没有找到这个日程块。", 404);
  return serializeBlock(block);
}

/**
 * 校验日程块关联的目标、任务与 Routine 是否有效。
 * @param userId - 用户 ID
 * @param goalId - 可选目标 ID
 * @param taskId - 可选主任务 ID
 * @param routineId - 可选 Routine ID
 * @param taskIds - 可选关联任务 ID 列表
 */
async function assertRelations(userId: string, goalId?: string | null, taskId?: string | null, routineId?: string | null, taskIds?: string[]) {
  if (goalId && !(await getDb().goal.findFirst({ where: { id: goalId, userId, archivedAt: null }, select: { id: true } }))) throw new DomainError("INVALID_GOAL", "关联目标不存在。", 400);
  const idsToCheck = taskIds?.length ? taskIds : taskId ? [taskId] : [];
  for (const linkedTaskId of idsToCheck) {
    if (!(await getDb().task.findFirst({ where: { id: linkedTaskId, goal: { userId }, archivedAt: null }, select: { id: true } }))) throw new DomainError("INVALID_TASK", "关联任务不存在。", 400);
  }
  if (routineId && !(await getDb().routine.findFirst({ where: { id: routineId, goal: { userId }, archivedAt: null }, select: { id: true } }))) throw new DomainError("INVALID_ROUTINE", "关联 Routine 不存在。", 400);
}

type SerializedBlockSource = {
  status: string;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  taskId: string | null;
  linkedTasks?: Array<{ taskId: string; task?: { id: string; title: string } | null }>;
};

/**
 * 将数据库日程块序列化为 API 响应，附带 taskIds 数组。
 * @param block - 含关联任务信息的日程块
 */
function serializeBlock<T extends SerializedBlockSource>(block: T) {
  const linkedIds = block.linkedTasks?.map((link) => link.taskId) ?? [];
  const taskIds = linkedIds.length ? linkedIds : block.taskId ? [block.taskId] : [];
  return {
    ...block,
    taskIds,
    status: block.status.toLowerCase(),
    startsAt: block.startsAt.toISOString(),
    endsAt: block.endsAt.toISOString(),
    createdAt: block.createdAt.toISOString(),
    updatedAt: block.updatedAt.toISOString(),
    deletedAt: block.deletedAt?.toISOString() ?? null,
  };
}
