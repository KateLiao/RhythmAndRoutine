import type { ScheduleItem } from "@/lib/demo-data";

/**
 * 判断日程块是否应在日历时间轴中展示。
 * 已取消块与已被后继块替代的改期历史块不展示；
 * Routine 实例拖动后虽标记为 rescheduled，但仍以 rescheduledStartAt 落在当天时间轴上，须继续展示。
 * @param item - 客户端日程块
 */
export function isActiveCalendarBlock(item: ScheduleItem) {
  if (item.status === "cancelled") return false;
  if (item.status === "rescheduled" && item.source !== "routine_occurrence") return false;
  return true;
}
