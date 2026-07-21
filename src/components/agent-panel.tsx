"use client";

import {
  ArrowRight,
  CalendarDays,
  Check,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  Send,
  Sparkles,
  Square,
  Target,
  Unlink2,
  X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { AgentMarkdown } from "@/components/agent-markdown";
import { AgentProcessSteps, type AgentProcessStep } from "@/components/agent-process-steps";
import { inferCapability } from "@/agent/infer-capability";
import {
  formatChangeOperationFieldValue,
  resolveChangeOperationFields,
  resolveChangeOperationLabel,
  resolveChangeOperationTitle,
} from "@/lib/change-operation-display";
import {
  agentRunApi,
  changeSetApi,
  streamChatWithAgent,
  summarizeConversation,
  type AgentChangeSet,
  type AgentChangeSetRevision,
  type AgentStreamEvent,
  type UserSettings,
} from "@/lib/client-api";
import {
  appendMessages,
  applyConversationSummary,
  buildRulesConversationSummary,
  clearContext,
  consumeClearUndo,
  countInContextTurns,
  getActiveParentRunId,
  getContextMessages,
  getActivePendingChangeSetId,
  getConversationSummary,
  getOverflowMessagesForSummary,
  getPanelExpanded,
  getSession,
  hasUndoableClear,
  isMessageOutsideContext,
  loadMessages,
  serializeProcessSteps,
  setPanelExpanded,
  startNewSession,
  syncContextScope,
  trackPendingChangeSet,
  trackRunEnded,
  trackRunStarted,
  undoClearContext,
  untrackPendingChangeSet,
  type StoredMessage,
} from "@/lib/conversation-store";
import { newConversationNotice } from "@/lib/agent-conversation-ui";
import { resolveAgentPageGoalId } from "@/lib/agent-page-context";
import type { Goal, ScheduleItem } from "@/lib/demo-data";

type AgentView = "today" | "goals" | "goal-detail" | "task-detail" | "routines" | "review" | "settings";

type PanelMessage = StoredMessage & {
  streaming?: boolean;
  userExpandedProcess?: boolean;
};

type ChangeSetTerminal = "pending" | "applied" | "rejected";

type NewConversationConfirm = {
  hasRun: boolean;
  hasChangeSet: boolean;
};

type CleanupWarning = {
  failedRunIds: string[];
  failedChangeSetIds: string[];
};

const VIEW_LABELS: Record<AgentView, string> = {
  today: "今天",
  goals: "目标",
  "goal-detail": "目标详情",
  "task-detail": "任务详情",
  routines: "Routine",
  review: "回顾",
  settings: "设置",
};

const WELCOME_TEXT = "我会根据当前页面理解你的请求；只有在目标详情页才会自动关联该目标。想一起梳理什么？";

const CHANGE_FIELD_LABELS: Record<string, string> = {
  title: "名称",
  description: "描述",
  status: "状态",
  startsAt: "开始时间",
  endsAt: "结束时间",
  start: "开始",
  end: "结束",
  date: "日期",
  entityId: "对象",
  goalId: "关联目标",
  taskId: "关联任务",
  taskIds: "关联任务",
  routineId: "关联 Routine",
  estimatedMinutes: "预计时长(分)",
  durationMinutes: "执行时长(分)",
  targetMinutes: "执行时长(兼容旧字段)",
  recurrenceRule: "重复规则",
  category: "分类",
  energyLevel: "精力",
  focusLevel: "专注",
  intent: "任务意图",
};

/**
 * 读取用户时区偏好（localStorage）。
 */
function currentTimezone(): string {
  try {
    const stored = localStorage.getItem("rr.settings");
    return stored ? (JSON.parse(stored) as UserSettings).timezone : "Asia/Shanghai";
  } catch {
    return "Asia/Shanghai";
  }
}

/**
 * 获取当前用户时区下的日期键 YYYY-MM-DD。
 */
function currentDateKey(): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: currentTimezone(),
  }).format(new Date());
}

/**
 * 从助手正文中识别进度评估状态标记。
 * @param text - 助手回复正文
 */
function progressStatus(text: string) {
  return (["on_track", "slightly_delayed", "blocked", "needs_adjustment", "ready_for_user_review"] as const).find((status) => text.includes(status));
}

/**
 * 将进度评估状态转为中文标签。
 * @param status - 进度状态枚举值
 */
function progressStatusLabel(status: NonNullable<ReturnType<typeof progressStatus>>) {
  return ({
    on_track: "推进正常",
    slightly_delayed: "略有延迟",
    blocked: "当前受阻",
    needs_adjustment: "需要调整",
    ready_for_user_review: "等待你的阶段确认",
  })[status];
}

/**
 * 创建欢迎消息（kind=welcome，不进入模型上下文）。
 */
function buildWelcomeMessage(): StoredMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    text: WELCOME_TEXT,
    timestamp: new Date().toISOString(),
    kind: "welcome",
  };
}

/**
 * 根据当前页面与目标生成 2–3 个上下文快捷入口。
 * @param view - 当前页面
 * @param selectedGoalId - 当前选中目标 id
 * @param goals - 目标列表
 */
function buildContextPrompts(view: AgentView, selectedGoalId: string | null, goals: Goal[]): Array<{ label: string; prompt: string }> {
  const prompts: Array<{ label: string; prompt: string }> = [];
  if (selectedGoalId) {
    const goalTitle = goals.find((goal) => goal.id === selectedGoalId)?.title ?? "当前目标";
    prompts.push(
      { label: "澄清目标", prompt: `请澄清「${goalTitle}」，先问我最关键的一个问题` },
      { label: "拆解任务", prompt: `信息足够后，请把「${goalTitle}」拆成结构化规划草案` },
    );
  } else if (view === "today") {
    prompts.push({ label: "调整今晚安排", prompt: "帮我调整今晚的安排" });
  } else if (view === "review") {
    prompts.push({ label: "AI 回顾", prompt: "基于真实执行生成本周回顾" });
  } else if (view === "goals") {
    prompts.push({ label: "梳理优先级", prompt: "帮我看看当前目标里，接下来最该推进哪一件" });
  } else if (view === "routines") {
    prompts.push({ label: "Routine 调整", prompt: "根据最近的执行反馈，看看哪些 Routine 需要调整" });
  }
  if (prompts.length < 2 && view !== "today") {
    prompts.push({ label: "调整今晚安排", prompt: "帮我调整今晚的安排" });
  }
  return prompts.slice(0, 3);
}

