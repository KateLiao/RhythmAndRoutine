import { z } from "zod";
import { zonedDateKey, zonedDateTimeToUtc } from "@/lib/timezone";
import type { AdjustmentKind, ProposalOperationRef } from "./types";

export type ProposalOperation = Record<string, unknown> & { operationId: string };

export type ReorderContext = {
  timezone: string;
  instruction: string;
  window: { startsAt: string; endsAt: string };
  affectedOperations: Array<{
    operationId: string;
    title: string;
    blockKind: string;
    durationMinutes: number;
    currentStartsAt: string;
    currentEndsAt: string;
    fixed: boolean;
    explicitConstraints: string[];
    focusLevel?: string;
    energyLevel?: string;
  }>;
  hardConstraints: string[];
  softConstraints: string[];
  availableIntervals: Array<{ startsAt: string; endsAt: string }>;
  neighboringProposalOperations: Array<{ operationId: string; title: string; startsAt: string; endsAt: string }>;
};

const reorderCandidateSchema = z.object({
  operationId: z.string().min(1).max(80),
  startsAt: z.string().min(10).max(60),
  endsAt: z.string().min(10).max(60),
  reason: z.string().min(1).max(300),
});

export const reorderDecisionSchema = z.object({
  affectedOperationIds: z.array(z.string().min(1).max(80)).min(1).max(20),
  candidates: z.array(reorderCandidateSchema).min(1).max(20),
  reasoningSummary: z.string().min(1).max(600),
  assumptions: z.array(z.string().min(1).max(240)).max(8).default([]),
  needsClarification: z.boolean().default(false),
  clarificationQuestion: z.string().min(1).max(300).optional(),
});

export type ReorderDecision = z.infer<typeof reorderDecisionSchema>;

export type ReorderValidationIssue = {
  code: "UNKNOWN_OPERATION" | "MISSING_OPERATION" | "DUPLICATE_OPERATION" | "FIXED_OPERATION" | "INVALID_RANGE" | "DURATION_CHANGED" | "OUTSIDE_WINDOW" | "OUTSIDE_AVAILABLE_INTERVAL" | "PROPOSAL_CONFLICT";
  operationId?: string;
  message: string;
};

export type ReorderValidation = { valid: boolean; issues: ReorderValidationIssue[] };

export type ProposalPatchInstruction = {
  removeSelected: boolean;
  replacementTitle?: string;
  addition?: { title: string; durationMinutes: number };
};

/**
 * 兼容 OpenAI-compatible 供应商偶发的外层包装和字段别名。
 * 该函数不补造 operation、不改时间，只做形状归一化；结果仍必须经过严格 schema 与硬约束校验。
 */
export function normalizeReorderDecisionResponse(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const outer = value as Record<string, unknown>;
  const raw = outer.reorderDecision && typeof outer.reorderDecision === "object" && !Array.isArray(outer.reorderDecision)
    ? outer.reorderDecision as Record<string, unknown>
    : outer;
  const rawCandidates = Array.isArray(raw.candidates)
    ? raw.candidates
    : Array.isArray(raw.operations)
      ? raw.operations
      : typeof raw.operationId === "string"
        ? [raw]
        : [];
  const candidates = rawCandidates.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Record<string, unknown>;
    const operationId = candidate.operationId;
    const startsAt = candidate.startsAt ?? candidate.newStartsAt ?? candidate.startTime;
    const endsAt = candidate.endsAt ?? candidate.newEndsAt ?? candidate.endTime;
    if (typeof operationId !== "string" || typeof startsAt !== "string" || typeof endsAt !== "string") return [];
    return [{ operationId, startsAt, endsAt, reason: String(candidate.reason ?? candidate.reasoning ?? raw.reasoningSummary ?? raw.reasoning ?? "模型局部排程").slice(0, 300) }];
  });
  if (!candidates.length) return raw;
  const assumptions = Array.isArray(raw.assumptions) ? raw.assumptions.slice(0, 8).map((item) => String(item).slice(0, 240)) : [];
  return {
    affectedOperationIds: Array.isArray(raw.affectedOperationIds) ? raw.affectedOperationIds.slice(0, 20).map(String) : candidates.map((candidate) => candidate.operationId),
    candidates: candidates.slice(0, 20),
    reasoningSummary: String(raw.reasoningSummary ?? raw.reasoning ?? candidates.map((candidate) => candidate.reason).join("；")).slice(0, 600),
    assumptions,
    needsClarification: raw.needsClarification === true || raw.needsClarification === "true",
    ...(typeof raw.clarificationQuestion === "string" ? { clarificationQuestion: raw.clarificationQuestion.slice(0, 300) } : {}),
  };
}

