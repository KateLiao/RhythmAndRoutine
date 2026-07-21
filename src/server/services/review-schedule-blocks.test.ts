import assert from "node:assert/strict";
import test from "node:test";
import { excludeSupersededPeriodBlocks } from "@/server/services/reviews";

test("回顾只保留单次改期后的最终日程块", () => {
  const blocks = [{ id: "original" }, { id: "final" }, { id: "unrelated" }];

  assert.deepEqual(
    excludeSupersededPeriodBlocks(blocks, [{ rescheduledFromId: "original" }]),
    [{ id: "final" }, { id: "unrelated" }],
  );
});

test("回顾从连续改期链中只保留叶子节点", () => {
  const blocks = [{ id: "original" }, { id: "moved-once" }, { id: "moved-twice" }];

  assert.deepEqual(
    excludeSupersededPeriodBlocks(blocks, [
      { rescheduledFromId: "original" },
      { rescheduledFromId: "moved-once" },
    ]),
    [{ id: "moved-twice" }],
  );
});

test("最终块移出周期后，原周期不再计算被替代的旧块", () => {
  const periodBlocks = [{ id: "original-in-period" }];

  assert.deepEqual(
    excludeSupersededPeriodBlocks(periodBlocks, [{ rescheduledFromId: "original-in-period" }]),
    [],
  );
});

test("普通日程和没有后继引用的既有块保持不变", () => {
  const blocks = [{ id: "ordinary" }, { id: "rescheduled-without-successor" }];

  assert.deepEqual(
    excludeSupersededPeriodBlocks(blocks, [{ rescheduledFromId: null }]),
    blocks,
  );
});
