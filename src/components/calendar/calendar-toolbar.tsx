"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import type { CalendarMode } from "@/lib/calendar/navigation";

/**
 * 飞书式日历顶栏：今天 / 翻页 / 标题 / 筛选 chip / 视图切换。
 * @param props.title - 当前视图日期标题
 * @param props.mode - 日 / 周 / 月
 * @param props.showRoutines - 是否显示 Routine
 * @param props.showCompleted - 是否显示已完成
 */
export function CalendarToolbar({
  title,
  mode,
  showRoutines,
  showCompleted,
  onToday,
  onPrev,
  onNext,
  onModeChange,
  onToggleRoutines,
  onToggleCompleted,
}: {
  title: string;
  mode: CalendarMode;
  showRoutines: boolean;
  showCompleted: boolean;
  onToday: () => void;
  onPrev: () => void;
  onNext: () => void;
  onModeChange: (mode: CalendarMode) => void;
  onToggleRoutines: () => void;
  onToggleCompleted: () => void;
}) {
  return (
    <div className="calendar-toolbar calendar-toolbar-feishu">
      <div className="calendar-toolbar-nav">
        <button type="button" className="calendar-nav-btn calendar-today-btn" onClick={onToday}>今天</button>
        <button type="button" className="calendar-nav-btn" onClick={onPrev} aria-label="上一页"><ChevronLeft size={15} /></button>
        <button type="button" className="calendar-nav-btn" onClick={onNext} aria-label="下一页"><ChevronRight size={15} /></button>
        <strong className="calendar-toolbar-title">{title}</strong>
      </div>
      <div className="calendar-toolbar-actions">
        <div className="calendar-filter-chips">
          <button type="button" className={showRoutines ? "active" : ""} onClick={onToggleRoutines}>Routine</button>
          <button type="button" className={showCompleted ? "active" : ""} onClick={onToggleCompleted}>已完成</button>
        </div>
        <div className="calendar-switch" aria-label="日历视图">
          {(["today", "week", "month"] as const).map((view) => (
            <button key={view} type="button" className={mode === view ? "active" : ""} onClick={() => onModeChange(view)}>
              {view === "today" ? "日" : view === "week" ? "周" : "月"}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
