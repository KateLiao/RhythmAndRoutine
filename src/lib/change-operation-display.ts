import type { Goal, ScheduleItem } from "./demo-data";

const FIELD_LABELS: Record<string, string> = {
  title: "名称",
  name: "名称",
  label: "名称",
  description: "描述",
  summary: "摘要",
  intent: "任务意图",
  status: "状态",
  startsAt: "开始时间",
  endsAt: "结束时间",
  start: "开始",
  end: "结束",
  date: "日期",
  goalId: "关联目标",
  taskId: "关联任务",
  routineId: "关联 Routine",
  estimatedMinutes: "预计时长",
  durationMinutes: "执行时长",
  targetMinutes: "执行时长（旧字段）",
  preferredStartTime: "建议开始时间",
  preferredEndTime: "建议结束时间",
  preferredTimeOfDay: "建议时段",
  startDate: "生效日期",
  endDate: "结束日期",
  recurrenceRule: "重复规则",
  minimumVersion: "最低可行版本",
  category: "分类",
  energyLevel: "精力",
  focusLevel: "专注",
  position: "顺序",
  targetDate: "目标日期",
  dayOfWeek: "星期",
  weekday: "星期",
  time: "时间",
  activity: "活动",
  type: "类型",
  frequency: "频率",
  duration: "时长",
  changeReason: "调整原因",
};

const REF_KEY = /^(clientRef|tempId|milestoneRef|goalRef|taskRef|routineRef|parentTaskRef)$/i;
const ID_KEY = /^(goal|task|routine|milestone|parent|client|temp|entity).*?(Id|Ref)$/i;

/**
 * 判断字符串是否像数据库 ID（cuid/uuid），不应作为用户可见标题。
 * @param value - 待检测字符串
 */
function looksLikeEntityId(value: string): boolean {
  return /^c[a-z0-9]{20,}$/i.test(value) || /^[0-9a-f-]{32,36}$/i.test(value);
}

/**
 * 格式化日程时间为可读字符串。
 * @param value - ISO 时间或 HH:mm 字符串
 */
function formatScheduleMoment(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const raw = String(value);
  try {
    if (raw.includes("T")) {
      return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(raw));
    }
    return raw;
  } catch {
    return raw;
  }
}

/**
 * 将 iCal 重复规则转为简短中文说明。
 * @param rule - recurrenceRule 字符串
 */
function humanizeRecurrenceRule(rule: string): string {
  const text = rule.trim();
  if (!text) return text;
  const dayMap: Record<string, string> = { MO: "一", TU: "二", WE: "三", TH: "四", FR: "五", SA: "六", SU: "日" };
  const freq = text.match(/FREQ=([A-Z]+)/i)?.[1]?.toUpperCase();
  const days = text.match(/BYDAY=([A-Z,]+)/i)?.[1]?.split(",").map((day) => dayMap[day] ?? day).join("、");
  if (freq === "DAILY") return "每天";
  if (freq === "WEEKLY" && days) return `每周${days}`;
  if (freq === "WEEKLY") return "每周";
  if (freq === "MONTHLY") return "每月";
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

/**
 * 将字段值格式化为对用户友好的字符串。
 * @param key - 字段名
 * @param value - 字段原始值
 * @param goals - 目标列表
 * @param schedule - 日程列表
 */
export function formatChangeOperationFieldValue(key: string, value: unknown, goals: Goal[], schedule: ScheduleItem[]): string {
  if (value === null || value === undefined || value === "") return "（空）";
  if (key === "scheduleBlockId" || key === "scheduleId") {
    return schedule.find((entry) => entry.id === String(value))?.title ?? String(value);
  }
  if (key === "goalId") {
    const goal = goals.find((entry) => entry.id === String(value));
    return goal ? goal.title : String(value);
  }
  if (key === "taskId") {
    for (const goal of goals) {
      const task = goal.tasks?.find((entry) => entry.id === String(value));
      if (task) return task.title;
    }
    return String(value);
  }
  if (key === "routineId") {
    for (const goal of goals) {
      const routine = goal.routines?.find((entry) => entry.id === String(value));
      if (routine) return routine.title;
    }
    return String(value);
  }
  if (key === "startsAt" || key === "endsAt" || key === "start" || key === "end" || key === "time") {
    return formatScheduleMoment(value) ?? String(value);
  }
  if (key === "recurrenceRule" || key === "recurrence") {
    return humanizeRecurrenceRule(String(value));
  }
  if (key === "status") {
    const statusLabels: Record<string, string> = { active: "推进中", draft: "待澄清", paused: "暂停", planned: "已计划", completed: "已完成", archived: "已归档", ready: "就绪", scheduled: "已安排" };
    return statusLabels[String(value)] ?? String(value);
  }
  if (key === "estimatedMinutes" || key === "durationMinutes" || key === "targetMinutes" || key === "duration") {
    const mins = Number(value);
    if (Number.isFinite(mins)) {
      return mins >= 60 ? `${Math.floor(mins / 60)}小时${mins % 60 ? `${mins % 60}分` : ""}` : `${mins}分钟`;
    }
  }
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean).slice(0, 3).join("；") || "（空）";
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * 从 payload 中提取可用于标题的文本，跳过 ID / 引用字段。
 * @param payload - 操作 payload
 */
function collectReadablePayloadText(payload: Record<string, unknown>): string[] {
  const results: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (REF_KEY.test(key) || ID_KEY.test(key)) continue;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 1 && !looksLikeEntityId(trimmed)) results.push(trimmed);
      continue;
    }
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      const joined = value.map((entry) => entry.trim()).filter(Boolean).slice(0, 2).join("；");
      if (joined.length > 1) results.push(joined);
    }
  }
  return results;
}

