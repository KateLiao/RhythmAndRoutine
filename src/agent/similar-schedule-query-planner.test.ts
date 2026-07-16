import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFallbackSimilarScheduleQueryPlan, planSimilarScheduleQueries, runProgressiveSimilarScheduleSearch } from "@/agent/similar-schedule-query-planner";
import type { ModelAdapter } from "@/agent/types";

describe("similar schedule query planner", () => {
  it("keeps the complete activity meaning before broader fallbacks", () => {
    const plan = createFallbackSimilarScheduleQueryPlan("按照之前的习惯安排阅读《原则》", "阅读");
    assert.deepEqual(plan.tiers[0].queries, ["阅读《原则》", "原则阅读"]);
    assert.equal(plan.tiers[1].queries[0], "原则");
    assert.equal(plan.tiers[2].queries[0], "阅读");
  });

  it("only broadens after the previous tier returns no samples", async () => {
    const plan = createFallbackSimilarScheduleQueryPlan("安排阅读《原则》", "阅读");
    const visited: string[] = [];
    const search = await runProgressiveSimilarScheduleSearch(plan, async (tier) => {
      visited.push(tier.level);
      return { sampleCount: tier.level === "related" ? 2 : 0, tier: tier.level };
    });
    assert.deepEqual(visited, ["exact", "related"]);
    assert.equal(search.matchedTier, "related");
    assert.equal(search.result.sampleCount, 2);
  });

  it("normalizes an over-broad or invented planner result against the original intent", async () => {
    const adapter = {
      provider: "test",
      generateObject: async () => ({
        activityLabel: "阅读",
        tiers: [
          { level: "exact", queries: ["阅读"], reason: "模型给宽了" },
          { level: "related", queries: ["跑步"], reason: "模型编造" },
          { level: "broad", queries: ["阅读"], reason: "活动类别" },
        ],
      }),
    } as unknown as ModelAdapter;
    const plan = await planSimilarScheduleQueries(adapter, { prompt: "按照习惯安排阅读《原则》", queryHint: "阅读", model: "test" });
    assert.deepEqual(plan.tiers[0].queries, ["阅读《原则》", "原则阅读"]);
    assert.equal(plan.tiers[1].queries.includes("跑步"), false);
  });

  it("executes each tier exactly once when nothing matches", async () => {
    const plan = createFallbackSimilarScheduleQueryPlan("安排阅读《不存在的书》", "阅读");
    let calls = 0;
    const search = await runProgressiveSimilarScheduleSearch(plan, async () => {
      calls += 1;
      return { sampleCount: 0 };
    });
    assert.equal(calls, 3);
    assert.equal(search.matchedTier, null);
  });
});
