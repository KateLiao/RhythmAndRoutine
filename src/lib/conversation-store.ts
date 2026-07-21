/**
 * 对话 Session 本地存储（localStorage）。
 *
 * v2：仅保留当前 Session；支持清空边界（messageId）、异步摘要、Run/ChangeSet 关联；
 * 新建对话删除旧 Session。兼容一次性迁移旧版 rr.conversation.v1。
 */

const STORAGE_KEY_V1 = "rr.conversation.v1";
const STORAGE_KEY = "rr.conversation.v2";
const PANEL_EXPANDED_KEY = "rr.agent.panel.expanded";

/** 装载进 Agent 上下文的最大对话轮数（1 轮 = 1 用户 + 1 助手） */
export const CONTEXT_WINDOW_TURNS = 6;

/** 持久化的单条 Agent 处理步骤 */
export type StoredProcessStep = {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "failed" | "confirm" | "cancelled";
  summary?: string;
  detail?: {
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
};

/** 系统分隔线（清空上下文 / 切目标），不进入模型上下文 */
export type StoredBoundary = {
  id: string;
  kind: "context_clear" | "goal_switch";
  timestamp: string;
  afterMessageId?: string;
  label: string;
  detail?: string;
  /** 发送前可撤销的清空；发送后清除 */
  undoable?: boolean;
};

/** 单条存储消息 */
export type StoredMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: string;
  processSteps?: StoredProcessStep[];
  kind?: "welcome" | "boundary";
  boundary?: StoredBoundary;
};

export type ContextScope = {
  view?: string;
  goalId?: string | null;
};

export type ConversationSession = {
  id: string;
  revision: number;
  createdAt: string;
  messages: StoredMessage[];
  contextBoundaryMessageId?: string;
  summary?: string;
  summarizedThroughMessageId?: string;
  runIds: string[];
  /** Run 链只在当前上下文 revision 内续接；历史 run 仍保留用于展示和审计。 */
  runRevisions: Record<string, number>;
  activeRunId?: string;
  pendingChangeSetIds: string[];
  /** ChangeSet 只有在创建它的上下文 revision 内才会被自动续接；跨边界后仍保留为可见、可审批历史。 */
  pendingChangeSetRevisions: Record<string, number>;
  contextScope?: ContextScope;
};

type ConversationDataV2 = {
  version: 2;
  panelExpanded?: boolean;
  session: ConversationSession;
};

type ConversationDataV1 = {
  messages: StoredMessage[];
  contextClearedAt?: string;
  contextScope?: ContextScope;
};

// ---------- 内部读写 ----------

/**
 * 创建空 Session。
 */
function createEmptySession(): ConversationSession {
  return {
    id: crypto.randomUUID(),
    revision: 1,
    createdAt: new Date().toISOString(),
    messages: [],
    runIds: [],
    runRevisions: {},
    pendingChangeSetIds: [],
    pendingChangeSetRevisions: {},
  };
}

/**
 * 将 v1 扁平存储迁移为唯一当前 Session。
 * @param v1 - 旧版数据
 */
function migrateV1(v1: ConversationDataV1): ConversationDataV2 {
  const messages = (v1.messages ?? []).map((message) => ({
    ...message,
    id: message.id || crypto.randomUUID(),
  }));
  let contextBoundaryMessageId: string | undefined;
  if (v1.contextClearedAt) {
    const clearedAt = v1.contextClearedAt;
    let lastBefore: StoredMessage | undefined;
    for (const message of messages) {
      if (message.timestamp <= clearedAt) lastBefore = message;
      else break;
    }
    contextBoundaryMessageId = lastBefore?.id ?? messages[messages.length - 1]?.id;
  }
  return {
    version: 2,
    session: {
      ...createEmptySession(),
      messages: messages.slice(-300),
      contextBoundaryMessageId,
      contextScope: v1.contextScope,
    },
  };
}

/**
 * 从 localStorage 读取 v2 数据；必要时从 v1 迁移。
 */
