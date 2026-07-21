# V0.4.0 目标执行系统实施计划

> 当前仅为开发顺序与验证计划。未获得实现批准前，不执行 schema 迁移、不改产品代码、不回填数据库。

## 1. 实施原则

- 先建立兼容读写，再迁移数据，最后收缩旧契约；任何阶段都可停止而不丢数据。
- 目标状态、行动提示、里程碑建议和成就是四个独立概念，不互相冒充。
- 先实现确定性事实投影和审计模型，再接 UI 与 Agent 文案。
- 每阶段具备单独测试、数据核对与回滚点，不将数据库迁移和大面积 UI 切换绑在一次发布中。

## 2. Phase A：冻结契约与基线

### 工作

1. 为目标列表 summary、`GoalExecutionFacts`、AchievementDefinition、MilestoneReviewSuggestion 定义服务端类型和 API 响应契约。
2. 运行迁移基线脚本，以执行时快照记录所有相关表的数量、主键、关系和字段摘要；2026-07-20 首次实施快照为 7 Goal、13 Outcome、21 Milestone、51 Task、7 Routine、18 RoutineExecutionRecord、100 ScheduleBlock、54 ScheduleBlockTask、57 ExecutionRecord。
3. 生成迁移前可恢复备份，并提供只读校验脚本：row count、主键集合、外键关系、Goal 非 status 字段 digest。
4. 将 achievement 规则表固定为版本化代码注册表，规则 ID 发布后不可复用为其他含义。

### 验证

- 基线脚本连续运行两次结果一致。
- 规则注册表无重复 ID，所有规则具备公开条件、适用模块和确定性 evaluator。
- Review 无 Goal 关联的事实不会进入单目标判定。

### 回滚点

只增加类型、测试和只读脚本，不触碰业务数据。

## 3. Phase B：停止产生 DRAFT，保留兼容读取

### 工作

1. `prisma/schema.prisma` 暂时保留 DRAFT enum，但把 Goal 默认值改为 ACTIVE。
2. 统一手动创建、ChangeSet、Agent planning 和 browser-local 创建为 active。
3. 兼容读取旧 draft：服务端/API/本地适配层临时归一化为 active；客户端 Goal union 覆盖 active/paused/completed/archived。
4. 移除 Agent planning 的“激活目标”副作用；修正首页洞察和周轨道，不再因历史 draft 遗漏真实投入。

### 重点文件

- `prisma/schema.prisma`
- `src/server/services/goals.ts`
- `src/server/services/change-sets.ts`
- `src/agent/tool-registry.ts`
- `src/lib/demo-data.ts`
- `src/lib/client-api.ts`
- `src/server/services/home-insights-facts.ts`
- `src/lib/home-insights/compute-weekly.ts`

### 验证

- 手动、Agent、ChangeSet、本地四种新建路径都得到 active。
- 读取旧 draft 时 UI 不显示“待澄清”，已有日程与执行仍可访问。
- active/paused/completed/archived 生命周期切换测试通过。

### 回滚点

数据库 enum 仍含 DRAFT；旧版本仍可读取。若兼容测试失败，不进入数据迁移。

## 4. Phase C：事实投影、列表摘要与行动提示

### 工作

1. 抽取统一 `GoalExecutionFacts`，复用真实投入统计口径，覆盖普通日程与 Routine execution，按稳定来源 ID 去重。
2. 新增目标列表 summary 聚合：本周投入、有效执行日、生命周期状态、确定性 actionHint、最近成就。
3. actionHint 只使用可解释事实与固定优先级；每条提示带目标页面深链和证据来源。
4. 移除目标卡片的 `tasksDone / tasksTotal` 百分比和进度条；保持旧字段短期兼容但不再展示，随后清理。

### 验证

- 普通日程、Routine-only、改期链、actualMinutes 缺失和跨周边界均有单元测试。
- 相同 Routine occurrence 不会被两条来源重复计算。
- 无投入显示诚实空状态；目标列表不再出现任何目标完成百分比。
- summary 查询无 N+1，窄屏与桌面布局可用。

### 回滚点

旧详情数据接口仍可用；summary 异常时可退化为既有本地真实投入聚合并隐藏 action hint，不得恢复任务百分比或“待澄清”语义。

## 5. Phase D：成就定义、持久化与历史回溯

### 工作

1. 新增 `GoalAchievement` 当前状态表与 append-only `GoalAchievementEvent` 审计流，并配置唯一键和索引。
2. 实现模块选择器、事实 evaluator、动态进展和幂等 unlock/revoke 服务。
3. 在执行写入与用户确认型事件完成后触发评估；失败不回滚原业务写入，记录可重试任务。
4. 对现有 7 个目标执行 dry-run，输出“将解锁”摘要；人工/自动核对后才执行正式回溯。
5. 接入最近成就、完整收藏、证据抽屉和一次性解锁动效。
6. 为 browser-local 增加同版本状态/事件适配与升级函数，避免刷新后丢失收藏和撤销历史。

### 验证

- 每条规则至少有未达到、刚好达到、超过阈值、重复运行、错误数据更正五类测试。
- 同一 `(goalId, achievementId)` 并发评估只产生一条有效状态；unlock/revoke/restore 事件各自幂等且历史不被覆盖。
- 暂停、改期、阈值回落不撤销；只有显式数据更正路径能填写 revoke 审计。
- 当前真实样本的 dry-run 结果与 `research/achievement-data-snapshot.md` 一致。
- 键盘、读屏、reduced motion、窄屏验收通过。

### 回滚点

新表为旁路能力；关闭 feature flag 后不影响目标、日程和执行。回滚不得删除已产生的审计记录。