/** 只把带具体时间的一次性日程 operation 纳入提案续接。 */
export function scheduleProposalOperations(operations: Array<Record<string, unknown>>): ProposalOperation[] {
  return operations.flatMap((operation, index) => {
    const payload = operationPayload(operation);
    const entity = String(operation.entity ?? "").toLowerCase();
    const hasTimes = typeof (payload.startsAt ?? payload.startTime ?? payload.start) === "string"
      && typeof (payload.endsAt ?? payload.endTime ?? payload.end) === "string";
    if (!hasTimes || (!entity.includes("schedule") && !payload.blockKind && !payload.scheduleKind)) return [];
    const operationId = typeof operation.operationId === "string" && operation.operationId.trim()
      ? operation.operationId
      : `operation-${index + 1}`;
    return [{ ...operation, operationId }];
  });
}

/**
 * 用稳定序号和活动标题解析“第一个”“银行那个”等引用。
 * 无法唯一定位时返回空数组，由调用方只追问目标项，不重跑整份规划。
 */
export function resolveAffectedProposalOperations(input: {
  operations: Array<Record<string, unknown>>;
  prompt: string;
  refs: ProposalOperationRef[];
  kind: AdjustmentKind;
}): ProposalOperation[] {
  const scheduleOperations = scheduleProposalOperations(input.operations);
  const selected = new Map<string, ProposalOperation>();
  for (const ref of input.refs) {
    if (ref.ordinal && scheduleOperations[ref.ordinal - 1]) {
      const operation = scheduleOperations[ref.ordinal - 1]!;
      selected.set(operation.operationId, operation);
    }
    if (ref.title) {
      for (const operation of scheduleOperations) if (titleMatches(input.prompt, operationTitle(operation), ref.title)) selected.set(operation.operationId, operation);
    }
  }
  for (const operation of scheduleOperations) {
    if (titleMatches(input.prompt, operationTitle(operation))) selected.set(operation.operationId, operation);
  }

  if (input.kind === "proposal_item_reschedule") {
    if (selected.size === 1) return [...selected.values()];
    if (selected.size === 0 && scheduleOperations.length === 1) return scheduleOperations;
    return [];
  }
  if (input.kind === "proposal_reorder") {
    if (selected.size >= 2) return [...selected.values()];
    if (selected.size === 0 && scheduleOperations.length === 2) return scheduleOperations;
    return [];
  }
  return [...selected.values()];
}

/** 明确给出开始时间时，只修改目标 operation，并默认保持原时长。 */
export function rescheduleProposalItem(input: {
  operations: Array<Record<string, unknown>>;
  targetOperationId: string;
  startTime: string;
  endTime?: string;
  timezone: string;
}) {
  let changed = false;
  const operations = input.operations.map((raw) => {
    const operation = raw as ProposalOperation;
    if (operation.operationId !== input.targetOperationId) return raw;
    const payload = operationPayload(operation);
    const currentStart = new Date(String(payload.startsAt ?? payload.startTime ?? payload.start));
    const currentEnd = new Date(String(payload.endsAt ?? payload.endTime ?? payload.end));
    if (Number.isNaN(currentStart.getTime()) || Number.isNaN(currentEnd.getTime()) || currentEnd <= currentStart) {
      throw new Error("目标日程缺少有效的原始起止时间。");
    }
    const date = zonedDateKey(currentStart, input.timezone);
    const startsAt = zonedDateTimeToUtc(date, `${input.startTime}:00`, input.timezone);
    const durationMs = currentEnd.getTime() - currentStart.getTime();
    let endsAt = input.endTime ? zonedDateTimeToUtc(date, `${input.endTime}:00`, input.timezone) : new Date(startsAt.getTime() + durationMs);
    if (input.endTime && endsAt <= startsAt) endsAt = zonedDateTimeToUtc(nextDateKey(date), `${input.endTime}:00`, input.timezone);
    if (endsAt <= startsAt) throw new Error("新的结束时间必须晚于开始时间。");
    changed = true;
    return replaceOperationTimes(operation, startsAt.toISOString(), endsAt.toISOString());
  });
  if (!changed) throw new Error("无法在上一份提案中定位要修改的日程。");
  return operations;
}

