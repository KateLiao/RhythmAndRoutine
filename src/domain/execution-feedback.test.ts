import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  executionResultHasInvestment,
  normalizeExecutionFocusState,
  normalizeExecutionOutcome,
  normalizeExecutionQuality,
  resolveExecutionFocusState,
} from "@/domain/execution-feedback";

describe("execution feedback v2 compatibility", () => {
  it("projects legacy outcomes without changing their stored meaning", () => {
    assert.equal(normalizeExecutionOutcome("completed"), "achieved");
    assert.equal(normalizeExecutionOutcome("not_completed"), "no_progress");
    assert.equal(normalizeExecutionOutcome("rescheduled"), "rescheduled");
  });

  it("keeps partial progress as real investment but excludes no progress", () => {
    assert.equal(executionResultHasInvestment("achieved"), true);
    assert.equal(executionResultHasInvestment("progressed"), true);
    assert.equal(executionResultHasInvestment("completed"), true);
    assert.equal(executionResultHasInvestment("no_progress"), false);
  });

  it("prefers an explicit v2 focus state and safely projects reliable legacy tags", () => {
    assert.equal(normalizeExecutionFocusState("under_challenged", ["resistant"]), "under_challenged");
    assert.equal(normalizeExecutionFocusState(undefined, ["smooth"]), "steady_focus");
    assert.equal(normalizeExecutionFocusState(undefined, ["interrupted"]), "fragmented");
    assert.equal(normalizeExecutionFocusState(undefined, ["high_energy"]), undefined);
    assert.equal(resolveExecutionFocusState(1, undefined, ["smooth"]), "steady_focus");
    assert.equal(resolveExecutionFocusState(2, undefined, ["smooth"]), undefined);
  });

  it("projects old quality values to the new three-level scale", () => {
    assert.equal(normalizeExecutionQuality("great"), "satisfying");
    assert.equal(normalizeExecutionQuality("good"), "expected");
    assert.equal(normalizeExecutionQuality("rough"), "needs_rework");
  });
});
