import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  appendMessages,
  applyConversationSummary,
  clearContext,
  getContextMessages,
  getSession,
  hasUndoableClear,
  startNewSession,
  syncContextScope,
  undoClearContext,
  type StoredMessage,
} from "@/lib/conversation-store";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function message(id: string, role: StoredMessage["role"], text: string): StoredMessage {
  return { id, role, text, timestamp: `2026-07-16T00:00:0${id.slice(-1)}.000Z` };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
});

describe("conversation-store v2", () => {
  it("keeps messages visible while excluding content above a clear boundary", () => {
    appendMessages([
      message("m1", "user", "旧问题"),
      message("m2", "assistant", "旧回答"),
    ]);

    const result = clearContext();
    appendMessages([
      message("m3", "user", "新问题"),
      message("m4", "assistant", "新回答"),
    ]);

    assert.equal(result.boundaryMessageId, "m2");
    assert.deepEqual(getContextMessages(), [
      { role: "user", content: "新问题" },
      { role: "assistant", content: "新回答" },
    ]);
    assert.equal(getSession().messages.length, 5);
  });

  it("allows undo before the next send and restores the previous context", () => {
    appendMessages([message("m1", "user", "保留我")]);
    clearContext();

    assert.equal(hasUndoableClear(), true);
    assert.equal(undoClearContext(), true);
    assert.equal(hasUndoableClear(), false);
    assert.deepEqual(getContextMessages(), [{ role: "user", content: "保留我" }]);
  });

  it("clears only when goalId changes, not when only the view changes", () => {
    appendMessages([message("m1", "user", "围绕目标 A")]);
    syncContextScope({ view: "today", goalId: "goal-a" }, "目标 A");
    const revisionAfterInitialScope = getSession().revision;

    const viewChange = syncContextScope({ view: "calendar", goalId: "goal-a" }, "目标 A");
    assert.equal(viewChange.cleared, false);
    assert.equal(getSession().revision, revisionAfterInitialScope);

    const goalChange = syncContextScope({ view: "calendar", goalId: "goal-b" }, "目标 B");
    assert.equal(goalChange.cleared, true);
    assert.match(getSession().messages.at(-1)?.text ?? "", /目标 B/);
  });

  it("rejects stale summary writes after the revision changes", () => {
    const original = getSession();
    clearContext();

    assert.equal(applyConversationSummary({
      sessionId: original.id,
      revision: original.revision,
      summary: "过期摘要",
      summarizedThroughMessageId: "m1",
    }), false);
    assert.equal(getSession().summary, undefined);
  });

  it("replaces the active session and deletes the old local conversation", () => {
    appendMessages([message("m1", "user", "旧 Session")]);
    const oldSessionId = getSession().id;

    const next = startNewSession();

    assert.notEqual(next.id, oldSessionId);
    assert.deepEqual(next.messages, []);
    assert.deepEqual(getSession().messages, []);
  });
});