/**
 * 解析提案内最常见的确定性增删改表达。它只抽取字段，不自行选择新增项时间。
 * 新增项未给出时间时，服务端仍必须把它交给模型做局部排程推理。
 */
export function parseProposalPatchInstruction(prompt: string): ProposalPatchInstruction {
  const removeSelected = /删除|去掉|移除/.test(prompt);
  const replacement = prompt.match(/(?:改(?:标题|内容)?|换)成\s*([^，。！？]+?)(?=\s*(?:，|。|！|？|$))/)?.[1]?.trim();
  const additionMatch = prompt.match(/(?:新增|添加|再?加(?:一|1)?个?)\s*([^，。！？]+?)(?=\s*(?:，|。|！|？|$))/);
  const additionText = additionMatch?.[1]?.trim();
  const duration = additionText?.match(/(\d{1,3})\s*分钟/);
  const additionTitle = additionText
    ?.replace(/\d{1,3}\s*分钟/, "")
    .replace(/^(?:的|一个|一项|项|日程|安排|活动)\s*/, "")
    .replace(/\s*(?:的)?(?:日程|安排|活动)$/, "")
    .trim();
  return {
    removeSelected,
    ...(replacement ? { replacementTitle: replacement } : {}),
    ...(additionTitle ? { addition: { title: additionTitle.slice(0, 120), durationMinutes: duration ? Number(duration[1]) : 30 } } : {}),
  };
}

/** 删除或改名只触碰用户点名的 operation；其他对象引用和值保持不变。 */
export function applyDeterministicProposalPatch(input: {
  operations: Array<Record<string, unknown>>;
  selectedOperationIds: string[];
  removeSelected?: boolean;
  replacementTitle?: string;
}) {
  const selected = new Set(input.selectedOperationIds);
  return input.operations.flatMap((raw) => {
    const operation = raw as ProposalOperation;
    if (!selected.has(operation.operationId)) return [raw];
    if (input.removeSelected) return [];
    if (!input.replacementTitle) return [raw];
    const key = operation.payload ? "payload" : "after";
    return [{ ...operation, [key]: { ...operationPayload(operation), title: input.replacementTitle } }];
  });
}

