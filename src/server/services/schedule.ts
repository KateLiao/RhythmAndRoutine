import type { Prisma } from "@/generated/prisma/client";
import { ScheduleBlockStatus, TaskStatus } from "@/generated/prisma/enums";
import { getDb } from "@/lib/db";
import { DomainError } from "@/server/api-response";
import { ensureLocalUser } from "@/server/auth";
import { createScheduleBlockSchema, executionFeedbackSchema, updateScheduleBlockSchema } from "@/server/validation";
import { inferScheduleBlockKind } from "@/lib/schedule-block-kind";
import { formatClock, timeMinutesInTimezone } from "@/lib/calendar/time";
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

export type SimilarScheduleHistoryInput = {
  query?: string;
  queries?: string[];
  matchMode?: "exact" | "contains";
  goalId?: string;
  taskId?: string;
  routineId?: string;
  days: number;
  limit: number;
};

export type SimilarScheduleSample = {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  status: ScheduleBlockStatus;
};

/** 返回数值数组中位数；空数组返回 0。 */
function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/**
 * 将相似历史日程整理为 Agent 可直接参考的典型时段，而不是让模型自行统计原始时间戳。
 */
export function summarizeSimilarScheduleHistory(samples: SimilarScheduleSample[], timezone: string, limit = 12) {
  const rows = samples.slice(0, limit).map((sample) => {
    const startMinute = timeMinutesInTimezone(sample.startsAt, timezone);
    const durationMinutes = Math.max(1, Math.round((sample.endsAt.getTime() - sample.startsAt.getTime()) / 60_000));
    return { sample, startMinute, durationMinutes };
  });
  const typicalStartMinute = median(rows.map((row) => row.startMinute));
  const typicalDurationMinutes = median(rows.map((row) => row.durationMinutes));
  const buckets = new Map<number, number>();
  for (const row of rows) {
    const bucket = Math.floor(row.startMinute / 30) * 30;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  const commonWindows = [...buckets.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 3)
    .map(([startMinute, count]) => ({
      start: formatClock(startMinute),
      end: formatClock(Math.min(1439, startMinute + typicalDurationMinutes)),
      count,
    }));

  return {
    sampleCount: rows.length,
    typicalStartTime: rows.length ? formatClock(typicalStartMinute) : null,
    typicalDurationMinutes: rows.length ? typicalDurationMinutes : null,
    commonWindows,
    samples: rows.map(({ sample }) => ({
      id: sample.id,
      title: sample.title,
      startsAt: sample.startsAt.toISOString(),
      endsAt: sample.endsAt.toISOString(),
      status: sample.status.toLowerCase(),
      localStartsAt: formatLocalDateTime(sample.startsAt, timezone),
      localEndsAt: formatLocalDateTime(sample.endsAt, timezone),
    })),
  };
}

/**
 * 查询过去相似活动的安排时间，并按实体关联与标题相似度排序。
 * 仅用于“照往常/按习惯安排”的参考，不代表推荐时段一定可用。
 */
export async function readSimilarScheduleHistory(
  userId: string,
  input: SimilarScheduleHistoryInput,
  timezone: string,
  now = new Date(),
) {
  await ensureLocalUser();
  const query = input.query?.trim();
  const queries = [...new Set([...(input.queries ?? []), ...(query ? [query] : [])].map((value) => value.trim()).filter(Boolean))];
  const similarity: Prisma.ScheduleBlockWhereInput[] = [];
  if (input.taskId) similarity.push({ taskId: input.taskId });
  if (input.routineId) similarity.push({ routineId: input.routineId });
  if (input.goalId) similarity.push({ goalId: input.goalId });
  for (const candidateQuery of queries) similarity.push({ title: { contains: candidateQuery, mode: "insensitive" } });
  if (!similarity.length) return summarizeSimilarScheduleHistory([], timezone, input.limit);

  const candidates = await getDb().scheduleBlock.findMany({
    where: {
      userId,
      deletedAt: null,
      startsAt: { gte: new Date(now.getTime() - input.days * 86_400_000), lt: now },
      // “习惯”必须来自真实完成记录；PLANNED 只能说明曾计划，不能证明用户通常这样执行。
      status: ScheduleBlockStatus.COMPLETED,
      OR: similarity,
    },
    select: { id: true, title: true, startsAt: true, endsAt: true, status: true, goalId: true, taskId: true, routineId: true },
    orderBy: { startsAt: "desc" },
    take: 80,
  });

  const normalizedQueries = queries.map(normalizeActivityTitle);
  const ranked = candidates
    .map((block) => {
      const normalizedTitle = normalizeActivityTitle(block.title);
      let score = 0;
      if (input.routineId && block.routineId === input.routineId) score += 8;
      if (input.taskId && block.taskId === input.taskId) score += 6;
      const exactMatch = normalizedQueries.some((candidateQuery) => normalizedTitle === candidateQuery);
      const containsMatch = normalizedQueries.some((candidateQuery) => normalizedTitle.includes(candidateQuery) || candidateQuery.includes(normalizedTitle));
      if (exactMatch) score += 10;
      else if (input.matchMode !== "exact" && containsMatch) score += 4;
      if (input.goalId && block.goalId === input.goalId) score += 1;
      return { block, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.block.startsAt.getTime() - a.block.startsAt.getTime())
    .slice(0, input.limit)
    .map(({ block }) => block);

  return summarizeSimilarScheduleHistory(ranked, timezone, input.limit);
}

function normalizeActivityTitle(value: string) {
  return value.toLocaleLowerCase().replace(/[\s·•:：,，。.!！?？()（）《》“”"'_-]+/g, "");
}

function formatLocalDateTime(value: Date, timezone: string) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value).replace(" ", "T");
}

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

/** Routine 动态展开允许的最大跨度（与 expandRoutineOccurrences 一致）。 */
const MAX_ROUTINE_EXPAND_MS = 93 * 86400000;

/**
 * 当 bootstrap 窗口超过 Routine 展开上限时，截取靠近窗口末尾的 93 天用于展开。
 * 物理日程块仍按完整 from/to 查询，避免历史投入漏算。
 * @param from - 完整查询窗口起点
 * @param to - 完整查询窗口终点
 */
export function clampRoutineExpandWindow(from: Date, to: Date): { from: Date; to: Date } {
  if (to.getTime() - from.getTime() <= MAX_ROUTINE_EXPAND_MS) return { from, to };
  return { from: new Date(to.getTime() - MAX_ROUTINE_EXPAND_MS), to };
}

/**
 * 列出指定时间窗口内的日程块。
 * @param userId - 用户 ID
 * @param from - 窗口开始时间（UTC）
 * @param to - 窗口结束时间（UTC）
 */
export async function listScheduleBlocks(userId: string, from: Date, to: Date) {
  await ensureLocalUser();
  const routineWindow = clampRoutineExpandWindow(from, to);
  const [blocks, occurrences] = await Promise.all([
    getDb().scheduleBlock.findMany({ where: { userId, deletedAt: null, startsAt: { lt: to }, endsAt: { gt: from }, NOT: { source: "routine" } }, include, orderBy: { startsAt: "asc" } }),
    expandRoutineOccurrences(userId, routineWindow.from, routineWindow.to),
  ]);
  return [...blocks.map(serializeBlock), ...occurrences].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/**
 * 当请求未带 goalId 但关联了任务时，从主任务回填目标 ID，避免目标投入漏计。
 * @param tx - Prisma 客户端或事务
 * @param goalId - 请求中的目标 ID
 * @param primaryTaskId - 主任务 ID
 */
async function resolveGoalIdForTasks(
  tx: Prisma.TransactionClient | ReturnType<typeof getDb>,
  goalId: string | null | undefined,
  primaryTaskId: string | null,
) {
  if (goalId) return goalId;
  if (!primaryTaskId) return goalId ?? null;
  const task = await tx.task.findFirst({ where: { id: primaryTaskId, archivedAt: null }, select: { goalId: true } });
  return task?.goalId ?? null;
}

/**
 * 手动创建日程块，若绑定 Task 则同步将 Task 状态改为 SCHEDULED。
 * 未显式传入 goalId 时，会从主任务回填目标，避免目标投入漏计。
 * @param userId - 用户 ID
 * @param raw - 未校验的请求体
 */
export async function createScheduleBlock(userId: string, raw: unknown) {
  await ensureLocalUser();
  const input = createScheduleBlockSchema.parse(raw);
  const { taskIds, primaryTaskId } = resolveTaskIds(input);
  const goalId = await resolveGoalIdForTasks(getDb(), input.goalId, primaryTaskId);
  await assertRelations(userId, goalId ?? undefined, primaryTaskId ?? undefined, input.routineId ?? undefined, taskIds);
  const block = await getDb().$transaction(async (tx) => {
    const blockInput = { ...input };
    delete blockInput.taskIds;
    const created = await tx.scheduleBlock.create({
      data: {
        userId,
        ...blockInput,
        goalId,
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
  const primaryForGoal = resolved?.primaryTaskId ?? (input.taskId !== undefined ? input.taskId : null);
  const derivedGoalId = input.goalId === undefined && primaryForGoal
    ? await resolveGoalIdForTasks(getDb(), null, primaryForGoal)
    : undefined;
  const effectiveGoalId = input.goalId !== undefined ? input.goalId : derivedGoalId;
  await assertRelations(userId, effectiveGoalId ?? input.goalId ?? undefined, resolved?.primaryTaskId ?? input.taskId ?? undefined, input.routineId ?? undefined, resolved?.taskIds);
  const current = await getDb().scheduleBlock.findFirst({ where: { id, userId, version: input.expectedVersion, deletedAt: null } });
  if (!current) throw new DomainError("VERSION_CONFLICT", "日程已经发生变化，请刷新后再保存。", 409);
  const moved = (input.startsAt && new Date(input.startsAt).getTime() !== current.startsAt.getTime()) || (input.endsAt && new Date(input.endsAt).getTime() !== current.endsAt.getTime());
  const goalPatch = effectiveGoalId !== undefined ? { goalId: effectiveGoalId } : input.goalId !== undefined ? { goalId: input.goalId } : {};
  if (moved && input.moveInPlace) {
    await getDb().$transaction(async (tx) => {
      await tx.scheduleBlock.update({ where: { id }, data: {
        ...(input.title !== undefined && { title: input.title }),
        ...goalPatch,
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
        goalId: effectiveGoalId !== undefined ? effectiveGoalId : input.goalId,
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
      ...goalPatch,
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

/** Task 完成只能由用户通过 completeTaskWithSummary 确认，聚合逻辑不得写入这些终态。 */
const TASK_TERMINAL_STATUSES: TaskStatus[] = [TaskStatus.COMPLETED, TaskStatus.CANCELLED, TaskStatus.ARCHIVED];

/**
 * 根据 Task 关联的所有有效日程块状态，聚合计算 Task 状态。
 *
 * 规则（v0.3 起）：日程块完成只代表一次投入会话完成，不代表任务交付完成——
 * Task 是否 COMPLETED 只能由用户在完成标准区主动确认（见 `task-completion.ts`）。
 * 本函数因此**禁止**把 Task 状态聚合为 COMPLETED，也不会把已处于终态
 * （COMPLETED / CANCELLED / ARCHIVED）的 Task 因块状态变化而打回其它状态。
 *
 * 非终态聚合规则：存在 PLANNED/IN_PROGRESS 块 → SCHEDULED（含 IN_PROGRESS 块时为 IN_PROGRESS）；
 * 存在已完成投入的块但用户尚未确认 → 保持 SCHEDULED（可作为「建议确认」的信号来源）；
 * 全部为 MISSED/RESCHEDULED/CANCELLED → BLOCKED；无任何有效块 → READY。
 * @param tx - Prisma 事务客户端
 * @param taskId - 任务 ID
 */
export async function aggregateTaskStatus(tx: Prisma.TransactionClient, taskId: string) {
  const task = await tx.task.findUnique({ where: { id: taskId }, select: { status: true } });
  if (!task || TASK_TERMINAL_STATUSES.includes(task.status)) return;

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
  if (statuses.includes(ScheduleBlockStatus.IN_PROGRESS)) {
    next = TaskStatus.IN_PROGRESS;
  } else if (statuses.some((s) => s === ScheduleBlockStatus.PLANNED)) {
    next = TaskStatus.SCHEDULED;
  } else if (statuses.includes(ScheduleBlockStatus.COMPLETED)) {
    // 有已完成的投入会话，但用户尚未在完成标准区确认交付；不自动完成任务。
    next = TaskStatus.SCHEDULED;
  } else if (statuses.every((s) => s === ScheduleBlockStatus.MISSED || s === ScheduleBlockStatus.RESCHEDULED || s === ScheduleBlockStatus.CANCELLED)) {
    next = TaskStatus.BLOCKED;
  } else {
    next = TaskStatus.READY;
  }
  await tx.task.update({ where: { id: taskId }, data: { status: next, version: { increment: 1 } } });
}

/**
 * 判断一个任务当前是否已具备「建议用户确认完成」的证据：
 * 累计真实投入达到预计时长，或已无剩余计划中的日程块但存在已完成投入。
 * 该函数只产出建议信号，绝不修改任务状态；最终完成仍须用户调用 completeTaskWithSummary。
 * @param task - 任务的预计时长与当前状态
 * @param blocks - 任务关联的日程块（仅需 status 与 investedMinutes 相关字段）
 */
export function isReadyForCompletionSuggest(
  task: { status: TaskStatus; estimatedMinutes: number | null },
  blocks: Array<{ status: ScheduleBlockStatus; investedMinutes: number }>,
): boolean {
  if (TASK_TERMINAL_STATUSES.includes(task.status)) return false;
  const completedBlocks = blocks.filter((block) => block.status === ScheduleBlockStatus.COMPLETED);
  if (!completedBlocks.length) return false;
  const investedMinutes = completedBlocks.reduce((sum, block) => sum + block.investedMinutes, 0);
  const hasNoRemainingPlanned = !blocks.some((block) => block.status === ScheduleBlockStatus.PLANNED || block.status === ScheduleBlockStatus.IN_PROGRESS);
  if (task.estimatedMinutes && investedMinutes >= task.estimatedMinutes) return true;
  return hasNoRemainingPlanned;
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
  const blockKind = inferScheduleBlockKind({
    goalId: "goalId" in block ? (block as { goalId?: string | null }).goalId : null,
    taskId: block.taskId,
    taskIds,
    routineId: "routineId" in block ? (block as { routineId?: string | null }).routineId : null,
    source: "source" in block ? (block as { source?: string | null }).source : null,
  });
  return {
    ...block,
    taskIds,
    blockKind,
    status: block.status.toLowerCase(),
    startsAt: block.startsAt.toISOString(),
    endsAt: block.endsAt.toISOString(),
    createdAt: block.createdAt.toISOString(),
    updatedAt: block.updatedAt.toISOString(),
    deletedAt: block.deletedAt?.toISOString() ?? null,
  };
}