/**
 * 根据 payload 结构推断实体类型（修正 AI 填错的 entity 字段）。
 * @param entity - 原始 entity 字符串
 * @param payload - 操作 payload
 */
export function inferChangeOperationLabel(entity: string, payload: Record<string, unknown>): string {
  if (payload.startsAt || payload.endsAt || payload.start || payload.end || payload.date || payload.time) return "日程";
  if (payload.recurrenceRule || payload.recurrence || payload.minimumVersion) {
    if (!payload.completionCriteria && !payload.estimatedMinutes && !payload.intent) return "Routine";
  }
  if (payload.completionCriteria || payload.estimatedMinutes || payload.intent || payload.suggestedSteps) return "任务";
  if (payload.description && !payload.title && !payload.name && !payload.position && !payload.recurrenceRule) return "结果";

  const name = entity.toLowerCase();
  if (name.includes("outcome")) return "结果";
  if (name.includes("milestone")) return "里程碑";
  if (name.includes("task")) return "任务";
  if (name.includes("routine")) return "Routine";
  if (name.includes("schedule")) return "日程";
  if (name.includes("goal")) return "目标";
  return "变更";
}

/**
 * 解析变更操作的实体类型中文标签。
 * @param entity - 操作实体类型字符串
 * @param payload - 可选 payload，用于结构推断
 */
export function resolveChangeOperationLabel(entity: string, payload?: Record<string, unknown>): string {
  if (payload) return inferChangeOperationLabel(entity, payload);
  return inferChangeOperationLabel(entity, {});
}

/**
 * 从目标列表中按 ID 查找子实体标题。
 * @param goals - 目标列表
 * @param entityId - 实体 ID
 * @param kind - 实体种类
 */
function lookupGoalChildTitle(goals: Goal[], entityId: string, kind: "task" | "routine" | "milestone"): string | undefined {
  for (const goal of goals) {
    if (kind === "task") {
      const task = goal.tasks?.find((entry) => entry.id === entityId);
      if (task?.title) return task.title;
    }
    if (kind === "routine") {
      const routine = goal.routines?.find((entry) => entry.id === entityId);
      if (routine?.title) return routine.title;
    }
    if (kind === "milestone") {
      const milestone = goal.milestones?.find((entry) => entry.id === entityId);
      if (milestone?.title) return milestone.title;
    }
  }
  return undefined;
}

/**
 * 为变更草案单条操作生成用户可读标题。
 * @param operation - 变更操作对象
 * @param goals - 当前目标列表
 * @param schedule - 当前日程列表
 * @param index - 操作在草案中的序号（用于兜底区分）
 */
