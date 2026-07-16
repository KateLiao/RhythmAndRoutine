import { ChangeSetStatus, GoalStatus, MilestoneStatus, RoutineStatus, ScheduleBlockStatus, TaskStatus } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";
import { DomainError } from "@/server/api-response";
import type { ChangeSetDraft } from "@/domain/schemas";
import { enrichChangeOperation, enrichChangeOperations, normalizeAgentChangePayload } from "@/lib/change-operation-display";
import { inferScheduleBlockKind, isGoalScheduleEntity, isPersonalScheduleEntity } from "@/lib/schedule-block-kind";
import { aggregateLinkedTaskStatuses, aggregateTaskStatus, rescheduleScheduleBlockTx } from "@/server/services/schedule";

/**
 * Run cancel 后重复拒绝同一草案属于幂等收敛，不应显示清理失败。
 */
export function isIdempotentChangeSetRejection(status: ChangeSetStatus, approved: boolean): boolean {
  return !approved && status === ChangeSetStatus.REJECTED;
}

/**
 * 规范化 Agent 提交的变更操作：统一 entity 小写，并为 update 操作补全 before 快照（便于 UI 展示 diff）。
 * @param draft - 原始变更草案
 */
async function normalizeChangeSetDraft(draft: ChangeSetDraft): Promise<ChangeSetDraft> {
  const operations = await Promise.all(draft.operations.map(async (operation, index) => {
    const enriched = enrichChangeOperation(operation as Record<string, unknown>, index) as ChangeSetDraft["operations"][number];
    const entity = enriched.entity.toLowerCase();
    if (enriched.type !== "update" && enriched.type !== "archive") {
      return { ...enriched, entity };
    }

    const before = { ...enriched.before };
    if (Object.keys(before).length === 0) {
      const snapshot = await readEntitySnapshot(entity, enriched.entityId);
      if (snapshot) Object.assign(before, snapshot);
    }
    return { ...enriched, entity, before };
  }));
  return { ...draft, operations };
}

/**
 * 创建待确认 ChangeSet。服务端主动读取所有 update/archive 操作对象的当前版本，
 * 写入 baseVersions，不依赖模型自觉提供 before.version，避免静默覆盖。
 * @param userId - 用户 ID
 * @param draft - 变更草案内容
 * @param idempotencyKey - 幂等键，防止重复创建
 * @param agentRunId - 关联的 AgentRun ID（可选）
 */
export async function createPendingChangeSet(userId: string, draft: ChangeSetDraft, idempotencyKey: string, agentRunId?: string) {
  const normalized = await normalizeChangeSetDraft(draft);
  // 服务端主动采集所有 update/archive 操作对象的当前版本（不依赖模型提供）
  const baseVersions: Record<string, number> = {};
  for (const operation of normalized.operations) {
    if ((operation.type === "update" || operation.type === "archive") && "entityId" in operation && operation.entityId) {
      const key = `${operation.entity}:${operation.entityId}`;
      if (key in baseVersions) continue;
      const version = await readEntityVersion(operation.entity, operation.entityId);
      if (version !== null) baseVersions[key] = version;
    }
  }
  return getDb().changeSet.upsert({
    where: { idempotencyKey }, update: {},
    create: { userId, agentRunId, status: ChangeSetStatus.AWAITING_CONFIRMATION, title: normalized.title, reason: normalized.reason, riskLevel: normalized.riskLevel, operations: normalized.operations as Prisma.InputJsonValue, baseVersions, idempotencyKey },
  });
}

/**
 * 列出当前用户待确认的 ChangeSet 列表。
 * @param userId - 用户 ID
 */
export async function listPendingChangeSets(userId: string) {
  const items = await getDb().changeSet.findMany({ where: { userId, status: ChangeSetStatus.AWAITING_CONFIRMATION }, orderBy: { createdAt: "desc" } });
  return items.map((item) => ({
    ...item,
    operations: enrichChangeOperations(item.operations as Array<Record<string, unknown>>),
  }));
}

