"use client";

import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Clock,
  Flag,
  Infinity,
  Leaf,
  Lightbulb,
  ListChecks,
  Loader2,
  Menu,
  Pencil,
  Plus,
  RefreshCcw,
  RotateCcw,
  Settings,
  Sparkles,
  Target,
  Trash2,
  X,
} from "lucide-react";
import { FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Goal, buildLocalTaskCompletionRecord, initialGoals, initialSchedule, resolveScheduleTaskIds, scheduleBelongsToGoal, scheduleInvestedMinutes, scheduleLinksTask, taskInvestedMinutes, ScheduleItem } from "@/lib/demo-data";
import { zonedDateTimeToUtc } from "@/lib/timezone";
import { changeSetApi, homeInsightsApi, loadModelProviders, loadWorkspace, mapServerBlockToScheduleItem, reviewApi, settingsApi, workspaceApi, type AgentChangeSet, type ApiHomeInsights, type HomeInsightProposedChange, type ModelProviderInfo, type ReviewContent, type ReviewRecord, type RhythmSignalRecord, type UserSettings } from "@/lib/client-api";
import { resolveManualReviewPeriod, selectCurrentReview } from "@/lib/review-schedule";
import { AgentPanel } from "@/components/agent-panel";
import { computeHomeInsights, isSignalPreferred, preferSignalForScheduling, type MomentAction } from "@/lib/home-insights";
import { CalendarHeader } from "@/components/calendar/calendar-header";
import { CalendarToolbar } from "@/components/calendar/calendar-toolbar";
import { DayTimeline } from "@/components/calendar/day-timeline";
import { WeekTimeline } from "@/components/calendar/week-timeline";
import { MonthCalendarView } from "@/components/calendar/month-calendar-view";
import { ScheduleDetailDrawer } from "@/components/calendar/schedule-detail-drawer";
import type { CalendarMode } from "@/lib/calendar/navigation";
import { isActiveCalendarBlock } from "@/lib/calendar/active-block";
import { formatToolbarTitle, shiftAnchorDate, weekDateKeys, weekStartFromDate } from "@/lib/calendar/navigation";

type View = "today" | "goals" | "goal-detail" | "task-detail" | "routines" | "review" | "settings";
type Modal = "goal" | "goal-detail" | "task-create" | "task-edit" | "routine" | "schedule-choice" | "schedule" | "personal-schedule" | "schedule-edit" | "feedback" | null;

const viewMeta: Record<View, { label: string; kicker: string; title: string }> = {
  today: { label: "今天", kicker: "", title: "今天的节奏" },
  goals: { label: "目标", kicker: "你正在靠近的方向", title: "目标与行动" },
  "goal-detail": { label: "目标详情", kicker: "方向、行动与真实投入", title: "目标详情" },
  "task-detail": { label: "任务详情", kicker: "把下一步看清楚", title: "任务详情" },
  routines: { label: "Routine", kicker: "长期节奏，不是重复待办", title: "我的 Routine" },
  review: { label: "回顾", kicker: "周期复盘", title: "回顾" },
  settings: { label: "设置", kicker: "模型、时间与使用边界", title: "偏好设置" },
};

