import { AgentContext, Capability, ContextReference } from "./types";
import { formatAgentTemporalAnchor } from "@/lib/timezone";
import { inferScheduleIntentHint } from "./infer-capability";
import { capabilityCatalog } from "./capability-catalog";
import type { ContextSourceMetric } from "./types";

export type ContextDataSource = {
  getUser(userId: string): Promise<{ id: string; timezone: string; preferences: Record<string, unknown> }>;
  getGoalContext(userId: string, entityId?: string): Promise<{ data: unknown; references: ContextReference[] }>;
  getScheduleWindow(userId: string, days: number): Promise<{ data: unknown; references: ContextReference[] }>;
  getExecutionHistory(userId: string, days: number): Promise<{ data: unknown; references: ContextReference[] }>;
  getRecentReviews(userId: string, limit: number): Promise<{ data: unknown; references: ContextReference[] }>;
  getRhythmSignals(userId: string, limit: number): Promise<{ data: unknown; references: ContextReference[] }>;
};

type ContextBusinessSource = "goals" | "schedule" | "executions" | "reviews" | "rhythmSignals";
const contextSourceOrder = ["user", "goals", "schedule", "executions", "reviews", "rhythmSignals"] as const;

export class ContextBuilder {
  constructor(private readonly source: ContextDataSource) {}

  async build(input: {
    userId: string;
    capability: Capability;
    page?: AgentContext["page"];
    recentMessages?: AgentContext["conversation"]["recentMessages"];
    conversationSummary?: string;
    strategy?: "parallel" | "serial";
  }): Promise<AgentContext> {
    const sourceMetrics: ContextSourceMetric[] = [];
    const userStartedAt = Date.now();
    const user = await this.source.getUser(input.userId);
    sourceMetrics.push({ source: "user", required: true, ok: true, durationMs: Date.now() - userStartedAt, rawCount: 1, estimatedChars: JSON.stringify(user).length });
    const needs = capabilityCatalog[input.capability].contextSources;
    const business: Record<string, unknown> = {};
    const manifest: ContextReference[] = [];
    const loaders: Record<ContextBusinessSource, () => Promise<{ data: unknown; references: ContextReference[] }>> = {
      goals: () => this.source.getGoalContext(input.userId, input.page?.selectedEntity?.entityId),
      schedule: () => this.source.getScheduleWindow(input.userId, 14),
      executions: () => this.source.getExecutionHistory(input.userId, 28),
      reviews: () => this.source.getRecentReviews(input.userId, 4),
      rhythmSignals: () => this.source.getRhythmSignals(input.userId, 12),
    };
    const load = async (key: ContextBusinessSource) => {
      const startedAt = Date.now();
      try {
        const chunk = await loaders[key]();
        this.merge(key, chunk, business, manifest);
        sourceMetrics.push({ source: key, required: true, ok: true, durationMs: Date.now() - startedAt, rawCount: Array.isArray(chunk.data) ? chunk.data.length : chunk.data == null ? 0 : 1, estimatedChars: estimateChars(chunk.data) });
      } catch (error) {
        const message = error instanceof Error ? error.message : "上下文读取失败";
        sourceMetrics.push({ source: key, required: true, ok: false, durationMs: Date.now() - startedAt, rawCount: 0, estimatedChars: 0, error: message.slice(0, 300) });
        business[key] = [];
        manifest.push({ entityType: "context_source_error", entityId: key, reason: message.slice(0, 300) });
      }
    };

    if (input.strategy === "serial") {
      for (const key of needs) await load(key);
    } else {
      await Promise.all(needs.map((key) => load(key)));
    }

    sourceMetrics.sort((left, right) => contextSourceOrder.indexOf(left.source as (typeof contextSourceOrder)[number]) - contextSourceOrder.indexOf(right.source as (typeof contextSourceOrder)[number]));

    return {
      user,
      page: input.page,
      conversation: { recentMessages: input.recentMessages?.slice(-12) ?? [], summary: input.conversationSummary },
      business,
      manifest,
      sourceMetrics,
    };
  }

  private merge(key: string, chunk: { data: unknown; references: ContextReference[] }, business: Record<string, unknown>, manifest: ContextReference[]) {
    business[key] = chunk.data;
    manifest.push(...chunk.references);
  }
}

function estimateChars(value: unknown) {
  try { return JSON.stringify(value).length; }
  catch { return 0; }
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
 * @param prompt - 当前用户请求（用于日程意图提示）
 * @param conversationSummary - 可选对话历史摘要
 */
export function buildAgentContextSummary(
  business: Record<string, unknown>,
  page?: AgentContext["page"],
  timezone = "Asia/Shanghai",
  prompt?: string,
  conversationSummary?: string,
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
  const lines = [
    formatAgentTemporalAnchor(new Date(), timezone),
    summarizeBusinessForPrompt(business, page),
  ];
  if (conversationSummary?.trim()) {
    lines.push(`【对话摘要】\n${conversationSummary.trim().slice(0, 2000)}`);
  }
  if (hintLine) lines.push(hintLine);
  return lines.filter(Boolean).join("\n");
}
