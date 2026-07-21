# 成就系统真实数据样本（2026-07-20）

> 来源：只读查询当前本机 PostgreSQL。以下只保留产品设计所需的聚合事实，不记录实体 ID。

## 1. 当前目标样本

| 目标 | category | Goal 状态 | Outcome / Milestone | 执行样本 | 主要实践模式 |
|---|---|---|---|---|---|
| 完成 Rhythm & Routine MVP | mixed | active | 4 / 6，均未确认 | 9 次、580 分钟、6 天；2 个 Task 已确认完成 | 项目交付 + 技能成长 |
| 提升英语水平至更自然流畅 | skill | active | 4 / 4，均未确认 | 5 次、122 分钟、5 天；1 个暂停 Routine | 技能练习 + Routine |
| 锻炼身体直到体脂降到 19% | mixed | draft | 2 / 5，均未确认 | 日程 3 次、210 分钟；Routine 有完成/跳过/改期 | 结果型目标 + Routine |
| 充分阅读并培养表达分享能力 | mixed | draft | 0 / 0 | 8 次、455 分钟、6 天；18 个任务 | 探索/产出混合 |
| 构建健康、强韧的精神状态 | skill | draft | 0 / 3 | 无目标日程；Routine 完成 8 次、跳过 2 次 | Routine 养成 |
| 吉他弹唱能力 | skill | draft | 0 / 0 | 7 次、235 分钟、7 天 | 技能练习 + 作品任务 |
| 入门全栈 AI Agent 开发 | mixed | active | 3 / 3，均未确认 | 17 次、1334 分钟、7 天，多次 90–150 分钟专注块 | 项目实践 + 技能成长 |

当前还有 2 份已确认周回顾、4 份已确认日回顾，但 `Review` 没有 Goal 外键，因此不能在 V0.4.0 中直接把“确认回顾”归因到某个目标成就。

## 2. 数据对成就设计的约束

### 2.1 `category` 不是足够细的行为类型

- 数据中只有 `skill` 和 `mixed`，没有当前 `project` 或 `routine` 样本。
- `mixed` 同时覆盖产品研发、健身、阅读表达和全栈学习，行为模式差异很大。
- 推荐用“显式 category + 实际组成字段”选择成就模块：
  - `project` 非空或 category=project → 项目交付模块；
  - `skill` 非空或 category=skill → 技能练习模块；
  - 存在 Routine 或 category=routine → Routine 模块；
  - mixed → 组合满足的模块，而不是独立硬编码 mixed 成就表。

### 2.2 Goal 状态与执行事实目前不一致

- 4 个 draft 目标中，3 个已有真实投入；最高已有 8 次 / 455 分钟。
- 因此行为成就只能依赖执行事实，不能依赖 draft/active 这类历史创建路径。
- V0.4.0 将删除 readiness 语义并把旧 draft 安全归一化为 active；成就不能承担生命周期状态或规划完整度提示的职责。

### 2.3 执行事实有两条来源

- 一次性/目标日程：`ScheduleBlock + ExecutionRecord`。
- Routine：`RoutineExecutionRecord`，可能没有对应 ScheduleBlock；精神状态目标就是这种样本。
- 成就评估服务必须投影两类执行事实，并避免同一 Routine 发生实例被双重计数。

### 2.4 当前没有已确认 Milestone / Outcome 样本

- 所有 Outcome 均未确认；所有 Milestone 均为 PENDING。
- “阶段确认”“结果兑现”应作为未解锁成就呈现，以验证未来激励价值。
- V0.4.0 不能用任务完成数替代它们，否则重新引入任务拆分套利。

### 2.5 历史数据足以回溯多种成就

现有数据可确定性回溯：首次投入、累计投入、有效执行日、长专注块、Task 用户确认、Routine 完成次数。Milestone/Outcome 成就会保持待解锁。

## 3. 首批成就集合

### 3.1 公共基础成就（所有目标）

