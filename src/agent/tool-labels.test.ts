import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildToolStepDetail,
  formatToolInputPreview,
  sanitizeToolInput,
  summarizeToolInput,
  summarizeToolResult,
  toolDisplayLabel,
} from "@/agent/tool-labels";

describe("tool input disclosure", () => {
  it("redacts sensitive keys recursively", () => {
    assert.deepEqual(sanitizeToolInput({
      token: "top-secret",
      nested: { authorization: "Bearer secret", title: "保留标题" },
    }), {
      token: "•••",
      nested: { authorization: "•••", title: "保留标题" },
    });
  });

  it("truncates long strings and arrays before rendering raw JSON", () => {
    const preview = formatToolInputPreview({
      text: "x".repeat(600),
      values: Array.from({ length: 25 }, (_, index) => index),
    });

    assert.match(preview, /…/);
    assert.match(preview, /另有 5 项/);
    assert.doesNotMatch(preview, /x{501}/);
  });

  it("provides a readable summary without exposing the internal tool name", () => {
    assert.equal(
      summarizeToolInput("read_schedule_window", { from: "2026-07-16T00:00:00Z", to: "2026-07-18T00:00:00Z" }),
      "时间范围 2026-07-16 → 2026-07-18",
    );
    assert.equal(toolDisplayLabel("read_schedule_window"), "检查今天的日程安排");
  });

  it("presents similar schedule history as a habit reference, not a guaranteed free slot", () => {
    const result = { ok: true as const, data: { sampleCount: 4, typicalStartTime: "19:30", typicalDurationMinutes: 45 } };
    assert.equal(toolDisplayLabel("read_similar_schedule_history"), "参考往常的安排时间");
    assert.equal(summarizeToolInput("read_similar_schedule_history", { query: "吉他练习", days: 60 }), "过去 60 天 · 吉他练习");
    assert.match(summarizeToolResult("read_similar_schedule_history", result), /通常约 19:30 开始/);
    assert.match(buildToolStepDetail("read_similar_schedule_history", result, { query: "吉他练习" }).judgment ?? "", /仍需单独检查日程冲突/);
  });
});
