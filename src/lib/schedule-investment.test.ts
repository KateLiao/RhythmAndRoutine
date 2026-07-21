import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  enrichGoalsWithScheduleStats,
  enrichLocalGoalsWithExecution,
  scheduleBelongsToGoal,
  scheduleInvestedMinutes,
  type Goal,
  type ScheduleItem,
} from "@/lib/demo-data";
import { clampRoutineExpandWindow } from "@/server/services/schedule";

/**
 * 构造最小可测的日程块。
 * @param overrides - 覆盖字段
 */
function block(overrides: Partial<ScheduleItem> & Pick<ScheduleItem, "id" | "title">): ScheduleItem {
  return {
    goalId: "",
    start: "09:00",
    end: "10:00",
    kind: "task",
    status: "completed",
    energy: "medium",
    date: "2026-07-14",
    ...overrides,
  };
}

/**
 * 构造最小可测的目标。
 * @param overrides - 覆盖字段
 */
function goal(overrides: Partial<Goal> & Pick<Goal, "id" | "title">): Goal {
  return {
    description: "",
    status: "active",
    color: "violet",
    weeklyMinutes: 0,
    completedMinutes: 0,
    tasksDone: 0,
    tasksTotal: 0,
    tasks: [],
    ...overrides,
  };
}

describe("scheduleBelongsToGoal", () => {
  it("matches by goalId", () => {
    const g = goal({ id: "g1", title: "目标" });
    assert.equal(scheduleBelongsToGoal(block({ id: "b1", title: "块", goalId: "g1" }), g), true);
  });

  it("matches by linked task even when goalId is empty", () => {
    const g = goal({ id: "g1", title: "目标", tasks: [{ id: "t1", title: "任务", status: "ready", version: 1 }] });
    assert.equal(scheduleBelongsToGoal(block({ id: "b1", title: "块", taskIds: ["t1"] }), g), true);
  });

  it("excludes personal blocks", () => {
    const g = goal({ id: "g1", title: "目标" });
    assert.equal(scheduleBelongsToGoal(block({ id: "b1", title: "午休", kind: "personal", goalId: "g1" }), g), false);
  });
});

describe("scheduleInvestedMinutes", () => {
  it("prefers actual minutes and falls back to planned duration", () => {
    assert.equal(scheduleInvestedMinutes(block({ id: "b1", title: "a", execution: { result: "completed", actualMinutes: 35, tags: [] } })), 35);
    assert.equal(scheduleInvestedMinutes(block({ id: "b2", title: "b", execution: { result: "completed", actualMinutes: null, tags: [] } })), 60);
    assert.equal(scheduleInvestedMinutes(block({ id: "b3", title: "c", status: "planned" })), 0);
  });
});

describe("enrichGoalsWithScheduleStats", () => {
  it("fills weekly planned and completed minutes from schedule", () => {
    const goals = [goal({ id: "g1", title: "目标", tasks: [{ id: "t1", title: "任务", status: "ready", version: 1 }] })];
    const schedule = [
      block({ id: "b1", title: "完成", goalId: "g1", date: "2026-07-14", execution: { result: "completed", actualMinutes: 40, tags: [] } }),
      block({ id: "b2", title: "计划", goalId: "g1", date: "2026-07-14", status: "planned", start: "14:00", end: "15:30" }),
      block({ id: "b3", title: "上周", goalId: "g1", date: "2026-07-06", execution: { result: "completed", actualMinutes: 90, tags: [] } }),
    ];
    const enriched = enrichGoalsWithScheduleStats(goals, schedule, new Set(["2026-07-14"]));
    assert.equal(enriched[0].completedMinutes, 40);
    assert.equal(enriched[0].weeklyMinutes, 60 + 90);
  });
});

describe("enrichLocalGoalsWithExecution", () => {
  it("persists unlocked achievements and deterministic milestone suggestions in browser-local data", () => {
    const goals = [goal({
      id: "g1",
      title: "本地目标",
      category: "project",
      milestones: [{ id: "m1", title: "投入半小时", status: "pending", version: 1, completionCriteria: { version: 1, mode: "all", items: [{ id: "time", label: "累计真实投入 30 分钟", evaluator: "invested_minutes", threshold: 30 }] } }],
    })];
    const schedule = [block({ id: "b1", title: "完成", goalId: "g1", date: "2026-07-14", execution: { result: "completed", actualMinutes: 40, tags: [] } })];
    const first = enrichLocalGoalsWithExecution(goals, schedule, "Asia/Shanghai", new Date("2026-07-15T04:00:00.000Z"));
    const second = enrichLocalGoalsWithExecution(first, schedule, "Asia/Shanghai", new Date("2026-07-16T04:00:00.000Z"));

    assert.equal(first[0].execution?.weekInvestedMinutes, 40);
    assert.equal(first[0].execution?.achievements.find((item) => item.id === "core.first_investment")?.state, "unlocked");
    assert.equal(second[0].achievementHistory?.find((item) => item.achievementId === "core.first_investment")?.unlockedAt, first[0].achievementHistory?.find((item) => item.achievementId === "core.first_investment")?.unlockedAt);
    assert.equal(first[0].milestones?.[0]?.reviewSuggestions?.[0]?.status, "pending");
    assert.equal(second[0].milestones?.[0]?.reviewSuggestions?.length, 1);
  });
});

describe("clampRoutineExpandWindow", () => {
  it("keeps short windows unchanged and clamps long windows to 93 days ending at to", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const to = new Date("2026-08-01T00:00:00.000Z");
    const short = clampRoutineExpandWindow(new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-20T00:00:00.000Z"));
    assert.equal(short.from.toISOString(), "2026-07-01T00:00:00.000Z");
    const clamped = clampRoutineExpandWindow(from, to);
    assert.equal(clamped.to.toISOString(), to.toISOString());
    assert.equal(clamped.from.getTime(), to.getTime() - 93 * 86400000);
  });
});
