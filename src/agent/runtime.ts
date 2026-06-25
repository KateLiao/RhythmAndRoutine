import { capabilityPolicies } from "./capabilities";
import { buildAgentContextSummary } from "./context-builder";
import { AgentExitReason, AgentRunRequest, AgentTool, LoopGoalStatus, LoopNextAction, ModelAdapter, ModelMessage, RunEvent, ToolResult } from "./types";

export type AgentRunStore = {
  create(input: { userId: string; capability: string; provider: string; model: string; contextManifest: unknown; inputSummary?: string }): Promise<{ id: string }>;
  appendStep(runId: string, step: { sequence: number; loopIteration?: number; kind: string; goalStatus?: LoopGoalStatus; nextAction?: LoopNextAction; reason?: string; missingInformation?: string[]; toolAttemptCount?: number; input?: unknown; output?: unknown; durationMs?: number; inputTokens?: number; outputTokens?: number; toolCalls?: Array<{ name: string; risk: AgentTool["risk"]; input: unknown; output?: unknown; ok: boolean; errorCode?: string; durationMs?: number }> }): Promise<void>;
  markAwaitingConfirmation(runId: string, changeSetId: string, summary: string, retryCount: number): Promise<void>;
  complete(runId: string, finalText: string, exitReason: AgentExitReason, goalStatus: LoopGoalStatus, retryCount: number): Promise<void>;
  fail(runId: string, code: string, message: string, exitReason: AgentExitReason, retryCount: number): Promise<void>;
  /** 取消一个正在运行或等待确认的 Run */
  cancel(runId: string, reason?: string): Promise<void>;
};

export class AgentRuntime {
  constructor(
    private readonly model: ModelAdapter,
    private readonly tools: Map<string, AgentTool>,
    private readonly store: AgentRunStore,
  ) {}

