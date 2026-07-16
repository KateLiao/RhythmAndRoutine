import type { ToolResult } from "./types";

/** 处理步骤展开详情，面向用户展示检查范围、结果与判断。 */
export type ToolStepDetail = {
  scope?: string;
  result?: string;
  judgment?: string;
  nextAction?: string;
  inputSummary?: string;
  inputPreview?: string;
  rawInputJson?: string;
  toolName?: string;
};

const SENSITIVE_KEY = /(token|secret|password|authorization|api[_-]?key|credential)/i;
const MAX_STRING = 500;
const MAX_ARRAY = 20;
const MAX_JSON_CHARS = 4_000;

const TOOL_LABELS: Record<string, string> = {
  read_goal_context: "参考目标与 Routine 设定",
  read_schedule_window: "检查今天的日程安排",
  read_similar_schedule_history: "参考往常的安排时间",
  validate_schedule_candidates: "核对候选时间是否空闲",
  read_execution_history: "回顾最近的执行记录",
  read_recent_reviews: "回顾最近的日/周回顾",
  read_rhythm_signals: "参考节奏信号",
  propose_planning: "整理规划方案",
  propose_change_set: "整理变更方案",
  read_routine: "检查重复安排规则",
  delete_schedule: "更新日程安排",
  create_schedule: "添加新的日程安排",
  query_tasks: "检查相关任务",
  write_execution_record: "记录本次处理结果",
};

/**
 * 将 Agent 工具内部名称映射为已完成步骤的用户可读标题。
 * @param tool - 工具注册名，例如 `read_goal_context`
 * @returns 面向用户展示的处理步骤标题
 */
export function toolDisplayLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? "处理相关信息";
}

/**
 * 生成工具执行中的状态文案（「正在……」）。
 * @param tool - 工具注册名
 * @returns 进行中的用户可读描述
 */
export function toolProcessingLabel(tool: string): string {
  const label = toolDisplayLabel(tool);
  if (label.startsWith("检查") || label.startsWith("回顾") || label.startsWith("参考")) {
    return `正在${label.slice(0, 2)}${label.slice(2)}`;
  }
  return `正在${label}`;
}

/**
 * 格式化 ISO 日期为用户可读的简短日期。
 * @param iso - ISO 时间字符串
 * @param timeZone - 用户时区
 */
function formatShortDate(iso: string, timeZone = "Asia/Shanghai"): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short", timeZone }).format(date);
}

/**
 * 从目标上下文中提取 Routine 摘要。
 * @param data - read_goal_context 返回的数据
 */
function summarizeRoutines(data: unknown): string | null {
  const goals = Array.isArray(data) ? data : data ? [data] : [];
  const routines: string[] = [];
  for (const item of goals) {
    const goal = item as { title?: string; routines?: Array<{ title?: string; recurrenceRule?: string }> };
    for (const routine of goal.routines ?? []) {
      const title = routine.title ?? "未命名 Routine";
      routines.push(goal.title ? `${goal.title} · ${title}` : title);
    }
  }
  if (!routines.length) return null;
  if (routines.length === 1) return `找到 Routine：${routines[0]}`;
  return `找到 ${routines.length} 条 Routine 规则`;
}

/**
 * 根据工具执行结果生成简短摘要，供对话面板默认展示。
 * @param tool - 工具注册名
 * @param result - 工具返回结果
 * @returns 一行以内的结果摘要；失败时返回错误说明
 */
