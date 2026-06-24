import { capabilityPolicies } from "./capabilities";
import { summarizeBusinessForPrompt, buildAgentContextSummary } from "./context-builder";
import { AgentRunRequest, AgentTool, ModelAdapter, ModelMessage, RunEvent, ToolResult } from "./types";

export type AgentRunStore = {
  create(input: { userId: string; capability: string; provider: string; model: string; contextManifest: unknown }): Promise<{ id: string }>;
  appendStep(runId: string, step: { sequence: number; kind: string; input?: unknown; output?: unknown; durationMs?: number; inputTokens?: number; outputTokens?: number; toolCalls?: Array<{ name: string; risk: AgentTool["risk"]; input: unknown; output?: unknown; ok: boolean; errorCode?: string; durationMs?: number }> }): Promise<void>;
  markAwaitingConfirmation(runId: string, changeSetId: string): Promise<void>;
  complete(runId: string, finalText: string): Promise<void>;
  fail(runId: string, code: string, message: string): Promise<void>;
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
    const run = await this.store.create({ userId: request.userId, capability: request.capability, provider: this.model.provider, model: request.model, contextManifest: request.context.manifest });
    yield { type: "run_started", runId: run.id };

    const messages: ModelMessage[] = [
      ...request.context.conversation.recentMessages,
      { role: "user", content: request.prompt },
    ];
    let finalText = "";
    const runStartedAt = Date.now();
    let totalTokens = 0;
    const maxTokens = policy.maxRunTokens;
    const contextSummary = buildAgentContextSummary(request.context.business, request.context.page, request.context.user.timezone);

    try {
      for (let sequence = 1; sequence <= policy.maxSteps; sequence += 1) {
        if (Date.now() - runStartedAt > 120_000) throw new AgentRuntimeError("MAX_DURATION", "小律已达到本次运行的 120 秒时限。计划没有被修改。");
        if (totalTokens >= maxTokens) throw new AgentRuntimeError("MAX_TOKENS", "小律已达到本次运行的 Token 上限。计划没有被修改。");
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
            if (!tool || !policy.allowedTools.includes(event.name)) throw new AgentRuntimeError("TOOL_NOT_ALLOWED", `工具 ${event.name} 未被当前能力授权。`);
            yield { type: "tool_started", tool: event.name };
            const toolStartedAt = Date.now();
            const result = await this.executeTool(tool, event.input, { userId: request.userId, runId: run.id, idempotencyKey: `${run.id}:${sequence}:${event.id}` });
            toolCalls.push({ name: tool.name, risk: tool.risk, input: event.input, output: result, ok: result.ok, errorCode: result.ok ? undefined : result.code, durationMs: Date.now() - toolStartedAt });
            yield { type: "tool_completed", tool: event.name, input: event.input, result };
            messages.push(
              { role: "assistant", content: "", toolCalls: [{ id: event.id, name: event.name, input: event.input }] },
              { role: "tool", toolCallId: event.id, content: truncateToolMessageContent(result) },
            );

            if (tool.risk === "draft_write" && result.ok) {
              const changeSetId = (result.data as { changeSetId: string }).changeSetId;
              await this.store.appendStep(run.id, { sequence, kind: "tool", output: finalText.slice(-1000), durationMs: Date.now() - startedAt, inputTokens, outputTokens, toolCalls });
              await this.store.markAwaitingConfirmation(run.id, changeSetId);
              yield { type: "approval_required", changeSetId };
              return;
            }
          }
        }
        await this.store.appendStep(run.id, { sequence, kind: calledTool ? "tool" : "model", output: finalText.slice(-1000), durationMs: Date.now() - startedAt, inputTokens, outputTokens, toolCalls });
        if (!calledTool) {
          await this.store.complete(run.id, finalText);
          yield { type: "run_completed", text: finalText };
          return;
        }
      }
      throw new AgentRuntimeError("MAX_STEPS", "小律已达到本次运行的最大步骤数。计划没有被修改。");
    } catch (error) {
      const normalized = error instanceof AgentRuntimeError ? error : new AgentRuntimeError("RUNTIME_ERROR", error instanceof Error ? error.message : "未知运行错误");
      await this.store.fail(run.id, normalized.code, normalized.message);
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
  constructor(public readonly code: string, message: string) { super(message); }
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
