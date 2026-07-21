import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { z } from "zod";
import {
  applyDeterministicProposalPatch,
  applyReorderDecision,
  buildContinuationCapsule,
  findProposalOverlaps,
  isFixed,
  operationPayload,
  operationTimeRange,
  operationTitle,
  normalizeReorderDecisionResponse,
  parseProposalPatchInstruction,
  reorderDecisionSchema,
  rescheduleProposalItem,
  resolveAffectedProposalOperations,
  scheduleProposalOperations,
  validateReorderDecision,
  type ReorderContext,
  type ReorderDecision,
  type ReorderValidationIssue,
} from "@/agent/proposal-continuation";
import { PrismaRunStore } from "@/agent/prisma-run-store";
import type { IntentResolution, ModelAdapter, RunEvent } from "@/agent/types";
import type { ChangeSetDraft } from "@/domain/schemas";
import { zonedDateKey, zonedDateTimeToUtc } from "@/lib/timezone";
import { listScheduleBlocks } from "@/server/services/schedule";
import { buildAgentScheduleWindowResult, validateScheduleCandidates } from "@/server/services/agent-schedule-analysis";
import { createChangeSetRevision, readPendingChangeSetForContinuation } from "@/server/services/change-sets";
import { getDb } from "@/lib/db";

type StoredRevision = Awaited<ReturnType<typeof createChangeSetRevision>>;

export type ProposalContinuationResult = {
  runId: string;
  text: string;
  changeSet: (ChangeSetDraft & { id: string; revision: number; supersedesChangeSetId?: string }) | null;
};

export function supportsProposalContinuation(resolution: IntentResolution) {
  return resolution.adjustment?.kind === "proposal_item_reschedule"
    || resolution.adjustment?.kind === "proposal_reorder"
    || resolution.adjustment?.kind === "proposal_patch"
    // 只要客户端仍持有待确认提案，就不能回落到全量 adjustment 链并另建一份草案。
    || (resolution.adjustment?.kind === "existing_adjustment" && Boolean(resolution.adjustment.changeSetId));
}

/**
 * 待确认提案的有界快路径：明确时间只做确定性 patch；未指定时间重排必须调用结构化模型。
 */
