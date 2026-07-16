import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentProcessSteps } from "@/components/agent-process-steps";
import {
  buildAgentProcessStages,
  buildAgentProcessSummary,
  buildAgentProcessTimeline,
  processStageStatus,
  type AgentProcessStep,
} from "./agent-process-presentation";

function toolStep(id: string, toolName: string, label: string, status: AgentProcessStep["status"] = "done"): AgentProcessStep {
  return {
    id,
    toolCallId: id,
    label,
    status,
    summary: `${label}结果`,
    detail: { toolName, inputSummary: `${label}参数`, rawInputJson: "{}" },
  };
}

const realisticSteps: AgentProcessStep[] = [
  { id: "planning-0", label: "理解目标", status: "done", summary: "已识别用户意图" },
  toolStep("call-goal", "read_goal_context", "参考目标与 Routine 设定"),
  toolStep("call-routine", "read_goal_context", "参考目标与 Routine 设定"),
  toolStep("call-schedule", "read_schedule_window", "检查今天的日程安排"),
  toolStep("call-proposal", "propose_change_set", "整理变更方案"),
  { id: "verification-5", label: "验证工具结果", status: "confirm", summary: "已生成可确认的变更草案" },
  { id: "decision-6", label: "判断目标状态", status: "confirm", summary: "目标已达成，等待确认" },
];

test("projects raw events into three user-facing stages without merging tool calls", () => {
  const stages = buildAgentProcessStages(realisticSteps);

  assert.deepEqual(stages.map((stage) => stage.id), ["understanding", "context", "result"]);
  assert.deepEqual(stages[1].steps.map((step) => step.toolCallId), ["call-goal", "call-routine", "call-schedule"]);
  assert.equal(stages[2].steps[0].toolCallId, "call-proposal");
  assert.deepEqual(stages[2].technicalSteps.map((step) => step.id), ["decision-6"]);
  assert.equal(stages[2].status, "confirm");
});

test("projects proposal retries as one current state while preserving the failed attempt in technical history", () => {
  const stages = buildAgentProcessStages([
    { id: "planning-0", label: "理解目标", status: "done" },
    toolStep("proposal-failed", "propose_change_set", "整理变更方案", "failed"),
    { id: "recovery-2", label: "工具失败恢复", status: "failed", summary: "需要先检查日程" },
    { id: "verification-3", label: "验证工具结果", status: "done", summary: "已交回模型" },
    toolStep("schedule-check", "read_schedule_window", "检查今日日程"),
    { id: "verification-5", label: "验证工具结果", status: "done", summary: "已交回模型" },
    toolStep("proposal-success", "propose_change_set", "整理变更方案"),
    { id: "verification-7", label: "验证工具结果", status: "confirm", summary: "草案已生成" },
    { id: "decision-8", label: "判断目标状态", status: "confirm", summary: "等待确认" },
  ]);
  const resultStage = stages.find((stage) => stage.id === "result");

  assert.ok(resultStage);
  assert.deepEqual(resultStage.steps.map((step) => step.id), ["proposal-success"]);
  assert.deepEqual(resultStage.technicalSteps.map((step) => step.id), ["proposal-failed", "decision-8"]);
  assert.equal(resultStage.status, "confirm");
  assert.equal(processStageStatus(resultStage.steps), "done");
  assert.equal(buildAgentProcessSummary([
    toolStep("proposal-failed", "propose_change_set", "整理变更方案", "failed"),
    toolStep("proposal-success", "propose_change_set", "整理变更方案"),
    { id: "decision-8", label: "判断目标状态", status: "confirm", summary: "等待确认" },
  ], false), "方案已整理好，等待你的确认");
});

test("compacts repeated loop verification into the latest semantic decision", () => {
  const stages = buildAgentProcessStages([
    toolStep("read-1", "read_goal_context", "读取目标"),
    { id: "verification-1", label: "验证工具结果", status: "done", summary: "第 1 轮" },
    toolStep("read-2", "read_schedule_window", "检查日程"),
    { id: "verification-2", label: "验证工具结果", status: "done", summary: "第 2 轮" },
    { id: "decision-3", label: "确认处理结束", status: "done", summary: "信息已足够" },
  ]);
  const resultStage = stages.find((stage) => stage.id === "result");

  assert.ok(resultStage);
  assert.deepEqual(resultStage.technicalSteps.map((step) => step.id), ["decision-3"]);
  assert.equal(resultStage.technicalSteps[0]?.label, "确认处理结束");
});

