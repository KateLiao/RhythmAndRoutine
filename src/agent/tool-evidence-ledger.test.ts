import assert from "node:assert/strict";
import test from "node:test";
import { compactToolResult, serializeCompactToolResult, ToolEvidenceLedger } from "./tool-evidence-ledger";

test("schedule evidence keeps local times, conflicts and availability while dropping bulky fields", () => {
  const result = compactToolResult("read_schedule_window", {
    ok: true,
    data: {
      timezone: "Asia/Shanghai",
      window: { from: "2026-07-16T11:30:00Z", to: "2026-07-16T15:00:00Z", localFrom: "2026-07-16T19:30", localTo: "2026-07-16T23:00" },
      itemCount: 1,
      items: [{ id: "schedule-1", title: "阅读《原则》", blockKind: "goal_task", localStartsAt: "2026-07-16T20:00", localEndsAt: "2026-07-16T21:00", unusedBlob: "x".repeat(10_000) }],
      busyIntervals: [{ localStartsAt: "2026-07-16T20:00", localEndsAt: "2026-07-16T21:00", titles: ["阅读《原则》"] }],
      availableIntervals: [{ localStartsAt: "2026-07-16T21:00", localEndsAt: "2026-07-16T23:00" }],
    },
  });
  const serialized = JSON.stringify(result);

  assert.match(serialized, /阅读《原则》/);
  assert.match(serialized, /2026-07-16T20:00/);
  assert.match(serialized, /2026-07-16T21:00/);
  assert.doesNotMatch(serialized, /unusedBlob/);
});

test("candidate validation evidence preserves the exact verified range and conflict conclusion", () => {
  const serialized = serializeCompactToolResult("validate_schedule_candidates", {
    ok: true,
    data: {
      timezone: "Asia/Shanghai",
      allAvailable: false,
      candidates: [{
        label: "阅读",
        startsAt: "2026-07-16T12:00:00.000Z",
        endsAt: "2026-07-16T13:00:00.000Z",
        localStartsAt: "2026-07-16T20:00",
        localEndsAt: "2026-07-16T21:00",
        available: false,
        conflicts: [{ id: "existing-1", title: "吉他练习", localStartsAt: "2026-07-16T20:30", localEndsAt: "2026-07-16T21:30" }],
      }],
    },
  });

  assert.match(serialized, /"allAvailable":false/);
  assert.match(serialized, /吉他练习/);
  assert.match(serialized, /2026-07-16T20:00/);
});

test("evidence ledger replaces repeated scoped reads and remains bounded", () => {
  const ledger = new ToolEvidenceLedger();
  ledger.record("read_schedule_window", { from: "a", to: "b" }, { ok: true, data: { itemCount: 1, items: [{ id: "old", title: "旧安排" }] } });
  ledger.record("read_schedule_window", { from: "a", to: "b" }, { ok: true, data: { itemCount: 1, items: [{ id: "new", title: "新安排" }] } });
  for (let index = 0; index < 12; index += 1) {
    ledger.record("read_goal_context", { goalId: `goal-${index}` }, { ok: true, data: { id: `goal-${index}`, title: `目标 ${index}`, description: "x".repeat(2_000) } });
  }
  const context = ledger.toSystemContext();

  assert.ok(context.length <= 8_001);
  assert.doesNotThrow(() => JSON.parse(context));
  assert.doesNotMatch(context, /旧安排/);
  assert.match(context, /目标 11/);
  assert.doesNotMatch(context, /目标 0/);
});
