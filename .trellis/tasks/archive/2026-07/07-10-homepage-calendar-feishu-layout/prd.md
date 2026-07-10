# PRD：首页日历飞书式布局改造

**状态：已完成（2026-07-10）**

## Goal

将首页左侧日历从卡片式低信息密度布局升级为飞书式专业日历（日/周/月），保留 RnR 紫色视觉与 Routine/Task 产品特性，并支持移动审计供 Agent 洞察。

## Background

- 需求文档：`docs/v0.3.0 版本需求/优化布局-首页日历布局参考飞书优化.md`
- 实现：`src/components/calendar/` + `src/lib/calendar/` + `TodayView` in `product-shell.tsx`
- 右侧建议卡片已完成，本次仅改造左侧 `rhythm-card` 日历区域

## Confirmed Product Decisions

| Topic | Decision |
|-------|----------|
| Scope | v0.3.0 交付 P0 + P1 + P2 全量 |
| Week start | 周一 |
| Time axis | 07:00–24:00 |
| Timezone label | 跟随 `userSettings.timezone` |
| Block interaction | 分层：紧凑块 + 日视图图标操作 + 单击侧滑详情 |
| Routine drag | 静默仅调整本次实例 |
| Move audit | Task 改期链 + Agent 字段增强 |
| Detail panel | 日历区域内嵌侧滑，块高亮 + 同色条 + 220–280ms 动效 |
| Filters | Routine / 已完成 toolbar chip |
| Overlap | 等宽分列，>3 条显示 +N |
| Header | 精简一行「今日轨道 · n/m 已完成」 |

## Delivered

### P0 — 核心视图

1. 飞书式统一顶栏
2. 日视图纵向时间轴，块 top/height 按时长计算
3. 周视图 7 列时间网格
4. 日/周当前时间红线
5. 视图切换保留 anchorDate；prev/next 按视图步进

### P1 — 交互补全

1. 月视图事件摘要、+N、点日期进日视图
2. 块颜色按 kind 区分
3. 单击块打开侧滑详情面板
4. 双击空白时间创建日程

### P2 — 高级交互

1. 日/周拖拽移动与边缘拉伸（15min 吸附）
2. 重叠日程并排布局
3. Routine 拖拽静默 recordRoutineExecution(rescheduled)
4. 打开日视图时滚到当前时间附近

### 移动审计

- Task/个人：改期链 moveInPlace=false
- Routine：RoutineExecutionRecord 含 planned/rescheduled 时间
- Agent：read_execution_history 暴露改期字段

## Acceptance Criteria

- [x] 9.1 日视图
- [x] 9.2 周视图
- [x] 9.3 月视图
- [x] 9.4 视图切换与导航
- [x] 11.1 侧滑详情面板
- [x] 11.2 移动审计与 Agent 可读

## Follow-ups (next iteration)

- 详情面板内联完整编辑，替代 Modal
- 月视图拖事件改日期
- 拖拽框选新建日程
- +N 更多展开列表

## Out of Scope

- 用户可配置工作时间范围
- Routine 拖拽弹窗改规则时间
- 右侧建议卡片改动

## Validation

```bash
npm run typecheck && npm run lint && npm run build
```

人工：首页日/周/月切换与样式已确认。
