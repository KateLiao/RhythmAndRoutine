"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { Goal, ScheduleItem } from "@/lib/demo-data";
import { HOUR_HEIGHT, TIMELINE_END_MINUTES, TIMELINE_START_HOUR } from "@/lib/calendar/constants";
import { assignOverlapLayout, timelineHeightPx } from "@/lib/calendar/layout";
import { formatTimeInTimezone, formatTimelineMinute, timeMinutesInTimezone } from "@/lib/calendar/time";
import { formatTimezoneAbbrev } from "@/lib/calendar/timezone-label";
import { dateFromKey, weekDateKeys } from "@/lib/calendar/navigation";
import { CalendarEventBlock } from "./calendar-event-block";

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/**
 * 周视图 7 列时间网格，与日视图共用刻度与日程块组件。
 */
export function WeekTimeline({
  weekStart,
  anchorDate,
  todayKey,
  timezone,
  now,
  schedule,
  goals,
  selectedBlockId,
  onSelect,
  onUpdateTime,
}: {
  weekStart: string;
  anchorDate: string;
  todayKey: string;
  timezone: string;
  now: Date;
  schedule: ScheduleItem[];
  goals: Goal[];
  selectedBlockId: string | null;
  onSelect: (id: string) => void;
  onUpdateTime: (item: ScheduleItem, start: string, end: string, date?: string) => Promise<void>;
}) {
  const itemsByDay = useMemo(() => {
    const days = weekDateKeys(weekStart);
    const map = new Map<string, ScheduleItem[]>();
    for (const key of days) map.set(key, []);
    for (const item of schedule) {
      const key = item.date ?? todayKey;
      if (map.has(key)) map.get(key)!.push(item);
    }
    for (const [, list] of map) list.sort((a, b) => a.start.localeCompare(b.start));
    return map;
  }, [schedule, weekStart, todayKey]);

  const days = weekDateKeys(weekStart);
  const startHour = TIMELINE_START_HOUR;
  const startMinutes = startHour * 60;
  const timelineHeight = timelineHeightPx(startHour, TIMELINE_END_MINUTES);
  const labelMinutes = [...Array.from({ length: TIMELINE_END_MINUTES / 60 - startHour + 1 }, (_, index) => startMinutes + index * 60), TIMELINE_END_MINUTES];
  const weekIncludesToday = days.includes(todayKey);
  const currentMinutes = timeMinutesInTimezone(now, timezone);
  const currentTop = ((currentMinutes - startMinutes) / 60) * HOUR_HEIGHT;
  const shellRef = useRef<HTMLDivElement>(null);
  const [timelineMounted, setTimelineMounted] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setTimelineMounted(true), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || !weekIncludesToday) return;
    const frame = window.requestAnimationFrame(() => {
      shell.scrollTop = Math.max(0, currentTop - shell.clientHeight * 0.4);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [weekStart, weekIncludesToday, currentTop]);

  return (
    <div className="week-timeline-module">
      <div className="calendar-scroll week-timeline-scroll" ref={shellRef}>
        <div className="week-day-header-row sticky-calendar-head">
          <div className="week-day-header-spacer" />
          {days.map((key) => {
            const date = dateFromKey(key);
            return (
              <header key={key} className={clsx("week-day-header", key === todayKey && "is-today", key === anchorDate && "is-selected")}>
                <span>{WEEKDAY_LABELS[date.getDay() === 0 ? 6 : date.getDay() - 1]}</span>
                <strong>{date.getDate()}</strong>
              </header>
            );
          })}
        </div>
        <div className="week-timeline-body">
          <div className="hour-label-column" style={{ height: `${timelineHeight}px` }}>
            <span className="hour-timezone-label">{formatTimezoneAbbrev(timezone)}</span>
            {labelMinutes.map((minute) => (
              <span key={minute} style={{ top: `${((minute - startMinutes) / 60) * HOUR_HEIGHT}px` }}>{formatTimelineMinute(minute)}</span>
            ))}
          </div>
          <div className="week-timeline-grid" data-week-start={weekStart} style={{ height: `${timelineHeight}px`, "--hour-height": `${HOUR_HEIGHT}px` } as React.CSSProperties}>
            {days.map((key) => {
              const dayItems = itemsByDay.get(key) ?? [];
              const positioned = assignOverlapLayout(dayItems, startHour);
              return (
                <div key={key} className={clsx("week-day-lane", key === todayKey && "is-today")}>
                  {labelMinutes.slice(0, -1).map((minute) => (
                    <div className="hour-gridline" key={minute} style={{ top: `${((minute - startMinutes) / 60) * HOUR_HEIGHT}px` }} />
                  ))}
                  {positioned.map((block) => (
                    <CalendarEventBlock
                      key={block.item.id}
                      item={block.item}
                      goals={goals}
                      top={block.top}
                      height={block.height}
                      column={block.column}
                      columnCount={block.columnCount}
                      hiddenCount={block.hiddenCount}
                      variant="week"
                      selected={selectedBlockId === block.item.id}
                      onSelect={onSelect}
                      onFeedback={() => onSelect(block.item.id)}
                      onComplete={() => onSelect(block.item.id)}
                      onUpdateTime={onUpdateTime}
                    />
                  ))}
                </div>
              );
            })}
            {timelineMounted && weekIncludesToday && currentTop >= 0 && currentTop <= timelineHeight && (
              <div className="current-time-line week-current-time-line" style={{ top: `${currentTop}px` }}>
                <span>{formatTimeInTimezone(now, timezone)}</span>
                <i />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