export function resolveChangeOperationTitle(
  operation: Record<string, unknown>,
  goals: Goal[],
  schedule: ScheduleItem[],
  index = 0,
): string {
  const entity = String(operation.entity ?? "").toLowerCase();
  const payload = (operation.payload ?? operation.after ?? {}) as Record<string, unknown>;
  const before = (operation.before ?? {}) as Record<string, unknown>;
  const entityId = typeof operation.entityId === "string" ? operation.entityId : "";
  const label = inferChangeOperationLabel(entity, payload);

  for (const key of ["title", "name", "label", "summary", "activity", "type"]) {
    const value = payload[key] ?? before[key];
    if (typeof value === "string" && value.trim() && !looksLikeEntityId(value.trim())) return value.trim();
  }

  const readable = collectReadablePayloadText(payload);
  if (readable.length) return readable[0];

  if (label === "日程") {
    const start = formatScheduleMoment(payload.startsAt ?? payload.start ?? payload.time);
    const end = formatScheduleMoment(payload.endsAt ?? payload.end);
    const date = payload.date ? String(payload.date) : undefined;
    if (start && end) return `${start} – ${end}`;
    if (date && start) return `${date} ${start}`;
    if (start) return String(start);
  }

  if (label === "Routine") {
    const rule = payload.recurrenceRule ?? payload.recurrence;
    if (typeof rule === "string" && rule.trim()) return humanizeRecurrenceRule(rule);
    if (typeof payload.minimumVersion === "string" && payload.minimumVersion.trim()) return payload.minimumVersion.trim();
  }

  if (label === "任务") {
    if (typeof payload.intent === "string" && payload.intent.trim()) return payload.intent.trim();
    if (Array.isArray(payload.completionCriteria) && payload.completionCriteria[0]) return String(payload.completionCriteria[0]);
  }

  if (label === "结果" && typeof payload.description === "string" && payload.description.trim()) {
    return payload.description.trim();
  }

  if (label === "里程碑" && typeof payload.description === "string" && payload.description.trim()) {
    return payload.description.trim();
  }

  if (entity.includes("goal") && entityId) {
    const goal = goals.find((entry) => entry.id === entityId);
    if (goal?.title) return goal.title;
  }

  if (entityId) {
    if (entity.includes("schedule") || label === "日程") {
      const block = schedule.find((entry) => entry.id === entityId);
      if (block?.title) return block.title;
    }
    const childKind = entity.includes("task") || label === "任务" ? "task" : entity.includes("routine") || label === "Routine" ? "routine" : entity.includes("milestone") || label === "里程碑" ? "milestone" : null;
    if (childKind) {
      const title = lookupGoalChildTitle(goals, entityId, childKind);
      if (title) return title;
    }
  }

  if (typeof payload.position === "number" || typeof payload.position === "string") {
    return `${label} ${Number(payload.position) + 1}`;
  }

  if (operation.type === "update") return `更新${label}`;
  if (operation.type === "archive") return `归档${label}`;
  return `${label} ${index + 1}`;
}

/**
 * 根据 payload 结构推断标准 entity 字符串（修正 AI 填错的 entity 字段）。
 * @param entity - 原始 entity 字符串
 * @param payload - 操作 payload
 */
export function inferChangeOperationEntity(entity: string, payload: Record<string, unknown>): string {
  const label = inferChangeOperationLabel(entity, payload);
  if (label === "日程") return "schedule";
  if (label === "Routine") return "routine";
  if (label === "任务") return "task";
  if (label === "里程碑") return "milestone";
  if (label === "结果") return "outcome";
  if (label === "目标") return "goal";
  return entity.toLowerCase() || "item";
}

/**
 * 将 Agent 提交的变更 payload 规范化为系统 schema 字段（name→title、dueDate→targetDate 等）。
 * 写入数据库前必须调用，避免落库为「新里程碑 / 新 Routine」等占位值。
 * @param entity - 实体类型字符串
 * @param payload - 原始 payload 或 after 对象
 */
export function normalizeAgentChangePayload(entity: string, payload: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...payload };
  const name = entity.toLowerCase();

  if (!normalized.title && typeof normalized.name === "string" && normalized.name.trim()) {
    normalized.title = normalized.name.trim();
  }
  if (!normalized.title && typeof normalized.label === "string" && normalized.label.trim()) {
    normalized.title = normalized.label.trim();
  }
  if (!normalized.title && typeof normalized.activity === "string" && normalized.activity.trim()) {
    normalized.title = normalized.activity.trim();
  }

  if (!normalized.targetDate && typeof normalized.dueDate === "string") {
    normalized.targetDate = normalized.dueDate;
  }

  if (!normalized.description && typeof normalized.summary === "string" && normalized.summary.trim()) {
    normalized.description = normalized.summary.trim();
  }

  if (name.includes("routine") && normalized.targetMinutes !== undefined && normalized.durationMinutes === undefined) {
    normalized.durationMinutes = normalized.targetMinutes;
  }

  if (name.includes("routine") && normalized.schedule && typeof normalized.schedule === "object") {
    const schedule = normalized.schedule as Record<string, unknown>;
    const time = typeof schedule.time === "string" ? schedule.time : "";
    const days = Array.isArray(schedule.daysOfWeek) ? schedule.daysOfWeek.map(Number).filter(Number.isFinite) : [];
    const dayTokens = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    const byDay = days.map((day) => dayTokens[day] ?? "").filter(Boolean).join(",");
    const timeRange = time.match(/^([01]\d|2[0-3]):([0-5]\d)\s*[-–]\s*([01]\d|2[0-3]):([0-5]\d)$/);
    if (timeRange) {
      const [, startHour, startMinute, endHour, endMinute] = timeRange;
      normalized.preferredStartTime ??= `${startHour}:${startMinute}`;
      normalized.preferredEndTime ??= `${endHour}:${endMinute}`;
      normalized.preferredTimeOfDay ??= Number(startHour) < 12 ? "morning" : Number(startHour) < 18 ? "afternoon" : Number(startHour) < 22 ? "evening" : "night";
      const elapsed = (Number(endHour) * 60 + Number(endMinute) - Number(startHour) * 60 - Number(startMinute) + 1440) % 1440;
      if (normalized.durationMinutes === undefined && elapsed > 0) normalized.durationMinutes = elapsed;
      if (!normalized.recurrenceRule) normalized.recurrenceRule = `${byDay ? `FREQ=WEEKLY;BYDAY=${byDay}` : "FREQ=WEEKLY"};BYHOUR=${Number(startHour)};BYMINUTE=${Number(startMinute)}`;
    } else if (!normalized.recurrenceRule) {
      normalized.recurrenceRule = byDay ? `FREQ=WEEKLY;BYDAY=${byDay}` : "FREQ=WEEKLY";
    }
  }

  if (name.includes("outcome") && !normalized.description && typeof normalized.title === "string") {
    normalized.description = normalized.title;
  }

  return normalized;
}

