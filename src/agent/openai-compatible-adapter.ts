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
   * 用于 AI Review / 首页洞察等不需要工具循环的结构化输出场景。
   *
   * 对 Qwen/DashScope 等混合思考模型：非流式 + json_object 时必须关闭 thinking，
   * 否则会卡住或报错（Agent 走流式所以不受影响）。
   *
   * @param request - 结构化请求参数（prompt、system、schema、可选 signal）
   */
  async generateObject<T>(request: StructuredRequest<T>): Promise<T> {
    const maxRetries = request.maxRetries ?? 2;
    const model = request.model || this.config.model;
    const disableThinking = shouldDisableThinkingForJson(this.provider, this.config.baseUrl, model);
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (request.signal?.aborted) {
        throw new DOMException("generateObject aborted", "AbortError");
      }
      const attemptStartedAt = Date.now();
      const retryNote = attempt > 0 ? `\n\n上一次输出校验失败：${String(lastError)}。请严格按照 JSON Schema 输出，不要包含任何解释文字。` : "";
      const system = `${request.system}\n\n必须以合法 JSON 对象回复，不允许使用 Markdown 代码块。输出中必须包含 JSON。`;
      const responseFormat = buildJsonResponseFormat(request.schema, disableThinking);
      let response: Response;
      try {
        response = await fetch(`${this.config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(this.config.apiKey && { Authorization: `Bearer ${this.config.apiKey}` }) },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: request.prompt + retryNote },
            ],
            max_tokens: request.maxOutputTokens ?? 2000,
            response_format: responseFormat,
            // DashScope/Qwen：非流式结构化输出必须关闭思考模式，否则会挂起或 400
            ...(disableThinking ? { enable_thinking: false } : {}),
          }),
          signal: request.signal,
        });
      } catch (error) {
        const aborted =
          request.signal?.aborted
          || (error instanceof DOMException && error.name === "AbortError")
          || (error instanceof Error && error.name === "AbortError");
        console.error("[llm] generateObject fetch failed", {
          provider: this.provider,
          model,
          attempt,
          ms: Date.now() - attemptStartedAt,
          aborted,
          disableThinking,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        const message = body?.error?.message || `${this.config.label} 请求失败（${response.status}）`;
        console.error("[llm] generateObject http error", {
          provider: this.provider,
          model,
          attempt,
          status: response.status,
          ms: Date.now() - attemptStartedAt,
          disableThinking,
          message,
        });
        throw new Error(message);
      }
      const body = await response.json() as CompletionResponse;
      const rawContent = body.choices?.[0]?.message?.content ?? "";
      const content = extractJsonText(rawContent);
      try {
        const parsed = JSON.parse(content) as unknown;
        const value = request.schema.parse(parsed) as T;
        console.info("[llm] generateObject ok", {
          provider: this.provider,
          model,
          attempt,
          ms: Date.now() - attemptStartedAt,
          disableThinking,
        });
        return value;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        console.warn("[llm] generateObject schema/parse retry", {
          provider: this.provider,
          model,
          attempt,
          ms: Date.now() - attemptStartedAt,
          message: lastError,
          preview: rawContent.slice(0, 240),
        });
      }
    }
    throw new Error(`结构化输出校验失败（已重试 ${maxRetries} 次）：${String(lastError)}`);
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

/**
 * 判断非流式 JSON 结构化输出是否需要关闭思考模式。
 * Qwen3.5 等混合思考模型默认可能开启 thinking；与 json_object 不兼容且非流式会挂起。
 * @param providerId - 供应商 id
 * @param baseUrl - API base URL
 * @param model - 模型名
 */
function shouldDisableThinkingForJson(providerId: string, baseUrl: string, model: string) {
  const id = providerId.toLowerCase();
  const url = baseUrl.toLowerCase();
  const name = model.toLowerCase();
  if (id === "qwen" || url.includes("dashscope") || url.includes("aliyuncs.com")) return true;
  if (name.includes("qwen3") || name.includes("qwen-3") || name.startsWith("qwen")) return true;
  return false;
}

/**
 * 构建结构化输出的 response_format。
 * Qwen 优先 json_schema；失败回退场景仍可用 json_object。
 * @param schema - Zod schema
 * @param preferJsonSchema - 是否优先使用 json_schema（Qwen 非思考模式）
 */
function buildJsonResponseFormat(schema: z.ZodType<unknown>, preferJsonSchema: boolean) {
  if (!preferJsonSchema) return { type: "json_object" as const };
  try {
    const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
    // 去掉部分供应商不接受的顶层元字段
    delete jsonSchema.$schema;
    return {
      type: "json_schema" as const,
      json_schema: {
        name: "structured_output",
        strict: true,
        schema: jsonSchema,
      },
    };
  } catch (error) {
    console.warn("[llm] toJSONSchema failed, fallback json_object", {
      message: error instanceof Error ? error.message : String(error),
    });
    return { type: "json_object" as const };
  }
}

/**
 * 从模型原始文本中提取可解析的 JSON 字符串。
 * 会去掉思考标签与 Markdown 代码块包裹。
 * @param raw - 模型返回的 content
 */
function extractJsonText(raw: string) {
  let text = stripThinkingTags(raw).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) text = fenced[1].trim();
  if (text.startsWith("{") || text.startsWith("[")) return text;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}
