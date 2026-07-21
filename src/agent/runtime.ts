import { capabilityPolicies } from "./capabilities";
import { buildAgentContextSummary } from "./context-builder";
import { serializeCompactToolResult, ToolEvidenceLedger } from "./tool-evidence-ledger";
import { AgentExitReason, AgentRunRequest, AgentTool, LoopGoalStatus, LoopNextAction, ModelAdapter, ModelMessage, RunEvent, ToolResult } from "./types";
import { executeScheduledBatch, scheduleToolCalls, type PendingToolCall } from "./tool-scheduler";

export type AgentRunStore = {
  create(input: { userId: string; capability: string; provider: string; model: string; contextManifest: unknown; inputSummary?: string; maxSteps: number; maxTokens: number; intentResolution?: unknown; executionPlan?: unknown; contextMetrics?: unknown; conversationId?: string; parentRunId?: string; continuationKind?: string; continuationState?: unknown }): Promise<{ id: string }>;
  appendStep(runId: string, step: { sequence: number; loopIteration?: number; kind: string; goalStatus?: LoopGoalStatus; nextAction?: LoopNextAction; reason?: string; missingInformation?: string[]; toolAttemptCount?: number; input?: unknown; output?: unknown; durationMs?: number; inputTokens?: number; outputTokens?: number; toolCalls?: Array<{ toolCallId?: string; batchId?: string; completionOrder?: number; name: string; risk: AgentTool["risk"]; input: unknown; output?: unknown; ok: boolean; errorCode?: string; durationMs?: number }> }): Promise<void>;
  markAwaitingConfirmation(runId: string, changeSetId: string, summary: string, retryCount: number): Promise<void>;
  complete(runId: string, finalText: string, exitReason: AgentExitReason, goalStatus: LoopGoalStatus, retryCount: number): Promise<void>;
  fail(runId: string, code: string, message: string, exitReason: AgentExitReason, retryCount: number): Promise<void>;
  /** 取消一个正在运行或等待确认的 Run */
  cancel(runId: string, reason?: string): Promise<void>;
};

/**
 * 在运行时兜底保证一次性日程草案不会绕过当前窗口检查。
 * 相似历史只提供候选顺序，因此调用后必须重新检查实际日程窗口。
 */
export function validateSchedulePlanningPrerequisites(
  toolName: string,
  input: unknown,
  successfulToolNames: string[],
  successfulTools: Array<{ name: string; input: unknown; data: unknown }> = [],
): ToolResult | null {
  if (toolName !== "propose_change_set" || !input || typeof input !== "object") return null;
  const operations = (input as { operations?: unknown[] }).operations;
  const changesConcreteSchedule = Array.isArray(operations) && operations.some((operation) => {
    if (!operation || typeof operation !== "object") return false;
    const item = operation as { entity?: unknown; type?: unknown };
    return (item.entity === "schedule" || item.entity === "personal_schedule")
      && (item.type === "create" || item.type === "update");
  });
  if (!changesConcreteSchedule) return null;

  const lastScheduleCheck = successfulToolNames.lastIndexOf("read_schedule_window");
  const lastHabitLookup = successfulToolNames.lastIndexOf("read_similar_schedule_history");
  if (lastScheduleCheck < 0 || lastScheduleCheck < lastHabitLookup) {
    return {
      ok: false,
      code: "SCHEDULE_WINDOW_REQUIRED",
      message: lastScheduleCheck < 0
        ? "生成一次性日程草案前，必须先用 read_schedule_window 检查候选时段是否与现有日程重叠。"
        : "参考历史习惯后，必须再次用 read_schedule_window 检查本次候选时段，再生成草案。",
      retryable: true,
    };
  }
  const lastCandidateValidation = successfulToolNames.lastIndexOf("validate_schedule_candidates");
  if (lastCandidateValidation < lastScheduleCheck) {
    return {
      ok: false,
      code: "SCHEDULE_CANDIDATE_VALIDATION_REQUIRED",
      message: "生成具体日程草案前，必须用 validate_schedule_candidates 校验最终候选时段。",
      retryable: true,
    };
  }
  const validation = [...successfulTools].reverse().find((tool) => tool.name === "validate_schedule_candidates");
  const validationData = validation?.data as { allAvailable?: boolean; candidates?: Array<{ startsAt?: string; endsAt?: string }> } | undefined;
  if (!validationData?.allAvailable) {
    return {
      ok: false,
      code: "SCHEDULE_CONFLICT",
      message: "最终候选中仍有日程冲突，请调整时间并重新校验。",
      retryable: true,
    };
  }
  const proposed = extractConcreteScheduleCandidates(operations);
  const validated = new Set((validationData.candidates ?? []).flatMap((candidate) => {
    const key = scheduleCandidateKey(candidate.startsAt, candidate.endsAt);
    return key ? [key] : [];
  }));
  if (proposed.some((candidate) => !validated.has(candidate))) {
    return {
      ok: false,
      code: "SCHEDULE_CANDIDATE_CHANGED",
      message: "草案中的候选时间与最后一次校验不一致，请重新校验草案中的实际时间。",
      retryable: true,
    };
  }
  return null;
}

