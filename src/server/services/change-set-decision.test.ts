import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChangeSetStatus } from "@/generated/prisma/enums";
import { normalizeAgentChangePayload } from "@/lib/change-operation-display";
import {
  canonicalizeChangeSetOperationReferences,
  createdOperationReferenceKeys,
  isIdempotentChangeSetRejection,
  prepareChangeSetOperations,
  projectScheduleCandidates,
  withStableOperationId,
} from "@/server/services/change-sets";

describe("ChangeSet decision convergence", () => {
  it("treats a repeated rejection as idempotent success", () => {
    assert.equal(isIdempotentChangeSetRejection(ChangeSetStatus.REJECTED, false), true);
  });

  it("does not treat approval or other terminal states as an idempotent rejection", () => {
    assert.equal(isIdempotentChangeSetRejection(ChangeSetStatus.REJECTED, true), false);
    assert.equal(isIdempotentChangeSetRejection(ChangeSetStatus.APPLIED, false), false);
    assert.equal(isIdempotentChangeSetRejection(ChangeSetStatus.AWAITING_CONFIRMATION, false), false);
    assert.equal(isIdempotentChangeSetRejection(ChangeSetStatus.SUPERSEDED, false), false);
  });

  it("adds a deterministic operation id without replacing an existing one", () => {
    const operation = { type: "create", entity: "schedule", payload: { title: "阅读", startsAt: "2026-07-21T02:00:00.000Z", endsAt: "2026-07-21T03:00:00.000Z" } };
    assert.equal(withStableOperationId(operation, 0).operationId, withStableOperationId(operation, 0).operationId);
    assert.equal(withStableOperationId({ ...operation, operationId: "keep-me" }, 0).operationId, "keep-me");
  });

  it("projects only timed schedule writes for apply-time conflict checks", () => {
    const candidates = projectScheduleCandidates([
      { operationId: "op-1", type: "create", entity: "schedule", payload: { title: "阅读", startsAt: "2026-07-21T02:00:00.000Z", endsAt: "2026-07-21T03:00:00.000Z", goalId: "goal-1" } },
      { operationId: "op-2", type: "update", entity: "schedule", entityId: "schedule-1", before: {}, after: { title: "只改标题" } },
      { operationId: "op-3", type: "create", entity: "task", payload: { title: "任务" } },
    ]);
    assert.deepEqual(candidates.map((candidate) => ({ operationId: candidate.operationId, title: candidate.title })), [{ operationId: "op-1", title: "阅读" }]);
  });

  it("canonicalizes the screenshot regression from temporary goalId to goalRef", () => {
    const operations = canonicalizeChangeSetOperationReferences([
      {
        operationId: "create-goal-missing-semester",
        type: "create",
        entity: "goal",
        payload: { title: "完成 The Missing Semester of CS 课程", deadline: "2026-08-10" },
      },
      {
        operationId: "schedule-7-21",
        type: "create",
        entity: "schedule",
        payload: {
          title: "学习 The Missing Semester - Lecture 1-2",
          goalId: "create-goal-missing-semester",
          startsAt: "2026-07-21T19:30:00+08:00",
          endsAt: "2026-07-21T21:30:00+08:00",
        },
      },
    ]);
    assert.deepEqual(operations[0].payload, { title: "完成 The Missing Semester of CS 课程", targetDate: "2026-08-10" });
    assert.equal((operations[1].payload as Record<string, unknown>).goalId, undefined);
    assert.equal((operations[1].payload as Record<string, unknown>).goalRef, "create-goal-missing-semester");
  });

  it("maps operationId together with legacy create reference aliases", () => {
    assert.deepEqual(
      createdOperationReferenceKeys({ operationId: "goal-op", type: "create", entity: "goal", payload: { clientRef: "goal-client", tempId: "goal-temp" } }),
      ["goal-op", "goal-client", "goal-temp"],
    );
  });

  it("adds parent create dependencies for partial approval and sorts them before children", () => {
    const prepared = prepareChangeSetOperations([
      {
        operationId: "schedule-op",
        type: "create",
        entity: "schedule",
        payload: { title: "课程学习", goalRef: "goal-op", startsAt: "2026-07-21T19:30:00+08:00", endsAt: "2026-07-21T21:30:00+08:00" },
      },
      { operationId: "goal-op", type: "create", entity: "goal", payload: { title: "课程目标" } },
    ], [0]);
    assert.deepEqual(prepared.map((operation) => operation.operationId), ["goal-op", "schedule-op"]);
  });

  it("does not reinterpret an explicit empty selection as approval of every operation", () => {
    assert.throws(
      () => prepareChangeSetOperations([
        { operationId: "goal-op", type: "create", entity: "goal", payload: { title: "课程目标" } },
      ], []),
      /至少选择一项/,
    );
  });

  it("rejects unknown and wrong-entity internal references before confirmation", () => {
    assert.throws(
      () => canonicalizeChangeSetOperationReferences([
        { operationId: "schedule-op", type: "create", entity: "schedule", payload: { title: "学习", goalRef: "missing-goal" } },
      ]),
      /没有对应的新增操作/,
    );
    assert.throws(
      () => canonicalizeChangeSetOperationReferences([
        { operationId: "task-op", type: "create", entity: "task", payload: { title: "任务" } },
        { operationId: "schedule-op", type: "create", entity: "schedule", payload: { title: "学习", goalRef: "task-op" } },
      ]),
      /这里需要 goal/,
    );
  });

  it("rejects duplicate aliases and cyclic dependencies before application", () => {
    assert.throws(
      () => canonicalizeChangeSetOperationReferences([
        { operationId: "goal-a", type: "create", entity: "goal", payload: { title: "A", clientRef: "same-goal" } },
        { operationId: "goal-b", type: "create", entity: "goal", payload: { title: "B", clientRef: "same-goal" } },
      ]),
      /指向了多个新增对象/,
    );
    assert.throws(
      () => prepareChangeSetOperations([
        { operationId: "task-a", type: "create", entity: "task", payload: { title: "A", parentTaskRef: "task-b" } },
        { operationId: "task-b", type: "create", entity: "task", payload: { title: "B", parentTaskRef: "task-a" } },
      ]),
      /循环引用/,
    );
  });

  it("normalizes both dueDate and deadline to targetDate", () => {
    assert.deepEqual(normalizeAgentChangePayload("goal", { title: "目标", deadline: "2026-08-10" }), { title: "目标", targetDate: "2026-08-10" });
    assert.deepEqual(normalizeAgentChangePayload("goal", { title: "目标", dueDate: "2026-08-11" }), { title: "目标", targetDate: "2026-08-11" });
  });
});