function load(): ConversationDataV2 {
  if (typeof window === "undefined") {
    return { version: 2, session: createEmptySession() };
  }
  try {
    const rawV2 = localStorage.getItem(STORAGE_KEY);
    if (rawV2) {
      const parsed = JSON.parse(rawV2) as ConversationDataV2;
      if (parsed?.version === 2 && parsed.session?.id) {
        const revision = parsed.session.revision ?? 1;
        const runIds = parsed.session.runIds ?? [];
        const pendingChangeSetIds = parsed.session.pendingChangeSetIds ?? [];
        return {
          ...parsed,
          session: {
            ...createEmptySession(),
            ...parsed.session,
            messages: parsed.session.messages ?? [],
            runIds,
            runRevisions: parsed.session.runRevisions
              ?? Object.fromEntries(runIds.map((id) => [id, revision])),
            pendingChangeSetIds,
            pendingChangeSetRevisions: parsed.session.pendingChangeSetRevisions
              ?? Object.fromEntries(pendingChangeSetIds.map((id) => [id, revision])),
            revision,
          },
        };
      }
    }
    const rawV1 = localStorage.getItem(STORAGE_KEY_V1);
    if (rawV1) {
      const migrated = migrateV1(JSON.parse(rawV1) as ConversationDataV1);
      save(migrated);
      try {
        localStorage.removeItem(STORAGE_KEY_V1);
      } catch {
        /* ignore */
      }
      return migrated;
    }
  } catch {
    /* fall through */
  }
  return { version: 2, session: createEmptySession() };
}

/**
 * 持久化当前对话数据。
 * @param data - v2 结构
 */
function save(data: ConversationDataV2): void {
  if (typeof window === "undefined") return;
  try {
    const next: ConversationDataV2 = {
      ...data,
      session: {
        ...data.session,
        messages: data.session.messages.slice(-300),
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式等静默失败 */
  }
}

/**
 * 更新当前 Session 并落盘。
 * @param updater - 基于当前 Session 返回新 Session
 */
function updateSession(updater: (session: ConversationSession) => ConversationSession): ConversationSession {
  const data = load();
  const session = updater(data.session);
  save({ ...data, session });
  return session;
}

// ---------- 公共 API ----------

/**
 * 读取当前 Session 快照。
 */
export function getSession(): ConversationSession {
  return load().session;
}

/**
 * 加载当前 Session 全部消息（含界外与欢迎）。
 */
export function loadMessages(): StoredMessage[] {
  return load().session.messages;
}

/**
 * 将内存中的处理步骤序列化为可持久化格式。
 * @param steps - UI 层处理步骤
 */
export function serializeProcessSteps(steps?: StoredProcessStep[]): StoredProcessStep[] | undefined {
  if (!steps?.length) return undefined;
  return steps.map((step) => ({
    ...step,
    status: step.status === "running" ? "done" : step.status,
  }));
}

/**
 * 追加消息到当前 Session。
 * @param newMessages - 要追加的消息
 */
export function appendMessages(newMessages: StoredMessage[]): void {
  updateSession((session) => ({
    ...session,
    messages: [...session.messages, ...newMessages],
  }));
}

/**
 * 清空上下文：以最后一条消息为边界，bump revision，清除摘要。
 * @param options.label - 分隔线文案
 * @param options.detail - 补充说明
 * @param options.kind - 边界类型
 * @returns 边界信息（含可撤销）
 */
export function clearContext(options?: {
  label?: string;
  detail?: string;
  kind?: StoredBoundary["kind"];
  undoable?: boolean;
}): { boundary: StoredBoundary; revision: number; boundaryMessageId?: string } {
  const label = options?.label ?? "上方内容已移出上下文，小律接下来不会参考上面的对话";
  const kind = options?.kind ?? "context_clear";
  let result!: { boundary: StoredBoundary; revision: number; boundaryMessageId?: string };

  updateSession((session) => {
    const last = [...session.messages].reverse().find((message) => message.role !== "system" || message.kind !== "boundary");
    const boundaryMessageId = last?.id;
    const boundary: StoredBoundary = {
      id: crypto.randomUUID(),
      kind,
      timestamp: new Date().toISOString(),
      afterMessageId: boundaryMessageId,
      label,
      detail: options?.detail,
      undoable: options?.undoable ?? true,
    };
    const boundaryMessage: StoredMessage = {
      id: boundary.id,
      role: "system",
      text: label,
      timestamp: boundary.timestamp,
      kind: "boundary",
      boundary,
    };
    result = { boundary, revision: session.revision + 1, boundaryMessageId };
    return {
      ...session,
      revision: session.revision + 1,
      contextBoundaryMessageId: boundaryMessageId,
      summary: undefined,
      summarizedThroughMessageId: undefined,
      messages: [
        ...session.messages.map((message) =>
          message.kind === "boundary" && message.boundary?.undoable
            ? { ...message, boundary: { ...message.boundary, undoable: false } }
            : message,
        ),
        boundaryMessage,
      ],
    };
  });

  return result;
}

/**
 * 撤销尚未发送后生效的清空边界（仅 undoable 边界）。
 * @returns 是否成功撤销
 */
export function undoClearContext(): boolean {
  const session = load().session;
  const last = session.messages[session.messages.length - 1];
  if (!last || last.kind !== "boundary" || !last.boundary?.undoable) return false;

  updateSession((current) => {
    const messages = current.messages.slice(0, -1);
    const previousBoundary = [...messages].reverse().find((message) => message.kind === "boundary");
    const restoredRevision = current.revision + 1;
    const pendingChangeSetRevisions = Object.fromEntries(
      Object.entries(current.pendingChangeSetRevisions).map(([id, revision]) => [id, revision === current.revision - 1 ? restoredRevision : revision]),
    );
    const runRevisions = Object.fromEntries(
      Object.entries(current.runRevisions).map(([id, revision]) => [id, revision === current.revision - 1 ? restoredRevision : revision]),
    );
    return {
      ...current,
      revision: restoredRevision,
      contextBoundaryMessageId: previousBoundary?.boundary?.afterMessageId,
      summary: undefined,
      summarizedThroughMessageId: undefined,
      messages,
      runRevisions,
      pendingChangeSetRevisions,
    };
  });
  return true;
}

/**
 * 标记清空边界不可再撤销（用户已发送下一条消息后调用）。
 */
export function consumeClearUndo(): void {
  updateSession((session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.kind === "boundary" && message.boundary?.undoable
        ? { ...message, boundary: { ...message.boundary, undoable: false } }
        : message,
    ),
  }));
}

