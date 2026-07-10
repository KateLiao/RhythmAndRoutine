import type { MomentCandidate } from "@/lib/home-insights/types";
import type { HomeInsightProposedChange, MomentInsightGeneration, SlowInsightsGeneration } from "@/domain/schemas";
import { momentInsightGenerationSchema, slowInsightsGenerationSchema } from "@/domain/schemas";
import { computeRhythmCard } from "@/lib/home-insights/compute-rhythm";
import { computeWeeklyCard } from "@/lib/home-insights/compute-weekly";
import { buildMomentCandidates } from "@/lib/home-insights/compute-moment";
import type { HomeInsightFactsBundle } from "@/server/services/home-insights-facts";
import { HOME_INSIGHT_EXECUTION_WORKFLOW } from "@/server/services/home-insights-facts";

/** 单次洞察 LLM 调用超时（含 schema 重试预算）；超时后降级规则引擎 */
const HOME_INSIGHT_AI_TIMEOUT_MS = 60_000;

/**
 * 将规则候选动作映射为可持久化的 proposedChange。
 * @param action - 规则引擎候选动作
 */
function candidateToProposedChange(action: MomentCandidate["action"]): HomeInsightProposedChange {
  if (action.type === "reschedule") {
    return { type: "reschedule", scheduleId: action.scheduleId, start: action.start, end: action.end, date: action.date, label: action.label };
  }
  if (action.type === "create_schedule") {
    return { type: "create_schedule", title: action.title, start: action.start, end: action.end, date: action.date, goalId: action.goalId, taskId: action.taskId, label: action.label };
  }
  if (action.type === "open_execution_feedback") {
    return { type: "open_execution_feedback", scheduleId: action.scheduleId, label: action.label };
  }
  return { type: "open_schedule_form", start: action.start, end: action.end, date: action.date, goalId: action.goalId, taskId: action.taskId, label: action.label };
}

/**
 * 用规则引擎降级生成此刻建议（无 LLM 或 LLM 失败时）。
 * @param facts - 事实包
 */
export function buildRulesMomentGeneration(facts: HomeInsightFactsBundle): MomentInsightGeneration | null {
  const candidates = buildMomentCandidates({
    now: facts.now,
    timezone: facts.timezone,
    goals: facts.goals,
    schedule: facts.schedule,
    rhythmSignals: facts.rhythmSignals,
  });
  if (!candidates.length) return null;
  const [primary, ...rest] = candidates;
  const toCard = (candidate: MomentCandidate) => ({
    headline: candidate.headline,
    judgment: candidate.judgment,
    reason: candidate.reason,
    nextLabel: candidate.nextLabel,
    proposedChange: candidateToProposedChange(candidate.action),
  });
  return {
    primary: toCard(primary),
    alternateCandidates: rest.slice(0, 4).map(toCard),
  };
}

/**
 * 用规则引擎降级生成慢路径洞察。
 * @param facts - 事实包
 */
export function buildRulesSlowGeneration(facts: HomeInsightFactsBundle): SlowInsightsGeneration {
  const rhythm = computeRhythmCard({
    now: facts.now,
    timezone: facts.timezone,
    goals: facts.goals,
    schedule: facts.schedule,
    rhythmSignals: facts.rhythmSignals,
  });
  const weekly = computeWeeklyCard({
    now: facts.now,
    timezone: facts.timezone,
    goals: facts.goals,
    schedule: facts.schedule,
    rhythmSignals: facts.rhythmSignals,
  });
  return {
    rhythm: {
      statement: rhythm.statement,
      evidence: rhythm.evidence ?? "基于近 7 天执行记录统计。",
      impact: rhythm.impact ?? "这个发现会参与之后的日程推荐。",
      relatedSignalId: rhythm.signalId,
    },
    weekly: {
      statusLabel: weekly.statusLabel,
      status: weekly.status,
      summary: weekly.summary,
      suggestion: weekly.suggestion,
    },
  };
}

/**
 * 为洞察 LLM 调用创建带超时的 AbortController。
 * @param label - 日志标签（moment / slow）
 */
function createInsightAiAbort(label: "moment" | "slow") {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    console.warn("[home-insights] AI call timeout, aborting", {
      label,
      timeoutMs: HOME_INSIGHT_AI_TIMEOUT_MS,
    });
    controller.abort();
  }, HOME_INSIGHT_AI_TIMEOUT_MS);
  return {
    signal: controller.signal,
    /**
     * 清理超时定时器，避免泄漏。
     */
    clear() {
      clearTimeout(timer);
    },
  };
}

/**
 * 调用 LLM 生成此刻建议；失败或超时返回 null。
 * @param facts - momentFacts 事实
 */
