import { AgentContext, Capability, ContextReference } from "./types";
import { formatAgentTemporalAnchor } from "@/lib/timezone";
import { inferScheduleIntentHint } from "./infer-capability";

export type ContextDataSource = {
  getUser(userId: string): Promise<{ id: string; timezone: string; preferences: Record<string, unknown> }>;
  getGoalContext(userId: string, entityId?: string): Promise<{ data: unknown; references: ContextReference[] }>;
  getScheduleWindow(userId: string, days: number): Promise<{ data: unknown; references: ContextReference[] }>;
  getExecutionHistory(userId: string, days: number): Promise<{ data: unknown; references: ContextReference[] }>;
  getRecentReviews(userId: string, limit: number): Promise<{ data: unknown; references: ContextReference[] }>;
  getRhythmSignals(userId: string, limit: number): Promise<{ data: unknown; references: ContextReference[] }>;
};

const contextNeeds: Record<Capability, Array<"goals" | "schedule" | "executions" | "reviews" | "rhythmSignals">> = {
  goal_clarification: ["goals"],
  planning: ["goals", "schedule"],
  review: ["schedule", "executions", "reviews", "rhythmSignals"],
  adjustment: ["goals", "schedule", "executions", "reviews", "rhythmSignals"],
  progress_evaluation: ["goals", "executions", "reviews", "rhythmSignals"],
};

export class ContextBuilder {
  constructor(private readonly source: ContextDataSource) {}

  async build(input: {
    userId: string;
    capability: Capability;
    page?: AgentContext["page"];
    recentMessages?: AgentContext["conversation"]["recentMessages"];
    conversationSummary?: string;
  }): Promise<AgentContext> {
    const user = await this.source.getUser(input.userId);
    const needs = contextNeeds[input.capability];
    const business: Record<string, unknown> = {};
    const manifest: ContextReference[] = [];

    if (needs.includes("goals")) this.merge("goals", await this.source.getGoalContext(input.userId, input.page?.selectedEntity?.entityId), business, manifest);
    if (needs.includes("schedule")) this.merge("schedule", await this.source.getScheduleWindow(input.userId, 14), business, manifest);
    if (needs.includes("executions")) this.merge("executions", await this.source.getExecutionHistory(input.userId, 28), business, manifest);
    if (needs.includes("reviews")) this.merge("reviews", await this.source.getRecentReviews(input.userId, 4), business, manifest);
    if (needs.includes("rhythmSignals")) this.merge("rhythmSignals", await this.source.getRhythmSignals(input.userId, 12), business, manifest);

    return {
      user,
      page: input.page,
      conversation: { recentMessages: input.recentMessages?.slice(-12) ?? [], summary: input.conversationSummary },
      business,
      manifest,
    };
  }

  private merge(key: string, chunk: { data: unknown; references: ContextReference[] }, business: Record<string, unknown>, manifest: ContextReference[]) {
    business[key] = chunk.data;
    manifest.push(...chunk.references);
  }
}

/**
 * 为 Agent system prompt 生成精简业务上下文摘要，避免每轮重复发送完整 JSON 占用 Token。
 * 详细数据应通过 read_* 工具按需读取。
 * @param business - ContextBuilder 装配的业务数据块
 * @param page - 可选页面上下文（含用户当前选中的实体）
 */
export function summarizeBusinessForPrompt(
  business: Record<string, unknown>,
  page?: AgentContext["page"],
): string {
  const lines: string[] = [];
  const goals = business.goals;
  const goalList = Array.isArray(goals) ? goals : [];

  if (page?.selectedEntity?.entityType === "goal") {
    const selectedId = page.selectedEntity.entityId;
    const selected = goalList.find((item) => (item as Record<string, unknown>).id === selectedId) as Record<string, unknown> | undefined;
    const title = typeof selected?.title === "string" ? selected.title : undefined;
    if (title) {
      lines.push(`【当前聚焦目标】「${title}」（id: ${selectedId}）。本轮对话只围绕此目标；若历史消息提到其他目标，以本目标为准。`);
    } else {
      lines.push(`当前选中：goal ${selectedId}（${page.selectedEntity.reason}）`);
    }
  }

  if (goalList.length) {
    const brief = goalList.slice(0, 8).map((item) => {
      const goal = item as Record<string, unknown>;
      const title = typeof goal.title === "string" ? goal.title : "未命名目标";
      const status = typeof goal.status === "string" ? goal.status : "unknown";
      return `${goal.id ?? "?"}:${title}(${status})`;
    }).join("；");
    lines.push(`目标 ${goalList.length} 个：${brief}。详情请用 read_goal_context。`);
  }

  for (const [key, tool] of [
    ["schedule", "read_schedule_window"],
    ["executions", "read_execution_history"],
    ["reviews", "read_recent_reviews"],
    ["rhythmSignals", "read_rhythm_signals"],
  ] as const) {
    const chunk = business[key];
    if (Array.isArray(chunk) && chunk.length) {
      lines.push(`${key} 已缓存 ${chunk.length} 条，详情请用 ${tool}。`);
    }
  }

  return lines.length ? lines.join("\n") : "业务详情请通过授权工具按需读取。";
}

/**
 * 拼装写入 Agent system prompt 的上下文摘要，首行固定为时区下的当前日期时间锚点。
 * @param business - ContextBuilder 装配的业务数据块
 * @param page - 可选页面上下文
 * @param timezone - 用户 IANA 时区
 */
export function buildAgentContextSummary(
  business: Record<string, unknown>,
  page?: AgentContext["page"],
  timezone = "Asia/Shanghai",
  prompt?: string,
): string {
  const view = (page?.path ?? "goals") as "today" | "goals" | "goal-detail" | "task-detail" | "routines" | "review" | "settings";
  const scheduleHint = prompt ? inferScheduleIntentHint(prompt, view) : null;
  const hintLine = scheduleHint === "personal"
    ? "【日历意图提示】用户表述更像个人时间占位，优先使用 personal_schedule。"
    : scheduleHint === "goal_task"
      ? "【日历意图提示】用户表述更像目标/任务安排，优先使用 schedule 并关联 goalId 或 taskId。"
      : scheduleHint === "routine"
        ? "【日历意图提示】用户表述含重复语义，优先使用 routine 而非多个 schedule。"
        : "";
  const base = `${formatAgentTemporalAnchor(new Date(), timezone)}\n${summarizeBusinessForPrompt(business, page)}`;
  return hintLine ? `${base}\n${hintLine}` : base;
}