export function summarizeToolResult(tool: string, result: ToolResult): string {
  if (!result.ok) return result.message;

  const data = result.data;
  if (tool === "read_goal_context") {
    const routineHint = summarizeRoutines(data);
    if (routineHint) return routineHint;
    if (Array.isArray(data)) {
      if (data.length === 1) {
        const title = (data[0] as { title?: string }).title;
        return title ? `已参考目标「${title}」` : "已参考当前目标";
      }
      return `已参考 ${data.length} 个目标`;
    }
    if (data && typeof data === "object" && "title" in data) {
      return `已参考目标「${String((data as { title: string }).title)}」`;
    }
    return "已参考目标设定";
  }
  if (tool === "read_schedule_window") {
    const payload = data as { itemCount?: number; items?: Array<{ blockKind?: string; title?: string }> };
    const items = Array.isArray(data) ? data as Array<{ blockKind?: string; title?: string }> : payload.items ?? [];
    const count = Array.isArray(data) ? data.length : payload.itemCount ?? items.length;
    if (!count) return "当前窗口暂无已安排的日程";
    const personal = items.filter((item) => item.blockKind === "personal").length;
    const goalTask = items.filter((item) => item.blockKind === "goal_task").length;
    const routine = items.filter((item) => item.blockKind === "routine_occurrence").length;
    const parts = [`共 ${count} 条`];
    if (personal) parts.push(`${personal} 条个人占位`);
    if (goalTask) parts.push(`${goalTask} 条目标日程`);
    if (routine) parts.push(`${routine} 条 Routine 实例`);
    return `找到 ${parts.join("，")}`;
  }
  if (tool === "read_execution_history") {
    const count = Array.isArray(data) ? data.length : 0;
    return count ? `找到 ${count} 条相关记录` : "暂无近期执行记录";
  }
  if (tool === "read_similar_schedule_history") {
    const payload = data as { sampleCount?: number; typicalStartTime?: string | null; matchedTier?: string | null };
    if (!payload.sampleCount) return "没有找到可参考的相似安排";
    const precision = payload.matchedTier === "exact" ? "精确匹配" : payload.matchedTier === "related" ? "核心对象匹配" : "宽泛匹配";
    return payload.typicalStartTime
      ? `${precision} ${payload.sampleCount} 次，通常约 ${payload.typicalStartTime} 开始`
      : `${precision} ${payload.sampleCount} 次相似安排`;
  }
  if (tool === "validate_schedule_candidates") {
    const payload = data as { allAvailable?: boolean; candidates?: unknown[] };
    const count = payload.candidates?.length ?? 0;
    return payload.allAvailable ? `${count} 个候选时间均无冲突` : `${count} 个候选时间中存在冲突`;
  }
  if (tool === "read_recent_reviews") {
    const count = Array.isArray(data) ? data.length : 0;
    return count ? `找到 ${count} 份回顾` : "暂无近期回顾";
  }
  if (tool === "read_rhythm_signals") {
    const count = Array.isArray(data) ? data.length : 0;
    return count ? `参考了 ${count} 条节奏信号` : "暂无可用节奏信号";
  }
  if (tool === "propose_planning" || tool === "propose_change_set") {
    const payload = data as { changeSetId?: string; status?: string };
    return payload.status === "awaiting_confirmation" ? "方案已整理好，等待你确认" : "方案已保存";
  }
  return "已完成";
}

/**
 * 根据工具执行结果生成展开详情，不暴露原始 JSON 或技术字段。
 * @param tool - 工具注册名
 * @param result - 工具返回结果
 * @param input - 可选工具入参，用于补充检查范围
 * @param timeZone - 用户时区，用于格式化日期
 */
