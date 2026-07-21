import { z } from "zod";
import type { IntentResolution, ModelAdapter } from "./types";
import type { AgentView } from "./intent-resolver";

const capabilitySchema = z.enum(["goal_clarification", "planning", "review", "adjustment", "progress_evaluation"]);
const modelResolutionSchema = z.object({
  route: z.enum(["agent", "non_execution"]),
  primaryCapability: capabilitySchema.optional(),
  intents: z.array(z.object({
    id: z.string().min(1).max(40),
    capability: capabilitySchema,
    objective: z.string().min(1).max(300),
    confidence: z.number().min(0).max(1),
    slots: z.record(z.string(), z.unknown()).default({}),
    missingSlots: z.array(z.string().min(1).max(80)).default([]),
  })).max(5),
  overallConfidence: z.number().min(0).max(1),
  needsClarification: z.boolean(),
  clarificationReason: z.string().max(500).optional(),
});

export function shouldUseModelIntentRouter(resolution: IntentResolution) {
  if (resolution.adjustment?.kind && resolution.adjustment.kind !== "existing_adjustment") return false;
  return resolution.route === "agent" && (resolution.intents.length > 1 || resolution.needsClarification || resolution.overallConfidence < 0.85);
}

export async function resolveIntentWithModel(input: {
  adapter: ModelAdapter;
  model: string;
  prompt: string;
  view: AgentView;
  selectedGoalId?: string;
  rules: IntentResolution;
  signal?: AbortSignal;
}): Promise<IntentResolution> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  const abort = () => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    const modelResult = await input.adapter.generateObject({
      model: input.model,
      system: "你是 Rhythm & Routine 的意图解析器。只分类和抽取，不执行任务。当前消息的明确动作高于页面位置；一条消息可有多个意图；只有缺失字段会导致误操作时才 needsClarification。普通知识问答是 non_execution。",
      prompt: `当前页面：${input.view}\n选中目标：${input.selectedGoalId ?? "无"}\n用户消息：${input.prompt}\n规则候选：${JSON.stringify(input.rules)}\n请输出结构化意图。`,
      schema: modelResolutionSchema,
      maxOutputTokens: 1200,
      maxRetries: 0,
      signal: controller.signal,
    });
    const normalized = modelResolutionSchema.parse(modelResult);
    if (normalized.route === "agent" && (!normalized.primaryCapability || !normalized.intents.length)) throw new Error("模型路由缺少主能力或意图。" );
    if (normalized.route === "non_execution" && normalized.intents.length) throw new Error("非执行路由不应包含业务意图。" );
    return {
      ...normalized,
      source: "hybrid",
      adjustment: normalized.primaryCapability === "adjustment" ? input.rules.adjustment : undefined,
    };
  } catch {
    return { ...input.rules, degraded: true };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abort);
  }
}
