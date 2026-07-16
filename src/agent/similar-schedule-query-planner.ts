import { z } from "zod";
import type { ModelAdapter } from "./types";

export const similarScheduleQueryTierSchema = z.object({
  level: z.enum(["exact", "related", "broad"]),
  queries: z.array(z.string().trim().min(2).max(80)).min(1).max(4),
  reason: z.string().trim().min(2).max(160),
});

export const similarScheduleQueryPlanSchema = z.object({
  activityLabel: z.string().trim().min(2).max(80),
  tiers: z.tuple([
    similarScheduleQueryTierSchema.extend({ level: z.literal("exact") }),
    similarScheduleQueryTierSchema.extend({ level: z.literal("related") }),
    similarScheduleQueryTierSchema.extend({ level: z.literal("broad") }),
  ]),
});

export type SimilarScheduleQueryPlan = z.infer<typeof similarScheduleQueryPlanSchema>;
export type SimilarScheduleQueryTier = SimilarScheduleQueryPlan["tiers"][number];

type PlanInput = {
  prompt: string;
  queryHint?: string;
  model: string;
  signal?: AbortSignal;
};

/**
 * 用独立结构化 planner 把用户完整意图拆成逐级放宽的历史查询计划。
 * planner 失败时使用可预测的本地规则降级，不能阻断主 Agent Loop。
 */
export async function planSimilarScheduleQueries(adapter: ModelAdapter, input: PlanInput): Promise<SimilarScheduleQueryPlan> {
  try {
    const plannerSignal = input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(8_000)])
      : AbortSignal.timeout(8_000);
    const planned = await adapter.generateObject({
      model: input.model,
      signal: plannerSignal,
      maxRetries: 1,
      maxOutputTokens: 700,
      schema: similarScheduleQueryPlanSchema,
      system: `你是日程历史检索 planner，只负责生成查询语句，不负责推荐时间。
把用户想重复的“完整活动语义”放在 exact 层，例如“阅读《原则》”，不要只输出“阅读”。
related 层保留核心对象或作品名，例如“原则”；broad 层才退化为活动类别，例如“阅读”。
三个层级必须从严格到宽松，且不得添加用户没有提到的作品、人物或活动。`,
      prompt: `用户原始请求：${input.prompt}\n主 Agent 给出的查询提示：${input.queryHint ?? "（无）"}\n请生成 exact、related、broad 三层候选查询。`,
    });
    return normalizePlannedQueryPlan(planned, input.prompt, input.queryHint);
  } catch {
    return createFallbackSimilarScheduleQueryPlan(input.prompt, input.queryHint);
  }
}

function normalizePlannedQueryPlan(plan: SimilarScheduleQueryPlan, prompt: string, queryHint?: string) {
  const fallback = createFallbackSimilarScheduleQueryPlan(prompt, queryHint);
  const quotedObject = [...prompt.matchAll(/《([^》]{1,60})》/g)][0]?.[1]?.trim();
  const safePlannerQueries = (queries: string[], level: SimilarScheduleQueryTier["level"]) => queries.filter((query) => {
    if (level === "broad") return prompt.includes(query) || Boolean(queryHint?.includes(query)) || Boolean(query.includes(inferActivityCategory(prompt, queryHint)));
    return quotedObject ? query.includes(quotedObject) : prompt.includes(query) || Boolean(queryHint?.includes(query));
  });
  return similarScheduleQueryPlanSchema.parse({
    activityLabel: fallback.activityLabel,
    tiers: fallback.tiers.map((fallbackTier, index) => {
      const plannedTier = plan.tiers[index]!;
      return {
        level: fallbackTier.level,
        queries: uniqueQueries([...fallbackTier.queries, ...safePlannerQueries(plannedTier.queries, fallbackTier.level)]),
        reason: plannedTier.reason || fallbackTier.reason,
      };
    }),
  });
}

/** 为结构化 planner 不可用时生成确定性的三层查询。 */
export function createFallbackSimilarScheduleQueryPlan(prompt: string, queryHint?: string): SimilarScheduleQueryPlan {
  const quoted = [...prompt.matchAll(/《([^》]{1,60})》/g)].map((match) => match[1]!.trim()).filter(Boolean);
  const object = quoted[0];
  const hinted = queryHint?.trim();
  const activity = inferActivityCategory(prompt, hinted);
  const exactQueries = object
    ? uniqueQueries([`${activity}《${object}》`, `${object}${activity}`])
    : uniqueQueries([hinted, stripPlanningLanguage(prompt)]);
  const relatedQueries = uniqueQueries([object, hinted && hinted !== activity ? hinted : undefined, exactQueries[0]]);
  const broadQueries = uniqueQueries([activity, hinted, object]);

  return similarScheduleQueryPlanSchema.parse({
    activityLabel: exactQueries[0] ?? hinted ?? activity,
    tiers: [
      { level: "exact", queries: exactQueries.length ? exactQueries : [activity], reason: "优先匹配用户描述的完整活动语义" },
      { level: "related", queries: relatedQueries.length ? relatedQueries : [activity], reason: "精确活动无历史时保留核心对象继续查询" },
      { level: "broad", queries: broadQueries.length ? broadQueries : [activity], reason: "前两层均无结果时才按活动类别降级" },
    ],
  });
}

/**
 * 严格按 tier 顺序执行检索；只有当前 tier 零结果才进入下一层。
 */
export async function runProgressiveSimilarScheduleSearch<T extends { sampleCount: number }>(
  plan: SimilarScheduleQueryPlan,
  search: (tier: SimilarScheduleQueryTier) => Promise<T>,
) {
  const attempts: Array<{ level: SimilarScheduleQueryTier["level"]; queries: string[]; sampleCount: number }> = [];
  let lastResult: T | undefined;
  for (const tier of plan.tiers) {
    const result = await search(tier);
    lastResult = result;
    attempts.push({ level: tier.level, queries: tier.queries, sampleCount: result.sampleCount });
    if (result.sampleCount > 0) return { result, matchedTier: tier.level, attempts };
  }
  if (!lastResult) throw new Error("相似日程查询计划不能为空。");
  return { result: lastResult, matchedTier: null, attempts };
}

function uniqueQueries(values: Array<string | undefined>) {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value && value.length >= 2)))].slice(0, 4);
}

function inferActivityCategory(prompt: string, queryHint?: string) {
  for (const category of ["阅读", "吉他练习", "英语练习", "运动", "写作", "冥想", "学习"]) {
    if (prompt.includes(category) || queryHint?.includes(category)) return category;
  }
  return queryHint?.trim() || "相似活动";
}

function stripPlanningLanguage(prompt: string) {
  return prompt
    .replace(/按照|根据|参考|我|之前|过去|往常|平时|习惯|帮忙|帮我|这周|今天|晚上|每天|安排|时间|一次|执行/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}
