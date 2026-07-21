import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FeedbackModal } from "@/components/product-shell";
import type { ScheduleItem } from "@/lib/demo-data";

const baseItem: ScheduleItem = {
  id: "schedule-1",
  title: "写产品方案",
  goalId: "goal-1",
  start: "09:00",
  end: "10:00",
  kind: "task",
  status: "planned",
  energy: "medium",
  date: "2026-07-21",
};

test("renders the lightweight v2 feedback path without deprecated daily fields", () => {
  const markup = renderToStaticMarkup(<FeedbackModal item={baseItem} onClose={() => undefined} onSave={() => undefined} />);

  assert.match(markup, /执行结果/);
  assert.match(markup, /达成预期/);
  assert.match(markup, /有效推进/);
  assert.match(markup, /未能推进/);
  assert.match(markup, /深度投入/);
  assert.match(markup, /挑战偏低/);
  assert.match(markup, /完成质量/);
  assert.match(markup, /补充感受/);
  assert.match(markup, /需要改期/);
  assert.doesNotMatch(markup, /遇到的阻碍/);
  assert.doesNotMatch(markup, /这个强度对我来说舒适/);
  assert.doesNotMatch(markup, />下一步</);
});

test("keeps legacy fields available in a collapsed compatibility section", () => {
  const legacyItem: ScheduleItem = {
    ...baseItem,
    status: "completed",
    execution: {
      result: "completed",
      feedbackVersion: 1,
      actualMinutes: 52,
      quality: "great",
      obstacle: "入口不够清楚",
      nextAction: "先整理接口清单",
      comfortable: false,
      timeFit: "poor",
      tags: ["interrupted"],
      note: "后来重新进入了状态",
    },
  };
  const markup = renderToStaticMarkup(<FeedbackModal item={legacyItem} onClose={() => undefined} onSave={() => undefined} />);

  assert.match(markup, /历史反馈（兼容保留）/);
  assert.match(markup, /入口不够清楚/);
  assert.match(markup, /先整理接口清单/);
  assert.match(markup, /原节奏标签/);
  assert.match(markup, /被打断/);
});
