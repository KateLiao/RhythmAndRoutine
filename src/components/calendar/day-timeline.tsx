"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Leaf, Plus } from "lucide-react";
import type { Goal, ScheduleItem } from "@/lib/demo-data";
import { HOUR_HEIGHT, TIMELINE_END_HOUR, TIMELINE_END_MINUTES, TIMELINE_START_HOUR } from "@/lib/calendar/constants";
import { assignOverlapLayout, timelineHeightPx } from "@/lib/calendar/layout";
import { clampTimelineMinutes, formatClock, formatTimeInTimezone, formatTimelineMinute, parseClock, snapMinutes, timeMinutesInTimezone } from "@/lib/calendar/time";
import { formatTimezoneAbbrev } from "@/lib/calendar/timezone-label";
import { CalendarEventBlock } from "./calendar-event-block";

type ScheduleTimeSeed = { goalId?: string; taskId?: string; routineId?: string; date?: string; start?: string; end?: string };

/**
 * 日视图纵向时间轴，含时区标签、当前时间线与重叠布局。
 */
export function DayTimeline({
  date,
  todayKey,
  timezone,
  now,
  items,
  goals,
  selectedBlockId,
  onSelect,
  onFeedback,
  onComplete,
  onAdd,
  onUpdateTime,
}: {
  date: string;
  todayKey: string;
  timezone: string;
  now: Date;
  items: ScheduleItem[];
  goals: Goal[];
  selectedBlockId: string | null;
  onSelect: (id: string) => void;
  onFeedback: (id: string) => void;
  onComplete: (id: string) => void;
  onAdd: (seed?: ScheduleTimeSeed) => void;
  onUpdateTime: (item: ScheduleItem, start: string, end: string, date?: string) => Promise<void>;
}) {
  const startHour = TIMELINE_START_HOUR;
  const endHour = TIMELINE_END_HOUR;
  const startMinutes = startHour * 60;
  const timelineHeight = timelineHeightPx(startHour, TIMELINE_END_MINUTES);
  const labelMinutes = [...Array.from({ length: endHour - startHour + 1 }, (_, index) => startMinutes + index * 60), TIMELINE_END_MINUTES];
  const currentMinutes = timeMinutesInTimezone(now, timezone);
  const currentTop = ((currentMinutes - startMinutes) / 60) * HOUR_HEIGHT;
  const showNow = date === todayKey && currentTop >= 0 && currentTop <= timelineHeight;
  const positioned = useMemo(() => assignOverlapLayout(items, startHour), [items, startHour]);
  const shellRef = useRef<HTMLDivElement>(null);
  const positionedDateRef = useRef<string | null>(null);
  const [timelineMounted, setTimelineMounted] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setTimelineMounted(true), 0);
    return () => window.clearTimeout(timer);
  }, []);

  /**
   * 打开日视图时滚动到当前时间或首个日程附近。
   */
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || positionedDateRef.current === date) return;
    const frame = window.requestAnimationFrame(() => {
      positionedDateRef.current = date;
      if (date === todayKey && showNow) {
        shell.scrollTop = Math.max(0, currentTop - shell.clientHeight * 0.5);
        return;
      }
      if (items.length) {
        const firstMinutes = parseClock(items[0].start);
        shell.scrollTop = Math.max(0, ((firstMinutes - startHour * 60) / 60) * HOUR_HEIGHT - 48);
        return;
      }
      shell.scrollTop = Math.max(0, (10 - startHour) * HOUR_HEIGHT);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [date, showNow, currentTop, items, startHour, todayKey]);

  /**
   * 双击空白格按位置预填新建日程。
   * @param event - lane 鼠标事件
   */
  function handleLaneDoubleClick(event: MouseEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest(".calendar-event-block")) return;
    const lane = event.currentTarget;
    const rect = lane.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const minutesFromDayStart = snapMinutes(Math.round((y / HOUR_HEIGHT) * 60));
    const startMins = clampTimelineMinutes(startHour * 60 + minutesFromDayStart, startHour, endHour - 1);
    const endMins = Math.min(endHour * 60, startMins + 30);
    onAdd({ date, start: formatClock(startMins), end: formatClock(endMins) });
  }

  return (
    <div className="day-timeline-module">
      <div className="hourly-timeline-shell calendar-scroll" ref={shellRef}>
        <div className="hour-label-column" style={{ height: `${timelineHeight}px` }}>
          <span className="hour-timezone-label">{formatTimezoneAbbrev(timezone)}</span>
          {labelMinutes.map((minute) => (
            <span key={minute} style={{ top: `${((minute - startMinutes) / 60) * HOUR_HEIGHT}px` }}>{formatTimelineMinute(minute)}</span>
          ))}
        </div>
        <div
          className="hourly-lane hourly-lane-interactive"
          style={{ height: `${timelineHeight}px`, "--hour-height": `${HOUR_HEIGHT}px` } as React.CSSProperties}
          onDoubleClick={handleLaneDoubleClick}
        >
          {labelMinutes.slice(0, -1).map((minute) => (
            <div className="hour-gridline" key={minute} style={{ top: `${((minute - startMinutes) / 60) * HOUR_HEIGHT}px` }} />
          ))}
          <div className="hour-gridline timeline-end-line" style={{ top: `${timelineHeight}px` }} />
          {timelineMounted && showNow && (
            <div className="current-time-line" style={{ top: `${currentTop}px` }}>
              <span>现在 {formatTimeInTimezone(now, timezone)}</span>
              <i />
            </div>
          )}
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
              variant="day"
              selected={selectedBlockId === block.item.id}
              onSelect={onSelect}
              onFeedback={onFeedback}
              onComplete={onComplete}
              onUpdateTime={onUpdateTime}
            />
          ))}
          {!items.length && (
            <div className="hourly-empty">
              <Leaf size={18} />
              <strong>这一天还没有安排</strong>
              <span>留白也可以，或放入一件真正想推进的事。</span>
              <button type="button" onClick={() => onAdd({ date })}><Plus size={14} />安排一件事</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