/**
 * 审批或拒绝一份 ChangeSet。
 * 批准时：重新校验所有 baseVersions，版本不符立即拒绝（防止静默覆盖）；
 * 然后逐项执行业务写操作；支持部分选项确认。
 * @param userId - 用户 ID
 * @param id - ChangeSet ID
 * @param approved - true=批准，false=拒绝
 * @param selectedOperationIndexes - 仅确认其中部分操作（可选，默认全部）
 */
export async function decideChangeSet(userId: string, id: string, approved: boolean, selectedOperationIndexes?: number[]) {
  const changeSet = await getDb().changeSet.findFirst({ where: { id, userId } });
  if (!changeSet) throw new DomainError("CHANGE_SET_NOT_FOUND", "这份变更草案不存在。", 404);
  // Run cancel 会先拒绝关联草案；随后 Session 兜底 reject 同一 id 时应视为已收敛。
  if (isIdempotentChangeSetRejection(changeSet.status, approved)) return changeSet;
  if (changeSet.status !== ChangeSetStatus.AWAITING_CONFIRMATION) {
    throw new DomainError("CHANGE_SET_ALREADY_DECIDED", "这份变更草案已经处理，不能重复审批。", 409);
  }
  if (!approved) return getDb().$transaction(async (tx) => {
    const rejected = await tx.changeSet.update({ where: { id }, data: { status: ChangeSetStatus.REJECTED, decidedAt: new Date() } });
    if (changeSet.agentRunId) await tx.agentRun.update({ where: { id: changeSet.agentRunId }, data: { status: "CANCELLED", exitReason: "cancelled_by_user", goalStatus: "blocked", completedAt: new Date() } });
    return rejected;
  });
  const allOperations = changeSet.operations as Array<Record<string, unknown>>;
  const selected = selectedOperationIndexes?.length ? new Set(selectedOperationIndexes.filter((index) => index >= 0 && index < allOperations.length)) : new Set(allOperations.map((_, index) => index));
  for (const index of [...selected]) {
    const payload = (allOperations[index].payload ?? allOperations[index].after ?? {}) as Record<string, unknown>;
    for (const reference of [payload.goalRef, payload.milestoneRef, payload.parentTaskRef]) {
      if (!reference) continue;
      const dependency = allOperations.findIndex((operation) => { const data = (operation.payload ?? {}) as Record<string, unknown>; return data.clientRef === reference || data.tempId === reference; });
      if (dependency >= 0) selected.add(dependency);
    }
  }
  const operations = allOperations.filter((_, index) => selected.has(index));
  await getDb().$transaction(async (tx) => {
    // 强制逐项版本校验，缺版本直接拒绝
    await assertVersions(tx, changeSet.baseVersions as Record<string, number>);
    const references = new Map<string, string>();
    for (const operation of operations) await applyOperation(tx, userId, operation, references);
    await tx.changeSet.update({ where: { id }, data: { status: ChangeSetStatus.APPLIED, decisionNote: operations.length === allOperations.length ? "用户确认整份草案" : `用户确认 ${operations.length}/${allOperations.length} 项`, decidedAt: new Date(), appliedAt: new Date() } });
    if (changeSet.agentRunId) await tx.agentRun.update({ where: { id: changeSet.agentRunId }, data: { status: "COMPLETED", exitReason: "goal_achieved", goalStatus: "achieved", completedAt: new Date() } });
  });
  return getDb().changeSet.findUniqueOrThrow({ where: { id } });
}

/**
 * 校验 baseVersions 中每个对象的当前版本是否一致。
 * 任一对象版本不符或不存在则抛出 VERSION_CONFLICT。
 * @param tx - Prisma 事务客户端
 * @param versions - { "EntityType:id": expectedVersion } 映射
 */
