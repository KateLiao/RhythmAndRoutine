import type { Capability } from "./types";

type AgentView = "today" | "goals" | "goal-detail" | "task-detail" | "routines" | "review" | "settings";

const PERSONAL_SCHEDULE_PATTERN = /会议|周会|例会|面试|约会|聚餐|通勤|午休|睡觉|没空|占用|占位|阻塞|个人日程|日历上标|外部|飞书|outlook|请假|看病|体检|理发/i;
const GOAL_SCHEDULE_PATTERN = /安排|排到|推进|投入|专注|任务|做.{1,20}|排到日历|放进日程/i;
const ROUTINE_PATTERN = /每天|每周|工作日|周末|重复|习惯|长期坚持|routine|节律/i;
const REVIEW_PATTERN = /回顾|复盘/;
const PLANNING_PATTERN = /拆解|规划/;
const PROGRESS_PATTERN = /进度|达成|里程碑/;
const CLARIFY_PATTERN = /澄清/;

/**
 * 根据用户输入与当前页面推断 Agent 能力类型。
 * @param prompt - 用户本轮输入
 * @param view - 当前页面视图
 * @param selectedGoalId - 当前选中的目标 ID（若有）
 */
export function inferCapability(prompt: string, view: AgentView, selectedGoalId?: string | null): Capability {
  if (REVIEW_PATTERN.test(prompt) || view === "review") return "review";
  if (view === "routines" || ROUTINE_PATTERN.test(prompt)) return "adjustment";
  if (PROGRESS_PATTERN.test(prompt)) return "progress_evaluation";
  if (PLANNING_PATTERN.test(prompt) || (view === "task-detail" && /任务|拆分/.test(prompt))) return "planning";
  if (CLARIFY_PATTERN.test(prompt) && (view === "goal-detail" || view === "goals" || Boolean(selectedGoalId))) return "goal_clarification";
  if (/目标/.test(prompt) && view === "goals") return "goal_clarification";

  if (view === "today" || view === "task-detail" || PERSONAL_SCHEDULE_PATTERN.test(prompt) || GOAL_SCHEDULE_PATTERN.test(prompt)) {
    return "adjustment";
  }

  return "adjustment";
}

/**
 * 从用户表述推断更可能的日历变更类型，供上下文摘要提示 Agent。
 * @param prompt - 用户本轮输入
 * @param view - 当前页面
 */
export function inferScheduleIntentHint(prompt: string, view: AgentView): "personal" | "goal_task" | "routine" | null {
  if (ROUTINE_PATTERN.test(prompt)) return "routine";
  if (view === "task-detail" && GOAL_SCHEDULE_PATTERN.test(prompt)) return "goal_task";
  if (PERSONAL_SCHEDULE_PATTERN.test(prompt) && !GOAL_SCHEDULE_PATTERN.test(prompt)) return "personal";
  if (view === "today" && PERSONAL_SCHEDULE_PATTERN.test(prompt)) return "personal";
  if (GOAL_SCHEDULE_PATTERN.test(prompt)) return "goal_task";
  return null;
}
