import { ChangeSetStatus, GoalStatus, MilestoneStatus, RoutineStatus, ScheduleBlockStatus, TaskStatus } from "@/generated/prisma/enums";
import { Prisma } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";
import { DomainError } from "@/server/api-response";
import type { ChangeSetDraft } from "@/domain/schemas";
import { enrichChangeOperation, enrichChangeOperations, normalizeAgentChangePayload } from "@/lib/change-operation-display";
import { inferScheduleBlockKind, isGoalScheduleEntity, isPersonalScheduleEntity } from "@/lib/schedule-block-kind";
import { aggregateLinkedTaskStatuses, aggregateTaskStatus, rescheduleScheduleBlockTx } from "@/server/services/schedule";
import { expandRoutineOccurrencesTx } from "@/server/services/routines";

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
async function normalizeChangeSetDraft(userId: string, draft: ChangeSetDraft): Promise<ChangeSetDraft> {
  const operations = await Promise.all(draft.operations.map(async (operation, index) => {
    const enriched = enrichChangeOperation(withStableOperationId(operation as Record<string, unknown>, index), index) as ChangeSetDraft["operations"][number];
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
  const preparedOperations = prepareChangeSetOperations(operations);
  await assertPersistedChangeReferences(userId, preparedOperations);
  return { ...draft, operations: preparedOperations as ChangeSetDraft["operations"] };
}

/**
 * 新草案为每个 operation 生成稳定引用；修订版会原样保留已有 operationId。
 * 历史 ChangeSet 只在读取投影中补齐，不回写旧数据。
 */
export function withStableOperationId(operation: Record<string, unknown>, index: number): Record<string, unknown> {
  if (typeof operation.operationId === "string" && operation.operationId.trim()) return operation;
  const payload = (operation.payload ?? operation.after ?? operation.before ?? {}) as Record<string, unknown>;
  const seed = [operation.type, operation.entity, operation.entityId, payload.title, payload.startsAt, payload.start, index].map((value) => String(value ?? "")).join(":");
  return { ...operation, operationId: `op-${index + 1}-${shortHash(seed)}` };
}

function shortHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

type ChangeReferenceField = {
  idField: "goalId" | "taskId" | "milestoneId" | "parentTaskId" | "routineId";
  refField: "goalRef" | "taskRef" | "milestoneRef" | "parentTaskRef" | "routineRef";
  entity: "goal" | "task" | "milestone" | "routine";
};

const CHANGE_REFERENCE_FIELDS: ChangeReferenceField[] = [
  { idField: "goalId", refField: "goalRef", entity: "goal" },
  { idField: "taskId", refField: "taskRef", entity: "task" },
  { idField: "milestoneId", refField: "milestoneRef", entity: "milestone" },
  { idField: "parentTaskId", refField: "parentTaskRef", entity: "task" },
  { idField: "routineId", refField: "routineRef", entity: "routine" },
];

type CreatedReference = {
  index: number;
  operationId: string;
  entity: string;
};

function operationPayloadKey(operation: Record<string, unknown>): "payload" | "after" | null {
  if (operation.type === "create") return "payload";
  if (operation.type === "update") return "after";
  return null;
}

function operationEntityKind(entity: unknown): string {
  const name = String(entity ?? "").toLowerCase();
  if (name.includes("milestone")) return "milestone";
  if (name.includes("routine")) return "routine";
  if (name.includes("outcome")) return "outcome";
  if (name.includes("task")) return "task";
  if (name.includes("goal")) return "goal";
  if (name.includes("schedule")) return "schedule";
  return name;
}

/**
 * 返回 create operation 可供同一 ChangeSet 后续操作引用的全部稳定键。
 * operationId 是首选契约；clientRef/tempId 仅用于兼容历史草案和模型旧输出。
 */
export function createdOperationReferenceKeys(operation: Record<string, unknown>): string[] {
  if (operation.type !== "create") return [];
  const payload = (operation.payload ?? {}) as Record<string, unknown>;
  return [...new Set([operation.operationId, payload.clientRef, payload.tempId]
    .map(optionalString)
    .filter((value): value is string => Boolean(value)))];
}

function buildCreatedReferenceIndex(operations: Array<Record<string, unknown>>): Map<string, CreatedReference> {
  const references = new Map<string, CreatedReference>();
  operations.forEach((operation, index) => {
    if (operation.type !== "create") return;
    const operationId = optionalString(operation.operationId);
    if (!operationId) throw new DomainError("INVALID_CHANGE_REFERENCE", "变更草案中的新增操作缺少稳定 operationId。", 400);
    const entry = { index, operationId, entity: operationEntityKind(operation.entity) };
    for (const key of createdOperationReferenceKeys(operation)) {
      const existing = references.get(key);
      if (existing && existing.operationId !== operationId) {
        throw new DomainError("AMBIGUOUS_CHANGE_REFERENCE", `变更草案中的临时引用“${key}”指向了多个新增对象。`, 400);
      }
      references.set(key, entry);
    }
  });
  return references;
}

function assertReferenceEntity(reference: CreatedReference, expectedEntity: string, field: string) {
  if (reference.entity !== expectedEntity) {
    throw new DomainError("INVALID_CHANGE_REFERENCE", `${field} 指向了 ${reference.entity}，但这里需要 ${expectedEntity}。`, 400);
  }
}

/**
 * 统一 ChangeSet 内部引用：`*Id` 只保留真实数据库 ID，匹配 create operation 的临时值改写为 `*Ref`。
 * 旧模型把 operationId 填进 goalId/taskId 时会在持久化或应用边界被安全兼容。
 */
export function canonicalizeChangeSetOperationReferences(input: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const operations = input.map((operation, index) => withStableOperationId(operation, index));
  const referenceIndex = buildCreatedReferenceIndex(operations);
  return operations.map((operation) => {
    const payloadKey = operationPayloadKey(operation);
    if (!payloadKey) return operation;
    const payload = normalizeAgentChangePayload(String(operation.entity ?? ""), (operation[payloadKey] ?? {}) as Record<string, unknown>);
    for (const { idField, refField, entity } of CHANGE_REFERENCE_FIELDS) {
      const idValue = optionalString(payload[idField]);
      const refValue = optionalString(payload[refField]);
      const idReference = idValue ? referenceIndex.get(idValue) : undefined;
      const explicitReference = refValue ? referenceIndex.get(refValue) : undefined;
      if (refValue && !explicitReference) {
        throw new DomainError("INVALID_CHANGE_REFERENCE", `变更草案中的 ${refField}“${refValue}”没有对应的新增操作。`, 400);
      }
      if (idReference && explicitReference && idReference.operationId !== explicitReference.operationId) {
        throw new DomainError("AMBIGUOUS_CHANGE_REFERENCE", `${idField} 与 ${refField} 指向了不同对象。`, 400);
      }
      if (!idReference && idValue && explicitReference) {
        throw new DomainError("AMBIGUOUS_CHANGE_REFERENCE", `${idField} 与 ${refField} 不能同时指向现有对象和草案内新增对象。`, 400);
      }
      const reference = idReference ?? explicitReference;
      if (!reference) continue;
      assertReferenceEntity(reference, entity, refField);
      delete payload[idField];
      payload[refField] = reference.operationId;
    }
    return { ...operation, [payloadKey]: payload };
  });
}

function operationDependencyIndexes(operation: Record<string, unknown>, referenceIndex: Map<string, CreatedReference>): number[] {
  const payloadKey = operationPayloadKey(operation);
  if (!payloadKey) return [];
  const payload = (operation[payloadKey] ?? {}) as Record<string, unknown>;
  const dependencies = new Set<number>();
  for (const { idField, refField } of CHANGE_REFERENCE_FIELDS) {
    for (const value of [payload[idField], payload[refField]]) {
      const reference = optionalString(value);
      if (reference && referenceIndex.has(reference)) dependencies.add(referenceIndex.get(reference)!.index);
    }
  }
  return [...dependencies];
}

/**
 * 计算用户选中操作的依赖闭包，并以父 create 在前的稳定拓扑顺序返回。
 * 这样选中日程会自动带上同草案中新建的目标，乱序模型输出也不会在应用阶段失配。
 */
export function prepareChangeSetOperations(input: Array<Record<string, unknown>>, selectedOperationIndexes?: number[]): Array<Record<string, unknown>> {
  const operations = canonicalizeChangeSetOperationReferences(input);
  const referenceIndex = buildCreatedReferenceIndex(operations);
  const selected = selectedOperationIndexes !== undefined
    ? [...new Set(selectedOperationIndexes.filter((index) => index >= 0 && index < operations.length))].sort((a, b) => a - b)
    : operations.map((_, index) => index);
  if (!selected.length) throw new DomainError("NO_CHANGE_SELECTED", "请至少选择一项要应用的变更。", 400);
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const ordered: number[] = [];

  const visit = (index: number) => {
    if (visited.has(index)) return;
    if (visiting.has(index)) throw new DomainError("CYCLIC_CHANGE_REFERENCE", "变更草案中的新增对象形成了循环引用。", 400);
    visiting.add(index);
    for (const dependency of operationDependencyIndexes(operations[index], referenceIndex)) visit(dependency);
    visiting.delete(index);
    visited.add(index);
    ordered.push(index);
  };
  selected.forEach(visit);
  return ordered.map((index) => operations[index]);
}

async function assertPersistedChangeReferences(userId: string, operations: Array<Record<string, unknown>>) {
  const byEntity = new Map<string, Set<string>>([
    ["goal", new Set<string>()],
    ["task", new Set<string>()],
    ["milestone", new Set<string>()],
    ["routine", new Set<string>()],
  ]);
  for (const operation of operations) {
    const payloadKey = operationPayloadKey(operation);
    if (!payloadKey) continue;
    const payload = (operation[payloadKey] ?? {}) as Record<string, unknown>;
    for (const { idField, entity } of CHANGE_REFERENCE_FIELDS) {
      const value = optionalString(payload[idField]);
      if (value) byEntity.get(entity)?.add(value);
    }
    if (Array.isArray(payload.taskIds)) {
      for (const value of payload.taskIds.map(optionalString)) if (value) byEntity.get("task")!.add(value);
    }
  }

  const goalIds = [...byEntity.get("goal")!];
  const taskIds = [...byEntity.get("task")!];
  const milestoneIds = [...byEntity.get("milestone")!];
  const routineIds = [...byEntity.get("routine")!];
  const [goals, tasks, milestones, routines] = await Promise.all([
    goalIds.length ? getDb().goal.findMany({ where: { id: { in: goalIds }, userId, archivedAt: null }, select: { id: true } }) : [],
    taskIds.length ? getDb().task.findMany({ where: { id: { in: taskIds }, goal: { userId }, archivedAt: null }, select: { id: true } }) : [],
    milestoneIds.length ? getDb().milestone.findMany({ where: { id: { in: milestoneIds }, goal: { userId } }, select: { id: true } }) : [],
    routineIds.length ? getDb().routine.findMany({ where: { id: { in: routineIds }, goal: { userId }, archivedAt: null }, select: { id: true } }) : [],
  ]);
  const existing = new Map<string, Set<string>>([
    ["goal", new Set(goals.map((item) => item.id))],
    ["task", new Set(tasks.map((item) => item.id))],
    ["milestone", new Set(milestones.map((item) => item.id))],
    ["routine", new Set(routines.map((item) => item.id))],
  ]);
  for (const [entity, ids] of byEntity) {
    const missing = [...ids].filter((id) => !existing.get(entity)!.has(id));
    if (missing.length) {
      throw new DomainError("INVALID_CHANGE_REFERENCE", `变更草案引用的${entity}不存在或不属于当前用户：${missing.join(", ")}`, 400);
    }
  }
}

async function collectBaseVersions(operations: ChangeSetDraft["operations"]) {
  const baseVersions: Record<string, number> = {};
  for (const operation of operations) {
    if ((operation.type === "update" || operation.type === "archive") && "entityId" in operation && operation.entityId) {
      const key = `${operation.entity}:${operation.entityId}`;
      if (key in baseVersions) continue;
      const version = await readEntityVersion(operation.entity, operation.entityId);
      if (version !== null) baseVersions[key] = version;
    }
  }
  return baseVersions;
}

/**
 * 创建待确认 ChangeSet。服务端主动读取所有 update/archive 操作对象的当前版本，
 * 写入 baseVersions，不依赖模型自觉提供 before.version，避免静默覆盖。
 * @param userId - 用户 ID
 * @param draft - 变更草案内容
 * @param idempotencyKey - 幂等键，防止重复创建
 * @param agentRunId - 关联的 AgentRun ID（可选）
 */
export async function createPendingChangeSet(userId: string, draft: ChangeSetDraft, idempotencyKey: string, agentRunId?: string, scheduleEvidence?: Prisma.InputJsonValue) {
  const normalized = await normalizeChangeSetDraft(userId, draft);
  const baseVersions = await collectBaseVersions(normalized.operations);
  return getDb().changeSet.upsert({
    where: { idempotencyKey }, update: {},
    create: { userId, agentRunId, status: ChangeSetStatus.AWAITING_CONFIRMATION, title: normalized.title, reason: normalized.reason, riskLevel: normalized.riskLevel, operations: normalized.operations as Prisma.InputJsonValue, baseVersions, scheduleEvidence, idempotencyKey },
  });
}

/** 读取一份仍可修订的结构化提案，并为历史 operation 提供只读兼容 ID。 */
export async function readPendingChangeSetForContinuation(userId: string, id: string) {
  const item = await getDb().changeSet.findFirst({ where: { id, userId, status: ChangeSetStatus.AWAITING_CONFIRMATION } });
  if (!item) throw new DomainError("PROPOSAL_NOT_AVAILABLE", "上一份提案已处理或不存在，无法继续修订。", 409);
  const operations = (item.operations as Array<Record<string, unknown>>).map(withStableOperationId);
  return { ...item, operations };
}

/**
 * 原子创建 ChangeSet 修订版，并让旧版本失去审批资格。
 * 任一并发修订只允许一个成功，避免同一提案链出现两个 pending。
 */
export async function createChangeSetRevision(input: {
  userId: string;
  baseChangeSetId: string;
  draft: ChangeSetDraft;
  idempotencyKey: string;
  agentRunId?: string;
  scheduleEvidence?: Prisma.InputJsonValue;
}) {
  const normalized = await normalizeChangeSetDraft(input.userId, input.draft);
  const baseVersions = await collectBaseVersions(normalized.operations);
  return getDb().$transaction(async (tx) => {
    const existing = await tx.changeSet.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return existing;
    const base = await tx.changeSet.findFirst({ where: { id: input.baseChangeSetId, userId: input.userId } });
    if (!base) throw new DomainError("CHANGE_SET_NOT_FOUND", "上一份变更草案不存在。", 404);
    if (base.status !== ChangeSetStatus.AWAITING_CONFIRMATION) throw new DomainError("PROPOSAL_NOT_AVAILABLE", "上一份提案已经处理，不能继续修订。", 409);
    const claimed = await tx.changeSet.updateMany({
      where: { id: base.id, status: ChangeSetStatus.AWAITING_CONFIRMATION },
      data: { status: ChangeSetStatus.SUPERSEDED, decidedAt: new Date(), decisionNote: "已被新的修订版替代" },
    });
    if (claimed.count !== 1) throw new DomainError("REVISION_CONFLICT", "提案刚刚发生变化，请基于最新版本重试。", 409);
    return tx.changeSet.create({ data: {
      userId: input.userId,
      agentRunId: input.agentRunId,
      status: ChangeSetStatus.AWAITING_CONFIRMATION,
      title: normalized.title,
      reason: normalized.reason,
      riskLevel: normalized.riskLevel,
      operations: normalized.operations as Prisma.InputJsonValue,
      baseVersions,
      revision: base.revision + 1,
      scheduleEvidence: input.scheduleEvidence,
      supersedesChangeSetId: base.id,
      idempotencyKey: input.idempotencyKey,
    } });
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
    operations: enrichChangeOperations((item.operations as Array<Record<string, unknown>>).map(withStableOperationId)),
  }));
}

/** 返回从当前版本向前追溯的 ChangeSet 修订链，用于只读审计。 */
export async function listChangeSetRevisionHistory(userId: string, id: string) {
  const history: Array<{ id: string; revision: number; status: ChangeSetStatus; title: string; reason: string; operations: Array<Record<string, unknown>>; createdAt: Date; supersedesChangeSetId: string | null }> = [];
  let cursor: string | null = id;
  while (cursor && history.length < 20) {
    const item: { id: string; revision: number; status: ChangeSetStatus; title: string; reason: string; operations: Prisma.JsonValue; createdAt: Date; supersedesChangeSetId: string | null } | null = await getDb().changeSet.findFirst({ where: { id: cursor, userId }, select: { id: true, revision: true, status: true, title: true, reason: true, operations: true, createdAt: true, supersedesChangeSetId: true } });
    if (!item) break;
    history.push({ ...item, operations: enrichChangeOperations((item.operations as Array<Record<string, unknown>>).map(withStableOperationId)) });
    cursor = item.supersedesChangeSetId;
  }
  if (!history.length) throw new DomainError("CHANGE_SET_NOT_FOUND", "这份变更草案不存在。", 404);
  return history;
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
  const operations = prepareChangeSetOperations(allOperations, selectedOperationIndexes);
  await getDb().$transaction(async (tx) => {
    // 强制逐项版本校验，缺版本直接拒绝
    await assertVersions(tx, changeSet.baseVersions as Record<string, number>);
    // 对话阶段的候选检查只用于效率；真正写入前在同一事务中重新检查当前日历。
    await assertScheduleOperationsAvailable(tx, userId, operations);
    await applyPreparedChangeSetOperationsTx(tx, userId, operations);
    await tx.changeSet.update({ where: { id }, data: { status: ChangeSetStatus.APPLIED, decisionNote: operations.length === allOperations.length ? "用户确认整份草案" : `用户确认 ${operations.length}/${allOperations.length} 项`, decidedAt: new Date(), appliedAt: new Date() } });
    if (changeSet.agentRunId) await tx.agentRun.update({ where: { id: changeSet.agentRunId }, data: { status: "COMPLETED", exitReason: "goal_achieved", goalStatus: "achieved", completedAt: new Date() } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  return getDb().changeSet.findUniqueOrThrow({ where: { id } });
}

/** 在调用方事务内应用已经完成引用规范化与依赖排序的操作。 */
export async function applyPreparedChangeSetOperationsTx(tx: Prisma.TransactionClient, userId: string, operations: Array<Record<string, unknown>>) {
  const references = new Map<string, string>();
  for (const operation of operations) await applyOperation(tx, userId, operation, references);
}

type PendingScheduleCandidate = {
  operationId: string;
  entityId?: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
};

/** 从 ChangeSet operations 投影需要在应用边界检查的最终日程候选。 */
export function projectScheduleCandidates(operations: Array<Record<string, unknown>>): PendingScheduleCandidate[] {
  return operations.flatMap((operation, index) => {
    const type = String(operation.type ?? "");
    if (type !== "create" && type !== "update") return [];
    const entity = String(operation.entity ?? "").toLowerCase();
    const rawPayload = (operation.payload ?? operation.after ?? {}) as Record<string, unknown>;
    const payload = normalizeAgentChangePayload(entity, rawPayload);
    if (!isPersonalScheduleEntity(entity, payload) && !isGoalScheduleEntity(entity, payload)) return [];
    const hasTime = payload.startsAt !== undefined || payload.start !== undefined || payload.startTime !== undefined;
    if (!hasTime) return [];
    const startsAt = parseScheduleDate(payload, "start", "startsAt");
    const endsAt = parseScheduleDate(payload, "end", "endsAt");
    assertValidScheduleRange(startsAt, endsAt);
    return [{
      operationId: typeof operation.operationId === "string" ? operation.operationId : `operation-${index + 1}`,
      entityId: type === "update" && typeof operation.entityId === "string" ? operation.entityId : undefined,
      title: String(payload.title ?? `日程 ${index + 1}`),
      startsAt,
      endsAt,
    }];
  });
}

/**
 * 应用 ChangeSet 前的权威冲突校验。检查草案内部互相重叠，也检查事务读取到的最新正式日历。
 */
async function assertScheduleOperationsAvailable(tx: Prisma.TransactionClient, userId: string, operations: Array<Record<string, unknown>>) {
  const candidates = projectScheduleCandidates(operations);
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const left = candidates[leftIndex];
      const right = candidates[rightIndex];
      if (left.startsAt < right.endsAt && left.endsAt > right.startsAt) {
        throw new DomainError("STALE_PLAN", `草案中的“${left.title}”与“${right.title}”时间重叠，请先修订提案。`, 409);
      }
    }
  }
  if (candidates.length) {
    const from = new Date(Math.min(...candidates.map((candidate) => candidate.startsAt.getTime())));
    const to = new Date(Math.max(...candidates.map((candidate) => candidate.endsAt.getTime())));
    const routineOccurrences = await expandRoutineOccurrencesTx(tx, userId, from, to);
    for (const candidate of candidates) {
      const occurrence = routineOccurrences.find((item) => item.status !== "cancelled" && item.status !== "rescheduled" && candidate.startsAt < new Date(item.endsAt) && candidate.endsAt > new Date(item.startsAt));
      if (occurrence) throw new DomainError("STALE_PLAN", `“${candidate.title}”与 Routine“${occurrence.title}”冲突，请先修订提案。`, 409);
    }
  }
  for (const candidate of candidates) {
    const conflict = await tx.scheduleBlock.findFirst({
      where: {
        userId,
        deletedAt: null,
        status: { notIn: [ScheduleBlockStatus.CANCELLED, ScheduleBlockStatus.RESCHEDULED] },
        startsAt: { lt: candidate.endsAt },
        endsAt: { gt: candidate.startsAt },
        ...(candidate.entityId ? { id: { not: candidate.entityId } } : {}),
      },
      select: { title: true, startsAt: true, endsAt: true },
    });
    if (conflict) {
      throw new DomainError("STALE_PLAN", `“${candidate.title}”与刚刚变化的日程“${conflict.title}”冲突，请基于最新日程修订。`, 409);
    }
  }
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
  const remember = (id: string) => {
    for (const key of createdOperationReferenceKeys({ ...operation, payload })) references.set(key, id);
  };
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