export async function executeProposalContinuation(input: {
  userId: string;
  prompt: string;
  resolution: IntentResolution;
  adapter: ModelAdapter;
  model: string;
  timezone: string;
  now?: Date;
  signal?: AbortSignal;
  emit?: (event: RunEvent) => void;
}): Promise<ProposalContinuationResult> {
  const adjustment = input.resolution.adjustment;
  if (!adjustment?.changeSetId || !supportsProposalContinuation(input.resolution)) throw new Error("当前请求没有可续接的结构化提案。");
  const base = await readPendingChangeSetForContinuation(input.userId, adjustment.changeSetId);
  const affected = resolveAffectedProposalOperations({ operations: base.operations, prompt: input.prompt, refs: adjustment.operationRefs, kind: adjustment.kind });
  const patchInstruction = adjustment.kind === "proposal_patch" ? parseProposalPatchInstruction(input.prompt) : undefined;
  const patchNeedsSelectedOperation = Boolean(patchInstruction?.removeSelected || patchInstruction?.replacementTitle);
  const hasPatchAction = Boolean(
    patchInstruction?.addition
    || (affected.length && (patchInstruction?.removeSelected || patchInstruction?.replacementTitle)),
  );
  const hasLocatedWork = adjustment.kind === "existing_adjustment"
    ? false
    : adjustment.kind === "proposal_patch"
      ? hasPatchAction && !(patchNeedsSelectedOperation && !affected.length)
      : affected.length > 0;
  const parentRunId = await validParentRunId(input.userId, adjustment.continuationOfRunId ?? base.agentRunId ?? undefined);
  const store = new PrismaRunStore();
  const run = await store.create({
    userId: input.userId,
    capability: "adjustment",
    provider: input.adapter.provider,
    model: input.model,
    contextManifest: [{ entityType: "change_set", entityId: base.id, reason: "续接上一份待确认提案" }],
    inputSummary: input.prompt,
    maxSteps: 2,
    maxTokens: 7_000,
    intentResolution: input.resolution,
    conversationId: adjustment.conversationId,
    parentRunId,
    continuationKind: adjustment.kind,
    continuationState: buildContinuationCapsule({ proposalId: base.id, parentRunId: parentRunId ?? base.agentRunId ?? "unknown", operations: base.operations, targetOperationIds: affected.map((operation) => operation.operationId) }),
  });
  input.emit?.({ type: "run_started", runId: run.id });

  let sequence = 1;
  const locatedSummary = [
    affected.length ? affected.map(operationTitle).join("、") : "",
    patchInstruction?.addition ? `新增“${patchInstruction.addition.title}”` : "",
  ].filter(Boolean).join("；");
  const planningReason = hasLocatedWork
    ? `已复用 ChangeSet ${base.id} 的结构化 operations，只处理 ${locatedSummary}。`
    : "已找到上一份提案，但当前表达无法唯一定位要调整的日程。";
  await store.appendStep(run.id, { sequence: sequence++, kind: "planning", goalStatus: hasLocatedWork ? "needs_more_action" : "needs_user_input", nextAction: hasLocatedWork ? "call_tool" : "ask_user", reason: planningReason, input: { baseChangeSetId: base.id, revision: base.revision, adjustment, patchInstruction } });
  input.emit?.({ type: "loop_step", kind: "planning", label: "复用上一轮方案", summary: hasLocatedWork ? `已定位：${locatedSummary}` : "需要确认要调整哪一项", goalStatus: hasLocatedWork ? "needs_more_action" : "needs_user_input", nextAction: hasLocatedWork ? "call_tool" : "ask_user", detail: { scope: `提案修订版 ${base.revision}；未受影响 operation 保持不变`, judgment: planningReason, nextAction: hasLocatedWork ? "只重新处理受影响片段。" : "请点名日程或序号。" } });

  if (!hasLocatedWork) {
    const text = adjustment.kind === "proposal_reorder"
      ? "我已经找到上一份提案，但还不能唯一确定你想交换哪两个日程。请告诉我两个日程名称或序号。"
      : "我已经找到上一份提案，但还不能唯一确定你想修改哪一项。请告诉我日程名称或序号。";
    await store.complete(run.id, text, "awaiting_user_input", "needs_user_input", 0);
    input.emit?.({ type: "text_delta", text });
    input.emit?.({ type: "run_completed", text });
    return { runId: run.id, text, changeSet: null };
  }

  try {
    let workingOperations = base.operations;
    let reasoningAffected = affected;
    let patchSummary: string | undefined;

    if (adjustment.kind === "proposal_patch") {
      const selectedIds = affected.map((operation) => operation.operationId);
      workingOperations = applyDeterministicProposalPatch({
        operations: base.operations,
        selectedOperationIds: selectedIds,
        removeSelected: patchInstruction?.removeSelected,
        replacementTitle: patchInstruction?.replacementTitle,
      });
      const changedLabels = [
        patchInstruction?.removeSelected && affected.length ? `删除“${affected.map(operationTitle).join("、")}”` : "",
        patchInstruction?.replacementTitle && affected.length ? `把“${affected.map(operationTitle).join("、")}”改为“${patchInstruction.replacementTitle}”` : "",
      ].filter(Boolean);

      if (!patchInstruction?.addition) {
        if (!workingOperations.length) {
          const text = "这次删除会让整份提案变为空。你是想取消整份提案，还是再保留/新增一项安排？";
          await store.complete(run.id, text, "awaiting_user_input", "needs_user_input", 0);
          input.emit?.({ type: "text_delta", text });
          input.emit?.({ type: "run_completed", text });
          return { runId: run.id, text, changeSet: null };
        }
        const reason = `${changedLabels.join("；")}；其余提案保持不变。`;
        const draft = revisionDraft(base, workingOperations, reason);
        const revision = await createChangeSetRevision({ userId: input.userId, baseChangeSetId: base.id, draft, idempotencyKey: `${run.id}:proposal-patch`, agentRunId: run.id });
        const text = `已${changedLabels.join("，")}，其余安排保持不变。请确认这份修订版后再写入日历。`;
        return await finishWithRevision(store, run.id, sequence, revision, draft, text, input.emit);
      }

      const anchor = affected[0] ?? scheduleProposalOperations(base.operations)[0];
      if (!anchor) {
        const text = "我已识别出要新增的事项，但上一份提案里没有可用于确定日期的日程。请告诉我希望安排在哪一天。";
        await store.complete(run.id, text, "awaiting_user_input", "needs_user_input", 0);
        input.emit?.({ type: "text_delta", text });
        input.emit?.({ type: "run_completed", text });
        return { runId: run.id, text, changeSet: null };
      }
      const added = createAddedProposalOperation({
        baseChangeSetId: base.id,
        prompt: input.prompt,
        title: patchInstruction.addition.title,
        durationMinutes: patchInstruction.addition.durationMinutes,
        anchor,
        startTime: adjustment.startTime,
        timezone: input.timezone,
      });
      workingOperations = [...workingOperations, added];
      reasoningAffected = [added];
      patchSummary = [...changedLabels, `新增 ${patchInstruction.addition.durationMinutes} 分钟“${patchInstruction.addition.title}”`].join("；");

      if (adjustment.startTime) {
        const validation = await validateRevisionSchedule(input.userId, workingOperations, [added.operationId], input.timezone, input.emit);
        await persistValidationStep(store, run.id, sequence++, validation);
        if (!validation.ok) {
          const text = `新增项放在这个时间会产生冲突：${validation.messages.join("；")}。请换一个开始时间。`;
          await store.complete(run.id, text, "awaiting_user_input", "needs_user_input", 0);
          input.emit?.({ type: "text_delta", text });
          input.emit?.({ type: "run_completed", text });
          return { runId: run.id, text, changeSet: null };
        }
        const draft = revisionDraft(base, workingOperations, `${patchSummary}；其余提案保持不变。`);
        const revision = await createChangeSetRevision({ userId: input.userId, baseChangeSetId: base.id, draft, idempotencyKey: `${run.id}:proposal-patch`, agentRunId: run.id, scheduleEvidence: validation.evidence });
        const text = `已${patchSummary}，其余安排保持不变。请确认这份修订版后再写入日历。`;
        return await finishWithRevision(store, run.id, sequence, revision, draft, text, input.emit);
      }
    }

    if (adjustment.kind === "proposal_item_reschedule") {
      if ((!adjustment.startTime && !adjustment.timeExpression) || affected.length !== 1) {
        const text = "请告诉我这一项新的开始时间；如果只给开始时间，我会保持原时长。";
        await store.complete(run.id, text, "awaiting_user_input", "needs_user_input", 0);
        input.emit?.({ type: "text_delta", text });
        input.emit?.({ type: "run_completed", text });
        return { runId: run.id, text, changeSet: null };
      }
      let resolvedStartTime = adjustment.startTime;
      if (!resolvedStartTime && adjustment.timeExpression) {
        const targetRange = operationTimeRange(affected[0]!);
        const context = {
          timezone: input.timezone,
          currentLocalDateTime: formatLocalDateTime(input.now ?? new Date(), input.timezone),
          instruction: input.prompt,
          timeExpression: adjustment.timeExpression,
          relation: adjustment.timeRelation ?? "neutral",
          target: {
            operationId: affected[0]!.operationId,
            title: operationTitle(affected[0]!),
            currentStartsAt: targetRange.startsAt,
            currentEndsAt: targetRange.endsAt,
            currentLocalRange: formatLocalRange(targetRange.startsAt, targetRange.endsAt, input.timezone),
          },
          neighboringOperations: scheduleProposalOperations(base.operations)
            .filter((operation) => operation.operationId !== affected[0]!.operationId)
            .slice(0, 12)
            .map((operation) => ({ operationId: operation.operationId, title: operationTitle(operation), ...operationTimeRange(operation) })),
        };
        input.emit?.({ type: "loop_step", kind: "verification", label: `理解“${adjustment.timeExpression}”`, summary: "结合当前时间和原日程判断最合理的时段", goalStatus: "needs_more_action", nextAction: "call_tool", detail: { scope: `只解释“${operationTitle(affected[0]!)}”的新开始时间`, judgment: "缺少上午/下午，使用一次有界模型推理；时长、日期和其他日程不交给模型修改。", nextAction: "输出一个 24 小时制时间后进行硬约束校验。" } });
        let inputTokens = 0;
        let outputTokens = 0;
        const startedAt = Date.now();
        const decision = await interpretAmbiguousProposalTime(input.adapter, input.model, context, input.signal, (usage) => { inputTokens += usage.inputTokens; outputTokens += usage.outputTokens; });
        await store.appendStep(run.id, { sequence: sequence++, loopIteration: 1, kind: "model_reasoning", goalStatus: decision.needsClarification ? "needs_user_input" : "needs_more_action", nextAction: decision.needsClarification ? "ask_user" : "call_tool", reason: "只解释缺少时段的时间表达，不重新读取目标、历史或整份日程。", input: context, output: decision, durationMs: Date.now() - startedAt, inputTokens, outputTokens, toolAttemptCount: 0 });
        if (decision.needsClarification) {
          const text = decision.clarificationQuestion ?? `“${adjustment.timeExpression}”可能指上午或下午，请告诉我你更倾向哪个时段。`;
          await store.complete(run.id, text, "awaiting_user_input", "needs_user_input", 0);
          input.emit?.({ type: "text_delta", text });
          input.emit?.({ type: "run_completed", text });
          return { runId: run.id, text, changeSet: null };
        }
        if (!respectsTimeRelation(decision.localTime, targetRange.startsAt, adjustment.timeRelation, input.timezone)) {
          const text = `我无法把“${adjustment.timeExpression}”解释成一个同时符合“${adjustment.timeRelation === "later" ? "推迟" : "提前"}”的当天时间。请补充上午或下午。`;
          await store.complete(run.id, text, "awaiting_user_input", "needs_user_input", 0);
          input.emit?.({ type: "text_delta", text });
          input.emit?.({ type: "run_completed", text });
          return { runId: run.id, text, changeSet: null };
        }
        resolvedStartTime = decision.localTime;
      }
      const revisedOperations = rescheduleProposalItem({ operations: base.operations, targetOperationId: affected[0]!.operationId, startTime: resolvedStartTime!, endTime: adjustment.endTime, timezone: input.timezone });
      const validation = await validateRevisionSchedule(input.userId, revisedOperations, [affected[0]!.operationId], input.timezone, input.emit);
      await persistValidationStep(store, run.id, sequence++, validation);
      if (!validation.ok) {
        const text = `这个时间会产生冲突：${validation.messages.join("；")}。请换一个开始时间，我会继续只修改这一项。`;
        await store.complete(run.id, text, "awaiting_user_input", "needs_user_input", 0);
        input.emit?.({ type: "text_delta", text });
        input.emit?.({ type: "run_completed", text });
        return { runId: run.id, text, changeSet: null };
      }
      const target = scheduleProposalOperations(revisedOperations).find((operation) => operation.operationId === affected[0]!.operationId)!;
      const range = operationTimeRange(target);
      const draft = revisionDraft(base, revisedOperations, `只调整“${operationTitle(target)}”的时间，其余提案保持不变。`);
      const revision = await createChangeSetRevision({ userId: input.userId, baseChangeSetId: base.id, draft, idempotencyKey: `${run.id}:proposal-item-reschedule`, agentRunId: run.id, scheduleEvidence: validation.evidence });
      const text = `已把“${operationTitle(target)}”调整为 ${formatLocalRange(range.startsAt, range.endsAt, input.timezone)}，其余安排保持不变。请确认这份修订版后再写入日历。`;
      return await finishWithRevision(store, run.id, sequence, revision, draft, text, input.emit);
    }

    if (reasoningAffected.some((operation) => isFixed(operation))) {
      const fixedTitles = reasoningAffected.filter((operation) => isFixed(operation)).map(operationTitle).join("、");
      const text = `${fixedTitles} 被标记为固定日程，不能由我静默移动。你希望解除固定约束，还是只调整另一项？`;
      await store.complete(run.id, text, "awaiting_user_input", "needs_user_input", 0);
      input.emit?.({ type: "text_delta", text });
      input.emit?.({ type: "run_completed", text });
      return { runId: run.id, text, changeSet: null };
    }

    const context = await buildReorderContext(input.userId, input.prompt, workingOperations, reasoningAffected, input.timezone);
    input.emit?.({ type: "loop_step", kind: "verification", label: "结合活动特点重新安排", summary: "正在推理受影响片段的合理时间", goalStatus: "needs_more_action", nextAction: "call_tool", detail: { scope: `${reasoningAffected.length} 个日程、${context.availableIntervals.length} 个当前可用区间`, judgment: "模型决定什么时间更合理；硬约束与冲突由确定性层检查。", nextAction: "生成结构化 ReorderDecision。" } });

    let modelCalls = 0;
    const decide = async (repair?: { prior: ReorderDecision; issues: ReorderValidationIssue[] }) => {
      modelCalls += 1;
      let inputTokens = 0;
      let outputTokens = 0;
      const startedAt = Date.now();
      const decision = await generateReorderDecision(input.adapter, input.model, context, input.signal, repair, (usage) => { inputTokens += usage.inputTokens; outputTokens += usage.outputTokens; });
      await store.appendStep(run.id, { sequence: sequence++, loopIteration: modelCalls, kind: "model_reasoning", goalStatus: "needs_more_action", nextAction: "call_tool", reason: repair ? "根据结构化冲突修正一次重排候选。" : "调用当前选定模型推理合理的重排时间。", input: repair ? { context, conflicts: repair.issues } : context, output: decision, durationMs: Date.now() - startedAt, inputTokens, outputTokens, toolAttemptCount: 0 });
      return decision;
    };

    let decision = await decide();
    if (decision.needsClarification) {
      const text = decision.clarificationQuestion ?? "这两个安排存在无法同时满足的约束，请告诉我你更优先保证哪一项。";
      await store.complete(run.id, text, "awaiting_user_input", "needs_user_input", 0);
      input.emit?.({ type: "text_delta", text });
      input.emit?.({ type: "run_completed", text });
      return { runId: run.id, text, changeSet: null };
    }

    let checked = await validateModelDecision(input.userId, context, decision, input.timezone, input.emit);
    await persistValidationStep(store, run.id, sequence++, checked);
    if (!checked.ok) {
      input.emit?.({ type: "loop_step", kind: "recovery", label: "修正冲突候选", summary: "首个重排方案未通过硬约束校验", goalStatus: "needs_more_action", nextAction: "retry_tool", detail: { result: checked.messages.join("；"), judgment: "只把结构化冲突反馈给模型，不重新读取目标或整段对话。", nextAction: "允许模型修正一次。" } });
      decision = await decide({ prior: decision, issues: checked.issues });
      checked = await validateModelDecision(input.userId, context, decision, input.timezone, input.emit);
      await persistValidationStep(store, run.id, sequence++, checked);
    }
    if (!checked.ok) {
      const text = `我尝试了两次局部重排，仍然受到这些约束影响：${checked.messages.join("；")}。你更希望优先保留哪一个日程的原时间？`;
      await store.complete(run.id, text, "awaiting_user_input", "needs_user_input", 1);
      input.emit?.({ type: "text_delta", text });
      input.emit?.({ type: "run_completed", text });
      return { runId: run.id, text, changeSet: null };
    }

    const revisedOperations = applyReorderDecision(workingOperations, decision);
    const reason = [patchSummary, decision.reasoningSummary, decision.assumptions.length ? `使用的假设：${decision.assumptions.join("；")}` : ""].filter(Boolean).join(" ");
    const draft = revisionDraft(base, revisedOperations, reason);
    const revision = await createChangeSetRevision({ userId: input.userId, baseChangeSetId: base.id, draft, idempotencyKey: `${run.id}:${adjustment.kind}`, agentRunId: run.id, scheduleEvidence: checked.evidence });
    const assumptionText = decision.assumptions.length ? ` 我把这些未核实信息作为假设：${decision.assumptions.join("；")}。` : "";
    const text = patchSummary
      ? `已${patchSummary}，并为新增项推理了合理时段：${decision.reasoningSummary}${assumptionText}其余提案保持不变，请确认修订版后再写入日历。`
      : `我只重新安排了受影响的日程：${decision.reasoningSummary}${assumptionText}其余提案保持不变，请确认修订版后再写入日历。`;
    return await finishWithRevision(store, run.id, sequence, revision, draft, text, input.emit);
  } catch (error) {
    const message = error instanceof Error ? error.message : "提案续接失败。";
    await store.fail(run.id, "PROPOSAL_CONTINUATION_FAILED", message, "runtime_error", 0);
    input.emit?.({ type: "run_failed", code: "PROPOSAL_CONTINUATION_FAILED", message });
    throw error;
  }
}