/** 确定性验证模型只能改受影响 operation 的时间，且不能破坏硬约束。 */
export function validateReorderDecision(context: ReorderContext, decision: ReorderDecision): ReorderValidation {
  const issues: ReorderValidationIssue[] = [];
  const affected = new Map(context.affectedOperations.map((operation) => [operation.operationId, operation]));
  const candidateIds = decision.candidates.map((candidate) => candidate.operationId);
  for (const id of candidateIds) if (!affected.has(id)) issues.push({ code: "UNKNOWN_OPERATION", operationId: id, message: `模型返回了未授权 operation：${id}` });
  for (const id of affected.keys()) if (!candidateIds.includes(id)) issues.push({ code: "MISSING_OPERATION", operationId: id, message: `模型遗漏了需要重排的 operation：${id}` });
  for (const id of new Set(candidateIds)) if (candidateIds.filter((candidateId) => candidateId === id).length > 1) issues.push({ code: "DUPLICATE_OPERATION", operationId: id, message: `模型重复返回 operation：${id}` });

  const windowStart = new Date(context.window.startsAt);
  const windowEnd = new Date(context.window.endsAt);
  const parsed = decision.candidates.flatMap((candidate) => {
    const startsAt = new Date(candidate.startsAt);
    const endsAt = new Date(candidate.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      issues.push({ code: "INVALID_RANGE", operationId: candidate.operationId, message: `${candidate.operationId} 的起止时间无效。` });
      return [];
    }
    const original = affected.get(candidate.operationId);
    if (!original) return [];
    if (original.fixed) issues.push({ code: "FIXED_OPERATION", operationId: candidate.operationId, message: `${candidate.operationId} 是固定日程，不能重排。` });
    const expectedMs = original.durationMinutes * 60_000;
    if (Math.abs(endsAt.getTime() - startsAt.getTime() - expectedMs) >= 60_000) issues.push({ code: "DURATION_CHANGED", operationId: candidate.operationId, message: `${candidate.operationId} 的时长被改变。` });
    if (startsAt < windowStart || endsAt > windowEnd) issues.push({ code: "OUTSIDE_WINDOW", operationId: candidate.operationId, message: `${candidate.operationId} 超出允许的重排窗口。` });
    const insideAvailableInterval = context.availableIntervals.some((interval) => startsAt >= new Date(interval.startsAt) && endsAt <= new Date(interval.endsAt));
    if (context.availableIntervals.length && !insideAvailableInterval) issues.push({ code: "OUTSIDE_AVAILABLE_INTERVAL", operationId: candidate.operationId, message: `${candidate.operationId} 不在任何已验证可用区间内。` });
    return [{ operationId: candidate.operationId, startsAt, endsAt }];
  });

  const occupied = [
    ...parsed,
    ...context.neighboringProposalOperations.map((operation) => ({ operationId: operation.operationId, startsAt: new Date(operation.startsAt), endsAt: new Date(operation.endsAt) })),
  ];
  for (let leftIndex = 0; leftIndex < occupied.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < occupied.length; rightIndex += 1) {
      const left = occupied[leftIndex]!;
      const right = occupied[rightIndex]!;
      if (left.startsAt < right.endsAt && left.endsAt > right.startsAt) issues.push({ code: "PROPOSAL_CONFLICT", operationId: left.operationId, message: `${left.operationId} 与 ${right.operationId} 在提案内重叠。` });
    }
  }
  return { valid: issues.length === 0, issues };
}

/** 将已验证的 ReorderDecision 合并回原 ChangeSet，未受影响字段保持深度不变。 */
export function applyReorderDecision(operations: Array<Record<string, unknown>>, decision: ReorderDecision) {
  const candidates = new Map(decision.candidates.map((candidate) => [candidate.operationId, candidate]));
  return operations.map((raw) => {
    const operation = raw as ProposalOperation;
    const candidate = candidates.get(operation.operationId);
    return candidate ? replaceOperationTimes(operation, new Date(candidate.startsAt).toISOString(), new Date(candidate.endsAt).toISOString()) : raw;
  });
}

/** 返回一份提案内部的时间重叠；相邻端点按半开区间处理，不算冲突。 */
export function findProposalOverlaps(operations: Array<Record<string, unknown>>) {
  const timed = scheduleProposalOperations(operations).flatMap((operation) => {
    const range = operationTimeRange(operation);
    const startsAt = new Date(range.startsAt);
    const endsAt = new Date(range.endsAt);
    return Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt
      ? []
      : [{ operationId: operation.operationId, title: operationTitle(operation), startsAt, endsAt }];
  });
  const conflicts: Array<{ leftOperationId: string; rightOperationId: string; message: string }> = [];
  for (let leftIndex = 0; leftIndex < timed.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < timed.length; rightIndex += 1) {
      const left = timed[leftIndex]!;
      const right = timed[rightIndex]!;
      if (left.startsAt < right.endsAt && left.endsAt > right.startsAt) conflicts.push({
        leftOperationId: left.operationId,
        rightOperationId: right.operationId,
        message: `“${left.title}”与“${right.title}”在提案内重叠。`,
      });
    }
  }
  return conflicts;
}

