import assert from "node:assert/strict";
import test from "node:test";
import { buildRulesSignals, type PeriodMetrics } from "@/server/services/reviews";

test("builds distinct v2 rhythm signals for low challenge, overload, and fragmentation", () => {
  const metrics: PeriodMetrics = {
    total: 8,
    completed: 5,
    missed: 2,
    rescheduled: 1,
    cancelled: 0,
    investedMinutes: 240,
    smoothCount: 3,
    resistanceCount: 5,
    focusCounts: {
      deep_focus: 2,
      steady_focus: 1,
      under_challenged: 2,
      overloaded: 3,
      fragmented: 2,
    },
  };

  const types = buildRulesSignals(metrics, "review-1", new Date("2026-07-14T00:00:00.000Z"), new Date("2026-07-21T00:00:00.000Z")).map((signal) => signal.type);

  assert.deepEqual(types, [
    "smooth_pattern",
    "under_challenged_pattern",
    "overload_pattern",
    "fragmented_focus_pattern",
    "completion_pattern",
  ]);
  assert.equal(types.includes("resistance_pattern"), false);
});
