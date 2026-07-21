# V0.4.0 版本实施总计划

> 当前任务的交付是可开发规划，不自动启动产品实现。两个子任务的 `implement.md` 是详细执行清单，本文件只管理跨任务顺序、验收和发布控制。

## 1. 开发批次

### Batch 1：基线与兼容（可并行）

- 目标线：数据备份/摘要脚本、Goal 契约、停止新写 DRAFT、兼容旧读取。
- Agent 线：能力元数据、eval infrastructure、固定数据集和当前 baseline。
- 出口：不改变用户数据；新建路径一致；Agent 当前准确率/时延有可复现报告。

### Batch 2：事实层

- 实现 GoalExecutionFacts、summary、actionHint 与目标列表 UX。
- 实现 Agent IntentResolution shadow mode 与上下文 source 观测。
- 出口：目标卡不再展示百分比/待澄清；shadow 路由可对比但不改变线上行为。

### Batch 3：建议与收藏（可并行）

- 成就后端、dry-run、回溯、Achievement Shelf。
- Milestone criteria 与 suggestion 状态机。
- Agent ExecutionPlan 与确定性 validator。
- 出口：成就和建议幂等、可审计；复杂请求结构化但工具仍可串行。

### Batch 4：安全提速

- ContextBuilder 按需并行。
- 同批 independent read tools 并行、证据版本与事件协议。
- 接入新 Goal facts / milestone boundary 的端到端 Agent eval。
- 出口：性能门槛达成，安全不变量 100%，准确率无超限回归。

### Batch 5：迁移、观察与收缩

- DRAFT→ACTIVE 事务迁移及零损失核对。
- 观察一个兼容发布窗口；随后删除数据库 enum DRAFT 和临时兼容。
- 发布前真实模型抽样、恢复演练、跨模式全量验收。
- 出口：所有门禁通过后封板 V0.4.0。

## 2. 工作流控制

- 每个 Batch 开始前读取对应子任务 design/implement 与 `.trellis/spec/`。
- 每个可独立回退的变更单独审查，不合并无关 feature flag。
- schema 扩展先于数据回溯；数据回溯先于 enum 收缩。
- 真实数据只在 dry-run 摘要核对通过并有恢复点后变更。
- Agent 优化先 shadow/baseline，后启用；任何安全失败立即关闭对应 flag。

## 3. 跨模块必测旅程

1. 旧 draft 且已有投入的目标迁移后显示 active、本周投入正确、历史关联不变。
2. 用户要求“规划本周并判断进度”：识别多意图、并行读取共享事实、串行产生待确认草案，不出现目标百分比。
3. Routine-only 目标解锁适用成就，普通日程与 occurrence 不重复计数。
4. 有完成标准的 Milestone 获得证据后生成建议；Agent 可解释，只有用户确认完成。
5. 用户驳回后冷却；新证据变更指纹后重评；重复运行不重复提醒。
6. read batch 一项失败时部分降级，依赖该项的 draft_write 不执行，其他只读结果保留。
7. 旧 browser-local draft 与旧 AgentRun 在新版本中可读、可操作、无崩溃。

## 4. 发布/回滚矩阵

| 能力 | 发布方式 | 回滚方式 | 数据处理 |
|---|---|---|---|
| Goal summary UI | feature flag | 退化到本地真实投入聚合并隐藏 action hint；不恢复任务百分比 | 不删除新 summary 数据 |
| Achievement | dry-run → backfill → UI flag | 关闭 evaluator/UI | 保留审计记录 |
| Milestone suggestion | generator/UI 独立 flag | 关闭生成与入口 | 保留 suggestion 决策记录 |
| Intent router | shadow → 小流量 → 默认 | 回到 rule router | 保留 trace |
| Context/tool parallel | 独立 flags | 恢复串行 | 无业务数据回滚 |
| DRAFT migration | 事务 + 校验 + 观察 | 事务回滚/备份/反向 enum 迁移 | 不手工删除业务行 |

## 5. 最终交付物

- 两个子任务的 PRD、研究、设计、实施计划与 Trellis 上下文清单。
- 数据迁移基线/校验/恢复证据。
- Agent capability matrix、versioned eval dataset、baseline/candidate 报告。
- UX 验收截图与无障碍检查。
- 端到端测试与发布门禁报告。
- 版本风险、feature flag 和回滚记录。

## 6. 开工状态

2026-07-20 用户确认采用全部推荐值并开始实施；若真实代码或测试暴露设计问题，先回到对应 PRD/design 修订，再继续执行。
