import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelAdapter, StructuredRequest } from "./types";
import {
  applyDeterministicProposalPatch,
  applyReorderDecision,
  buildContinuationCapsule,
  normalizeReorderDecisionResponse,
  parseProposalPatchInstruction,
  rescheduleProposalItem,
  resolveAffectedProposalOperations,
  validateReorderDecision,
  type ReorderContext,
  type ReorderDecision,
} from "./proposal-continuation";
import { resolveIntent } from "./intent-resolver";
import { generateReorderDecision, interpretAmbiguousProposalTime } from "@/server/services/proposal-continuation";

const operations = [
  { operationId: "op-read", type: "create", entity: "schedule", payload: { title: "阅读 LLM 论文", startsAt: "2026-07-21T02:30:00.000Z", endsAt: "2026-07-21T04:00:00.000Z", goalId: "goal-1" } },
  { operationId: "op-bank", type: "create", entity: "personal_schedule", payload: { title: "去银行", startsAt: "2026-07-21T06:00:00.000Z", endsAt: "2026-07-21T07:00:00.000Z", blockKind: "personal" } },
  { operationId: "op-write", type: "create", entity: "schedule", payload: { title: "写小红书笔记", startsAt: "2026-07-21T08:30:00.000Z", endsAt: "2026-07-21T09:15:00.000Z", goalId: "goal-2" } },
];

describe("proposal continuation intent", () => {
  it("recognizes a dotted single-time edit as item reschedule", () => {
    const result = resolveIntent({
      prompt: "第一个日程可以从 10.15 开始，其他没问题",
      view: "today",
      activeChangeSetId: "change-1",
      conversationId: "conversation-1",
      parentRunId: "run-1",
      recentMessages: [{ role: "assistant", content: "10:30-12:00 阅读，14:00-15:00 去银行" }],
    });
    assert.equal(result.adjustment?.kind, "proposal_item_reschedule");
    assert.equal(result.adjustment?.startTime, "10:15");
    assert.deepEqual(result.adjustment?.operationRefs, [{ ordinal: 1 }]);
    assert.equal(result.needsClarification, false);
  });

  it("recognizes an unspecified-time order change without demanding a time", () => {
    const result = resolveIntent({ prompt: "把银行放到阅读前面，你看怎么安排合理", view: "today", activeChangeSetId: "change-1" });
    assert.equal(result.adjustment?.kind, "proposal_reorder");
    assert.equal(result.adjustment?.timingSpecified, false);
    assert.equal(result.needsClarification, false);
  });

  it("keeps a Chinese time without day period for bounded model interpretation", () => {
    const result = resolveIntent({
      prompt: "英语学习的开始时间推迟到 5 点半吧。",
      view: "today",
      activeChangeSetId: "change-1",
      conversationId: "conversation-1",
      parentRunId: "run-1",
    });
    assert.equal(result.adjustment?.kind, "proposal_item_reschedule");
    assert.equal(result.adjustment?.timingSpecified, true);
    assert.equal(result.adjustment?.timeExpression, "5 点半");
    assert.equal(result.adjustment?.timeAmbiguous, true);
    assert.equal(result.adjustment?.timeRelation, "later");
    assert.equal(result.adjustment?.startTime, undefined);
  });

  it("normalizes an explicit Chinese day period without a model", () => {
    const result = resolveIntent({ prompt: "英语学习改到下午 5 点半", view: "today", activeChangeSetId: "change-1" });
    assert.equal(result.adjustment?.kind, "proposal_item_reschedule");
    assert.equal(result.adjustment?.startTime, "17:30");
    assert.equal(result.adjustment?.timeAmbiguous, false);
  });
});

describe("proposal item patch", () => {
  it("preserves duration, operation ids, and every untouched operation", () => {
    const beforeUntouched = structuredClone(operations[1]);
    const revised = rescheduleProposalItem({ operations, targetOperationId: "op-read", startTime: "10:15", timezone: "Asia/Shanghai" });
    const read = (revised[0] as typeof operations[number]).payload;
    assert.equal(read.startsAt, "2026-07-21T02:15:00.000Z");
    assert.equal(read.endsAt, "2026-07-21T03:45:00.000Z");
    assert.deepEqual(revised[1], beforeUntouched);
    assert.deepEqual(revised.map((operation) => operation.operationId), ["op-read", "op-bank", "op-write"]);
  });

  it("parses delete-and-add feedback and preserves every untouched operation", () => {
    const instruction = parseProposalPatchInstruction("删除第三项，再加一个 30 分钟散步");
    assert.deepEqual(instruction, {
      removeSelected: true,
      addition: { title: "散步", durationMinutes: 30 },
    });
    const revised = applyDeterministicProposalPatch({
      operations,
      selectedOperationIds: ["op-write"],
      removeSelected: instruction.removeSelected,
    });
    assert.deepEqual(revised, operations.slice(0, 2));
    assert.deepEqual(revised[0], operations[0]);
    assert.deepEqual(revised[1], operations[1]);
  });

  it("changes only the selected title and keeps its operation id", () => {
    const instruction = parseProposalPatchInstruction("把第二项标题改成去办银行卡");
    const revised = applyDeterministicProposalPatch({
      operations,
      selectedOperationIds: ["op-bank"],
      replacementTitle: instruction.replacementTitle,
    });
    assert.equal((revised[1] as typeof operations[number]).operationId, "op-bank");
    assert.equal((revised[1] as typeof operations[number]).payload.title, "去办银行卡");
    assert.deepEqual(revised[0], operations[0]);
    assert.deepEqual(revised[2], operations[2]);
  });
});