async function buildReorderContext(userId: string, instruction: string, operations: Array<Record<string, unknown>>, affected: Array<Record<string, unknown> & { operationId: string }>, timezone: string): Promise<ReorderContext> {
  const ranges = affected.map(operationTimeRange);
  const localDates = ranges.flatMap((range) => [zonedDateKey(new Date(range.startsAt), timezone), zonedDateKey(new Date(range.endsAt), timezone)]).sort();
  const from = zonedDateTimeToUtc(localDates[0]!, "06:00:00", timezone);
  const to = zonedDateTimeToUtc(localDates.at(-1)!, "23:59:59", timezone);
  const schedule = buildAgentScheduleWindowResult(await listScheduleBlocks(userId, from, to), from, to, timezone);
  const affectedIds = new Set(affected.map((operation) => operation.operationId));
  const neighboringProposalOperations = scheduleProposalOperations(operations).filter((operation) => !affectedIds.has(operation.operationId)).map((operation) => ({ operationId: operation.operationId, title: operationTitle(operation), ...operationTimeRange(operation) }));
  return {
    timezone,
    instruction,
    window: { startsAt: from.toISOString(), endsAt: to.toISOString() },
    affectedOperations: affected.map((operation) => {
      const payload = operationPayload(operation);
      const range = operationTimeRange(operation);
      return {
        operationId: operation.operationId,
        title: operationTitle(operation),
        blockKind: String(payload.blockKind ?? payload.scheduleKind ?? "schedule"),
        durationMinutes: Math.round((new Date(range.endsAt).getTime() - new Date(range.startsAt).getTime()) / 60_000),
        currentStartsAt: range.startsAt,
        currentEndsAt: range.endsAt,
        fixed: isFixed(operation, payload),
        explicitConstraints: Array.isArray(payload.constraints) ? payload.constraints.map(String).slice(0, 6) : [],
        focusLevel: typeof payload.focusLevel === "string" ? payload.focusLevel : undefined,
        energyLevel: typeof payload.energyLevel === "string" ? payload.energyLevel : undefined,
      };
    }),
    hardConstraints: ["保持每项原时长", "不得移动固定日程", "不得与正式日历或提案内其他日程重叠", "只修改 affectedOperations 中的时间"],
    softConstraints: ["尽量避开本地午餐 11:30-13:30", "尽量避开本地晚餐 18:00-19:30", "结合活动语义、专注需求和用户表达选择合理时段"],
    availableIntervals: schedule.availableIntervals.map(({ startsAt, endsAt }) => ({ startsAt, endsAt })),
    neighboringProposalOperations,
  };
}