/**
 * 是否存在可撤销的清空边界。
 */
export function hasUndoableClear(): boolean {
  const last = load().session.messages.at(-1);
  return Boolean(last?.kind === "boundary" && last.boundary?.undoable);
}

/**
 * 获取上下文边界消息 id（此 id 及之前不装载）。
 */
export function getContextBoundaryMessageId(): string | undefined {
  return load().session.contextBoundaryMessageId;
}

/**
 * 同步上下文范围；仅当 selectedGoalId（goalId）变化时自动清空。
 * @param scope - 当前页面与目标
 * @param goalTitle - 新目标标题，用于边界文案
 */
export function syncContextScope(
  scope: ContextScope,
  goalTitle?: string | null,
): { cleared: boolean; goalChanged: boolean; boundary?: StoredBoundary } {
  const data = load();
  const prev = data.session.contextScope;
  const goalChanged = prev !== undefined && prev.goalId !== scope.goalId;
  const isFirstScope = prev === undefined;
  const shouldAutoClear =
    goalChanged || (isFirstScope && scope.goalId != null && data.session.messages.some((message) => message.role === "user"));

  if (!goalChanged && prev?.view === scope.view && prev?.goalId === scope.goalId) {
    return { cleared: false, goalChanged: false };
  }

  if (shouldAutoClear && (goalChanged || (isFirstScope && scope.goalId != null))) {
    const title = goalTitle?.trim() || "新目标";
    const leavingGoalContext = scope.goalId == null;
    const { boundary } = clearContext({
      kind: "goal_switch",
      undoable: false,
      label: leavingGoalContext
        ? "已离开目标上下文，上方对话不再作为上下文"
        : `已切换到「${title}」，上方对话不再作为上下文`,
      detail: leavingGoalContext
        ? "小律接下来不会默认关联任何目标；需要时请在消息中点名。"
        : "小律接下来会围绕当前目标理解你的请求。",
    });
    updateSession((session) => ({ ...session, contextScope: scope }));
    return { cleared: true, goalChanged: true, boundary };
  }

  updateSession((session) => ({ ...session, contextScope: scope }));
  return { cleared: false, goalChanged: goalChanged || isFirstScope };
}

