export const EXECUTION_FEEDBACK_VERSION = 2;

export const executionOutcomeOptions = [
  { value: "achieved", label: "达成预期", description: "这次计划中的结果已经完成" },
  { value: "progressed", label: "有效推进", description: "还没做完，但留下了可继续的进展" },
  { value: "no_progress", label: "未能推进", description: "这次没有形成有效进展" },
] as const;

export const executionFocusOptions = [
  { value: "deep_focus", label: "深度投入", description: "持续专注，挑战与能力刚好匹配" },
  { value: "steady_focus", label: "稳定专注", description: "能持续做，强度和注意力都比较稳定" },
  { value: "under_challenged", label: "挑战偏低", description: "偏容易或容易无聊，可以提高挑战" },
  { value: "overloaded", label: "挑战过高", description: "明显吃力，可能需要拆小或先补准备" },
  { value: "fragmented", label: "注意力破碎", description: "频繁走神、切换或受到外部打断" },
] as const;

export const executionQualityOptions = [
  { value: "satisfying", label: "满意" },
  { value: "expected", label: "达到预期" },
  { value: "needs_rework", label: "需要返工" },
] as const;

export type ExecutionOutcome = typeof executionOutcomeOptions[number]["value"];
export type ExecutionFocusState = typeof executionFocusOptions[number]["value"];
export type ExecutionQuality = typeof executionQualityOptions[number]["value"];
export type ExecutionResult = ExecutionOutcome | "rescheduled";

export const executionResultValues = ["achieved", "progressed", "no_progress", "rescheduled"] as const;
export const compatibleExecutionResultValues = ["achieved", "progressed", "no_progress", "completed", "not_completed", "rescheduled"] as const;
export const executionFocusValues = ["deep_focus", "steady_focus", "under_challenged", "overloaded", "fragmented"] as const;
export const compatibleExecutionQualityValues = ["satisfying", "expected", "needs_rework", "great", "good", "rough", "fair", "poor"] as const;

const outcomes = new Set<string>(executionOutcomeOptions.map((option) => option.value));
const focusStates = new Set<string>(executionFocusOptions.map((option) => option.value));
const qualities = new Set<string>(executionQualityOptions.map((option) => option.value));

/** 将新旧结果投影到 V2 语义；不修改数据库原值。 */
export function normalizeExecutionOutcome(value?: string | null): ExecutionResult {
  if (outcomes.has(value ?? "")) return value as ExecutionOutcome;
  if (value === "completed") return "achieved";
  if (value === "rescheduled") return "rescheduled";
  return "no_progress";
}

/** 将新专注字段或旧 tag 投影到 V2；没有可靠对应时保持未填写。 */
export function normalizeExecutionFocusState(value?: string | null, legacyTags: string[] = []): ExecutionFocusState | undefined {
  if (focusStates.has(value ?? "")) return value as ExecutionFocusState;
  if (legacyTags.includes("smooth")) return "steady_focus";
  if (legacyTags.includes("resistant") || legacyTags.includes("barely_completed")) return "overloaded";
  if (legacyTags.includes("interrupted")) return "fragmented";
  return undefined;
}

/** V2 仅使用显式专注体验；V1 才允许从历史标签兼容投影。 */
export function resolveExecutionFocusState(feedbackVersion: number | null | undefined, value?: string | null, legacyTags: string[] = []): ExecutionFocusState | undefined {
  return normalizeExecutionFocusState(value, (feedbackVersion ?? 1) >= EXECUTION_FEEDBACK_VERSION ? [] : legacyTags);
}

/** 将历史质量值映射到新的三档语义。 */
export function normalizeExecutionQuality(value?: string | null): ExecutionQuality | undefined {
  if (qualities.has(value ?? "")) return value as ExecutionQuality;
  if (value === "great") return "satisfying";
  if (value === "good") return "expected";
  if (["rough", "fair", "poor"].includes(value ?? "")) return "needs_rework";
  return undefined;
}

/** 达成和有效推进都代表这个时间块真实发生；未推进与改期不计入投入。 */
export function executionResultHasInvestment(value?: string | null): boolean {
  return value === "achieved" || value === "progressed" || value === "completed";
}

export function isExecutionFeedbackV2Result(value?: string | null): value is ExecutionOutcome {
  return outcomes.has(value ?? "");
}

export function executionOutcomeLabel(value?: string | null): string {
  const normalized = normalizeExecutionOutcome(value);
  if (normalized === "rescheduled") return "已改期";
  return executionOutcomeOptions.find((option) => option.value === normalized)?.label ?? "未能推进";
}

export function executionFocusLabel(value?: string | null, legacyTags: string[] = [], feedbackVersion = 1): string | undefined {
  const normalized = resolveExecutionFocusState(feedbackVersion, value, legacyTags);
  return executionFocusOptions.find((option) => option.value === normalized)?.label;
}

export function executionQualityLabel(value?: string | null): string | undefined {
  const normalized = normalizeExecutionQuality(value);
  return executionQualityOptions.find((option) => option.value === normalized)?.label;
}
