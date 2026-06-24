import type { ModelAdapter, ModelEvent, ModelRequest, StructuredRequest } from "./types";

/**
 * 带降级的 ModelAdapter 包装器。
 * 主模型失败且尚未产出内容时，自动切换到 fallback 模型并继续。
 * model_fallback 事件独立发出，供 Trace 记录降级原因、原模型与降级模型。
 * generateObject 同样支持降级：主模型失败时尝试 fallback。
 */
export class FallbackModelAdapter implements ModelAdapter {
  private active: ModelAdapter;
  readonly provider: string;
  constructor(private readonly primary: ModelAdapter, private readonly fallback?: { adapter: ModelAdapter; model: string }) {
    this.active = primary;
    this.provider = fallback ? `${primary.provider}->${fallback.adapter.provider}` : primary.provider;
  }
  get activeProvider() { return this.active.provider; }

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    let emitted = false;
    try {
      for await (const event of this.primary.stream(request, signal)) { if (event.type === "text_delta" || event.type === "tool_call") emitted = true; yield event; }
    } catch (error) {
      if (emitted || !this.fallback) throw error;
      this.active = this.fallback.adapter;
      // 独立的 model_fallback 事件，包含触发原因、原模型与降级模型，写入 Trace
      yield { type: "model_fallback", from: this.primary.provider, to: this.fallback.adapter.provider, reason: error instanceof Error ? error.message : "模型调用失败" };
      yield* this.fallback.adapter.stream({ ...request, model: this.fallback.model }, signal);
    }
  }

  async generateObject<T>(request: StructuredRequest<T>): Promise<T> {
    try {
      return await this.primary.generateObject(request);
    } catch (error) {
      if (!this.fallback) throw error;
      this.active = this.fallback.adapter;
      return this.fallback.adapter.generateObject({ ...request, model: this.fallback.model });
    }
  }
}
