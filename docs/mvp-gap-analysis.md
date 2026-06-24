# Rhythm & Routine MVP 最新缺口分析

> 分析日期：2026-06-20（最后更新：2026-06-20）  
> 对照基准：`design-note.md`、`docs/development-spec.md`  
> 代码范围：业务服务、API、Agent Harness、`product-shell.tsx`、Prisma Schema  
> 说明：本文只保留当前仍存在的 Gap；已经补完的旧条目已删除。原型级视觉差异单列，不混入 MVP 功能缺口。

## 1. 结论

当前版本已经能够演示完整主链路：

```text
Goal → 澄清/规划 → ChangeSet 确认 → Task/Routine 排期
→ 执行反馈 → 日/周 Review → 调整草案 → 用户确认
```

本轮补齐后，6 个 P0 Gap 和 6 个 P1 Gap 已全部修复，MVP 核心业务验收清单可视为完整。
剩余部分为 **体验层** 和 **端到端自动化测试** 工作，不阻塞功能验收。

## 2. 当前仍存在的 Gap（体验层）

| # | 优先级 | 模块 | Gap | 说明 |
| --- | --- | --- | --- | --- |
| 1 | P2 | Time / Schedule | **跨午夜日程 UI 仅有一个日期** | 结束时间早于开始时间会校验失败；月视图翻页不重新拉取窗口数据 |
| 2 | P2 | Experience | **首次使用引导（Onboarding）未完成** | 没有引导用户完成 Goal→澄清→排期→反馈 的首次流程 |
| 3 | P2 | Experience | **数据库加载失败缺显式重试** | 数据库失败直接进入本地模式，用户无法感知并重试 |

## 3. 验收清单状态（2026-06-20 更新）

`development-spec.md` §8 验收项最新状态：

| 验收项 | 状态 | 说明 |
| --- | --- | --- |
| 用户可以移动、改期、取消和删除日程块 | `[x]` | 统一 reschedule 路径已完成；cancel/delete 语义分离；Task 状态聚合 |
| Agent Run、Step、Tool Call、Token Usage 和错误可查询 | `[x]` | stream_options include_usage 已补；fallback 独立 step 事件；cancel/retry API |
| 时区转换、跨日时间块和夏令时边界不改变真实时刻 | `[~]` | Routine 物化和手动 Review 已贯通用户时区；跨午夜 UI 尚待前端修正 |

## 4. 本轮已修复的 P0/P1 Gap

| # | 模块 | 修复内容 | 关键文件 |
| --- | --- | --- | --- |
| P0-G1 | Review | AI Review 通过 `generateObject` 生成结构化结果并持久化；AI 失败时回退规则并在 `metrics.source` 标明来源 | `server/services/reviews.ts` |
| P0-G2 | Rhythm Signal | Agent 通过 `generateObject` 提取结构化信号；规则引擎作为降级路径 | `server/services/reviews.ts` |
| P0-G3 | Schedule | 统一 `rescheduleScheduleBlockTx`，手动、ChangeSet、执行反馈三路复用；ChangeSet update 时间变化时创建后继块 | `server/services/schedule.ts`, `change-sets.ts` |
| P0-G4 | Approval Gate | `createPendingChangeSet` 服务端主动读取所有 update/archive 对象当前版本写入 `baseVersions`；`assertVersions` 强制校验，缺版本直接拒绝 | `server/services/change-sets.ts` |
| P0-G5 | Time / Routine | Routine 物化使用用户时区计算日期和星期；`zonedDateToUtcHour` 处理 DST 跳变 | `server/services/routines.ts` |
| P0-G6 | Planning | `taskDraftSchema` 新增结构化 `rhythmConditions` 字段；新增 `reviewResultSchema`、`rhythmSignalExtractionSchema` | `domain/schemas.ts` |
| P1-G7 | Agent Trace | `stream_options.include_usage` 已添加；`FallbackModelAdapter.generateObject` 实现降级 | `agent/openai-compatible-adapter.ts`, `agent/fallback-model-adapter.ts` |
| P1-G8 | Agent Reliability | 工具 schema 校验失败进入最多 2 次的显式修复流程；耗尽后标记 `TOOL_SCHEMA_EXHAUSTED` 且不可重试 | `agent/runtime.ts` |
| P1-G9 | Agent Lifecycle | Run cancel API（同步拒绝关联 ChangeSet）；Run retry API（创建关联新 Run，不复用幂等键） | `api/agent/runs/[id]/cancel`, `api/agent/runs/[id]/retry` |
| P1-G10 | Schedule Lifecycle | `cancelScheduleBlock`（保留历史可见）vs `deleteScheduleBlock`（仅限无执行记录草稿）；API 路由 POST=取消、DELETE=软删除 | `server/services/schedule.ts`, `api/schedule/[id]/route.ts` |
| P1-G11 | Task State | `aggregateTaskStatus` 根据所有有效日程块状态聚合 Task 状态；改期/取消/删除均触发聚合 | `server/services/schedule.ts`, `change-sets.ts` |