function extractConcreteScheduleCandidates(operations: unknown[]) {
  return operations.flatMap((operation) => {
    if (!operation || typeof operation !== "object") return [];
    const item = operation as { entity?: unknown; type?: unknown; payload?: unknown; after?: unknown };
    if ((item.entity !== "schedule" && item.entity !== "personal_schedule") || (item.type !== "create" && item.type !== "update")) return [];
    const values = item.type === "create" ? item.payload : item.after;
    if (!values || typeof values !== "object") return [];
    const candidate = values as { startsAt?: string; endsAt?: string };
    const key = scheduleCandidateKey(candidate.startsAt, candidate.endsAt);
    return key ? [key] : [];
  });
}

function scheduleCandidateKey(startsAt?: string, endsAt?: string) {
  if (!startsAt || !endsAt) return null;
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return `${start.toISOString()}|${end.toISOString()}`;
}

export class AgentRuntime {
  constructor(
    private readonly model: ModelAdapter,
    private readonly tools: Map<string, AgentTool>,
    private readonly store: AgentRunStore,
  ) {}

  async *run(request: AgentRunRequest): AsyncGenerator<RunEvent> {
    const policy = capabilityPolicies[request.capability];
    const run = await this.store.create({
      userId: request.userId,
      capability: request.capability,
      provider: this.model.provider,
      model: request.model,
      contextManifest: request.context.manifest,
      inputSummary: request.prompt,
      maxSteps: policy.maxSteps,
      maxTokens: policy.maxRunTokens,
      intentResolution: request.intentResolution,
      executionPlan: request.executionPlan,
      contextMetrics: request.context.sourceMetrics,
      conversationId: request.conversationId,
      parentRunId: request.parentRunId,
      continuationKind: request.intentResolution?.adjustment?.kind,
    });
    yield { type: "run_started", runId: run.id };

    const baseMessages: ModelMessage[] = [
      ...request.context.conversation.recentMessages,
      { role: "user", content: request.prompt },
    ];
    let pendingToolMessages: ModelMessage[] = [];
    const evidenceLedger = new ToolEvidenceLedger();
    let finalText = "";
    const runStartedAt = Date.now();
    let totalTokens = 0;
    let stepSequence = 1;
    let failureRecoveryCount = 0;
    const successfulToolNames: string[] = [];
    const successfulTools: Array<{ name: string; input: unknown; data: unknown }> = [];
    const readCache = new Map<string, ToolResult>();
    const maxTokens = policy.maxRunTokens;
    const contextSummary = buildAgentContextSummary(
      request.context.business,
      request.context.page,
      request.context.user.timezone,
      request.prompt,
      request.context.conversation.summary,
    );

    try {
      const intentSummary = request.intentResolution?.intents.map((intent) => intent.capability).join(" + ") || request.capability;
      const planningReason = request.intentResolution?.needsClarification
        ? `已识别 ${intentSummary}，仍有阻塞信息需要先澄清：${request.intentResolution.clarificationReason ?? "关键信息不足"}。`
        : `已识别 ${intentSummary}，并形成 ${request.executionPlan?.steps.length ?? 1} 个可观测步骤。`;
      await this.store.appendStep(run.id, { sequence: stepSequence++, loopIteration: 0, kind: "planning", goalStatus: "needs_more_action", nextAction: request.intentResolution?.needsClarification ? "ask_user" : "call_tool", reason: planningReason, input: { prompt: request.prompt, selectedEntity: request.context.page?.selectedEntity, intentResolution: request.intentResolution, executionPlan: request.executionPlan, contextMetrics: request.context.sourceMetrics } });
      yield { type: "loop_step", kind: "planning", label: "理解目标", summary: request.intentResolution?.intents.length && request.intentResolution.intents.length > 1 ? `已识别 ${request.intentResolution.intents.length} 个意图并排好顺序` : "已结合当前消息、页面和对话识别意图", goalStatus: "needs_more_action", nextAction: request.intentResolution?.needsClarification ? "ask_user" : "call_tool", detail: { scope: `意图：${intentSummary}；计划：${request.executionPlan?.steps.map((step) => step.objective).join(" → ") ?? "最小执行步骤"}`, judgment: planningReason, nextAction: request.intentResolution?.needsClarification ? "只询问仍阻塞执行的关键信息。" : "按依赖读取证据，必要时生成待确认草案。" } };

      for (let loopIteration = 1; loopIteration <= policy.maxSteps; loopIteration += 1) {
        if (Date.now() - runStartedAt > 120_000) throw new AgentRuntimeError("MAX_DURATION", "小律已达到本次运行的 120 秒时限。计划没有被修改。", "stopped_by_time_budget");
        if (totalTokens >= maxTokens) throw new AgentRuntimeError("MAX_TOKENS", "小律已达到本次运行的 Token 上限。计划没有被修改。", "stopped_by_token_budget");
        const startedAt = Date.now();
        let calledTool = false;
        let bufferedScheduleText = "";
        const bufferScheduleAnswer = successfulToolNames.includes("read_schedule_window");
        let inputTokens: number | undefined; let outputTokens: number | undefined;
        const toolCalls: NonNullable<Parameters<AgentRunStore["appendStep"]>[1]["toolCalls"]> = [];
        const nextToolMessages: ModelMessage[] = [];
        const allowedToolNames = request.intentResolution?.route === "non_execution"
          ? []
          : [...new Set((request.intentResolution?.intents.length ? request.intentResolution.intents.map((intent) => capabilityPolicies[intent.capability].allowedTools) : [policy.allowedTools]).flat())];
        const availableTools = allowedToolNames.map((name) => this.tools.get(name)).filter((tool): tool is AgentTool => Boolean(tool));
        const evidence = evidenceLedger.toSystemContext();
        const budgetGuidance = buildBudgetGuidance(totalTokens, maxTokens);
        const system = [
          policy.system,
          request.intentResolution ? `结构化意图：${JSON.stringify(request.intentResolution)}\n执行计划：${JSON.stringify(request.executionPlan ?? null)}\n严格按意图顺序完成；只在 missingSlots 阻塞安全执行时询问。` : "",
          request.intentResolution?.adjustment?.kind === "itinerary_create" ? "这是明确的一日或多日行程安排请求。最终候选通过校验后必须调用 propose_change_set 创建待确认草案；不能只输出文字方案后再问用户要不要生成。" : "",
          request.context.sourceMetrics?.some((metric) => !metric.ok) ? `上下文降级：${request.context.sourceMetrics.filter((metric) => !metric.ok).map((metric) => `${metric.source}:${metric.error ?? "读取失败"}`).join("；")}。不要把缺失数据当成零；危险步骤前可用工具补读。` : "",
          `当前上下文摘要：\n${contextSummary}`,
          evidence ? `已验证工具证据（精简账本；应继续作为事实使用，不要因原始工具消息已压缩而重复查询）：\n${evidence}` : "",
          budgetGuidance,
        ].filter(Boolean).join("\n");
        const events = this.model.stream({ model: request.model, system, messages: [...baseMessages, ...pendingToolMessages], tools: availableTools, maxOutputTokens: policy.maxOutputTokens }, request.signal);
        const pendingCalls: PendingToolCall[] = [];

        for await (const event of events) {
          if (event.type === "text_delta") {
            if (bufferScheduleAnswer) bufferedScheduleText += event.text;
            else { finalText += event.text; yield event; }
          }
          if (event.type === "model_fallback") yield event;
          if (event.type === "usage") { inputTokens = event.inputTokens; outputTokens = event.outputTokens; totalTokens += event.inputTokens + event.outputTokens; }
          if (event.type === "tool_call") {
            const tool = this.tools.get(event.name);
            if (!tool || !allowedToolNames.includes(event.name)) throw new AgentRuntimeError("TOOL_NOT_ALLOWED", `工具 ${event.name} 未被当前意图授权。`, "blocked_by_tool_error");
            pendingCalls.push({ id: event.id || crypto.randomUUID(), name: event.name, input: event.input, tool, originalIndex: pendingCalls.length });
          }
        }
        if (pendingCalls.length) {
          calledTool = true;
          const scheduled = scheduleToolCalls(pendingCalls, successfulToolNames, 3);
          const completed: Array<{ call: PendingToolCall; result: ToolResult; durationMs: number; batchId: string; completedAt: number; completionOrder: number }> = [];
          let completionOrder = 0;
          for (const call of pendingCalls) yield { type: "tool_started", tool: call.name, toolCallId: call.id, input: call.input };
          for (const rejected of scheduled.rejected) {
            completionOrder += 1;
            completed.push({ call: rejected, result: rejected.result, durationMs: 0, batchId: "rejected", completedAt: Date.now(), completionOrder });
            evidenceLedger.record(rejected.name, rejected.input, rejected.result);
            yield { type: "tool_completed", tool: rejected.name, toolCallId: rejected.id, input: rejected.input, result: rejected.result };
          }
          for (const batch of scheduled.batches) {
            const batchResults = await executeScheduledBatch(batch, async (call) => {
              const toolStartedAt = Date.now();
              const cacheKey = call.tool.risk === "read" && call.name !== "validate_schedule_candidates" ? `${call.name}:${stableJson(call.input)}` : undefined;
              const cached = cacheKey ? readCache.get(cacheKey) : undefined;
              if (cached) return { result: cached, durationMs: 0 };
              const prerequisiteError = validateSchedulePlanningPrerequisites(call.name, call.input, successfulToolNames, successfulTools);
              const latestScheduleEvidence = [...successfulTools].reverse().find((item) => item.name === "validate_schedule_candidates")?.data as { scheduleEvidence?: unknown } | undefined;
              const result = prerequisiteError ?? await this.executeTool(call.tool, call.input, { userId: request.userId, runId: run.id, idempotencyKey: buildToolIdempotencyKey(run.id, loopIteration, call), scheduleEvidence: latestScheduleEvidence?.scheduleEvidence });
              if (cacheKey && result.ok) readCache.set(cacheKey, result);
              return { result, durationMs: Date.now() - toolStartedAt };
            });
            for (const item of [...batchResults].sort((left, right) => left.completedAt - right.completedAt || left.call.originalIndex - right.call.originalIndex)) {
              completionOrder += 1;
              completed.push({ call: item.call, result: item.value.result, durationMs: item.value.durationMs, batchId: batch.id, completedAt: item.completedAt, completionOrder });
              // 依赖批次必须立即看到上一批的实际成功证据；提供给模型的 tool message 顺序仍在下方恢复为原调用顺序。
              if (item.value.result.ok) {
                successfulToolNames.push(item.call.name);
                successfulTools.push({ name: item.call.name, input: item.call.input, data: item.value.result.data });
              }
              evidenceLedger.record(item.call.name, item.call.input, item.value.result);
              yield { type: "tool_completed", tool: item.call.name, toolCallId: item.call.id, input: item.call.input, result: item.value.result };
            }
          }

          const orderedResults = [...completed].sort((left, right) => left.call.originalIndex - right.call.originalIndex);
          let fatalToolError: AgentRuntimeError | null = null;
          for (const item of orderedResults) {
            toolCalls.push({ toolCallId: item.call.id, batchId: item.batchId, completionOrder: item.completionOrder, name: item.call.name, risk: item.call.tool.risk, input: item.call.input, output: item.result, ok: item.result.ok, errorCode: item.result.ok ? undefined : item.result.code, durationMs: item.durationMs });
            if (!item.result.ok) {
              failureRecoveryCount += 1;
              const nextAction: LoopNextAction = item.result.retryable ? "retry_tool" : "stop";
              const reason = item.result.retryable
                ? `工具 ${item.call.name} 返回 ${item.result.code}，将把错误反馈给模型，让它修正参数、换工具或追问用户。`
                : `工具 ${item.call.name} 返回不可重试错误 ${item.result.code}，停止自动推进。`;
              const prerequisiteRecovery = ["SCHEDULE_WINDOW_REQUIRED", "SCHEDULE_CANDIDATE_VALIDATION_REQUIRED", "TOOL_EVIDENCE_REQUIRED", "STALE_DRAFT_BATCH"].includes(item.result.code);
              yield { type: "loop_step", kind: "recovery", label: prerequisiteRecovery ? "补充必要校验" : "工具失败恢复", summary: item.result.message, goalStatus: "needs_more_action", nextAction, detail: { result: item.result.message, judgment: reason, nextAction: item.result.retryable ? "修正参数、换工具或追问用户。" : "停止并解释原因。" } };
              if (!item.result.retryable) fatalToolError = new AgentRuntimeError(item.result.code, item.result.message, "blocked_by_tool_error");
              if (failureRecoveryCount >= 5) fatalToolError = new AgentRuntimeError("MAX_RETRIES", `工具失败恢复已达到 5 次，最近一次失败：${item.result.message}`, "stopped_by_max_retries");
            }
          }
          nextToolMessages.push({ role: "assistant", content: "", toolCalls: pendingCalls.map((call) => ({ id: call.id, name: call.name, input: call.input })) });
          nextToolMessages.push(...orderedResults.map((item) => ({ role: "tool" as const, toolCallId: item.call.id, content: serializeCompactToolResult(item.call.name, item.result) })));

          const draftResult = orderedResults.find((item) => item.call.tool.risk === "draft_write" && item.result.ok);
          if (draftResult?.result.ok) {
            const changeSetId = (draftResult.result.data as { changeSetId: string }).changeSetId;
            const reason = "写操作已生成待确认 ChangeSet；Agent 的目标是产出草案，正式应用必须等待用户确认。";
            await this.store.appendStep(run.id, { sequence: stepSequence++, loopIteration, kind: "tool", goalStatus: "awaiting_confirmation", nextAction: "propose_change_set", reason, output: finalText.slice(-1000), durationMs: Date.now() - startedAt, inputTokens, outputTokens, toolAttemptCount: toolCalls.length, toolCalls });
            await this.store.appendStep(run.id, { sequence: stepSequence++, loopIteration, kind: "verification", goalStatus: "awaiting_confirmation", nextAction: "propose_change_set", reason, output: draftResult.result, durationMs: Date.now() - startedAt, toolAttemptCount: toolCalls.length });
            await this.store.appendStep(run.id, { sequence: stepSequence++, loopIteration, kind: "decision", goalStatus: "awaiting_confirmation", nextAction: "propose_change_set", reason, output: { changeSetId }, durationMs: Date.now() - startedAt, toolAttemptCount: toolCalls.length });
            yield { type: "loop_step", kind: "verification", label: "验证工具结果", summary: "已生成可确认的变更草案", goalStatus: "awaiting_confirmation", nextAction: "propose_change_set", detail: { result: `ChangeSet ${changeSetId} 已创建。`, judgment: "草案生成成功，正式计划尚未修改。", nextAction: "等待用户确认草案。" } };
            yield { type: "loop_step", kind: "decision", label: "判断目标状态", summary: "目标已达成，等待确认", goalStatus: "awaiting_confirmation", nextAction: "propose_change_set", detail: { judgment: reason, nextAction: "暂停 Agent Loop，交给审批流程。" } };
            await this.store.markAwaitingConfirmation(run.id, changeSetId, finalText || reason, failureRecoveryCount);
            yield { type: "approval_required", changeSetId };
            return;
          }
          if (fatalToolError) {
            await this.store.appendStep(run.id, { sequence: stepSequence++, loopIteration, kind: "tool", goalStatus: "blocked", nextAction: "stop", reason: fatalToolError.message, durationMs: Date.now() - startedAt, inputTokens, outputTokens, toolAttemptCount: toolCalls.length, toolCalls });
            throw fatalToolError;
          }
        }
        if (!calledTool && bufferedScheduleText && needsCandidateValidationBeforeFinal(bufferedScheduleText, successfulToolNames, successfulTools)) {
          failureRecoveryCount += 1;
          const reason = "模型准备输出具体时间建议，但尚未完成最终候选校验；已拦截这段未验证回复并要求继续调用工具。";
          baseMessages.push({ role: "user", content: "你正在提出具体日程时间，但尚未证明这些最终候选无冲突。请先调用 validate_schedule_candidates 校验回复中准备推荐的每一个具体候选；若有冲突，调整后重新校验，再输出结论。" });
          await this.store.appendStep(run.id, { sequence: stepSequence++, loopIteration, kind: "recovery", goalStatus: "needs_more_action", nextAction: "call_tool", reason, output: { interceptedChars: bufferedScheduleText.length }, durationMs: Date.now() - startedAt, inputTokens, outputTokens, toolAttemptCount: 0 });
          yield { type: "loop_step", kind: "recovery", label: "补充候选时间校验", summary: "具体时间仍需核对冲突", goalStatus: "needs_more_action", nextAction: "call_tool", detail: { judgment: reason, nextAction: "校验最终候选时段后再回复。" } };
          continue;
        }
        if (!calledTool && bufferedScheduleText && request.intentResolution?.adjustment?.kind === "itinerary_create" && !successfulToolNames.includes("propose_change_set")) {
          failureRecoveryCount += 1;
          const reason = "模型已经形成并校验具体行程，但尚未创建结构化待确认提案；已拦截纯文字结束。";
          baseMessages.push({ role: "user", content: "这是明确的行程安排请求。不要再次读取已经具备的证据，也不要只输出文字方案；请直接用刚刚通过校验的候选调用 propose_change_set，生成待确认草案。" });
          await this.store.appendStep(run.id, { sequence: stepSequence++, loopIteration, kind: "recovery", goalStatus: "needs_more_action", nextAction: "propose_change_set", reason, output: { interceptedChars: bufferedScheduleText.length }, durationMs: Date.now() - startedAt, inputTokens, outputTokens, toolAttemptCount: 0 });
          yield { type: "loop_step", kind: "recovery", label: "生成结构化提案", summary: "候选已校验，正在创建待确认草案", goalStatus: "needs_more_action", nextAction: "propose_change_set", detail: { judgment: reason, nextAction: "复用现有证据创建 ChangeSet。" } };
          continue;
        }
        if (!calledTool && bufferedScheduleText) {
          finalText += bufferedScheduleText;
          yield { type: "text_delta", text: bufferedScheduleText };
        }
        const loopReason = calledTool
          ? "本轮工具结果已写回模型上下文，继续判断是否还需要更多动作。"
          : "现有信息已经足够，模型已完成判断并准备输出最终回复。";
        const loopKind = calledTool ? "verification" : "decision";
        const loopLabel = calledTool ? "验证工具结果" : "确认处理结束";
        const loopSummary = calledTool ? "已把工具结果交回模型继续判断" : "信息已足够，准备输出最终回复";
        const loopResult = calledTool ? summarizeToolCalls(toolCalls) : "本轮无需继续调用工具。";
        await this.store.appendStep(run.id, { sequence: stepSequence++, loopIteration, kind: calledTool ? "tool" : "model", goalStatus: calledTool ? "needs_more_action" : "achieved", nextAction: calledTool ? "call_tool" : "final_answer", reason: loopReason, output: finalText.slice(-1000), durationMs: Date.now() - startedAt, inputTokens, outputTokens, toolAttemptCount: toolCalls.length, toolCalls });
        await this.store.appendStep(run.id, { sequence: stepSequence++, loopIteration, kind: loopKind, goalStatus: calledTool ? "needs_more_action" : "achieved", nextAction: calledTool ? "call_tool" : "final_answer", reason: loopReason, output: loopResult, durationMs: Date.now() - startedAt, toolAttemptCount: toolCalls.length });
        if (!calledTool) {
          yield { type: "loop_step", kind: loopKind, label: loopLabel, summary: loopSummary, goalStatus: "achieved", nextAction: "final_answer", detail: { result: loopResult, judgment: loopReason, nextAction: "输出最终回复。" } };
        }
        if (calledTool) pendingToolMessages = nextToolMessages;
        if (!calledTool) {
          await this.store.appendStep(run.id, { sequence: stepSequence++, loopIteration, kind: "final", goalStatus: "achieved", nextAction: "final_answer", reason: "用户目标已通过最终回复完成。", output: finalText.slice(-1000), durationMs: Date.now() - startedAt, toolAttemptCount: toolCalls.length });
          yield { type: "loop_step", kind: "final", label: "输出最终结果", summary: "Run 已完成", goalStatus: "achieved", nextAction: "final_answer", detail: { judgment: "用户目标已通过最终回复完成。", nextAction: "结束本次 Run。" } };
          await this.store.complete(run.id, finalText, "goal_achieved", "achieved", failureRecoveryCount);
          yield { type: "run_completed", text: finalText };
          return;
        }
      }
      throw new AgentRuntimeError("MAX_STEPS", "小律已达到本次运行的最大步骤数。计划没有被修改。", "stopped_by_max_steps");
    } catch (error) {
      const normalized = error instanceof AgentRuntimeError ? error : new AgentRuntimeError("RUNTIME_ERROR", error instanceof Error ? error.message : "未知运行错误", "runtime_error");
      await this.store.appendStep(run.id, { sequence: stepSequence++, kind: "final", goalStatus: "blocked", nextAction: "stop", reason: normalized.message, output: { code: normalized.code, exitReason: normalized.exitReason }, toolAttemptCount: failureRecoveryCount });
      yield { type: "loop_step", kind: "final", label: "停止执行", summary: normalized.message, goalStatus: "blocked", nextAction: "stop", detail: { result: normalized.code, judgment: normalized.message, nextAction: "停止本次 Run，并向用户说明原因。" } };
      await this.store.fail(run.id, normalized.code, normalized.message, normalized.exitReason, failureRecoveryCount);
      yield { type: "run_failed", code: normalized.code, message: normalized.message };
    }
  }

