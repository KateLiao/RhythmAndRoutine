"use client";

import clsx from "clsx";
import type { ScheduleItem } from "@/lib/demo-data";
import { dateFromKey, localDateKeyFromDate, monthGridDays } from "@/lib/calendar/navigation";

const WEEKDAY_HEADERS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/**
 * 月视图标准网格：事件时间摘要、+N 更多、点击日期进入日视图。
 */
export function MonthCalendarView({
  anchorDate,
  todayKey,
  schedule,
  onSelectDate,
  onSelectEvent,
}: {
  anchorDate: string;
  todayKey: string;
  schedule: ScheduleItem[];
  onSelectDate: (dateKey: string) => void;
  onSelectEvent: (id: string) => void;
}) {
  const anchor = dateFromKey(anchorDate);
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const days = monthGridDays(year, month);

  return (
    <div className="month-wrap month-calendar-feishu">
      <div className="month-weekdays">
        {WEEKDAY_HEADERS.map((day) => <span key={day}>{day}</span>)}
      </div>
      <div className="month-calendar">
        {days.map((date) => {
          const key = localDateKeyFromDate(date);
          const items = schedule
            .filter((item) => (item.date ?? todayKey) === key)
            .sort((a, b) => a.start.localeCompare(b.start));
          const currentMonth = date.getMonth() === month;
          return (
            <section
              key={key}
              className={clsx("month-day", !currentMonth && "outside", key === todayKey && "is-today", key === anchorDate && "is-selected")}
            >
              <button type="button" className="month-day-number" onClick={() => onSelectDate(key)}>
                <strong>{date.getDate()}</strong>
              </button>
              <div className="month-day-events">
                {items.slice(0, 3).map((item) => (
                  <button key={item.id} type="button" className={clsx("month-event", item.kind)} onClick={() => onSelectEvent(item.id)}>
                    <i className="month-event-dot" aria-hidden="true" />
                    <span>{item.start} {item.title}</span>
                  </button>
                ))}
                {items.length > 3 && (
                  <button type="button" className="month-event-more" onClick={() => onSelectDate(key)}>
                    +{items.length - 3} 更多
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <div className="calendar-legend">
        <span><i className="task" />任务</span>
        <span><i className="routine" />Routine</span>
        <span><i className="personal" />个人</span>
        <span><i className="rescheduled" />改期</span>
      </div>
    </div>
  );
}
