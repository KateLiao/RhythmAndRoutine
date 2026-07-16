import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capabilityPolicies } from "@/agent/capabilities";
import { needsCandidateValidationBeforeFinal, validateSchedulePlanningPrerequisites } from "@/agent/runtime";
import { createToolRegistry, type AgentDomainGateway } from "@/agent/tool-registry";

function createGateway(overrides: Partial<AgentDomainGateway> = {}): AgentDomainGateway {
  return {
    readGoalContext: async () => [],
    readScheduleWindow: async () => [],
    readSimilarScheduleHistory: async () => ({ sampleCount: 0 }),
    validateScheduleCandidates: async () => ({ allAvailable: true, candidates: [] }),
    readExecutionHistory: async () => [],
    readRecentReviews: async () => [],
    readRhythmSignals: async () => [],
    createChangeSet: async () => ({ id: "change-set" }),
    ...overrides,
  };
}

describe("schedule planning guardrails", () => {
  it("requires conflict checks, meal-time awareness, and conditional habit lookup", () => {
    for (const capability of ["planning", "adjustment"] as const) {
      const policy = capabilityPolicies[capability];
      assert.match(policy.system, /必须先用 read_schedule_window/);
      assert.match(policy.system, /\[startsAt, endsAt\)/);
      assert.match(policy.system, /11:30–13:30/);
      assert.match(policy.system, /18:00–19:30/);
      assert.match(policy.system, /只有当用户明确表达/);
      assert.ok(policy.allowedTools.includes("read_similar_schedule_history"));
      assert.ok(policy.allowedTools.includes("validate_schedule_candidates"));
    }
  });

  it("registers and executes the similar-history read tool with safe defaults", async () => {
    let received: unknown;
    const registry = createToolRegistry(createGateway({
      readSimilarScheduleHistory: async (_userId, input) => {
        received = input;
        return { sampleCount: 2, typicalStartTime: "19:00" };
      },
    }));
    const tool = registry.get("read_similar_schedule_history");
    assert.ok(tool);

    const result = await tool.execute({ query: "吉他练习" }, { userId: "user", runId: "run", idempotencyKey: "key" });
    assert.deepEqual(received, { query: "吉他练习", days: 90, limit: 12 });
    assert.deepEqual(result, { ok: true, data: { sampleCount: 2, typicalStartTime: "19:00" } });
  });

  it("rejects a history lookup with no similarity clue", async () => {
    const tool = createToolRegistry(createGateway()).get("read_similar_schedule_history");
    assert.ok(tool);
    await assert.rejects(() => tool.execute({}, { userId: "user", runId: "run", idempotencyKey: "key" }));
  });

  it("blocks a concrete schedule draft until the current window was checked", () => {
    const draft = { operations: [{ type: "create", entity: "schedule", payload: { title: "吉他练习", startsAt: "2026-07-16T12:00:00Z", endsAt: "2026-07-16T13:00:00Z" } }] };
    assert.equal(
      validateSchedulePlanningPrerequisites("propose_change_set", draft, [])?.ok,
      false,
    );
    assert.equal(
      validateSchedulePlanningPrerequisites(
        "propose_change_set",
        draft,
        ["read_schedule_window", "validate_schedule_candidates"],
        [{ name: "validate_schedule_candidates", input: {}, data: { allAvailable: true, candidates: [{ startsAt: "2026-07-16T12:00:00Z", endsAt: "2026-07-16T13:00:00Z" }] } }],
      ),
      null,
    );
  });

  it("requires a fresh conflict check after reading historical habits", () => {
    const draft = { operations: [{ type: "update", entity: "personal_schedule", after: { title: "运动" } }] };
    const stale = validateSchedulePlanningPrerequisites(
      "propose_change_set",
      draft,
      ["read_schedule_window", "read_similar_schedule_history"],
    );
    assert.equal(stale && !stale.ok ? stale.code : null, "SCHEDULE_WINDOW_REQUIRED");
    const freshWindowOnly = validateSchedulePlanningPrerequisites(
        "propose_change_set",
        draft,
        ["read_similar_schedule_history", "read_schedule_window"],
      );
    assert.equal(freshWindowOnly && !freshWindowOnly.ok ? freshWindowOnly.code : null, "SCHEDULE_CANDIDATE_VALIDATION_REQUIRED");
  });

  it("blocks a draft when the validated candidates still conflict", () => {
    const draft = { operations: [{ type: "create", entity: "schedule", payload: { startsAt: "2026-07-16T12:00:00Z", endsAt: "2026-07-16T13:00:00Z" } }] };
    const result = validateSchedulePlanningPrerequisites(
      "propose_change_set",
      draft,
      ["read_schedule_window", "validate_schedule_candidates"],
      [{ name: "validate_schedule_candidates", input: {}, data: { allAvailable: false, candidates: [] } }],
    );
    assert.equal(result && !result.ok ? result.code : null, "SCHEDULE_CONFLICT");
  });

  it("intercepts a concrete recommendation before final candidate validation", () => {
    const text = "建议这周每天安排在 20:00-21:00，这些时间都空闲。";
    assert.equal(needsCandidateValidationBeforeFinal(text, ["read_schedule_window"], []), true);
    assert.equal(needsCandidateValidationBeforeFinal(
      text,
      ["read_schedule_window", "validate_schedule_candidates"],
      [{ name: "validate_schedule_candidates", input: {}, data: { allAvailable: true, candidates: [{ localStartsAt: "2026-07-16T20:00", localEndsAt: "2026-07-16T21:00" }] } }],
    ), false);
    assert.equal(needsCandidateValidationBeforeFinal(
      "建议安排在 22:00-23:00。",
      ["read_schedule_window", "validate_schedule_candidates"],
      [{ name: "validate_schedule_candidates", input: {}, data: { allAvailable: true, candidates: [{ localStartsAt: "2026-07-16T20:00", localEndsAt: "2026-07-16T21:00" }] } }],
    ), true);
    assert.equal(needsCandidateValidationBeforeFinal("你今天已安排 19:30-20:00 吉他练习。", ["read_schedule_window"], []), false);
  });
});
