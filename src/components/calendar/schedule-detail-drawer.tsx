"use client";

import { useEffect } from "react";
import { Pencil, Trash2, X, ClipboardPen, Check } from "lucide-react";
import clsx from "clsx";
import type { Goal, ScheduleItem } from "@/lib/demo-data";

/**
 * 日程详情侧滑面板：与选中块同色条联动，承载查看与操作入口。
 */
export function ScheduleDetailDrawer({
  item,
  goals,
  open,
  onClose,
  onFeedback,
  onComplete,
  onEdit,
  onDelete,
}: {
  item: ScheduleItem | null;
  goals: Goal[];
  open: boolean;
  onClose: () => void;
  onFeedback: (id: string) => void;
  onComplete: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!item) return null;
  const goal = goals.find((entry) => entry.id === item.goalId);
  const statusLabel = item.status === "completed" ? "已完成" : item.status === "missed" ? "未完成" : item.status === "rescheduled" ? "已改期" : item.status === "cancelled" ? "已取消" : "待执行";

  return (
    <>
      {open && <button type="button" className="calendar-drawer-backdrop" aria-label="关闭详情" onClick={onClose} />}
      <aside className={clsx("calendar-detail-drawer", open && "is-open", item.kind)} aria-hidden={!open}>
        <div className="calendar-detail-drawer-accent" aria-hidden="true" />
        <header className="calendar-detail-drawer-head">
          <div>
            <span className="calendar-detail-time">{item.date ?? "今天"} · {item.start}–{item.end}</span>
            <h3>{item.title}</h3>
          </div>
          <button type="button" className="calendar-icon-btn" aria-label="关闭" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="calendar-detail-body">
          <dl className="calendar-detail-meta">
            <div><dt>类型</dt><dd>{item.kind === "routine" ? "Routine" : item.kind === "review" ? "回顾" : item.kind === "personal" ? "个人" : "任务"}</dd></div>
            <div><dt>状态</dt><dd>{statusLabel}</dd></div>
            {goal && <div><dt>关联目标</dt><dd>{goal.title}</dd></div>}
            {item.changeReason && <div><dt>调整原因</dt><dd>{item.changeReason}</dd></div>}
          </dl>
          <div className="calendar-detail-actions">
            {item.status !== "completed" && item.kind === "personal" && (
              <button type="button" className="primary-button compact" onClick={() => onComplete(item.id)}><Check size={14} />完成</button>
            )}
            {item.status !== "completed" && item.kind !== "personal" && (
              <button type="button" className="primary-button compact" onClick={() => onFeedback(item.id)}><ClipboardPen size={14} />记录执行</button>
            )}
            <button type="button" className="soft-button compact" onClick={() => onEdit(item.id)}><Pencil size={14} />编辑</button>
            <button type="button" className="soft-button compact danger-outline" onClick={() => onDelete(item.id)}><Trash2 size={14} />取消日程</button>
          </div>
        </div>
      </aside>
    </>
  );
}