export async function tryAiMomentGeneration(facts: HomeInsightFactsBundle): Promise<MomentInsightGeneration | null> {
  const abort = createInsightAiAbort("moment");
  try {
    const { resolveCapabilityProvider } = await import("@/agent/provider-config");
    const { OpenAICompatibleAdapter } = await import("@/agent/openai-compatible-adapter");
    const { provider, model } = resolveCapabilityProvider("review");
    console.info("[home-insights] moment AI start", {
      provider: provider.id,
      model,
      baseUrl: provider.baseUrl,
      timeoutMs: HOME_INSIGHT_AI_TIMEOUT_MS,
    });
    const adapter = new OpenAICompatibleAdapter(provider);
    const prompt = `${facts.momentFacts.temporalAnchor}

产品约束（必须遵守）：
${HOME_INSIGHT_EXECUTION_WORKFLOW}

你是 Rhythm & Routine 的「此刻建议」助手。根据以下事实，生成一条主建议 + 最多 4 条备选建议。
要求：
- 必须基于事实，不得编造日程
- 顶层字段必须是 primary 与 alternateCandidates（不要用 primarySuggestion）
- 每条建议字段：headline, judgment, reason, nextLabel, proposedChange
- proposedChange 必须含 type，且必须含 label（按钮文案，≤40字）
- proposedChange.type 只能是 reschedule / create_schedule / open_schedule_form / open_execution_feedback
- 计划时段已过但 status=planned 时，优先 open_execution_feedback，不要建议改到此刻开始
- 主建议应对应当前最合适的单一行动
- 备选应覆盖不同合理策略，但不要重复

事实 JSON：
${JSON.stringify(facts.momentFacts, null, 2)}`;
    const startedAt = Date.now();
    const result = await adapter.generateObject({
      model,
      system: "你只输出结构化此刻建议。禁止鸡汤。禁止罗列完整日程表。禁止假设用户未开始执行。",
      prompt,
      schema: momentInsightGenerationSchema,
      maxOutputTokens: 1400,
      maxRetries: 1,
      signal: abort.signal,
    });
    console.info("[home-insights] moment AI ok", { model, ms: Date.now() - startedAt });
    return result;
  } catch (error) {
    const aborted =
      abort.signal.aborted
      || (error instanceof DOMException && error.name === "AbortError")
      || (error instanceof Error && error.name === "AbortError");
    console.error("[home-insights] moment AI failed", {
      aborted,
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
    });
    return null;
  } finally {
    abort.clear();
  }
}

/**
 * 调用 LLM 生成节奏发现 + 本周轨道；失败或超时返回 null。
 * @param facts - slowFacts 事实
 */
export async function tryAiSlowGeneration(facts: HomeInsightFactsBundle): Promise<SlowInsightsGeneration | null> {
  const abort = createInsightAiAbort("slow");
  try {
    const { resolveCapabilityProvider } = await import("@/agent/provider-config");
    const { OpenAICompatibleAdapter } = await import("@/agent/openai-compatible-adapter");
    const { provider, model } = resolveCapabilityProvider("review");
    console.info("[home-insights] slow AI start", {
      provider: provider.id,
      model,
      baseUrl: provider.baseUrl,
      timeoutMs: HOME_INSIGHT_AI_TIMEOUT_MS,
    });
    const adapter = new OpenAICompatibleAdapter(provider);
    const prompt = `${facts.slowFacts.temporalAnchor}

产品约束（必须遵守）：
${HOME_INSIGHT_EXECUTION_WORKFLOW}

生成两张卡的内容：
1. rhythm（节奏发现）：陈述规律 + 证据 + 对后续安排的影响。不要写「你现在应该…」。
2. weekly（本周轨道）：状态标签 + 总结 + 可选建议。必须把目标投入与负荷联系起来。

事实 JSON：
${JSON.stringify(facts.slowFacts, null, 2)}`;
    const startedAt = Date.now();
    const result = await adapter.generateObject({
      model,
      system: "你区分节奏发现（长期规律）与本周轨道（周度校准）。禁止纯数字堆砌。",
      prompt,
      schema: slowInsightsGenerationSchema,
      maxOutputTokens: 1200,
      maxRetries: 1,
      signal: abort.signal,
    });
    console.info("[home-insights] slow AI ok", { model, ms: Date.now() - startedAt });
    return result;
  } catch (error) {
    const aborted =
      abort.signal.aborted
      || (error instanceof DOMException && error.name === "AbortError")
      || (error instanceof Error && error.name === "AbortError");
    console.error("[home-insights] slow AI failed", {
      aborted,
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
    });
    return null;
  } finally {
    abort.clear();
  }
}

/**
 * 生成此刻建议（AI 优先，规则降级）。
 * @param facts - 事实包
 */
export async function generateMomentInsight(facts: HomeInsightFactsBundle) {
  const ai = await tryAiMomentGeneration(facts);
  if (ai) return { generation: ai, source: "ai" as const };
  const rules = buildRulesMomentGeneration(facts);
  if (rules) return { generation: rules, source: "rules" as const };
  return null;
}

/**
 * 生成慢路径洞察（AI 优先，规则降级）。
 * @param facts - 事实包
 */
export async function generateSlowInsight(facts: HomeInsightFactsBundle) {
  const ai = await tryAiSlowGeneration(facts);
  if (ai) return { generation: ai, source: "ai" as const };
  return { generation: buildRulesSlowGeneration(facts), source: "rules" as const };
}