async function assertVersions(tx: Prisma.TransactionClient, versions: Record<string, number>) {
  for (const [key, expected] of Object.entries(versions)) {
    const [entity, id] = key.split(":");
    const name = entity.toLowerCase();
    const actual = name.includes("schedule") ? await tx.scheduleBlock.findUnique({ where: { id }, select: { version: true } }) : name.includes("routine") ? await tx.routine.findUnique({ where: { id }, select: { version: true } }) : name.includes("milestone") ? await tx.milestone.findUnique({ where: { id }, select: { version: true } }) : name.includes("outcome") ? await tx.outcome.findUnique({ where: { id }, select: { version: true } }) : name.includes("goal") ? await tx.goal.findUnique({ where: { id }, select: { version: true } }) : await tx.task.findUnique({ where: { id }, select: { version: true } });
    // 对象不存在或版本已变化，均拒绝（不依赖模型自觉提供版本）
    if (!actual) throw new DomainError("VERSION_CONFLICT", `对象 ${key} 不存在，可能已被删除，请重新生成草案。`, 409);
    if (actual.version !== expected) throw new DomainError("VERSION_CONFLICT", "计划在你确认前已经变化，请重新生成草案。", 409);
  }
}

/**
 * 读取实体当前版本号（不在事务内，用于 createPendingChangeSet 时采集）。
 * @param entity - 实体类型字符串
 * @param id - 实体 ID
 * @returns 版本号，不存在时返回 null
 */
async function readEntityVersion(entity: string, id: string): Promise<number | null> {
  const name = entity.toLowerCase();
  const record = name.includes("schedule") ? await getDb().scheduleBlock.findUnique({ where: { id }, select: { version: true } }) : name.includes("routine") ? await getDb().routine.findUnique({ where: { id }, select: { version: true } }) : name.includes("milestone") ? await getDb().milestone.findUnique({ where: { id }, select: { version: true } }) : name.includes("outcome") ? await getDb().outcome.findUnique({ where: { id }, select: { version: true } }) : name.includes("goal") ? await getDb().goal.findUnique({ where: { id }, select: { version: true } }) : await getDb().task.findUnique({ where: { id }, select: { version: true } });
  return record?.version ?? null;
}

/**
 * 读取实体当前快照，用于补全 update/archive 操作的 before 字段供 UI 展示。
 * @param entity - 实体类型字符串
 * @param id - 实体 ID
 */
async function readEntitySnapshot(entity: string, id: string): Promise<Record<string, unknown> | null> {
  const name = entity.toLowerCase();
  if (name.includes("goal")) {
    const goal = await getDb().goal.findUnique({ where: { id }, select: { title: true, description: true, category: true, project: true, skill: true, targetDate: true, status: true, version: true } });
    return goal ? { title: goal.title, description: goal.description, category: goal.category?.toLowerCase(), project: goal.project, skill: goal.skill, targetDate: goal.targetDate?.toISOString(), status: goal.status.toLowerCase(), version: goal.version } : null;
  }
  if (name.includes("milestone")) {
    const milestone = await getDb().milestone.findUnique({ where: { id }, select: { title: true, description: true, version: true } });
    return milestone ? { title: milestone.title, description: milestone.description, version: milestone.version } : null;
  }
  if (name.includes("task")) {
    const task = await getDb().task.findUnique({ where: { id }, select: { title: true, intent: true, version: true } });
    return task ? { title: task.title, intent: task.intent, version: task.version } : null;
  }
  if (name.includes("routine")) {
    const routine = await getDb().routine.findUnique({ where: { id }, select: { title: true, description: true, recurrenceRule: true, startDate: true, endDate: true, durationMinutes: true, preferredStartTime: true, preferredEndTime: true, preferredTimeOfDay: true, minimumVersion: true, version: true } });
    return routine ? { ...routine, startDate: routine.startDate.toISOString(), endDate: routine.endDate?.toISOString() } : null;
  }
  if (name.includes("schedule")) {
    const block = await getDb().scheduleBlock.findUnique({ where: { id }, select: { title: true, startsAt: true, endsAt: true, goalId: true, taskId: true, routineId: true, source: true, version: true } });
    return block ? {
      title: block.title,
      startsAt: block.startsAt.toISOString(),
      endsAt: block.endsAt.toISOString(),
      blockKind: inferScheduleBlockKind(block),
      version: block.version,
    } : null;
  }
  if (name.includes("outcome")) {
    const outcome = await getDb().outcome.findUnique({ where: { id }, select: { description: true, version: true } });
    return outcome ? { description: outcome.description, version: outcome.version } : null;
  }
  return null;
}