/**
 * 获取应装载到 Agent 的消息（边界之后 + 滑动窗口，排除欢迎/分隔线）。
 */
export function getContextMessages(): Array<{ role: "user" | "assistant"; content: string }> {
  const session = load().session;
  const boundaryId = session.contextBoundaryMessageId;
  let started = !boundaryId;
  const collected: StoredMessage[] = [];

  for (const message of session.messages) {
    if (!started) {
      if (message.id === boundaryId) started = true;
      continue;
    }
    if (message.role === "user" || message.role === "assistant") {
      if (message.kind === "welcome") continue;
      collected.push(message);
    }
  }

  const windowSize = CONTEXT_WINDOW_TURNS * 2;
  return collected.slice(-windowSize).map((message) => ({
    role: message.role as "user" | "assistant",
    content: message.text,
  }));
}

/**
 * 获取当前对话摘要（若有）。
 */
export function getConversationSummary(): string | undefined {
  return load().session.summary;
}

/**
 * 统计边界内对话轮数（用于触发摘要）。
 */
export function countInContextTurns(): number {
  return Math.floor(getContextMessages().length / 2);
}

/**
 * 写入摘要（仅当 sessionId + revision 仍匹配时）。
 * @param input - 摘要写回参数
 */
export function applyConversationSummary(input: {
  sessionId: string;
  revision: number;
  summary: string;
  summarizedThroughMessageId: string;
}): boolean {
  const session = load().session;
  if (session.id !== input.sessionId || session.revision !== input.revision) return false;
  updateSession((current) => ({
    ...current,
    summary: input.summary.slice(0, 2000),
    summarizedThroughMessageId: input.summarizedThroughMessageId,
  }));
  return true;
}

/**
 * 规则降级摘要：界外用户要点 + 助手结论首句。
 * @param overflow - 滑出窗口的消息
 * @param priorSummary - 既有摘要
 */
export function buildRulesConversationSummary(
  overflow: Array<{ role: "user" | "assistant"; content: string }>,
  priorSummary?: string,
): string {
  const parts: string[] = [];
  if (priorSummary?.trim()) parts.push(priorSummary.trim());
  for (const message of overflow.slice(-8)) {
    const text = message.content.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (message.role === "user") parts.push(`用户：${text.slice(0, 120)}`);
    else parts.push(`小律：${text.slice(0, 80)}`);
  }
  return parts.join("\n").slice(0, 1800);
}

/**
 * 获取滑出窗口、需纳入摘要的消息。
 */
export function getOverflowMessagesForSummary(): {
  sessionId: string;
  revision: number;
  priorSummary?: string;
  overflow: Array<{ role: "user" | "assistant"; content: string; id: string }>;
  summarizedThroughMessageId?: string;
} {
  const session = load().session;
  const boundaryId = session.contextBoundaryMessageId;
  let started = !boundaryId;
  const collected: Array<{ role: "user" | "assistant"; content: string; id: string }> = [];

  for (const message of session.messages) {
    if (!started) {
      if (message.id === boundaryId) started = true;
      continue;
    }
    if ((message.role === "user" || message.role === "assistant") && message.kind !== "welcome") {
      collected.push({ role: message.role, content: message.text, id: message.id });
    }
  }

  const windowSize = CONTEXT_WINDOW_TURNS * 2;
  const overflow = collected.slice(0, Math.max(0, collected.length - windowSize));
  const through = overflow[overflow.length - 1]?.id;
  return {
    sessionId: session.id,
    revision: session.revision,
    priorSummary: session.summary,
    overflow,
    summarizedThroughMessageId: through,
  };
}

