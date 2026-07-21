import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveAgentPageGoalId } from "@/lib/agent-page-context";

describe("Agent page goal scope", () => {
  it("focuses a goal only on goal-detail", () => {
    assert.equal(resolveAgentPageGoalId("goal-detail", "goal-1"), "goal-1");
    for (const view of ["today", "goals", "task-detail", "routines", "review", "settings"]) {
      assert.equal(resolveAgentPageGoalId(view, "goal-1"), null, view);
    }
  });

  it("rejects empty and missing goal ids", () => {
    assert.equal(resolveAgentPageGoalId("goal-detail", "  "), null);
    assert.equal(resolveAgentPageGoalId("goal-detail", undefined), null);
  });
});