## 5. 不是 MVP 功能 Gap、但仍未对齐原型的体验项

以下内容来自 `prototype/`，`development-spec.md` 的 MUST 范围没有要求必须采用同样的信息架构，因此不列入 MVP Todo：

- 独立 Task 详情路由；当前为 Goal 详情中的折叠编辑器。
- 独立 Goal 详情页；当前为完整编辑 Modal。
- 日程一体化侧滑抽屉；当前为编辑与反馈两个 Modal。
- 按小时 × 七天的周视图；当前是七天分栏列表。
- 更丰富的目标投入图表、节奏签名与动效。

这些可作为 MVP 验收后的 UI 重构，不应阻塞核心业务验收。

## 6. 已完成并从旧 Gap 表删除的能力

- Task / Routine 关联排期及 Task `scheduled` 联动。
- 手动改期历史、`rescheduledFromId` 与 `changeReason`。
- 执行记录回看修正及完整反馈字段。
- 日/周 Review Tab、生成、确认、失败重试。
- Review 页 Milestone / Outcome 用户确认。
- Planning 专用 schema、Outcome→Milestone→Task→Routine 草案树与逐项确认。
- ChangeSet before/after、正式拒绝、Goal/Outcome/Milestone/Task/Routine 写入。
- Agent 绑定选中 Goal、新建 Goal 后进入澄清入口。
- Context Builder 读取真实 DB、Rhythm Signal read tool。
- AgentRun / Step / ToolCall / Context Manifest 持久化与查询。
- 等待确认 ChangeSet 的刷新恢复、ChangeSet 与 AgentRun 关联。
- SSE 流式文本、Markdown、工具步骤可见、进度状态展示。
- Capability 模型配置与基础 fallback。
- Goal project/skill/category、Task focus 与节奏条件手动编辑、Routine RRULE UI。
- Outcome 软归档、Review `GENERATING/FAILED`、Cron 时区边界。
- 月视图翻页/图例、任意日期日视图、小律历史/清空/展开。
- 需求文档验收清单同步。
- **[本轮]** AI Review 生成与结构化持久化（含 Rhythm Signal 提取）。
- **[本轮]** 统一 reschedule 路径（手动/Agent/反馈三路一致）。
- **[本轮]** Approval Gate 强制版本保护（服务端主动采集）。
- **[本轮]** Routine 物化用户时区贯通。
- **[本轮]** Planning `rhythmConditions` 结构化字段。
- **[本轮]** stream_options include_usage + FallbackModelAdapter.generateObject。
- **[本轮]** 工具 schema 修复循环有限预算。
- **[本轮]** Run cancel/retry API。
- **[本轮]** ScheduleBlock cancel vs delete 语义分离。
- **[本轮]** Task 状态聚合规则。

## 7. 相关文档

- [MVP 开发规格](./development-spec.md)
- [UI 设计方向](./ui-design-direction.md)
- [产品设计笔记](../design-note.md)
- [交互原型](../prototype/index.html)
