import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAgentScheduleWindow } from "@/lib/timezone";

describe("parseAgentScheduleWindow", () => {
  it("interprets timezone-less wall-clock input in the user timezone", () => {
    const result = parseAgentScheduleWindow("2026-07-16T18:00:00", "2026-07-16T19:00:00", "Asia/Shanghai");
    assert.equal(result.from.toISOString(), "2026-07-16T10:00:00.000Z");
    assert.equal(result.to.toISOString(), "2026-07-16T11:00:00.000Z");
  });

  it("preserves explicit offsets as absolute instants", () => {
    const result = parseAgentScheduleWindow("2026-07-16T18:00:00Z", "2026-07-16T19:00:00Z", "Asia/Shanghai");
    assert.equal(result.from.toISOString(), "2026-07-16T18:00:00.000Z");
  });
});
