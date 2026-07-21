import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GoalStatus, MilestoneStatus, ScheduleBlockStatus } from "@/generated/prisma/enums";
import { definitionsForModules, deriveGoalActionHint, evaluateAchievement, resolveAchievementModules } from "@/domain/goal-achievements";
import { evaluateMilestoneCriteria } from "@/domain/milestone-suggestions";
import { projectGoalExecutionFacts, type GoalProjection, type ScheduleProjection } from "@/server/services/goal-execution";

const NOW = new Date("2026-07-15T04:00:00.000Z");

function goal(overrides: Partial<GoalProjection> = {}): GoalProjection {
  return {
    id: "goal-1",
    status: GoalStatus.ACTIVE,
    category: "project",
    project: "V0.4.0",
    skill: null,
    targetDate: null,
    outcomes: [],
    milestones: [],
    tasks: [],
    routines: [],
    ...overrides,
  };
}

function block(overrides: Partial<ScheduleProjection> & Pick<ScheduleProjection, "id">): ScheduleProjection {
  return {
    userId: "user-1",
    goalId: "goal-1",
    taskId: null,
    routineId: null,
    startsAt: new Date("2026-07-14T01:00:00.000Z"),
    endsAt: new Date("2026-07-14T02:00:00.000Z"),
    status: ScheduleBlockStatus.COMPLETED,
    rescheduledFromId: null,
    deletedAt: null,
    linkedTasks: [],
    executionRecord: null,
    ...overrides,
  };
}

describe("projectGoalExecutionFacts", () => {
  it("uses actual minutes, excludes rescheduled predecessors, and keeps honest weekly plan", () => {
    const facts = projectGoalExecutionFacts(goal(), [
      block({ id: "old", status: ScheduleBlockStatus.RESCHEDULED }),
      block({ id: "next", rescheduledFromId: "old", startsAt: new Date("2026-07-15T01:00:00.000Z"), endsAt: new Date("2026-07-15T02:30:00.000Z"), executionRecord: { actualMinutes: 45 } }),
      block({ id: "planned", status: ScheduleBlockStatus.PLANNED, startsAt: new Date("2026-07-16T01:00:00.000Z"), endsAt: new Date("2026-07-16T02:00:00.000Z") }),
    ], "Asia/Shanghai", NOW);

    assert.equal(facts.investedMinutes, 45);
    assert.equal(facts.weekInvestedMinutes, 45);
    assert.equal(facts.weekPlannedMinutes, 150);
    assert.equal(facts.completedSessions, 1);
    assert.equal(facts.evidenceRefs.find((ref) => ref.id === "schedule:next")?.estimated, false);
  });

  it("deduplicates a Routine occurrence represented by both calendar and execution record", () => {
    const occurrenceDate = new Date("2026-07-14T16:00:00.000Z");
    const facts = projectGoalExecutionFacts(goal({
      category: "routine",
      routines: [{ id: "routine-1", durationMinutes: 30, archivedAt: null, executionRecords: [{ id: "record-1", occurrenceDate, plannedStartAt: null, plannedEndAt: null, status: "completed", actualMinutes: 25 }] }],
    }), [
      block({ id: "routine-block", routineId: "routine-1", startsAt: new Date("2026-07-14T16:00:00.000Z"), endsAt: new Date("2026-07-14T16:30:00.000Z"), executionRecord: null }),
    ], "Asia/Shanghai", NOW);

    assert.equal(facts.routineCompletedCount, 1);
    assert.equal(facts.completedSessions, 1);
    assert.equal(facts.investedMinutes, 25);
    assert.deepEqual(facts.activeDateKeys, ["2026-07-15"]);
  });

  it("counts only user-confirmed tasks with a completion record", () => {
    const facts = projectGoalExecutionFacts(goal({
      tasks: [
        { id: "confirmed", completedAt: new Date("2026-07-14T03:00:00.000Z"), completionRecord: { source: "rules" } },
        { id: "legacy-terminal", completedAt: new Date("2026-07-14T04:00:00.000Z"), completionRecord: null },
        ...Array.from({ length: 8 }, (_, index) => ({ id: `split-${index}`, completedAt: null, completionRecord: null })),
      ],
    }), [], "Asia/Shanghai", NOW);
    const delivery = definitionsForModules(["project"]).find((definition) => definition.id === "project.first_delivery")!;

    assert.equal(facts.confirmedTaskCount, 1);
    assert.equal(evaluateAchievement(delivery, facts).met, true);
  });
});

