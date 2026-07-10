"use client";

/**
 * 精简版 rhythm-card 标题行：今日轨道 + 完成进度。
 * @param props.completed - 已完成数量
 * @param props.total - 当日日程总数
 */
export function CalendarHeader({ completed, total }: { completed: number; total: number }) {
  return (
    <div className="calendar-header-compact">
      <span className="section-kicker">今日轨道</span>
      <strong className="calendar-header-progress">{completed}/{total} 已完成</strong>
    </div>
  );
}
