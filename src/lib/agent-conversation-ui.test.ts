import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  newConversationNotice,
  shouldCollapseAgentProcess,
} from "@/lib/agent-conversation-ui";

describe("Agent conversation presentation", () => {
  it("collapses as soon as the final answer starts", () => {
    assert.equal(shouldCollapseAgentProcess(false, false), false);
    assert.equal(shouldCollapseAgentProcess(true, false), true);
  });

  it("keeps the process open after a user manually expands it", () => {
    assert.equal(shouldCollapseAgentProcess(true, true), false);
  });

  it("combines Run and ChangeSet cleanup into one visible notice", () => {
    assert.equal(newConversationNotice(true, true), "已停止当前处理，并放弃待确认的变更草案");
    assert.equal(newConversationNotice(true, false), "已停止当前处理");
    assert.equal(newConversationNotice(false, true), "已放弃待确认的变更草案");
    assert.equal(newConversationNotice(false, false), "已开始新对话");
  });
});
