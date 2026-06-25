import type { Goal, ScheduleItem } from "./demo-data";

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

export type RhythmSignalRecord = { id: string; type: string; statement: string; confidence?: number | null };
export async function loadWorkspace(timezone = "Asia/Shanghai"): Promise<{ goals: Goal[]; schedule: ScheduleItem[]; rhythmSignals: RhythmSignalRecord[] }> {
  const today = new Date();
  const from = new Date(today.getFullYear(), today.getMonth(), 1);
  const to = new Date(today.getFullYear(), today.getMonth() + 1, 7);
  const data = await request<{ goals: ServerGoal[]; schedule: ServerBlock[]; rhythmSignals?: RhythmSignalRecord[] }>(`/api/bootstrap?from=${from.toISOString()}&to=${to.toISOString()}`);
  const goals = data.goals.map((goal, index) => ({
    ...goal, color: goalColor(index), weeklyMinutes: 0, completedMinutes: 0,
    tasksDone: goal.tasks.filter((task) => task.status === "completed").length, tasksTotal: goal.tasks.length,
  }));
  const schedule = data.schedule.map((block) => {
    const taskIds = block.taskIds?.length
      ? block.taskIds
      : block.linkedTasks?.map((link) => link.taskId)
      ?? (block.taskId ? [block.taskId] : []);
    return {
    id: block.id, title: block.title, goalId: block.goalId ?? "", taskId: taskIds[0] ?? block.taskId ?? undefined, taskIds: taskIds.length ? taskIds : undefined, routineId: block.routineId ?? undefined, start: time(block.startsAt, timezone), end: time(block.endsAt, timezone), version: block.version,
    date: dateKey(block.startsAt, timezone), occurrenceDate: block.occurrenceDate, source: block.source, displayMode: block.displayMode, changeReason: block.changeReason, rescheduledFromId: block.rescheduledFromId,
    kind: block.routineId ? "routine" as const : (!block.goalId && !taskIds.length && !block.routineId) ? "personal" as const : "task" as const,
    status: block.status === "completed" ? "completed" as const : block.status === "missed" ? "missed" as const : block.status === "rescheduled" ? "rescheduled" as const : block.status === "cancelled" ? "cancelled" as const : "planned" as const,
    energy: "medium" as const, feedback: block.executionRecord?.rhythmFeedback?.tags?.[0], execution: block.executionRecord ? { result: block.executionRecord.result, actualMinutes: block.executionRecord.actualMinutes, actualStartedAt: block.executionRecord.actualStartedAt, actualEndedAt: block.executionRecord.actualEndedAt, quality: block.executionRecord.quality, obstacle: block.executionRecord.obstacle, deviationReason: block.executionRecord.deviationReason, nextAction: block.executionRecord.nextAction, tags: block.executionRecord.rhythmFeedback?.tags ?? [], note: block.executionRecord.rhythmFeedback?.note, comfortable: block.executionRecord.rhythmFeedback?.comfortable, timeFit: block.executionRecord.rhythmFeedback?.timeFit } : undefined,
  };
  });
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
export type ReviewRecord = { id: string; type: "daily" | "weekly"; status: string; periodStart: string; periodEnd: string; summary: string; metrics: Record<string, number>; findings: string[]; suggestions: string[]; confirmedAt?: string | null };

export async function loadModelProviders() {
  const response = await fetch("/api/models");
  if (!response.ok) throw new Error("无法读取模型配置。");
  return response.json() as Promise<{ data: ModelProviderInfo[]; defaultProvider: string }>;
}

export type AgentStreamEvent =
  | { type: "status"; phase: "context" | "thinking" | "tool" | "writing"; message: string }
  | { type: "run_started"; runId: string }
  | { type: "loop_step"; kind: "planning" | "verification" | "decision" | "final" | "recovery"; label: string; summary?: string; goalStatus?: string; nextAction?: string; detail?: { scope?: string; result?: string; judgment?: string; nextAction?: string; missingInformation?: string[] } }
  | { type: "text_delta"; text: string }
  | { type: "model_fallback"; from: string; to: string; reason: string }
  | { type: "tool_started"; tool: string; label?: string }
  | { type: "tool_completed"; tool: string; label?: string; summary?: string; detail?: { scope?: string; result?: string; judgment?: string; nextAction?: string }; result: { ok: boolean; message?: string } }
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
  input: { prompt: string; capability: string; provider: string; model?: string; messages: Array<{ role: "user" | "assistant"; content: string }>; business: Record<string, unknown>; page: { path: string; selectedEntityId?: string } },
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
};
export type UserSettings = { timezone: string; dailyReviewTime: string; weeklyReviewDay: number; weeklyReviewTime: string; defaultModel: string };
export const settingsApi = {
  get: () => request<UserSettings>("/api/settings"),
  save: (settings: UserSettings) => request<UserSettings>("/api/settings", { method: "PATCH", body: JSON.stringify(settings) }),
};

function time(iso: string, timezone: string) { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone }).format(new Date(iso)); }
function dateKey(iso: string, timezone: string) { return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: timezone }).format(new Date(iso)); }
