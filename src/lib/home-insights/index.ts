import type { HomeInsights } from "./types";
import type { HomeInsightsInput } from "./types";
import { computeMomentCard } from "./compute-moment";
import { computeRhythmCard } from "./compute-rhythm";
import { computeWeeklyCard } from "./compute-weekly";

export type { HomeInsights, HomeInsightsInput, MomentAction, MomentCard, RhythmCard, WeeklyCard, WeeklyStatus } from "./types";
export { preferSignalForScheduling, isSignalPreferred, readPreferredSignalIds } from "./preferred-signals";
export { computeRhythmCard } from "./compute-rhythm";
export { computeWeeklyCard } from "./compute-weekly";

/**
 * 聚合计算首页右侧三张洞察卡片。
 * @param input - 目标、日程、节奏信号与当前时刻
 */
export function computeHomeInsights(input: HomeInsightsInput): HomeInsights {
  return {
    moment: computeMomentCard(input),
    rhythm: computeRhythmCard(input),
    weekly: computeWeeklyCard(input),
  };
}
