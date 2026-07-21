# V0.4.0 目标执行系统现状研究

## 1. 已验证事实

### 1.1 目标列表把任务结构完成度当成目标进度

- `src/components/product-shell.tsx:1428-1434` 使用 `tasksDone / tasksTotal` 生成百分比和进度条。
- `src/lib/client-api.ts:185` 的 `tasksDone/tasksTotal` 由已完成任务数和全部任务数计算。
- 因此用户只要改变任务拆分颗粒度，目标“进度”就会改变；它不能稳定表达真实目标推进。

### 1.2 系统已经具备可复用的真实投入口径

- `docs/development-spec.md:112-115` 定义了真实投入：只统计已完成日程块，优先 `ExecutionRecord.actualMinutes`，缺失时回退计划时长，个人日程不计入目标投入。
- `src/lib/demo-data.ts` 的 `scheduleBelongsToGoal`、`scheduleInvestedMinutes`、`enrichGoalsWithScheduleStats` 已按目标/任务关联聚合累计与本周投入。
- `src/lib/schedule-investment.test.ts` 已覆盖目标直接关联、任务间接关联、个人日程排除、实际时长优先和计划时长回退。
- `src/components/product-shell.tsx:1456-1553` 的目标详情已经展示累计真实投入、本周真实投入、本周完成/安排、当前计划总量和每日分布。
- 结论：V0.4.0 不必新造“投入时间”数据模型；首要工作是统一服务端聚合与列表/详情展示口径，并明确时间只是投入证据，不等于成果。

### 1.3 Goal 的 DRAFT 没有形成行为边界

- `prisma/schema.prisma:10-16` 定义 `DRAFT / ACTIVE / PAUSED / COMPLETED / ARCHIVED`。
- 新建目标固定为 `DRAFT`（`src/server/services/goals.ts:38-45`）。
- `propose_planning` 的 ChangeSet 会把目标更新为 `active`（`src/agent/tool-registry.ts:82`）。
- 手动目标编辑只保存标题、说明、分类、项目、能力与日期，没有确认/激活动作（`src/components/product-shell.tsx:2185-2212`）。
- UI 将 draft 显示为“待澄清”，active 显示为“推进中”（`src/components/product-shell.tsx:1428-1434, 1469-1476`），并不存在用户可见的“已确认”状态或清晰的进入条件。
- 客户端 `Goal` 类型只声明 `active | draft | paused`，与数据库的 completed/archived 不完全一致（`src/lib/demo-data.ts:1-18`）。
- Task、Routine、Schedule 与执行路径只校验目标存在/未归档，并不以 DRAFT 阻止推进；当前 4 个 draft 目标中已有多个真实执行样本。
- 结论：DRAFT 由创建路径而非业务事实决定，既不能表达“尚未开始”，也没有可辩护的确认对象。最终决策是删除 readiness 语义，而不是补建确认流程。

### 1.4 Milestone 有状态枚举，但智能状态链路不闭合

- `prisma/schema.prisma:18-24` 定义 `PENDING / READY_FOR_REVIEW / COMPLETED / REJECTED / ARCHIVED`。
- Milestone 当前字段只有标题、说明、目标日期、状态、排序和完成时间；没有完成标准、证据、风险、置信度或建议来源（`prisma/schema.prisma:156-174`）。
- `planningDraftSchema` 只要求 milestone title/description/tasks（`src/domain/schemas.ts:37-45`）。
- 运行时代码没有把 `PENDING` 自动推进为 `READY_FOR_REVIEW` 的写入路径；该状态主要来自 demo 数据，Review 只读取它并提示用户确认。
- 页面中的 MilestoneRow 对所有未完成状态都允许直接“确认完成”，并未基于证据、完成标准或 review 建议区分（`src/components/product-shell.tsx:2358-2362`）。
- 现有设计文档明确规定 Agent 只能建议检查，Milestone/Outcome 只能由用户确认（`docs/Rhythm & Routine 应用设计与开发.md:106-128, 413-444`）。