describe("model-driven proposal reorder", () => {
  const context: ReorderContext = {
    timezone: "Asia/Shanghai",
    instruction: "把银行放到阅读前面，你看怎么安排合理",
    window: { startsAt: "2026-07-20T22:00:00.000Z", endsAt: "2026-07-21T15:59:59.000Z" },
    affectedOperations: [
      { operationId: "op-read", title: "阅读 LLM 论文", blockKind: "schedule", durationMinutes: 90, currentStartsAt: "2026-07-21T02:30:00.000Z", currentEndsAt: "2026-07-21T04:00:00.000Z", fixed: false, explicitConstraints: [] },
      { operationId: "op-bank", title: "去银行", blockKind: "personal", durationMinutes: 60, currentStartsAt: "2026-07-21T06:00:00.000Z", currentEndsAt: "2026-07-21T07:00:00.000Z", fixed: false, explicitConstraints: [] },
    ],
    hardConstraints: ["保持原时长"],
    softConstraints: ["避开午餐"],
    availableIntervals: [{ startsAt: "2026-07-21T01:00:00.000Z", endsAt: "2026-07-21T08:00:00.000Z" }],
    neighboringProposalOperations: [{ operationId: "op-write", title: "写小红书笔记", startsAt: "2026-07-21T08:30:00.000Z", endsAt: "2026-07-21T09:15:00.000Z" }],
  };
  const decision: ReorderDecision = {
    affectedOperationIds: ["op-bank", "op-read"],
    candidates: [
      { operationId: "op-bank", startsAt: "2026-07-21T01:00:00.000Z", endsAt: "2026-07-21T02:00:00.000Z", reason: "先处理需要外出的事务" },
      { operationId: "op-read", startsAt: "2026-07-21T02:15:00.000Z", endsAt: "2026-07-21T03:45:00.000Z", reason: "随后保留完整专注时段" },
    ],
    reasoningSummary: "先外出，再安排连续阅读。",
    assumptions: ["银行在上午可办理业务，此信息尚未核实"],
    needsClarification: false,
  };

  it("selects named operations from the actual proposal", () => {
    const affected = resolveAffectedProposalOperations({ operations, prompt: context.instruction, refs: [], kind: "proposal_reorder" });
    assert.deepEqual(affected.map((operation) => operation.operationId), ["op-read", "op-bank"]);
  });

  it("really calls the selected model adapter for unspecified times", async () => {
    let calls = 0;
    let captured: StructuredRequest<unknown> | undefined;
    const adapter: ModelAdapter = {
      provider: "test",
      async *stream() {},
      async generateObject<T>(request: StructuredRequest<T>) { calls += 1; captured = request as StructuredRequest<unknown>; return decision as T; },
    };
    const result = await generateReorderDecision(adapter, "test-model", context, undefined, undefined, () => {});
    assert.equal(calls, 1);
    assert.match(captured?.prompt ?? "", /op-bank/);
    assert.match(captured?.prompt ?? "", /localStartsAt[^\n]*09:00/);
    assert.match(captured?.system ?? "", /不得把 01:00Z 描述为本地凌晨 1 点/);
    assert.equal(captured?.maxRetries, 0);
    assert.deepEqual(result, decision);
  });

  it("normalizes provider wrappers without inventing missing operations", () => {
    const normalized = normalizeReorderDecisionResponse({
      reorderDecision: {
        operationId: "op-bank",
        newStartsAt: "2026-07-21T01:00:00.000Z",
        newEndsAt: "2026-07-21T02:00:00.000Z",
        reasoning: "先办理外出事务",
      },
    }) as ReorderDecision;
    assert.deepEqual(normalized.affectedOperationIds, ["op-bank"]);
    assert.deepEqual(normalized.candidates, [{
      operationId: "op-bank",
      startsAt: "2026-07-21T01:00:00.000Z",
      endsAt: "2026-07-21T02:00:00.000Z",
      reason: "先办理外出事务",
    }]);
    assert.equal(validateReorderDecision(context, normalized).valid, false);
    assert.ok(validateReorderDecision(context, normalized).issues.some((issue) => issue.code === "MISSING_OPERATION"));
  });

  it("fills presentation-only fields while keeping provider candidates unchanged", () => {
    const normalized = normalizeReorderDecisionResponse({
      affectedOperationIds: ["op-bank", "op-read"],
      candidates: decision.candidates.map((candidate) => ({ operationId: candidate.operationId, startsAt: candidate.startsAt, endsAt: candidate.endsAt })),
      reasoningSummary: "先处理外出事务，再保留连续阅读时间。",
      assumptions: [],
      needsClarification: [],
    }) as ReorderDecision;
    assert.equal(normalized.needsClarification, false);
    assert.equal(normalized.candidates[0]?.reason, "先处理外出事务，再保留连续阅读时间。");
    assert.deepEqual(normalized.candidates.map(({ operationId, startsAt, endsAt }) => ({ operationId, startsAt, endsAt })), decision.candidates.map(({ operationId, startsAt, endsAt }) => ({ operationId, startsAt, endsAt })));
    assert.equal(validateReorderDecision(context, normalized).valid, true);
  });

  it("accepts a valid decision and changes no unrelated operation", () => {
    assert.equal(validateReorderDecision(context, decision).valid, true);
    const revised = applyReorderDecision(operations, decision);
    assert.deepEqual(revised[2], operations[2]);
    assert.equal((revised[1] as typeof operations[number]).payload.startsAt, "2026-07-21T01:00:00.000Z");
  });

  it("rejects silent duration changes and unknown operations", () => {
    const invalid: ReorderDecision = {
      ...decision,
      candidates: [
        { ...decision.candidates[0]!, endsAt: "2026-07-21T02:30:00.000Z" },
        { operationId: "op-unknown", startsAt: "2026-07-21T03:00:00.000Z", endsAt: "2026-07-21T04:00:00.000Z", reason: "bad" },
      ],
    };
    const codes = new Set(validateReorderDecision(context, invalid).issues.map((issue) => issue.code));
    assert.ok(codes.has("DURATION_CHANGED"));
    assert.ok(codes.has("UNKNOWN_OPERATION"));
    assert.ok(codes.has("MISSING_OPERATION"));
  });

  it("rejects a semantically plausible time outside verified available intervals", () => {
    const invalid: ReorderDecision = {
      ...decision,
      candidates: [
        { ...decision.candidates[0]!, startsAt: "2026-07-21T08:00:00.000Z", endsAt: "2026-07-21T09:00:00.000Z" },
        decision.candidates[1]!,
      ],
    };
    assert.ok(validateReorderDecision(context, invalid).issues.some((issue) => issue.code === "OUTSIDE_AVAILABLE_INTERVAL"));
  });

  it("keeps the continuation capsule valid and bounded", () => {
    const capsule = buildContinuationCapsule({ proposalId: "change-1", parentRunId: "run-1", operations: [...operations, ...Array.from({ length: 30 }, (_, index) => ({ ...operations[2], operationId: `extra-${index}`, payload: { ...operations[2].payload, title: `很长的日程标题 ${index}` } }))], targetOperationIds: ["op-bank"] });
    assert.ok(JSON.stringify(capsule).length <= 1500);
    assert.equal(capsule.operations[0]?.operationId, "op-bank");
  });
});

