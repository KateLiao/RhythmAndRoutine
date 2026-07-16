import { enrichGoalsWithScheduleStats, type Goal, type ScheduleItem } from "./demo-data";
import { zonedDateKey, zonedPeriod } from "./timezone";

type ApiEnvelope<T> = { data: T };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `请求失败（${response.status}）`);
  }
  if (response.status === 204) return undefined as T;
  return ((await response.json()) as ApiEnvelope<T>).data;
}

type ServerGoal = Omit<Goal, "color" | "weeklyMinutes" | "completedMinutes" | "tasksDone" | "tasksTotal"> & {
  tasks: NonNullable<Goal["tasks"]>;
  routines: NonNullable<Goal["routines"]>;
};

type ServerBlock = {
  id: string; title: string; goalId?: string | null; taskId?: string | null; taskIds?: string[]; routineId?: string | null; startsAt: string; endsAt: string; status: string; version: number; changeReason?: string | null; rescheduledFromId?: string | null;
  task?: { id: string; title: string } | null; routine?: { id: string; title: string } | null;
  linkedTasks?: Array<{ taskId: string; task?: { id: string; title: string } | null }>;
  occurrenceDate?: string; source?: string; displayMode?: string;
  executionRecord?: { result: string; actualMinutes?: number | null; actualStartedAt?: string | null; actualEndedAt?: string | null; quality?: string | null; obstacle?: string | null; deviationReason?: string | null; nextAction?: string | null; rhythmFeedback?: { tags: string[]; note?: string | null; comfortable?: boolean | null; timeFit?: string | null } | null } | null;
};

function goalColor(index: number): Goal["color"] { return (["violet", "sage", "coral"] as const)[index % 3]; }

/**
 * 将 API 返回的日程块转为客户端 ScheduleItem，统一时区下的日期与时间字段。
 * @param block - 服务端日程块
 * @param timezone - 用户 IANA 时区
 */
export function mapServerBlockToScheduleItem(block: ServerBlock, timezone: string): ScheduleItem {
  const taskIds = block.taskIds?.length
    ? block.taskIds
    : block.linkedTasks?.map((link) => link.taskId)
    ?? (block.taskId ? [block.taskId] : []);
  return {
    id: block.id,
    title: block.title,
    goalId: block.goalId ?? "",
    taskId: taskIds[0] ?? block.taskId ?? undefined,
    taskIds: taskIds.length ? taskIds : undefined,
    routineId: block.routineId ?? undefined,
    start: time(block.startsAt, timezone),
    end: time(block.endsAt, timezone),
    version: block.version,
    date: dateKey(block.startsAt, timezone),
    occurrenceDate: block.occurrenceDate,
    source: block.source,
    displayMode: block.displayMode,
    changeReason: block.changeReason,
    rescheduledFromId: block.rescheduledFromId,
    kind: block.routineId ? "routine" as const : (!block.goalId && !taskIds.length && !block.routineId) ? "personal" as const : "task" as const,
    status: block.status === "completed" ? "completed" as const : block.status === "in_progress" ? "in_progress" as const : block.status === "missed" ? "missed" as const : block.status === "rescheduled" ? "rescheduled" as const : block.status === "cancelled" ? "cancelled" as const : "planned" as const,
    energy: "medium" as const,
    feedback: block.executionRecord?.rhythmFeedback?.tags?.[0],
    execution: block.executionRecord ? {
      result: block.executionRecord.result,
      actualMinutes: block.executionRecord.actualMinutes,
      actualStartedAt: block.executionRecord.actualStartedAt,
      actualEndedAt: block.executionRecord.actualEndedAt,
      quality: block.executionRecord.quality,
      obstacle: block.executionRecord.obstacle,
      deviationReason: block.executionRecord.deviationReason,
      nextAction: block.executionRecord.nextAction,
      tags: block.executionRecord.rhythmFeedback?.tags ?? [],
      note: block.executionRecord.rhythmFeedback?.note,
      comfortable: block.executionRecord.rhythmFeedback?.comfortable,
      timeFit: block.executionRecord.rhythmFeedback?.timeFit,
    } : undefined,
  };
}

export type RhythmSignalRecord = { id: string; type: string; statement: string; confidence?: number | null; evidence?: unknown };