test("normalizes legacy no-tool verification into a non-contradictory terminal decision", () => {
  const stages = buildAgentProcessStages([
    toolStep("read-1", "read_goal_context", "读取目标"),
    { id: "verification-1", label: "验证工具结果", status: "done", summary: "已把工具结果交回模型" },
    { id: "verification-2", label: "验证工具结果", status: "done", summary: "没有新的工具调用", detail: { result: "本轮没有工具结果需要验证。" } },
  ]);
  const terminal = stages.find((stage) => stage.id === "result")?.technicalSteps[0];

  assert.equal(terminal?.label, "确认处理结束");
  assert.equal(terminal?.summary, "信息已足够，已输出最终回复");
  assert.equal(terminal?.detail?.result, "本轮无需继续调用工具。");
});

test("keeps repeated calls to the same tool distinct by toolCallId", () => {
  const stages = buildAgentProcessStages([
    toolStep("call-1", "read_goal_context", "读取目标"),
    toolStep("call-2", "read_goal_context", "读取目标"),
  ]);

  assert.equal(stages[0].id, "context");
  assert.equal(stages[0].steps.length, 2);
  assert.notEqual(stages[0].steps[0].toolCallId, stages[0].steps[1].toolCallId);
});

test("keeps expanded events in arrival order and hides internal per-loop verification", () => {
  const timeline = buildAgentProcessTimeline([
    { id: "planning-0", label: "理解目标", status: "done" },
    toolStep("read-1", "read_goal_context", "读取目标"),
    { id: "verification-2", label: "验证工具结果", status: "done" },
    toolStep("read-2", "read_schedule_window", "检查日程"),
    { id: "recovery-4", label: "工具失败恢复", status: "failed" },
    toolStep("read-3", "validate_schedule_candidates", "校验候选", "running"),
  ]);

  assert.deepEqual(timeline.map((step) => step.id), ["planning-0", "read-1", "read-2", "recovery-4", "read-3"]);
});

test("prioritizes active, failure, confirmation and terminal stage states", () => {
  assert.equal(processStageStatus([{ id: "a", label: "a", status: "done" }, { id: "b", label: "b", status: "running" }]), "running");
  assert.equal(processStageStatus([{ id: "a", label: "a", status: "confirm" }, { id: "b", label: "b", status: "failed" }]), "failed");
  assert.equal(processStageStatus([{ id: "a", label: "a", status: "done" }, { id: "b", label: "b", status: "confirm" }]), "confirm");
  assert.equal(processStageStatus([{ id: "a", label: "a", status: "done" }]), "done");
});

test("builds summaries from real calls and approval state", () => {
  assert.equal(buildAgentProcessSummary(realisticSteps, false), "方案已整理好，等待你的确认");
  const running = [toolStep("call-running", "read_schedule_window", "检查今日日程", "running")];
  assert.match(buildAgentProcessSummary(running, true), /^查阅相关信息 · /);
  assert.equal(buildAgentProcessSummary([
    toolStep("call-failed", "read_schedule_window", "检查今日日程", "failed"),
    { id: "decision", label: "判断目标状态", status: "confirm" },
  ], false), "部分动作未完成，可查看过程");
});

test("renders linear process without notifying the parent during render", () => {
  let parentNotifications = 0;
  const markup = renderToStaticMarkup(
    <AgentProcessSteps
      steps={realisticSteps}
      active
      onUserExpandChange={() => { parentNotifications += 1; }}
    />,
  );

  assert.equal(parentNotifications, 0);
  assert.match(markup, /理解目标/);
  assert.match(markup, /参考目标与 Routine 设定/);
  assert.match(markup, /整理变更方案/);
  assert.doesNotMatch(markup, /验证工具结果/);
  assert.doesNotMatch(markup, /agent-process-step done/);
});

test("renders a recovered proposal run as awaiting confirmation instead of failed", () => {
  const recovered = [
    toolStep("proposal-failed", "propose_change_set", "整理变更方案", "failed"),
    { id: "recovery-1", label: "工具失败恢复", status: "failed" as const },
    toolStep("schedule-check", "read_schedule_window", "检查今日日程"),
    toolStep("proposal-success", "propose_change_set", "整理变更方案"),
    { id: "decision-4", label: "判断目标状态", status: "confirm" as const, summary: "等待确认" },
  ];
  const markup = renderToStaticMarkup(<AgentProcessSteps steps={recovered} active={false} />);

  assert.match(markup, /等待确认/);
  assert.doesNotMatch(markup, /需要处理/);
});
