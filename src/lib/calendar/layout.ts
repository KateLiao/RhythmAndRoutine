import type { ScheduleItem } from "@/lib/demo-data";
import { HOUR_HEIGHT, MIN_EVENT_HEIGHT, TIMELINE_START_HOUR } from "./constants";
import { parseClock } from "./time";

export type PositionedBlock = {
  item: ScheduleItem;
  top: number;
  height: number;
  column: number;
  columnCount: number;
  hiddenCount: number;
};

/**
 * 根据开始/结束时间计算日程块在时间轴上的 top 与 height（px）。
 * @param start - HH:mm 开始时间
 * @param end - HH:mm 结束时间
 * @param startHour - 时间轴起始小时
 */
export function blockGeometry(start: string, end: string, startHour = TIMELINE_START_HOUR) {
  const startMinutes = parseClock(start);
  const endMinutes = parseClock(end);
  const durationMins = Math.max(15, endMinutes - startMinutes);
  const top = Math.max(0, ((startMinutes - startHour * 60) / 60) * HOUR_HEIGHT);
  const height = Math.max(MIN_EVENT_HEIGHT, (durationMins / 60) * HOUR_HEIGHT);
  return { top, height, startMinutes, endMinutes, durationMins };
}

/**
 * 计算时间轴总高度（px）。
 * @param startHour - 起始小时
 * @param endMinutes - 结束分钟（如 24:30）
 */
export function timelineHeightPx(startHour = TIMELINE_START_HOUR, endMinutes = 24 * 60 + 30) {
  return ((endMinutes - startHour * 60) / 60) * HOUR_HEIGHT;
}

type TimedItem = { item: ScheduleItem; startMinutes: number; endMinutes: number };

/**
 * 判断两个时间区间是否重叠。
 * @param a - 区间 A
 * @param b - 区间 B
 */
function intervalsOverlap(a: TimedItem, b: TimedItem) {
  return a.startMinutes < b.endMinutes && b.startMinutes < a.endMinutes;
}

/**
 * 为重叠日程分配列索引，返回带布局信息的块列表。
 * @param items - 同日日程块
 * @param startHour - 时间轴起始小时
 */
export function assignOverlapLayout(items: ScheduleItem[], startHour = TIMELINE_START_HOUR): PositionedBlock[] {
  const timed: TimedItem[] = items
    .map((item) => {
      const geo = blockGeometry(item.start, item.end, startHour);
      return { item, startMinutes: geo.startMinutes, endMinutes: geo.endMinutes };
    })
    .sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);

  const clusters: TimedItem[][] = [];
  let cluster: TimedItem[] = [];
  let clusterEnd = -1;

  for (const entry of timed) {
    if (!cluster.length || entry.startMinutes < clusterEnd) {
      cluster.push(entry);
      clusterEnd = Math.max(clusterEnd, entry.endMinutes);
    } else {
      clusters.push(cluster);
      cluster = [entry];
      clusterEnd = entry.endMinutes;
    }
  }
  if (cluster.length) clusters.push(cluster);

  const result: PositionedBlock[] = [];

  for (const group of clusters) {
    const columns: TimedItem[][] = [];
    for (const entry of group) {
      let placed = false;
      for (const col of columns) {
        const last = col[col.length - 1];
        if (!intervalsOverlap(last, entry)) {
          col.push(entry);
          placed = true;
          break;
        }
      }
      if (!placed) columns.push([entry]);
    }

    const columnCount = columns.length;
    const maxVisible = 3;
    const overflow = columnCount > maxVisible;
    const effectiveCount = overflow ? maxVisible : columnCount;
    const hiddenCount = overflow ? columnCount - (maxVisible - 1) : 0;

    columns.forEach((col, columnIndex) => {
      if (overflow && columnIndex >= maxVisible - 1) {
        if (columnIndex === maxVisible - 1) {
          const entry = col[0];
          const geo = blockGeometry(entry.item.start, entry.item.end, startHour);
          result.push({
            item: entry.item,
            top: geo.top,
            height: geo.height,
            column: maxVisible - 1,
            columnCount: effectiveCount,
            hiddenCount,
          });
        }
        return;
      }
      col.forEach((entry) => {
        const geo = blockGeometry(entry.item.start, entry.item.end, startHour);
        result.push({
          item: entry.item,
          top: geo.top,
          height: geo.height,
          column: columnIndex,
          columnCount: effectiveCount,
          hiddenCount: 0,
        });
      });
    });
  }

  return result;
}

/**
 * 根据列信息计算日程块水平布局样式。
 * @param column - 列索引
 * @param columnCount - 总列数
 * @param hiddenCount - 折叠数量（+N）
 */
export function blockColumnStyle(column: number, columnCount: number, hiddenCount: number) {
  if (hiddenCount > 0) {
    return { left: `${(column / columnCount) * 100}%`, width: `${100 / columnCount}%`, isOverflow: true as const };
  }
  const widthPercent = 100 / columnCount;
  return { left: `${column * widthPercent}%`, width: `${widthPercent}%`, isOverflow: false as const };
}
