import { z } from "zod";
import type { ModelAdapter, ModelEvent, ModelMessage, ModelRequest, StructuredRequest } from "./types";
import type { ProviderConfig } from "./provider-config";

type CompletionResponse = {
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
};

type StreamChunk = {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
};

type PendingToolCall = { id: string; name: string; arguments: string };

export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly provider: string;
  constructor(private readonly config: ProviderConfig) { this.provider = config.id; }

  /**
   * 以流式方式调用兼容 OpenAI 的 Chat Completions 接口，逐块产出文本与工具调用事件。
   * 自动添加 stream_options.include_usage 以确保 token 用量写入 Trace。
   * @param request - 模型请求（系统提示、消息、工具等）
   * @param signal - 可选 AbortSignal，用于取消请求
   */
  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.config.apiKey && { Authorization: `Bearer ${this.config.apiKey}` }) },
      body: JSON.stringify({
        model: request.model || this.config.model,
        messages: [{ role: "system", content: request.system }, ...request.messages.map(toProviderMessage)],
        ...(request.tools.length && {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.inputSchema) },
          })),
          tool_choice: "auto",
        }),
        max_tokens: request.maxOutputTokens,
        stream: true,
        // 确保在支持的供应商上返回 token 用量
        stream_options: { include_usage: true },
      }),
      signal,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null) as CompletionResponse | null;
      throw new Error(body?.error?.message || `${this.config.label} 请求失败（${response.status}）`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error(`${this.config.label} 没有返回可读取的流。`);

    const decoder = new TextDecoder();
    let buffer = "";
    let finishReason: "stop" | "tool_calls" | "length" = "stop";
    const pendingTools = new Map<number, PendingToolCall>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd === -1) break;
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let chunk: StreamChunk;
        try { chunk = JSON.parse(payload) as StreamChunk; }
        catch { continue; }

        if (chunk.error?.message) throw new Error(chunk.error.message);

        const choice = chunk.choices?.[0];
        if (choice?.finish_reason === "tool_calls") finishReason = "tool_calls";
        else if (choice?.finish_reason === "length") finishReason = "length";
        else if (choice?.finish_reason === "stop") finishReason = "stop";

        const delta = choice?.delta;
        if (delta?.content) {
          const text = stripThinkingTags(delta.content);
          if (text) yield { type: "text_delta", text };
        }

        for (const call of delta?.tool_calls ?? []) {
          const current = pendingTools.get(call.index) ?? { id: call.id ?? "", name: call.function?.name ?? "", arguments: "" };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.name = call.function.name;
          if (call.function?.arguments) current.arguments += call.function.arguments;
          pendingTools.set(call.index, current);
        }

        if (chunk.usage) {
          yield { type: "usage", inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
        }
      }
    }

    for (const call of [...pendingTools.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!call.name) continue;
      let input: unknown = {};
      try { input = JSON.parse(call.arguments || "{}"); } catch { input = {}; }
      yield { type: "tool_call", id: call.id || crypto.randomUUID(), name: call.name, input };
    }

    yield { type: "finish", reason: finishReason };
  }

  /**
   * 单次调用模型，以 JSON 格式返回符合给定 Zod schema 的结构化对象。
   * 用于 AI Review 生成等不需要工具循环的结构化输出场景。
   * 最多重试 2 次（schema 校验失败时），仍失败则抛出错误。
   * @param request - 结构化请求参数（prompt、system、schema）
   */
  async generateObject<T>(request: StructuredRequest<T>): Promise<T> {
    const MAX_RETRIES = 2;
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const retryNote = attempt > 0 ? `\n\n上一次输出校验失败：${String(lastError)}。请严格按照 JSON Schema 输出，不要包含任何解释文字。` : "";
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.config.apiKey && { Authorization: `Bearer ${this.config.apiKey}` }) },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: "system", content: request.system + "\n\n必须以合法 JSON 对象回复，不允许使用 Markdown 代码块。" },
            { role: "user", content: request.prompt + retryNote },
          ],
          max_tokens: request.maxOutputTokens ?? 2000,
          response_format: { type: "json_object" },
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message || `${this.config.label} 请求失败（${response.status}）`);
      }
      const body = await response.json() as CompletionResponse;
      const content = body.choices?.[0]?.message?.content ?? "";
      try {
        const parsed = JSON.parse(content) as unknown;
        return request.schema.parse(parsed) as T;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(`结构化输出校验失败（已重试 ${MAX_RETRIES} 次）：${String(lastError)}`);
  }
}

/**
 * 将内部 ModelMessage 转为 OpenAI Chat Completions 消息格式。
 * @param message - 运行时消息对象
 */
function toProviderMessage(message: ModelMessage) {
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.input) },
      })),
    };
  }
  if (message.role === "tool") return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
  return { role: message.role, content: message.content };
}

/**
 * 移除模型输出中的思考标签（保留空格，适用于流式分片）。
 * @param content - 原始模型文本分片
 */
function stripThinkingTags(content: string) { return content.replace(/<think>[\s\S]*?<\/think>/gi, ""); }