/**
 * 比较变更前后字段，返回可读 diff 列表。
 * @param before - 变更前快照
 * @param after - 变更后快照
 * @param goals - 目标列表
 * @param schedule - 日程列表
 */
function buildChangedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  goals: Goal[],
  schedule: ScheduleItem[],
) {
  const changed: Array<{ label: string; from: string; to: string }> = [];
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of allKeys) {
    if (!CHANGE_FIELD_LABELS[key]) continue;
    const beforeVal = before[key];
    const afterVal = after[key];
    if (String(beforeVal ?? "") === String(afterVal ?? "")) continue;
    changed.push({
      label: CHANGE_FIELD_LABELS[key],
      from: formatChangeOperationFieldValue(key, beforeVal, goals, schedule),
      to: formatChangeOperationFieldValue(key, afterVal, goals, schedule),
    });
  }
  return changed;
}

/**
 * 单条变更操作预览卡片（草案确认层）。
 */
function ChangeOperationPreview({
  operation,
  index,
  selected,
  onToggle,
  goals,
  schedule,
  readOnly,
}: {
  operation: Record<string, unknown>;
  index: number;
  selected: boolean;
  onToggle: () => void;
  goals: Goal[];
  schedule: ScheduleItem[];
  readOnly?: boolean;
}) {
  const payload = (operation.payload ?? operation.after ?? {}) as Record<string, unknown>;
  const before = (operation.before ?? {}) as Record<string, unknown>;
  const label = resolveChangeOperationLabel(String(operation.entity ?? "item"), payload);
  const displayTitle = resolveChangeOperationTitle(operation, goals, schedule, index);
  const changedFields = operation.type === "update" ? buildChangedFields(before, payload, goals, schedule) : [];
  const createFields = operation.type === "create" ? resolveChangeOperationFields(operation, goals, schedule) : [];

  return (
    <article className={clsx("change-operation", !selected && !readOnly && "unselected", `entity-${label}`)}>
      <label>
        {!readOnly && <input type="checkbox" checked={selected} onChange={onToggle} />}
        <span>{label}</span>
        <strong>{displayTitle}</strong>
        <em className="op-type">
          {operation.type === "create" ? "新增" : operation.type === "update" ? "修改" : operation.type === "archive" ? "归档" : String(operation.type)}
        </em>
      </label>
      {changedFields.length > 0 && (
        <ul className="field-diff">
          {changedFields.map((field, fieldIndex) => (
            <li key={`${field.label}-${fieldIndex}`}>
              <span className="diff-label">{field.label}</span>
              <span className="diff-from">{field.from}</span>
              <ArrowRight size={10} />
              <span className="diff-to">{field.to}</span>
            </li>
          ))}
        </ul>
      )}
      {createFields.length > 0 && (
        <ul className="field-create">
          {createFields.map((field, fieldIndex) => (
            <li key={`${field.label}-${fieldIndex}`}>
              <span className="diff-label">{field.label}</span>
              <span>{field.value}</span>
            </li>
          ))}
        </ul>
      )}
      {Array.isArray(payload.completionCriteria) && (
        <ul className="criteria-list">
          {payload.completionCriteria.slice(0, 3).map((item) => (
            <li key={String(item)}>{String(item)}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

export function AgentPanel({
  open,
  onClose,
  goals,
  schedule,
  view,
  provider,
  model,
  dataMode,
  selectedGoalId,
  onApply,
  onReject,
}: {
  open: boolean;
  onClose: () => void;
  goals: Goal[];
  schedule: ScheduleItem[];
  view: AgentView;
  provider: string;
  model: string;
  dataMode: "checking" | "database" | "local";
  selectedGoalId: string | null;
  onApply: (changeSet: AgentChangeSet, indexes: number[]) => Promise<void>;
  onReject: (changeSet: AgentChangeSet) => Promise<void>;
}) {
  // 防御性收口：即使调用方错误保留了旧 selectedGoalId，非目标详情页也不允许形成隐式目标上下文。
  const contextGoalId = resolveAgentPageGoalId(view, selectedGoalId);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [changeSet, setChangeSet] = useState<AgentChangeSet | null>(null);
  const [changeSetTerminal, setChangeSetTerminal] = useState<ChangeSetTerminal>("pending");
  const [appliedCount, setAppliedCount] = useState(0);
  const [selectedOps, setSelectedOps] = useState<Set<number>>(new Set());
  const [changeSetMessageId, setChangeSetMessageId] = useState<string | null>(null);
  const [changeSetVisible, setChangeSetVisible] = useState(true);
  const [revisionHistory, setRevisionHistory] = useState<AgentChangeSetRevision[] | null>(null);
  const [revisionHistoryOpen, setRevisionHistoryOpen] = useState(false);
  const [revisionHistoryError, setRevisionHistoryError] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [confirmNew, setConfirmNew] = useState<NewConversationConfirm | null>(null);
  const [cleanupWarning, setCleanupWarning] = useState<CleanupWarning | null>(null);
  const [canUndoClear, setCanUndoClear] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activeTurnRef = useRef<HTMLDivElement>(null);
  const changeSetRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const streamingStepsRef = useRef<AgentProcessStep[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  const streamGenerationRef = useRef(0);
  const currentRunIdRef = useRef<string | null>(null);
  const prevGoalIdRef = useRef<string | null | undefined>(undefined);

  /**
   * 从 conversation-store 刷新消息列表与撤销状态。
   */
  const refreshFromStore = useCallback(() => {
    setMessages(loadMessages());
    setCanUndoClear(hasUndoableClear());
  }, []);

  /**
   * 写入欢迎态并持久化到 Session。
   */
  const seedWelcome = useCallback(() => {
    const welcome = buildWelcomeMessage();
    appendMessages([welcome]);
    setMessages([welcome]);
    setChangeSet(null);
    setChangeSetTerminal("pending");
    setChangeSetMessageId(null);
    setSelectedOps(new Set());
    setCanUndoClear(false);
  }, []);

  /**
   * 显示短暂提示（toast）。
   * @param text - 提示文案
   */
  const showToast = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  /**
   * 异步触发对话摘要（best-effort，revision 不匹配则丢弃）。
   */
  const maybeSummarizeConversation = useCallback(() => {
    if (countInContextTurns() <= 6) return;
    const payload = getOverflowMessagesForSummary();
    if (!payload.overflow.length || !payload.summarizedThroughMessageId) return;

    const { sessionId, revision, priorSummary, overflow, summarizedThroughMessageId } = payload;

    void summarizeConversation({
      sessionId,
      revision,
      priorSummary,
      messages: overflow,
    })
      .then((result) => {
        applyConversationSummary({
          sessionId: result.sessionId,
          revision: result.revision,
          summary: result.summary,
          summarizedThroughMessageId: result.summarizedThroughMessageId ?? summarizedThroughMessageId,
        });
      })
      .catch(() => {
        const fallback = buildRulesConversationSummary(overflow, priorSummary);
        applyConversationSummary({
          sessionId,
          revision,
          summary: fallback,
          summarizedThroughMessageId,
        });
      });
  }, []);

  /**
   * 取消当前 SSE 并将 running 步骤标记为 cancelled。
   * @param generation - 当前流代数，用于丢弃迟到事件
   */
  const abortStream = useCallback((generation: number) => {
    streamGenerationRef.current = generation;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setMessages((items) => {
      const next = [...items];
      const last = next[next.length - 1];
      if (last?.role === "assistant" && last.streaming) {
        const processSteps = (last.processSteps ?? []).map((step) =>
          step.status === "running" ? { ...step, status: "cancelled" as const } : step,
        );
        next[next.length - 1] = { ...last, streaming: false, processSteps };
        streamingStepsRef.current = processSteps;
      }
      return next;
    });
    setLoading(false);
    setStatusText(null);
  }, []);

  /**
   * 取消服务端 Run 并清除 Session activeRunId。
   * @param runId - AgentRun id
   */
  const cancelServerRun = useCallback(async (runId: string): Promise<boolean> => {
    try {
      await agentRunApi.cancel(runId, "user_cancelled");
      trackRunEnded(runId);
      if (currentRunIdRef.current === runId) currentRunIdRef.current = null;
      return true;
    } catch {
      return false;
    }
  }, []);

  /**
   * 停止当前处理：abort SSE + 取消 Run。
   */
  const handleStop = useCallback(async () => {
    const generation = streamGenerationRef.current + 1;
    abortStream(generation);
    const runId = currentRunIdRef.current ?? getSession().activeRunId;
    if (runId) {
      const ok = await cancelServerRun(runId);
      if (ok) showToast("已停止当前处理");
      else setCleanupWarning((prev) => ({ failedRunIds: [...new Set([...(prev?.failedRunIds ?? []), runId])], failedChangeSetIds: prev?.failedChangeSetIds ?? [] }));
    }
  }, [abortStream, cancelServerRun, showToast]);

  /**
   * 拒绝 Session 关联的 pending ChangeSet（幂等）。
   * @param ids - ChangeSet id 列表
   */
  const rejectSessionChangeSets = useCallback(async (ids: string[]) => {
    const failed: string[] = [];
    for (const id of ids) {
      try {
        await changeSetApi.decide(id, false);
        untrackPendingChangeSet(id);
      } catch {
        failed.push(id);
      }
    }
    return failed;
  }, []);

  /**
   * 重试未完成的清理（Run 取消 / 草案拒绝）。
   */
  const retryCleanup = useCallback(async () => {
    if (!cleanupWarning) return;
    const stillFailedRuns: string[] = [];
    const stillFailedCs: string[] = [];
    for (const runId of cleanupWarning.failedRunIds) {
      const ok = await cancelServerRun(runId);
      if (!ok) stillFailedRuns.push(runId);
    }
    const csFailed = await rejectSessionChangeSets(cleanupWarning.failedChangeSetIds);
    stillFailedCs.push(...csFailed);
    if (!stillFailedRuns.length && !stillFailedCs.length) {
      setCleanupWarning(null);
      showToast("清理已完成");
    } else {
      setCleanupWarning({ failedRunIds: stillFailedRuns, failedChangeSetIds: stillFailedCs });
    }
  }, [cleanupWarning, cancelServerRun, rejectSessionChangeSets, showToast]);

  /**
   * 执行新建对话：终止 Run、拒绝草案、替换 Session。
   * @param hadRun - 是否有进行中的 Run
   * @param hadChangeSet - 是否有待确认草案
   */
  const executeNewConversation = useCallback(async (hadRun: boolean, hadChangeSet: boolean) => {
    const generation = streamGenerationRef.current + 1;
    abortStream(generation);

    const session = getSession();
    const failedRuns: string[] = [];
    const failedCs: string[] = [];

    const runId = currentRunIdRef.current ?? session.activeRunId;
    if (runId) {
      const ok = await cancelServerRun(runId);
      if (!ok) failedRuns.push(runId);
    }

    const pendingIds = [...session.pendingChangeSetIds];
    if (pendingIds.length) {
      const rejectedFailed = await rejectSessionChangeSets(pendingIds);
      failedCs.push(...rejectedFailed);
    }

    startNewSession();
    seedWelcome();
    currentRunIdRef.current = null;
    setHistoryLoaded(true);
    setError(null);
    setConfirmNew(null);

    showToast(newConversationNotice(hadRun, hadChangeSet));

    if (failedRuns.length || failedCs.length) {
      setCleanupWarning({ failedRunIds: failedRuns, failedChangeSetIds: failedCs });
    }

    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [abortStream, cancelServerRun, rejectSessionChangeSets, seedWelcome, showToast]);

  /**
   * 点击「新对话」：无风险直接新建，否则弹出确认。
   */
  const handleNewConversationClick = useCallback(() => {
    const session = getSession();
    const hasRun = loading || Boolean(session.activeRunId);
    const hasChangeSet = Boolean(changeSet && changeSetTerminal === "pending");
    if (!hasRun && !hasChangeSet) {
      void executeNewConversation(false, false);
      return;
    }
    setConfirmNew({ hasRun, hasChangeSet });
  }, [loading, changeSet, changeSetTerminal, executeNewConversation]);

  /**
   * 清空上下文：插入边界消息，bump revision。
   */
  const handleClearContext = useCallback(() => {
    clearContext();
    refreshFromStore();
    showToast("上方内容已移出上下文");
  }, [refreshFromStore, showToast]);

  /**
   * 撤销尚未发送的清空边界。
   */
  const handleUndoClear = useCallback(() => {
    if (undoClearContext()) {
      refreshFromStore();
      showToast("已撤销清空上下文");
    }
  }, [refreshFromStore, showToast]);

  /**
   * 更新当前流式助手消息字段。
   * @param patch - 局部更新或更新函数
   * @param generation - 流代数，不匹配则忽略
   */
  const patchStreamingMessage = useCallback((
    patch: Partial<PanelMessage> | ((message: PanelMessage) => PanelMessage),
    generation: number,
  ) => {
    if (generation !== streamGenerationRef.current) return;
    setMessages((items) => {
      const next = [...items];
      const last = next[next.length - 1];
      if (last?.role === "assistant" && last.streaming) {
        next[next.length - 1] = typeof patch === "function" ? patch(last) : { ...last, ...patch };
      }
      return next;
    });
  }, []);

  /**
   * 更新流式助手消息的处理步骤。
   * @param updater - 步骤更新函数
   * @param generation - 流代数
   */
  const patchStreamingSteps = useCallback((
    updater: (steps: AgentProcessStep[]) => AgentProcessStep[],
    generation: number,
  ) => {
    patchStreamingMessage((message) => {
      const processSteps = updater(message.processSteps ?? []);
      streamingStepsRef.current = processSteps;
      return { ...message, processSteps };
    }, generation);
  }, [patchStreamingMessage]);

  /**
   * 处理 SSE 事件：按 toolCallId 对齐，planning 最多 1 条，跳过 final。
   * @param event - 服务端推送事件
   * @param generation - 当前流代数
   */
  const handleStreamEvent = useCallback((event: AgentStreamEvent, generation: number) => {
    if (generation !== streamGenerationRef.current) return;

    if (event.type === "status") {
      setStatusText(event.message);
      return;
    }

    if (event.type === "run_started") {
      currentRunIdRef.current = event.runId;
      trackRunStarted(event.runId);
      return;
    }

    if (event.type === "text_delta") {
      patchStreamingMessage((message) => ({ ...message, text: message.text + event.text }), generation);
      return;
    }

    if (event.type === "loop_step") {
      if (event.kind === "final") return;
      if (event.kind === "planning") {
        patchStreamingSteps((steps) => {
          if (steps.some((step) => step.label === event.label || step.id.startsWith("planning-"))) return steps;
          return [...steps, {
            id: `planning-${steps.length}`,
            label: event.label,
            status: "done",
            summary: event.summary,
            detail: event.detail,
          }];
        }, generation);
        return;
      }
      patchStreamingSteps((steps) => [...steps, {
        id: `${event.kind}-${steps.length}`,
        label: event.label,
        status: event.goalStatus === "blocked" || (event.kind === "recovery" && event.label === "工具失败恢复") ? "failed" : event.goalStatus === "awaiting_confirmation" ? "confirm" : "done",
        summary: event.summary,
        detail: event.detail,
      }], generation);
      return;
    }

    if (event.type === "tool_started") {
      const stepId = event.toolCallId ?? `${event.tool}-${Date.now()}`;
      patchStreamingSteps((steps) => {
        if (event.toolCallId) {
          const existing = steps.findIndex((step) => step.toolCallId === event.toolCallId || step.id === event.toolCallId);
          if (existing >= 0) {
            const next = [...steps];
            next[existing] = {
              ...next[existing],
              label: event.label ?? event.tool,
              status: "running",
              summary: event.summary ?? next[existing].summary,
              detail: {
                ...next[existing].detail,
                ...event.detail,
                inputSummary: event.detail?.inputSummary ?? next[existing].detail?.inputSummary,
                inputPreview: event.detail?.inputPreview ?? next[existing].detail?.inputPreview,
                rawInputJson: event.detail?.rawInputJson ?? next[existing].detail?.rawInputJson,
                toolName: event.tool,
              },
            };
            return next;
          }
        }
        return [...steps, {
          id: stepId,
          toolCallId: event.toolCallId,
          label: event.label ?? event.tool,
          status: "running",
          summary: event.summary,
          detail: {
            ...event.detail,
            inputSummary: event.detail?.inputSummary,
            inputPreview: event.detail?.inputPreview,
            rawInputJson: event.detail?.rawInputJson,
            toolName: event.tool,
          },
        }];
      }, generation);
      return;
    }

    if (event.type === "tool_completed") {
      patchStreamingSteps((steps) => {
        const next = [...steps];
        const index = event.toolCallId
          ? next.findIndex((step) => step.toolCallId === event.toolCallId || step.id === event.toolCallId)
          : next.findLastIndex((step) => step.status === "running");
        const target = index >= 0 ? index : next.length - 1;
        if (target >= 0 && next[target]) {
          next[target] = {
            ...next[target],
            toolCallId: event.toolCallId ?? next[target].toolCallId,
            status: event.result.ok ? "done" : "failed",
            summary: event.summary ?? (event.result.ok ? next[target].summary : event.result.message),
            detail: event.detail ?? next[target].detail,
          };
        }
        return next;
      }, generation);
      return;
    }

    if (event.type === "approval_required") {
      trackPendingChangeSet(event.changeSetId);
      patchStreamingSteps((steps) => {
        if (steps.some((step) => step.status === "confirm")) return steps;
        return [...steps, {
          id: `confirm-${steps.length}`,
          label: "等待你确认",
          status: "confirm",
          summary: "需要确认是否应用这份变更方案",
          detail: { judgment: "变更会写入你的正式计划，需要你先看草案并确认或拒绝。" },
        }];
      }, generation);
      return;
    }

    if (event.type === "run_failed") {
      patchStreamingSteps((steps) => steps.map((step) => (
        step.status === "running"
          ? { ...step, status: "failed" as const, summary: event.message }
          : step
      )), generation);
      setError(event.message);
    }
  }, [patchStreamingMessage, patchStreamingSteps]);

  /**
   * 加载 Session 关联的 pending ChangeSet（不扫全用户 pending）。
   */
  const loadSessionChangeSet = useCallback(async () => {
    const session = getSession();
    if (!session.pendingChangeSetIds.length) return;
    try {
      const items = await changeSetApi.list();
      const pending = items.find((item) => session.pendingChangeSetIds.includes(item.id));
      if (pending) {
        setChangeSet(pending);
        setRevisionHistory(null);
        setRevisionHistoryOpen(false);
        setChangeSetTerminal("pending");
        setSelectedOps(new Set(pending.operations.map((_, index) => index)));
        const lastAssistant = [...loadMessages()].reverse().find((message) => message.role === "assistant" && message.kind !== "welcome");
        if (lastAssistant) setChangeSetMessageId(lastAssistant.id);
      }
    } catch {
      /* ignore */
    }
  }, []);

  /**
   * 发送用户消息并启动 SSE 流。
   * @param prompt - 用户输入
   */
  const sendPrompt = useCallback(async (prompt: string) => {
    if (!prompt.trim() || loading) return;
    if (dataMode !== "database") {
      setError(dataMode === "checking"
        ? "正在确认数据库连接，请稍后再让小律调整计划。"
        : "当前是本地模式，无法安全读取服务端提案修订链与冲突证据。你仍可使用页面上的“安排事情”和日程编辑功能手动调整。");
      return;
    }

    if (hasUndoableClear()) consumeClearUndo();
    setCanUndoClear(false);

    const userTs = new Date().toISOString();
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const contextHistory = getContextMessages();
    const conversationSummary = getConversationSummary();
    const session = getSession();
    const scopedGoals = contextGoalId ? goals.filter((goal) => goal.id === contextGoalId) : goals;

    streamingStepsRef.current = [];
    const generation = streamGenerationRef.current + 1;
    streamGenerationRef.current = generation;

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setMessages((items) => [
      ...items,
      { id: userId, role: "user", text: prompt, timestamp: userTs },
      { id: assistantId, role: "assistant", text: "", streaming: true, timestamp: userTs },
    ]);
    setDraft("");
    setLoading(true);
    setError(null);
    setStatusText("正在理解你的请求…");

    appendMessages([{ id: userId, role: "user", text: prompt, timestamp: userTs }]);

    try {
      const result = await streamChatWithAgent(
        {
          prompt,
          capability: inferCapability(prompt, view, contextGoalId),
          provider,
          model: model || undefined,
          messages: contextHistory,
          conversationSummary,
          business: {
            goals: scopedGoals,
            schedule,
            executions: schedule.filter((item) => item.feedback),
            today: currentDateKey(),
            timezone: currentTimezone(),
          },
          page: { path: view, selectedEntityId: contextGoalId ?? undefined },
          conversationId: session.id,
          parentRunId: getActiveParentRunId(),
          activeChangeSetId: getActivePendingChangeSetId(),
        },
        (event) => handleStreamEvent(event, generation),
        abortController.signal,
      );

      if (generation !== streamGenerationRef.current) return;

      const assistantTs = new Date().toISOString();
      const finalText = result.text;
      const persistedProcessSteps = streamingStepsRef.current;

      setMessages((items) => {
        const next = [...items];
        const last = next[next.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          next[next.length - 1] = {
            ...last,
            text: finalText || last.text,
            streaming: false,
            timestamp: assistantTs,
            processSteps: persistedProcessSteps,
          };
        }
        return next;
      });

      appendMessages([{
        id: assistantId,
        role: "assistant",
        text: finalText,
        timestamp: assistantTs,
        processSteps: serializeProcessSteps(persistedProcessSteps),
      }]);

      if (result.changeSet) {
        if (result.changeSet.supersedesChangeSetId) untrackPendingChangeSet(result.changeSet.supersedesChangeSetId);
        setChangeSet(result.changeSet);
        setRevisionHistory(null);
        setRevisionHistoryOpen(false);
        setRevisionHistoryError(null);
        setChangeSetTerminal("pending");
        setChangeSetMessageId(assistantId);
        setSelectedOps(new Set(result.changeSet.operations.map((_, index) => index)));
        trackPendingChangeSet(result.changeSet.id);
      }

      trackRunEnded(currentRunIdRef.current ?? undefined);
      currentRunIdRef.current = null;
      maybeSummarizeConversation();
    } catch (caught) {
      if (generation !== streamGenerationRef.current) return;
      if (caught instanceof DOMException && caught.name === "AbortError") {
        const assistantTs = new Date().toISOString();
        const steps = streamingStepsRef.current;
        let finalText = "（已停止）";
        setMessages((items) => {
          const next = [...items];
          const last = next[next.length - 1];
          if (last?.role === "assistant" && last.id === assistantId) {
            finalText = last.text || finalText;
            next[next.length - 1] = {
              ...last,
              streaming: false,
              timestamp: assistantTs,
              processSteps: steps,
              text: finalText,
            };
          }
          return next;
        });
        appendMessages([{
          id: assistantId,
          role: "assistant",
          text: finalText,
          timestamp: assistantTs,
          processSteps: serializeProcessSteps(steps),
        }]);
        return;
      }
      setMessages((items) => items.filter((item) => !item.streaming));
      setError(caught instanceof Error ? caught.message : "小律暂时无法回应。");
    } finally {
      if (generation === streamGenerationRef.current) {
        setLoading(false);
        setStatusText(null);
        abortControllerRef.current = null;
      }
    }
  }, [loading, dataMode, goals, contextGoalId, view, provider, model, schedule, handleStreamEvent, maybeSummarizeConversation]);

  /**
   * 应用选中的变更草案（卡片原位进入只读终态）。
   */
  const applyChangeSet = useCallback(async () => {
    if (!changeSet || !selectedOps.size || changeSetTerminal !== "pending") return;
    setApplying(true);
    setError(null);
    try {
      const indexes = [...selectedOps].sort((a, b) => a - b);
      await onApply(changeSet, indexes);
      untrackPendingChangeSet(changeSet.id);
      setChangeSetTerminal("applied");
      setAppliedCount(indexes.length);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "草案没有应用成功。");
    } finally {
      setApplying(false);
    }
  }, [changeSet, selectedOps, changeSetTerminal, onApply]);

  /**
   * 拒绝变更草案（卡片原位进入只读终态）。
   */
  const rejectChangeSet = useCallback(async () => {
    if (!changeSet || changeSetTerminal !== "pending") return;
    setApplying(true);
    setError(null);
    try {
      await onReject(changeSet);
      untrackPendingChangeSet(changeSet.id);
      setChangeSetTerminal("rejected");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "没有成功记录拒绝。");
    } finally {
      setApplying(false);
    }
  }, [changeSet, changeSetTerminal, onReject]);

  /**
   * 表单提交：loading 时忽略，否则发送 draft。
   */
  const handleSubmit = useCallback((event: FormEvent) => {
    event.preventDefault();
    if (loading) return;
    void sendPrompt(draft.trim());
  }, [loading, draft, sendPrompt]);

  /**
   * 滚动到当前活动助手回合。
   */
  const scrollToActiveTurn = useCallback(() => {
    activeTurnRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  /**
   * 滚动到变更草案卡片。
   */
  const scrollToChangeSet = useCallback(() => {
    changeSetRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  // 面板打开：加载 Session 消息（不 merge AgentRun）
  useEffect(() => {
    if (!open || historyLoaded) return;
    const frame = window.requestAnimationFrame(() => {
      setExpanded(getPanelExpanded());
      const stored = loadMessages();
      if (stored.length) {
        setMessages(stored);
      } else {
        seedWelcome();
      }
      void loadSessionChangeSet();
      setHistoryLoaded(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, historyLoaded, seedWelcome, loadSessionChangeSet]);

  // 展开偏好持久化
  useEffect(() => {
    if (open) setPanelExpanded(expanded);
  }, [expanded, open]);

  // 切目标：Run 中先 cancel；syncContextScope 仅 goalId 变化时清空
  useEffect(() => {
    if (!open || !historyLoaded) return;
    const goalTitle = contextGoalId ? goals.find((goal) => goal.id === contextGoalId)?.title : null;
    const prevGoalId = prevGoalIdRef.current;
    const goalChanged = prevGoalId !== undefined && prevGoalId !== contextGoalId;
    prevGoalIdRef.current = contextGoalId;

    void (async () => {
      if (goalChanged) {
        const session = getSession();
        const runId = currentRunIdRef.current ?? session.activeRunId;
        if (runId) {
          const generation = streamGenerationRef.current + 1;
          abortStream(generation);
          await cancelServerRun(runId);
        }
      }
      syncContextScope({ view, goalId: contextGoalId }, goalTitle);
      refreshFromStore();
    })();
  }, [open, historyLoaded, contextGoalId, view, goals, abortStream, cancelServerRun, refreshFromStore]);

  // 自动滚到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, statusText, loading, changeSet]);

  // 草案卡片可见性（滚离后显示 sticky 提醒）
  useEffect(() => {
    const node = changeSetRef.current;
    if (!node || !changeSet || changeSetTerminal !== "pending") {
      setChangeSetVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      setChangeSetVisible(entry?.isIntersecting ?? true);
    }, { threshold: 0.15 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [changeSet, changeSetTerminal, messages]);

  // 面板打开时聚焦输入框
  useEffect(() => {
    if (open && historyLoaded) {
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, historyLoaded]);

  const welcomeOnly = messages.length === 1 && messages[0]?.kind === "welcome";
  const contextPrompts = buildContextPrompts(view, contextGoalId, goals);
  const showChangeSetSticky = changeSet && changeSetTerminal === "pending" && !changeSetVisible;
  const streamingMessage = messages.find((message) => message.streaming);
  const streamingSteps = streamingMessage?.processSteps ?? [];
  const activeStep = streamingSteps.find((step) => step.status === "running")
    ?? [...streamingSteps].reverse().find((step) => step.status === "confirm" || step.status === "running");
  const stickyLabel = loading
    ? (activeStep?.summary ? `${activeStep.label} · ${activeStep.summary}` : statusText ?? activeStep?.label ?? "处理中")
    : null;

  /**
   * 渲染变更草案确认层（独立卡片，支持原位终态）。
   */
  function renderChangeSetCard(afterMessageId?: string | null) {
    if (!changeSet) return null;
    if (afterMessageId && changeSetMessageId && afterMessageId !== changeSetMessageId) return null;

    return (
      <div
        className={clsx("change-set-card", changeSetTerminal !== "pending" && "terminal", changeSetTerminal)}
        ref={changeSetRef}
        aria-live={changeSetTerminal === "pending" ? undefined : "polite"}
      >
        {changeSetTerminal === "applied" ? (
          <div className="change-set-terminal">
            <span className="change-set-terminal-icon" aria-hidden><Check size={15} /></span>
            <span className="change-set-terminal-copy"><strong>已应用 {appliedCount} 项变更</strong><span>正式计划已更新</span></span>
          </div>
        ) : changeSetTerminal === "rejected" ? (
          <div className="change-set-terminal">
            <span className="change-set-terminal-icon" aria-hidden><X size={15} /></span>
            <span className="change-set-terminal-copy"><strong>草案已放弃</strong><span>正式计划没有变化</span></span>
          </div>
        ) : (
          <>
            <div className="change-set-header">
              <div>
                <span className="change-set-eyebrow">{changeSet.revision && changeSet.revision > 1 ? `待你确认的第 ${changeSet.revision} 版 · 已替代上一版` : "待你确认的方案"}</span>
                <strong>{changeSet.title}</strong>
                <p>{changeSet.reason}</p>
              </div>
              <span className="change-set-risk">{changeSet.operations.length} 项变更</span>
            </div>
            <div className="change-set-toolbar">
              <span>{selectedOps.size} 项已选择</span>
              {changeSet.revision && changeSet.revision > 1 && (
                <button
                  type="button"
                  className="select-all"
                  onClick={() => void (async () => {
                    if (revisionHistoryOpen) {
                      setRevisionHistoryOpen(false);
                      return;
                    }
                    try {
                      setRevisionHistoryError(null);
                      if (!revisionHistory) setRevisionHistory(await changeSetApi.revisions(changeSet.id));
                      setRevisionHistoryOpen(true);
                    } catch (caught) {
                      setRevisionHistoryError(caught instanceof Error ? caught.message : "暂时无法读取版本记录。");
                    }
                  })()}
                >
                  {revisionHistoryOpen ? "收起版本记录" : "查看上一版本变化"}
                </button>
              )}
              <button
                type="button"
                className="select-all"
                onClick={() => setSelectedOps(selectedOps.size === changeSet.operations.length ? new Set() : new Set(changeSet.operations.map((_, index) => index)))}
              >
                {selectedOps.size === changeSet.operations.length ? "取消全选" : "选择全部"}
              </button>
            </div>
            {revisionHistoryError && <p className="change-set-revision-error">{revisionHistoryError}</p>}
            {revisionHistoryOpen && revisionHistory && (
              <div className="change-set-revision-history">
                {revisionHistory.slice(1).map((revision) => (
                  <details key={revision.id}>
                    <summary>第 {revision.revision} 版 · {revision.status === "SUPERSEDED" ? "已被替代" : revision.status}</summary>
                    <p>{revision.reason}</p>
                    <div className="planning-tree">
                      {revision.operations.map((operation, index) => (
                        <ChangeOperationPreview key={String(operation.operationId ?? index)} operation={operation} index={index} selected={false} onToggle={() => {}} goals={goals} schedule={schedule} readOnly />
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            )}
            <div className="planning-tree">
              {changeSet.operations.map((operation, index) => (
                <ChangeOperationPreview
                  key={String(operation.operationId ?? index)}
                  operation={operation}
                  index={index}
                  selected={selectedOps.has(index)}
                  onToggle={() => setSelectedOps((current) => {
                    const next = new Set(current);
                    if (next.has(index)) next.delete(index);
                    else next.add(index);
                    return next;
                  })}
                  goals={goals}
                  schedule={schedule}
                />
              ))}
            </div>
            <div className="change-set-actions">
              <span>继续讨论不会应用这份方案</span>
              <button type="button" disabled={applying || !selectedOps.size} onClick={() => void applyChangeSet()}>
                {applying ? "应用中…" : `确认 ${selectedOps.size} 项`}
              </button>
              <button type="button" disabled={applying} onClick={() => void rejectChangeSet()}>
                拒绝草案
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <aside className={clsx("agent-panel", open && "open", expanded && "expanded")} aria-hidden={!open}>
      <header>
        <div className="agent-title">
          <div className="agent-avatar"><Sparkles size={17} /></div>
          <div>
            <strong>小律</strong>
            <small><i />{provider} · {model || "默认模型"}</small>
          </div>
        </div>
        <div className="agent-header-actions">
          <button
            type="button"
            className="agent-header-action new-conversation"
            aria-label="新对话"
            title="新对话"
            onClick={handleNewConversationClick}
          >
            <span className="agent-header-action-icon" aria-hidden><MessageSquarePlus size={15} /></span>
            <span className="agent-header-action-label">新对话</span>
          </button>
          <button
            type="button"
            className="agent-header-action clear-context"
            aria-label="清空上下文"
            title={welcomeOnly ? "暂无可清空的上下文" : "清空上下文"}
            disabled={welcomeOnly}
            onClick={handleClearContext}
          >
            <span className="agent-header-action-icon" aria-hidden><Unlink2 size={15} /></span>
            <span className="agent-header-action-label">清空上下文</span>
          </button>
          <button type="button" className="icon-button" title={expanded ? "还原窗口" : "展开对话窗口"} aria-label={expanded ? "还原" : "展开"} onClick={() => setExpanded((value) => !value)}>
            {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </button>
          <button type="button" className="icon-button" aria-label="关闭小律" onClick={onClose}><X size={19} /></button>
        </div>
      </header>

      <div className="agent-context">
        <span><CalendarDays size={13} />{VIEW_LABELS[view]}</span>
        <span><Target size={13} />{contextGoalId ? goals.find((goal) => goal.id === contextGoalId)?.title ?? "当前目标" : "未关联目标"}</span>
      </div>

      {cleanupWarning && (
        <div className="agent-error" style={{ margin: "8px 16px 0" }}>
          仍有未取消的任务或未处理草案。
          <button type="button" onClick={() => void retryCleanup()}>重试清理</button>
        </div>
      )}

      {toast && (
        <div className="agent-thinking" style={{ margin: "8px 16px 0" }} role="status">
          <i /><span>{toast}</span>
        </div>
      )}

      <div className="agent-messages">
        {messages.map((item, index) => {
          const isOutsideContext = item.id ? isMessageOutsideContext(item.id) : false;
          const isActiveTurn = loading && index === messages.length - 1 && item.role === "assistant" && item.streaming;

          if (item.kind === "boundary") {
            return (
              <div key={item.id} className="context-divider">
                <span>{item.text}</span>
                {item.boundary?.undoable && canUndoClear && index === messages.length - 1 && (
                  <button type="button" className="soft-button" style={{ marginLeft: 8, minHeight: 28, fontSize: 10 }} onClick={handleUndoClear}>
                    撤销
                  </button>
                )}
              </div>
            );
          }

          return (
            <div key={item.id ?? index} className={clsx("agent-message-row", item.role)}>
              <div
                className={clsx("agent-turn", item.role)}
                ref={isActiveTurn ? activeTurnRef : undefined}
              >
                {item.role === "assistant" && (item.processSteps?.length ?? 0) > 0 && (
                  <AgentProcessSteps
                    steps={item.processSteps!}
                    active={!!item.streaming}
                    answerStarted={item.text.length > 0}
                    userExpanded={item.userExpandedProcess}
                    onUserExpandChange={(expandedProcess) => {
                      setMessages((items) => items.map((message, messageIndex) => (
                        messageIndex === index ? { ...message, userExpandedProcess: expandedProcess } : message
                      )));
                    }}
                  />
                )}
                <div className={clsx("agent-message", item.role, item.streaming && "streaming", isOutsideContext && "out-of-context")}>
                  {item.role === "assistant" ? (
                    item.streaming && !item.text ? (
                      <span className="agent-typing" aria-label="小律正在输入"><i /><i /><i /></span>
                    ) : (
                      <>
                        {progressStatus(item.text) && (
                          <span className={clsx("progress-evaluation", progressStatus(item.text))}>
                            {progressStatusLabel(progressStatus(item.text)!)}
                          </span>
                        )}
                        <AgentMarkdown content={item.text} />
                      </>
                    )
                  ) : item.text}
                </div>
              </div>
              {changeSet && item.id === changeSetMessageId && renderChangeSetCard(item.id)}
            </div>
          );
        })}

        {changeSet && !changeSetMessageId && renderChangeSetCard()}

        <div ref={messagesEndRef} />
      </div>

      {loading && stickyLabel && (
        <button type="button" className="agent-activity" style={{ margin: "0 16px 8px", alignSelf: "stretch" }} onClick={scrollToActiveTurn} aria-live="polite">
          <div className="agent-thinking"><i /><span>{stickyLabel}</span></div>
        </button>
      )}

      {error && (
        <div className="agent-error">
          {error}
          <button type="button" onClick={() => setError(null)}>知道了</button>
        </div>
      )}

      {welcomeOnly && contextPrompts.length > 0 && (
        <div className="agent-prompts">
          {contextPrompts.map((entry) => (
            <button key={entry.label} type="button" onClick={() => void sendPrompt(entry.prompt)}>
              {entry.label}
            </button>
          ))}
        </div>
      )}

      {showChangeSetSticky && (
        <button type="button" className="agent-thinking" style={{ margin: "0 16px 8px" }} onClick={scrollToChangeSet}>
          <i /><span>有一份变更草案等待确认 · 查看</span>
        </button>
      )}

      <form className="agent-input" onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={dataMode === "local" ? "本地模式下请使用手动日程功能…" : "告诉小律你想调整什么…"}
          disabled={dataMode !== "database"}
        />
        {loading ? (
          <button type="button" aria-label="停止" onClick={() => void handleStop()}><Square size={15} /></button>
        ) : (
          <button type="submit" aria-label="发送" disabled={!draft.trim() || dataMode !== "database"}><Send size={17} /></button>
        )}
      </form>

      <p className="agent-boundary">
        {dataMode === "local"
          ? "本地模式保留手动日程能力；服务端提案续接暂不可用。"
          : changeSet && changeSetTerminal === "pending"
          ? "继续讨论不会应用草案；正式写入仍须你确认。"
          : "涉及计划变更时，会先给你确认。"}
      </p>

      {confirmNew && (
        <div className="modal-layer">
          <button type="button" className="modal-scrim" aria-label="关闭" onClick={() => setConfirmNew(null)} />
          <section className="modal-card" style={{ width: "min(420px, 100%)" }}>
            <header>
              <div>
                <span className="section-kicker">新对话</span>
                <h2>{confirmNew.hasRun && confirmNew.hasChangeSet ? "停止处理并放弃草案？" : confirmNew.hasRun ? "停止当前处理并开始新对话？" : "开始新对话？"}</h2>
                <p>
                  {confirmNew.hasRun && "将停止当前处理。"}
                  {confirmNew.hasChangeSet && " 待确认的变更草案会被放弃，正式计划不会改变。"}
                </p>
              </div>
            </header>
            <div className="form-actions spread">
              <button type="button" className="soft-button" onClick={() => setConfirmNew(null)}>取消</button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void executeNewConversation(confirmNew.hasRun, confirmNew.hasChangeSet)}
              >
                {confirmNew.hasRun && confirmNew.hasChangeSet ? "停止并放弃" : confirmNew.hasRun ? "停止并新建" : "放弃草案并新建"}
              </button>
            </div>
          </section>
        </div>
      )}
    </aside>
  );
}