  async *run(request: AgentRunRequest): AsyncGenerator<RunEvent> {
    const policy = capabilityPolicies[request.capability];
    const run = await this.store.create({ userId: request.userId, capability: request.capability, provider: this.model.provider, model: request.model, contextManifest: request.context.manifest, inputSummary: request.prompt });
    yield { type: "run_started", runId: run.id };

    const messages: ModelMessage[] = [
      ...request.context.conversation.recentMessages,
      { role: "user", content: request.prompt },
    ];
    let finalText = "";
    const runStartedAt = Date.now();
    let totalTokens = 0;
    let stepSequence = 1;
    let failureRecoveryCount = 0;
    const maxTokens = policy.maxRunTokens;
    const contextSummary = buildAgentContextSummary(request.context.business, request.context.page, request.context.user.timezone, request.prompt);

    try {
      const planningReason = "已读取当前对话、页面和业务上下文，准备围绕用户目标选择工具或直接回复。";
      await this.store.appendStep(run.id, { sequence: stepSequence++, loopIteration: 0, kind: "planning", goalStatus: "needs_more_action", nextAction: "call_tool", reason: planningReason, input: { prompt: request.prompt, selectedEntity: request.context.page?.selectedEntity } });
      yield { type: "loop_step", kind: "planning", label: "理解目标", summary: "已结合当前页面和对话识别用户意图", goalStatus: "needs_more_action", nextAction: "call_tool", detail: { scope: "当前消息、最近对话、页面选中对象和业务上下文", judgment: planningReason, nextAction: "选择可用工具或直接给出答复。" } };

      for (let loopIteration = 1; loopIteration <= policy.maxSteps; loopIteration += 1) {
        if (Date.now() - runStartedAt > 120_000) throw new AgentRuntimeError("MAX_DURATION", "小律已达到本次运行的 120 秒时限。计划没有被修改。", "stopped_by_time_budget");
        if (totalTokens >= maxTokens) throw new AgentRuntimeError("MAX_TOKENS", "小律已达到本次运行的 Token 上限。计划没有被修改。", "stopped_by_token_budget");
        const startedAt = Date.now();
        let calledTool = false;
        let inputTokens: number | undefined; let outputTokens: number | undefined;
        const toolCalls: NonNullable<Parameters<AgentRunStore["appendStep"]>[1]["toolCalls"]> = [];
        const availableTools = policy.allowedTools.map((name) => this.tools.get(name)).filter((tool): tool is AgentTool => Boolean(tool));
        const events = this.model.stream({ model: request.model, system: `${policy.system}\n当前上下文摘要：\n${contextSummary}`, messages, tools: availableTools, maxOutputTokens: policy.maxOutputTokens }, request.signal);

        for await (const event of events) {
          if (event.type === "text_delta") { finalText += event.text; yield event; }
          if (event.type === "model_fallback") yield event;
          if (event.type === "usage") { inputTokens = event.inputTokens; outputTokens = event.outputTokens; totalTokens += event.inputTokens + event.outputTokens; }
          if (event.type === "tool_call") {
            calledTool = true;
            const tool = this.tools.get(event.name);
            if (!tool || !policy.allowedTools.includes(event.name)) throw new AgentRuntimeError("TOOL_NOT_ALLOWED", `工具 ${event.name} 未被当前能力授权。`, "blocked_by_tool_error");
            yield { type: "tool_started", tool: event.name };
            const toolStartedAt = Date.now();
            const result = await this.executeTool(tool, event.input, { userId: request.userId, runId: run.id, idempotencyKey: `${run.id}:${loopIteration}:${event.id}` });
            toolCalls.push({ name: tool.name, risk: tool.risk, input: event.input, output: result, ok: result.ok, errorCode: result.ok ? undefined : result.code, durationMs: Date.now() - toolStartedAt });
            yield { type: "tool_completed", tool: event.name, input: event.input, result };
            if (!result.ok) {
              failureRecoveryCount += 1;
              const nextAction: LoopNextAction = result.retryable ? "retry_tool" : "stop";
              const reason = result.retryable
                ? `工具 ${tool.name} 返回 ${result.code}，将把错误反馈给模型，让它修正参数、换工具或追问用户。`
                : `工具 ${tool.name} 返回不可重试错误 ${result.code}，停止自动推进。`;
              yield { type: "loop_step", kind: "recovery", label: "工具失败恢复", summary: result.message, goalStatus: "needs_more_action", nextAction, detail: { result: result.message, judgment: reason, nextAction: result.retryable ? "修正参数、换工具或追问用户。" : "停止并解释原因。" } };
              if (!result.retryable) throw new AgentRuntimeError(result.code, result.message, "blocked_by_tool_error");
              if (failureRecoveryCount >= 5) throw new AgentRuntimeError("MAX_RETRIES", `工具失败恢复已达到 5 次，最近一次失败：${result.message}`, "stopped_by_max_retries");
            }
            messages.push(
              { role: "assistant", content: "", toolCalls: [{ id: event.id, name: event.name, input: event.input }] },
              { role: "tool", toolCallId: event.id, content: truncateToolMessageContent(result) },
            );

            if (tool.risk === "draft_write" && result.ok) {
              const changeSetId = (result.data as { changeSetId: string }).changeSetId;
              const reason = "写操作已生成待确认 ChangeSet；Agent 的目标是产出草案，正式应用必须等待用户确认。";
              await this.store.appendStep(run.id, { sequence: stepSequence++, loopIteration, kind: "tool", goalStatus: "awaiting_confirmation", nextAction: "propose_change_set", reason, output: finalText.slice(-1000), durationMs: Date.now() - startedAt, inputTokens, outputTokens, toolAttemptCount: toolCalls.length, toolCalls });
              await this.store.appendStep(run.id, { sequence: stepSequence++, loopIteration, kind: "verification", goalStatus: "awaiting_confirmation", nextAction: "propose_change_set", reason, output: result, durationMs: Date.now() - startedAt, toolAttemptCount: toolCalls.length });
              await this.store.appendStep(run.id, { sequence: stepSequence++, loopIteration, kind: "decision", goalStatus: "awaiting_confirmation", nextAction: "propose_change_set", reason, output: { changeSetId }, durationMs: Date.now() - startedAt, toolAttemptCount: toolCalls.length });
              yield { type: "loop_step", kind: "verification", label: "验证工具结果", summary: "已生成可确认的变更草案", goalStatus: "awaiting_confirmation", nextAction: "propose_change_set", detail: { result: `ChangeSet ${changeSetId} 已创建。`, judgment: "草案生成成功，正式计划尚未修改。", nextAction: "等待用户确认草案。" } };
              yield { type: "loop_step", kind: "decision", label: "判断目标状态", summary: "目标已达成，等待确认", goalStatus: "awaiting_confirmation", nextAction: "propose_change_set", detail: { judgment: reason, nextAction: "暂停 Agent Loop，交给审批流程。" } };
              await this.store.markAwaitingConfirmation(run.id, changeSetId, finalText || reason, failureRecoveryCount);
              yield { type: "approval_required", changeSetId };
              return;
            }
          }
        }
        const loopReason = calledTool
          ? "本轮工具结果已写回模型上下文，继续判断是否还需要更多动作。"
          : "模型没有继续调用工具，视为已基于现有上下文给出最终回复。";
        await this.store.appendStep(run.id, { sequence: stepSequence++, loopIteration, kind: calledTool ? "tool" : "model", goalStatus: calledTool ? "needs_more_action" : "achieved", nextAction: calledTool ? "call_tool" : "final_answer", reason: loopReason, output: finalText.slice(-1000), durationMs: Date.now() - startedAt, inputTokens, outputTokens, toolAttemptCount: toolCalls.length, toolCalls });
        await this.store.appendStep(run.id, { sequence: stepSequence++, loopIteration, kind: "verification", goalStatus: calledTool ? "needs_more_action" : "achieved", nextAction: calledTool ? "call_tool" : "final_answer", reason: loopReason, output: summarizeToolCalls(toolCalls), durationMs: Date.now() - startedAt, toolAttemptCount: toolCalls.length });
        yield { type: "loop_step", kind: "verification", label: "验证工具结果", summary: calledTool ? "已把工具结果交回模型继续判断" : "没有新的工具调用", goalStatus: calledTool ? "needs_more_action" : "achieved", nextAction: calledTool ? "call_tool" : "final_answer", detail: { result: summarizeToolCalls(toolCalls), judgment: loopReason, nextAction: calledTool ? "继续下一轮判断。" : "输出最终回复。" } };
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
        return await Promise.race([
          tool.execute(parsed.data, context),
          new Promise<ToolResult>((resolve) => setTimeout(() => resolve({ ok: false, code: "TOOL_TIMEOUT", message: "工具调用超过 15 秒，已安全停止等待。", retryable: true }), 15_000)),
        ]);
      } catch (error) {
        return { ok: false, code: "TOOL_EXECUTION_FAILED", message: error instanceof Error ? error.message : "工具执行失败", retryable: true };
      }
    }
    return { ok: false, code: "TOOL_SCHEMA_EXHAUSTED", message: `工具 ${tool.name} 修复循环异常终止`, retryable: false };
  }
}

