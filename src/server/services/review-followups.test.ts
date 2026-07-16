import assert from "node:assert/strict";
import test from "node:test";
import { countTodayPendingSchedule, hasAwaitingReview, resolveReviewHeadline } from "@/components/product-shell";
import { Prisma } from "@/generated/prisma/client";
import { ReviewStatus, ScheduleBlockStatus, TaskStatus } from "@/generated/prisma/enums";
import type { ScheduleItem } from "@/lib/demo-data";
import type { ReviewRecord } from "@/lib/client-api";
import { updateTask } from "@/server/services/goals";
import { collectPeriodTaskIds, shouldGenerateDueReview } from "@/server/services/reviews";
import { resolveMostRecentDueReviewPeriods, selectCurrentReview, resolveManualReviewPeriod } from "@/server/services/review-schedule";
import { buildRepairUpdateGuard, deriveRepairTaskStatus } from "../../../scripts/repair-auto-completed-tasks";

const baseSchedule: Omit<ScheduleItem, "id" | "status" | "date"> = {
  title: "测试日程",
  goalId: "",
  start: "09:00",
  end: "10:00",
  kind: "personal",
  energy: "medium",
};

test("今天 badge 只统计用户时区当天的 planned/in_progress", () => {
  const schedule: ScheduleItem[] = [
    { ...baseSchedule, id: "planned", date: "2026-07-11", status: "planned" },
    { ...baseSchedule, id: "active", date: "2026-07-11", status: "in_progress" },
    { ...baseSchedule, id: "done", date: "2026-07-11", status: "completed" },
    { ...baseSchedule, id: "tomorrow", date: "2026-07-12", status: "planned" },
  ];
  assert.equal(countTodayPendingSchedule(schedule, "Asia/Shanghai", new Date("2026-07-11T12:00:00+08:00")), 2);
});

/**
 * 构造指定状态的最小回顾记录，供导航状态测试复用。
 * @param status - 回顾业务状态
 * @returns 可用于测试的回顾记录
 */
function reviewRecord(status: string): ReviewRecord {
  return {
    id: status,
    type: "daily",
    status,
    periodStart: "2026-07-11T00:00:00.000Z",
    periodEnd: "2026-07-12T00:00:00.000Z",
    summary: "",
    metrics: {},
    findings: [],
    suggestions: [],
  };
}

test("回顾提示只由 awaiting_confirmation 状态驱动", () => {
  assert.equal(hasAwaitingReview([reviewRecord("confirmed")]), false);
  assert.equal(hasAwaitingReview([reviewRecord("confirmed"), reviewRecord("awaiting_confirmation")]), true);
});

test("日回顾在 Asia/Shanghai 2026-07-14 23:00 前后切换最近到期周期", () => {
  const settings = {
    timezone: "Asia/Shanghai",
    dailyReviewTime: "23:00",
    weeklyReviewDay: 0,
    weeklyReviewTime: "23:00",
  };
  const before = resolveMostRecentDueReviewPeriods(settings, new Date("2026-07-14T22:59:00+08:00"));
  const atDueTime = resolveMostRecentDueReviewPeriods(settings, new Date("2026-07-14T23:00:00+08:00"));

  assert.equal(before.daily.periodStart.toISOString(), "2026-07-12T16:00:00.000Z");
  assert.equal(before.daily.periodEnd.toISOString(), "2026-07-13T16:00:00.000Z");
  assert.equal(atDueTime.daily.periodStart.toISOString(), "2026-07-13T16:00:00.000Z");
  assert.equal(atDueTime.daily.periodEnd.toISOString(), "2026-07-14T16:00:00.000Z");
});

test("Cron 延迟到设置时间之后仍定位当天到期日回顾", () => {
  const settings = {
    timezone: "Asia/Shanghai",
    dailyReviewTime: "23:00",
    weeklyReviewDay: 0,
    weeklyReviewTime: "23:00",
  };
  const delayed = resolveMostRecentDueReviewPeriods(settings, new Date("2026-07-14T23:37:00+08:00"));

  assert.equal(delayed.daily.periodStart.toISOString(), "2026-07-13T16:00:00.000Z");
  assert.equal(delayed.daily.periodEnd.toISOString(), "2026-07-14T16:00:00.000Z");
});

test("日回顾到期判定使用用户时区而非服务器时区", () => {
  const settings = {
    timezone: "America/Los_Angeles",
    dailyReviewTime: "23:00",
    weeklyReviewDay: 0,
    weeklyReviewTime: "23:00",
  };
  const before = resolveMostRecentDueReviewPeriods(settings, new Date("2026-07-15T05:59:00.000Z"));
  const atDueTime = resolveMostRecentDueReviewPeriods(settings, new Date("2026-07-15T06:00:00.000Z"));

  assert.equal(before.daily.periodStart.toISOString(), "2026-07-13T07:00:00.000Z");
  assert.equal(before.daily.periodEnd.toISOString(), "2026-07-14T07:00:00.000Z");
  assert.equal(atDueTime.daily.periodStart.toISOString(), "2026-07-14T07:00:00.000Z");
  assert.equal(atDueTime.daily.periodEnd.toISOString(), "2026-07-15T07:00:00.000Z");
});

