# V0.4.0 版本整合设计

## 1. 版本主线

V0.4.0 解决的是同一个核心问题：**系统必须用可验证事实帮助用户向前，而不是用内部结构制造进度感或让 Agent 猜测执行。**

- 目标侧把计划数量、真实投入、阶段成果、生命周期和成就拆成独立概念。
- Agent 侧把意图、计划、依赖、工具结果和确认边界变成可观察、可测试的结构。
- 两侧共享“确定性事实优先、模型负责解释与建议、用户控制正式成果”的原则。

## 2. 两个子任务的接口

| 目标执行系统产物 | Agent 使用方式 | 约束 |
|---|---|---|
| Goal lifecycle status | 作为当前业务状态读取 | 不再存在 readiness/confirmed 意图 |
| Goal summary / execution facts | progress_evaluation、planning、review 的事实输入 | 不用任务比例推导完成度 |
| planningHints / actionHint | Agent 可解释或提出下一步 | 动态提示，不写回 Goal.status |
| Achievement definitions/progress | 只读解释与展示 | Agent 不能主观解锁 |
| Milestone criteria | 规划时可建议补充 | 修改必须走 ChangeSet |
| MilestoneReviewSuggestion | Agent/评估器可创建建议 | 用户确认才完成 Milestone |

Agent 路由测试必须增加 Goal readiness 删除后的用例，例如“已经安排日程但结构不完整”的目标仍应进入 planning/progress，而不是要求先确认目标。

## 3. 统一数据与权限原则

```text
事实层：日程、执行、Routine、用户确认、生命周期
  ↓ 确定性投影
判断层：投入摘要、action hint、成就 evaluator、里程碑守卫
  ↓ 可解释证据
建议层：Agent 意图、计划、ChangeSet、Milestone suggestion
  ↓ 用户确认
正式变化：目标结构调整、Milestone/Outcome 完成、ChangeSet 应用
```

- Agent 不把概率或文字判断写成业务事实。
- 成就解锁由规则和证据决定；错误数据更正有审计撤销，普通状态变化不撤销。
- Milestone 完成、Outcome 完成、ChangeSet 应用保持用户确认边界。
- 所有并行只发生在事实读取层；进入草案写入或用户确认前必须串行屏障和证据版本校验。

## 4. 推荐版本切片

### Slice 0：测量与兼容基础

- Goal/Agent 当前数据和性能基线。
- 停止产生 DRAFT，保留兼容读取。
- Agent eval 基础设施、能力矩阵和 baseline。
- 所有新能力 feature flag 默认关闭。

### Slice 1：真实目标反馈

- 统一 GoalExecutionFacts 与列表 summary。
- 目标列表切换为本周投入 + 生命周期 + action hint，移除百分比/待澄清。
- Agent context 开始读取新 summary，但暂不改变工具调度。

### Slice 2：成就与里程碑建议

- AchievementDefinition / GoalAchievement 与历史 dry-run/backfill。
- Achievement Shelf 与完整收藏 UX。
- Milestone criteria、suggestion、去重/冷却和用户确认流程。

### Slice 3：Agent 准确率与速度

- IntentResolution shadow → active。
- 复杂请求 ExecutionPlan。
- ContextBuilder 并行、同批 read tool scheduler、显式证据守卫。
- QA 门禁、trace UI 和发布报告。

### Slice 4：收缩与封板

- DRAFT→ACTIVE 零损失迁移，观察后删除 enum/类型/兼容分支。
- 全量跨模块验收、恢复演练、性能/准确率对比。
- 清理 feature flag 仅在稳定期后进行，不与数据迁移同一次发布。

## 5. 依赖关系

```text
数据与评测基线
 ├─ Goal DRAFT 兼容写入 ─ Goal facts/summary ─ Achievement
 │                                  └────────── Milestone suggestion
 └─ Agent eval baseline ─ Intent resolver ─ ExecutionPlan
                                      └──── Context/tool parallel

Goal facts + Agent plan/evidence contract
                 ↓
跨模块验收 ─ DRAFT 迁移 ─ 契约收缩 ─ V0.4.0 封板
```

Goal facts 是 progress_evaluation、成就和里程碑建议的共同前置。Agent 并行不依赖成就 UX，可独立开发；但最终必须用新 Goal 状态与里程碑边界跑端到端用例。

## 6. 风险与控制

| 风险 | 影响 | 控制 |
|---|---|---|
| DRAFT enum 一步删除 | 旧数据/客户端不兼容 | 扩展/收缩、备份、digest 校验、观察窗口 |
| 投入双来源重复 | 列表/成就虚高 | 稳定来源 ID 去重、改期链与 Routine 专项测试 |
| 成就变成新进度焦虑 | 偏离产品目标 | 不显示总完成百分比、不做断签惩罚、成就放次级区 |
| 模型错误建议里程碑完成 | 用户失去控制 | criteria + evidence 守卫，suggestion 独立，用户唯一确认 |
| 多意图增加延迟 | 准确但变慢 | 简单 fast path，复杂请求才建 plan |
| 并行破坏工具协议/写入幂等 | 错误结果或重复 ChangeSet | 仅 read、原序组装、显式 evidence、写屏障、mock scenarios |
| Eval 为指标优化而失真 | 离线好看、线上变差 | 困难用例保留、真实模型抽样、失败人工复核、安全项 100% |

## 7. 统一发布门禁

### 产品正确性

- 所有目标卡片不显示目标完成百分比或待澄清；真实投入和生命周期准确。
- 已有数据除了 4 个旧 DRAFT→ACTIVE 外无业务字段、ID、关系或历史变化。
- 成就/里程碑建议可追溯、幂等，用户确认边界无法被 Agent 绕过。

### Agent 正确性

- Router/Planner/Runtime 指标达到子任务门槛；安全不变量 100%，重复写入 0。
- 意图、计划、依赖、工具批次、失败和确认点可在 AgentRun 中追踪。
- 准确率、成功率没有为时延优化退化超过门槛。

### 性能与兼容

- Goal summary 无 N+1；历史回溯不阻塞在线请求。
- Context P50、eligible batch P95 达到性能目标，并报告端到端 P50/P95。
- server、browser-local、demo/fallback、旧 AgentRun、旧数据均有回归用例。

### 发布安全

- 数据库备份可恢复，迁移校验脚本和反向迁移经过演练。
- feature flags 可独立关闭 router/planner/context parallel/tool parallel/achievement/suggestion。
- 不在一次发布中同时做历史回溯、Agent 调度切换和 enum 收缩。

## 8. 版本完成定义

V0.4.0 完成不是“代码合并”，而是：两套子任务验收全通过；当前数据零损失；目标反馈不再误导；Agent 有可重复质量基线并实现安全性能提升；跨层路径有可解释 trace；回滚与恢复已验证。

## 9. 决策状态

Milestone completionCriteria 兼容规则，以及 Agent QA 首发数据集规模、指标和运行频率均已确认。V0.4.0 已无待澄清范围项，可按实施计划进入开发。