| ID | 名称 | 触发事实 | 展示层级 |
|---|---|---|---|
| `core.first_investment` | 第一次让它发生 | 第一次有效执行记录 | 基础 |
| `core.active_days_3` | 三次回到这里 | 3 个不同日期有有效执行 | 基础 |
| `core.invested_300` | 五小时的形状 | 累计真实投入达到 300 分钟 | 进阶 |
| `core.first_milestone` | 阶段抵达 | 用户确认第一个 Milestone | 进阶 |
| `core.first_outcome` | 结果兑现 | 用户确认第一个 Outcome | 稀有 |
| `core.return_after_gap` | 重新接上节奏 | 间隔至少 14 天后再次有效执行 | 进阶/温和鼓励 |

`return_after_gap` 奖励回来，不惩罚断档；本版本不设计 streak 断裂惩罚。

所有成就条件公开，V0.4.0 不设计隐藏成就。

### 3.2 项目交付模块

| ID | 名称 | 触发事实 |
|---|---|---|
| `project.first_delivery` | 第一块交付 | 第一个由用户确认完成且有 completionRecord 的 Task |
| `project.deep_work_90` | 深入问题腹地 | 单次真实投入达到 90 分钟 |
| `project.invested_600` | 做出十小时 | 项目模块累计真实投入达到 600 分钟 |

### 3.3 技能练习模块

| ID | 名称 | 触发事实 |
|---|---|---|
| `skill.practice_days_7` | 七日手感 | 7 个不同日期有技能目标有效执行，不要求连续 |
| `skill.invested_300` | 五小时练习场 | 技能模块累计真实投入达到 300 分钟 |
| `skill.focus_session_45` | 一次完整练习 | 单次真实投入达到 45 分钟 |

### 3.4 Routine 模块

| ID | 名称 | 触发事实 |
|---|---|---|
| `routine.first_occurrence` | 第一次自然发生 | 第一个完成的 Routine occurrence |
| `routine.completed_3` | 节奏开始成形 | 累计完成 3 次 occurrence |
| `routine.active_weeks_2` | 两周都有回应 | 两个不同自然周均至少完成一次 occurrence |
| `routine.completed_10` | 十次之后 | 累计完成 10 次 occurrence |

跳过与改期不扣分；它们可以作为节奏洞察证据，但不触发惩罚性成就。

## 4. 当前样本对规则的验证

- Rhythm & Routine：应回溯解锁首次投入、三天、五小时、第一块交付、90 分钟专注；Milestone/Outcome 保持未解锁。
- 英语：应解锁首次投入、三天、45 分钟练习尚未达到；Routine 数据需要做双来源去重。
- 健身：行为成就可按历史事实回溯解锁；迁移后作为 active 生命周期目标展示，不再出现“仍待确认”的冲突表达。
- 精神状态：必须能仅凭 RoutineExecutionRecord 解锁第一次、3 次和两周成就。
- 吉他：应解锁 7 个练习日，但不能因为创建 4 个歌曲任务获得任何成就。
- 全栈 Agent：应解锁首次投入、三天、五小时、90 分钟专注、十小时项目实践；仍不宣称 Milestone 达成。

## 5. 不采用的规则

- 创建 N 个任务、完成任务比例达到 X%。
- 连续打卡中断后降级或扣分。
- Agent 主观判断“表现优秀”。
- 仅根据 Goal.status 推定已投入。
- 仅根据 Review.confirmed 归因某个目标（当前无关联关系）。

## 6. 实施前基线刷新

规划后的正常使用新增了任务与 Routine，因此迁移守卫不再依赖本文件早期聚合的固定计数。2026-07-20 实施前只读快照记录为：7 Goal、13 Outcome、21 Milestone、51 Task、7 Routine、18 RoutineExecutionRecord、100 ScheduleBlock、54 ScheduleBlockTask、57 ExecutionRecord；Goal 状态仍为 3 ACTIVE / 4 DRAFT。

成就回溯的最终期望以实现后的 dry-run 报告和逐条证据为准，本文件第 4 节保留为规则设计样本，不作为删除新增业务数据的依据。