export type HomeInsightProposedChange =
  | { type: "reschedule"; scheduleId: string; start: string; end: string; date: string; label: string }
  | { type: "create_schedule"; title: string; start: string; end: string; date: string; goalId?: string; taskId?: string; label: string }
  | { type: "open_schedule_form"; start: string; end: string; date: string; goalId?: string; taskId?: string; label: string }
  | { type: "open_execution_feedback"; scheduleId: string; label: string };

export type ApiHomeInsights = {
  moment: {
    kind: "action" | "empty" | "exhausted";
    headline: string;
    judgment: string;
    reason?: string;
    nextLabel?: string;
    proposedChange?: HomeInsightProposedChange;
    actionLabel?: string;
    alternateCount: number;
    alternateIndex: number;
    exhausted: boolean;
    source?: "ai" | "rules";
    generatedAt?: string;
    trigger?: string | null;
  };
  rhythm: {
    kind: "insight" | "empty";
    statement: string;
    evidence?: string;
    impact?: string;
    signalId?: string;
    source?: "ai" | "rules";
    generatedAt?: string;
    trigger?: string | null;
  };
  weekly: {
    kind: "track" | "empty";
    statusLabel: string;
    status: string;
    summary: string;
    suggestion?: string;
    plannedMinutes?: number;
    completedMinutes?: number;
    source?: "ai" | "rules";
    generatedAt?: string;
    trigger?: string | null;
  };
  meta: {
    regeneratedMoment: boolean;
    regeneratedSlow: boolean;
    momentGeneratedAt?: string;
    slowGeneratedAt?: string;
  };
};

export const homeInsightsApi = {
  get: () => request<ApiHomeInsights>("/api/home/insights"),
  /**
   * 手动触发服务端洞察重生成（同步请求）。
   * @param target - moment 仅重算此刻建议；slow 重算节奏发现与本周轨道
   * @param options.signal - 可选 AbortSignal，用于客户端超时取消
   */
  regenerate: (target: "moment" | "slow", options?: { signal?: AbortSignal }) =>
    request<ApiHomeInsights>("/api/home/insights/regenerate", {
      method: "POST",
      body: JSON.stringify({ target }),
      signal: options?.signal,
    }),
  alternateMoment: () => request<ApiHomeInsights>("/api/home/insights/moment", { method: "PATCH", body: JSON.stringify({ action: "alternate" }) }),
  respondMoment: (response: "accepted" | "ignored", applied = false) =>
    request<ApiHomeInsights>("/api/home/insights/moment", { method: "PATCH", body: JSON.stringify({ action: "respond", response, applied }) }),
};
/**
 * 构造工作区 bootstrap 时间窗：向前覆盖一年历史（保证累计投入不漏算），向后覆盖到下月初。
 * Routine 展开由服务端在超长窗口内自动截断到 93 天。
 * @param now - 当前时刻
 * @returns ISO 查询用的 from / to
 */
function workspaceBootstrapRange(now = new Date()) {
  const from = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 7);
  return { from, to };
}

/**
 * 计算用户时区下本周（周一至周日）的日期键集合。
 * @param timezone - IANA 时区
 * @param now - 当前时刻
 */
function currentWeekDateKeys(timezone: string, now = new Date()): Set<string> {
  const week = zonedPeriod(now, timezone, "weekly");
  const keys = new Set<string>();
  for (let cursor = new Date(week.start); cursor < week.end; cursor = new Date(cursor.getTime() + 86400000)) {
    keys.add(zonedDateKey(cursor, timezone));
  }
  return keys;
}

/**
 * 加载工作区的目标、日程与节奏信号，并按用户时区转换日程日期和时间。
 * @param timezone - 用于格式化日程的 IANA 时区
 * @returns 客户端可直接消费的目标、日程与节奏信号
 */
export async function loadWorkspace(timezone = "Asia/Shanghai"): Promise<{ goals: Goal[]; schedule: ScheduleItem[]; rhythmSignals: RhythmSignalRecord[] }> {
  const { from, to } = workspaceBootstrapRange();
  const data = await request<{ goals: ServerGoal[]; schedule: ServerBlock[]; rhythmSignals?: RhythmSignalRecord[] }>(`/api/bootstrap?from=${from.toISOString()}&to=${to.toISOString()}`);
  const baseGoals = data.goals.map((goal, index) => ({
    ...goal, color: goalColor(index), weeklyMinutes: 0, completedMinutes: 0,
    tasksDone: goal.tasks.filter((task) => task.status === "completed").length, tasksTotal: goal.tasks.length,
  }));
  const schedule = data.schedule.map((block) => mapServerBlockToScheduleItem(block, timezone));
  const goals = enrichGoalsWithScheduleStats(baseGoals, schedule, currentWeekDateKeys(timezone));
  return { goals, schedule, rhythmSignals: data.rhythmSignals ?? [] };
}

