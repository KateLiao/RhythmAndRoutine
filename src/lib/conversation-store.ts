/**
 * 对话历史本地存储模块（基于 localStorage）。
 *
 * 设计原则：
 * - 单用户 MVP 使用 localStorage，无需 DB 迁移
 * - 支持"清空上下文"：消息仍然可见，但不再装载到 Agent 调用中
 * - 滑动窗口：最近 CONTEXT_WINDOW_TURNS 轮完整对话进入上下文；超出部分截断
 * - 最多保留 300 条消息，自动截断旧消息
 */

const STORAGE_KEY = "rr.conversation.v1";

/** 装载进 Agent 上下文的最大对话轮数（1 轮 = 1 用户 + 1 助手） */
export const CONTEXT_WINDOW_TURNS = 6;

/** 持久化的单条 Agent 处理步骤（与 UI 层 AgentProcessStep 结构兼容） */
export type StoredProcessStep = {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "failed" | "confirm";
  summary?: string;
  detail?: {
    scope?: string;
    result?: string;
    judgment?: string;
    nextAction?: string;
    missingInformation?: string[];
  };
};

/** 单条存储消息 */
export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** ISO 8601 时间戳，用于与 contextClearedAt 比较 */
  timestamp: string;
  /** Agent 处理过程步骤，仅 assistant 消息可能有；用于回看与调试 */
  processSteps?: StoredProcessStep[];
};

/** Agent 上下文范围：用于检测目标切换并自动隔离历史对话 */
export type ContextScope = {
  view?: string;
  goalId?: string | null;
};

type ConversationData = {
  messages: StoredMessage[];
  /**
   * 清空上下文的时间戳（ISO）。
   * 此时间戳 *之前* 的消息不会被装载到 Agent 上下文中，但仍然展示给用户。
   */
  contextClearedAt?: string;
  /** 最近一次 Agent 调用时的页面/目标范围 */
  contextScope?: ContextScope;
};

// ---------- 内部读写 ----------

function load(): ConversationData {
  if (typeof window === "undefined") return { messages: [] };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { messages: [] };
    return JSON.parse(raw) as ConversationData;
  } catch {
    return { messages: [] };
  }
}

function save(data: ConversationData): void {
  if (typeof window === "undefined") return;
  try {
    const trimmed: ConversationData = { ...data, messages: data.messages.slice(-300) };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // localStorage 不可用（隐私模式等）时静默失败
  }
}

// ---------- 公共 API ----------

/**
 * 加载所有已存储的消息（含已清空上下文前的旧消息）。
 */
export function loadMessages(): StoredMessage[] {
  return load().messages;
}

/**
 * 将内存中的处理步骤序列化为可持久化格式。
 * 进行中的步骤在落盘时标记为已完成，避免刷新后仍显示「处理中」。
 * @param steps - UI 层的处理步骤列表
 */
export function serializeProcessSteps(steps?: StoredProcessStep[]): StoredProcessStep[] | undefined {
  if (!steps?.length) return undefined;
  return steps.map((step) => ({
    ...step,
    status: step.status === "running" ? "done" : step.status,
  }));
}

/**
 * 追加新消息到持久化存储。
 * @param newMessages - 要追加的消息数组
 */
export function appendMessages(newMessages: StoredMessage[]): void {
  const data = load();
  save({ ...data, messages: [...data.messages, ...newMessages] });
}

/**
 * 清空上下文：将当前时间记录为"清空时间"，之前的消息不再装载到 Agent 上下文。
 * @returns ISO 时间戳，表示清空时刻
 */
export function clearContext(): string {
  const data = load();
  const clearedAt = new Date().toISOString();
  save({ ...data, contextClearedAt: clearedAt });
  return clearedAt;
}

/**
 * 获取当前"清空上下文"时间戳，不存在则返回 undefined。
 */
export function getContextClearedAt(): string | undefined {
  return load().contextClearedAt;
}

/**
 * 同步 Agent 上下文范围；当用户切换到不同目标时，自动清空可装载的对话历史。
 * @param scope - 当前页面视图与选中目标
 * @returns 最新的清空时间戳，以及是否发生了范围变化
 */
export function syncContextScope(scope: ContextScope): { clearedAt?: string; scopeChanged: boolean } {
  const data = load();
  const prev = data.contextScope;

  if (prev?.goalId === scope.goalId && prev?.view === scope.view) {
    return { clearedAt: data.contextClearedAt, scopeChanged: false };
  }

  const hasInContextMessages = data.messages.some(
    (message) => !data.contextClearedAt || message.timestamp > data.contextClearedAt,
  );
  const goalChanged = prev !== undefined && prev.goalId !== scope.goalId;
  const isFirstScope = prev === undefined;
  const shouldAutoClear = hasInContextMessages && (goalChanged || (isFirstScope && scope.goalId != null));

  if (shouldAutoClear) {
    const clearedAt = new Date().toISOString();
    save({ ...data, contextClearedAt: clearedAt, contextScope: scope });
    return { clearedAt, scopeChanged: true };
  }

  save({ ...data, contextScope: scope });
  return { clearedAt: data.contextClearedAt, scopeChanged: true };
}

/**
 * 获取应该装载到 Agent 上下文中的消息列表（已考虑清空时间和滑动窗口）。
 * 返回格式与 API `messages` 字段兼容。
 *
 * @returns 最多 CONTEXT_WINDOW_TURNS * 2 条消息（最近 N 轮）
 */
export function getContextMessages(): Array<{ role: "user" | "assistant"; content: string }> {
  const data = load();
  let messages = data.messages;

  // 只取清空上下文时间之后的消息
  if (data.contextClearedAt) {
    messages = messages.filter((m) => m.timestamp > data.contextClearedAt!);
  }

  // 滑动窗口：只保留最近 N 轮对话
  const windowSize = CONTEXT_WINDOW_TURNS * 2;
  messages = messages.slice(-windowSize);

  return messages.map((m) => ({ role: m.role, content: m.text }));
}
