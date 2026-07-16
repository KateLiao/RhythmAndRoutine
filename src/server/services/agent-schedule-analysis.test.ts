import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAgentScheduleWindowResult, validateScheduleCandidates } from "@/server/services/agent-schedule-analysis";

describe("Agent schedule analysis", () => {
  const from = new Date("2026-07-16T10:00:00.000Z");
  const to = new Date("2026-07-16T16:00:00.000Z");
  const schedule = buildAgentScheduleWindowResult([
    { id: "old", title: "旧吉他安排", startsAt: "2026-07-16T11:00:00.000Z", endsAt: "2026-07-16T12:00:00.000Z", status: "rescheduled" },
    { id: "guitar", title: "吉他练习", startsAt: "2026-07-16T11:30:00.000Z", endsAt: "2026-07-16T12:00:00.000Z", status: "planned" },
    { id: "english", title: "英语练习", startsAt: "2026-07-16T12:30:00.000Z", endsAt: "2026-07-16T13:30:00.000Z", status: "planned" },
    { id: "routine-outside", title: "晨间冥想", startsAt: "2026-07-16T01:00:00.000Z", endsAt: "2026-07-16T01:15:00.000Z", status: "planned", source: "routine_occurrence" },
  ], from, to, "Asia/Shanghai");

  it("returns local busy intervals without stale or out-of-window rows", () => {
    assert.equal(schedule.itemCount, 2);
    assert.deepEqual(schedule.items.map((item) => item.title), ["吉他练习", "英语练习"]);
    assert.equal(schedule.items[0]?.localStartsAt, "2026-07-16T19:30");
  });

  it("detects conflicts with half-open interval semantics", () => {
    const result = validateScheduleCandidates([
      { label: "冲突阅读", startsAt: "2026-07-16T12:00:00.000Z", endsAt: "2026-07-16T13:00:00.000Z" },
      { label: "可用阅读", startsAt: "2026-07-16T13:30:00.000Z", endsAt: "2026-07-16T14:30:00.000Z" },
    ], schedule);
    assert.equal(result.allAvailable, false);
    assert.deepEqual(result.candidates[0]?.conflicts.map((item) => item.title), ["英语练习"]);
    assert.equal(result.candidates[1]?.available, true);
  });
});
