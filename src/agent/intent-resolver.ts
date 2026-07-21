import type { AdjustmentResolution, AgentContext, Capability, IntentResolution, ProposalOperationRef, ResolvedIntent } from "./types";

export type AgentView = "today" | "goals" | "goal-detail" | "task-detail" | "routines" | "review" | "settings";

type Signal = { capability: Capability; pattern: RegExp; confidence: number };

const signals: Signal[] = [
  { capability: "review", pattern: /回顾|复盘|总结(?:今天|本周|这周|最近)?(?:的)?执行|分析(?:今天|本周|这周|最近)?(?:的)?阻力/i, confidence: 0.96 },
  { capability: "planning", pattern: /拆解|拆成|规划(?:一下|这个|目标|本周)?|制定.{0,12}计划|目标计划|怎么开始|行动路线|分解.{0,6}(?:任务|步骤)/i, confidence: 0.95 },
  { capability: "progress_evaluation", pattern: /进度|进展|是否在轨|有没有推进|实际发生|本周投入|投入了多少|偏离|卡住|阻塞|判断.{0,12}(?:需不需要|是否).{0,6}调整|里程碑.{0,8}(?:达到|完成|证据|检查)|评估.{0,8}(?:目标|推进)/i, confidence: 0.95 },
  { capability: "goal_clarification", pattern: /澄清(?:一下)?(?:这个)?目标|成功标准|目标范围|目标定义|把目标说清楚|什么算(?:完成|成功)|目标.{0,8}(?:约束|边界)/i, confidence: 0.95 },
  { capability: "adjustment", pattern: /安排|排到|日程|改期|改到|挪到|移到|提前|推迟|交换|对调|换个顺序|放到.{0,16}(?:前面|后面)|取消.{0,8}(?:日程|安排|任务)|调整.{0,12}(?:时间|日程|任务|计划|顺序|routine|习惯)|每天|每周|工作日|重复|习惯|routine|占位|没空|会议|通勤|午休/i, confidence: 0.96 },
];

const pageFallback: Partial<Record<AgentView, Capability>> = {
  goals: "goal_clarification",
  "goal-detail": "goal_clarification",
  "task-detail": "adjustment",
  routines: "adjustment",
  review: "review",
  today: "adjustment",
};

const datePattern = /今天|今晚|明天|后天|未来\s*\d+\s*天|本周|这周|下周|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}月\d{1,2}日/g;
const timeRangePattern = /(?:[01]?\d|2[0-3]):[0-5]\d\s*(?:-|–|—|~|至|到)\s*(?:[01]?\d|2[0-3]):[0-5]\d/g;
const clockPattern = /(?:[01]?\d|2[0-3])[:.][0-5]\d/g;
const humanClockPattern = /(凌晨|早上|上午|中午|下午|傍晚|晚上|晚间)?\s*([零〇一二三四五六七八九十两\d]{1,3})\s*(点(?:\s*(半|一刻|三刻|([0-5]?\d)\s*分?))?|[:.]([0-5]\d))/g;

export function resolveIntent(input: {
  prompt: string;
  view: AgentView;
  selectedGoalId?: string | null;
  recentMessages?: AgentContext["conversation"]["recentMessages"];
  conversationId?: string;
  parentRunId?: string;
  activeChangeSetId?: string;
}): IntentResolution {
  const prompt = input.prompt.trim();
  const explicit = signals.flatMap((signal) => {
    const match = signal.pattern.exec(prompt);
    signal.pattern.lastIndex = 0;
    return match ? [{ ...signal, index: match.index, matchedText: match[0] }] : [];
  });
  const deduped = [...explicit]
    .filter((signal) => !(signal.capability === "adjustment" && /^routine$/i.test(signal.matchedText) && explicit.some((candidate) => candidate.capability === "planning" && candidate.index < signal.index)))
    .sort((left, right) => left.index - right.index || right.confidence - left.confidence)
    .filter((signal, index, items) => items.findIndex((candidate) => candidate.capability === signal.capability) === index);

  if (!deduped.length && isClearlyNonExecution(prompt)) {
    return { route: "non_execution", intents: [], overallConfidence: 0.98, needsClarification: false, source: "rules" };
  }

  const fallback = pageFallback[input.view] ?? "adjustment";
  const candidates = deduped.length ? deduped : [{ capability: fallback, pattern: /(?:)/, confidence: input.selectedGoalId ? 0.7 : 0.58, index: 0 }];
  const adjustment = candidates.some((candidate) => candidate.capability === "adjustment")
    ? resolveAdjustment({ ...input, prompt })
    : undefined;
  const slots = extractIntentSlots(prompt, input.selectedGoalId);
  const intents: ResolvedIntent[] = candidates.map((candidate, index) => {
    const missingSlots = missingSlotsFor(candidate.capability, prompt, input.selectedGoalId, adjustment);
    return {
      id: `intent-${index + 1}`,
      capability: candidate.capability,
      objective: objectiveFor(candidate.capability, prompt),
      confidence: roundConfidence(candidate.confidence - (missingSlots.length ? 0.15 : 0)),
      slots: { ...slots },
      missingSlots,
    };
  });
  const primary = intents[0];
  const needsClarification = intents.some((intent) => intent.missingSlots.length > 0);
  return {
    route: "agent",
    primaryCapability: primary?.capability ?? fallback,
    intents,
    overallConfidence: roundConfidence(intents.reduce((sum, intent) => sum + intent.confidence, 0) / Math.max(1, intents.length)),
    needsClarification,
    clarificationReason: needsClarification ? describeMissingSlots(intents) : undefined,
    source: "rules",
    adjustment,
  };
}