describe("achievement modules", () => {
  it("composes core with every applicable goal module without a mixed-only branch", () => {
    const modules = resolveAchievementModules({ category: "mixed", project: "产品", skill: "表达", hasRoutine: true });
    assert.deepEqual(modules, ["core", "project", "skill", "routine"]);
    assert.equal(new Set(definitionsForModules(modules).map((definition) => definition.id)).size, definitionsForModules(modules).length);
  });
});

describe("milestone completion criteria", () => {
  it("creates machine evidence only when all public criteria are met", () => {
    const facts = projectGoalExecutionFacts(goal({
      tasks: [{ id: "task-1", completedAt: new Date("2026-07-14T03:00:00.000Z"), completionRecord: { source: "rules" } }],
      milestones: [{ id: "milestone-1", status: MilestoneStatus.PENDING, targetDate: null, completedAt: null }],
    }), [block({ id: "session", executionRecord: { actualMinutes: 60 } })], "Asia/Shanghai", NOW);

    const result = evaluateMilestoneCriteria({
      version: 1,
      mode: "all",
      items: [
        { id: "delivery", label: "完成交付任务", evaluator: "linked_task_completed", sourceIds: ["task-1"] },
        { id: "time", label: "投入一小时", evaluator: "invested_minutes", threshold: 60 },
      ],
    }, facts);

    assert.equal(result?.met, true);
    assert.equal(result?.results.length, 2);
    assert.equal(evaluateMilestoneCriteria({ version: 1, mode: "all", items: [{ id: "manual", label: "我认可结果", evaluator: "manual_only" }] }, facts), null);
  });

  it("keeps a milestone pending while evidence is below the public threshold", () => {
    const facts = projectGoalExecutionFacts(goal(), [block({ id: "short-session", executionRecord: { actualMinutes: 40 } })], "Asia/Shanghai", NOW);
    const result = evaluateMilestoneCriteria({
      version: 1,
      mode: "all",
      items: [{ id: "time", label: "累计投入两小时", evaluator: "invested_minutes", threshold: 120 }],
    }, facts);

    assert.equal(result?.met, false);
    assert.equal(result?.results[0]?.current, 40);
    assert.equal(result?.results[0]?.target, 120);
  });

  it("supports an explicit any-mode milestone without treating its other criteria as required", () => {
    const facts = projectGoalExecutionFacts(goal(), [block({ id: "active-day", executionRecord: { actualMinutes: 25 } })], "Asia/Shanghai", NOW);
    const result = evaluateMilestoneCriteria({
      version: 1,
      mode: "any",
      items: [
        { id: "time", label: "累计投入十小时", evaluator: "invested_minutes", threshold: 600 },
        { id: "day", label: "至少一个有效执行日", evaluator: "active_days", threshold: 1 },
      ],
    }, facts);

    assert.equal(result?.met, true);
    assert.deepEqual(result?.results.map((item) => item.met), [false, true]);
  });
});

describe("goal action hint", () => {
  it("prioritizes a pending milestone review over planning or drift copy", () => {
    assert.deepEqual(deriveGoalActionHint({
      lifecycleStatus: "active",
      pendingMilestoneSuggestions: 1,
      overdueMilestones: 2,
      weekPlannedMinutes: 180,
      weekInvestedMinutes: 0,
    }), {
      kind: "milestone_review",
      label: "有里程碑待确认",
      detail: "1 个阶段成果等待你的判断",
    });
  });
});
