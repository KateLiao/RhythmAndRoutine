# 实施计划：首页日历飞书式布局改造

> **状态：已完成（2026-07-10）**  
> 需求：`docs/v0.3.0 版本需求/优化布局-首页日历布局参考飞书优化.md`

---

## Phase 1–10 总结

| Phase | 内容 | 状态 |
|-------|------|------|
| 1 | lib/calendar 基础设施 | ✅ |
| 2 | 顶栏 + anchorDate 导航 | ✅ |
| 3 | 日视图重构 | ✅ |
| 4 | 周视图 7 列网格 | ✅ |
| 5 | 月视图增强 | ✅ |
| 6 | 侧滑详情面板 | ✅（编辑仍走 Modal） |
| 7 | 拖拽 + 重叠布局 | ✅（月视图拖改日期待补） |
| 8 | 移动审计 + Agent | ✅ |
| 9 | 样式与响应式 | ✅ |
| 10 | typecheck / lint / build | ✅ |

## 关键文件

| 路径 | 说明 |
|------|------|
| `src/components/calendar/*` | 日历 UI 组件 |
| `src/lib/calendar/*` | 布局/导航/时区工具 |
| `src/components/product-shell.tsx` | TodayView 编排 |
| `src/app/globals.css` | 飞书式样式 |
| `src/agent/prisma-context-source.ts` | Agent 改期字段 |

## 后续迭代

1. 详情面板内联完整编辑/反馈
2. 月视图拖事件改日期
3. 空白拖拽框选建日程
4. +N 更多展开弹层