/**
 * 记录 Run 开始。
 * @param runId - AgentRun id
 */
export function trackRunStarted(runId: string): void {
  updateSession((session) => ({
    ...session,
    activeRunId: runId,
    runIds: session.runIds.includes(runId) ? session.runIds : [...session.runIds, runId],
    runRevisions: { ...session.runRevisions, [runId]: session.revision },
  }));
}

/**
 * 返回当前上下文 revision 内最近一次 Run，避免首页的新指令挂到旧目标运行链。
 */
export function getActiveParentRunId(): string | undefined {
  const session = load().session;
  return [...session.runIds].reverse().find((id) => session.runRevisions[id] === session.revision);
}

/**
 * 清除 activeRun（完成/失败/取消后）。
 * @param runId - 可选，仅当匹配时清除
 */
export function trackRunEnded(runId?: string): void {
  updateSession((session) => {
    if (runId && session.activeRunId && session.activeRunId !== runId) return session;
    return { ...session, activeRunId: undefined };
  });
}

/**
 * 关联待确认 ChangeSet 到当前 Session。
 * @param changeSetId - ChangeSet id
 */
export function trackPendingChangeSet(changeSetId: string): void {
  updateSession((session) => ({
    ...session,
    pendingChangeSetIds: session.pendingChangeSetIds.includes(changeSetId)
      ? session.pendingChangeSetIds
      : [...session.pendingChangeSetIds, changeSetId],
    pendingChangeSetRevisions: { ...session.pendingChangeSetRevisions, [changeSetId]: session.revision },
  }));
}

/**
 * 返回可在当前上下文中自动续接的最新待确认 ChangeSet。
 * 清空上下文或离开目标详情会 bump revision，因此旧草案不会影响新的首页指令。
 */
export function getActivePendingChangeSetId(): string | undefined {
  const session = load().session;
  return [...session.pendingChangeSetIds].reverse().find((id) => session.pendingChangeSetRevisions[id] === session.revision);
}

/**
 * 从 Session 移除已处理的 ChangeSet id。
 * @param changeSetId - ChangeSet id
 */
export function untrackPendingChangeSet(changeSetId: string): void {
  updateSession((session) => {
    const pendingChangeSetRevisions = { ...session.pendingChangeSetRevisions };
    delete pendingChangeSetRevisions[changeSetId];
    return {
      ...session,
      pendingChangeSetIds: session.pendingChangeSetIds.filter((id) => id !== changeSetId),
      pendingChangeSetRevisions,
    };
  });
}

/**
 * 新建对话：丢弃旧 Session，创建空 Session（欢迎消息由 UI 写入）。
 * @returns 新 Session
 */
export function startNewSession(): ConversationSession {
  const data = load();
  const session = createEmptySession();
  save({ ...data, session });
  return session;
}

/**
 * 读取/写入面板展开偏好。
 */
export function getPanelExpanded(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const fromStore = load().panelExpanded;
    if (typeof fromStore === "boolean") return fromStore;
    return localStorage.getItem(PANEL_EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * 持久化面板展开状态。
 * @param expanded - 是否展开
 */
export function setPanelExpanded(expanded: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(PANEL_EXPANDED_KEY, expanded ? "1" : "0");
    const data = load();
    save({ ...data, panelExpanded: expanded });
  } catch {
    /* ignore */
  }
}

/**
 * 判断消息是否在装载上下文之外（用于 UI 标记）。
 * 边界消息本身及其之前的消息均为界外。
 * @param messageId - 消息 id
 */
export function isMessageOutsideContext(messageId: string): boolean {
  const session = load().session;
  const boundaryId = session.contextBoundaryMessageId;
  if (!boundaryId) return false;
  let pastBoundary = false;
  for (const message of session.messages) {
    if (!pastBoundary) {
      if (message.id === messageId) return true;
      if (message.id === boundaryId) pastBoundary = true;
      continue;
    }
    if (message.id === messageId) return false;
  }
  return false;
}