/** 生成受长度约束的下一轮状态胶囊；只保留结构化提案，不包含原始工具输出。 */
export function buildContinuationCapsule(input: {
  proposalId: string;
  parentRunId: string;
  operations: Array<Record<string, unknown>>;
  targetOperationIds?: string[];
}, maxChars = 1500) {
  const targetIds = new Set(input.targetOperationIds ?? []);
  const projected = scheduleProposalOperations(input.operations).map((operation) => {
    const payload = operationPayload(operation);
    return {
      operationId: operation.operationId,
      title: operationTitle(operation),
      startsAt: String(payload.startsAt ?? payload.startTime ?? payload.start),
      endsAt: String(payload.endsAt ?? payload.endTime ?? payload.end),
      goalId: stringOrUndefined(payload.goalId),
      taskId: stringOrUndefined(payload.taskId),
      fixed: isFixed(operation, payload),
    };
  });
  const prioritized = [...projected.filter((operation) => targetIds.has(operation.operationId)), ...projected.filter((operation) => !targetIds.has(operation.operationId))];
  const operations = [...prioritized];
  let capsule = { proposalId: input.proposalId, parentRunId: input.parentRunId, status: "awaiting_confirmation", operations };
  while (JSON.stringify(capsule).length > maxChars && operations.length > Math.max(1, targetIds.size)) operations.pop();
  capsule = { ...capsule, operations };
  return capsule;
}

export function operationPayload(operation: Record<string, unknown>) {
  return (operation.payload ?? operation.after ?? {}) as Record<string, unknown>;
}

export function operationTitle(operation: Record<string, unknown>) {
  const payload = operationPayload(operation);
  return String(payload.title ?? payload.name ?? operation.entity ?? "未命名日程");
}

export function operationTimeRange(operation: Record<string, unknown>) {
  const payload = operationPayload(operation);
  return {
    startsAt: String(payload.startsAt ?? payload.startTime ?? payload.start ?? ""),
    endsAt: String(payload.endsAt ?? payload.endTime ?? payload.end ?? ""),
  };
}

export function isFixed(operation: Record<string, unknown>, payload = operationPayload(operation)) {
  return operation.fixed === true || payload.fixed === true || payload.flexibility === "fixed" || payload.movable === false;
}

function replaceOperationTimes(operation: ProposalOperation, startsAt: string, endsAt: string): ProposalOperation {
  const key = operation.payload ? "payload" : "after";
  const payload = operationPayload(operation);
  const next: Record<string, unknown> = { ...payload, startsAt, endsAt };
  delete next.startTime;
  delete next.endTime;
  delete next.start;
  delete next.end;
  return { ...operation, [key]: next };
}

function titleMatches(prompt: string, title: string, explicit?: string) {
  const normalizedPrompt = compact(prompt);
  const normalizedTitle = compact(explicit ?? title);
  if (normalizedTitle.length >= 2 && normalizedPrompt.includes(normalizedTitle)) return true;
  const activityPrefix = normalizedTitle.match(/^(阅读|学习|写作|撰写|构思|运动|训练|复盘|开会|会议|通勤)/)?.[1];
  if (activityPrefix && normalizedPrompt.includes(activityPrefix)) return true;
  const withoutVerb = normalizedTitle.replace(/^(去|做|进行|完成|处理|阅读|学习|撰写|构思|安排)/, "");
  return withoutVerb.length >= 2 && normalizedPrompt.includes(withoutVerb);
}

function compact(value: string) { return value.toLowerCase().replace(/[\s《》“”"'，。！？、:：()（）\[\]]/g, ""); }
function stringOrUndefined(value: unknown) { return typeof value === "string" && value ? value : undefined; }
function nextDateKey(date: string) { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + 1); return value.toISOString().slice(0, 10); }
