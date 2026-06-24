import { ModelAdapter } from "./types";

export type ModelAlias = "qwen" | "deepseek" | "minimax";

export class ModelRegistry {
  private readonly adapters = new Map<ModelAlias, ModelAdapter>();

  register(alias: ModelAlias, adapter: ModelAdapter) {
    this.adapters.set(alias, adapter);
    return this;
  }

  resolve(alias: ModelAlias): ModelAdapter {
    const adapter = this.adapters.get(alias);
    if (!adapter) throw new Error(`Model adapter '${alias}' is not configured.`);
    return adapter;
  }

  configured(): ModelAlias[] {
    return [...this.adapters.keys()];
  }
}