/**
 * 执行单条 ChangeSet 操作。
 * schedule update 若时间发生变化走统一 reschedule 路径（而非原地改时间）。
 * @param tx - 事务客户端
 * @param userId - 用户 ID
 * @param operation - 变更操作对象
 * @param references - 临时 ID → 真实 ID 映射（用于 create 后的引用解析）
 */
async function applyOperation(tx: Prisma.TransactionClient, userId: string, operation: Record<string, unknown>, references: Map<string, string>) {
  const type = String(operation.type ?? ""); const entity = String(operation.entity ?? "").toLowerCase();
  const rawPayload = (operation.payload ?? operation.after ?? {}) as Record<string, unknown>;
  const payload = normalizeAgentChangePayload(entity, rawPayload);
  const entityId = String(operation.entityId ?? "");
  const resolve = (value: unknown) => references.get(String(value ?? "")) ?? optionalString(value);
  const remember = (id: string) => { const key = optionalString(payload.clientRef) ?? optionalString(payload.tempId); if (key) references.set(key, id); };
  if (type === "create" && entity.includes("goal")) {
    const created = await tx.goal.create({ data: { userId, title: String(payload.title ?? "新目标"), description: optionalString(payload.description), category: optionalString(payload.category), project: optionalString(payload.project), skill: optionalString(payload.skill), targetDate: optionalDate(payload.targetDate), status: GoalStatus.ACTIVE } }); remember(created.id); return;
  }
  if (type === "create" && entity.includes("outcome")) {
    const goalId = resolve(payload.goalId ?? payload.goalRef) ?? ""; await assertGoal(tx, userId, goalId);
    const created = await tx.outcome.create({ data: { goalId, description: String(payload.description ?? payload.title ?? "结果指标") } }); remember(created.id); return;
  }
  if (type === "create" && entity.includes("milestone")) {
    const goalId = resolve(payload.goalId ?? payload.goalRef) ?? ""; await assertGoal(tx, userId, goalId);
    const last = await tx.milestone.aggregate({ where: { goalId }, _max: { position: true } });
    const created = await tx.milestone.create({ data: { goalId, title: String(payload.title ?? "新里程碑"), description: optionalString(payload.description), targetDate: optionalDate(payload.targetDate), status: MilestoneStatus.PENDING, position: optionalNumber(payload.position) ?? ((last._max.position ?? -1) + 1) } }); remember(created.id); return;
  }
  if (type === "create" && entity.includes("task")) {
    const goalId = resolve(payload.goalId ?? payload.goalRef) ?? ""; await assertGoal(tx, userId, goalId);
    const created = await tx.task.create({ data: { goalId, milestoneId: resolve(payload.milestoneId ?? payload.milestoneRef), parentTaskId: resolve(payload.parentTaskId ?? payload.parentTaskRef), title: String(payload.title ?? "新任务"), intent: optionalString(payload.intent), completionCriteria: jsonValue(payload.completionCriteria), suggestedSteps: jsonValue(payload.suggestedSteps), rhythmConditions: jsonValue(payload.rhythmConditions), estimatedMinutes: optionalNumber(payload.estimatedMinutes), energyLevel: optionalString(payload.energyLevel), focusLevel: optionalString(payload.focusLevel), status: TaskStatus.READY } }); remember(created.id); return;
  }
  if (type === "create" && entity.includes("routine")) {
    const goalId = resolve(payload.goalId ?? payload.goalRef) ?? ""; await assertGoal(tx, userId, goalId);
    const created = await tx.routine.create({ data: { goalId, title: String(payload.title ?? "新 Routine"), description: optionalString(payload.reason ?? payload.description), recurrenceRule: String(payload.recurrenceRule ?? "FREQ=DAILY"), startDate: optionalDate(payload.startDate) ?? new Date(), endDate: optionalDate(payload.endDate), durationMinutes: optionalNumber(payload.durationMinutes ?? payload.targetMinutes) ?? 20, preferredStartTime: optionalString(payload.preferredStartTime), preferredEndTime: optionalString(payload.preferredEndTime), preferredTimeOfDay: optionalString(payload.preferredTimeOfDay ?? payload.preferredTime), priority: optionalString(payload.priority) ?? "medium", displayMode: optionalString(payload.displayMode) ?? "subtle", minimumVersion: optionalString(payload.minimumVersion), status: RoutineStatus.ACTIVE } }); remember(created.id); return;
  }
  if (type === "create" && isPersonalScheduleEntity(entity, payload)) {
    assertPersonalSchedulePayload(payload);
    const startsAt = parseScheduleDate(payload, "start", "startsAt");
    const endsAt = parseScheduleDate(payload, "end", "endsAt");
    assertValidScheduleRange(startsAt, endsAt);
    await tx.scheduleBlock.create({ data: { userId, title: String(payload.title ?? "个人日程"), startsAt, endsAt, source: "agent" } });
    return;
  }
  if (type === "create" && isGoalScheduleEntity(entity, payload)) {
    const { goalId, taskId } = await resolveGoalScheduleRelations(tx, userId, payload, resolve);
    const startsAt = parseScheduleDate(payload, "start", "startsAt");
    const endsAt = parseScheduleDate(payload, "end", "endsAt");
    assertValidScheduleRange(startsAt, endsAt);
    await tx.scheduleBlock.create({ data: { userId, goalId, taskId, title: String(payload.title ?? "新安排"), startsAt, endsAt, source: "agent" } });
    if (taskId) await aggregateTaskStatus(tx, taskId);
    return;
  }
  if (type === "update" && (isPersonalScheduleEntity(entity, payload) || isGoalScheduleEntity(entity, payload))) {
    const current = await tx.scheduleBlock.findFirst({ where: { id: entityId, userId, deletedAt: null } }); if (!current) throw new DomainError("SCHEDULE_NOT_FOUND", "待调整的日程不存在。", 404);
    const currentKind = inferScheduleBlockKind(current);
    if (isPersonalScheduleEntity(entity, payload) && currentKind !== "personal") {
      throw new DomainError("INVALID_SCHEDULE_KIND", "该日程不是个人占位，请使用 schedule 类型调整。", 400);
    }
    if (isGoalScheduleEntity(entity, payload) && !isPersonalScheduleEntity(entity, payload) && currentKind === "personal") {
      throw new DomainError("INVALID_SCHEDULE_KIND", "该日程是个人占位，请使用 personal_schedule 类型调整。", 400);
    }
    if (isPersonalScheduleEntity(entity, payload)) assertPersonalSchedulePayload(payload);
    const newStart = payload.start !== undefined || payload.startsAt !== undefined ? parseScheduleDate(payload, "start", "startsAt") : null;
    const newEnd = payload.end !== undefined || payload.endsAt !== undefined ? parseScheduleDate(payload, "end", "endsAt") : null;
    if (newStart || newEnd) assertValidScheduleRange(newStart ?? current.startsAt, newEnd ?? current.endsAt);
    const moved = (newStart && newStart.getTime() !== current.startsAt.getTime()) || (newEnd && newEnd.getTime() !== current.endsAt.getTime());
    if (moved) {
      // 时间有变化：走统一改期路径，保留原块历史
      await rescheduleScheduleBlockTx(tx, current, {
        startsAt: newStart ?? current.startsAt,
        endsAt: newEnd ?? current.endsAt,
        changeReason: optionalString(payload.changeReason) ?? "Agent 调整日程",
        title: optionalString(payload.title),
        source: "agent",
      });
    } else {
      // 仅更新属性，不创建新块
      await tx.scheduleBlock.update({ where: { id: entityId }, data: { ...(payload.title !== undefined && { title: String(payload.title) }), version: { increment: 1 } } });
    }
    if (current.taskId) await aggregateTaskStatus(tx, current.taskId);
    await aggregateLinkedTaskStatuses(tx, entityId, current.taskId);
    return;
  }
  if (type === "update" && entity.includes("task")) {
    const task = await tx.task.findFirst({ where: { id: entityId, goal: { userId }, archivedAt: null } }); if (!task) throw new DomainError("TASK_NOT_FOUND", "待调整的任务不存在。", 404);
    await tx.task.update({ where: { id: entityId }, data: { ...(payload.title !== undefined && { title: String(payload.title) }), ...(payload.intent !== undefined && { intent: optionalString(payload.intent) }), ...(payload.completionCriteria !== undefined && { completionCriteria: jsonValue(payload.completionCriteria) }), ...(payload.suggestedSteps !== undefined && { suggestedSteps: jsonValue(payload.suggestedSteps) }), ...(payload.rhythmConditions !== undefined && { rhythmConditions: jsonValue(payload.rhythmConditions) }), ...(payload.estimatedMinutes !== undefined && { estimatedMinutes: optionalNumber(payload.estimatedMinutes) }), ...(payload.energyLevel !== undefined && { energyLevel: optionalString(payload.energyLevel) }), ...(payload.focusLevel !== undefined && { focusLevel: optionalString(payload.focusLevel) }), version: { increment: 1 } } }); return;
  }
  if (type === "update" && entity.includes("goal")) { await tx.goal.updateMany({ where: { id: entityId, userId, archivedAt: null }, data: { ...(payload.title !== undefined && { title: String(payload.title) }), ...(payload.description !== undefined && { description: optionalString(payload.description) }), ...(payload.category !== undefined && { category: optionalString(payload.category) }), ...(payload.project !== undefined && { project: optionalString(payload.project) }), ...(payload.skill !== undefined && { skill: optionalString(payload.skill) }), ...(payload.targetDate !== undefined && { targetDate: optionalDate(payload.targetDate) }), ...(payload.status !== undefined && { status: String(payload.status).toUpperCase() as GoalStatus }), version: { increment: 1 } } }); return; }
  if (type === "update" && entity.includes("milestone")) { await tx.milestone.updateMany({ where: { id: entityId, goal: { userId } }, data: { ...(payload.title !== undefined && { title: String(payload.title) }), ...(payload.description !== undefined && { description: optionalString(payload.description) }), version: { increment: 1 } } }); return; }
  if (type === "update" && entity.includes("outcome")) { await tx.outcome.updateMany({ where: { id: entityId, goal: { userId } }, data: { ...(payload.description !== undefined && { description: String(payload.description) }), version: { increment: 1 } } }); return; }
  if (type === "archive" && (isPersonalScheduleEntity(entity, payload) || isGoalScheduleEntity(entity, payload))) {
    const block = await tx.scheduleBlock.findFirst({ where: { id: entityId, userId, deletedAt: null }, select: { taskId: true } });
    await tx.scheduleBlock.updateMany({ where: { id: entityId, userId }, data: { status: ScheduleBlockStatus.CANCELLED, deletedAt: new Date(), version: { increment: 1 } } });
    if (block?.taskId) await aggregateTaskStatus(tx, block.taskId);
    await aggregateLinkedTaskStatuses(tx, entityId, block?.taskId);
    return;
  }
  if (type === "archive" && entity.includes("task")) { await tx.task.updateMany({ where: { id: entityId, goal: { userId } }, data: { status: TaskStatus.ARCHIVED, archivedAt: new Date(), version: { increment: 1 } } }); return; }
  throw new DomainError("UNSUPPORTED_CHANGE", `暂不支持这类变更：${type} ${entity}`, 400);
}