function extractIntentSlots(prompt: string, selectedGoalId?: string | null) {
  datePattern.lastIndex = 0;
  timeRangePattern.lastIndex = 0;
  const dates = [...prompt.matchAll(datePattern)].map((match) => match[0]);
  const timeRanges = [...prompt.matchAll(timeRangePattern)].map((match) => normalizeTimeRange(match[0]));
  clockPattern.lastIndex = 0;
  const times = [...prompt.matchAll(clockPattern)].map((match) => normalizeClock(match[0]));
  return {
    ...(selectedGoalId ? { selectedGoalId } : {}),
    ...(dates.length ? { dateExpressions: [...new Set(dates)] } : {}),
    ...(timeRanges.length ? { timeRanges: [...new Set(timeRanges)] } : {}),
    ...(times.length ? { times: [...new Set(times)] } : {}),
  };
}

function missingSlotsFor(capability: Capability, prompt: string, selectedGoalId?: string | null, adjustment?: AdjustmentResolution) {
  const missing: string[] = [];
  if (capability === "adjustment") {
    if (adjustment && adjustment.kind !== "existing_adjustment") return missing;
    const hasTarget = /任务|目标|日程|会议|通勤|午休|运动|训练|阅读|学习|写作|练习|routine|习惯|它|这个/.test(prompt) || Boolean(selectedGoalId);
    datePattern.lastIndex = 0;
    timeRangePattern.lastIndex = 0;
    const hasTiming = datePattern.test(prompt) || timeRangePattern.test(prompt) || /提前|推迟|改期|挪到|移到|取消|每天|每周|工作日|周末/.test(prompt);
    datePattern.lastIndex = 0;
    timeRangePattern.lastIndex = 0;
    if (!hasTarget) missing.push("target");
    if (!hasTiming) missing.push("time_or_recurrence");
  }
  if ((capability === "planning" || capability === "goal_clarification") && !selectedGoalId && /这个目标|该目标|帮我规划一下|帮我澄清一下/.test(prompt) && !/目标[：:]?[^，。]{2,}/.test(prompt)) missing.push("goal");
  return missing;
}

function resolveAdjustment(input: {
  prompt: string;
  recentMessages?: AgentContext["conversation"]["recentMessages"];
  conversationId?: string;
  parentRunId?: string;
  activeChangeSetId?: string;
}): AdjustmentResolution {
  const { prompt } = input;
  const parsedTimes = extractHumanClockExpressions(prompt);
  const times = parsedTimes.flatMap((time) => time.ambiguous ? [] : [time.normalized]);
  const firstAmbiguousTime = parsedTimes.find((time) => time.ambiguous);
  const operationRefs = extractOperationRefs(prompt);
  const hasStructuredProposal = Boolean(input.activeChangeSetId);
  const priorAssistantProposedTimes = Boolean(input.recentMessages?.slice(-4).some((message) => message.role === "assistant" && /(?:[01]?\d|2[0-3]):[0-5]\d/.test(message.content)));
  const continuationLanguage = /第(?:一|二|三|四|五|六|七|八|九|十|\d+)(?:个|项)?|其他没问题|其余不变|上一(?:份|版|轮)|这(?:个|项)|那个/.test(prompt);
  const timeEditLanguage = /(?:开始|结束).{0,6}时间|提前|提早|推迟|延后|改到|挪到|移到/.test(prompt);
  let kind: AdjustmentResolution["kind"] = "existing_adjustment";
  let confidence = 0.72;

  if (hasStructuredProposal && /交换|对调|换个顺序|调整.{0,10}顺序|顺序.{0,10}调整|(?:放|挪)到.{0,18}(?:前面|后面)/.test(prompt)) {
    kind = "proposal_reorder";
    confidence = 0.99;
  } else if (hasStructuredProposal && parsedTimes.length > 0 && (timeEditLanguage || continuationLanguage || priorAssistantProposedTimes)) {
    kind = "proposal_item_reschedule";
    confidence = 0.99;
  } else if (hasStructuredProposal && /删除|去掉|移除|新增|添加|加(?:一|1)?个|改(?:标题|内容)|换成/.test(prompt)) {
    kind = "proposal_patch";
    confidence = 0.96;
  } else if (/安排/.test(prompt) && /今天|今晚|明天|后天|未来\s*\d+\s*天|本周|这周|下周|一日|多日/.test(prompt) && !/调整|修改|改到|改期|重新/.test(prompt)) {
    kind = "itinerary_create";
    confidence = 0.96;
  }

  return {
    kind,
    conversationId: input.conversationId,
    continuationOfRunId: input.parentRunId,
    changeSetId: input.activeChangeSetId,
    operationRefs,
    timingSpecified: parsedTimes.length > 0,
    confidence,
    startTime: times[0],
    endTime: times[1],
    timeExpression: firstAmbiguousTime?.raw,
    timeAmbiguous: Boolean(firstAmbiguousTime),
    timeRelation: /推迟|延后|晚一点/.test(prompt) ? "later" : /提前|提早|早一点/.test(prompt) ? "earlier" : "neutral",
  };
}