export function buildToolStepDetail(
  tool: string,
  result: ToolResult,
  input?: Record<string, unknown>,
  timeZone = "Asia/Shanghai",
): ToolStepDetail {
  if (!result.ok) {
    return { result: result.message, judgment: "这一步未能顺利完成，小律会尝试用其他方式继续处理。" };
  }

  const data = result.data;

  if (tool === "read_schedule_window") {
    const from = typeof input?.from === "string" ? input.from : undefined;
    const to = typeof input?.to === "string" ? input.to : undefined;
    const payload = data as { itemCount?: number; busyIntervals?: unknown[]; availableIntervals?: unknown[] };
    const count = Array.isArray(data) ? data.length : payload.itemCount ?? 0;
    const scope = from && to
      ? `检查范围：${formatShortDate(from, timeZone)} 至 ${formatShortDate(to, timeZone)} 的日程`
      : "检查范围：当前时间窗口内的日程安排";
    const resultText = count
      ? `检查结果：共找到 ${count} 条有效日程，形成 ${payload.busyIntervals?.length ?? count} 个忙碌区间。`
      : "检查结果：该时间窗口内暂无已写入日历的具体日程。";
    const judgment = count
      ? "日程块含 blockKind：personal=个人占位，goal_task=目标推进，routine_occurrence=Routine 展开实例；调整时请用匹配的 entity。"
      : "你提到的时间可能来自 Routine 规则、目标设定，或尚未创建的临时计划。";
    return { scope, result: resultText, judgment };
  }

  if (tool === "read_goal_context") {
    const routineHint = summarizeRoutines(data);
    const goalCount = Array.isArray(data) ? data.length : data ? 1 : 0;
    const scope = input?.goalId ? "检查范围：当前选中目标及其 Routine、任务设定" : "检查范围：活跃目标与 Routine 设定";
    const resultText = routineHint ?? (goalCount ? `检查结果：共参考 ${goalCount} 个目标。` : "检查结果：未找到相关目标数据。");
    const judgment = routineHint
      ? "Routine 规则会按重复模式生成日程，不等同于某一天已安排的具体事件。"
      : undefined;
    return { scope, result: resultText, judgment };
  }

  if (tool === "read_execution_history") {
    const count = Array.isArray(data) ? data.length : 0;
    const days = typeof input?.days === "number" ? input.days : 28;
    return {
      scope: `检查范围：最近 ${days} 天的执行记录与反馈`,
      result: count ? `检查结果：找到 ${count} 条执行记录。` : "检查结果：近期暂无执行记录。",
      judgment: count ? "这些记录可帮助判断你近期的真实投入与完成情况。" : undefined,
    };
  }

  if (tool === "read_similar_schedule_history") {
    const payload = data as { sampleCount?: number; typicalStartTime?: string | null; typicalDurationMinutes?: number | null; matchedTier?: string | null; attempts?: Array<{ level: string; sampleCount: number }> };
    const query = typeof input?.query === "string" ? input.query : "相似活动";
    const precision = payload.matchedTier === "exact" ? "完整活动语义" : payload.matchedTier === "related" ? "核心对象" : payload.matchedTier === "broad" ? "宽泛活动类别" : "未匹配";
    return {
      scope: `检查范围：过去相似的「${query}」安排`,
      result: payload.sampleCount
        ? `检查结果：通过${precision}找到 ${payload.sampleCount} 次参考；通常约 ${payload.typicalStartTime ?? "相近时段"} 开始，持续 ${payload.typicalDurationMinutes ?? "未知"} 分钟。`
        : "检查结果：没有找到可参考的相似安排。",
      judgment: payload.sampleCount ? "查询只在上一层零结果时放宽；历史习惯只用于候选排序，本次候选仍需单独检查日程冲突并验证。" : undefined,
    };
  }

  if (tool === "validate_schedule_candidates") {
    const payload = data as { allAvailable?: boolean; candidates?: Array<{ available?: boolean; conflicts?: Array<{ title?: string }> }> };
    const conflicts = payload.candidates?.flatMap((candidate) => candidate.conflicts ?? []).map((item) => item.title).filter(Boolean) ?? [];
    return {
      scope: `检查范围：${payload.candidates?.length ?? 0} 个最终候选时段`,
      result: payload.allAvailable ? "检查结果：所有候选时段均无日程重叠。" : `检查结果：存在冲突${conflicts.length ? `（${[...new Set(conflicts)].join("、")}）` : ""}。`,
      judgment: payload.allAvailable ? "这些具体候选可以进入文字建议或 ChangeSet。" : "必须调整冲突候选并重新校验，不能称为可用时段。",
    };
  }

  if (tool === "read_recent_reviews") {
    const count = Array.isArray(data) ? data.length : 0;
    return {
      scope: "检查范围：最近的日回顾与周回顾",
      result: count ? `检查结果：找到 ${count} 份回顾。` : "检查结果：暂无近期回顾。",
    };
  }

  if (tool === "read_rhythm_signals") {
    const count = Array.isArray(data) ? data.length : 0;
    return {
      scope: "检查范围：从真实执行中提取的节奏信号",
      result: count ? `检查结果：参考了 ${count} 条节奏信号。` : "检查结果：暂无可用节奏信号。",
      judgment: count ? "节奏信号反映你近期的精力与专注模式，可用于调整安排。" : undefined,
    };
  }

  if (tool === "propose_planning" || tool === "propose_change_set") {
    const payload = data as { status?: string };
    return {
      scope: "处理范围：根据当前对话整理变更方案",
      result: payload.status === "awaiting_confirmation" ? "检查结果：方案已生成，尚未写入正式计划。" : "检查结果：方案已保存。",
      nextAction: payload.status === "awaiting_confirmation" ? "请你在下方确认或拒绝这份草案。" : undefined,
    };
  }

  return { result: summarizeToolResult(tool, result) };
}