  private async executeTool(tool: AgentTool, input: unknown, context: Parameters<AgentTool["execute"]>[1]): Promise<ToolResult> {
    const MAX_SCHEMA_RETRIES = 2;
    const lastInput = input;
    for (let attempt = 0; attempt <= MAX_SCHEMA_RETRIES; attempt += 1) {
      const parsed = tool.inputSchema.safeParse(lastInput);
      if (!parsed.success) {
        if (attempt === MAX_SCHEMA_RETRIES) {
          // 耗尽修复次数，保存错误摘要并标记不可重试
          return { ok: false, code: "TOOL_SCHEMA_EXHAUSTED", message: `工具 ${tool.name} 参数校验失败（已尝试 ${MAX_SCHEMA_RETRIES + 1} 次）：${parsed.error.message.slice(0, 400)}`, retryable: false };
        }
        // 允许模型在 retryable 错误时重新提交（此处返回 retryable，Loop 会追加到消息并继续）
        return { ok: false, code: "INVALID_TOOL_INPUT", message: `工具 ${tool.name} 参数格式有误，请按以下错误修正后重新调用：${parsed.error.message.slice(0, 400)}`, retryable: true };
      }
      try {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            tool.execute(parsed.data, context),
            new Promise<ToolResult>((resolve) => {
              timeout = setTimeout(() => resolve({ ok: false, code: "TOOL_TIMEOUT", message: "工具调用超过 15 秒，已安全停止等待。", retryable: true }), 15_000);
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      } catch (error) {
        return { ok: false, code: "TOOL_EXECUTION_FAILED", message: error instanceof Error ? error.message : "工具执行失败", retryable: true };
      }
    }
    return { ok: false, code: "TOOL_SCHEMA_EXHAUSTED", message: `工具 ${tool.name} 修复循环异常终止`, retryable: false };
  }
}

export function needsCandidateValidationBeforeFinal(
  text: string,
  successfulToolNames: string[],
  successfulTools: Array<{ name: string; input: unknown; data: unknown }>,
) {
  const hasConcreteRange = /(?:[01]?\d|2[0-3]):[0-5]\d\s*(?:-|–|—|~|至)\s*(?:[01]?\d|2[0-3]):[0-5]\d/.test(text);
  const recommendsSchedule = /(?:建议|推荐|可以|准备|希望)[\s\S]{0,80}(?:安排|创建|放在|改到)|(?:为你|帮你)[\s\S]{0,30}(?:安排|创建|放在|改到)/.test(text);
  if (!hasConcreteRange || !recommendsSchedule) return false;
  const lastScheduleCheck = successfulToolNames.lastIndexOf("read_schedule_window");
  const lastValidation = successfulToolNames.lastIndexOf("validate_schedule_candidates");
  if (lastValidation < lastScheduleCheck) return true;
  const validation = [...successfulTools].reverse().find((tool) => tool.name === "validate_schedule_candidates");
  const validationData = validation?.data as { allAvailable?: boolean; candidates?: Array<{ localStartsAt?: string | null; localEndsAt?: string | null }> } | undefined;
  if (!validationData?.allAvailable) return true;
  const recommendedRanges = [...text.matchAll(/(?:建议|推荐|可以|准备|希望|为你|帮你)[\s\S]{0,120}?(?:([01]?\d|2[0-3]):([0-5]\d))\s*(?:-|–|—|~|至)\s*(?:([01]?\d|2[0-3]):([0-5]\d))/g)]
    .map((match) => `${match[1]!.padStart(2, "0")}:${match[2]}|${match[3]!.padStart(2, "0")}:${match[4]}`);
  const validatedRanges = new Set((validationData.candidates ?? []).flatMap((candidate) => {
    if (!candidate.localStartsAt || !candidate.localEndsAt) return [];
    return [`${candidate.localStartsAt.slice(-5)}|${candidate.localEndsAt.slice(-5)}`];
  }));
  return recommendedRanges.some((range) => !validatedRanges.has(range));
}

class AgentRuntimeError extends Error {
  constructor(public readonly code: string, message: string, public readonly exitReason: AgentExitReason = "runtime_error") { super(message); }
}

/** 临近预算上限时引导模型收敛，避免继续做低价值探索后突然终止。 */
export function buildBudgetGuidance(totalTokens: number, maxTokens: number): string {
  const remaining = Math.max(0, maxTokens - totalTokens);
  if (totalTokens < maxTokens * 0.75) return "";
  if (totalTokens < maxTokens * 0.88) {
    return `Token 预算提醒：本次 Run 约剩余 ${remaining} Token。停止重复查询，复用证据账本；只补齐完成目标必需的校验或草案，然后尽快给出结论。`;
  }
  return `Token 预算即将耗尽：本次 Run 约剩余 ${remaining} Token。禁止新的探索性查询；仅允许完成不可省略的最终冲突校验或待确认草案，否则立即基于现有证据输出结论并明确仍缺少什么。`;
}

function summarizeToolCalls(toolCalls: Array<{ name: string; ok: boolean; errorCode?: string }>): string {
  if (!toolCalls.length) return "本轮没有工具结果需要验证。";
  const failed = toolCalls.filter((call) => !call.ok);
  if (!failed.length) return `本轮 ${toolCalls.length} 个工具调用均成功。`;
  return `本轮 ${toolCalls.length} 个工具调用中 ${failed.length} 个失败：${failed.map((call) => `${call.name}/${call.errorCode ?? "UNKNOWN"}`).join("、")}。`;
}

/** 写草案重试复用语义幂等键；即使第一次请求超时后仍在后台完成，也不会生成第二份 ChangeSet。 */
export function buildToolIdempotencyKey(runId: string, loopIteration: number, call: Pick<PendingToolCall, "id" | "name" | "input" | "tool">) {
  if (call.tool.risk !== "draft_write") return `${runId}:${loopIteration}:${call.id}`;
  const value = `${call.name}:${stableJson(call.input)}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return `${runId}:draft:${(hash >>> 0).toString(36)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
