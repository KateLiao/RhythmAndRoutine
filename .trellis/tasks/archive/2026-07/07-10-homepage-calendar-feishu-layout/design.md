# Design：首页日历飞书式布局改造

## Architecture

### 现状

日历 UI 全部内联于 `product-shell.tsx`（~3000 行）：`TodayView`、`HourlyDayTimeline`、`HourBlock`、`WeekCalendar`（列表式）、`MonthCalendar`。

### 目标结构

```
src/lib/calendar/
  constants.ts       # HOUR_HEIGHT, MIN_EVENT_HEIGHT, 时间范围
  layout.ts          # top/height 计算、重叠分列算法
  navigation.ts      # selectedDate、周/月游标、标题格式化
  timezone-label.ts  # 时区缩写

src/components/calendar/
  calendar-toolbar.tsx
  calendar-header.tsx          # 精简「今日轨道」行
  day-timeline.tsx
  week-timeline.tsx
  month-calendar.tsx
  calendar-event-block.tsx     # 日/周共用块
  schedule-detail-drawer.tsx
  overlap-overflow-list.tsx    # +N 展开

src/components/product-shell.tsx  # TodayView 编排，接入上述组件
src/app/globals.css               # 日历样式分区重构
```

后端小改：

- `src/components/product-shell.tsx`：`updateScheduleTime` 非 Routine 改 `moveInPlace: false`，`changeReason: "拖动调整时间"`
- `src/agent/prisma-context-source.ts`：`getExecutionHistory` 补充 Routine 改期时间字段

## Data Flow

```
ScheduleItem[] (props)
  → filter (Routine/已完成 chip)
  → per-view slice (日/周/月日期范围)
  → layout.assignOverlapColumns(blocks)
  → CalendarEventBlock (position + column width)
  → onEdit → ScheduleDetailDrawer
  → onUpdateTime → updateScheduleTime (audit path)
```

### Calendar State（`TodayView`）

```ts
calendarMode: "today" | "week" | "month"
anchorDate: string          // YYYY-MM-DD，三视图共享
selectedBlockId: string | null
drawerOpen: boolean
showRoutines / showCompleted
```

- 日视图：`anchorDate` 即选中天
- 周视图：包含 `anchorDate` 的那一周（周一起）
- 月视图：包含 `anchorDate` 的那一月
- prev/next：日 ±1、周 ±7、月 ±1
- 「今天」：`anchorDate = today`

## Layout Constants

```ts
TIME_COLUMN_WIDTH = 64
HOUR_HEIGHT = 72
MIN_EVENT_HEIGHT = 18
TIMELINE_START_HOUR = 7
TIMELINE_END_HOUR = 24
SNAP_MINUTES = 15
```

块高度：`max(MIN_EVENT_HEIGHT, durationMinutes / 60 * HOUR_HEIGHT)` — **移除** 原 `HOUR_BLOCK_MIN_HEIGHT = 72` 下限。

## Overlap Algorithm

1. 按 start 排序，构建重叠簇（区间相交）
2. 簇内 column assignment（贪心：每条放第一个不冲突列）
3. 渲染：
   - columns ≤ 3：等宽 `100% / columns`
   - columns > 3：col0/col1 各 40%，col2 为 `+{n-2} 更多` 占位

## Schedule Detail Drawer

- 父容器：`rhythm-card` 内 `position: relative; overflow: hidden`
- 日历区 `flex: 1` + drawer `width: 35%`，`transform: translateX(100%)` → `0`
- `selectedBlockId` 驱动块 `.is-selected` 与 drawer 色条
- 内容复用 `ScheduleEditModal` / `FeedbackModal` 表单项（内联组件化，非居中 Modal）

## Move Audit

| kind | API |
|------|-----|
| routine_occurrence | `recordRoutineExecution({ status: "rescheduled", planned*, rescheduled* })` |
| goal_task / personal | `updateSchedule({ moveInPlace: false, changeReason: "拖动调整时间", startsAt, endsAt })` |

周视图横向拖：改 `date` + `start/end`（Routine 仍走 execution 路径）。

## CSS 要点

- `.calendar-shell` 固定高度 + 内部 `.calendar-scroll` 滚动
- sticky：toolbar + week-day-header
- `.calendar-event-block.is-selected` 紫色边框
- `@media (prefers-reduced-motion: reduce)` 禁用 drawer 动画
- 移动端：drawer 全宽覆盖日历

## Compatibility

- 不改变 Prisma schema
- `ScheduleItem` 类型不变
- 现有 `onAdd` / `onFeedback` / `onComplete` 回调保留

## Risks

| Risk | Mitigation |
|------|------------|
| `product-shell.tsx` 改动面大 | 分文件抽取，每阶段 typecheck |
| 改期链导致块 ID 变化 | 拖动后 `refreshDatabase`，更新 `selectedBlockId` |
| 周视图性能 | 单周最多 ~几十块，无虚拟化需求 |