type ParsedHumanClock = { raw: string; normalized: string; ambiguous: boolean };

/**
 * 只做无损的时间字面量抽取。带上午/下午或 24 小时制的表达可直接归一化；
 * “5 点半”这类缺少时段的信息保留原文，交给局部模型结合当前时间和提案上下文判断。
 */
function extractHumanClockExpressions(prompt: string): ParsedHumanClock[] {
  humanClockPattern.lastIndex = 0;
  return [...prompt.matchAll(humanClockPattern)].flatMap((match) => {
    const period = match[1];
    const hour = parseHumanHour(match[2]);
    if (hour === undefined || hour > 23) return [];
    const token = match[3] ?? "";
    const minute = match[4] === "半" ? 30 : match[4] === "一刻" ? 15 : match[4] === "三刻" ? 45 : Number(match[5] ?? match[6] ?? 0);
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return [];
    const usesNaturalPoint = token.startsWith("点");
    const ambiguous = !period && usesNaturalPoint && hour >= 1 && hour <= 12;
    const normalizedHour = period ? applyDayPeriod(hour, period) : hour;
    return [{ raw: match[0].trim(), normalized: `${String(normalizedHour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, ambiguous }];
  });
}

function parseHumanHour(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === "十") return 10;
  if (value.startsWith("十")) return 10 + (digits[value[1] ?? ""] ?? 0);
  if (value.endsWith("十")) return (digits[value[0] ?? ""] ?? 0) * 10;
  if (value.includes("十")) return (digits[value[0] ?? ""] ?? 0) * 10 + (digits[value[2] ?? ""] ?? 0);
  return value.length === 1 ? digits[value] : undefined;
}

function applyDayPeriod(hour: number, period: string) {
  if (period === "凌晨") return hour === 12 ? 0 : hour;
  if (period === "中午") return hour > 0 && hour < 11 ? hour + 12 : hour;
  if (/下午|傍晚|晚上|晚间/.test(period)) return hour < 12 ? hour + 12 : hour;
  return hour;
}

function extractOperationRefs(prompt: string): ProposalOperationRef[] {
  const refs: ProposalOperationRef[] = [];
  const ordinalPattern = /第\s*(一|二|三|四|五|六|七|八|九|十|\d+)\s*(?:个|项)?(?:日程|安排|活动|提案)?/g;
  for (const match of prompt.matchAll(ordinalPattern)) {
    const ordinal = parseOrdinal(match[1]);
    if (ordinal && !refs.some((ref) => ref.ordinal === ordinal)) refs.push({ ordinal });
  }
  return refs;
}

function parseOrdinal(value: string): number | undefined {
  const chinese: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const parsed = chinese[value] ?? Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isClearlyNonExecution(prompt: string) {
  if (/^(你好|嗨|hi|hello|谢谢|你是谁|在吗)[！!。.?？]*$/i.test(prompt)) return true;
  return /^(解释|介绍|什么是|为什么|怎么理解).{0,80}$/.test(prompt) && !/我的|目标|任务|日程|计划|执行|回顾|routine/i.test(prompt);
}

function objectiveFor(capability: Capability, prompt: string) {
  const prefix: Record<Capability, string> = {
    goal_clarification: "澄清目标及成功标准",
    planning: "形成可执行规划",
    review: "基于真实执行完成回顾",
    adjustment: "调整计划或日程",
    progress_evaluation: "评估目标推进状态",
  };
  return `${prefix[capability]}：${prompt.slice(0, 120)}`;
}

function describeMissingSlots(intents: ResolvedIntent[]) {
  return intents.filter((intent) => intent.missingSlots.length).map((intent) => `${intent.capability} 缺少 ${intent.missingSlots.join(", ")}`).join("；");
}

function normalizeTimeRange(value: string) {
  return value.replace(/\s+/g, "").replace(/[–—~至到]/, "-").split("-").map((part) => {
    const [hour, minute] = part.split(":");
    return `${String(Number(hour)).padStart(2, "0")}:${minute}`;
  }).join("-");
}

function normalizeClock(value: string) {
  const [hour, minute] = value.replace(".", ":").split(":");
  return `${String(Number(hour)).padStart(2, "0")}:${minute}`;
}

function roundConfidence(value: number) { return Math.max(0, Math.min(1, Math.round(value * 100) / 100)); }