test("周回顾在周日设置时间跨过后切换周期，并在周一保持最近到期周", () => {
  const settings = {
    timezone: "Asia/Shanghai",
    dailyReviewTime: "23:00",
    weeklyReviewDay: 0,
    weeklyReviewTime: "23:00",
  };
  const before = resolveMostRecentDueReviewPeriods(settings, new Date("2026-07-12T22:59:00+08:00"));
  const atDueTime = resolveMostRecentDueReviewPeriods(settings, new Date("2026-07-12T23:00:00+08:00"));
  const monday = resolveMostRecentDueReviewPeriods(settings, new Date("2026-07-13T00:01:00+08:00"));

  assert.equal(before.weekly.periodStart.toISOString(), "2026-06-28T16:00:00.000Z");
  assert.equal(before.weekly.periodEnd.toISOString(), "2026-07-05T16:00:00.000Z");
  assert.equal(atDueTime.weekly.periodStart.toISOString(), "2026-07-05T16:00:00.000Z");
  assert.equal(atDueTime.weekly.periodEnd.toISOString(), "2026-07-12T16:00:00.000Z");
  assert.deepEqual(monday.weekly, atDueTime.weekly);
});

test("到期同步只为缺失或 FAILED 的周期触发生成", () => {
  assert.equal(shouldGenerateDueReview(undefined), true);
  assert.equal(shouldGenerateDueReview(ReviewStatus.FAILED), true);
  assert.equal(shouldGenerateDueReview(ReviewStatus.GENERATING), false);
  assert.equal(shouldGenerateDueReview(ReviewStatus.AWAITING_CONFIRMATION), false);
  assert.equal(shouldGenerateDueReview(ReviewStatus.CONFIRMED), false);
});

test("手动生成在 23:00 前指向昨日到期周期，重新生成则保留当前展示周期", () => {
  const settings = {
    timezone: "Asia/Shanghai",
    dailyReviewTime: "23:00",
    weeklyReviewDay: 0,
    weeklyReviewTime: "23:00",
  };
  const now = new Date("2026-07-16T10:19:00+08:00");
  const due = resolveManualReviewPeriod("daily", settings, null, now);
  assert.equal(due.periodStart.toISOString(), "2026-07-14T16:00:00.000Z");
  assert.equal(due.periodEnd.toISOString(), "2026-07-15T16:00:00.000Z");

  const rewrite = resolveManualReviewPeriod("daily", settings, {
    periodStart: "2026-07-14T16:00:00.000Z",
    periodEnd: "2026-07-15T16:00:00.000Z",
  }, now);
  assert.equal(rewrite.periodStart.toISOString(), "2026-07-14T16:00:00.000Z");
});

test("回顾页优先展示最近到期周期，忽略尚未到期的今天抢先生成", () => {
  const settings = {
    timezone: "Asia/Shanghai",
    dailyReviewTime: "23:00",
    weeklyReviewDay: 0,
    weeklyReviewTime: "23:00",
  };
  const current = selectCurrentReview([
    {
      id: "july-16",
      type: "daily",
      status: "awaiting_confirmation",
      periodStart: "2026-07-15T16:00:00.000Z",
      periodEnd: "2026-07-16T16:00:00.000Z",
      summary: "今天",
      metrics: {},
      findings: [],
      suggestions: [],
    },
    {
      id: "july-15",
      type: "daily",
      status: "awaiting_confirmation",
      periodStart: "2026-07-14T16:00:00.000Z",
      periodEnd: "2026-07-15T16:00:00.000Z",
      summary: "昨日",
      metrics: {},
      findings: [],
      suggestions: [],
    },
  ], "daily", settings, new Date("2026-07-16T10:19:00+08:00"));

  assert.equal(current?.id, "july-15");
});

test("日回顾与周回顾标题使用各自摘要和专属空态", () => {
  assert.equal(resolveReviewHeadline("daily", "今天完成了重点任务。"), "今天完成了重点任务。");
  assert.equal(resolveReviewHeadline("weekly", "本周 Routine 更稳定。"), "本周 Routine 更稳定。");
  assert.match(resolveReviewHeadline("daily", null), /今天的收尾评估/);
  assert.match(resolveReviewHeadline("weekly", null), /本周的节奏与目标校准/);
});

test("周回顾任务汇总合并主关联与多任务关联并去重", () => {
  assert.deepEqual(collectPeriodTaskIds([
    { taskId: "task-a", linkedTasks: [{ taskId: "task-a" }, { taskId: "task-b" }] },
    { taskId: null, linkedTasks: [{ taskId: "task-c" }] },
  ]), ["task-a", "task-b", "task-c"]);
});

test("PATCH 更新任务拒绝直接写 completed", async () => {
  await assert.rejects(
    updateTask("user", "task", { status: "completed", expectedVersion: 1 }),
    /任务完成必须通过/,
  );
});

test("误完成修复状态与正式任务聚合保持同一非终态规则", () => {
  assert.equal(deriveRepairTaskStatus([]), TaskStatus.READY);
  assert.equal(deriveRepairTaskStatus([ScheduleBlockStatus.IN_PROGRESS, ScheduleBlockStatus.COMPLETED]), TaskStatus.IN_PROGRESS);
  assert.equal(deriveRepairTaskStatus([ScheduleBlockStatus.PLANNED]), TaskStatus.SCHEDULED);
  assert.equal(deriveRepairTaskStatus([ScheduleBlockStatus.COMPLETED]), TaskStatus.SCHEDULED);
  assert.equal(deriveRepairTaskStatus([ScheduleBlockStatus.MISSED, ScheduleBlockStatus.CANCELLED]), TaskStatus.BLOCKED);
});

test("修复条件更新同时保护完成记录、归档状态和乐观锁版本", () => {
  const guard = buildRepairUpdateGuard("task-1", 7);
  assert.deepEqual(guard, {
    id: "task-1",
    version: 7,
    archivedAt: null,
    status: TaskStatus.COMPLETED,
    completionRecord: { equals: Prisma.DbNull },
  });
});