/**
 * 补全 create 操作 payload 中缺失的可读 title，并修正 entity 类型。
 * @param operation - 原始变更操作
 * @param index - 操作序号
 */
export function enrichChangeOperation(operation: Record<string, unknown>, index = 0): Record<string, unknown> {
  const entity = inferChangeOperationEntity(String(operation.entity ?? ""), (operation.payload ?? operation.after ?? {}) as Record<string, unknown>);
  const source = (operation.payload ?? operation.after ?? {}) as Record<string, unknown>;
  const payload = normalizeAgentChangePayload(entity, source);

  if (!payload.title || (typeof payload.title === "string" && !payload.title.trim())) {
    const readable = collectReadablePayloadText(payload);
    if (readable[0]) payload.title = readable[0];
  }

  if (!payload.title || (typeof payload.title === "string" && !payload.title.trim())) {
    if (entity.includes("schedule")) {
      const start = formatScheduleMoment(payload.startsAt ?? payload.start ?? payload.time);
      const end = formatScheduleMoment(payload.endsAt ?? payload.end);
      if (start && end) payload.title = `${start} – ${end}`;
      else if (start) payload.title = start;
    } else if (entity.includes("routine")) {
      const rule = payload.recurrenceRule ?? payload.recurrence;
      if (typeof rule === "string" && rule.trim()) payload.title = humanizeRecurrenceRule(rule);
    } else if (entity.includes("outcome") && typeof payload.description === "string") {
      payload.title = payload.description.trim();
    } else if (entity.includes("milestone") && typeof payload.description === "string") {
      payload.title = payload.description.trim();
    }
  }

  if (!payload.title || (typeof payload.title === "string" && !payload.title.trim())) {
    const label = inferChangeOperationLabel(entity, payload);
    payload.title = typeof payload.position === "number" || typeof payload.position === "string"
      ? `${label} ${Number(payload.position) + 1}`
      : `${label} ${index + 1}`;
  }

  if (operation.type === "create") return { ...operation, entity, payload };
  return { ...operation, entity, ...(operation.payload ? { payload } : {}), ...(operation.after ? { after: payload } : {}) };
}

/**
 * 批量补全变更草案操作的可读字段。
 * @param operations - 原始操作列表
 */
export function enrichChangeOperations(operations: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return operations.map((operation, index) => enrichChangeOperation(operation, index));
}

/**
 * 列出 create/update 操作中应展示的关键字段。
 * @param operation - 变更操作对象
 * @param goals - 目标列表
 * @param schedule - 日程列表
 */
export function resolveChangeOperationFields(
  operation: Record<string, unknown>,
  goals: Goal[],
  schedule: ScheduleItem[],
): Array<{ label: string; value: string }> {
  const payload = (operation.payload ?? operation.after ?? {}) as Record<string, unknown>;
  const priority = ["title", "name", "description", "summary", "intent", "startsAt", "endsAt", "start", "end", "date", "time", "recurrenceRule", "minimumVersion", "estimatedMinutes", "targetDate", "dayOfWeek", "frequency", "activity", "type", "goalId", "taskId", "routineId", "status", "category", "position"];
  const entries = Object.entries(payload).filter(([key, value]) => !REF_KEY.test(key) && value !== null && value !== undefined && value !== "");
  entries.sort((a, b) => {
    const ai = priority.indexOf(a[0]);
    const bi = priority.indexOf(b[0]);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  return entries.slice(0, 6).map(([key, value]) => ({
    label: FIELD_LABELS[key] ?? key,
    value: formatChangeOperationFieldValue(key, value, goals, schedule),
  })).filter((field) => field.value !== "（空）");
}
