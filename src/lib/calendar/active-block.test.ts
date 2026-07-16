import assert from "node:assert/strict";
import test from "node:test";
import type { ScheduleItem } from "@/lib/demo-data";
import { isActiveCalendarBlock } from "./active-block";

const base: ScheduleItem = {
  id: "block-1",
  title: "健身",
  goalId: "goal-1",
  start: "19:00",
  end: "20:00",
  kind: "routine",
  status: "planned",
  energy: "medium",
};

test("isActiveCalendarBlock keeps planned and completed blocks visible", () => {
  assert.equal(isActiveCalendarBlock({ ...base, status: "planned" }), true);
  assert.equal(isActiveCalendarBlock({ ...base, status: "completed" }), true);
});

test("isActiveCalendarBlock hides cancelled and superseded task reschedule history", () => {
  assert.equal(isActiveCalendarBlock({ ...base, kind: "task", status: "cancelled" }), false);
  assert.equal(isActiveCalendarBlock({ ...base, kind: "task", status: "rescheduled" }), false);
});

test("isActiveCalendarBlock keeps dragged routine occurrences visible after rescheduled status", () => {
  assert.equal(
    isActiveCalendarBlock({
      ...base,
      status: "rescheduled",
      source: "routine_occurrence",
      changeReason: "拖动调整时间",
    }),
    true,
  );
});
