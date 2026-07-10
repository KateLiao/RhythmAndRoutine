"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowRightLeft,
  Ban,
  Check,
  CheckCircle2,
  Circle,
  CircleSlash,
  ClipboardPen,
} from "lucide-react";
import clsx from "clsx";
import type { Goal, ScheduleItem } from "@/lib/demo-data";
import { HOUR_HEIGHT, TIMELINE_END_HOUR, TIMELINE_START_HOUR } from "@/lib/calendar/constants";
import { blockColumnStyle, blockGeometry } from "@/lib/calendar/layout";
import { clampBlockTimes, formatClock, parseClock, snapMinutes } from "@/lib/calendar/time";

type DragKind = "move" | "resize-start" | "resize-end";

/**
 * 飞书式紧凑日程块，支持日/周视图、重叠分列、拖拽与图标操作。
 */
export function CalendarEventBlock({
  item,
  goals,
  top,
  height,
  column = 0,
  columnCount = 1,
  hiddenCount = 0,
  variant = "day",
  selected = false,
  startHour = TIMELINE_START_HOUR,
  endHour = TIMELINE_END_HOUR,
  onSelect,
  onFeedback,
  onComplete,
  onUpdateTime,
  onOverflowClick,
}: {
  item: ScheduleItem;
  goals: Goal[];
  top: number;
  height: number;
  column?: number;
  columnCount?: number;
  hiddenCount?: number;
  variant?: "day" | "week";
  selected?: boolean;
  startHour?: number;
  endHour?: number;
  onSelect: (id: string) => void;
  onFeedback: (id: string) => void;
  onComplete: (id: string) => void;
  onUpdateTime: (item: ScheduleItem, start: string, end: string, date?: string) => Promise<void>;
  onOverflowClick?: (items: ScheduleItem[]) => void;
}) {
  const goal = goals.find((entry) => entry.id === item.goalId);
  const task = goal?.tasks?.find((entry) => entry.id === item.taskId);
  const rhythmTag = rhythmConditionLabels(task?.rhythmConditions)[0];
  const [preview, setPreview] = useState<{ start: string; end: string; date?: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ kind: DragKind; pointerId: number; startX: number; startY: number; originStart: number; originEnd: number; originDate?: string } | null>(null);
  const movedRef = useRef(false);
  const commitRef = useRef(false);

  if (hiddenCount > 0) {
    const col = blockColumnStyle(column, columnCount, hiddenCount);
    return (
      <button
        type="button"
        className="calendar-event-block overflow-chip"
        style={{ top: `${top}px`, left: col.left, width: col.width, height: `${Math.max(height, 18)}px` }}
        onClick={() => onOverflowClick?.([item])}
      >
        +{hiddenCount} 更多
      </button>
    );
  }

  const displayStart = preview?.start ?? item.start;
  const displayEnd = preview?.end ?? item.end;
  const previewGeometry = preview ? blockGeometry(displayStart, displayEnd, startHour) : null;
  const displayTop = previewGeometry?.top ?? top;
  const displayHeight = previewGeometry?.height ?? height;
  const compact = displayHeight < 36;
  const weekStacked = variant === "week" && displayHeight >= 48;
  const col = blockColumnStyle(column, columnCount, 0);

  /**
   * 开始拖动或拉伸日程块。
   * @param kind - 拖动类型
   * @param event - 指针事件
   */
  function beginDrag(kind: DragKind, event: ReactPointerEvent<HTMLElement>) {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      kind,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originStart: parseClock(item.start),
      originEnd: parseClock(item.end),
      originDate: item.date,
    };
    movedRef.current = false;
    setDragging(true);
  }

  /**
   * 根据指针位移更新预览时间（及周视图日期）。
   * @param event - 指针移动事件
   */
  function handlePointerMove(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (Math.abs(event.clientY - drag.startY) > 2 || Math.abs(event.clientX - drag.startX) > 2) movedRef.current = true;
    const deltaMinutes = snapMinutes(Math.round(((event.clientY - drag.startY) / HOUR_HEIGHT) * 60));
    let nextStart = drag.originStart;
    let nextEnd = drag.originEnd;
    if (drag.kind === "move") {
      nextStart = drag.originStart + deltaMinutes;
      nextEnd = drag.originEnd + deltaMinutes;
    } else if (drag.kind === "resize-start") {
      nextStart = drag.originStart + deltaMinutes;
    } else {
      nextEnd = drag.originEnd + deltaMinutes;
    }
    const clamped = clampBlockTimes(nextStart, nextEnd, startHour, endHour);
    let nextDate = drag.originDate;
    if (variant === "week" && drag.kind === "move" && columnCount > 0) {
      const lane = (event.currentTarget as HTMLElement).closest(".week-day-lane") as HTMLElement | null;
      const grid = lane?.closest(".week-timeline-grid");
      if (grid) {
        const rect = grid.getBoundingClientRect();
        const dayWidth = rect.width / 7;
        const dayOffset = Math.max(0, Math.min(6, Math.floor((event.clientX - rect.left) / dayWidth)));
        const weekStart = grid.getAttribute("data-week-start");
        if (weekStart) {
          const date = new Date(`${weekStart}T12:00:00`);
          date.setDate(date.getDate() + dayOffset);
          nextDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        }
      }
    }
    setPreview({ start: formatClock(clamped.start), end: formatClock(clamped.end), date: nextDate });
  }

  /**
   * 结束拖动并提交时间变更。
   * @param event - 指针抬起事件
   */
  function handlePointerUp(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    const nextPreview = preview;
    setPreview(null);
    if (nextPreview && !commitRef.current && (nextPreview.start !== item.start || nextPreview.end !== item.end || (nextPreview.date && nextPreview.date !== item.date))) {
      commitRef.current = true;
      void onUpdateTime({ ...item, date: nextPreview.date ?? item.date }, nextPreview.start, nextPreview.end, nextPreview.date).finally(() => { commitRef.current = false; });
    }
  }

  return (
    <article
      className={clsx(
        "calendar-event-block",
        item.kind,
        item.status,
        variant,
        compact && "is-compact",
        weekStacked && "is-week-stacked",
        selected && "is-selected",
        dragging && "is-dragging",
        preview && "is-resizing",
      )}
      style={{ top: `${displayTop}px`, height: `${displayHeight}px`, left: col.left, width: `calc(${col.width} - 4px)` }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <span className="calendar-event-accent" aria-hidden="true" />
      <span className="calendar-event-resize calendar-event-resize-top" onPointerDown={(event) => beginDrag("resize-start", event)} aria-hidden="true" />
      <span className="calendar-event-resize calendar-event-resize-bottom" onPointerDown={(event) => beginDrag("resize-end", event)} aria-hidden="true" />
      <div className="calendar-event-body">
        <div
          className="calendar-event-main"
          role="button"
          tabIndex={0}
          onPointerDown={(event) => beginDrag("move", event)}
          onClick={() => { if (!movedRef.current) onSelect(item.id); }}
          onKeyDown={(event) => { if (event.key === "Enter") onSelect(item.id); }}
        >
          <div className="calendar-event-line">
            <span className="calendar-event-time">{displayStart}</span>
            <strong className="calendar-event-title">{item.kind === "routine" ? `↻ ${item.title}` : item.title}</strong>
          </div>
          {!compact && (
            <div className="calendar-event-sub">
              {displayStart} – {displayEnd}
              {rhythmTag ? ` · ${rhythmTag}` : ""}
            </div>
          )}
        </div>
        <div className="calendar-event-actions">
          <StatusIcon status={item.status} />
          {variant === "day" && item.status !== "completed" && (
            item.kind === "personal" ? (
              <button type="button" className="calendar-icon-btn" aria-label="完成" onClick={(event) => { event.stopPropagation(); void onComplete(item.id); }}>
                <Check size={14} />
              </button>
            ) : (
              <button type="button" className="calendar-icon-btn" aria-label="记录执行" onClick={(event) => { event.stopPropagation(); onFeedback(item.id); }}>
                <ClipboardPen size={14} />
              </button>
            )
          )}
        </div>
      </div>
    </article>
  );
}

