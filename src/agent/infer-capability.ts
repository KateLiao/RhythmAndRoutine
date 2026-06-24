import type { Capability } from "./types";

type AgentView = "today" | "goals" | "goal-detail" | "task-detail" | "routines" | "review" | "settings";

/**
 * 根据用户输入与当前页面推断 Agent 能力类型。
 * @param prompt - 用户本轮输入
 * @param view - 当前页面视图
 * @param selectedGoalId - 当前选中的目标 ID（若有）
 */
export function inferCapability(prompt: string, view: AgentView, selectedGoalId?: string | null): Capability {
  if (/回顾|复盘/.test(prompt) || view === "review") return "review";
  if (view === "routines") return "adjustment";
  if (/进度|达成|里程碑/.test(prompt)) return "progress_evaluation";
  if (/拆解|规划/.test(prompt) || (view === "task-detail" && /任务|拆分/.test(prompt))) return "planning";
  if (/澄清/.test(prompt) && (view === "goal-detail" || view === "goals" || Boolean(selectedGoalId))) return "goal_clarification";
  if (/目标/.test(prompt) && view === "goals") return "goal_clarification";
  return "adjustment";
}
