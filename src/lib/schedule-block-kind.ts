/**
 * 日历日程块的业务类型，用于区分手动/Agent 创建的个人占位、目标任务与 Routine 实例。
 */
export type ScheduleBlockKind = "personal" | "goal_task" | "routine_occurrence";

type ScheduleRelationInput = {
  goalId?: string | null;
  taskId?: string | null;
  taskIds?: string[];
  routineId?: string | null;
  source?: string | null;
};

/**
 * 根据关联字段与来源推断日程块类型。
 * @param input - 含 goalId、taskId、routineId、source 等字段的对象
 */
export function inferScheduleBlockKind(input: ScheduleRelationInput): ScheduleBlockKind {
  if (input.source === "routine_occurrence" || input.routineId) {
    return "routine_occurrence";
  }
  const hasTask = Boolean(input.taskId || input.taskIds?.length);
  const hasGoal = Boolean(input.goalId);
  if (!hasGoal && !hasTask) return "personal";
  return "goal_task";
}

/**
 * 判断 ChangeSet 操作是否针对个人日程。
 * @param entity - 操作 entity 字符串
 * @param payload - 可选 payload，支持 scheduleKind / blockKind 显式标记
 */
export function isPersonalScheduleEntity(entity: string, payload?: Record<string, unknown>): boolean {
  const name = entity.toLowerCase();
  if (name === "personal_schedule") return true;
  if (payload?.scheduleKind === "personal" || payload?.blockKind === "personal") return true;
  return false;
}

/**
 * 判断 ChangeSet 操作是否针对目标关联日程（非个人、非 Routine 规则实体）。
 * @param entity - 操作 entity 字符串
 * @param payload - 可选 payload
 */
export function isGoalScheduleEntity(entity: string, payload?: Record<string, unknown>): boolean {
  if (isPersonalScheduleEntity(entity, payload)) return false;
  const name = entity.toLowerCase();
  return name === "schedule" || name.includes("schedule");
}

/**
 * 为 Agent 上下文中的日程块附加 blockKind 字段。
 * @param block - 含关联 ID 与 source 的日程块对象
 */
export function annotateScheduleBlockKind<T extends ScheduleRelationInput>(block: T): T & { blockKind: ScheduleBlockKind } {
  return { ...block, blockKind: inferScheduleBlockKind(block) };
}
