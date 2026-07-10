import type { Goal, ScheduleItem } from "@/lib/demo-data";
import type { RhythmSignalRecord } from "@/lib/client-api";

/** 首页洞察计算的输入上下文 */
export type HomeInsightsInput = {
  now: Date;
  timezone: string;
  goals: Goal[];
  schedule: ScheduleItem[];
  rhythmSignals: RhythmSignalRecord[];
  alternateMomentIndex?: number;
};

/** 此刻建议可执行动作 */
export type MomentAction =
  | { type: "reschedule"; scheduleId: string; start: string; end: string; date: string; label: string }
  | { type: "create_schedule"; title: string; start: string; end: string; date: string; goalId?: string; taskId?: string; label: string }
  | { type: "open_schedule_form"; goalId?: string; taskId?: string; date: string; start: string; end: string; label: string }
  | { type: "open_execution_feedback"; scheduleId: string; label: string };

/** 此刻建议卡片 */
export type MomentCard = {
  kind: "action" | "empty";
  headline: string;
  judgment: string;
  reason: string;
  nextLabel?: string;
  action?: MomentAction;
  alternateCount: number;
};

/** 节奏发现卡片 */
export type RhythmCard = {
  kind: "insight" | "empty";
  signalId?: string;
  statement: string;
  evidence?: string;
  impact?: string;
  preferred?: boolean;
};

/** 本周轨道状态 */
export type WeeklyStatus = "relaxed" | "balanced" | "full" | "overload" | "off_track";

/** 本周轨道卡片 */
export type WeeklyCard = {
  kind: "track" | "empty";
  status: WeeklyStatus;
  statusLabel: string;
  plannedMinutes: number;
  completedMinutes: number;
  summary: string;
  suggestion?: string;
};

/** 首页右侧三张卡片的聚合结果 */
export type HomeInsights = {
  moment: MomentCard;
  rhythm: RhythmCard;
  weekly: WeeklyCard;
};

/** 内部：此刻建议候选 */
export type MomentCandidate = {
  priority: number;
  headline: string;
  judgment: string;
  reason: string;
  nextLabel: string;
  action: MomentAction;
};

export type { Goal, ScheduleItem, RhythmSignalRecord };