/**
 * 递归脱敏并限长工具入参，供前端展开层展示。
 * @param value - 原始入参
 * @param depth - 递归深度
 */
export function sanitizeToolInput(value: unknown, depth = 0): unknown {
  if (depth > 6) return "…";
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const sliced = value.slice(0, MAX_ARRAY).map((item) => sanitizeToolInput(item, depth + 1));
    if (value.length > MAX_ARRAY) sliced.push(`…另有 ${value.length - MAX_ARRAY} 项`);
    return sliced;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? "•••" : sanitizeToolInput(entry, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * 将脱敏后的入参格式化为限长 JSON 字符串。
 * @param input - 工具入参
 */
export function formatToolInputPreview(input: unknown): string {
  try {
    const text = JSON.stringify(sanitizeToolInput(input), null, 2);
    if (text.length <= MAX_JSON_CHARS) return text;
    return `${text.slice(0, MAX_JSON_CHARS)}\n…（已截断）`;
  } catch {
    return "无法序列化的参数";
  }
}

/**
 * 生成工具入参的一行人类可读摘要。
 * @param tool - 工具注册名
 * @param input - 工具入参
 */
export function summarizeToolInput(tool: string, input: unknown): string {
  const data = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (tool === "read_schedule_window") {
    const from = typeof data.from === "string" ? data.from.slice(0, 10) : undefined;
    const to = typeof data.to === "string" ? data.to.slice(0, 10) : undefined;
    if (from && to) return `时间范围 ${from} → ${to}`;
    return "查询日程时间窗口";
  }
  if (tool === "read_goal_context") {
    if (typeof data.goalId === "string" && data.goalId) return `目标 ${data.goalId.slice(0, 8)}…`;
    return "当前活跃目标与 Routine";
  }
  if (tool === "read_execution_history") {
    const days = typeof data.days === "number" ? data.days : 28;
    return `最近 ${days} 天执行记录`;
  }
  if (tool === "read_similar_schedule_history") {
    const query = typeof data.query === "string" ? data.query : "关联活动";
    const days = typeof data.days === "number" ? data.days : 90;
    return `过去 ${days} 天 · ${query}`;
  }
  if (tool === "validate_schedule_candidates") {
    const count = Array.isArray(data.candidates) ? data.candidates.length : 0;
    return `核对 ${count} 个具体候选时段`;
  }
  if (tool === "read_recent_reviews") {
    const limit = typeof data.limit === "number" ? data.limit : 4;
    return `最近 ${limit} 份回顾`;
  }
  if (tool === "read_rhythm_signals") {
    const limit = typeof data.limit === "number" ? data.limit : 12;
    return `最多 ${limit} 条节奏信号`;
  }
  if (tool === "propose_planning" || tool === "propose_change_set") {
    return "根据对话整理变更草案";
  }
  const keys = Object.keys(data);
  if (!keys.length) return "无额外参数";
  return keys.slice(0, 3).map((key) => `${key}`).join("、") + (keys.length > 3 ? "…" : "");
}