/**
 * 按状态渲染日程块角标图标。
 * @param status - 日程状态
 */
function StatusIcon({ status }: { status: ScheduleItem["status"] }) {
  if (status === "completed") return <CheckCircle2 size={14} className="calendar-status-icon completed" aria-label="已完成" />;
  if (status === "missed") return <CircleSlash size={14} className="calendar-status-icon missed" aria-label="未完成" />;
  if (status === "rescheduled") return <ArrowRightLeft size={14} className="calendar-status-icon rescheduled" aria-label="已改期" />;
  if (status === "cancelled") return <Ban size={14} className="calendar-status-icon cancelled" aria-label="已取消" />;
  if (status === "planned") return <Circle size={14} className="calendar-status-icon planned" aria-label="待执行" />;
  return null;
}

function rhythmConditionLabels(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(rhythmConditionLabels);
  if (typeof value !== "object") return [];
  const condition = value as { preferredTimeOfDay?: unknown; notes?: unknown };
  const timeLabel = typeof condition.preferredTimeOfDay === "string"
    ? ({ morning: "上午", afternoon: "下午", evening: "晚上", anytime: "任意时段" } as Record<string, string>)[condition.preferredTimeOfDay] ?? condition.preferredTimeOfDay
    : "";
  const notes = typeof condition.notes === "string" ? condition.notes.trim() : "";
  return [timeLabel, notes].filter(Boolean);
}