## 6. Phase E：智能里程碑建议

### 工作

1. 为 Milestone 增加 nullable `completionCriteria` 和版本信息；不要求旧数据立即补齐。
2. 新增 `MilestoneReviewSuggestion`、证据指纹、唯一键、状态、冷却与决策审计；停止新写 `READY_FOR_REVIEW`。
3. 实现确定性守卫和异步 evaluator；模型仅生成可读解释，不能绕过标准/证据守卫。
4. 新增目标详情与周回顾的待确认入口；实现确认完成、稍后 7 天、驳回 14 天和 supersede。
5. 编辑 Milestone 后使旧建议过期；确认接口校验 milestone version，防止陈旧建议误完成。
6. 对其他环境可能存在的 `READY_FOR_REVIEW` 执行兼容迁移：先创建 legacy suggestion，再归一化为 pending；不得直接丢失原状态含义。
7. browser-local suggestion 复用同一状态机、指纹和冷却规则，不能退化成刷新即重复提醒。

### 验证

- 新目标、执行中偏离、阶段证据达成三个端到端场景通过。
- 相同指纹重跑不重复提醒；新事实改变指纹；冷却规则准确。
- 无 criteria 的旧里程碑仍可手动管理，但不会收到完成建议。
- Agent 无法通过任何工具直接完成或改写 Milestone；用户确认是唯一 completed 入口。

### 回滚点

建议表与 nullable 字段均为扩展性变更；关闭生成器和 UI 即可停用，不改变 Milestone 原状态。

## 7. Phase F：DRAFT 数据迁移与契约收缩

### 工作

1. 在兼容版本稳定后重新生成备份与迁移基线。
2. 事务内把所有 DRAFT 更新为 ACTIVE，并把默认值确认为 ACTIVE。
3. 逐项核对数量、ID、关联和非 status digest；只允许当前基线中的 4 个 Goal 发生 DRAFT→ACTIVE。
4. 观察一个发布窗口后，用 enum 替换迁移删除 PostgreSQL DRAFT；清理 API、客户端和 browser-local 的临时兼容分支。

### 验证

- 迁移前后实体数量、主键集合、关联、历史记录和 Goal 非 status 字段完全一致。
- 原 draft 目标的投入、成就回溯、任务、Routine、日程和执行均可见。
- 数据库、生成类型、API、UI、测试夹具中无 DRAFT/待澄清残留。

### 回滚点

- 归一化事务校验失败：立即回滚事务。
- 收缩前故障：备份恢复并继续运行兼容代码。
- enum 已收缩后的回退必须使用显式反向迁移恢复 enum，不允许手工修改生产数据。

## 8. 发布门禁

- 数据：零损失迁移校验全部通过，备份恢复演练成功。
- 正确性：投入去重、成就幂等、建议去重/冷却、用户确认边界测试通过。
- UX：目标列表无百分比/待澄清；详情页优先下一步与时间，成就收藏为次级区。
- 性能：目标列表 summary 单次聚合，无按目标逐个查询；历史回溯不阻塞在线请求。
- 兼容：server、browser-local、demo/fallback 三种数据模式都有回归场景。
- 可观测：回溯数量、解锁/撤销、建议生成/接受/驳回、迁移摘要均可审计。

## 8.1 轻量执行反馈 V2 增量实施

1. 建立共享 outcome/focus/quality 定义与 V1 normalizer，先补纯函数兼容测试。
2. 只新增 `feedbackVersion` 与 nullable V2 字段；迁移前后核对 ExecutionRecord、RhythmFeedback、RoutineExecutionRecord 的数量、ID 与全部旧字段摘要。
3. API 同时接受旧 payload 与 V2 payload；ScheduleBlock 的 `achieved/progressed` 均表示该时段真实发生，`no_progress` 不得计入计划时长。
4. 重构反馈弹窗；主路径仅显示结果、专注体验、质量、感受，有效推进才要求真实分钟。旧字段进入历史详情且保存 V2 时不清空。
5. Routine occurrence 写入同样的 result/focus/quality/note，不能只保存一个旧标签。
6. 日/周回顾、任务完成摘要、首页事实和 Agent 执行历史读取 V2 字段；V1 继续用 normalizer。
7. 运行兼容单测、全量测试、类型、Lint、Prisma、生产构建和桌面/窄屏视觉检查。

### 实施结果（2026-07-21）

- 新增共享 V2 outcome/focus/quality 契约、版本感知投影，以及省略保留/显式 null 清除语义。
- 普通 ScheduleBlock、Routine occurrence、个人日程快速完成统一写入 V2；已完成记录均可进入修正路径。
- 回顾、任务完成摘要、节奏信号与 Agent 执行历史改用版本感知投影；V2 不再消费旧低频字段或遗留 tags。
- 增量迁移已应用。迁移前后 59 ExecutionRecord、59 RhythmFeedback、19 RoutineExecutionRecord 的全部旧字段摘要一致；历史新列保持 V1/null 默认值。
- Lint、TypeScript、Prisma、134 项仓库测试、11 项 V2 定向测试、生产构建、桌面与 390×844 交互验收全部通过。

## 9. 实施依赖与预计切分

```text
契约与基线
  ├─ DRAFT 兼容写入 ─ 事实投影/列表 UI ─ 成就系统
  └─ Milestone criteria ─ 建议系统
                    两线验证通过 ─ DRAFT 数据迁移 ─ enum 收缩
```

推荐拆成 6 个可独立审查的变更集：兼容状态、事实摘要、成就后端、成就 UX、里程碑建议、最终迁移收缩。不要把 schema 扩展、历史回溯和 enum 删除放在同一次上线中。
