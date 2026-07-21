import assert from "node:assert/strict";
import test from "node:test";
import { executionFeedbackSchema, routineExecutionSchema } from "@/server/validation";

test("requires real invested minutes for partial progress", () => {
  assert.equal(executionFeedbackSchema.safeParse({ feedbackVersion: 2, result: "progressed" }).success, false);
  assert.equal(executionFeedbackSchema.safeParse({ feedbackVersion: 2, result: "progressed", actualMinutes: 25 }).success, true);
});

test("keeps no-progress records at zero minutes", () => {
  assert.equal(executionFeedbackSchema.safeParse({ feedbackVersion: 2, result: "no_progress", actualMinutes: 0 }).success, true);
  assert.equal(executionFeedbackSchema.safeParse({ feedbackVersion: 2, result: "no_progress", actualMinutes: 10 }).success, false);
});

test("accepts legacy results while allowing clients to mark the v2 contract explicitly", () => {
  const legacy = executionFeedbackSchema.parse({ result: "completed", tags: ["smooth"], quality: "great" });
  assert.equal(legacy.feedbackVersion, undefined);

  const rescheduled = executionFeedbackSchema.parse({ feedbackVersion: 2, result: "rescheduled" });
  assert.equal(rescheduled.feedbackVersion, 2);

  const routine = routineExecutionSchema.parse({
    routineId: "routine-1",
    occurrenceDate: "2026-07-21T00:00:00.000Z",
    status: "completed",
    feedbackVersion: 2,
    result: "achieved",
  });
  assert.equal(routine.feedbackVersion, 2);
});

test("distinguishes omitted legacy fields from explicit v2 clearing", () => {
  const omitted = executionFeedbackSchema.parse({ feedbackVersion: 2, result: "achieved", actualMinutes: 30 });
  assert.equal(omitted.tags, undefined);
  assert.equal(omitted.focusState, undefined);
  assert.equal(omitted.quality, undefined);
  assert.equal(omitted.note, undefined);

  const cleared = executionFeedbackSchema.parse({
    feedbackVersion: 2,
    result: "achieved",
    actualMinutes: 30,
    focusState: null,
    quality: null,
    note: null,
  });
  assert.equal(cleared.focusState, null);
  assert.equal(cleared.quality, null);
  assert.equal(cleared.note, null);
});