async function assertGoal(tx: Prisma.TransactionClient, userId: string, goalId: string) { if (!goalId || !(await tx.goal.findFirst({ where: { id: goalId, userId, archivedAt: null }, select: { id: true } }))) throw new DomainError("INVALID_GOAL", "变更草案引用了不存在的目标。", 400); }

/**
 * 校验个人日程 payload 不得携带目标、任务、Routine 或重复规则。
 * @param payload - 规范化后的操作 payload
 */
function assertPersonalSchedulePayload(payload: Record<string, unknown>) {
  const forbidden = ["goalId", "taskId", "taskIds", "routineId", "goalRef", "taskRef", "routineRef", "recurrenceRule", "recurrence"];
  for (const key of forbidden) {
    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== "") {
      throw new DomainError("INVALID_PERSONAL_SCHEDULE", "个人日程不得关联目标、任务、Routine 或重复规则。", 400);
    }
  }
}

/**
 * 解析目标日程必须关联的 goalId / taskId，并校验不得使用重复规则。
 * @param tx - 事务客户端
 * @param userId - 用户 ID
 * @param payload - 操作 payload
 * @param resolve - 引用 ID 解析函数
 */
async function resolveGoalScheduleRelations(
  tx: Prisma.TransactionClient,
  userId: string,
  payload: Record<string, unknown>,
  resolve: (value: unknown) => string | undefined,
) {
  if (payload.recurrenceRule || payload.recurrence) {
    throw new DomainError("INVALID_GOAL_SCHEDULE", "重复性安排应使用 routine 实体，而不是 schedule。", 400);
  }
  let goalId = resolve(payload.goalId ?? payload.goalRef);
  const taskId = resolve(payload.taskId ?? payload.taskRef);
  if (!goalId && taskId) {
    const task = await tx.task.findFirst({ where: { id: taskId, goal: { userId }, archivedAt: null }, select: { goalId: true } });
    if (!task) throw new DomainError("INVALID_TASK", "关联任务不存在。", 400);
    goalId = task.goalId;
  }
  if (!goalId) throw new DomainError("INVALID_GOAL_SCHEDULE", "目标日程必须关联 goalId 或 taskId。", 400);
  await assertGoal(tx, userId, goalId);
  if (taskId) {
    const task = await tx.task.findFirst({ where: { id: taskId, goalId, archivedAt: null }, select: { id: true } });
    if (!task) throw new DomainError("INVALID_TASK", "关联任务不存在或不属于该目标。", 400);
  }
  return { goalId, taskId: taskId ?? null };
}

function optionalString(value: unknown) { return typeof value === "string" && value ? value : undefined; }
function optionalNumber(value: unknown) { const number = Number(value); return Number.isFinite(number) ? number : undefined; }
function optionalDate(value: unknown) { return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value) : undefined; }
function jsonValue(value: unknown): Prisma.InputJsonValue | undefined { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
function parseScheduleDate(payload: Record<string, unknown>, shortKey: string, isoKey: string) { const raw = payload[isoKey] ?? payload[shortKey]; if (typeof raw === "string" && raw.includes("T")) return new Date(raw); const date = String(payload.date ?? new Date().toISOString().slice(0, 10)); return new Date(`${date}T${String(raw ?? "10:00")}:00+08:00`); }
function assertValidScheduleRange(startsAt: Date, endsAt: Date) {
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw new DomainError("INVALID_SCHEDULE_TIME", "草案里的日程时间无法识别，请重新生成草案。", 400);
  if (endsAt <= startsAt) throw new DomainError("INVALID_SCHEDULE_RANGE", "草案里的日程结束时间必须晚于开始时间。", 400);
}
