export type ProviderId = "qwen" | "deepseek" | "minimax" | "openai" | "moonshot" | "zhipu" | "openrouter" | "siliconflow" | "custom";

export type ProviderConfig = {
  id: ProviderId;
  label: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  enabled: boolean;
};

const definitions: Array<Omit<ProviderConfig, "apiKey" | "model" | "baseUrl" | "enabled"> & { keyEnv: string; modelEnv: string; baseEnv: string; defaultBase: string; defaultModel: string }> = [
  { id: "qwen", label: "Qwen / 阿里云百炼", keyEnv: "QWEN_API_KEY", modelEnv: "QWEN_MODEL", baseEnv: "QWEN_BASE_URL", defaultBase: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen-plus" },
  { id: "deepseek", label: "DeepSeek", keyEnv: "DEEPSEEK_API_KEY", modelEnv: "DEEPSEEK_MODEL", baseEnv: "DEEPSEEK_BASE_URL", defaultBase: "https://api.deepseek.com", defaultModel: "deepseek-v4-pro" },
  { id: "minimax", label: "MiniMax", keyEnv: "MINIMAX_API_KEY", modelEnv: "MINIMAX_MODEL", baseEnv: "MINIMAX_BASE_URL", defaultBase: "https://api.minimax.io/v1", defaultModel: "MiniMax-M2.7" },
  { id: "openai", label: "OpenAI", keyEnv: "OPENAI_API_KEY", modelEnv: "OPENAI_MODEL", baseEnv: "OPENAI_BASE_URL", defaultBase: "https://api.openai.com/v1", defaultModel: "gpt-5-mini" },
  { id: "moonshot", label: "Moonshot / Kimi", keyEnv: "MOONSHOT_API_KEY", modelEnv: "MOONSHOT_MODEL", baseEnv: "MOONSHOT_BASE_URL", defaultBase: "https://api.moonshot.cn/v1", defaultModel: "kimi-k2.5" },
  { id: "zhipu", label: "智谱 GLM", keyEnv: "ZHIPU_API_KEY", modelEnv: "ZHIPU_MODEL", baseEnv: "ZHIPU_BASE_URL", defaultBase: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-5" },
  { id: "openrouter", label: "OpenRouter", keyEnv: "OPENROUTER_API_KEY", modelEnv: "OPENROUTER_MODEL", baseEnv: "OPENROUTER_BASE_URL", defaultBase: "https://openrouter.ai/api/v1", defaultModel: "deepseek/deepseek-v4-pro" },
  { id: "siliconflow", label: "SiliconFlow", keyEnv: "SILICONFLOW_API_KEY", modelEnv: "SILICONFLOW_MODEL", baseEnv: "SILICONFLOW_BASE_URL", defaultBase: "https://api.siliconflow.cn/v1", defaultModel: "deepseek-ai/DeepSeek-V4" },
  { id: "custom", label: "自定义 OpenAI-compatible", keyEnv: "CUSTOM_LLM_API_KEY", modelEnv: "CUSTOM_LLM_MODEL", baseEnv: "CUSTOM_LLM_BASE_URL", defaultBase: "http://localhost:11434/v1", defaultModel: "local-model" },
];

export function getProviderConfigs(): ProviderConfig[] {
  return definitions.map((definition) => {
    const apiKey = process.env[definition.keyEnv]?.trim();
    return {
      id: definition.id,
      label: definition.label,
      apiKey,
      baseUrl: (process.env[definition.baseEnv] || definition.defaultBase).replace(/\/$/, ""),
      model: process.env[definition.modelEnv] || definition.defaultModel,
      enabled: Boolean(apiKey) || (definition.id === "custom" && Boolean(process.env.CUSTOM_LLM_BASE_URL)),
    };
  });
}

export function resolveProvider(providerId?: string): ProviderConfig {
  const requested = providerId || process.env.AI_DEFAULT_PROVIDER || "qwen";
  const provider = getProviderConfigs().find((item) => item.id === requested);
  if (!provider) throw new Error(`未知模型供应商：${requested}`);
  if (!provider.enabled) throw new Error(`${provider.label} 尚未配置 API Key。请在 .env 中填写对应密钥后重启应用。`);
  return provider;
}

export function resolveCapabilityProvider(capability: string, requestedProvider?: string, requestedModel?: string) {
  const key = capability.toUpperCase();
  const provider = resolveProvider(requestedProvider || process.env[`AI_${key}_PROVIDER`]);
  return { provider, model: requestedModel || process.env[`AI_${key}_MODEL`] || provider.model };
}

export function resolveFallbackProvider(primaryId: string) {
  const requested = process.env.AI_FALLBACK_PROVIDER;
  if (!requested || requested === primaryId) return undefined;
  try { const provider = resolveProvider(requested); return { provider, model: process.env.AI_FALLBACK_MODEL || provider.model }; }
  catch { return undefined; }
}