const ambiguousTimeDecisionSchema = z.object({
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  reasoningSummary: z.string().min(1).max(240),
  assumptions: z.array(z.string().min(1).max(120)).max(3).default([]),
  needsClarification: z.boolean().default(false),
  clarificationQuestion: z.string().min(1).max(240).optional(),
});

export type AmbiguousTimeContext = {
  timezone: string;
  currentLocalDateTime: string;
  instruction: string;
  timeExpression: string;
  relation: "earlier" | "later" | "neutral";
  target: { operationId: string; title: string; currentStartsAt: string; currentEndsAt: string; currentLocalRange: string };
  neighboringOperations: Array<{ operationId: string; title: string; startsAt: string; endsAt: string }>;
};

export type AmbiguousTimeDecision = z.infer<typeof ambiguousTimeDecisionSchema>;

/**
 * 对“5 点半”这类缺少时段的表达做一次小型结构化推理。
 * 模型只能返回一个 HH:mm；日期、时长、目标 operation 和冲突判断都留在服务端。
 */
export async function interpretAmbiguousProposalTime(
  adapter: ModelAdapter,
  model: string,
  context: AmbiguousTimeContext,
  signal: AbortSignal | undefined,
  onUsage: (usage: { inputTokens: number; outputTokens: number }) => void,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await adapter.generateObject({
      model,
      system: "你是 Rhythm & Routine 的中文时间解释器。用户已经点名一项待确认日程，你只负责把缺少上午/下午的表达解释成最合理的本地 24 小时时间。优先级依次是：用户说的提前/推迟关系、目标项原时间、当前本地日期时间、相邻提案、正常人类作息（通常 06:00-24:00 活动，睡眠时段谨慎）。不得修改日期、时长、活动名称或其他日程，不得声称已检查正式日历。只有两种解释仍同样合理且会显著改变安排时才 needsClarification=true。输出必须精简。",
      prompt: `有界上下文：${JSON.stringify(context)}\n请解释 timeExpression 并输出一个 HH:mm。currentLocalDateTime 是本次请求的真实当前时间；neighboringOperations 只用于语义判断，冲突稍后由服务端校验。`,
      schema: ambiguousTimeDecisionSchema,
      normalize: normalizeAmbiguousTimeDecision,
      maxOutputTokens: 240,
      maxRetries: 0,
      signal: controller.signal,
      onUsage,
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function normalizeAmbiguousTimeDecision(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const outer = value as Record<string, unknown>;
  const raw = outer.timeDecision && typeof outer.timeDecision === "object" && !Array.isArray(outer.timeDecision)
    ? outer.timeDecision as Record<string, unknown>
    : outer;
  const localTime = raw.localTime ?? raw.time ?? raw.startTime;
  if (typeof localTime !== "string") return raw;
  return {
    localTime: localTime.trim(),
    reasoningSummary: String(raw.reasoningSummary ?? raw.reasoning ?? "结合当前时间与原日程解释该时间。 ").trim().slice(0, 240),
    assumptions: Array.isArray(raw.assumptions) ? raw.assumptions.slice(0, 3).map((item) => String(item).slice(0, 120)) : [],
    needsClarification: raw.needsClarification === true || raw.needsClarification === "true",
    ...(typeof raw.clarificationQuestion === "string" ? { clarificationQuestion: raw.clarificationQuestion.slice(0, 240) } : {}),
  };
}

export async function generateReorderDecision(adapter: ModelAdapter, model: string, context: ReorderContext, signal: AbortSignal | undefined, repair: { prior: ReorderDecision; issues: ReorderValidationIssue[] } | undefined, onUsage: (usage: { inputTokens: number; outputTokens: number }) => void) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const modelContext = withLocalTimeProjection(context);
    return await adapter.generateObject({
      model,
      system: "你是 Rhythm & Routine 的局部日程重排器。你必须真正判断什么时间更合理，而不是机械交换时间字段。只能修改 allowlist 中 operation 的起止时间，必须保持时长并遵守硬约束；每个候选必须完整落在某一个 availableIntervals 内，不能自行推断区间之间的空档可用。所有带 Z 的 ISO 时间都是 UTC 绝对时刻；判断上午、下午、饭点和正常作息时必须使用同对象的 localStartsAt/localEndsAt，不得把 01:00Z 描述为本地凌晨 1 点。未由系统验证的营业时间等常识只能写入 assumptions，不能冒充事实。输出结构化 ReorderDecision。顶层必须直接包含 affectedOperationIds、candidates、reasoningSummary、assumptions、needsClarification，禁止再包一层 reorderDecision；candidates 必须为每个 affectedOperations 各返回一项，并使用 startsAt/endsAt 字段。保持简洁：每项 reason 不超过 80 字，reasoningSummary 不超过 240 字，assumptions 最多 3 项且每项不超过 120 字。",
      prompt: repair
        ? `精简上下文：${JSON.stringify(modelContext)}\n首个候选：${JSON.stringify(repair.prior)}\n确定性校验错误：${JSON.stringify(repair.issues)}\n请只修正这些冲突一次。`
        : `精简上下文：${JSON.stringify(modelContext)}\n请根据用户意图和本地时间投影推理合理的新时间；候选仍返回 ISO 绝对时刻。`,
      schema: reorderDecisionSchema,
      normalize: normalizeReorderDecisionResponse,
      maxOutputTokens: 700,
      maxRetries: 0,
      signal: controller.signal,
      onUsage,
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function withLocalTimeProjection(context: ReorderContext) {
  const local = (value: string) => new Intl.DateTimeFormat("sv-SE", { timeZone: context.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
  return {
    ...context,
    affectedOperations: context.affectedOperations.map((operation) => ({ ...operation, currentLocalStartsAt: local(operation.currentStartsAt), currentLocalEndsAt: local(operation.currentEndsAt) })),
    availableIntervals: context.availableIntervals.map((interval) => ({ ...interval, localStartsAt: local(interval.startsAt), localEndsAt: local(interval.endsAt) })),
    neighboringProposalOperations: context.neighboringProposalOperations.map((operation) => ({ ...operation, localStartsAt: local(operation.startsAt), localEndsAt: local(operation.endsAt) })),
  };
}

async function validateModelDecision(userId: string, context: ReorderContext, decision: ReorderDecision, timezone: string, emit?: (event: RunEvent) => void) {
  const deterministic = validateReorderDecision(context, decision);
  const formal = await validateCandidates(userId, decision.candidates.map((candidate) => ({ label: candidate.operationId, startsAt: candidate.startsAt, endsAt: candidate.endsAt })), timezone, emit);
  const formalIssues: ReorderValidationIssue[] = formal.result.candidates.flatMap((candidate) => candidate.available ? [] : [{ code: "PROPOSAL_CONFLICT" as const, operationId: candidate.label, message: candidate.conflicts.length ? `${candidate.label} 与正式日程 ${candidate.conflicts.map((conflict) => conflict.title).join("、")} 冲突。` : `${candidate.label} 的候选时间无效。` }]);
  const issues = [...deterministic.issues, ...formalIssues];
  return { ok: issues.length === 0, issues, messages: issues.map((issue) => issue.message), evidence: formal.evidence, toolResult: formal.result };
}

async function validateRevisionSchedule(userId: string, operations: Array<Record<string, unknown>>, changedOperationIds: string[], timezone: string, emit?: (event: RunEvent) => void) {
  const targetIds = new Set(changedOperationIds);
  const candidates = scheduleProposalOperations(operations).filter((operation) => targetIds.has(operation.operationId)).map((operation) => ({ label: operation.operationId, ...operationTimeRange(operation) }));
  const formal = await validateCandidates(userId, candidates, timezone, emit);
  const overlaps = findProposalOverlaps(operations);
  const messages = [
    ...formal.result.candidates.flatMap((candidate) => candidate.available ? [] : [candidate.conflicts.length ? `${candidate.label} 与 ${candidate.conflicts.map((conflict) => conflict.title).join("、")} 冲突` : `${candidate.label} 时间无效`]),
    ...overlaps.map((conflict) => conflict.message),
  ];
  return { ok: formal.result.allAvailable && overlaps.length === 0, messages, issues: overlaps.map((conflict) => ({ code: "PROPOSAL_CONFLICT" as const, operationId: conflict.leftOperationId, message: conflict.message })), evidence: formal.evidence, toolResult: formal.result };
}

async function validateCandidates(userId: string, candidates: Array<{ label?: string; startsAt: string; endsAt: string }>, timezone: string, emit?: (event: RunEvent) => void) {
  const from = new Date(Math.min(...candidates.map((candidate) => new Date(candidate.startsAt).getTime())));
  const to = new Date(Math.max(...candidates.map((candidate) => new Date(candidate.endsAt).getTime())));
  const toolCallId = crypto.randomUUID();
  emit?.({ type: "tool_started", tool: "validate_schedule_candidates", toolCallId, input: { candidates } });
  const schedule = buildAgentScheduleWindowResult(await listScheduleBlocks(userId, from, to), from, to, timezone);
  const result = validateScheduleCandidates(candidates, schedule);
  emit?.({ type: "tool_completed", tool: "validate_schedule_candidates", toolCallId, input: { candidates }, result: { ok: true, data: result } });
  const fingerprint = createHash("sha256").update(JSON.stringify(schedule.items.map((item) => [item.id, item.status, item.startsAt, item.endsAt]))).digest("hex");
  const evidence = json({ resourceKey: `schedule:${from.toISOString()}:${to.toISOString()}`, from: from.toISOString(), to: to.toISOString(), fingerprint, observedAt: new Date().toISOString(), operationIds: candidates.map((candidate) => candidate.label).filter(Boolean) });
  return { result, evidence, toolCallId, input: { candidates } };
}

async function persistValidationStep(store: PrismaRunStore, runId: string, sequence: number, validation: { ok: boolean; messages: string[]; toolResult: unknown }) {
  await store.appendStep(runId, {
    sequence,
    kind: "tool",
    goalStatus: validation.ok ? "needs_more_action" : "needs_user_input",
    nextAction: validation.ok ? "propose_change_set" : "ask_user",
    reason: validation.ok ? "只重新校验受影响时间，候选通过。" : `受影响时间未通过：${validation.messages.join("；")}`,
    output: validation.toolResult,
    toolAttemptCount: 1,
    toolCalls: [{ name: "validate_schedule_candidates", risk: "read", input: {}, output: { ok: true, data: validation.toolResult }, ok: true }],
  });
}

async function finishWithRevision(store: PrismaRunStore, runId: string, sequence: number, revision: StoredRevision, draft: ChangeSetDraft, text: string, emit?: (event: RunEvent) => void): Promise<ProposalContinuationResult> {
  await store.appendStep(runId, { sequence, kind: "decision", goalStatus: "awaiting_confirmation", nextAction: "propose_change_set", reason: "已生成新的 ChangeSet revision；旧版本已原子标记为 superseded。", output: { changeSetId: revision.id, revision: revision.revision, supersedesChangeSetId: revision.supersedesChangeSetId } });
  await store.markAwaitingConfirmation(runId, revision.id, text, 0);
  emit?.({ type: "loop_step", kind: "decision", label: "生成修订版", summary: `已生成第 ${revision.revision} 版待确认草案`, goalStatus: "awaiting_confirmation", nextAction: "propose_change_set", detail: { result: `新版本 ${revision.id}；旧版本 ${revision.supersedesChangeSetId ?? "无"} 已不可应用`, judgment: "正式日历尚未写入。", nextAction: "等待用户确认最新版本。" } });
  emit?.({ type: "approval_required", changeSetId: revision.id });
  emit?.({ type: "text_delta", text });
  return { runId, text, changeSet: { ...draft, id: revision.id, revision: revision.revision, supersedesChangeSetId: revision.supersedesChangeSetId ?? undefined } };
}

function revisionDraft(base: { title: string; riskLevel: string }, operations: Array<Record<string, unknown>>, reason: string): ChangeSetDraft {
  return {
    title: `${base.title.replace(/（第\s*\d+\s*版）$/, "")}（修订版）`,
    reason,
    riskLevel: base.riskLevel === "low" || base.riskLevel === "high" ? base.riskLevel : "medium",
    operations: operations as ChangeSetDraft["operations"],
  };
}

function createAddedProposalOperation(input: {
  baseChangeSetId: string;
  prompt: string;
  title: string;
  durationMinutes: number;
  anchor: Record<string, unknown> & { operationId: string };
  startTime?: string;
  timezone: string;
}): Record<string, unknown> & { operationId: string } {
  const anchorRange = operationTimeRange(input.anchor);
  const anchorStart = new Date(anchorRange.startsAt);
  if (Number.isNaN(anchorStart.getTime())) throw new Error("上一份提案缺少可用于新增事项的有效日期。");
  const startsAt = input.startTime
    ? zonedDateTimeToUtc(zonedDateKey(anchorStart, input.timezone), `${input.startTime}:00`, input.timezone)
    : anchorStart;
  const durationMinutes = Math.min(720, Math.max(5, Math.round(input.durationMinutes)));
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);
  const operationId = `op-new-${createHash("sha256").update(`${input.baseChangeSetId}:${input.prompt}:${input.title}`).digest("hex").slice(0, 16)}`;
  return {
    operationId,
    type: "create",
    entity: "personal_schedule",
    payload: {
      title: input.title,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      blockKind: "personal",
      constraints: input.startTime ? [] : ["当前起止时间仅用于确定日期和时长，需由模型选择合理时段"],
    },
  };
}

async function validParentRunId(userId: string, runId?: string) {
  if (!runId) return undefined;
  return (await getDb().agentRun.findFirst({ where: { id: runId, userId }, select: { id: true } }))?.id;
}

function formatLocalRange(startsAt: string, endsAt: string, timezone: string) {
  const format = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
  return `${format(startsAt)}–${format(endsAt)}`;
}

function formatLocalDateTime(value: Date, timezone: string) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value);
}

function respectsTimeRelation(localTime: string, currentStartsAt: string, relation: "earlier" | "later" | "neutral" | undefined, timezone: string) {
  if (!relation || relation === "neutral") return true;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(currentStartsAt)).split(":");
  const currentMinutes = Number(parts[0]) * 60 + Number(parts[1]);
  const [hour, minute] = localTime.split(":").map(Number);
  const candidateMinutes = hour * 60 + minute;
  return relation === "later" ? candidateMinutes > currentMinutes : candidateMinutes < currentMinutes;
}

function json(value: unknown) { return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue; }
