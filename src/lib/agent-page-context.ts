/**
 * Agent 的页面目标是一个派生上下文，不等同于 UI 中最后一次选中的目标。
 * 只有目标详情页能隐式聚焦目标；其他页面必须依靠用户当前消息显式指定目标。
 */
export function resolveAgentPageGoalId(view: string | undefined, selectedGoalId?: string | null): string | null {
  if (view !== "goal-detail") return null;
  const normalized = selectedGoalId?.trim();
  return normalized || null;
}
