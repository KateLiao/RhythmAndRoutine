import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentPanel } from "@/components/agent-panel";

test("renders new conversation and clear context as peer header actions", () => {
  const markup = renderToStaticMarkup(
    <AgentPanel
      open
      onClose={() => undefined}
      goals={[]}
      schedule={[]}
      view="today"
      provider="qwen"
      model="qwen3.5-plus"
      selectedGoalId={null}
      onApply={async () => undefined}
      onReject={async () => undefined}
    />,
  );

  assert.match(markup, /class="agent-header-action new-conversation"/);
  assert.match(markup, /aria-label="新对话"/);
  assert.match(markup, /class="agent-header-action clear-context"/);
  assert.match(markup, /aria-label="清空上下文"/);
  assert.doesNotMatch(markup, /aria-label="更多操作"/);
});