describe("ambiguous proposal time interpretation", () => {
  it("injects the current local time and asks the model for one bounded HH:mm", async () => {
    let captured: StructuredRequest<unknown> | undefined;
    let calls = 0;
    const adapter: ModelAdapter = {
      provider: "test",
      async *stream() {},
      async generateObject<T>(request: StructuredRequest<T>) {
        calls += 1;
        captured = request as StructuredRequest<unknown>;
        return { localTime: "17:30", reasoningSummary: "原安排在 17:15，用户要求推迟，17:30 最符合语义。", assumptions: [], needsClarification: false } as T;
      },
    };
    const result = await interpretAmbiguousProposalTime(adapter, "test-model", {
      timezone: "Asia/Shanghai",
      currentLocalDateTime: "2026/07/21周二 13:45:00",
      instruction: "英语学习的开始时间推迟到 5 点半吧。",
      timeExpression: "5 点半",
      relation: "later",
      target: { operationId: "op-english", title: "英语学习", currentStartsAt: "2026-07-21T09:15:00.000Z", currentEndsAt: "2026-07-21T09:45:00.000Z", currentLocalRange: "17:15–17:45" },
      neighboringOperations: [{ operationId: "op-guitar", title: "吉他练习", startsAt: "2026-07-21T13:30:00.000Z", endsAt: "2026-07-21T14:30:00.000Z" }],
    }, undefined, () => {});
    assert.equal(calls, 1);
    assert.equal(result.localTime, "17:30");
    assert.match(captured?.prompt ?? "", /2026\/07\/21周二 13:45:00/);
    assert.match(captured?.system ?? "", /正常人类作息/);
    assert.equal(captured?.maxRetries, 0);
    assert.ok((captured?.maxOutputTokens ?? 0) <= 240);
  });
});