## 2. 第一性原理拆分

### 2.1 目标页面需要回答的不是“完成了多少任务”

目标执行系统至少要回答四个不同问题：

1. **方向是否可执行**：成功标准、时间边界、投入约束是否足够清楚。
2. **本周期是否在行动**：投入了多少时间、执行了多少次、是否持续进入日历。
3. **是否产生阶段成果**：哪些可验证证据支持某个 Milestone 进入确认。
4. **是否需要调整**：相对时间窗与阶段预期，是正常、偏离、阻塞还是等待用户判断。

单一百分比无法同时回答以上四问。V0.4.0 应建立分层反馈，而非寻找另一个万能百分比。

### 2.2 推荐的信息层级

- **列表主指标**：本周真实投入（时间）+ 有效执行日，表达“目标正在发生”。
- **生命周期状态**：推进中 / 已暂停 / 已完成 / 已归档，表达 Goal 当前业务状态。
- **行动提示**：需调整 / 有里程碑待确认 / 本周无安排等确定性派生信号，作为独立第二行并指向可处理对象。
- **详情证据层**：累计投入、执行次数、成果证据、Milestone 状态、任务完成记录。
- **成就反馈**：只奖励可验证行为或成果（第一次真实投入、有效执行日、阶段成果确认），不把积分伪装成目标进度。

### 2.3 Milestone 的最小职责

Milestone 是“一个阶段成果的用户确认点”，必须至少具备：

- 可验证的阶段成果描述；
- 目标时间窗（可选但推荐）；
- 用户可读的完成标准；
- 关联任务/Routine 只是实现路径，不是完成证明；
- Agent 建议进入 review 的理由与证据快照；
- 用户确认、驳回、稍后处理和编辑标准的控制权。

正式 Milestone 生命周期与建议状态应分离：Milestone 继续使用 pending/completed/rejected/archived；独立 suggestion 使用 pending/snoozed/dismissed/accepted/superseded。Agent 创建 suggestion 不修改 Milestone，只有用户确认能把 Milestone 设为 completed。

### 2.4 规划完整度不应成为 Goal 状态

从第一性原理看，Goal.status 只应保留会改变用户下一步行为和查询范围的生命周期：active / paused / completed / archived。结构缺口改为动态 planning hints：

- 缺 Outcome：提示补充成功标准；
- 缺 Milestone：提示增加阶段检查点；
- 项目型且无 targetDate：提示补充期限或明确无固定期限；
- 已有真实执行：文案先承认已经推进，再说明补充结构能改善建议。

这些 hints 不持久化为 Goal 状态、不阻止手动执行，也不作为 Agent 静默修改结构的授权。完整决策与迁移证据见 `research/goal-status-decision.md`。

## 3. 风险与兼容性

- 列表统计目前依赖客户端一次加载近一年日程，长期可能造成数据量与口径漂移；建议增加服务端 goal execution summary 查询。
- `actualMinutes` 缺失回退计划时长会把“完成但未填实际时间”视为全额投入；UI 应标记估算值，评测中区分 recorded 与 inferred。
- 旧目标可能没有 Outcome/Milestone；迁移后应保持可查看、可手动执行，并提示补充而不是强制锁死。
- 游戏化若奖励任务数，会重新制造拆分套利；成就只能绑定稳定事件和用户确认成果。

## 4. 决策收敛

- 已确认：列表主反馈为本周真实投入 + 生命周期/行动提示，成果与成就为次级信息。
- 已确认：加入可复用、按目标类型组合的公开成就集合，不设计隐藏成就。
- 已确认：删除 Goal readiness 与 DRAFT 语义，现有 DRAFT 安全归一化为 ACTIVE，不新增 confirmed 字段。
- 已确认：Milestone suggestion 可自动生成，但定义变更和完成仍由用户控制。
