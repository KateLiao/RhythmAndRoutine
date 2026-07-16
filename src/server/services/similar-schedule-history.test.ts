import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScheduleBlockStatus } from "@/generated/prisma/enums";
import { summarizeSimilarScheduleHistory } from "@/server/services/schedule";

describe("similar schedule history summary", () => {
  it("summarizes common local start windows and median duration", () => {
    const summary = summarizeSimilarScheduleHistory([
      { id: "a", title: "吉他练习", startsAt: new Date("2026-07-01T11:00:00Z"), endsAt: new Date("2026-07-01T11:40:00Z"), status: ScheduleBlockStatus.COMPLETED },
      { id: "b", title: "吉他练习", startsAt: new Date("2026-07-03T11:30:00Z"), endsAt: new Date("2026-07-03T12:30:00Z"), status: ScheduleBlockStatus.COMPLETED },
      { id: "c", title: "温柔吉他练习", startsAt: new Date("2026-07-05T11:00:00Z"), endsAt: new Date("2026-07-05T11:50:00Z"), status: ScheduleBlockStatus.MISSED },
    ], "Asia/Shanghai");

    assert.equal(summary.sampleCount, 3);
    assert.equal(summary.typicalStartTime, "19:00");
    assert.equal(summary.typicalDurationMinutes, 50);
    assert.deepEqual(summary.commonWindows[0], { start: "19:00", end: "19:50", count: 2 });
    assert.equal(summary.samples[0]?.startsAt, "2026-07-01T11:00:00.000Z");
    assert.equal(summary.samples[0]?.localStartsAt, "2026-07-01T19:00");
  });

  it("returns an explicit empty summary when no history matches", () => {
    assert.deepEqual(summarizeSimilarScheduleHistory([], "Asia/Shanghai"), {
      sampleCount: 0,
      typicalStartTime: null,
      typicalDurationMinutes: null,
      commonWindows: [],
      samples: [],
    });
  });
});
