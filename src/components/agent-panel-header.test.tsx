import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentPanel } from "@/components/agent-panel";
import type { Goal } from "@/lib/demo-data";

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
      dataMode="database"
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

test("clearly degrades Agent continuation while browser-local manual scheduling remains available", () => {
  const markup = renderToStaticMarkup(
    <AgentPanel
      open
      onClose={() => undefined}
      goals={[]}
      schedule={[]}
      view="today"
      provider="qwen"
      model="qwen3.5-plus"
      dataMode="local"
      selectedGoalId={null}
      onApply={async () => undefined}
      onReject={async () => undefined}
    />,
  );

  assert.match(markup, /本地模式下请使用手动日程功能/);
  assert.match(markup, /本地模式保留手动日程能力；服务端提案续接暂不可用/);
  assert.match(markup, /disabled=""/);
});

test("does not expose a stale selected goal outside the goal detail page", () => {
  const goal: Goal = { id: "goal-1", title: "不应关联的目标", status: "active", description: "", color: "violet", weeklyMinutes: 0, completedMinutes: 0, tasksDone: 0, tasksTotal: 0, tasks: [], routines: [], outcomes: [], milestones: [] };
  const markup = renderToStaticMarkup(
    <AgentPanel
      open
      onClose={() => undefined}
      goals={[goal]}
      schedule={[]}
      view="today"
      provider="qwen"
      model="qwen3.5-plus"
      dataMode="database"
      selectedGoalId="goal-1"
      onApply={async () => undefined}
      onReject={async () => undefined}
    />,
  );

  assert.match(markup, /未关联目标/);
  assert.doesNotMatch(markup, /不应关联的目标/);
});

test("shows the current goal only on its goal detail page", () => {
  const goal: Goal = { id: "goal-1", title: "当前目标", status: "active", description: "", color: "violet", weeklyMinutes: 0, completedMinutes: 0, tasksDone: 0, tasksTotal: 0, tasks: [], routines: [], outcomes: [], milestones: [] };
  const markup = renderToStaticMarkup(
    <AgentPanel
      open
      onClose={() => undefined}
      goals={[goal]}
      schedule={[]}
      view="goal-detail"
      provider="qwen"
      model="qwen3.5-plus"
      dataMode="database"
      selectedGoalId="goal-1"
      onApply={async () => undefined}
      onReject={async () => undefined}
    />,
  );

  assert.match(markup, /当前目标/);
  assert.doesNotMatch(markup, /未关联目标/);
});