export const workspaceApi = {
  createGoal: (input: { title: string; description: string; category?: string; project?: string; skill?: string; targetDate?: string | null }) => request<ServerGoal>("/api/goals", { method: "POST", body: JSON.stringify(input) }),
  updateGoal: (id: string, input: { title?: string; description?: string; category?: string; project?: string; skill?: string; targetDate?: string | null; status?: string; expectedVersion: number }) => request<ServerGoal>(`/api/goals/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  archiveGoal: (id: string, version: number) => request<void>(`/api/goals/${id}?version=${version}`, { method: "DELETE" }),
  createOutcome: (goalId: string, description: string) => request<NonNullable<Goal["outcomes"]>[number]>(`/api/goals/${goalId}/outcomes`, { method: "POST", body: JSON.stringify({ description }) }),
  updateOutcome: (id: string, input: { description?: string; completed?: boolean; expectedVersion: number }) => request<NonNullable<Goal["outcomes"]>[number]>(`/api/outcomes/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteOutcome: (id: string, version: number) => request<void>(`/api/outcomes/${id}?version=${version}`, { method: "DELETE" }),
  createMilestone: (goalId: string, input: { title: string; description?: string }) => request<NonNullable<Goal["milestones"]>[number]>(`/api/goals/${goalId}/milestones`, { method: "POST", body: JSON.stringify(input) }),
  updateMilestone: (id: string, input: { title?: string; status?: string; expectedVersion: number }) => request<NonNullable<Goal["milestones"]>[number]>(`/api/milestones/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  archiveMilestone: (id: string, version: number) => request<void>(`/api/milestones/${id}?version=${version}`, { method: "DELETE" }),
  createTask: (goalId: string, input: { title: string; intent?: string; completionCriteria?: string[]; suggestedSteps?: string[]; estimatedMinutes?: number; energyLevel?: string; focusLevel?: string; rhythmConditions?: string[]; milestoneId?: string }) => request<NonNullable<Goal["tasks"]>[number]>(`/api/goals/${goalId}/tasks`, { method: "POST", body: JSON.stringify(input) }),
  updateTask: (id: string, input: { title?: string; intent?: string; completionCriteria?: string[]; suggestedSteps?: string[]; estimatedMinutes?: number; energyLevel?: string; focusLevel?: string; rhythmConditions?: string[]; milestoneId?: string; status?: string; expectedVersion: number }) => request<NonNullable<Goal["tasks"]>[number]>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  completeTask: (id: string, expectedVersion: number) => request<{ id: string; status: string; completedAt: string | null; completionRecord: import("./demo-data").TaskCompletionRecord; version: number }>(`/api/tasks/${id}/complete`, { method: "POST", body: JSON.stringify({ expectedVersion }) }),
  archiveTask: (id: string, version: number) => request<void>(`/api/tasks/${id}?version=${version}`, { method: "DELETE" }),
  createRoutine: (goalId: string, input: { title: string; description?: string | null; recurrenceRule: string; startDate: string; endDate?: string | null; durationMinutes?: number; preferredStartTime?: string; preferredEndTime?: string; preferredTimeOfDay?: string; priority?: string; displayMode?: string; minimumVersion?: string | null }) => request<NonNullable<Goal["routines"]>[number]>(`/api/goals/${goalId}/routines`, { method: "POST", body: JSON.stringify(input) }),
  updateRoutine: (id: string, input: { title?: string; description?: string | null; recurrenceRule?: string; startDate?: string; endDate?: string | null; durationMinutes?: number; preferredStartTime?: string; preferredEndTime?: string; preferredTimeOfDay?: string; priority?: string; displayMode?: string; minimumVersion?: string | null; status?: string; expectedVersion: number }) => request<NonNullable<Goal["routines"]>[number]>(`/api/routines/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  archiveRoutine: (id: string, version: number) => request<void>(`/api/routines/${id}?version=${version}`, { method: "DELETE" }),
  createSchedule: (input: { title: string; goalId?: string; taskId?: string; taskIds?: string[]; routineId?: string; startsAt: string; endsAt: string }) => request<ServerBlock>("/api/schedule", { method: "POST", body: JSON.stringify(input) }),
  updateSchedule: (id: string, input: { title?: string; goalId?: string | null; taskId?: string | null; taskIds?: string[]; routineId?: string | null; startsAt?: string; endsAt?: string; changeReason?: string; status?: string; moveInPlace?: boolean; expectedVersion: number }) => request<ServerBlock>(`/api/schedule/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteSchedule: (id: string, version: number) => request<void>(`/api/schedule/${id}?version=${version}`, { method: "DELETE" }),
  recordExecution: (id: string, input: { result: string; tags: string[]; actualMinutes?: number; actualStartedAt?: string; actualEndedAt?: string; quality?: string; obstacle?: string; deviationReason?: string; nextAction?: string; note?: string; comfortable?: boolean; timeFit?: string }) => request<ServerBlock>(`/api/schedule/${id}/execution`, { method: "PUT", body: JSON.stringify(input) }),
  recordRoutineExecution: (input: { routineId: string; occurrenceDate: string; plannedStartAt?: string; plannedEndAt?: string; status: "completed" | "skipped" | "missed" | "rescheduled"; actualMinutes?: number; feedbackTags?: string[]; note?: string; rescheduledStartAt?: string; rescheduledEndAt?: string }) => request<Record<string, unknown>>("/api/routine-occurrences/execution", { method: "PUT", body: JSON.stringify(input) }),
};

export type ModelProviderInfo = { id: string; label: string; model: string; baseUrl: string; enabled: boolean };
export type AgentChangeSet = { id: string; title: string; reason: string; riskLevel: string; operations: Array<Record<string, unknown>> };
export type AgentRunHistory = {
  id: string;
  status: string;
  inputSummary?: string | null;
  finalSummary?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  completedAt?: string | null;
  steps: Array<{
    id: string;
    sequence: number;
    kind: string;
    goalStatus?: string | null;
    nextAction?: string | null;
    reason?: string | null;
    missingInformation?: string[] | null;
    outputSummary?: string | null;
    toolCalls: Array<{ toolName: string; status: string; errorCode?: string | null }>;
  }>;
};
export type ReviewReadyForCompletionTask = { taskId: string; title: string; goalId: string; goalTitle: string | null };
export type ReviewContent = {
  sessionHighlights: string[];
  rhythmNotes: string[];
  taskProgressNotes: string[];
  routineNotes: string[];
  goalCheckSuggestions: string[];
  nextCycleSuggestions: string[];
  readyForCompletionTasks: ReviewReadyForCompletionTask[];
};
export type ReviewRecord = { id: string; type: "daily" | "weekly"; status: string; periodStart: string; periodEnd: string; summary: string; metrics: Record<string, number>; findings: string[]; suggestions: string[]; content?: ReviewContent | null; confirmedAt?: string | null };

export async function loadModelProviders() {
  const response = await fetch("/api/models");
  if (!response.ok) throw new Error("无法读取模型配置。");
  return response.json() as Promise<{ data: ModelProviderInfo[]; defaultProvider: string }>;
}

export type AgentToolDetail = {
  scope?: string;
  result?: string;
  judgment?: string;
  nextAction?: string;
  missingInformation?: string[];
  inputSummary?: string;
  inputPreview?: string;
  rawInputJson?: string;
  toolName?: string;
};

export type AgentStreamEvent =
  | { type: "status"; phase: "context" | "thinking" | "tool" | "writing"; message: string }
  | { type: "run_started"; runId: string }
  | { type: "loop_step"; kind: "planning" | "verification" | "decision" | "final" | "recovery"; label: string; summary?: string; goalStatus?: string; nextAction?: string; detail?: AgentToolDetail }
  | { type: "text_delta"; text: string }
  | { type: "model_fallback"; from: string; to: string; reason: string }
  | { type: "tool_started"; tool: string; toolCallId?: string; label?: string; summary?: string; detail?: AgentToolDetail; input?: unknown }
  | { type: "tool_completed"; tool: string; toolCallId?: string; label?: string; summary?: string; detail?: AgentToolDetail; result: { ok: boolean; message?: string } }
  | { type: "approval_required"; changeSetId: string }
  | { type: "run_completed"; text: string }
  | { type: "run_failed"; code: string; message: string }
  | { type: "done"; text: string; provider: string; model: string; changeSet: AgentChangeSet | null }
  | { type: "error"; message: string };

/**
 * 以 SSE 流式方式与小律对话，实时接收状态、工具调用与文本增量。
 * @param input - 对话请求参数（与 chatWithAgent 相同）
 * @param onEvent - 每收到一条 SSE 事件时的回调
 * @param signal - 可选 AbortSignal，用于取消请求
 */
export async function streamChatWithAgent(
  input: {
    prompt: string;
    capability: string;
    provider: string;
    model?: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    conversationSummary?: string;
    business: Record<string, unknown>;
    page: { path: string; selectedEntityId?: string };
  },
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal,
): Promise<{ text: string; provider: string; model: string; changeSet: AgentChangeSet | null }> {
  const response = await fetch("/api/agent/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(input),
    signal,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `请求失败（${response.status}）`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("服务器没有返回可读取的流。");

  const decoder = new TextDecoder();
  let buffer = "";
  let result: { text: string; provider: string; model: string; changeSet: AgentChangeSet | null } | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const blockEnd = buffer.indexOf("\n\n");
      if (blockEnd === -1) break;
      const block = buffer.slice(0, blockEnd);
      buffer = buffer.slice(blockEnd + 2);
      const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (!payload) continue;

      const event = JSON.parse(payload) as AgentStreamEvent;
      onEvent(event);
      if (event.type === "done") {
        result = { text: event.text, provider: event.provider, model: event.model, changeSet: event.changeSet };
      }
      if (event.type === "error") throw new Error(event.message);
    }
  }

  if (!result) throw new Error("小律没有返回完整回复。");
  return result;
}

export const reviewApi = {
  list: () => request<ReviewRecord[]>("/api/reviews"),
  generate: (type: "daily" | "weekly", periodStart: string, periodEnd: string) => request<ReviewRecord>("/api/reviews", { method: "POST", body: JSON.stringify({ type, periodStart, periodEnd }) }),
  confirm: (id: string, confirmed: boolean) => request<ReviewRecord>(`/api/reviews/${id}`, { method: "PATCH", body: JSON.stringify({ confirmed }) }),
};
export const changeSetApi = {
  list: () => request<AgentChangeSet[]>("/api/change-sets"),
  decide: (id: string, approved: boolean, selectedOperationIndexes?: number[]) => request<unknown>(`/api/change-sets/${id}/decision`, { method: "POST", body: JSON.stringify({ approved, selectedOperationIndexes }) }),
};
export const agentRunApi = {
  list: (limit = 30) => request<AgentRunHistory[]>(`/api/agent/runs?limit=${limit}`),
  /**
   * 取消指定 AgentRun，并拒绝其关联的待确认 ChangeSet。
   * @param id - Run id
   * @param reason - 可选原因
   */
  cancel: async (id: string, reason?: string) => {
    const response = await fetch(`/api/agent/runs/${id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    if (!response.ok && response.status !== 204) {
      const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message ?? "取消当前处理失败。");
    }
  },
};

/**
 * 请求异步对话摘要（best-effort）。
 * @param input - session 校验字段与溢出消息
 */
export async function summarizeConversation(input: {
  sessionId: string;
  revision: number;
  priorSummary?: string;
  messages: Array<{ role: "user" | "assistant"; content: string; id?: string }>;
}): Promise<{ sessionId: string; revision: number; summary: string; summarizedThroughMessageId?: string }> {
  return request(`/api/agent/conversation/summarize`, { method: "POST", body: JSON.stringify(input) });
}
export type UserSettings = { timezone: string; dailyReviewTime: string; weeklyReviewDay: number; weeklyReviewTime: string; defaultModel: string };
export const settingsApi = {
  get: () => request<UserSettings>("/api/settings"),
  save: (settings: UserSettings) => request<UserSettings>("/api/settings", { method: "PATCH", body: JSON.stringify(settings) }),
};

function time(iso: string, timezone: string) { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone }).format(new Date(iso)); }
function dateKey(iso: string, timezone: string) { return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: timezone }).format(new Date(iso)); }