class AgentRuntimeError extends Error {
  constructor(public readonly code: string, message: string, public readonly exitReason: AgentExitReason = "runtime_error") { super(message); }
}

const MAX_TOOL_MESSAGE_CHARS = 12_000;

/**
 * 将工具返回结果序列化并截断，防止多轮对话中 tool 消息无限膨胀导致 Token 过快耗尽。
 * @param result - 工具执行结果
 */
function truncateToolMessageContent(result: ToolResult): string {
  const serialized = JSON.stringify(result);
  if (serialized.length <= MAX_TOOL_MESSAGE_CHARS) return serialized;
  return `${serialized.slice(0, MAX_TOOL_MESSAGE_CHARS)}…（工具结果已截断，如需完整数据请再次调用工具）`;
}

function summarizeToolCalls(toolCalls: Array<{ name: string; ok: boolean; errorCode?: string }>): string {
  if (!toolCalls.length) return "本轮没有工具结果需要验证。";
  const failed = toolCalls.filter((call) => !call.ok);
  if (!failed.length) return `本轮 ${toolCalls.length} 个工具调用均成功。`;
  return `本轮 ${toolCalls.length} 个工具调用中 ${failed.length} 个失败：${failed.map((call) => `${call.name}/${call.errorCode ?? "UNKNOWN"}`).join("、")}。`;
}
