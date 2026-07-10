import type { HomeInsightsInput, RhythmCard } from "./types";
import { isSignalPreferred } from "./preferred-signals";
import { parseClock, scheduleForDate, todayKey } from "./helpers";

/**
 * 从 evidence JSON 提取展示用证据文案。
 * @param evidence - RhythmSignal.evidence
 */
function formatEvidence(evidence: unknown): string | undefined {
  if (!evidence || typeof evidence !== "object") return undefined;
  const record = evidence as Record<string, unknown>;
  if (typeof record.evidenceSummary === "string") return record.evidenceSummary;
  const metrics = record.metrics as { completed?: number; total?: number } | undefined;
  if (metrics?.total) {
    return `本周期完成 ${metrics.completed ?? 0}/${metrics.total} 个相关日程块。`;
  }
  return undefined;
}

/**
 * 根据信号类型生成对后续安排的影响说明。
 * @param type - RhythmSignal.type
 */
function impactForType(type: string): string {
  const map: Record<string, string> = {
    smooth_pattern: "顺畅窗口会被优先保留在后续自动推荐中。",
    resistance_pattern: "后续排程会尝试降低粒度或调整时间段。",
    completion_pattern: "完成率趋势会参与本周轨道与回顾判断。",
    time_window: "深度任务将优先推荐在对应时间段。",
    routine_pressure: "Routine 频率或门槛可能在下次调整时被建议修改。",
  };
  return map[type] ?? "这个发现会参与之后的日程推荐与 Agent 上下文。";
}

/**
 * 用近 7 天日程规则补充一条节奏发现（无 DB signal 时）。
 * @param input - 洞察计算输入
 */
function ruleBasedInsight(input: HomeInsightsInput): RhythmCard | null {
  const { now, timezone, schedule } = input;
  const date = todayKey(now, timezone);
  const recentDates: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(`${date}T12:00:00`);
    d.setDate(d.getDate() - i);
    recentDates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }

  const buckets = new Map<string, { done: number; total: number }>();
  for (const day of recentDates) {
    for (const item of scheduleForDate(schedule, day, timezone)) {
      if (item.kind === "personal") continue;
      const hour = Math.floor(parseClock(item.start) / 60);
      const key = hour < 12 ? "上午" : hour < 18 ? "下午" : "晚上";
      const entry = buckets.get(key) ?? { done: 0, total: 0 };
      entry.total += 1;
      if (item.status === "completed") entry.done += 1;
      buckets.set(key, entry);
    }
  }

  let best: { label: string; rate: number } | null = null;
  for (const [label, stats] of buckets) {
    if (stats.total < 2) continue;
    const rate = stats.done / stats.total;
    if (!best || rate > best.rate) best = { label, rate };
  }

  if (!best) return null;

  return {
    kind: "insight",
    statement: `你最近在${best.label}的任务完成率更高（${Math.round(best.rate * 100)}%）。`,
    evidence: `过去 7 天，${best.label}共 ${buckets.get(best.label)?.total ?? 0} 个目标相关块，完成 ${buckets.get(best.label)?.done ?? 0} 个。`,
    impact: impactForType("time_window"),
    preferred: false,
  };
}

/**
 * 计算「节奏发现」卡片内容。
 * @param input - 洞察计算输入
 */
export function computeRhythmCard(input: HomeInsightsInput): RhythmCard {
  const signal = input.rhythmSignals[0];
  if (signal) {
    const evidence = formatEvidence(signal.evidence);
    return {
      kind: "insight",
      signalId: signal.id,
      statement: signal.statement,
      evidence: evidence ?? `信号类型：${signal.type}${signal.confidence ? `，置信度 ${Math.round(signal.confidence * 100)}%` : ""}。`,
      impact: impactForType(signal.type),
      preferred: isSignalPreferred(signal.id),
    };
  }

  const ruled = ruleBasedInsight(input);
  if (ruled) return ruled;

  return {
    kind: "empty",
    statement: "完成几次执行反馈后，这里会出现你的节奏规律。",
    evidence: "例如：你更适合在哪些时间段做深度任务，哪些 Routine 容易被跳过，哪些任务需要拆得更小。",
    impact: undefined,
  };
}