function minutesToText(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} 分钟`;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

/**
 * 按指定时区计算日期键，供导航待办与页面日期使用同一口径。
 * @param date - 需要转换的时间
 * @param timezone - IANA 时区名称
 * @returns YYYY-MM-DD 格式的用户本地日期键
 */
export function zonedNavigationDateKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone,
  }).format(date);
}

/**
 * 统计用户时区今天仍需处理的日程块，包含计划中与进行中的块。
 * @param schedule - 当前已加载的日程块
 * @param timezone - 用户 IANA 时区
 * @param now - 当前时间，测试时可注入固定时间
 * @returns 今天待处理日程块数量
 */
export function countTodayPendingSchedule(schedule: ScheduleItem[], timezone: string, now = new Date()): number {
  const todayKey = zonedNavigationDateKey(now, timezone);
  return schedule.filter((item) => {
    const dateKey = item.date ?? todayKey;
    return dateKey === todayKey && (item.status === "planned" || item.status === "in_progress");
  }).length;
}

/**
 * 判断是否存在尚待用户确认的回顾。
 * @param reviews - 当前已加载的回顾列表
 * @returns 至少一份回顾待确认时返回 true
 */
export function hasAwaitingReview(reviews: ReviewRecord[]): boolean {
  return reviews.some((review) => review.status === "awaiting_confirmation");
}

/**
 * 解析指定周期回顾的主标题，优先展示报告摘要，否则返回周期专属空态文案。
 * @param type - 回顾周期类型
 * @param summary - 当前回顾摘要
 * @returns 日回顾或周回顾对应的主标题
 */
export function resolveReviewHeadline(type: "daily" | "weekly", summary?: string | null): string {
  if (summary) return secondPersonReviewText(summary);
  return type === "weekly"
    ? "本周的节奏与目标校准还没有生成，先手动生成一份看看。"
    : "今天的收尾评估还没有生成，先手动生成一份看看。";
}

export function ProductShell() {
  const [view, setView] = useState<View>("today");
  const [goals, setGoals] = useState(initialGoals);
  const [schedule, setSchedule] = useState(initialSchedule);
  const [modal, setModal] = useState<Modal>(null);
  const [selectedBlock, setSelectedBlock] = useState<string | null>(null);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedRoutineId, setSelectedRoutineId] = useState<string | null>(null);
  const [taskEditId, setTaskEditId] = useState<string | null>(null);
  const [scheduleSeed, setScheduleSeed] = useState<ScheduleTimeSeed | null>(null);
  const [dataMode, setDataMode] = useState<"checking" | "database" | "local">("checking");
  const [notice, setNotice] = useState<string | null>(null);
  const [providers, setProviders] = useState<ModelProviderInfo[]>([]);
  const [selectedProvider, setSelectedProvider] = useState("qwen");
  const [selectedModel, setSelectedModel] = useState("");
  const [reviews, setReviews] = useState<ReviewRecord[]>([]);
  const [rhythmSignals, setRhythmSignals] = useState<RhythmSignalRecord[]>([]);
  const [userSettings, setUserSettings] = useState<UserSettings>({ timezone: "Asia/Shanghai", dailyReviewTime: "23:00", weeklyReviewDay: 0, weeklyReviewTime: "23:00", defaultModel: "qwen-plus" });
  const [agentOpen, setAgentOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [taskDetailEditing, setTaskDetailEditing] = useState(false);
  const [alternateMomentIndex, setAlternateMomentIndex] = useState(0);
  const [insightTick, setInsightTick] = useState(0);
  const [serverInsights, setServerInsights] = useState<ApiHomeInsights | null>(null);

  useEffect(() => {
    const savedGoals = localStorage.getItem("rr.goals");
    const savedSchedule = localStorage.getItem("rr.schedule");
    const restore = window.setTimeout(() => {
      if (savedGoals) setGoals(migrateLocalGoals(JSON.parse(savedGoals)));
      if (savedSchedule) setSchedule(JSON.parse(savedSchedule));
      const savedReviews = localStorage.getItem("rr.reviews");
      if (savedReviews) setReviews(JSON.parse(savedReviews));
      const savedSettings = localStorage.getItem("rr.settings");
      if (savedSettings) setUserSettings(JSON.parse(savedSettings));
    }, 0);
    loadWorkspace().then((workspace) => {
      setGoals(workspace.goals);
      setSchedule(workspace.schedule);
      setRhythmSignals(workspace.rhythmSignals);
      setDataMode("database");
      void refreshHomeInsights();
    }).catch(() => setDataMode("local"));
    reviewApi.list().then(setReviews).catch(() => undefined);
    settingsApi.get().then(setUserSettings).catch(() => undefined);
    loadModelProviders().then((result) => {
      setProviders(result.data);
      const stored = localStorage.getItem("rr.provider") || result.defaultProvider;
      const provider = result.data.find((item) => item.id === stored) ?? result.data[0];
      if (provider) { setSelectedProvider(provider.id); setSelectedModel(localStorage.getItem("rr.model") || provider.model); }
    }).catch(() => undefined);
    return () => window.clearTimeout(restore);
  }, []);

  useEffect(() => localStorage.setItem("rr.goals", JSON.stringify(goals)), [goals]);
  useEffect(() => localStorage.setItem("rr.schedule", JSON.stringify(schedule)), [schedule]);
  useEffect(() => localStorage.setItem("rr.reviews", JSON.stringify(reviews)), [reviews]);
  useEffect(() => localStorage.setItem("rr.settings", JSON.stringify(userSettings)), [userSettings]);

  /**
   * 顶部提示在展示 3 秒后自动消失；用户也可点击提前关闭。
   */
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const selectedItem = schedule.find((item) => item.id === selectedBlock);
  const selectedGoal = goals.find((goal) => goal.id === selectedGoalId);
  const selectedTask = selectedGoal?.tasks?.find((task) => task.id === selectedTaskId);
  const modalTask = selectedGoal?.tasks?.find((task) => task.id === (taskEditId ?? selectedTaskId));
  const todayPendingCount = countTodayPendingSchedule(schedule, userSettings.timezone);
  const reviewNeedsAttention = hasAwaitingReview(reviews);

  function openFeedback(id: string) {
    setSelectedBlock(id);
    setModal("feedback");
  }

  /**
   * 将个人日程轻量标记为已完成，不打开完整反馈弹窗。
   * @param id - 日程块 ID
   */
  async function completePersonalSchedule(id: string) {
    const item = schedule.find((entry) => entry.id === id);
    if (!item || item.kind !== "personal" || item.status === "completed") return;
    const actualMinutes = durationMinutes(item.start, item.end);
    if (dataMode === "database") {
      await workspaceApi.recordExecution(item.id, { result: "completed", tags: ["smooth"], actualMinutes });
      await refreshDatabase();
    } else {
      setSchedule((items) => items.map((entry) => entry.id === id ? { ...entry, status: "completed" } : entry));
    }
    setNotice(`「${item.title}」已标记完成`);
  }

  async function refreshDatabase() {
    const workspace = await loadWorkspace(userSettings.timezone);
    setGoals(workspace.goals);
    setSchedule(workspace.schedule);
    setRhythmSignals(workspace.rhythmSignals);
    await refreshHomeInsights();
  }

  /**
   * 从服务端读取落库的首页洞察快照（仅数据库模式）。
   */
  async function refreshHomeInsights() {
    try {
      const data = await homeInsightsApi.get();
      setServerInsights(data);
    } catch {
      setServerInsights(null);
    }
  }

  /**
   * 将 API proposedChange 转为客户端可执行的 MomentAction。
   * @param change - 服务端结构化日程变更
   */
  function proposedChangeToAction(change: HomeInsightProposedChange): MomentAction {
    if (change.type === "reschedule") {
      return { type: "reschedule", scheduleId: change.scheduleId, start: change.start, end: change.end, date: change.date, label: change.label };
    }
    if (change.type === "create_schedule") {
      return { type: "create_schedule", title: change.title, start: change.start, end: change.end, date: change.date, goalId: change.goalId, taskId: change.taskId, label: change.label };
    }
    if (change.type === "open_execution_feedback") {
      return { type: "open_execution_feedback", scheduleId: change.scheduleId, label: change.label };
    }
    return { type: "open_schedule_form", goalId: change.goalId, taskId: change.taskId, date: change.date, start: change.start, end: change.end, label: change.label };
  }

  async function saveGoal(goal: Goal) {
    if (dataMode === "database") {
      const created = await workspaceApi.createGoal({ title: goal.title, description: goal.description, category: goal.category, project: goal.project ?? undefined, skill: goal.skill ?? undefined, targetDate: goal.targetDate ?? undefined });
      setSelectedGoalId(created.id);
      await refreshDatabase();
    } else { setGoals((items) => [goal, ...items]); setSelectedGoalId(goal.id); }
    setModal(null);
    setView("goal-detail");
    setAgentOpen(true);
    setNotice("目标已保存，小律已准备好帮你澄清");
  }

  async function updateScheduleTime(item: ScheduleItem, start: string, end: string, date?: string) {
    const nextDate = date ?? item.date ?? currentDateKey();
    if (start === item.start && end === item.end && nextDate === (item.date ?? currentDateKey())) return;
    const previous = item;
    setSchedule((items) => items.map((entry) => entry.id === item.id ? { ...entry, start, end, date: nextDate, changeReason: "拖动调整时间" } : entry).sort((a, b) => a.start.localeCompare(b.start)));
    try {
      if (dataMode === "database" && item.source === "routine_occurrence" && item.routineId && item.occurrenceDate) {
        await workspaceApi.recordRoutineExecution({ routineId: item.routineId, occurrenceDate: item.occurrenceDate, plannedStartAt: zonedDateTimeToIso(item.date ?? currentDateKey(), item.start, userSettings.timezone), plannedEndAt: zonedDateTimeToIso(item.date ?? currentDateKey(), item.end, userSettings.timezone), status: "rescheduled", rescheduledStartAt: zonedDateTimeToIso(nextDate, start, userSettings.timezone), rescheduledEndAt: zonedDateTimeToIso(nextDate, end, userSettings.timezone), feedbackTags: [] });
      } else if (dataMode === "database" && item.version) {
        const updated = await workspaceApi.updateSchedule(item.id, {
          startsAt: zonedDateTimeToIso(nextDate, start, userSettings.timezone),
          endsAt: zonedDateTimeToIso(nextDate, end, userSettings.timezone),
          changeReason: "拖动调整时间",
          moveInPlace: false,
          expectedVersion: item.version,
        });
        const mapped = mapServerBlockToScheduleItem(updated, userSettings.timezone);
        setSchedule((items) => [...items.filter((entry) => entry.id !== item.id), mapped].sort((a, b) => `${a.date ?? currentDateKey()}T${a.start}`.localeCompare(`${b.date ?? currentDateKey()}T${b.start}`)));
      }
      if (dataMode === "database") await refreshDatabase();
    } catch {
      setSchedule((items) => items.map((entry) => entry.id === previous.id ? previous : entry));
      setNotice("日程时间保存失败，请刷新后重试");
    }
  }

  /**
   * 执行「此刻建议」的轻量日程调整（改期或新增）。
   * @param action - 规则引擎或 API 输出的可执行动作
   */
  async function applyMomentAction(action: MomentAction) {
    if (action.type === "reschedule") {
      const item = schedule.find((entry) => entry.id === action.scheduleId);
      if (!item) return;
      await updateScheduleTime(item, action.start, action.end);
      setNotice(`已将「${item.title}」调整到 ${action.start}–${action.end}`);
      setAlternateMomentIndex(0);
      if (dataMode === "database") await homeInsightsApi.respondMoment("accepted", true).then(setServerInsights).catch(() => undefined);
      return;
    }
    if (action.type === "create_schedule") {
      const taskIds = action.taskId ? [action.taskId] : undefined;
      const draft: ScheduleItem = {
        id: crypto.randomUUID(),
        title: action.title,
        goalId: action.goalId ?? "",
        taskId: action.taskId,
        taskIds,
        start: action.start,
        end: action.end,
        date: action.date,
        kind: action.goalId ? "task" : "personal",
        status: "planned",
        energy: "medium",
      };
      await saveSchedule(draft);
      setNotice(`已添加「${action.title}」`);
      setAlternateMomentIndex(0);
      if (dataMode === "database") await homeInsightsApi.respondMoment("accepted", true).then(setServerInsights).catch(() => undefined);
      return;
    }
    if (action.type === "open_execution_feedback") {
      const item = schedule.find((entry) => entry.id === action.scheduleId);
      if (!item) return;
      openFeedback(action.scheduleId);
      setNotice(item ? `打开「${item.title}」的执行记录` : "打开执行记录");
      setAlternateMomentIndex(0);
      if (dataMode === "database") await homeInsightsApi.respondMoment("accepted", false).then(setServerInsights).catch(() => undefined);
      return;
    }
    openScheduleModal({ goalId: action.goalId, taskId: action.taskId, date: action.date, start: action.start, end: action.end });
  }

  /**
   * 应用服务端返回的 proposedChange 并刷新洞察快照。
   * @param change - API 结构化变更
   */
  async function applyServerMomentChange(change: HomeInsightProposedChange) {
    await applyMomentAction(proposedChangeToAction(change));
    if (dataMode === "database") await refreshHomeInsights();
  }

  /**
   * 手动触发服务端洞察重生成；成功更新快照，失败抛出错误供卡片展示。
   * @param target - moment 或 slow
   * @param signal - 可选 AbortSignal，用于客户端超时取消
   */
  async function regenerateInsightTarget(target: "moment" | "slow", signal?: AbortSignal) {
    if (dataMode !== "database") return;
    const startedAt = Date.now();
    try {
      const data = await homeInsightsApi.regenerate(target, { signal });
      console.info("[home-insights] client regenerate ok", {
        target,
        ms: Date.now() - startedAt,
        regeneratedMoment: data.meta.regeneratedMoment,
        regeneratedSlow: data.meta.regeneratedSlow,
      });
      setServerInsights(data);
      setAlternateMomentIndex(0);
      const wrote = target === "moment" ? data.meta.regeneratedMoment : data.meta.regeneratedSlow;
      if (!wrote) {
        console.warn("[home-insights] regenerate returned without new snapshot", {
          target,
          momentSource: data.moment.source,
          rhythmSource: data.rhythm.source,
        });
        setNotice(target === "moment"
          ? "此刻建议未写入新快照（可能 AI 失败后保留了旧版），请查看控制台日志"
          : "节奏卡片未写入新快照（可能 AI 失败后保留了旧版），请查看控制台日志");
        return;
      }
      setNotice(target === "moment" ? "此刻建议已更新" : "节奏发现与本周轨道已更新");
    } catch (caught) {
      const aborted =
        signal?.aborted
        || (caught instanceof DOMException && caught.name === "AbortError")
        || (caught instanceof Error && caught.name === "AbortError");
      const message = aborted
        ? "生成超时，请重试"
        : caught instanceof Error && caught.message
          ? caught.message
          : "洞察更新失败，请稍后再试";
      console.error("[home-insights] client regenerate failed", {
        target,
        ms: Date.now() - startedAt,
        aborted,
        message,
        error: caught,
      });
      setNotice(message);
      throw new Error(message);
    }
  }

  /**
   * 轮换服务端此刻建议候选并更新快照。
   */
  async function alternateServerMoment() {
    if (dataMode !== "database") {
      setAlternateMomentIndex((value) => value + 1);
      return;
    }
    try {
      const data = await homeInsightsApi.alternateMoment();
      setServerInsights(data);
      if (data.moment.exhausted) {
        setNotice("本轮建议已全部浏览");
      }
    } catch {
      setAlternateMomentIndex((value) => value + 1);
      setNotice("暂时无法切换建议，请稍后再试");
    }
  }

  /**
   * 打开新建日程流程；今日安排页可让用户先选择个人日程或目标日程。
   * @param seed - 预填的日期、时间或关联实体
   * @param options.promptType - 为 true 且无预填关联实体时，先展示类型选择
   */
  function openScheduleModal(seed?: ScheduleTimeSeed, options?: { promptType?: boolean }) {
    setScheduleSeed(seed ?? null);
    const hasLinkedEntity = Boolean(seed?.goalId || seed?.taskId || seed?.routineId);
    if (options?.promptType && !hasLinkedEntity) {
      setModal("schedule-choice");
      return;
    }
    setModal("schedule");
  }

  function openTaskCreateModal() {
    setTaskEditId(null);
    setModal("task-create");
  }

  function openTaskEditModal(taskId: string) {
    setTaskEditId(taskId);
    setModal("task-edit");
  }

  function closeTaskModal() {
    setModal(null);
    setTaskEditId(null);
  }

  /**
   * 在目标下创建新任务并刷新工作区数据。
   * @param goalId - 所属目标 ID
   * @param patch - 任务字段
   */
  async function createTaskForGoal(goalId: string, patch: TaskFormPatch) {
    if (dataMode === "database") {
      await workspaceApi.createTask(goalId, {
        title: patch.title,
        intent: patch.intent || undefined,
        completionCriteria: patch.completionCriteria,
        suggestedSteps: patch.suggestedSteps,
        estimatedMinutes: patch.estimatedMinutes,
        energyLevel: patch.energyLevel,
        focusLevel: patch.focusLevel,
        rhythmConditions: patch.rhythmConditions,
        milestoneId: patch.milestoneId || undefined,
      });
      await refreshDatabase();
    } else {
      const task = {
        id: crypto.randomUUID(),
        title: patch.title,
        status: "ready",
        version: 1,
        intent: patch.intent,
        completionCriteria: patch.completionCriteria,
        suggestedSteps: patch.suggestedSteps,
        rhythmConditions: patch.rhythmConditions,
        estimatedMinutes: patch.estimatedMinutes,
        energyLevel: patch.energyLevel,
        focusLevel: patch.focusLevel,
        milestoneId: patch.milestoneId,
      };
      setGoals((items) => items.map((goal) => goal.id === goalId ? { ...goal, tasks: [...(goal.tasks ?? []), task], tasksTotal: goal.tasksTotal + 1 } : goal));
    }
    closeTaskModal();
    setNotice("任务已创建");
  }

  /**
   * 保存任务编辑内容。
   * @param goalId - 所属目标 ID
   * @param taskId - 任务 ID
   * @param patch - 待更新的任务字段
   */
  async function saveTaskEdits(goalId: string, taskId: string, patch: TaskFormPatch, options?: { keepModalOpen?: boolean }) {
    const goal = goals.find((entry) => entry.id === goalId);
    const task = goal?.tasks?.find((entry) => entry.id === taskId);
    if (!task) return;
    if (dataMode === "database") {
      await workspaceApi.updateTask(taskId, {
        title: patch.title,
        intent: patch.intent ?? undefined,
        completionCriteria: patch.completionCriteria ?? undefined,
        suggestedSteps: patch.suggestedSteps ?? undefined,
        estimatedMinutes: patch.estimatedMinutes ?? undefined,
        energyLevel: patch.energyLevel ?? undefined,
        focusLevel: patch.focusLevel ?? undefined,
        rhythmConditions: patch.rhythmConditions ?? undefined,
        milestoneId: patch.milestoneId ?? undefined,
        expectedVersion: task.version,
      });
      await refreshDatabase();
    } else {
      setGoals((items) => items.map((entry) => entry.id === goalId ? {
        ...entry,
        tasks: (entry.tasks ?? []).map((item) => item.id === taskId ? { ...item, ...patch, version: item.version + 1 } : item),
      } : entry));
    }
    if (!options?.keepModalOpen) closeTaskModal();
    setNotice("任务已保存");
  }

  /**
   * 确认完成任务：汇总投入与执行记录，由 AI（或规则兜底）生成完成总结并入库。
   * @param goalId - 所属目标 ID
   * @param taskId - 任务 ID
   */
  async function completeTaskWithAi(goalId: string, taskId: string) {
    const goal = goals.find((entry) => entry.id === goalId);
    const task = goal?.tasks?.find((entry) => entry.id === taskId);
    if (!task || task.status === "completed") return;
    if (dataMode === "database") {
      await workspaceApi.completeTask(taskId, task.version);
      await refreshDatabase();
    } else {
      const completionRecord = buildLocalTaskCompletionRecord(task, schedule);
      setGoals((items) => items.map((entry) => {
        if (entry.id !== goalId) return entry;
        return {
          ...entry,
          tasksDone: entry.tasksDone + 1,
          tasks: (entry.tasks ?? []).map((item) => item.id === taskId ? { ...item, status: "completed", completionRecord, version: item.version + 1 } : item),
        };
      }));
    }
    setNotice("任务已完成，小律已总结执行情况");
  }

  /**
   * 归档（删除）任务；若正在查看该任务详情则返回目标页。
   * @param goalId - 所属目标 ID
   * @param taskId - 任务 ID
   */
  async function archiveTaskById(goalId: string, taskId: string) {
    const goal = goals.find((entry) => entry.id === goalId);
    const task = goal?.tasks?.find((entry) => entry.id === taskId);
    if (!task) return;
    if (dataMode === "database") {
      await workspaceApi.archiveTask(taskId, task.version);
      await refreshDatabase();
    } else {
      setGoals((items) => items.map((entry) => entry.id === goalId ? {
        ...entry,
        tasks: (entry.tasks ?? []).filter((item) => item.id !== taskId),
        tasksTotal: Math.max(0, entry.tasksTotal - 1),
        tasksDone: task.status === "completed" ? Math.max(0, entry.tasksDone - 1) : entry.tasksDone,
      } : entry));
    }
    if (selectedTaskId === taskId) {
      setSelectedTaskId(null);
      setView("goal-detail");
    }
    closeTaskModal();
    setNotice("任务已删除");
  }

  async function saveSchedule(item: ScheduleItem) {
    const taskIds = resolveScheduleTaskIds(item);
    if (dataMode === "database") {
      await workspaceApi.createSchedule({ title: item.title, goalId: item.goalId || undefined, taskId: taskIds[0], taskIds, routineId: item.routineId, startsAt: zonedDateTimeToIso(item.date ?? currentDateKey(), item.start, userSettings.timezone), endsAt: zonedDateTimeToIso(item.date ?? currentDateKey(), item.end, userSettings.timezone) });
      await refreshDatabase();
    } else setSchedule((items) => [...items, item].sort((a, b) => a.start.localeCompare(b.start)));
    setModal(null);
  }

  async function saveFeedback(input: { tag: string; result: "completed" | "not_completed" | "rescheduled"; actualMinutes?: number; actualStartedAt?: string; actualEndedAt?: string; quality?: string; obstacle?: string; nextAction?: string; note?: string; comfortable?: boolean; timeFit?: string }) {
    if (!selectedItem) return;
    if (dataMode === "database" && selectedItem.source === "routine_occurrence" && selectedItem.routineId && selectedItem.occurrenceDate) {
      const itemDate = selectedItem.date ?? currentDateKey();
      const movedOccurrence = selectedItem.status === "rescheduled";
      const payload: Parameters<typeof workspaceApi.recordRoutineExecution>[0] = {
        routineId: selectedItem.routineId,
        occurrenceDate: selectedItem.occurrenceDate,
        status: input.result === "completed" ? "completed" : input.result === "rescheduled" ? "rescheduled" : "skipped",
        actualMinutes: input.actualMinutes,
        feedbackTags: [feedbackTag(input.tag)],
        note: input.note,
      };
      if (!selectedItem.execution) {
        payload.plannedStartAt = zonedDateTimeToIso(itemDate, selectedItem.start, userSettings.timezone);
        payload.plannedEndAt = zonedDateTimeToIso(itemDate, selectedItem.end, userSettings.timezone);
      }
      if (movedOccurrence || input.result === "rescheduled") {
        payload.rescheduledStartAt = zonedDateTimeToIso(itemDate, selectedItem.start, userSettings.timezone);
        payload.rescheduledEndAt = zonedDateTimeToIso(itemDate, selectedItem.end, userSettings.timezone);
      }
      await workspaceApi.recordRoutineExecution(payload);
      await refreshDatabase();
    } else if (dataMode === "database") {
      await workspaceApi.recordExecution(selectedItem.id, { result: input.result, tags: [feedbackTag(input.tag)], actualMinutes: input.actualMinutes, actualStartedAt: input.actualStartedAt ? localInputToIso(input.actualStartedAt, userSettings.timezone) : undefined, actualEndedAt: input.actualEndedAt ? localInputToIso(input.actualEndedAt, userSettings.timezone) : undefined, quality: input.quality, obstacle: input.obstacle, nextAction: input.nextAction, deviationReason: input.result === "completed" ? undefined : input.note, note: input.note, comfortable: input.comfortable, timeFit: input.timeFit });
      await refreshDatabase();
    } else setSchedule((items) => items.map((item) => item.id === selectedItem.id ? { ...item, status: input.result === "completed" ? "completed" : "missed", feedback: input.tag } : item));
    setModal(null);
  }

  /**
   * 手动生成或重新生成指定类型的回顾；优先重写当前展示周期，否则生成最近到期周期。
   * @param type - 日回顾或周回顾
   * @param current - 当前 Tab 展示中的回顾；首次生成时为 null
   */
  async function generateReview(type: "daily" | "weekly", current: ReviewRecord | null = null) {
    const { periodStart, periodEnd } = resolveManualReviewPeriod(type, userSettings, current);
    if (dataMode === "database") {
      const review = await reviewApi.generate(type, periodStart.toISOString(), periodEnd.toISOString());
      setReviews((items) => [review, ...items.filter((item) => item.id !== review.id)]);
    } else {
      const weekItems = schedule.filter((item) => {
        const date = item.date ? new Date(`${item.date}T12:00:00`) : new Date();
        return date >= periodStart && date < periodEnd;
      });
      const completedCount = weekItems.filter((item) => item.status === "completed").length;
      const review: ReviewRecord = {
        id: `local-${type}-${periodStart.toISOString()}`,
        type,
        status: "awaiting_confirmation",
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        summary: `${type === "weekly" ? "本周" : "这一天"}完成 ${completedCount}/${weekItems.length} 个日程块。`,
        metrics: { total: weekItems.length, completed: completedCount },
        findings: ["继续记录顺畅与阻力，节奏模式会逐渐清晰。"],
        suggestions: ["先处理未完成日程，再安排新的高专注任务。"],
      };
      setReviews((items) => [review, ...items.filter((item) => item.id !== review.id)]);
    }
    setNotice(`${type === "weekly" ? "周" : "日"}回顾已生成，等待你确认`);
  }

  async function confirmReview(review: ReviewRecord) {
    if (dataMode === "database") { const updated = await reviewApi.confirm(review.id, review.status !== "confirmed"); setReviews((items) => items.map((item) => item.id === review.id ? updated : item)); }
    else setReviews((items) => items.map((item) => item.id === review.id ? { ...item, status: item.status === "confirmed" ? "draft" : "confirmed", confirmedAt: item.status === "confirmed" ? null : new Date().toISOString() } : item));
    setNotice(review.status === "confirmed" ? "回顾确认已撤销" : "这份回顾已由你确认");
  }

  async function confirmOutcome(goalId: string, outcome: NonNullable<Goal["outcomes"]>[number]) {
    if (dataMode === "database") { await workspaceApi.updateOutcome(outcome.id, { completed: true, expectedVersion: outcome.version }); await refreshDatabase(); }
    else setGoals((items) => items.map((goal) => goal.id === goalId ? { ...goal, outcomes: goal.outcomes?.map((item) => item.id === outcome.id ? { ...item, completedAt: new Date().toISOString(), version: item.version + 1 } : item) } : goal));
    setNotice("结果指标已由你确认完成");
  }

  async function confirmMilestone(goalId: string, milestone: NonNullable<Goal["milestones"]>[number]) {
    if (dataMode === "database") { await workspaceApi.updateMilestone(milestone.id, { status: "completed", expectedVersion: milestone.version }); await refreshDatabase(); }
    else setGoals((items) => items.map((goal) => goal.id === goalId ? { ...goal, milestones: goal.milestones?.map((item) => item.id === milestone.id ? { ...item, status: "completed", version: item.version + 1 } : item) } : goal));
    setNotice("里程碑已由你确认完成");
  }

  async function saveRoutineQuickSettings(routine: NonNullable<Goal["routines"]>[number], patch: { startDate: string; endDate: string | null; status: "active" | "paused" }) {
    const normalized = {
      startDate: zonedDateTimeToIso(patch.startDate, "00:00", userSettings.timezone),
      endDate: patch.endDate ? zonedDateTimeToIso(patch.endDate, "23:59", userSettings.timezone) : null,
      status: patch.status,
    };
    if (dataMode === "database") {
      await workspaceApi.updateRoutine(routine.id, { ...normalized, expectedVersion: routine.version });
      await refreshDatabase();
    } else {
      const updatedRoutine = { ...routine, ...normalized, version: routine.version + 1 };
      const routineGoalId = goals.find((goal) => goal.routines?.some((item) => item.id === routine.id))?.id ?? "";
      setGoals((items) => items.map((goal) => ({
        ...goal,
        routines: goal.routines?.map((item) => item.id === routine.id ? updatedRoutine : item),
      })));
      setSchedule((items) => rebuildLocalRoutineOccurrences(items, updatedRoutine, routineGoalId, userSettings.timezone));
    }
    setNotice(patch.status === "active" ? "Routine 已重新计算，后续实例会按规则出现" : "Routine 已暂停，未发生的后续实例已删除");
  }

  return (
    <div className="app-shell">
      <aside className={clsx("sidebar", mobileNav && "sidebar-open")}>
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div><strong>Rhythm <i>&</i> Routine</strong><small>目标推进系统</small></div>
          <button className="icon-button mobile-close" onClick={() => setMobileNav(false)} aria-label="关闭导航"><X size={18} /></button>
        </div>

        <nav className="primary-nav" aria-label="主导航">
          <NavButton active={view === "today"} icon={<CalendarDays />} label="今天" hint={todayPendingCount > 0 ? String(todayPendingCount) : undefined} onClick={() => { setView("today"); setMobileNav(false); }} />
          <NavButton active={view === "goals" || view === "goal-detail" || view === "task-detail"} icon={<Target />} label="目标" onClick={() => { setView("goals"); setSelectedTaskId(null); setMobileNav(false); }} />
          <NavButton active={view === "routines"} icon={<Infinity />} label="Routine" onClick={() => { setView("routines"); setMobileNav(false); }} />
          <NavButton active={view === "review"} icon={<RefreshCcw />} label="回顾" hint={reviewNeedsAttention ? "新" : undefined} onClick={() => { setView("review"); setMobileNav(false); }} />
          <NavButton active={view === "settings"} icon={<Settings />} label="设置" onClick={() => { setView("settings"); setMobileNav(false); }} />
        </nav>

        <div className="sidebar-pulse">
          <div className="pulse-orbit"><Leaf size={18} /></div>
          <p>你最近的深度任务，在上午推进得更自然。</p>
          <button onClick={() => setView("review")}>看看这个发现 <ArrowRight size={14} /></button>
        </div>

        <div className="sidebar-footer">
          <button><Settings size={17} /><span>偏好设置</span></button>
          <div className="profile-dot">C</div>
          <div><strong>Calcifer</strong><small>Asia / Shanghai</small></div>
        </div>
      </aside>

      {mobileNav && <button className="nav-scrim" aria-label="关闭导航" onClick={() => setMobileNav(false)} />}

      <main className="main-stage">
        {dataMode === "local" && <div className="mode-banner"><span>本地模式</span>数据库尚未连接，修改会安全保存在这台浏览器中。</div>}
        {notice && <button className="notice-toast" onClick={() => setNotice(null)}>{notice}<X size={14} /></button>}
        <header className={clsx("page-header", (view === "goal-detail" || view === "task-detail") && "detail-page-header")}>
          <div className="header-copy">
            <button className="icon-button menu-button" onClick={() => setMobileNav(true)} aria-label="打开导航"><Menu size={20} /></button>
            {view === "goal-detail" && selectedGoal ? <div><button className="back-link" onClick={() => { setView("goals"); setSelectedTaskId(null); }}><ChevronLeft size={15} />返回目标列表</button><h1>{selectedGoal.title}</h1><p>{selectedGoal.description}</p></div> : view === "task-detail" && selectedGoal && selectedTask ? <div><button className="back-link" onClick={() => setView("goal-detail")}><ChevronLeft size={15} />返回目标详情</button><h1>{selectedTask.title}</h1><p>{selectedGoal.title}{selectedTask.milestoneId ? " · 关联里程碑" : " · 行动任务"}</p></div> : <div><span className="eyebrow">{view === "today" ? todayLabel() : viewMeta[view].kicker}</span><h1>{viewMeta[view].title}</h1></div>}
          </div>
          <div className="header-actions">
            {view === "goal-detail" && selectedGoal && <button className="soft-button" onClick={() => setModal("goal-detail")}>编辑目标</button>}
            {view === "task-detail" && selectedTask && <button className="soft-button" onClick={() => setTaskDetailEditing((value) => !value)}><Pencil size={16} />{taskDetailEditing ? "取消编辑" : "编辑任务"}</button>}
            {view === "task-detail" && selectedTask && <button className="soft-button danger-outline" onClick={() => { if (window.confirm(`确定删除任务「${selectedTask.title}」？关联日程仍会保留在历史中。`)) void archiveTaskById(selectedGoal!.id, selectedTask.id); }}><Trash2 size={16} />删除任务</button>}
            {view === "task-detail" && selectedTask && <button className="soft-button" onClick={() => { setScheduleSeed({ goalId: selectedGoalId ?? undefined, taskId: selectedTask.id }); setModal("schedule"); }}><CalendarDays size={16} />安排到日程</button>}
            {view !== "settings" && <button className={view === "goal-detail" || view === "task-detail" ? "primary-button" : "soft-button"} onClick={() => setAgentOpen(true)}><Sparkles size={16} />{view === "goal-detail" ? "请小律规划" : view === "task-detail" ? "请小律拆分" : "请小律调整"}</button>}
            {view === "goals" && <button className="primary-button" onClick={() => setModal("goal")}><Plus size={17} />新建目标</button>}
            {view === "routines" && <button className="primary-button" onClick={() => { setSelectedRoutineId(null); setModal("routine"); }}><Plus size={17} />新建 Routine</button>}
            {view === "today" && <button className="primary-button" onClick={() => { setScheduleSeed(null); setModal("schedule"); }}><Plus size={17} />安排事情</button>}
          </div>
        </header>

        {view === "today" && <TodayView goals={goals} schedule={schedule} rhythmSignals={rhythmSignals} timezone={userSettings.timezone} dataMode={dataMode} serverInsights={serverInsights} alternateMomentIndex={alternateMomentIndex} insightTick={insightTick} onFeedback={openFeedback} onComplete={completePersonalSchedule} onEdit={(id) => { const item = schedule.find((entry) => entry.id === id); setSelectedBlock(id); setModal(item?.source === "routine_occurrence" ? "feedback" : "schedule-edit"); }} onAdd={(seed) => openScheduleModal(seed, { promptType: true })} onUpdateTime={updateScheduleTime} onApplyMoment={applyMomentAction} onApplyServerMoment={applyServerMomentChange} onAlternateMoment={alternateServerMoment} onRegenerateMoment={(signal) => regenerateInsightTarget("moment", signal)} onRegenerateSlow={(signal) => regenerateInsightTarget("slow", signal)} onPreferSignal={(signalId) => { preferSignalForScheduling(signalId); setInsightTick((value) => value + 1); setNotice("已记录，后续排程会优先考虑此节奏发现"); }} />}
        {view === "goals" && <GoalsView goals={goals} onAdd={() => setModal("goal")} onOpen={(id) => { setSelectedGoalId(id); setSelectedTaskId(null); setView("goal-detail"); }} />}
        {view === "goal-detail" && selectedGoal && <GoalDetailView goal={selectedGoal} schedule={schedule} reviews={reviews} rhythmSignals={rhythmSignals} onOpenTask={(taskId) => { setSelectedTaskId(taskId); setTaskDetailEditing(false); setView("task-detail"); }} onAddTask={openTaskCreateModal} onEditTask={openTaskEditModal} onDeleteTask={(taskId) => { const task = selectedGoal.tasks?.find((entry) => entry.id === taskId); if (task && window.confirm(`确定删除任务「${task.title}」？`)) void archiveTaskById(selectedGoal.id, taskId); }} onArrange={(seed) => openScheduleModal(seed)} onAskAgent={() => setAgentOpen(true)} />}
        {view === "task-detail" && selectedGoal && selectedTask && <TaskDetailView goal={selectedGoal} task={selectedTask} schedule={schedule} rhythmSignals={rhythmSignals} editing={taskDetailEditing} onEditingChange={setTaskDetailEditing} onSave={(patch) => saveTaskEdits(selectedGoal.id, selectedTask.id, patch, { keepModalOpen: true }).then(() => setTaskDetailEditing(false))} onComplete={() => completeTaskWithAi(selectedGoal.id, selectedTask.id)} onArrange={() => openScheduleModal({ goalId: selectedGoal.id, taskId: selectedTask.id })} onEditSchedule={(id) => { setSelectedBlock(id); setModal("schedule-edit"); }} onFeedback={openFeedback} onAskAgent={() => setAgentOpen(true)} />}
        {view === "routines" && <RoutinesView goals={goals} schedule={schedule} selectedRoutineId={selectedRoutineId} timezone={userSettings.timezone} onSelect={setSelectedRoutineId} onEdit={(id) => { setSelectedRoutineId(id); setModal("routine"); }} onQuickSave={saveRoutineQuickSettings} onFeedback={openFeedback} onAskAgent={() => setAgentOpen(true)} />}
        {view === "review" && <ReviewView goals={goals} reviews={reviews} settings={userSettings} onGenerate={(type, current) => void generateReview(type, current)} onConfirm={(review) => void confirmReview(review)} onConfirmOutcome={(goalId, outcome) => void confirmOutcome(goalId, outcome)} onConfirmMilestone={(goalId, milestone) => void confirmMilestone(goalId, milestone)} onCompleteTask={(goalId, taskId) => void completeTaskWithAi(goalId, taskId)} onAskAgent={() => setAgentOpen(true)} />}
        {view === "settings" && <SettingsView providers={providers} provider={selectedProvider} model={selectedModel} settings={userSettings} onSave={async (provider, model, settings) => { setSelectedProvider(provider); setSelectedModel(model); setUserSettings(settings); localStorage.setItem("rr.provider", provider); localStorage.setItem("rr.model", model); if (dataMode === "database") await settingsApi.save({ ...settings, defaultModel: model }); setNotice("偏好设置已保存"); }} />}
      </main>

      <button className={clsx("agent-fab", agentOpen && "agent-fab-hidden")} onClick={() => setAgentOpen(true)} aria-label="打开小律">
        <Sparkles size={18} /><span>问小律</span>
      </button>
      <AgentPanel open={agentOpen} onClose={() => setAgentOpen(false)} goals={goals} schedule={schedule} view={view} provider={selectedProvider} model={selectedModel} selectedGoalId={selectedGoalId} onApply={async (changeSet, indexes) => { if (dataMode === "database") { await changeSetApi.decide(changeSet.id, true, indexes); await refreshDatabase(); setNotice("小律的变更草案已应用"); } else applyLocalChangeSet({ ...changeSet, operations: changeSet.operations.filter((_, index) => indexes.includes(index)) }, goals, schedule, setGoals, setSchedule, setNotice); }} onReject={async (changeSet) => { if (dataMode === "database") await changeSetApi.decide(changeSet.id, false); setNotice("已拒绝这份草案，正式计划没有变化"); }} />

      {modal === "goal" && <GoalModal onClose={() => setModal(null)} onSave={saveGoal} />}
      {modal === "goal-detail" && selectedGoal && <GoalDetailModal goal={selectedGoal} dataMode={dataMode} onClose={() => setModal(null)} onChanged={async () => { if (dataMode === "database") await refreshDatabase(); }} onLocalChange={(next) => setGoals((items) => items.map((goal) => goal.id === next.id ? next : goal))} onLocalArchive={() => { setGoals((items) => items.filter((goal) => goal.id !== selectedGoal.id)); setModal(null); }} onNotice={setNotice} />}
      {modal === "task-create" && selectedGoal && <TaskFormModal mode="create" goal={selectedGoal} dataMode={dataMode} onClose={closeTaskModal} onSave={(patch) => createTaskForGoal(selectedGoal.id, patch)} />}
      {modal === "task-edit" && selectedGoal && modalTask && <TaskFormModal mode="edit" goal={selectedGoal} task={modalTask} dataMode={dataMode} onClose={closeTaskModal} onSave={(patch) => saveTaskEdits(selectedGoal.id, modalTask.id, patch)} onDelete={() => archiveTaskById(selectedGoal.id, modalTask.id)} />}
      {modal === "routine" && <RoutineFormModal goals={goals} routineId={selectedRoutineId} dataMode={dataMode} timezone={userSettings.timezone} onClose={() => setModal(null)} onSaved={async (goalId, routine) => { if (dataMode === "database") await refreshDatabase(); else setGoals((items) => items.map((goal) => goal.id === goalId ? { ...goal, routines: routine.id ? [...(goal.routines ?? []).filter((item) => item.id !== routine.id), routine] : goal.routines } : goal)); setSelectedRoutineId(routine.id); setModal(null); setNotice("Routine 已保存"); }} />}
      {modal === "schedule-choice" && <ScheduleAddChoiceModal initialSelection={scheduleSeed ?? undefined} onClose={() => { setModal(null); setScheduleSeed(null); }} onChooseGoal={() => setModal("schedule")} onChoosePersonal={() => setModal("personal-schedule")} />}
      {modal === "schedule" && <ScheduleModal goals={goals} initialSelection={scheduleSeed ?? undefined} onClose={() => { setModal(null); setScheduleSeed(null); }} onSave={saveSchedule} />}
      {modal === "personal-schedule" && <PersonalScheduleModal initialSelection={scheduleSeed ?? undefined} onClose={() => { setModal(null); setScheduleSeed(null); }} onSave={saveSchedule} />}
      {modal === "schedule-edit" && selectedItem && <ScheduleEditModal item={selectedItem} dataMode={dataMode} goals={goals} onClose={() => setModal(null)} onSave={async (next, reason) => { const taskIds = resolveScheduleTaskIds(next); if (dataMode === "database" && next.version) { await workspaceApi.updateSchedule(next.id, { title: next.title, goalId: next.goalId || undefined, taskId: taskIds[0], taskIds, routineId: next.routineId, startsAt: zonedDateTimeToIso(next.date ?? currentDateKey(), next.start, userSettings.timezone), endsAt: zonedDateTimeToIso(next.date ?? currentDateKey(), next.end, userSettings.timezone), changeReason: reason.trim() || undefined, expectedVersion: next.version }); await refreshDatabase(); } else setSchedule((items) => items.map((item) => item.id === next.id ? { ...next, changeReason: reason } : item)); setModal(null); }} onDelete={async () => { if (dataMode === "database" && selectedItem.version) { await workspaceApi.deleteSchedule(selectedItem.id, selectedItem.version); await refreshDatabase(); } else setSchedule((items) => items.filter((item) => item.id !== selectedItem.id)); setModal(null); }} />}
      {modal === "feedback" && selectedItem && <FeedbackModal item={selectedItem} onClose={() => setModal(null)} onSave={saveFeedback} />}
    </div>
  );
}

function migrateLocalGoals(value: unknown): Goal[] {
  if (!Array.isArray(value)) return initialGoals;
  const migrated: Goal[] = [];
  for (const stored of value) {
    if (!stored || typeof stored !== "object") continue;
    const goal = stored as Goal;
    const template = initialGoals.find((item) => item.id === goal.id);
    if (!template) {
      migrated.push({ ...goal, tasks: goal.tasks ?? [], routines: goal.routines ?? [], outcomes: goal.outcomes ?? [], milestones: goal.milestones ?? [] });
      continue;
    }
    const restoredTasks = goal.tasks ?? template.tasks ?? [];
    migrated.push({
      ...template,
      ...goal,
      tasks: restoredTasks,
      routines: goal.routines ?? template.routines ?? [],
      outcomes: goal.outcomes ?? template.outcomes ?? [],
      milestones: goal.milestones ?? template.milestones ?? [],
      tasksDone: goal.tasks ? goal.tasksDone : restoredTasks.filter((task) => task.status === "completed").length,
      tasksTotal: goal.tasks ? goal.tasksTotal : restoredTasks.length,
    });
  }
  return migrated;
}

function NavButton({ active, icon, label, hint, onClick }: { active: boolean; icon: React.ReactNode; label: string; hint?: string; onClick: () => void }) {
  return <button className={clsx("nav-button", active && "active")} onClick={onClick}>{icon}<span>{label}</span>{hint && <em>{hint}</em>}</button>;
}

/**
 * 展示洞察卡片内容来源（小律生成 / 规则建议）。
 * @param source - API 返回的 ai 或 rules
 */
function InsightSourceBadge({ source }: { source?: "ai" | "rules" }) {
  if (!source) return null;
  return <span className={clsx("insight-source-badge", source)}>{source === "ai" ? "小律生成" : "规则建议"}</span>;
}

/**
 * 将快照生成时间格式化为相对时间文案。
 * @param iso - ISO 时间字符串
 */
function formatInsightUpdatedAt(iso?: string) {
  if (!iso) return null;
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 60_000) return "刚刚更新";
  if (diffMs < 3_600_000) return `${Math.max(1, Math.round(diffMs / 60_000))} 分钟前更新`;
  if (diffMs < 86_400_000) return `${Math.max(1, Math.round(diffMs / 3_600_000))} 小时前更新`;
  return `${Math.max(1, Math.round(diffMs / 86_400_000))} 天前更新`;
}

const INSIGHT_REGEN_WAIT_MS = 8_000;
/** 客户端等待上限：需大于服务端 AI 超时 + 规则降级与落库余量 */
const INSIGHT_REGEN_TIMEOUT_MS = 75_000;

type InsightRegenPhase = "idle" | "generating" | "waiting" | "error";

type InsightRegenState = {
  phase: InsightRegenPhase;
  message: string | null;
};

/**
 * 洞察卡片标题行：来源标签、更新时间、手动刷新。
 * @param props - 标题与交互回调
 */
function InsightCardHeading({
  kicker,
  source,
  generatedAt,
  trailing,
  showRefresh,
  refreshing,
  onRefresh,
}: {
  kicker: string;
  source?: "ai" | "rules";
  generatedAt?: string;
  trailing?: React.ReactNode;
  showRefresh: boolean;
  refreshing: boolean;
  onRefresh?: () => void;
}) {
  const updatedLabel = formatInsightUpdatedAt(generatedAt);
  return (
    <div className="insight-card-heading">
      <div className="insight-card-heading-main">
        <span className="section-kicker">{kicker}</span>
        <InsightSourceBadge source={source} />
        {updatedLabel && <span className="insight-updated-at">{updatedLabel}</span>}
      </div>
      <div className="insight-card-heading-actions">
        {trailing}
        {showRefresh && onRefresh && (
          <button type="button" className="insight-refresh-button" disabled={refreshing} onClick={onRefresh} aria-label={`更新${kicker}`}>
            <RefreshCcw size={14} className={refreshing ? "spinning" : undefined} />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 洞察卡次要信息展开/收起开关；无折叠内容时不渲染。
 * @param props.expanded - 当前是否展开
 * @param props.hasContent - 是否存在可折叠内容
 * @param props.onToggle - 切换展开状态
 */
function InsightExpandToggle({
  expanded,
  hasContent,
  onToggle,
}: {
  expanded: boolean;
  hasContent: boolean;
  onToggle: () => void;
}) {
  if (!hasContent) return null;
  return (
    <button type="button" className="text-link insight-expand-toggle" onClick={onToggle}>
      {expanded ? "收起" : "展开详情"}
    </button>
  );
}

/**
 * 洞察卡生成态/错误态文案条；idle 时不渲染。
 * @param props.state - 当前生成态
 * @param props.onRetry - 失败时重试回调
 */
function InsightRegenStatusBar({
  state,
  onRetry,
}: {
  state: InsightRegenState;
  onRetry?: () => void;
}) {
  if (state.phase === "idle" || !state.message) return null;
  const isError = state.phase === "error";
  return (
    <div className={clsx("insight-regen-status", isError && "is-error", state.phase === "waiting" && "is-waiting")} role="status">
      <span>{state.message}</span>
      {isError && onRetry && (
        <button type="button" className="text-link" onClick={onRetry}>重试</button>
      )}
    </div>
  );
}

function TodayView({ goals, schedule, rhythmSignals, timezone, dataMode, serverInsights, alternateMomentIndex, insightTick, onFeedback, onComplete, onEdit, onAdd, onUpdateTime, onApplyMoment, onApplyServerMoment, onAlternateMoment, onRegenerateMoment, onRegenerateSlow, onPreferSignal }: {
  goals: Goal[];
  schedule: ScheduleItem[];
  rhythmSignals: RhythmSignalRecord[];
  timezone: string;
  dataMode: "checking" | "database" | "local";
  serverInsights: ApiHomeInsights | null;
  alternateMomentIndex: number;
  insightTick: number;
  onFeedback: (id: string) => void;
  onComplete: (id: string) => void;
  onEdit: (id: string) => void;
  onAdd: (seed?: ScheduleTimeSeed) => void;
  onUpdateTime: (item: ScheduleItem, start: string, end: string, date?: string) => Promise<void>;
  onApplyMoment: (action: MomentAction) => Promise<void>;
  onApplyServerMoment: (change: HomeInsightProposedChange) => Promise<void>;
  onAlternateMoment: () => void | Promise<void>;
  onRegenerateMoment: (signal?: AbortSignal) => void | Promise<void>;
  onRegenerateSlow: (signal?: AbortSignal) => void | Promise<void>;
  onPreferSignal: (signalId: string) => void;
}) {
  const [calendarMode, setCalendarMode] = useState<CalendarMode>("today");
  const [anchorDate, setAnchorDate] = useState(currentDateKey());
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showRoutines, setShowRoutines] = useState(true);
  const [showCompleted, setShowCompleted] = useState(true);
  const [now, setNow] = useState(() => new Date());
  const [momentExpanded, setMomentExpanded] = useState(false);
  const [rhythmExpanded, setRhythmExpanded] = useState(false);
  const [weeklyExpanded, setWeeklyExpanded] = useState(false);
  const [momentRegen, setMomentRegen] = useState<InsightRegenState>({ phase: "idle", message: null });
  const [slowRegen, setSlowRegen] = useState<InsightRegenState>({ phase: "idle", message: null });
  const regenTimersRef = useRef<{ wait?: number; timeout?: number; controller?: AbortController }>({});
  const slowTimersRef = useRef<{ wait?: number; timeout?: number; controller?: AbortController }>({});
  const todayKey = currentDateKey();
  const visibleSchedule = schedule.filter((item) => (showRoutines || item.kind !== "routine") && (showCompleted || item.status !== "completed") && isActiveCalendarBlock(item));
  const daySchedule = visibleSchedule.filter((item) => ((!item.date && anchorDate === todayKey) || item.date === anchorDate)).sort((a, b) => a.start.localeCompare(b.start));
  const weekStart = weekStartFromDate(anchorDate);
  const weekSchedule = visibleSchedule.filter((item) => weekDateKeys(weekStart).includes(item.date ?? todayKey));
  const anchorMonth = new Date(`${anchorDate}T12:00:00`);
  const monthSchedule = visibleSchedule.filter((item) => {
    const key = item.date ?? todayKey;
    const date = new Date(`${key}T12:00:00`);
    return date.getFullYear() === anchorMonth.getFullYear() && date.getMonth() === anchorMonth.getMonth();
  });
  const progressSchedule = calendarMode === "today" ? daySchedule : calendarMode === "week" ? weekSchedule.filter((item) => item.date === anchorDate) : daySchedule;
  const progressCompleted = progressSchedule.filter((item) => item.status === "completed").length;
  const progressTotal = progressSchedule.length;
  const selectedBlock = selectedBlockId ? schedule.find((entry) => entry.id === selectedBlockId) ?? null : null;
  const toolbarTitle = formatToolbarTitle(anchorDate, calendarMode, todayKey, timezone);
  const useServerInsights = dataMode === "database" && serverInsights !== null;
  const [momentBusy, setMomentBusy] = useState(false);
  const localInsights = useMemo(() => {
    void insightTick;
    return computeHomeInsights({
      now,
      timezone,
      goals,
      schedule,
      rhythmSignals,
      alternateMomentIndex,
    });
  }, [now, timezone, goals, schedule, rhythmSignals, alternateMomentIndex, insightTick]);
  const momentCard = useServerInsights && serverInsights
    ? serverInsights.moment
    : {
        kind: localInsights.moment.kind,
        headline: localInsights.moment.headline,
        judgment: localInsights.moment.judgment,
        reason: localInsights.moment.reason,
        nextLabel: localInsights.moment.nextLabel,
        proposedChange: undefined,
        actionLabel: localInsights.moment.action?.label,
        alternateCount: localInsights.moment.alternateCount,
        alternateIndex: alternateMomentIndex,
        exhausted: false,
        source: "rules" as const,
      };
  const rhythmCard = useServerInsights && serverInsights
    ? {
        kind: serverInsights.rhythm.kind,
        statement: serverInsights.rhythm.statement,
        evidence: serverInsights.rhythm.evidence,
        impact: serverInsights.rhythm.impact,
        signalId: serverInsights.rhythm.signalId,
        preferred: serverInsights.rhythm.signalId ? isSignalPreferred(serverInsights.rhythm.signalId) : false,
        source: serverInsights.rhythm.source,
        generatedAt: serverInsights.rhythm.generatedAt,
      }
    : { ...localInsights.rhythm, source: "rules" as const };
  const weeklyCard = useServerInsights && serverInsights
    ? {
        kind: serverInsights.weekly.kind,
        statusLabel: serverInsights.weekly.statusLabel,
        status: serverInsights.weekly.status,
        summary: serverInsights.weekly.summary,
        suggestion: serverInsights.weekly.suggestion,
        plannedMinutes: serverInsights.weekly.plannedMinutes ?? 0,
        completedMinutes: serverInsights.weekly.completedMinutes ?? 0,
        source: serverInsights.weekly.source,
        generatedAt: serverInsights.weekly.generatedAt,
      }
    : { ...localInsights.weekly, source: "rules" as const };
  const weeklyLoadPercent = weeklyCard.plannedMinutes > 0
    ? Math.min(100, Math.round((weeklyCard.completedMinutes / weeklyCard.plannedMinutes) * 100))
    : 0;
  const momentActionLabel = useServerInsights
    ? momentCard.proposedChange?.label ?? momentCard.actionLabel
    : localInsights.moment.action?.label;
  const showMomentAlternate = useServerInsights
    ? momentCard.kind === "action" && !momentCard.exhausted && momentCard.alternateCount > 0
    : momentCard.kind === "action" && localInsights.moment.alternateCount > 1;
  const momentHasDetail = Boolean(momentCard.reason);
  const rhythmHasDetail = Boolean(rhythmCard.evidence || rhythmCard.impact);
  const weeklyHasDetail = Boolean(weeklyCard.suggestion);
  const momentRefreshing = momentRegen.phase === "generating" || momentRegen.phase === "waiting";
  const slowRefreshing = slowRegen.phase === "generating" || slowRegen.phase === "waiting";
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 60_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => () => {
    // 仅清理定时器；不要 abort 进行中的 fetch。
    // HMR / 重挂载 abort 会被误判为「生成超时」，而服务端其实还在跑。
    window.clearTimeout(regenTimersRef.current.wait);
    window.clearTimeout(regenTimersRef.current.timeout);
    window.clearTimeout(slowTimersRef.current.wait);
    window.clearTimeout(slowTimersRef.current.timeout);
  }, []);

  /**
   * 打开日程详情侧滑面板并高亮对应块。
   * @param id - 日程块 ID
   */
  function openScheduleDrawer(id: string) {
    setSelectedBlockId(id);
    setDrawerOpen(true);
  }

  /**
   * 关闭详情侧滑面板并清除选中态。
   */
  function closeScheduleDrawer() {
    setDrawerOpen(false);
    setSelectedBlockId(null);
  }

  /**
   * 清理指定目标的生成态定时器与 AbortController。
   * @param target - moment 或 slow
   */
  function clearRegenTimers(target: "moment" | "slow") {
    const bag = target === "moment" ? regenTimersRef : slowTimersRef;
    window.clearTimeout(bag.current.wait);
    window.clearTimeout(bag.current.timeout);
    bag.current.wait = undefined;
    bag.current.timeout = undefined;
  }

  /**
   * 手动重生成洞察：先清空卡片正文，展示生成文案；超时按失败处理。
   * @param target - moment 仅此刻建议；slow 同时影响节奏发现与本周轨道
   */
  async function handleRegenerate(target: "moment" | "slow") {
    if (!useServerInsights) return;
    if (target === "moment" && momentRefreshing) return;
    if (target === "slow" && slowRefreshing) return;

    const bag = target === "moment" ? regenTimersRef : slowTimersRef;
    const setRegen = target === "moment" ? setMomentRegen : setSlowRegen;
    clearRegenTimers(target);
    bag.current.controller?.abort();
    const controller = new AbortController();
    bag.current.controller = controller;
    const startedAt = Date.now();

    setRegen({ phase: "generating", message: "正在重新生成…" });
    bag.current.wait = window.setTimeout(() => {
      console.warn("[home-insights] client still waiting", { target, ms: Date.now() - startedAt });
      setRegen((prev) => (prev.phase === "generating" ? { phase: "waiting", message: "仍在生成，请稍候…" } : prev));
    }, INSIGHT_REGEN_WAIT_MS);
    bag.current.timeout = window.setTimeout(() => {
      console.error("[home-insights] client abort timeout", {
        target,
        timeoutMs: INSIGHT_REGEN_TIMEOUT_MS,
        ms: Date.now() - startedAt,
      });
      controller.abort();
    }, INSIGHT_REGEN_TIMEOUT_MS);

    try {
      if (target === "moment") await onRegenerateMoment(controller.signal);
      else await onRegenerateSlow(controller.signal);
      clearRegenTimers(target);
      setRegen({ phase: "idle", message: null });
    } catch (caught) {
      clearRegenTimers(target);
      const aborted =
        controller.signal.aborted
        || (caught instanceof DOMException && caught.name === "AbortError")
        || (caught instanceof Error && caught.name === "AbortError");
      const message = aborted
        ? "生成超时，请重试"
        : caught instanceof Error && caught.message
          ? caught.message
          : "洞察更新失败，请稍后再试";
      console.error("[home-insights] client card regen error", {
        target,
        ms: Date.now() - startedAt,
        aborted,
        message,
      });
      setRegen({ phase: "error", message });
    } finally {
      if (bag.current.controller === controller) bag.current.controller = undefined;
    }
  }

  async function handleApplyMoment() {
    if (momentBusy) return;
    if (useServerInsights) {
      if (!momentCard.proposedChange) return;
      setMomentBusy(true);
      try {
        await onApplyServerMoment(momentCard.proposedChange);
      } finally {
        setMomentBusy(false);
      }
      return;
    }
    if (!localInsights.moment.action) return;
    setMomentBusy(true);
    try {
      await onApplyMoment(localInsights.moment.action);
    } finally {
      setMomentBusy(false);
    }
  }
  return (
    <div className="content-grid">
      <section className="rhythm-card calendar-shell">
        <CalendarHeader completed={progressCompleted} total={progressTotal} />
        <CalendarToolbar
          title={toolbarTitle}
          mode={calendarMode}
          showRoutines={showRoutines}
          showCompleted={showCompleted}
          onToday={() => setAnchorDate(todayKey)}
          onPrev={() => setAnchorDate((value) => shiftAnchorDate(value, calendarMode, -1))}
          onNext={() => setAnchorDate((value) => shiftAnchorDate(value, calendarMode, 1))}
          onModeChange={setCalendarMode}
          onToggleRoutines={() => setShowRoutines((value) => !value)}
          onToggleCompleted={() => setShowCompleted((value) => !value)}
        />
        <div className={clsx("calendar-body", drawerOpen && "drawer-open")}>
          <div className="calendar-main">
            {calendarMode === "today" && (
              <DayTimeline
                date={anchorDate}
                todayKey={todayKey}
                timezone={timezone}
                now={now}
                items={daySchedule}
                goals={goals}
                selectedBlockId={selectedBlockId}
                onSelect={openScheduleDrawer}
                onFeedback={onFeedback}
                onComplete={onComplete}
                onAdd={onAdd}
                onUpdateTime={onUpdateTime}
              />
            )}
            {calendarMode === "week" && (
              <WeekTimeline
                weekStart={weekStart}
                anchorDate={anchorDate}
                todayKey={todayKey}
                timezone={timezone}
                now={now}
                schedule={weekSchedule}
                goals={goals}
                selectedBlockId={selectedBlockId}
                onSelect={openScheduleDrawer}
                onUpdateTime={onUpdateTime}
              />
            )}
            {calendarMode === "month" && (
              <MonthCalendarView
                anchorDate={anchorDate}
                todayKey={todayKey}
                schedule={monthSchedule}
                onSelectDate={(dateKey) => { setAnchorDate(dateKey); setCalendarMode("today"); }}
                onSelectEvent={openScheduleDrawer}
              />
            )}
          </div>
          <ScheduleDetailDrawer
            item={selectedBlock}
            goals={goals}
            open={drawerOpen}
            onClose={closeScheduleDrawer}
            onFeedback={(id) => { closeScheduleDrawer(); onFeedback(id); }}
            onComplete={(id) => { closeScheduleDrawer(); void onComplete(id); }}
            onEdit={(id) => { closeScheduleDrawer(); onEdit(id); }}
            onDelete={(id) => { closeScheduleDrawer(); onEdit(id); }}
          />
        </div>
      </section>

      <aside className="insight-column">
        <section className="gentle-card greeting-card">
          <div className="sun-shape" aria-hidden="true"><span /></div>
          <InsightCardHeading
            kicker="此刻建议"
            source={momentRefreshing ? undefined : momentCard.source}
            generatedAt={momentRefreshing ? undefined : momentCard.generatedAt}
            showRefresh={useServerInsights}
            refreshing={momentRefreshing}
            onRefresh={() => void handleRegenerate("moment")}
          />
          <InsightRegenStatusBar state={momentRegen} onRetry={() => void handleRegenerate("moment")} />
          {!momentRefreshing && (
            <>
              <h2>{momentCard.headline}</h2>
              <p>{momentCard.judgment}</p>
              {momentExpanded && momentCard.reason && <p className="insight-reason">{momentCard.reason}</p>}
              {momentCard.nextLabel && (
                <p className="insight-next"><strong>推荐下一步：</strong>{momentCard.nextLabel}</p>
              )}
              {momentCard.kind === "exhausted" && (
                <p className="insight-exhausted">本轮候选建议已全部浏览。完成一次执行或调整日程后，系统会生成新的建议。</p>
              )}
              {momentCard.kind === "action" && momentActionLabel && (
                <div className="insight-actions">
                  <button type="button" className="primary-button compact" disabled={momentBusy} onClick={() => void handleApplyMoment()}>
                    {momentActionLabel}
                  </button>
                  {showMomentAlternate && (
                    <button type="button" className="text-link" onClick={() => void onAlternateMoment()}>换个建议</button>
                  )}
                </div>
              )}
              <InsightExpandToggle
                expanded={momentExpanded}
                hasContent={momentHasDetail}
                onToggle={() => setMomentExpanded((value) => !value)}
              />
            </>
          )}
        </section>
        <section className="gentle-card">
          <InsightCardHeading
            kicker="节奏发现"
            source={slowRefreshing ? undefined : rhythmCard.source}
            generatedAt={slowRefreshing ? undefined : rhythmCard.generatedAt}
            trailing={<Sparkles size={16} />}
            showRefresh={useServerInsights}
            refreshing={slowRefreshing}
            onRefresh={() => void handleRegenerate("slow")}
          />
          <InsightRegenStatusBar state={slowRegen} onRetry={() => void handleRegenerate("slow")} />
          {!slowRefreshing && (
            <>
              <p className="quote">“{rhythmCard.statement}”</p>
              {rhythmExpanded && rhythmCard.evidence && <p className="insight-evidence"><strong>证据：</strong>{rhythmCard.evidence}</p>}
              {rhythmExpanded && rhythmCard.impact && <p className="insight-impact">{rhythmCard.impact}</p>}
              {rhythmCard.kind === "insight" && rhythmCard.signalId && (
                <div className="insight-actions">
                  <button type="button" className="text-link" disabled={rhythmCard.preferred} onClick={() => onPreferSignal(rhythmCard.signalId!)}>
                    {rhythmCard.preferred ? "已用于下次安排" : "用于下次安排"} <ArrowRight size={14} />
                  </button>
                </div>
              )}
              <InsightExpandToggle
                expanded={rhythmExpanded}
                hasContent={rhythmHasDetail}
                onToggle={() => setRhythmExpanded((value) => !value)}
              />
            </>
          )}
        </section>
        <section className="gentle-card load-card">
          <InsightCardHeading
            kicker="本周轨道"
            source={slowRefreshing ? undefined : weeklyCard.source}
            generatedAt={slowRefreshing ? undefined : weeklyCard.generatedAt}
            trailing={slowRefreshing ? undefined : <span>{weeklyCard.statusLabel}</span>}
            showRefresh={useServerInsights}
            refreshing={slowRefreshing}
            onRefresh={() => void handleRegenerate("slow")}
          />
          <InsightRegenStatusBar state={slowRegen} onRetry={() => void handleRegenerate("slow")} />
          {!slowRefreshing && (
            <>
              <div className="load-bar"><i style={{ width: `${weeklyLoadPercent}%` }} /></div>
              <p>{weeklyCard.summary}</p>
              {weeklyExpanded && weeklyCard.suggestion && <p className="insight-suggestion">{weeklyCard.suggestion}</p>}
              <InsightExpandToggle
                expanded={weeklyExpanded}
                hasContent={weeklyHasDetail}
                onToggle={() => setWeeklyExpanded((value) => !value)}
              />
            </>
          )}
        </section>
      </aside>
    </div>
  );
}


function RoutinesView({ goals, schedule, selectedRoutineId, timezone, onSelect, onEdit, onQuickSave, onFeedback, onAskAgent }: { goals: Goal[]; schedule: ScheduleItem[]; selectedRoutineId: string | null; timezone: string; onSelect: (id: string) => void; onEdit: (id: string) => void; onQuickSave: (routine: NonNullable<Goal["routines"]>[number], patch: { startDate: string; endDate: string | null; status: "active" | "paused" }) => Promise<void>; onFeedback: (id: string) => void; onAskAgent: () => void }) {
  const routines = goals.flatMap((goal) => (goal.routines ?? []).map((routine) => ({ routine, goal })));
  const selected = routines.find(({ routine }) => routine.id === selectedRoutineId) ?? routines[0];
  return <div className="routine-page-grid">
    <section className="routine-list-panel">
      <div className="section-heading"><div><span className="section-kicker">持续中的节奏</span><h2>不是打卡，是逐渐变得自然</h2></div><span className="quiet-count">{routines.filter(({ routine }) => routine.status === "active").length} 个进行中</span></div>
      <div className="routine-card-list">{routines.map(({ routine, goal }) => {
        const occurrences = schedule.filter((item) => item.routineId === routine.id).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
        const completed = occurrences.filter((item) => item.status === "completed").length;
        const decided = occurrences.filter((item) => item.status !== "planned").length;
        const rate = decided ? Math.round(completed / decided * 100) : 0;
        const recent = occurrences.slice(0, 7).reverse();
        return <button type="button" className={clsx("routine-card", selected?.routine.id === routine.id && "active")} key={routine.id} onClick={() => onSelect(routine.id)}>
          <div className="routine-card-top"><span className="routine-loop">↻</span><div><strong>{routine.title}</strong><small>{recurrenceLabel(routine.recurrenceRule)} · {routine.durationMinutes} 分钟 · {preferredWindowLabel(routine.preferredTimeOfDay, routine.preferredStartTime, routine.preferredEndTime)}</small></div><em>{routine.status === "active" ? "进行中" : routine.status === "paused" ? "已暂停" : "已结束"}</em></div>
          <p>关联目标：{goal.title}</p>
          <div className="routine-card-bottom"><div className="routine-dots">{recent.length ? recent.map((item) => <i key={item.id} className={item.status} title={`${item.date} ${scheduleStatusLabel(item.status)}`} />) : <span>执行后会在这里形成节奏轨迹</span>}</div><strong>{rate}%</strong><span>近期完成率</span></div>
        </button>;
      })}{!routines.length && <div className="entity-empty">还没有 Routine。创建一个足够小、愿意长期重复的行动。</div>}</div>
    </section>
    <aside className="routine-detail-panel">{selected ? <RoutineDetail key={`${selected.routine.id}:${selected.routine.version}`} routine={selected.routine} goal={selected.goal} schedule={schedule} timezone={timezone} onEdit={() => onEdit(selected.routine.id)} onQuickSave={onQuickSave} onFeedback={onFeedback} onAskAgent={onAskAgent} /> : <section className="gentle-card"><Leaf size={20} /><h3>先从一个很小的重复开始</h3><p>Routine 会按日历范围动态出现，不会制造一长串重复任务。</p></section>}</aside>
  </div>;
}

function RoutineDetail({ routine, goal, schedule, timezone, onEdit, onQuickSave, onFeedback, onAskAgent }: { routine: NonNullable<Goal["routines"]>[number]; goal: Goal; schedule: ScheduleItem[]; timezone: string; onEdit: () => void; onQuickSave: (routine: NonNullable<Goal["routines"]>[number], patch: { startDate: string; endDate: string | null; status: "active" | "paused" }) => Promise<void>; onFeedback: (id: string) => void; onAskAgent: () => void }) {
  const [startDate, setStartDate] = useState(dateInputInTimezone(routine.startDate, timezone) || currentDateKey());
  const [endDate, setEndDate] = useState(dateInputInTimezone(routine.endDate, timezone));
  const [enabled, setEnabled] = useState(routine.status === "active");
  const [savingQuick, setSavingQuick] = useState(false);
  const [quickError, setQuickError] = useState<string | null>(null);
  const occurrences = schedule.filter((item) => item.routineId === routine.id).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  const decided = occurrences.filter((item) => item.status !== "planned");
  const completed = occurrences.filter((item) => item.status === "completed");
  const rate = decided.length ? Math.round(completed.length / decided.length * 100) : 0;
  let streak = 0; for (const item of decided) { if (item.status !== "completed") break; streak += 1; }
  const next = occurrences.filter((item) => item.status === "planned").sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))[0];
  const visiblePlanned = occurrences.filter((item) => item.status === "planned").length;
  const dirty = startDate !== (dateInputInTimezone(routine.startDate, timezone) || currentDateKey()) || endDate !== dateInputInTimezone(routine.endDate, timezone) || enabled !== (routine.status === "active");
  async function submitQuick(event: FormEvent) {
    event.preventDefault();
    if (endDate && endDate < startDate) { setQuickError("结束日期不能早于开始日期。"); return; }
    setSavingQuick(true); setQuickError(null);
    try {
      await onQuickSave(routine, { startDate, endDate: endDate || null, status: enabled ? "active" : "paused" });
    } catch (caught) {
      setQuickError(caught instanceof Error ? caught.message : "快捷设置没有保存成功。");
    } finally {
      setSavingQuick(false);
    }
  }
  return <div className="routine-detail-stack">
    <section className="routine-hero-card"><div className="routine-hero-orbit">↻</div><span className="section-kicker">{goal.title}</span><h2>{routine.title}</h2><p>{routine.description || "每一次都可以很小，稳定比完美更重要。"}</p>{routine.minimumVersion && <small>状态不佳时：{routine.minimumVersion}</small>}<div className="routine-hero-actions"><button className="soft-button small" onClick={onEdit}><Pencil size={14} />编辑规则</button><button className="primary-button small" onClick={onAskAgent}><Sparkles size={14} />请小律分析</button></div></section>
    <section className="entity-section compact routine-quick-card">
      <div className="entity-section-head"><div><span className="section-kicker">快捷操作</span><h3>有效期与开启状态</h3></div><span className={clsx("routine-state-pill", enabled && "active")}>{enabled ? "已开启" : "已暂停"}</span></div>
      <form className="routine-quick-form" onSubmit={(event) => void submitQuick(event)}>
        <label>开始日期<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required /></label>
        <label>结束日期<input type="date" min={startDate} value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
        <label className="routine-switch"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span><strong>{enabled ? "开启 Routine" : "暂停 Routine"}</strong><small>{enabled ? "后续日历会继续按规则出现" : "后续日历不再展开新的发生实例"}</small></span></label>
        <p>{enabled ? `当前窗口内还有 ${visiblePlanned} 次待发生；保存日期后会重新计算。` : "暂停不会删除已经留下的执行记录。"}</p>
        {quickError && <p className="form-error">{quickError}</p>}
        <button className="primary-button small" disabled={savingQuick || !dirty}>{savingQuick ? "保存中…" : "保存快捷设置"}</button>
      </form>
    </section>
    <section className="entity-section compact"><div className="entity-section-head"><div><span className="section-kicker">执行统计</span><h3>最近的坚持情况</h3></div></div><div className="routine-stat-grid"><div><strong>{rate}%</strong><span>近期完成率</span></div><div><strong>{streak}</strong><span>当前连续完成</span></div><div><strong>{completed.length}</strong><span>已完成次数</span></div><div><strong>{next ? `${next.date?.slice(5)} ${next.start}` : "—"}</strong><span>下一次</span></div></div></section>
    <section className="entity-section compact"><div className="entity-section-head"><div><span className="section-kicker">执行记录</span><h3>每一次都留下证据</h3></div></div><div className="routine-history">{occurrences.slice(0, 8).map((item) => <article key={item.id}><i className={item.status} /><div><strong>{item.date} · {item.start}</strong><span>{scheduleStatusLabel(item.status)}{item.execution?.note ? ` · ${item.execution.note}` : ""}</span></div>{item.status === "planned" && <button onClick={() => onFeedback(item.id)}>记录</button>}</article>)}{!occurrences.length && <p>当前时间范围内还没有发生实例。</p>}</div></section>
    <section className="routine-ai-card"><div><Sparkles size={17} /><span>小律分析</span></div><p>{decided.length ? `目前记录了 ${decided.length} 次执行，完成率 ${rate}%。继续补充“顺畅 / 有阻力”和一句原因，小律才能更可靠地判断是否该调整时段或降低门槛。` : "完成或跳过几次后，小律会结合反馈分析阻力、时间匹配和频率是否合适。"}</p><button onClick={onAskAgent}>基于记录生成调整建议 <ArrowRight size={14} /></button><small>建议不会直接修改 Routine，仍需你确认。</small></section>
  </div>;
}

function RoutineFormModal({ goals, routineId, dataMode, timezone, onClose, onSaved }: { goals: Goal[]; routineId: string | null; dataMode: "checking" | "database" | "local"; timezone: string; onClose: () => void; onSaved: (goalId: string, routine: NonNullable<Goal["routines"]>[number]) => Promise<void> }) {
  const existingPair = goals.flatMap((goal) => (goal.routines ?? []).map((routine) => ({ goal, routine }))).find((entry) => entry.routine.id === routineId);
  const existing = existingPair?.routine;
  const initialRule = parseRoutineFormRule(existing?.recurrenceRule);
  const [goalId, setGoalId] = useState(existingPair?.goal.id ?? goals[0]?.id ?? "");
  const [title, setTitle] = useState(existing?.title ?? ""); const [description, setDescription] = useState(existing?.description ?? "");
  const [startDate, setStartDate] = useState(dateInputInTimezone(existing?.startDate, timezone) || currentDateKey()); const [endDate, setEndDate] = useState(dateInputInTimezone(existing?.endDate, timezone));
  const [frequency, setFrequency] = useState(initialRule.frequency); const [weekdays, setWeekdays] = useState(initialRule.weekdays); const [interval, setInterval] = useState(initialRule.interval);
  const [time, setTime] = useState(existing?.preferredStartTime ?? initialRule.time); const [endTime] = useState(existing?.preferredEndTime ?? ""); const [minutes, setMinutes] = useState(existing?.durationMinutes ?? 20); const [priority, setPriority] = useState(existing?.priority ?? "medium"); const [displayMode, setDisplayMode] = useState(existing?.displayMode ?? "subtle"); const [minimum, setMinimum] = useState(existing?.minimumVersion ?? ""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const dayOptions = [["MO", "一"], ["TU", "二"], ["WE", "三"], ["TH", "四"], ["FR", "五"], ["SA", "六"], ["SU", "日"]] as const;
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    const recurrenceRule = buildRoutineRule(frequency, interval, weekdays, startDate, time);
    const patch = { title: title.trim(), description: description.trim() || null, recurrenceRule, startDate: zonedDateTimeToIso(startDate, "00:00", timezone), endDate: endDate ? zonedDateTimeToIso(endDate, "23:59", timezone) : null, durationMinutes: minutes, preferredStartTime: time, preferredEndTime: endTime || undefined, preferredTimeOfDay: timeOfDayFromClock(time), priority, displayMode, minimumVersion: minimum.trim() || null };
    try {
      let routine: NonNullable<Goal["routines"]>[number];
      if (dataMode === "database") routine = existing ? await workspaceApi.updateRoutine(existing.id, { ...patch, expectedVersion: existing.version }) : await workspaceApi.createRoutine(goalId, patch);
      else routine = { id: existing?.id ?? crypto.randomUUID(), status: existing?.status ?? "active", version: (existing?.version ?? 0) + 1, executionRecords: existing?.executionRecords ?? [], ...patch };
      await onSaved(goalId, routine);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Routine 没有保存成功。"); } finally { setBusy(false); }
  }
  return <ModalShell title={existing ? "编辑整个 Routine" : "创建 Routine"} caption="这里只维护长期规则；日历中的发生实例会按当前范围动态出现。" onClose={onClose}><form className="form-stack" onSubmit={submit}><label>Routine 名称<input value={title} onChange={(event) => setTitle(event.target.value)} required placeholder="例如：英语口语练习" /></label><label>关联目标<select value={goalId} onChange={(event) => setGoalId(event.target.value)} disabled={Boolean(existing)}>{goals.map((goal) => <option value={goal.id} key={goal.id}>{goal.title}</option>)}</select></label><label>为什么要保持它<textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="它会怎样产生长期价值？" /></label><div className="field-row"><label>开始日期<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required /></label><label>结束日期（可选）<input type="date" min={startDate} value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label></div><div className="field-row"><label>重复方式<select value={frequency} onChange={(event) => setFrequency(event.target.value)}><option value="DAILY">每天</option><option value="WEEKLY">每周</option><option value="MONTHLY">每月</option><option value="YEARLY">每年</option></select></label><label>间隔<input type="number" min="1" max="30" value={interval} onChange={(event) => setInterval(Number(event.target.value))} /></label></div>{frequency === "WEEKLY" && <div className="weekday-picker" aria-label="选择星期">{dayOptions.map(([value, label]) => <button type="button" className={weekdays.includes(value) ? "active" : ""} key={value} onClick={() => setWeekdays((items) => items.includes(value) ? items.filter((item) => item !== value) : [...items, value])}>周{label}</button>)}</div>}<div className="field-row"><label>建议开始时间<input type="time" value={time} onChange={(event) => setTime(event.target.value)} /></label><label>执行时长（分钟）<input type="number" min="1" max="1440" value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label></div><div className="field-row"><label>优先级<select value={priority} onChange={(event) => setPriority(event.target.value)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label><label>日历显示<select value={displayMode} onChange={(event) => setDisplayMode(event.target.value)}><option value="subtle">弱化显示</option><option value="normal">正常显示</option><option value="hidden_from_calendar">从日历隐藏</option></select></label></div><label>最低可执行版本<input value={minimum} onChange={(event) => setMinimum(event.target.value)} placeholder="例如：状态差时只练 5 分钟" /></label>{error && <p className="form-error">{error}</p>}<div className="form-actions"><button type="button" className="soft-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy || !goalId || !title.trim()}>{busy ? "保存中…" : existing ? "修改整个 Routine" : "创建 Routine"}</button></div></form></ModalShell>;
}

function GoalsView({ goals, onAdd, onOpen }: { goals: Goal[]; onAdd: () => void; onOpen: (id: string) => void }) {
  return (
    <div className="goals-layout">
      <section className="goal-list-card">
        <div className="section-heading"><div><span className="section-kicker">方向层</span><h2>重要的事，正在怎样发生</h2></div><span className="quiet-count">{goals.length} 个目标</span></div>
        <div className="goal-list">
          {goals.map((goal) => {
            const progress = goal.tasksTotal ? Math.round((goal.tasksDone / goal.tasksTotal) * 100) : 0;
            return (
              <article className="goal-row" key={goal.id}>
                <button type="button" className="goal-row-open" onClick={() => onOpen(goal.id)} aria-label={`查看目标详情：${goal.title}`}>
                  <div className={`goal-symbol ${goal.color}`}><Flag size={18} /></div>
                  <div className="goal-copy"><div className="goal-title-line"><h3>{goal.title}</h3><span className={clsx("status-pill", goal.status)}>{goal.status === "active" ? "推进中" : goal.status === "draft" ? "待澄清" : "已暂停"}</span></div><p>{goal.description}</p><div className="goal-stats"><span>本周 {minutesToText(goal.completedMinutes)}</span><span>{goal.tasksDone}/{goal.tasksTotal || "—"} 个任务</span></div></div>
                  <div className="goal-progress"><strong>{progress}%</strong><div><i style={{ width: `${progress}%` }} /></div></div>
                  <span className="goal-row-chevron" aria-hidden="true"><ChevronRight size={19} /></span>
                </button>
              </article>
            );
          })}
        </div>
        <button className="empty-action" onClick={onAdd}><Plus size={18} /><span><strong>开始一个新目标</strong><small>先写下方向，细节可以和小律一起弄清楚。</small></span></button>
      </section>
      <aside className="goal-aside">
        <section className="gentle-card"><span className="section-kicker">待你确认</span><h3>里程碑 1 可能已经完成</h3><p>数据库与开发规格已经明确。小律建议你检查是否可以进入实现阶段。</p><div className="button-row"><button className="primary-button small">去确认</button><button className="soft-button small">稍后</button></div></section>
        <section className="gentle-card"><span className="section-kicker">本周投入</span><div className="big-time">8<small>h</small>30<small>m</small></div><p>其中 69% 投入在 Rhythm & Routine MVP。</p></section>
      </aside>
    </div>
  );
}

function GoalDetailView({ goal, schedule, reviews, rhythmSignals, onOpenTask, onAddTask, onEditTask, onDeleteTask, onArrange, onAskAgent }: { goal: Goal; schedule: ScheduleItem[]; reviews: ReviewRecord[]; rhythmSignals: RhythmSignalRecord[]; onOpenTask: (taskId: string) => void; onAddTask: () => void; onEditTask: (taskId: string) => void; onDeleteTask: (taskId: string) => void; onArrange: (seed: { goalId: string; taskId?: string; routineId?: string }) => void; onAskAgent: () => void }) {
  const goalSchedule = schedule.filter((item) => scheduleBelongsToGoal(item, goal));
  const activeSchedule = goalSchedule.filter((item) => isActiveCalendarBlock(item));
  const completedBlocks = goalSchedule.filter((item) => item.status === "completed");
  const invested = completedBlocks.reduce((sum, item) => sum + scheduleInvestedMinutes(item), 0);
  const plannedMinutes = activeSchedule.reduce((sum, item) => sum + durationMinutes(item.start, item.end), 0);
  const pendingConfirmation = (goal.outcomes ?? []).filter((item) => !item.completedAt).length + (goal.milestones ?? []).filter((item) => item.status === "ready_for_review").length;
  const weekStart = startOfCurrentWeek();
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const weekSchedule = goalSchedule.filter((item) => {
    const date = new Date(`${item.date ?? currentDateKey()}T12:00:00`);
    return date >= weekStart && date < weekEnd;
  });
  const weekInvested = weekSchedule.filter((item) => item.status === "completed").reduce((sum, item) => sum + scheduleInvestedMinutes(item), 0);
  const weekCompletedCount = weekSchedule.filter((item) => item.status === "completed").length;
  const maxDayMinutes = Math.max(30, ...Array.from({ length: 7 }, (_, index) => weekSchedule.filter((item) => item.status === "completed" && weekdayIndex(item.date ?? currentDateKey()) === index).reduce((sum, item) => sum + scheduleInvestedMinutes(item), 0)));

  return (
    <div className="entity-page-grid">
      <div className="entity-page-stack">
        <section className="entity-section">
          <div className="entity-section-head">
            <div><span className="section-kicker">目标结构</span><h2>这个方向由什么组成</h2></div>
            <span className={clsx("status-pill", goal.status)}>{goal.status === "active" ? "推进中" : goal.status === "draft" ? "待澄清" : "已暂停"}</span>
          </div>
          <div className="goal-structure-grid">
            <article><span>结果指标 · 由你确认</span><strong>{goal.outcomes?.[0]?.description ?? "还没有结果指标"}</strong><small>{goal.outcomes?.[0]?.completedAt ? "已确认完成" : "在回顾中确认是否达成"}</small></article>
            <article><span>项目</span><strong>{goal.project || goal.title}</strong><small>{goal.category ? goalCategoryLabel(goal.category) : "混合型目标"}</small></article>
            <article><span>当前里程碑</span><strong>{goal.milestones?.find((item) => item.status !== "completed")?.title ?? "暂时没有进行中的里程碑"}</strong><small>{goal.milestones?.filter((item) => item.status === "completed").length ?? 0} 个里程碑已完成</small></article>
            <article><span>重点能力</span><strong>{goal.skill || "尚未设置"}</strong><small>通过任务与 Routine 持续积累</small></article>
          </div>
        </section>

        <section className="entity-section">
          <div className="entity-section-head">
            <div><span className="section-kicker">关联任务</span><h2>下一步具体做什么</h2><p>点击任务进入详情，或使用右侧按钮直接编辑、删除。</p></div>
            <button className="soft-button small" onClick={onAddTask}><Plus size={14} />新建任务</button>
          </div>
          <div className="detail-task-list">
            {goal.tasks?.map((task) => {
              const investedMinutes = taskInvestedMinutes(task.id, schedule);
              return (
                <div className={clsx("detail-task-row", taskStatusTone(task.status))} key={task.id}>
                  <button type="button" className="detail-task-open" onClick={() => onOpenTask(task.id)}>
                    <div>
                      <span className="task-title-line">{task.status === "completed" && <Check size={13} />}<strong>{task.title}</strong></span>
                      <span className={clsx("status-pill", task.status)}>{taskStatusLabel(task.status)}</span>
                    </div>
                    <p>{task.intent || "还没有填写任务意图。"}</p>
                    <footer>
                      <span className="task-invested-pill">已投入 {investedMinutes ? minutesToCompact(investedMinutes) : "0m"}</span>
                      <span>预计 {task.estimatedMinutes ? minutesToCompact(task.estimatedMinutes) : "待估算"}</span>
                      <span>{energyText(task.energyLevel)}</span>
                      <span>{focusText(task.focusLevel)}</span>
                      {rhythmConditionLabels(task.rhythmConditions)[0] && <span>{rhythmConditionLabels(task.rhythmConditions)[0]}</span>}
                      <ChevronRight size={15} />
                    </footer>
                  </button>
                  <div className="detail-task-row-actions">
                    <button type="button" className="icon-button compact" aria-label={`编辑 ${task.title}`} onClick={() => onEditTask(task.id)}><Pencil size={15} /></button>
                    <button type="button" className="icon-button compact danger-icon" aria-label={`删除 ${task.title}`} onClick={() => onDeleteTask(task.id)}><Trash2 size={15} /></button>
                  </div>
                </div>
              );
            })}
            {!goal.tasks?.length && <div className="entity-empty">还没有任务。点击「新建任务」添加一个能够开始的动作。</div>}
          </div>
        </section>

        <section className="entity-section">
          <div className="entity-section-head">
            <div>
              <span className="section-kicker">时间投入与日程</span>
              <h2>时间怎样进入这个目标</h2>
              <p>基于真实执行记录统计，不含已改期或已取消的日程。</p>
            </div>
            <button className="soft-button small" onClick={() => onArrange({ goalId: goal.id })}><CalendarDays size={14} />安排事情</button>
          </div>
          <div className="goal-time-summary">
            <div><strong>{minutesToCompact(invested)}</strong><span>累计真实投入</span></div>
            <div><strong>{minutesToCompact(weekInvested)}</strong><span>本周真实投入</span></div>
            <div><strong>{weekCompletedCount}/{weekSchedule.length || activeSchedule.length}</strong><span>本周完成/安排</span></div>
            <div><strong>{minutesToCompact(plannedMinutes)}</strong><span>当前计划总量</span></div>
          </div>
          <p className="goal-time-caption">本周真实投入分布</p>
          <div className="goal-time-bars">
            {[1, 2, 3, 4, 5, 6, 0].map((weekday) => {
              const minutes = weekSchedule.filter((item) => item.status === "completed" && weekdayIndex(item.date ?? currentDateKey()) === weekday).reduce((sum, item) => sum + scheduleInvestedMinutes(item), 0);
              return (
                <div key={weekday}>
                  <span>{["周日", "周一", "周二", "周三", "周四", "周五", "周六"][weekday]}</span>
                  <i><b style={{ width: `${(minutes / maxDayMinutes) * 100}%` }} /></i>
                  <em>{minutes ? minutesToCompact(minutes) : "—"}</em>
                </div>
              );
            })}
          </div>
          {!goalSchedule.length && <div className="entity-empty">这个目标还没有进入日历。</div>}
        </section>
      </div>
      <aside className="entity-side-stack">
        <section className="entity-section compact"><span className="section-kicker">本周摘要</span><div className="entity-metrics"><div><strong>{minutesToCompact(weekInvested)}</strong><span>真实投入</span></div><div><strong>{goal.tasksDone}</strong><span>完成任务</span></div><div><strong>{pendingConfirmation}</strong><span>待确认</span></div></div></section>
        <section className="entity-section compact"><div className="entity-section-head"><div><span className="section-kicker">Routine</span><h3>重复积累</h3></div></div><div className="side-entity-list">{goal.routines?.map((routine) => <article key={routine.id}><div><strong>{routine.title}</strong><span>{routine.minimumVersion || routine.recurrenceRule}</span></div><button onClick={() => onArrange({ goalId: goal.id, routineId: routine.id })}>安排</button></article>)}{!goal.routines?.length && <p>还没有 Routine。</p>}</div></section>
        <section className="entity-section compact"><div className="entity-section-head"><div><span className="section-kicker">小律建议</span><h3>从真实节奏出发</h3></div><button className="icon-button compact" onClick={onAskAgent}><Sparkles size={15} /></button></div><p className="entity-insight">{rhythmSignals[0]?.statement ?? "积累几次执行反馈后，小律会在这里解释适合这个目标的推进节奏。"}</p></section>
        <section className="entity-section compact"><span className="section-kicker">回顾历史</span><div className="side-review-list">{reviews.slice(0, 3).map((review) => <article key={review.id}><strong>{review.type === "weekly" ? "周回顾" : "日回顾"}</strong><span>{review.summary}</span></article>)}{!reviews.length && <p>还没有回顾记录。</p>}</div></section>
      </aside>
    </div>
  );
}

function TaskDetailView({ goal, task, schedule, rhythmSignals, editing, onEditingChange, onSave, onComplete, onArrange, onEditSchedule, onFeedback, onAskAgent }: {
  goal: Goal;
  task: NonNullable<Goal["tasks"]>[number];
  schedule: ScheduleItem[];
  rhythmSignals: RhythmSignalRecord[];
  editing: boolean;
  onEditingChange: (value: boolean) => void;
  onSave: (patch: TaskFormPatch) => Promise<void>;
  onComplete: () => Promise<void>;
  onArrange: () => void;
  onEditSchedule: (id: string) => void;
  onFeedback: (id: string) => void;
  onAskAgent: () => void;
}) {
  const taskSchedule = schedule.filter((item) => scheduleLinksTask(item, task.id));
  const completedRuns = taskSchedule.filter((item) => item.status === "completed");
  const investedMinutes = taskInvestedMinutes(task.id, schedule);
  const [title, setTitle] = useState(task.title);
  const [intent, setIntent] = useState(task.intent ?? "");
  const [criteria, setCriteria] = useState((task.completionCriteria ?? []).join("\n"));
  const [steps, setSteps] = useState((task.suggestedSteps ?? []).join("\n"));
  const [rhythm, setRhythm] = useState(rhythmConditionLabels(task.rhythmConditions).join("\n"));
  const [minutes, setMinutes] = useState(task.estimatedMinutes ?? 45);
  const [energy, setEnergy] = useState(task.energyLevel ?? "medium");
  const [focus, setFocus] = useState(task.focusLevel ?? "medium");
  const [milestoneId, setMilestoneId] = useState(task.milestoneId ?? "");
  const [busy, setBusy] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) return;
    const frame = window.requestAnimationFrame(() => {
      setTitle(task.title);
      setIntent(task.intent ?? "");
      setCriteria((task.completionCriteria ?? []).join("\n"));
      setSteps((task.suggestedSteps ?? []).join("\n"));
      setRhythm(rhythmConditionLabels(task.rhythmConditions).join("\n"));
      setMinutes(task.estimatedMinutes ?? 45);
      setEnergy(task.energyLevel ?? "medium");
      setFocus(task.focusLevel ?? "medium");
      setMilestoneId(task.milestoneId ?? "");
      setError(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editing, task]);

  /**
   * 保存页面内编辑的任务字段。
   * @param event - 表单提交事件
   */
  async function submitInlineEdit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({
        title: title.trim(),
        intent: intent.trim(),
        completionCriteria: lines(criteria),
        suggestedSteps: lines(steps),
        rhythmConditions: lines(rhythm),
        estimatedMinutes: minutes,
        energyLevel: energy,
        focusLevel: focus,
        milestoneId: milestoneId || undefined,
      });
      onEditingChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存没有完成。");
    } finally {
      setBusy(false);
    }
  }

  /**
   * 确认完成任务并触发 AI 完成总结。
   */
  async function submitComplete() {
    if (task.status === "completed" || completing) return;
    setCompleting(true);
    setError(null);
    try {
      await onComplete();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "任务完成没有成功。");
    } finally {
      setCompleting(false);
    }
  }

  if (editing) {
    return (
      <div className="entity-page-grid task-page-grid">
        <form className="entity-page-stack task-inline-editor" onSubmit={(event) => void submitInlineEdit(event)}>
          <section className="entity-section">
            <div className="entity-section-head">
              <div><span className="section-kicker">编辑任务</span><h2>直接修改页面内容</h2></div>
              <span className={clsx("status-pill", task.status)}>{taskStatusLabel(task.status)}</span>
            </div>
            <div className="form-stack inline-task-form">
              <label>任务名称<input value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
              <label>任务意图<textarea rows={3} value={intent} onChange={(event) => setIntent(event.target.value)} placeholder="这件事为什么能推动目标？" /></label>
              <label>完成标准<textarea rows={4} value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder="每行一条可验收结果" /></label>
              <label>建议步骤<textarea rows={4} value={steps} onChange={(event) => setSteps(event.target.value)} placeholder="每行一步" /></label>
              <label>适合的节奏条件<textarea rows={2} value={rhythm} onChange={(event) => setRhythm(event.target.value)} placeholder="每行一条" /></label>
              {goal.milestones?.length ? (
                <label>关联里程碑
                  <select value={milestoneId} onChange={(event) => setMilestoneId(event.target.value)}>
                    <option value="">不关联里程碑</option>
                    {goal.milestones.map((milestone) => <option key={milestone.id} value={milestone.id}>{milestone.title}</option>)}
                  </select>
                </label>
              ) : null}
              <div className="field-row">
                <label>预计分钟<input type="number" min={5} max={1440} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label>
                <label>所需精力<select value={energy} onChange={(event) => setEnergy(event.target.value)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
                <label>专注度<select value={focus} onChange={(event) => setFocus(event.target.value)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
              </div>
              {error && <p className="form-error">{error}</p>}
              <div className="form-actions spread">
                <button type="button" className="soft-button" onClick={() => onEditingChange(false)} disabled={busy}>取消</button>
                <button className="primary-button" disabled={busy || !title.trim()}>{busy ? "保存中…" : "保存修改"}</button>
              </div>
            </div>
          </section>
        </form>
      </div>
    );
  }

  return (
    <div className="entity-page-grid task-page-grid">
      <div className="entity-page-stack">
        <section className="entity-section task-intent">
          <div className="entity-section-head">
            <div><span className="section-kicker">任务意图</span><h2>为什么现在做这件事</h2></div>
            <span className={clsx("status-pill", task.status)}>{taskStatusLabel(task.status)}</span>
          </div>
          <p>{task.intent || `完成“${task.title}”，让自己更靠近“${goal.title}”。`}</p>
        </section>
        <section className="entity-section">
          <div className="entity-section-head">
            <div><span className="section-kicker">完成标准</span><h2>做到什么算完成</h2></div>
            {task.status !== "completed" && (
              <button type="button" className="primary-button small" disabled={completing} onClick={() => void submitComplete()}>
                <Check size={14} />{completing ? "小律总结中…" : "确认完成"}
              </button>
            )}
          </div>
          <ul className="detail-checklist">{(task.completionCriteria?.length ? task.completionCriteria : ["明确这个任务的可验收结果", "完成后记录执行结果与节奏反馈"]).map((criterion) => <li key={criterion}><span><Check size={13} /></span>{criterion}</li>)}</ul>
          {error && <p className="form-error">{error}</p>}
          {task.completionRecord && (
            <div className="task-completion-summary">
              <article>
                <span className="section-kicker">执行回顾</span>
                <p>{task.completionRecord.executionSummary}</p>
                <small>累计投入 {minutesToCompact(task.completionRecord.investedMinutes)} · {task.completionRecord.completedSessions} 次已完成安排 · {task.completionRecord.source === "ai" ? "小律总结" : "规则总结"}</small>
              </article>
              <article>
                <span className="section-kicker">完成评价</span>
                <p>{task.completionRecord.overallEvaluation}</p>
              </article>
            </div>
          )}
        </section>
        <section className="entity-section">
          <div className="entity-section-head"><div><span className="section-kicker">执行指导</span><h2>进入任务的路径</h2></div></div>
          <ol className="detail-steps">{(task.suggestedSteps?.length ? task.suggestedSteps : ["先完成最小可交付版本", "检查完成标准", "记录下一步"]).map((step, index) => <li key={step}><span>{String(index + 1).padStart(2, "0")}</span><p>{step}</p></li>)}</ol>
        </section>
        <section className="entity-section">
          <div className="entity-section-head">
            <div><span className="section-kicker">执行历史</span><h2>计划与真实发生的事</h2></div>
            <button className="soft-button small" onClick={onArrange}><Plus size={14} />再次安排</button>
          </div>
          <div className="execution-history">
            {taskSchedule.map((item) => (
              <article key={item.id}>
                <button onClick={() => onEditSchedule(item.id)}>
                  <strong>{item.date ?? currentDateKey()} · {item.start}–{item.end}</strong>
                  <span className={clsx("status-pill", item.status)}>{scheduleStatusLabel(item.status)}</span>
                </button>
                <p>计划 {minutesToCompact(durationMinutes(item.start, item.end))}{item.execution?.actualMinutes != null ? `，实际 ${minutesToCompact(item.execution.actualMinutes)}` : ""}。{item.execution?.obstacle || item.execution?.deviationReason || (item.feedback ? `节奏反馈：${feedbackLabel(item.feedback)}` : "等待执行反馈。")}</p>
                {item.status !== "completed" && <button className="history-feedback" onClick={() => onFeedback(item.id)}>记录执行</button>}
              </article>
            ))}
            {!taskSchedule.length && <div className="entity-empty">这个任务还没有安排到日历。<button onClick={onArrange}>现在安排</button></div>}
          </div>
        </section>
      </div>
      <aside className="entity-side-stack">
        <section className="entity-section compact">
          <span className="section-kicker">真实投入</span>
          <div className="task-invested-hero">
            <strong>{investedMinutes ? minutesToCompact(investedMinutes) : "0m"}</strong>
            <span>{completedRuns.length ? `来自 ${completedRuns.length} 次已完成安排` : "完成日程后会在这里累计"}</span>
          </div>
        </section>
        <section className="entity-section compact">
          <span className="section-kicker">节奏匹配</span>
          <div className="task-facts">
            <div><span>预计耗时</span><strong>{task.estimatedMinutes ? minutesToCompact(task.estimatedMinutes) : "待估算"}</strong></div>
            <div><span>所需精力</span><strong>{energyText(task.energyLevel)}</strong></div>
            <div><span>所需专注</span><strong>{focusText(task.focusLevel)}</strong></div>
            <div><span>适合条件</span><strong>{rhythmConditionLabels(task.rhythmConditions).join(" / ") || "继续观察"}</strong></div>
          </div>
        </section>
        <section className="entity-section compact">
          <div className="entity-section-head"><div><span className="section-kicker">关联日程</span><h3>{taskSchedule.length} 次安排</h3></div><button className="icon-button compact" onClick={onArrange}><Plus size={15} /></button></div>
          <div className="side-entity-list">{taskSchedule.slice(0, 4).map((item) => <article key={item.id}><button className="side-schedule-link" onClick={() => onEditSchedule(item.id)}><strong>{item.date ?? currentDateKey()} {item.start}</strong><span>{scheduleStatusLabel(item.status)}</span></button></article>)}</div>
        </section>
        <section className="entity-section compact">
          <div className="entity-section-head"><div><span className="section-kicker">小律判断</span><h3>{completedRuns.length ? "节奏正在形成" : "先从一次真实执行开始"}</h3></div><button className="icon-button compact" onClick={onAskAgent}><Sparkles size={15} /></button></div>
          <p className="entity-insight">{rhythmSignals[0]?.statement ?? (task.focusLevel === "high" ? "这是一个高专注任务，优先放到连续、不易被打断的时间窗口。" : "完成后记录一次节奏反馈，小律会据此判断任务粒度和时间匹配。")}</p>
          <button className="soft-button small full-width" onClick={onAskAgent}>让小律解释这个任务</button>
        </section>
      </aside>
    </div>
  );
}

type ReviewContentTextKey = Exclude<keyof ReviewContent, "readyForCompletionTasks">;

/** D5 评估正文的可选区块：标题、图标与取值字段一一对应；`accent` 决定卡片的强调色，无值的区块不渲染。 */
const REVIEW_CONTENT_SECTIONS: Array<{ key: ReviewContentTextKey; title: string; icon: typeof Sparkles; accent: "violet" | "sage" | "gold" | "coral" }> = [
  { key: "sessionHighlights", title: "执行亮点", icon: Sparkles, accent: "gold" },
  { key: "rhythmNotes", title: "节奏解读", icon: Leaf, accent: "sage" },
  { key: "taskProgressNotes", title: "任务进展", icon: Target, accent: "violet" },
  { key: "routineNotes", title: "Routine 坚持", icon: RotateCcw, accent: "sage" },
  { key: "goalCheckSuggestions", title: "建议检查", icon: Flag, accent: "coral" },
  { key: "nextCycleSuggestions", title: "下一步的轻量建议", icon: ArrowRight, accent: "violet" },
];

/** 依据回顾状态与是否正在生成，返回状态徽标的文案、图标与配色基调，供 hero 徽标与空态统一复用。 */
function reviewStatusMeta(status: ReviewRecord["status"] | undefined, isBusy: boolean): { label: string; icon: typeof Clock; tone: "confirmed" | "pending" | "generating" | "failed" } {
  if (isBusy) return { label: "生成中", icon: Loader2, tone: "generating" };
  if (status === "confirmed") return { label: "已确认", icon: CircleCheck, tone: "confirmed" };
  if (status === "failed") return { label: "生成失败", icon: AlertTriangle, tone: "failed" };
  return { label: "待确认", icon: Clock, tone: "pending" };
}

/**
 * 回顾正文直接面向当前用户展示，把模型偶尔生成的第三人称称谓与内部参数名转换为自然中文。
 * @param text - AI / 规则生成的回顾文案
 */
function secondPersonReviewText(text: string) {
  return text
    .replace(/该用户/g, "你")
    .replace(/这位用户/g, "你")
    .replace(/用户的/g, "你的")
    .replace(/用户/g, "你")
    .replace(/时间适配度（\s*timeFit\s*）均为[`'"]?good[`'"]?/gi, "时间安排整体比较匹配")
    .replace(/时间适配度（\s*timeFit\s*）均为[`'"]?neutral[`'"]?/gi, "时间安排整体基本匹配")
    .replace(/时间适配度（\s*timeFit\s*）均为[`'"]?poor[`'"]?/gi, "时间安排整体不太匹配")
    .replace(/质量评估分别为[`'"]?great[`'"]?和[`'"]?good[`'"]?/gi, "质量反馈从很好到较好")
    .replace(/质量评估(?:分别)?为[`'"]?great[`'"]?/gi, "质量反馈很好")
    .replace(/质量评估(?:分别)?为[`'"]?good[`'"]?/gi, "质量反馈较好")
    .replace(/质量评估(?:分别)?为[`'"]?fair[`'"]?/gi, "质量反馈一般")
    .replace(/质量评估(?:分别)?为[`'"]?poor[`'"]?/gi, "质量反馈不佳")
    .replace(/（\s*(?:timeFit|quality|comfortable|tags|status|result|feedbackTags)\s*）/gi, "")
    .replace(/[`'"]?smooth[`'"]?\s*（顺畅）?/gi, "顺畅")
    .replace(/[`'"]?resistant[`'"]?\s*（有阻力）?/gi, "有阻力")
    .replace(/[`'"]?barely_completed[`'"]?\s*（勉强完成）?/gi, "勉强完成")
    .replace(/[`'"]?high_energy[`'"]?\s*（状态很好）?/gi, "状态很好")
    .replace(/[`'"]?low_energy[`'"]?\s*（状态很差）?/gi, "状态很差")
    .replace(/[`'"]?interrupted[`'"]?\s*（被打断）?/gi, "被打断")
    .replace(/[`'"]?not_started[`'"]?\s*（没开始）?/gi, "没开始")
    .replace(/\(?\s*[`'"]?comfortable[`'"]?\s*[:=]\s*true\s*\)?/gi, "感受顺畅")
    .replace(/\(?\s*[`'"]?comfortable[`'"]?\s*[:=]\s*false\s*\)?/gi, "感受不顺畅")
    .replace(/[`'"]?timeFit[`'"]?\s*[:=]\s*[`'"]?good[`'"]?/gi, "时间匹配")
    .replace(/[`'"]?timeFit[`'"]?\s*[:=]\s*[`'"]?neutral[`'"]?/gi, "时间基本匹配")
    .replace(/[`'"]?timeFit[`'"]?\s*[:=]\s*[`'"]?poor[`'"]?/gi, "时间不太匹配")
    .replace(/[`'"]?quality[`'"]?\s*[:=]\s*[`'"]?great[`'"]?/gi, "质量很好")
    .replace(/[`'"]?quality[`'"]?\s*[:=]\s*[`'"]?good[`'"]?/gi, "质量较好")
    .replace(/[`'"]?quality[`'"]?\s*[:=]\s*[`'"]?fair[`'"]?/gi, "质量一般")
    .replace(/[`'"]?quality[`'"]?\s*[:=]\s*[`'"]?poor[`'"]?/gi, "质量不佳")
    .replace(/[`'"]great[`'"]/gi, "很好")
    .replace(/[`'"]good[`'"]/gi, "较好")
    .replace(/[`'"]fair[`'"]/gi, "一般")
    .replace(/[`'"]poor[`'"]/gi, "不佳");
}

/**
 * 渲染回顾中的结构化文本卡片，日回顾与周回顾共用视觉原语但可独立编排。
 * @param section - 区块标题、图标、强调色与正文列表
 * @param compact - 是否使用侧栏紧凑尺寸
 * @returns 有内容时返回区块卡片，否则返回 null
 */
function ReviewSectionCard({ section, compact = false }: { section: { key: string; title: string; icon: typeof Sparkles; accent: "violet" | "sage" | "gold" | "coral"; items: string[] }; compact?: boolean }) {
  if (!section.items.length) return null;
  const Icon = section.icon;
  return (
    <div className={clsx("review-section", compact && "compact", `accent-${section.accent}`)}>
      <div className="review-section-head"><Icon size={compact ? 14 : 15} /><h3>{section.title}</h3></div>
      <ul>{section.items.map((item) => <li key={item}>{secondPersonReviewText(item)}</li>)}</ul>
    </div>
  );
}

/**
 * 展示日/周回顾，并按周期类型提供独立的信息架构、确认操作与生成入口。
 * @param goals - 用于周回顾目标、里程碑与任务确认的目标树
 * @param reviews - 当前用户的回顾记录
 * @param settings - 用户时区与日、周回顾触发设置
 * @param onGenerate - 生成指定周期回顾；传入当前展示回顾以便重写同一周期
 * @param onConfirm - 确认或撤销确认回顾
 * @param onConfirmOutcome - 确认结果指标完成
 * @param onConfirmMilestone - 确认里程碑完成
 * @param onCompleteTask - 用户确认任务完成
 * @param onAskAgent - 打开小律解释入口
 * @returns 回顾页面
 */
function ReviewView({ goals, reviews, settings, onGenerate, onConfirm, onConfirmOutcome, onConfirmMilestone, onCompleteTask, onAskAgent }: { goals: Goal[]; reviews: ReviewRecord[]; settings: UserSettings; onGenerate: (type: "daily" | "weekly", current: ReviewRecord | null) => void; onConfirm: (review: ReviewRecord) => void; onConfirmOutcome: (goalId: string, outcome: NonNullable<Goal["outcomes"]>[number]) => void; onConfirmMilestone: (goalId: string, milestone: NonNullable<Goal["milestones"]>[number]) => void; onCompleteTask: (goalId: string, taskId: string) => void; onAskAgent: () => void }) {
  const [type, setType] = useState<"daily" | "weekly">("weekly");
  const latest = selectCurrentReview(reviews, type, settings);
  const periodLabel = latest ? describeReviewPeriod(type, latest.periodStart, settings.timezone) : type === "weekly" ? "上周" : "昨日";
  const metrics = latest?.metrics ?? {};
  const contentSections = latest ? REVIEW_CONTENT_SECTIONS.map((section) => ({ ...section, items: latest.content?.[section.key] ?? [] })) : [];
  const sectionByKey = new Map(contentSections.map((section) => [section.key, section]));
  const dailyDetails = (["sessionHighlights", "rhythmNotes", "nextCycleSuggestions"] as ReviewContentTextKey[]).map((key) => sectionByKey.get(key)).filter((section): section is NonNullable<typeof section> => Boolean(section?.items.length));
  const weeklyMainDetails = (["rhythmNotes", "nextCycleSuggestions"] as ReviewContentTextKey[]).map((key) => sectionByKey.get(key)).filter((section): section is NonNullable<typeof section> => Boolean(section?.items.length));
  const weeklyCalibration = (["taskProgressNotes", "routineNotes", "goalCheckSuggestions"] as ReviewContentTextKey[]).map((key) => sectionByKey.get(key)).filter((section): section is NonNullable<typeof section> => Boolean(section?.items.length));
  const nextCycle = sectionByKey.get("nextCycleSuggestions");
  if (nextCycle) nextCycle.title = type === "weekly" ? "下周建议" : "明天可以这样调整";
  const confirmationItems = type === "weekly" ? goals.flatMap((goal) => [
    ...(goal.milestones ?? []).filter((item) => item.status === "ready_for_review").map((item) => ({ kind: "milestone" as const, goal, item })),
    ...(goal.outcomes ?? []).filter((item) => !item.completedAt).map((item) => ({ kind: "outcome" as const, goal, item })),
  ]).slice(0, 6) : [];
  const readyTasks = type === "weekly" ? (latest?.content?.readyForCompletionTasks ?? []) : [];
  const isBusy = latest?.status === "generating";
  const statusMeta = reviewStatusMeta(latest?.status, isBusy);
  const smoothTotal = (metrics.smoothCount ?? 0) + (metrics.resistanceCount ?? 0);

  function generate() { onGenerate(type, latest); }

  return (
    <div className={clsx("review-page", type === "weekly" ? "review-weekly" : "review-daily")}>
      <div className="review-toolbar">
        <div className="review-tabs" role="tablist" aria-label="选择回顾周期">
          <button role="tab" aria-selected={type === "daily"} className={type === "daily" ? "active" : ""} onClick={() => setType("daily")}>日回顾</button>
          <button role="tab" aria-selected={type === "weekly"} className={type === "weekly" ? "active" : ""} onClick={() => setType("weekly")}>周回顾</button>
        </div>
        <span><CalendarDays size={14} />{type === "weekly" ? "校准一周的节奏与方向" : "轻量收好今天的执行"}</span>
      </div>

      <div className="review-page-grid">
        <div className="review-main-stack">
          <section className="review-hero">
            <div className="review-hero-top">
              <span className="review-period"><CalendarDays size={13} />{periodLabel}</span>
              {latest && <span className={clsx("review-status-pill", statusMeta.tone)}><statusMeta.icon size={11} className={statusMeta.tone === "generating" ? "spin" : ""} />{statusMeta.label}</span>}
            </div>
            <p className="review-headline">{resolveReviewHeadline(type, latest?.summary)}</p>
            <div className="review-metrics">
              <div><strong>{metrics.completed ?? 0}<small>/{metrics.total ?? 0}</small></strong><span>完成日程块</span></div>
              <div><strong>{(metrics.missed ?? 0) + (metrics.rescheduled ?? 0)}</strong><span>未完成/改期</span></div>
              <div><strong>{minutesToCompact(metrics.investedMinutes ?? 0)}</strong><span>真实投入</span></div>
              {smoothTotal > 0 && <div><strong>{metrics.smoothCount ?? 0}<small>·{metrics.resistanceCount ?? 0}</small></strong><span>顺畅·阻力</span></div>}
            </div>
          </section>

          {!latest && (
            <section className="review-empty">
              <Clock size={22} />
              <h2>{type === "weekly" ? "等待周日 23:00 自动生成" : "等待每晚 23:00 自动生成"}</h2>
              <p>也可以点击下方按钮手动生成一份{type === "weekly" ? "本周" : "今日"}回顾。</p>
            </section>
          )}

          {latest && (
            <section className={clsx("review-body", latest.status === "failed" && "review-failed")}>
              {latest.status === "failed" && <p className="review-body-note"><AlertTriangle size={13} />数据仍然安全保留，可以重新生成。</p>}
              {isBusy && <p className="review-body-note"><Loader2 size={13} className="spin" />正在整理真实执行记录…</p>}
              {latest.findings?.length > 0 && (
                <div className="review-section accent-violet">
                  <div className="review-section-head"><Lightbulb size={15} /><h3>关键发现</h3></div>
                  <ul>{latest.findings.map((finding) => <li key={finding}>{secondPersonReviewText(finding)}</li>)}</ul>
                </div>
              )}
              {latest.suggestions?.length > 0 && (
                <div className="review-section accent-gold">
                  <div className="review-section-head"><ListChecks size={15} /><h3>{type === "weekly" ? "本周建议" : "轻量建议"}</h3></div>
                  <ul>{latest.suggestions.map((suggestion) => <li key={suggestion}>{secondPersonReviewText(suggestion)}</li>)}</ul>
                </div>
              )}
              {type === "weekly" && weeklyMainDetails.map((section) => <ReviewSectionCard section={section} key={section.key} />)}
            </section>
          )}

          <section className="review-actions">
            <div className="button-row">
              {!latest || latest.status === "failed" ? (
                <button className="primary-button" onClick={generate}><RefreshCcw size={15} />{latest ? "重新生成" : "手动生成"}{type === "weekly" ? "周" : "日"}回顾</button>
              ) : (
                <>
                  {!isBusy && <button className="primary-button" onClick={() => onConfirm(latest)}>{latest.status === "confirmed" ? "撤销确认" : "确认这份回顾"}</button>}
                  <button className="soft-button" onClick={generate} disabled={isBusy}><RefreshCcw size={14} />重新生成</button>
                </>
              )}
              <button className="soft-button" onClick={onAskAgent}>请小律解释</button>
            </div>
          </section>
        </div>

        <aside className="review-side-stack">
          {type === "daily" && dailyDetails.length > 0 && (
            <section className="review-side-card">
              <div className="review-side-card-head"><span className="section-kicker">收工复盘</span><h3>今天值得带走的</h3></div>
              <div className="review-side-sections">
                {dailyDetails.map((section) => <ReviewSectionCard section={section} compact key={section.key} />)}
              </div>
            </section>
          )}

          {type === "weekly" && weeklyCalibration.length > 0 && (
            <section className="review-side-card review-calibration-card">
              <div className="review-side-card-head"><span className="section-kicker">本周校准</span><h3>行动与方向</h3><p>任务、Routine 与目标只展示汇总证据，不逐条复刻执行明细。</p></div>
              <div className="review-side-sections">
                {weeklyCalibration.map((section) => <ReviewSectionCard section={section} compact key={section.key} />)}
              </div>
            </section>
          )}

          {type === "weekly" && (confirmationItems.length > 0 || readyTasks.length > 0) && (
            <section className="review-confirmations compact">
              <div><span className="section-kicker">只由你确认</span><h3>阶段与结果</h3><p>系统只提供执行证据，不替你判断目标或任务是否达成、完成。</p></div>
              <div>
                {confirmationItems.map(({ kind, goal, item }) => <article key={item.id}><span>{kind === "milestone" ? "里程碑" : "结果指标"} · {goal.title}</span><strong>{"title" in item ? item.title : item.description}</strong><button onClick={() => kind === "milestone" ? onConfirmMilestone(goal.id, item) : onConfirmOutcome(goal.id, item)}>确认完成</button></article>)}
                {readyTasks.map((task) => <article key={task.taskId}><span>任务 · {task.goalTitle ?? ""}</span><strong>{task.title}</strong><button onClick={() => onCompleteTask(task.goalId, task.taskId)}>确认完成</button></article>)}
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * 根据回顾周期起始时间与用户时区，生成「今日/昨日」「本周/上周」等相对语义标题。
 * 与实际日期不连续时（例如跳过了一天未生成），回退为显式日期标签。
 * @param type - 回顾类型
 * @param periodStartIso - 回顾周期起始时间（ISO，UTC）
 * @param timezone - 用户时区
 */
function describeReviewPeriod(type: "daily" | "weekly", periodStartIso: string, timezone: string) {
  const periodStart = new Date(periodStartIso);
  const now = new Date();
  const dayMs = 86400000;
  const dateKey = (date: Date) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: timezone }).format(date);
  if (type === "daily") {
    const dateLabel = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", timeZone: timezone }).format(periodStart);
    const startKey = dateKey(periodStart);
    if (startKey === dateKey(now)) return `今日回顾 · ${dateLabel}`;
    if (startKey === dateKey(new Date(now.getTime() - dayMs))) return `昨日回顾 · ${dateLabel}`;
    return `${dateLabel} 回顾`;
  }
  const rangeLabel = reviewPeriodLabel(periodStart, new Date(periodStart.getTime() + 7 * dayMs));
  const thisWeekStart = startOfCurrentWeek();
  const lastWeekStart = new Date(thisWeekStart); lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const startKey = dateKey(periodStart);
  if (startKey === dateKey(thisWeekStart)) return `本周回顾 · ${rangeLabel}`;
  if (startKey === dateKey(lastWeekStart)) return `上周回顾 · ${rangeLabel}`;
  return `${rangeLabel} 回顾`;
}

function SettingsView({ providers, provider, model, settings, onSave }: { providers: ModelProviderInfo[]; provider: string; model: string; settings: UserSettings; onSave: (provider: string, model: string, settings: UserSettings) => Promise<void> }) {
  const [selected, setSelected] = useState(provider); const [modelId, setModelId] = useState(model);
  const [timezone, setTimezone] = useState(settings.timezone); const [dailyTime, setDailyTime] = useState(settings.dailyReviewTime); const [weeklyDay, setWeeklyDay] = useState(settings.weeklyReviewDay); const [weeklyTime, setWeeklyTime] = useState(settings.weeklyReviewTime); const [saving, setSaving] = useState(false);
  const current = providers.find((item) => item.id === selected);
  function choose(next: string) { setSelected(next); const info = providers.find((item) => item.id === next); if (info) setModelId(info.model); }
  async function save() { setSaving(true); try { await onSave(selected, modelId, { timezone, dailyReviewTime: dailyTime, weeklyReviewDay: weeklyDay, weeklyReviewTime: weeklyTime, defaultModel: modelId }); } finally { setSaving(false); } }
  return <div className="settings-layout"><section className="settings-card"><div className="section-heading"><div><span className="section-kicker">小律的大脑</span><h2>模型与回顾偏好</h2></div><span className={clsx("provider-state", current?.enabled && "ready")}>{current?.enabled ? "已配置" : "等待 API Key"}</span></div><div className="form-stack"><label>供应商<select value={selected} onChange={(event) => choose(event.target.value)}>{providers.map((item) => <option key={item.id} value={item.id}>{item.label}{item.enabled ? " · 已配置" : ""}</option>)}</select></label><label>模型 ID<input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="供应商模型名称" /></label><div className="provider-endpoint"><span>服务地址</span><code>{current?.baseUrl ?? "读取中…"}</code></div>{!current?.enabled && <div className="form-note"><Settings size={16} /><span>在项目 `.env` 中填写对应 API Key，重启应用后即可调用。密钥不会发送到浏览器。</span></div>}<div className="settings-divider" /><label>时区<select value={timezone} onChange={(event) => setTimezone(event.target.value)}><option value="Asia/Shanghai">Asia/Shanghai</option><option value="Asia/Tokyo">Asia/Tokyo</option><option value="Europe/London">Europe/London</option><option value="America/Los_Angeles">America/Los_Angeles</option></select></label><div className="field-row"><label>日回顾时间<input type="time" value={dailyTime} onChange={(event) => setDailyTime(event.target.value)} /></label><label>周回顾时间<input type="time" value={weeklyTime} onChange={(event) => setWeeklyTime(event.target.value)} /></label></div><label>周回顾日<select value={weeklyDay} onChange={(event) => setWeeklyDay(Number(event.target.value))}><option value={0}>星期日</option><option value={1}>星期一</option><option value={5}>星期五</option><option value={6}>星期六</option></select></label><div className="form-actions"><button className="primary-button" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存偏好"}</button></div></div></section><aside className="provider-list"><span className="section-kicker">已支持</span>{providers.map((item) => <div key={item.id}><i className={item.enabled ? "ready" : ""} /><span><strong>{item.label}</strong><small>{item.model}</small></span></div>)}</aside></div>;
}


function ModalShell({ title, caption, onClose, children }: { title: string; caption: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-layer"><button className="modal-scrim" onClick={onClose} aria-label="关闭" /><section className="modal-card"><header><div><span className="section-kicker">手动编辑</span><h2>{title}</h2><p>{caption}</p></div><button className="icon-button" aria-label="关闭弹窗" onClick={onClose}><X size={19} /></button></header>{children}</section></div>;
}

function GoalModal({ onClose, onSave }: { onClose: () => void; onSave: (goal: Goal) => void }) {
  const [title, setTitle] = useState(""); const [description, setDescription] = useState("");
  const [category, setCategory] = useState<Goal["category"]>("mixed"); const [project, setProject] = useState(""); const [skill, setSkill] = useState(""); const [targetDate, setTargetDate] = useState("");
  function submit(event: FormEvent) { event.preventDefault(); if (!title.trim()) return; onSave({ id: crypto.randomUUID(), title: title.trim(), description: description.trim(), category, project: project.trim(), skill: skill.trim(), targetDate: targetDate ? zonedDateTimeToIso(targetDate, "23:59", currentTimezone()) : undefined, status: "draft", color: "coral", weeklyMinutes: 0, completedMinutes: 0, tasksDone: 0, tasksTotal: 0 }); }
  return <ModalShell title="写下一个新目标" caption="目标保存方向与期限；项目、能力用独立字段表达，之后仍可修改。" onClose={onClose}><form className="form-stack" onSubmit={submit}><label>目标名称<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：完成一个可用的产品 MVP" required /></label><label>为什么这件事重要<textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="它会给你的生活带来什么变化？" rows={4} /></label><div className="field-row"><label>目标类型<select value={category} onChange={(e) => setCategory(e.target.value as Goal["category"])}><option value="project">项目型</option><option value="skill">能力型</option><option value="routine">Routine 型</option><option value="mixed">混合型</option></select></label><label>目标日期（可选）<input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} /></label></div>{(category === "project" || category === "mixed") && <label>关联项目<input value={project} onChange={(e) => setProject(e.target.value)} placeholder="例如：Rhythm & Routine MVP" /></label>}{(category === "skill" || category === "routine" || category === "mixed") && <label>关联能力<input value={skill} onChange={(e) => setSkill(e.target.value)} placeholder="例如：产品设计、英语口语" /></label>}<div className="form-note"><Sparkles size={16} /><span>成功标准请继续用结果指标表达，不必塞进目标说明。</span></div><div className="form-actions"><button type="button" className="soft-button" onClick={onClose}>取消</button><button className="primary-button">保存目标</button></div></form></ModalShell>;
}

type TaskFormPatch = {
  title: string;
  intent?: string;
  completionCriteria?: string[];
  suggestedSteps?: string[];
  rhythmConditions?: string[];
  estimatedMinutes?: number;
  energyLevel?: string;
  focusLevel?: string;
  milestoneId?: string;
};

/**
 * 任务创建/编辑弹窗，支持填写意图、完成标准与节奏条件。
 * @param mode - create 新建，edit 编辑已有任务
 * @param goal - 所属目标（用于里程碑选项）
 * @param task - 编辑模式下的任务数据
 * @param dataMode - 数据模式
 * @param onClose - 关闭回调
 * @param onSave - 保存回调
 * @param onDelete - 编辑模式下的删除回调
 */
function TaskFormModal({ mode, goal, task, dataMode, onClose, onSave, onDelete }: {
  mode: "create" | "edit";
  goal: Goal;
  task?: NonNullable<Goal["tasks"]>[number];
  dataMode: "checking" | "database" | "local";
  onClose: () => void;
  onSave: (patch: TaskFormPatch) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [intent, setIntent] = useState(task?.intent ?? "");
  const [criteria, setCriteria] = useState((task?.completionCriteria ?? []).join("\n"));
  const [steps, setSteps] = useState((task?.suggestedSteps ?? []).join("\n"));
  const [rhythm, setRhythm] = useState(rhythmConditionLabels(task?.rhythmConditions).join("\n"));
  const [minutes, setMinutes] = useState(task?.estimatedMinutes ?? 45);
  const [energy, setEnergy] = useState(task?.energyLevel ?? "medium");
  const [focus, setFocus] = useState(task?.focusLevel ?? "medium");
  const [milestoneId, setMilestoneId] = useState(task?.milestoneId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * 提交表单，将多行文本字段拆分为数组后保存。
   * @param event - 表单提交事件
   */
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({
        title: title.trim(),
        intent: intent.trim(),
        completionCriteria: lines(criteria),
        suggestedSteps: lines(steps),
        rhythmConditions: lines(rhythm),
        estimatedMinutes: minutes,
        energyLevel: energy,
        focusLevel: focus,
        milestoneId: milestoneId || undefined,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存没有完成。");
      setBusy(false);
    }
  }

  /**
   * 确认后删除任务。
   */
  async function handleDelete() {
    if (!onDelete || !task) return;
    if (!window.confirm(`确定删除任务「${task.title}」？关联日程仍会保留在历史中。`)) return;
    setBusy(true);
    setError(null);
    try { await onDelete(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "删除没有完成。"); setBusy(false); }
  }

  return (
    <ModalShell
      title={mode === "create" ? "新建任务" : "编辑任务"}
      caption={`${dataMode === "database" ? "已连接数据库" : "本地模式"} · 所属目标：${goal.title}`}
      onClose={onClose}
    >
      <form className="form-stack task-form-modal" onSubmit={(event) => void submit(event)}>
        <label>任务名称<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="一件清楚、可以开始的事" required /></label>
        <label>任务意图<textarea rows={2} value={intent} onChange={(event) => setIntent(event.target.value)} placeholder="这件事为什么能推动目标？" /></label>
        <label>完成标准<textarea rows={3} value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder="每行一条可验收结果" /></label>
        <label>建议步骤<textarea rows={3} value={steps} onChange={(event) => setSteps(event.target.value)} placeholder="每行一步" /></label>
        <label>适合的节奏条件<textarea rows={2} value={rhythm} onChange={(event) => setRhythm(event.target.value)} placeholder="每行一条，例如：上午、安静环境" /></label>
        {goal.milestones?.length ? (
          <label>关联里程碑
            <select value={milestoneId} onChange={(event) => setMilestoneId(event.target.value)}>
              <option value="">不关联里程碑</option>
              {goal.milestones.map((milestone) => <option key={milestone.id} value={milestone.id}>{milestone.title}</option>)}
            </select>
          </label>
        ) : null}
        <div className="field-row">
          <label>预计分钟<input type="number" min={5} max={1440} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label>
          <label>所需精力<select value={energy} onChange={(event) => setEnergy(event.target.value)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
          <label>专注度<select value={focus} onChange={(event) => setFocus(event.target.value)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="form-actions spread">
          {mode === "edit" && onDelete ? <button type="button" className="danger-button" disabled={busy} onClick={() => void handleDelete()}>删除任务</button> : <span />}
          <div>
            <button type="button" className="soft-button" onClick={onClose}>取消</button>
            <button className="primary-button" disabled={busy || !title.trim()}>{busy ? "保存中…" : mode === "create" ? "创建任务" : "保存修改"}</button>
          </div>
        </div>
      </form>
    </ModalShell>
  );
}

function GoalDetailModal({ goal, dataMode, onClose, onChanged, onLocalChange, onLocalArchive, onNotice }: {
  goal: Goal; dataMode: "checking" | "database" | "local"; onClose: () => void; onChanged: () => Promise<void>;
  onLocalChange: (goal: Goal) => void; onLocalArchive: () => void; onNotice: (message: string) => void;
}) {
  const [title, setTitle] = useState(goal.title);
  const [description, setDescription] = useState(goal.description);
  const [category, setCategory] = useState(goal.category ?? "mixed"); const [project, setProject] = useState(goal.project ?? ""); const [skill, setSkill] = useState(goal.skill ?? "");
  const [targetDate, setTargetDate] = useState(dateInputInTimezone(goal.targetDate, currentTimezone()));
  const [outcomeText, setOutcomeText] = useState("");
  const [milestoneTitle, setMilestoneTitle] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [routineTitle, setRoutineTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true); setError(null);
    try { await action(); onNotice(success); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "操作没有完成。"); }
    finally { setBusy(false); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      const normalizedTargetDate = targetDate ? zonedDateTimeToIso(targetDate, "23:59", currentTimezone()) : null;
      if (dataMode === "database" && goal.version) { await workspaceApi.updateGoal(goal.id, { title, description, category, project, skill, targetDate: normalizedTargetDate, expectedVersion: goal.version }); await onChanged(); }
      else onLocalChange({ ...goal, title, description, category: category as Goal["category"], project, skill, targetDate: normalizedTargetDate ?? undefined });
    }, "目标已保存");
  }

  async function addTask() {
    if (!taskTitle.trim()) return;
    await run(async () => {
      if (dataMode === "database") { await workspaceApi.createTask(goal.id, { title: taskTitle, estimatedMinutes: 45 }); await onChanged(); }
      else { const task = { id: crypto.randomUUID(), title: taskTitle, status: "ready", version: 1, estimatedMinutes: 45 }; onLocalChange({ ...goal, tasks: [...(goal.tasks ?? []), task], tasksTotal: goal.tasksTotal + 1 }); }
      setTaskTitle("");
    }, "任务已添加");
  }

  async function addOutcome() {
    if (!outcomeText.trim()) return;
    await run(async () => {
      if (dataMode === "database") { await workspaceApi.createOutcome(goal.id, outcomeText); await onChanged(); }
      else onLocalChange({ ...goal, outcomes: [...(goal.outcomes ?? []), { id: crypto.randomUUID(), description: outcomeText, completedAt: null, version: 1 }] });
      setOutcomeText("");
    }, "结果指标已添加");
  }

  async function saveOutcome(outcome: NonNullable<Goal["outcomes"]>[number], nextDescription: string, completed = Boolean(outcome.completedAt)) {
    await run(async () => {
      if (dataMode === "database") { await workspaceApi.updateOutcome(outcome.id, { description: nextDescription, completed, expectedVersion: outcome.version }); await onChanged(); }
      else onLocalChange({ ...goal, outcomes: (goal.outcomes ?? []).map((item) => item.id === outcome.id ? { ...item, description: nextDescription, completedAt: completed ? new Date().toISOString() : null, version: item.version + 1 } : item) });
    }, completed ? "结果指标已由你确认完成" : "结果指标已保存");
  }

  async function removeOutcome(outcome: NonNullable<Goal["outcomes"]>[number]) {
    await run(async () => {
      if (dataMode === "database") { await workspaceApi.deleteOutcome(outcome.id, outcome.version); await onChanged(); }
      else onLocalChange({ ...goal, outcomes: (goal.outcomes ?? []).filter((item) => item.id !== outcome.id) });
    }, "结果指标已删除");
  }

  async function addMilestone() {
    if (!milestoneTitle.trim()) return;
    await run(async () => {
      if (dataMode === "database") { await workspaceApi.createMilestone(goal.id, { title: milestoneTitle }); await onChanged(); }
      else onLocalChange({ ...goal, milestones: [...(goal.milestones ?? []), { id: crypto.randomUUID(), title: milestoneTitle, status: "pending", version: 1 }] });
      setMilestoneTitle("");
    }, "里程碑已添加");
  }

  async function saveMilestone(milestone: NonNullable<Goal["milestones"]>[number], nextTitle: string, status = milestone.status) {
    await run(async () => {
      if (dataMode === "database") { await workspaceApi.updateMilestone(milestone.id, { title: nextTitle, status, expectedVersion: milestone.version }); await onChanged(); }
      else onLocalChange({ ...goal, milestones: (goal.milestones ?? []).map((item) => item.id === milestone.id ? { ...item, title: nextTitle, status, version: item.version + 1 } : item) });
    }, status === "completed" ? "里程碑已由你确认完成" : "里程碑已保存");
  }

  async function archiveMilestone(milestone: NonNullable<Goal["milestones"]>[number]) {
    await run(async () => {
      if (dataMode === "database") { await workspaceApi.archiveMilestone(milestone.id, milestone.version); await onChanged(); }
      else onLocalChange({ ...goal, milestones: (goal.milestones ?? []).filter((item) => item.id !== milestone.id) });
    }, "里程碑已归档");
  }

  async function addRoutine() {
    if (!routineTitle.trim()) return;
    await run(async () => {
      if (dataMode === "database") { await workspaceApi.createRoutine(goal.id, { title: routineTitle, recurrenceRule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", startDate: zonedDateTimeToIso(currentDateKey(), "00:00", currentTimezone()), preferredStartTime: "09:00", durationMinutes: 20 }); await onChanged(); }
      else { const routine = { id: crypto.randomUUID(), title: routineTitle, status: "active", version: 1, recurrenceRule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", startDate: new Date().toISOString(), preferredStartTime: "09:00", durationMinutes: 20, displayMode: "subtle", executionRecords: [] }; onLocalChange({ ...goal, routines: [...(goal.routines ?? []), routine] }); }
      setRoutineTitle("");
    }, "Routine 已添加");
  }

  async function saveTask(task: NonNullable<Goal["tasks"]>[number], patch: Partial<NonNullable<Goal["tasks"]>[number]>) {
    await run(async () => {
      if (dataMode === "database") { await workspaceApi.updateTask(task.id, { title: patch.title, intent: patch.intent ?? undefined, completionCriteria: patch.completionCriteria ?? undefined, suggestedSteps: patch.suggestedSteps ?? undefined, estimatedMinutes: patch.estimatedMinutes ?? undefined, energyLevel: patch.energyLevel ?? undefined, focusLevel: patch.focusLevel ?? undefined, rhythmConditions: patch.rhythmConditions == null ? undefined : rhythmConditionLabels(patch.rhythmConditions), milestoneId: patch.milestoneId ?? undefined, expectedVersion: task.version }); await onChanged(); }
      else onLocalChange({ ...goal, tasks: (goal.tasks ?? []).map((item) => item.id === task.id ? { ...item, ...patch, version: item.version + 1 } : item) });
    }, "任务已保存");
  }

  async function archiveTask(task: NonNullable<Goal["tasks"]>[number]) {
    await run(async () => {
      if (dataMode === "database") { await workspaceApi.archiveTask(task.id, task.version); await onChanged(); }
      else onLocalChange({ ...goal, tasks: (goal.tasks ?? []).filter((item) => item.id !== task.id), tasksTotal: Math.max(0, goal.tasksTotal - 1), tasksDone: task.status === "completed" ? Math.max(0, goal.tasksDone - 1) : goal.tasksDone });
    }, "任务已归档");
  }

  async function saveRoutine(routine: NonNullable<Goal["routines"]>[number], patch: { title: string; recurrenceRule: string; durationMinutes: number; minimumVersion?: string }) {
    await run(async () => {
      if (dataMode === "database") { await workspaceApi.updateRoutine(routine.id, { ...patch, expectedVersion: routine.version }); await onChanged(); }
      else onLocalChange({ ...goal, routines: (goal.routines ?? []).map((item) => item.id === routine.id ? { ...item, ...patch, version: item.version + 1 } : item) });
    }, "Routine 已保存");
  }

  async function archiveRoutine(routine: NonNullable<Goal["routines"]>[number]) {
    await run(async () => {
      if (dataMode === "database") { await workspaceApi.archiveRoutine(routine.id, routine.version); await onChanged(); }
      else onLocalChange({ ...goal, routines: (goal.routines ?? []).filter((item) => item.id !== routine.id) });
    }, "Routine 已归档");
  }

  async function archive() {
    await run(async () => {
      if (dataMode === "database" && goal.version) { await workspaceApi.archiveGoal(goal.id, goal.version); await onChanged(); onClose(); }
      else onLocalArchive();
    }, "目标已归档");
  }

  return <ModalShell title="目标详情" caption="手动编辑始终可用；AI 只是帮你形成建议。" onClose={onClose}>
    <form className="form-stack" onSubmit={save}>
      <label>目标名称<input value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
      <label>目标说明<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></label>
      <div className="field-row"><label>目标类型<select value={category} onChange={(event) => setCategory(event.target.value as NonNullable<Goal["category"]>)}><option value="project">项目</option><option value="skill">能力</option><option value="routine">习惯</option><option value="mixed">混合</option></select></label><label>目标日期（可选）<input type="date" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} /></label></div>{(category === "project" || category === "mixed") && <label>所属项目<input value={project} onChange={(event) => setProject(event.target.value)} placeholder="可选" /></label>}{(category === "skill" || category === "routine" || category === "mixed") && <label>重点能力<input value={skill} onChange={(event) => setSkill(event.target.value)} placeholder="例如：产品设计、英语表达" /></label>}
      <div className="detail-section"><div className="detail-heading"><strong>结果指标</strong><span>{goal.outcomes?.length ?? 0} 个</span></div>
        <div className="mini-list">{goal.outcomes?.map((outcome) => <OutcomeRow key={outcome.id} outcome={outcome} disabled={busy} onSave={(next, completed) => saveOutcome(outcome, next, completed)} onDelete={() => removeOutcome(outcome)} />)}{!goal.outcomes?.length && <p>写下什么变化代表这个目标真正达成。</p>}</div>
        <div className="inline-create"><input value={outcomeText} onChange={(event) => setOutcomeText(event.target.value)} placeholder="添加结果指标" /><button type="button" aria-label="确认添加结果指标" onClick={addOutcome} disabled={busy}><Plus size={16} /></button></div>
      </div>
      <div className="detail-section"><div className="detail-heading"><strong>里程碑</strong><span>{goal.milestones?.length ?? 0} 个</span></div>
        <div className="mini-list">{goal.milestones?.map((milestone) => <MilestoneRow key={milestone.id} milestone={milestone} disabled={busy} onSave={(next, status) => saveMilestone(milestone, next, status)} onArchive={() => archiveMilestone(milestone)} />)}{!goal.milestones?.length && <p>用阶段节点看见自己正在靠近目标。</p>}</div>
        <div className="inline-create"><input value={milestoneTitle} onChange={(event) => setMilestoneTitle(event.target.value)} placeholder="添加里程碑" /><button type="button" aria-label="确认添加里程碑" onClick={addMilestone} disabled={busy}><Plus size={16} /></button></div>
      </div>
      <div className="detail-section"><div className="detail-heading"><strong>行动任务</strong><span>{goal.tasks?.length ?? 0} 个</span></div>
        <div className="mini-list task-detail-list">{goal.tasks?.map((task) => <TaskEditorRow key={task.id} task={task} disabled={busy} onSave={(patch) => saveTask(task, patch)} onArchive={() => archiveTask(task)} />)}{!goal.tasks?.length && <p>还没有任务。先添加一个能够开始的动作。</p>}</div>
        <div className="inline-create"><input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="添加一个任务" /><button type="button" aria-label="确认添加任务" onClick={addTask} disabled={busy}><Plus size={16} /></button></div>
      </div>
      <div className="detail-section"><div className="detail-heading"><strong>Routine</strong><span>{goal.routines?.length ?? 0} 个</span></div>
        <div className="mini-list task-detail-list">{goal.routines?.map((routine) => <RoutineEditorRow key={routine.id} routine={routine} disabled={busy} onSave={(patch) => saveRoutine(routine, patch)} onArchive={() => archiveRoutine(routine)} />)}{!goal.routines?.length && <p>还没有 Routine。适合持续重复的行动可以放在这里。</p>}</div>
        <div className="inline-create"><input value={routineTitle} onChange={(event) => setRoutineTitle(event.target.value)} placeholder="添加一个 Routine" /><button type="button" aria-label="确认添加 Routine" onClick={addRoutine} disabled={busy}><Plus size={16} /></button></div>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions spread"><button type="button" className="danger-button" onClick={archive} disabled={busy}>归档目标</button><div><button type="button" className="soft-button" onClick={onClose}>关闭</button><button className="primary-button" disabled={busy}>{busy ? "保存中…" : "保存修改"}</button></div></div>
    </form>
  </ModalShell>;
}

function RoutineEditorRow({ routine, disabled, onSave, onArchive }: { routine: NonNullable<Goal["routines"]>[number]; disabled: boolean; onSave: (patch: { title: string; recurrenceRule: string; durationMinutes: number; minimumVersion?: string }) => Promise<void>; onArchive: () => Promise<void> }) {
  const [title, setTitle] = useState(routine.title); const [rule, setRule] = useState(routine.recurrenceRule); const [minutes, setMinutes] = useState(routine.durationMinutes ?? 20); const [minimum, setMinimum] = useState(routine.minimumVersion ?? "");
  return <details className="task-editor"><summary><RefreshCcw size={14} /><span>{routine.title}</span><em>{routine.durationMinutes ? `${routine.durationMinutes}m` : "重复"}</em><ChevronRight size={14} /></summary><div><label>Routine 名称<input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>重复规则<select value={presetRule(rule)} onChange={(event) => setRule(event.target.value === "custom" ? rule : event.target.value)}><option value="FREQ=DAILY">每天</option><option value="FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR">工作日</option><option value="FREQ=WEEKLY;BYDAY=SA,SU">周末</option><option value="custom">自定义 RRULE</option></select></label><label>RRULE<input value={rule} onChange={(event) => setRule(event.target.value)} placeholder="FREQ=WEEKLY;BYDAY=TU,SA;BYHOUR=19" /></label><div className="field-row"><label>执行分钟<input type="number" min="1" max="1440" value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label><label>最低版本<input value={minimum} onChange={(event) => setMinimum(event.target.value)} placeholder="例如：只做 5 分钟" /></label></div><div className="task-editor-actions"><button type="button" className="archive-mini" disabled={disabled} onClick={() => void onArchive()}>归档 Routine</button><button type="button" disabled={disabled || !title.trim() || !rule.trim()} onClick={() => void onSave({ title: title.trim(), recurrenceRule: rule.trim(), durationMinutes: minutes, minimumVersion: minimum.trim() || undefined })}>保存 Routine</button></div></div></details>;
}

function TaskEditorRow({ task, disabled, onSave, onArchive }: { task: NonNullable<Goal["tasks"]>[number]; disabled: boolean; onSave: (patch: Partial<NonNullable<Goal["tasks"]>[number]>) => Promise<void>; onArchive: () => Promise<void> }) {
  const [title, setTitle] = useState(task.title); const [intent, setIntent] = useState(task.intent ?? ""); const [criteria, setCriteria] = useState((task.completionCriteria ?? []).join("\n")); const [steps, setSteps] = useState((task.suggestedSteps ?? []).join("\n")); const [rhythm, setRhythm] = useState(rhythmConditionLabels(task.rhythmConditions).join("\n")); const [minutes, setMinutes] = useState(task.estimatedMinutes ?? 45); const [energy, setEnergy] = useState(task.energyLevel ?? "medium"); const [focus, setFocus] = useState(task.focusLevel ?? "medium");
  return <details className="task-editor"><summary><Check size={14} /><span>{task.title}</span><em>{task.estimatedMinutes ? `${task.estimatedMinutes}m` : task.status}</em><ChevronRight size={14} /></summary><div><label>任务名称<input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>任务意图<textarea rows={2} value={intent} onChange={(event) => setIntent(event.target.value)} placeholder="这件事为什么能推动目标？" /></label><label>完成标准<textarea rows={3} value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder="每行一条" /></label><label>建议步骤<textarea rows={3} value={steps} onChange={(event) => setSteps(event.target.value)} placeholder="每行一步" /></label><label>适合的节奏条件<textarea rows={2} value={rhythm} onChange={(event) => setRhythm(event.target.value)} placeholder="每行一条，例如：上午、安静环境、精力充足" /></label><div className="field-row"><label>预计分钟<input type="number" min="5" max="1440" value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label><label>所需精力<select value={energy} onChange={(event) => setEnergy(event.target.value)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label><label>专注度<select value={focus} onChange={(event) => setFocus(event.target.value)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label></div><div className="task-editor-actions"><button type="button" className="archive-mini" disabled={disabled} onClick={() => void onArchive()}>归档任务</button><button type="button" disabled={disabled || !title.trim()} onClick={() => void onSave({ title: title.trim(), intent, completionCriteria: lines(criteria), suggestedSteps: lines(steps), rhythmConditions: lines(rhythm), estimatedMinutes: minutes, energyLevel: energy, focusLevel: focus })}>保存任务详情</button></div></div></details>;
}

function OutcomeRow({ outcome, disabled, onSave, onDelete }: { outcome: NonNullable<Goal["outcomes"]>[number]; disabled: boolean; onSave: (description: string, completed: boolean) => Promise<void>; onDelete: () => Promise<void> }) {
  const [value, setValue] = useState(outcome.description);
  const completed = Boolean(outcome.completedAt);
  return <div className={clsx("editable-work-item", completed && "confirmed-item")}><Target size={14} /><input aria-label={`编辑结果指标 ${outcome.description}`} value={value} onChange={(event) => setValue(event.target.value)} /><em>{completed ? "已确认" : "待确认"}</em><button type="button" disabled={disabled} onClick={() => void onSave(value.trim(), !completed)}>{completed ? "撤销确认" : "确认完成"}</button><button type="button" className="archive-mini" disabled={disabled} onClick={() => void onDelete()}>删除</button></div>;
}

function MilestoneRow({ milestone, disabled, onSave, onArchive }: { milestone: NonNullable<Goal["milestones"]>[number]; disabled: boolean; onSave: (title: string, status: string) => Promise<void>; onArchive: () => Promise<void> }) {
  const [value, setValue] = useState(milestone.title);
  const completed = milestone.status === "completed";
  return <div className={clsx("editable-work-item", completed && "confirmed-item")}><Flag size={14} /><input aria-label={`编辑里程碑 ${milestone.title}`} value={value} onChange={(event) => setValue(event.target.value)} /><em>{completed ? "已完成" : milestone.status === "ready_for_review" ? "待你确认" : "推进中"}</em><button type="button" disabled={disabled} onClick={() => void onSave(value.trim(), completed ? "pending" : "completed")}>{completed ? "撤销确认" : "确认完成"}</button><button type="button" className="archive-mini" disabled={disabled} onClick={() => void onArchive()}>归档</button></div>;
}

function TaskMultiSelect({ choices, value, onChange, disabled }: { choices: Array<{ id: string; title: string }>; value: string[]; onChange: (taskIds: string[]) => void; disabled?: boolean }) {
  const groupId = useId();

  /**
   * 切换某个任务的选中状态。
   * @param taskId - 被点击的任务 ID
   */
  function toggleTask(taskId: string) {
    if (disabled) return;
    if (value.includes(taskId)) onChange(value.filter((id) => id !== taskId));
    else onChange([...value, taskId]);
  }

  return (
    <div className="task-multi-select" role="group" aria-label="关联任务">
      {choices.map((choice) => {
        const inputId = `${groupId}-${choice.id}`;
        const checked = value.includes(choice.id);
        return (
          <div key={choice.id} className="task-multi-option" onClick={() => toggleTask(choice.id)}>
            <input id={inputId} type="checkbox" checked={checked} onChange={() => toggleTask(choice.id)} disabled={disabled} onClick={(event) => event.stopPropagation()} />
            <span>{choice.title}</span>
          </div>
        );
      })}
      {!choices.length && <p className="task-multi-empty">该目标下还没有任务，可先在目标详情中创建。</p>}
    </div>
  );
}

function ScheduleAddChoiceModal({ initialSelection, onClose, onChooseGoal, onChoosePersonal }: {
  initialSelection?: ScheduleTimeSeed;
  onClose: () => void;
  onChooseGoal: () => void;
  onChoosePersonal: () => void;
}) {
  const timeHint = initialSelection?.start && initialSelection?.end
    ? `${initialSelection.date ?? currentDateKey()} · ${initialSelection.start}–${initialSelection.end}`
    : initialSelection?.date ?? currentDateKey();

  return (
    <ModalShell title="添加日程" caption={`${timeHint} · 选择要标记的类型`} onClose={onClose}>
      <div className="schedule-type-choice">
        <button type="button" className="schedule-type-option personal" onClick={onChoosePersonal}>
          <strong>个人日程</strong>
          <span>会议、通勤、休息等时间占位，不关联目标或 Routine。</span>
        </button>
        <button type="button" className="schedule-type-option goal" onClick={onChooseGoal}>
          <strong>目标日程</strong>
          <span>推进某个目标或任务的具体安排，完成后可记录执行反馈。</span>
        </button>
      </div>
      <div className="form-actions"><button type="button" className="soft-button" onClick={onClose}>取消</button></div>
    </ModalShell>
  );
}

/**
 * 创建个人日程（不关联目标/任务/Routine）的简化表单弹窗。
 * @param initialSelection - 预填日期与时间段
 * @param onClose - 关闭回调
 * @param onSave - 保存回调，写入 kind 为 personal 的日程块
 */
function PersonalScheduleModal({ initialSelection, onClose, onSave }: {
  initialSelection?: ScheduleTimeSeed;
  onClose: () => void;
  onSave: (item: ScheduleItem) => void;
}) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(initialSelection?.date ?? currentDateKey());
  const [start, setStart] = useState(initialSelection?.start ?? "16:00");
  const [end, setEnd] = useState(initialSelection?.end ?? (initialSelection?.start ? formatClock(parseClock(initialSelection.start) + 60) : "17:00"));

  /**
   * 提交个人日程表单，生成无关联实体的占位块。
   * @param event - 表单提交事件
   */
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    onSave({
      id: crypto.randomUUID(),
      title: title.trim(),
      goalId: "",
      date,
      start,
      end,
      kind: "personal",
      status: "planned",
      energy: "medium",
    });
  }

  return (
    <ModalShell title="添加个人日程" caption="像普通日历一样标记占用时段，不需要关联目标。" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <label>日程名称<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：团队周会、午休、通勤" required /></label>
        <label>日期<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <div className="field-row"><label>开始<input type="time" value={start} onChange={(event) => setStart(event.target.value)} /></label><label>结束<input type="time" value={end} onChange={(event) => setEnd(event.target.value)} /></label></div>
        <div className="form-actions"><button type="button" className="soft-button" onClick={onClose}>取消</button><button className="primary-button">加入日历</button></div>
      </form>
    </ModalShell>
  );
}

function ScheduleModal({ goals, initialSelection, onClose, onSave }: { goals: Goal[]; initialSelection?: ScheduleTimeSeed; onClose: () => void; onSave: (item: ScheduleItem) => void }) {
  const initialGoalId = initialSelection?.goalId ?? goals[0]?.id ?? "";
  const initialGoal = goals.find((item) => item.id === initialGoalId);
  const arrangingRoutine = Boolean(initialSelection?.routineId);
  const initialRoutine = initialGoal?.routines?.find((item) => item.id === initialSelection?.routineId);
  const initialTaskIds = initialSelection?.taskId ? [initialSelection.taskId] : [];
  const initialTitle = initialGoal?.tasks?.find((item) => item.id === initialSelection?.taskId)?.title ?? initialRoutine?.title ?? "";
  const [goalId, setGoalId] = useState(initialGoalId);
  const goal = goals.find((item) => item.id === goalId);
  const taskChoices = (goal?.tasks ?? []).map((item) => ({ id: item.id, title: item.title }));
  const [taskIds, setTaskIds] = useState(initialTaskIds);
  const [title, setTitle] = useState(initialTitle);
  const [date, setDate] = useState(initialSelection?.date ?? currentDateKey());
  const [start, setStart] = useState(initialSelection?.start ?? "16:00");
  const [end, setEnd] = useState(initialSelection?.end ?? (initialSelection?.start ? formatClock(parseClock(initialSelection.start) + 60) : "17:00"));

  /**
   * 更新关联任务列表，并在只选中一个任务时同步标题。
   * @param nextTaskIds - 新的任务 ID 列表
   */
  function updateTaskIds(nextTaskIds: string[]) {
    setTaskIds(nextTaskIds);
    const onlyTask = nextTaskIds.length === 1 ? taskChoices.find((item) => item.id === nextTaskIds[0]) : null;
    if (onlyTask) setTitle(onlyTask.title);
  }

  /**
   * 提交新建日程：Routine 入口保留 routine 关联，同时可关联多个任务。
   * @param event - 表单提交事件
   */
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    onSave({
      id: crypto.randomUUID(),
      title,
      goalId,
      date,
      start,
      end,
      taskId: taskIds[0],
      taskIds: taskIds.length ? taskIds : undefined,
      routineId: arrangingRoutine ? initialSelection?.routineId : undefined,
      kind: arrangingRoutine ? "routine" : "task",
      status: "planned",
      energy: "medium",
    });
  }

  return (
    <ModalShell title="安排到日历" caption={arrangingRoutine ? "为 Routine 额外安排一次时间；可同时关联多个任务，完成后会写入各任务的执行历史。" : "手动添加的日程可关联多个任务；Routine 会按重复规则自动出现在日历。"} onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <label>关联目标<select value={goalId} onChange={(event) => { setGoalId(event.target.value); setTaskIds([]); setTitle(""); }} disabled={arrangingRoutine}>{goals.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        {arrangingRoutine && (
          <label>来源 Routine<input value={initialRoutine?.title ?? "Routine"} readOnly /></label>
        )}
        <div className="form-field">
          <span className="form-field-label">关联任务（可多选）</span>
          <TaskMultiSelect choices={taskChoices} value={taskIds} onChange={updateTaskIds} />
        </div>
        <label>要做什么<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="一件清楚、可以开始的事" required /></label>
        <label>日期<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <div className="field-row"><label>开始<input type="time" value={start} onChange={(event) => setStart(event.target.value)} /></label><label>结束<input type="time" value={end} onChange={(event) => setEnd(event.target.value)} /></label></div>
        <div className="form-actions"><button type="button" className="soft-button" onClick={onClose}>取消</button><button className="primary-button">加入日程</button></div>
      </form>
    </ModalShell>
  );
}

function ScheduleEditModal({ item, dataMode, goals, onClose, onSave, onDelete }: {
  item: ScheduleItem; dataMode: "checking" | "database" | "local"; goals: Goal[];
  onClose: () => void; onSave: (item: ScheduleItem, reason: string) => Promise<void>; onDelete: () => Promise<void>;
}) {
  const [title, setTitle] = useState(item.title);
  const [date, setDate] = useState(item.date ?? currentDateKey());
  const [start, setStart] = useState(item.start);
  const [end, setEnd] = useState(item.end);
  const [reason, setReason] = useState(item.changeReason ?? "");
  const [goalId, setGoalId] = useState(item.goalId ?? "");
  const [taskIds, setTaskIds] = useState(() => resolveScheduleTaskIds(item));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedGoal = goals.find((g) => g.id === goalId);
  const taskChoices = (selectedGoal?.tasks ?? []).map((t) => ({ id: t.id, title: t.title }));
  const linkedRoutine = selectedGoal?.routines?.find((r) => r.id === item.routineId);

  /**
   * 切换关联目标时清空已选任务。
   * @param nextGoalId - 新选中的目标 ID
   */
  function handleGoalChange(nextGoalId: string) {
    setGoalId(nextGoalId);
    setTaskIds([]);
  }

  /**
   * 封装异步操作，统一处理 busy + error 状态。
   * @param action - 要执行的异步操作
   */
  async function execute(action: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await action(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "操作没有完成。"); }
    finally { setBusy(false); }
  }

  /**
   * 组装编辑后的日程块，保留 Routine 来源并写入多任务关联。
   */
  function buildUpdatedItem(): ScheduleItem {
    return {
      ...item, title, date, start, end,
      goalId: goalId || item.goalId,
      taskId: taskIds[0],
      taskIds: taskIds.length ? taskIds : undefined,
      routineId: item.routineId,
      kind: item.routineId ? "routine" : (!goalId && !taskIds.length) ? "personal" : "task",
    };
  }

  return (
    <ModalShell title="移动或编辑日程" caption={`${dataMode === "database" ? "数据库已连接" : "本地模式"} · 改期会保留原时间和原因`} onClose={onClose}>
      <form className="form-stack" onSubmit={(event) => { event.preventDefault(); void execute(() => onSave(buildUpdatedItem(), reason)); }}>
        <label>名称<input value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
        <label>关联目标
          <select value={goalId} onChange={(event) => handleGoalChange(event.target.value)}>
            <option value="">不关联目标</option>
            {goals.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
          </select>
        </label>
        {goalId && item.routineId && linkedRoutine && (
          <label>来源 Routine<input value={linkedRoutine.title} readOnly /></label>
        )}
        {goalId && (
          <div className="form-field">
            <span className="form-field-label">关联任务（可多选）</span>
            <TaskMultiSelect choices={taskChoices} value={taskIds} onChange={setTaskIds} disabled={busy} />
          </div>
        )}
        <label>日期<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <div className="field-row">
          <label>开始<input type="time" value={start} onChange={(event) => setStart(event.target.value)} /></label>
          <label>结束<input type="time" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
        </div>
        <label>移动或改期原因<textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：上午临时会议，移到精力更合适的时段" /></label>
        {item.rescheduledFromId && <div className="form-note"><RefreshCcw size={16} /><span>这是一次改期后的安排，原日程仍保留在历史中。</span></div>}
        {error && <p className="form-error">{error}</p>}
        <div className="form-actions spread">
          <button type="button" className="danger-button" onClick={() => void execute(onDelete)} disabled={busy}>取消并删除</button>
          <div><button type="button" className="soft-button" onClick={onClose}>关闭</button><button className="primary-button" disabled={busy}>保存变更</button></div>
        </div>
      </form>
    </ModalShell>
  );
}

function FeedbackModal({ item, onClose, onSave }: { item: ScheduleItem; onClose: () => void; onSave: (input: { tag: string; result: "completed" | "not_completed" | "rescheduled"; actualMinutes?: number; actualStartedAt?: string; actualEndedAt?: string; quality?: string; obstacle?: string; nextAction?: string; note?: string; comfortable?: boolean; timeFit?: string }) => void }) {
  const tags = ["顺畅", "有阻力", "勉强完成", "状态很好", "状态很差", "被打断", "没开始"];
  const initialTag = feedbackLabel(item.execution?.tags?.[0] ?? item.feedback) || "顺畅";
  const [tag, setTag] = useState(initialTag); const [result, setResult] = useState<"completed" | "not_completed" | "rescheduled">((item.execution?.result as "completed" | "not_completed" | "rescheduled") ?? "completed"); const [actualMinutes, setActualMinutes] = useState(item.execution?.actualMinutes ?? durationMinutes(item.start, item.end)); const [actualStartedAt, setActualStartedAt] = useState(toLocalInput(item.execution?.actualStartedAt) || `${item.date ?? currentDateKey()}T${item.start}`); const [actualEndedAt, setActualEndedAt] = useState(toLocalInput(item.execution?.actualEndedAt) || `${item.date ?? currentDateKey()}T${item.end}`); const [quality, setQuality] = useState(item.execution?.quality ?? ""); const [obstacle, setObstacle] = useState(item.execution?.obstacle ?? ""); const [nextAction, setNextAction] = useState(item.execution?.nextAction ?? ""); const [note, setNote] = useState(item.execution?.note ?? item.execution?.deviationReason ?? ""); const [comfortable, setComfortable] = useState(item.execution?.comfortable ?? true); const [timeFit, setTimeFit] = useState(item.execution?.timeFit ?? "good");
  return <ModalShell title={item.execution ? "修正执行记录" : "这次做得怎么样？"} caption={`${item.start}–${item.end} · ${item.title}`} onClose={onClose}><div className="feedback-result"><button className={result === "completed" ? "active" : ""} onClick={() => setResult("completed")}>完成</button><button className={result === "not_completed" ? "active" : ""} onClick={() => { setResult("not_completed"); setTag("没开始"); }}>未完成</button><button className={result === "rescheduled" ? "active" : ""} onClick={() => setResult("rescheduled")}>改期</button></div><div className="feedback-grid">{tags.map((value) => <button className={tag === value ? "active" : ""} key={value} onClick={() => setTag(value)}>{value}</button>)}</div><div className="form-stack feedback-details"><div className="field-row"><label>实际开始<input type="datetime-local" value={actualStartedAt} onChange={(event) => setActualStartedAt(event.target.value)} /></label><label>实际结束<input type="datetime-local" value={actualEndedAt} onChange={(event) => setActualEndedAt(event.target.value)} /></label><label>实际耗时（分钟）<input type="number" min="0" max="1440" value={actualMinutes} onChange={(event) => setActualMinutes(Number(event.target.value))} /></label><label>完成质量<select value={quality} onChange={(event) => setQuality(event.target.value)}><option value="">未评价</option><option value="great">很好</option><option value="good">达到预期</option><option value="rough">比较粗糙</option></select></label><label>时间匹配<select value={timeFit} onChange={(event) => setTimeFit(event.target.value)}><option value="good">很合适</option><option value="neutral">一般</option><option value="poor">不合适</option></select></label></div><label>遇到的阻碍<textarea rows={2} value={obstacle} onChange={(event) => setObstacle(event.target.value)} placeholder="例如：任务入口不够清楚、被消息打断" /></label><label>下一步<textarea rows={2} value={nextAction} onChange={(event) => setNextAction(event.target.value)} placeholder="例如：先补一份接口清单，再继续实现" /></label><label className="boolean-choice"><input type="checkbox" checked={comfortable} onChange={(event) => setComfortable(event.target.checked)} />这个强度对我来说舒适</label><label>{result === "completed" ? "补充感受" : "偏差原因"}<textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="可选，写下最有用的一点" /></label><div className="form-actions"><button className="soft-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" onClick={() => onSave({ tag, result, actualMinutes, actualStartedAt, actualEndedAt, quality: quality || undefined, obstacle: obstacle || undefined, nextAction: nextAction || undefined, note, comfortable, timeFit })}>{item.execution ? "保存修正" : "保存执行反馈"}</button></div></div></ModalShell>;
}

function feedbackTag(tag: string) { return tag === "顺畅" ? "smooth" : tag === "有阻力" ? "resistant" : tag === "勉强完成" ? "barely_completed" : tag === "状态很好" ? "high_energy" : tag === "状态很差" ? "low_energy" : tag === "被打断" ? "interrupted" : "not_started"; }
function feedbackLabel(tag?: string) { return tag === "smooth" ? "顺畅" : tag === "resistant" ? "有阻力" : tag === "barely_completed" ? "勉强完成" : tag === "high_energy" ? "状态很好" : tag === "low_energy" ? "状态很差" : tag === "interrupted" ? "被打断" : tag === "not_started" ? "没开始" : tag ?? ""; }
function currentTimezone() { try { const stored = localStorage.getItem("rr.settings"); return stored ? (JSON.parse(stored) as UserSettings).timezone : "Asia/Shanghai"; } catch { return "Asia/Shanghai"; } }
function todayLabel() { return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long", timeZone: currentTimezone() }).format(new Date()).replace(/日(星期)/, "日 · $1"); }
function localDateKey(date: Date) { return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: currentTimezone() }).format(date); }
function currentDateKey() { return localDateKey(new Date()); }
function startOfCurrentWeek() { const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - ((date.getDay() + 6) % 7)); return date; }
function durationMinutes(start: string, end: string) { const [sh, sm] = start.split(":").map(Number); const [eh, em] = end.split(":").map(Number); return Math.max(0, eh * 60 + em - sh * 60 - sm); }
function minutesToCompact(minutes: number) { return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ""}` : `${minutes}m`; }
type ScheduleTimeSeed = { goalId?: string; taskId?: string; routineId?: string; date?: string; start?: string; end?: string };

/**
 * 将分钟数格式化为 HH:mm 时间字符串。
 * @param totalMinutes - 从 0:00 起算的分钟数
 */
function formatClock(totalMinutes: number) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function parseClock(value: string) { const [hours, minutes] = value.split(":").map(Number); return hours * 60 + minutes; }
function scheduleStatusLabel(status: ScheduleItem["status"]) { return status === "completed" ? "已完成" : status === "missed" ? "未完成" : status === "rescheduled" ? "已改期" : status === "cancelled" ? "已取消" : "待执行"; }

function taskStatusLabel(status: string) { return ({ draft: "草稿", ready: "待安排", scheduled: "已安排", in_progress: "进行中", completed: "已完成", blocked: "受阻", cancelled: "已取消", archived: "已归档" } as Record<string, string>)[status] ?? status; }
function taskStatusTone(status: string) { return ({ ready: "is-waiting", scheduled: "is-scheduled", in_progress: "is-active", completed: "is-completed", blocked: "is-blocked", cancelled: "is-muted", archived: "is-muted" } as Record<string, string>)[status] ?? "is-waiting"; }
function energyText(value?: string | null) { return value === "high" ? "高精力" : value === "low" ? "低精力" : "中等精力"; }
function focusText(value?: string | null) { return value === "high" ? "高专注" : value === "low" ? "低专注" : "中专注"; }
function rhythmConditionLabels(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(rhythmConditionLabels);
  if (typeof value !== "object") return [];
  const condition = value as { preferredTimeOfDay?: unknown; notes?: unknown };
  const timeLabel = typeof condition.preferredTimeOfDay === "string" ? ({ morning: "上午", afternoon: "下午", evening: "晚上", anytime: "任意时段" } as Record<string, string>)[condition.preferredTimeOfDay] ?? condition.preferredTimeOfDay : "";
  const notes = typeof condition.notes === "string" ? condition.notes.trim() : "";
  return [timeLabel, notes].filter(Boolean);
}
function goalCategoryLabel(value: string) { return ({ project: "项目型目标", skill: "能力型目标", routine: "Routine 型目标", mixed: "混合型目标" } as Record<string, string>)[value] ?? value; }
function weekdayIndex(date: string) { return new Date(`${date}T12:00:00`).getDay(); }
function reviewPeriodLabel(start: Date, endExclusive: Date) { const end = new Date(endExclusive); end.setDate(end.getDate() - 1); const format = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }); return `${format.format(start)}—${format.format(end)}`; }
function zonedDateTimeToIso(date: string, time: string, timezone: string) { return zonedDateTimeToUtc(date, time, timezone).toISOString(); }
function dateInputInTimezone(value: string | null | undefined, timezone: string) { if (!value) return ""; return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: timezone }).format(new Date(value)); }
function localInputToIso(value: string, timezone: string) { const [date, time] = value.split("T"); return zonedDateTimeToIso(date, time, timezone); }
function toLocalInput(value?: string | null) { if (!value) return ""; const date = new Date(value); return `${localDateKey(date)}T${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: currentTimezone() }).format(date)}`; }
function rebuildLocalRoutineOccurrences(schedule: ScheduleItem[], routine: NonNullable<Goal["routines"]>[number], goalId: string, timezone: string) {
  const today = currentDateKey();
  const kept = schedule.filter((item) => item.routineId !== routine.id || item.status !== "planned" || (item.date ?? today) < today);
  if (routine.status !== "active" || !goalId) return kept;
  const existingIds = new Set(kept.map((item) => item.id));
  const occurrences = expandLocalRoutineOccurrences(routine, goalId, timezone).filter((item) => !existingIds.has(item.id));
  return [...kept, ...occurrences].sort((a, b) => `${a.date ?? today}T${a.start}`.localeCompare(`${b.date ?? today}T${b.start}`));
}
function expandLocalRoutineOccurrences(routine: NonNullable<Goal["routines"]>[number], goalId: string, timezone: string): ScheduleItem[] {
  const rule = parseRoutineFormRule(routine.recurrenceRule);
  const startDate = dateInputInTimezone(routine.startDate, timezone) || currentDateKey();
  const today = currentDateKey();
  const from = startDate > today ? startDate : today;
  const endDate = dateInputInTimezone(routine.endDate, timezone);
  const windowEndDate = new Date(`${today}T12:00:00`);
  windowEndDate.setMonth(windowEndDate.getMonth() + 1, 7);
  const to = endDate && endDate < localDateKey(windowEndDate) ? endDate : localDateKey(windowEndDate);
  const time = routine.preferredStartTime ?? rule.time;
  const end = addMinutesToClock(time, routine.durationMinutes || 20);
  const items: ScheduleItem[] = [];
  for (const date of enumerateLocalRoutineDates(startDate, from, to, rule)) {
    items.push({
      id: `routine:${routine.id}:${date}`,
      title: routine.title,
      goalId,
      routineId: routine.id,
      date,
      occurrenceDate: zonedDateTimeToIso(date, "00:00", timezone),
      start: time,
      end,
      kind: "routine",
      status: "planned",
      energy: "medium",
      version: routine.version,
      source: "routine_occurrence",
      displayMode: routine.displayMode,
    });
  }
  return items;
}
function enumerateLocalRoutineDates(startDate: string, from: string, to: string, rule: ReturnType<typeof parseRoutineFormRule>) {
  const weekdayMap: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const start = new Date(`${startDate}T12:00:00`);
  const first = new Date(`${from}T12:00:00`);
  const last = new Date(`${to}T12:00:00`);
  const result: string[] = [];
  for (const day = new Date(start); day <= last; day.setDate(day.getDate() + 1)) {
    if (day < first) continue;
    const diffDays = Math.floor((day.getTime() - start.getTime()) / 86400000);
    const diffMonths = (day.getFullYear() - start.getFullYear()) * 12 + day.getMonth() - start.getMonth();
    const matches = rule.frequency === "DAILY"
      ? diffDays % rule.interval === 0
      : rule.frequency === "WEEKLY"
        ? Math.floor(diffDays / 7) % rule.interval === 0 && (rule.weekdays.length ? rule.weekdays.map((weekday) => weekdayMap[weekday]).includes(day.getDay()) : day.getDay() === start.getDay())
        : rule.frequency === "MONTHLY"
          ? diffMonths % rule.interval === 0 && day.getDate() === start.getDate()
          : day.getFullYear() >= start.getFullYear() && (day.getFullYear() - start.getFullYear()) % rule.interval === 0 && day.getMonth() === start.getMonth() && day.getDate() === start.getDate();
    if (matches) result.push(localDateKey(day));
  }
  return result;
}
function addMinutesToClock(time: string, minutes: number) {
  const [hour, minute] = time.split(":").map(Number);
  const total = Math.min(1439, hour * 60 + minute + minutes);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
function applyLocalChangeSet(changeSet: AgentChangeSet, goals: Goal[], schedule: ScheduleItem[], setGoals: React.Dispatch<React.SetStateAction<Goal[]>>, setSchedule: React.Dispatch<React.SetStateAction<ScheduleItem[]>>, setNotice: (message: string) => void) {
  let nextGoals = [...goals]; let nextSchedule = [...schedule]; const references = new Map<string, string>();
  for (const operation of changeSet.operations) {
    const entity = String(operation.entity ?? "").toLowerCase(); const type = String(operation.type ?? "");
    const payload = (operation.payload ?? operation.after ?? {}) as Record<string, unknown>; const entityId = String(operation.entityId ?? "");
    const resolve = (value: unknown) => references.get(String(value ?? "")) ?? String(value ?? ""); const remember = (id: string) => { const key = String(payload.clientRef ?? payload.tempId ?? ""); if (key) references.set(key, id); };
    if (type === "update" && entity.includes("goal")) {
      nextGoals = nextGoals.map((goal) => goal.id === entityId ? { ...goal, title: String(payload.title ?? goal.title), description: String(payload.description ?? goal.description), category: (payload.category ?? goal.category) as Goal["category"], status: payload.status === "active" ? "active" : goal.status, version: (goal.version ?? 1) + 1 } : goal);
    } else if (type === "create" && entity.includes("outcome")) {
      const goalId = resolve(payload.goalId ?? payload.goalRef); const outcome = { id: crypto.randomUUID(), description: String(payload.description ?? payload.title ?? "结果指标"), completedAt: null, version: 1 };
      nextGoals = nextGoals.map((goal) => goal.id === goalId ? { ...goal, outcomes: [...(goal.outcomes ?? []), outcome] } : goal); remember(outcome.id);
    } else if (type === "create" && entity.includes("milestone")) {
      const goalId = resolve(payload.goalId ?? payload.goalRef); const milestone = { id: crypto.randomUUID(), title: String(payload.title ?? "里程碑"), description: String(payload.description ?? ""), status: "pending", version: 1 };
      nextGoals = nextGoals.map((goal) => goal.id === goalId ? { ...goal, milestones: [...(goal.milestones ?? []), milestone] } : goal); remember(milestone.id);
    } else if (type === "create" && entity.includes("task")) {
      const goalId = resolve(payload.goalId ?? payload.goalRef) || nextGoals[0]?.id || ""; const task = { id: crypto.randomUUID(), title: String(payload.title ?? "小律建议的任务"), status: "ready", version: 1, milestoneId: resolve(payload.milestoneId ?? payload.milestoneRef) || undefined, intent: String(payload.intent ?? ""), completionCriteria: Array.isArray(payload.completionCriteria) ? payload.completionCriteria.map(String) : [], suggestedSteps: Array.isArray(payload.suggestedSteps) ? payload.suggestedSteps.map(String) : [], rhythmConditions: Array.isArray(payload.rhythmConditions) ? payload.rhythmConditions.map(String) : [], estimatedMinutes: Number(payload.estimatedMinutes ?? 45), energyLevel: String(payload.energyLevel ?? "medium"), focusLevel: String(payload.focusLevel ?? "medium") };
      nextGoals = nextGoals.map((goal) => goal.id === goalId ? { ...goal, tasks: [...(goal.tasks ?? []), task], tasksTotal: goal.tasksTotal + 1 } : goal);
      remember(task.id);
    } else if (type === "create" && entity.includes("routine")) {
      const goalId = resolve(payload.goalId ?? payload.goalRef) || nextGoals[0]?.id || ""; const routine = { id: crypto.randomUUID(), title: String(payload.title ?? "小律建议的 Routine"), description: String(payload.reason ?? ""), status: "active", version: 1, recurrenceRule: String(payload.recurrenceRule ?? "FREQ=DAILY"), startDate: String(payload.startDate ?? new Date().toISOString()), endDate: payload.endDate ? String(payload.endDate) : undefined, durationMinutes: Number(payload.durationMinutes ?? payload.targetMinutes ?? 20), preferredStartTime: payload.preferredStartTime ? String(payload.preferredStartTime) : undefined, preferredEndTime: payload.preferredEndTime ? String(payload.preferredEndTime) : undefined, preferredTimeOfDay: String(payload.preferredTimeOfDay ?? payload.preferredTime ?? "morning"), minimumVersion: payload.minimumVersion ? String(payload.minimumVersion) : undefined, displayMode: String(payload.displayMode ?? "subtle"), executionRecords: [] };
      nextGoals = nextGoals.map((goal) => goal.id === goalId ? { ...goal, routines: [...(goal.routines ?? []), routine] } : goal);
      remember(routine.id);
    } else if (type === "create" && (entity === "personal_schedule" || (entity.includes("schedule") && (payload.scheduleKind === "personal" || payload.blockKind === "personal")))) {
      nextSchedule.push({
        id: crypto.randomUUID(),
        title: String(payload.title ?? "个人日程"),
        goalId: "",
        date: String(payload.date ?? currentDateKey()),
        start: String(payload.start ?? "10:00"),
        end: String(payload.end ?? "11:00"),
        kind: "personal",
        status: "planned",
        energy: "medium",
        version: 1,
      });
    } else if (type === "create" && entity.includes("schedule")) {
      nextSchedule.push({ id: crypto.randomUUID(), title: String(payload.title ?? "小律建议的安排"), goalId: String(payload.goalId ?? nextGoals[0]?.id ?? ""), date: String(payload.date ?? currentDateKey()), start: String(payload.start ?? "10:00"), end: String(payload.end ?? "11:00"), kind: "task", status: "planned", energy: "medium", version: 1 });
    } else if (type === "update" && (entity === "personal_schedule" || entity.includes("schedule"))) {
      nextSchedule = nextSchedule.map((item) => item.id === entityId ? {
        ...item,
        title: String(payload.title ?? item.title),
        start: String(payload.start ?? item.start),
        end: String(payload.end ?? item.end),
        date: String(payload.date ?? item.date ?? currentDateKey()),
        kind: entity === "personal_schedule" || item.kind === "personal" ? "personal" : item.kind,
        version: (item.version ?? 1) + 1,
      } : item);
    } else if (type === "update" && entity.includes("task")) {
      nextGoals = nextGoals.map((goal) => ({ ...goal, tasks: goal.tasks?.map((task) => task.id === entityId ? { ...task, title: String(payload.title ?? task.title), version: task.version + 1 } : task) }));
    } else if (type === "archive" && (entity === "personal_schedule" || entity.includes("schedule"))) nextSchedule = nextSchedule.filter((item) => item.id !== entityId);
  }
  setGoals(nextGoals); setSchedule(nextSchedule.sort((a, b) => `${a.date ?? ""}${a.start}`.localeCompare(`${b.date ?? ""}${b.start}`))); setNotice("小律的变更草案已应用");
}
function lines(value: string) { return value.split("\n").map((item) => item.trim()).filter(Boolean); }
function presetRule(rule: string) { return ["FREQ=DAILY", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "FREQ=WEEKLY;BYDAY=SA,SU"].includes(rule) ? rule : "custom"; }
function parseRoutineFormRule(rule = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0") { const parts = Object.fromEntries(rule.split(";").map((part) => { const [key, value = ""] = part.split("="); return [key, value]; })); return { frequency: parts.FREQ ?? "DAILY", interval: Math.max(1, Number(parts.INTERVAL) || 1), weekdays: (parts.BYDAY ?? "").split(",").filter(Boolean), time: `${String(Number(parts.BYHOUR) || 9).padStart(2, "0")}:${String(Number(parts.BYMINUTE) || 0).padStart(2, "0")}` }; }
function buildRoutineRule(frequency: string, interval: number, weekdays: string[], startDate: string, time: string) { const [hour, minute] = time.split(":"); const parts = [`FREQ=${frequency}`, `INTERVAL=${Math.max(1, interval)}`]; if (frequency === "WEEKLY" && weekdays.length) parts.push(`BYDAY=${weekdays.join(",")}`); if (frequency === "MONTHLY") parts.push(`BYMONTHDAY=${Number(startDate.slice(-2))}`); parts.push(`BYHOUR=${Number(hour)}`, `BYMINUTE=${Number(minute)}`); return parts.join(";"); }
function recurrenceLabel(rule: string) { const parsed = parseRoutineFormRule(rule); const prefix = parsed.interval > 1 ? `每 ${parsed.interval} ` : "每"; if (parsed.frequency === "DAILY") return parsed.interval === 1 ? "每天" : `${prefix}天`; if (parsed.frequency === "WEEKLY") return parsed.weekdays.length ? `${prefix}周 · ${parsed.weekdays.map((day) => ({ MO: "一", TU: "二", WE: "三", TH: "四", FR: "五", SA: "六", SU: "日" } as Record<string, string>)[day]).join("/")}` : `${prefix}周`; if (parsed.frequency === "MONTHLY") return parsed.interval === 1 ? "每月" : `${prefix}月`; return parsed.interval === 1 ? "每年" : `${prefix}年`; }
function timeOfDayFromClock(time: string) { const hour = Number(time.split(":")[0]); return hour < 12 ? "morning" : hour < 18 ? "afternoon" : hour < 22 ? "evening" : "night"; }
function timeOfDayLabel(period?: string | null, time?: string | null) { return time || ({ morning: "早上", afternoon: "下午", evening: "晚上", night: "夜间" } as Record<string, string>)[period ?? ""] || "时间灵活"; }
function preferredWindowLabel(period?: string | null, start?: string | null, end?: string | null) { return start && end ? `${start}–${end}` : timeOfDayLabel(period, start); }
