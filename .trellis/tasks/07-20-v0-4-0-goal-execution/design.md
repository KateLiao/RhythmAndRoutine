# V0.4.0 目标执行系统技术与 UX 设计

## 1. 设计原则

1. 时间表达投入，不表达完成度。
2. Milestone/Outcome 表达成果，并始终由用户确认。
3. 成就表达值得记住的历史事件，不成为新的总进度算法。
4. 规则必须确定性、可审计、可回溯、可复用。
5. 目标页的首要任务仍是“知道下一步做什么”；成就负责激励和回看，不能抢走主操作。

## 2. 目标列表

移除 `tasksDone / tasksTotal` 百分比和进度条，目标行右侧改为两层事实：

```text
┌ 目标图标 ─ 目标标题 [推进中/已暂停/已完成] ───────────────────┐
│            目标说明                                               │
│            本周真实投入 2h 35m · 3 个有效执行日                    │
│            需要调整：本周计划已过期        最近成就 [七日手感] ›   │
└───────────────────────────────────────────────────────────────────┘
```

- 主数值：本周真实投入；无数据时显示“本周还没有真实投入”。
- 主状态：只显示 active / paused / completed / archived 对应的生命周期文案。
- 行动提示：作为独立的、可选的第二行提示，由确定性事实派生，例如“有里程碑待确认”“本周计划已过期”“可以安排下一次行动”；不能覆盖生命周期状态，也不能由 AI 黑盒分数决定。
- 最近成就：只在已解锁时展示一枚小型徽章；无成就时不占位。

行动提示优先级固定为：`待确认里程碑 > 明确阻塞/过期 > 本周无安排 > 正常推进`。同一卡片最多展示一条，点击后必须进入可处理对象；没有可靠证据时不展示“需调整”。

### 2.1 Goal 状态建议

- 删除“待澄清/已确认”作为持久化维度，不新增 confirmed 字段。
- `Goal.status` 仅保留 active / paused / completed / archived 生命周期。
- 新建 Goal 默认 active；旧 draft 数据迁移为 active。
- 结构缺口通过动态 `planningHints` 在详情页非阻塞展示，不占据列表主状态位置。
- 该方案已确认；完整证据与零损失迁移流程见 `research/goal-status-decision.md`。

### 2.2 Milestone 检查建议

Milestone 的定义与完成状态继续由用户控制；Agent 只生成独立建议记录：

```text
MilestoneReviewSuggestion
- id
- milestoneId
- evidenceFingerprint
- evidence Json
- reason
- status: pending | snoozed | dismissed | accepted | superseded
- suggestedAt
- snoozedUntil (nullable)
- decisionReason (nullable)
- decidedAt (nullable)
UNIQUE(milestoneId, evidenceFingerprint)
```

- 生成建议不需要 ChangeSet，因为它不修改正式目标结构，也不代表完成。
- 用户“确认完成”才更新 Milestone.completed；“稍后”设置冷却期；“驳回”保存可选原因。
- 相同 evidenceFingerprint 永不重复提醒；有实质新证据时旧 pending 建议先 supersede，再展示新建议。
- `snoozed` 默认 7 天后重新出现；`dismissed` 默认进入 14 天冷却。冷却期内只有 evidenceFingerprint 变化才能提前重新建议。
- 建议入口位于目标详情和周回顾的待确认区域；已处理建议保留只读记录，不反复占据主操作区。
- Agent 不能通过该记录修改标题、说明、目标日期或完成标准；此类变更仍走 ChangeSet。
- 现有 `READY_FOR_REVIEW` 不再作为 Agent 写入的 Milestone 状态。兼容期将其读取为 pending + legacy suggestion；若其他环境存在该状态，迁移时先生成可审计 suggestion 再归一化为 pending，稳定后才考虑从 enum 移除。

### 2.3 里程碑的第一性原理模型

里程碑只回答一个问题：**“什么可验证事实，足以证明目标跨过了一个阶段？”** 它不等于任务分组、日期提醒或投入时长阈值。

建议扩展现有 Milestone：

```text
Milestone
- title / description
- completionCriteria Json (nullable for legacy/manual quick capture)
- targetDate (nullable)
- status
- completedAt / completedByUserId (nullable)
```

`completionCriteria` 采用版本化结构，而不是让模型自由解释一段文本：

```ts
type MilestoneCriteria = {
  version: 1;
  mode: "all" | "any";
  items: Array<{
    id: string;
    label: string; // 向用户公开的完成标准
    evaluator: "linked_task_completed" | "routine_completed_count" |
      "invested_minutes" | "active_days" | "manual_only";
    sourceIds?: string[];
    threshold?: number;
  }>;
};
```

Evaluator 只读取可归属当前 Goal 的事实。V0.4.0 只有所有必需条目都可机器判定且满足时，才自动生成“建议检查”；包含 `manual_only` 的 Milestone 继续由用户手动判断。后续新增 evaluator 必须版本化并补回溯测试，不能改变旧版本规则含义。

V0.4.0 采用兼容规则：

- 人工快速记录可暂时没有 `completionCriteria`，既有 21 个里程碑不被强制补写。
- 只有具备明确且可机器判定完成标准的里程碑参与自动“建议检查”。没有标准或含 `manual_only` 时，详情页给出非阻塞说明与“补充/调整完成标准”入口。
- Agent 可通过 ChangeSet 建议补充或改写标准；不能静默写入。
- 时间投入、任务完成和日程执行只能作为证据，不能单独替用户宣布阶段达成。

### 2.4 建议评估与证据指纹

评估器在以下事件后异步运行：Execution/Routine execution 写入、Task 用户确认完成、Milestone 关联证据变更。首次发布也可按目标回溯。Review 在建立可验证的 Goal 关联前不作为直接触发证据。

流程固定为：

1. 读取 Milestone 的完成标准、目标时间窗及目标事实投影。
2. 若标准缺失、里程碑非 pending、证据不足或仍在冷却期，则不产生建议。
3. 生成结构化证据摘要，按排序后的来源类型、来源 ID、事实版本和标准版本计算指纹。
4. 通过唯一键去重后写入 suggestion；不修改 Milestone。
5. 用户确认时在同一事务中完成 Milestone、记录确认人/时间，并把 suggestion 标为 accepted。

偏离提醒与完成建议分开：偏离是动态行动提示，不改变 Milestone status；完成建议只在证据足以匹配公开标准时出现。模型可以生成解释文本，但是否允许创建建议由确定性守卫决定。

## 3. 成就规则架构

### 3.1 定义与选择

V0.4.0 使用代码内版本化 `AchievementDefinition` 注册表，不建设运营后台：

```ts
type AchievementDefinition = {
  id: string;
  version: number;
  title: string;
  description: string;
  applicableModules: Array<"core" | "project" | "skill" | "routine">;
  evaluator: string;
  threshold?: number;
  tier: "basic" | "advanced" | "rare";
  icon: string;
};
```

模块选择：

- 所有目标加载 `core`。
- category=project 或 project 非空加载 `project`。
- category=skill 或 skill 非空加载 `skill`。
- category=routine 或存在未归档 Routine 加载 `routine`。
- mixed 组合满足条件的模块，不维护独立 mixed 分支。

### 3.2 事实投影

统一 `GoalExecutionFacts`：

```ts
type GoalExecutionFacts = {
  goalStatus: string;
  investedMinutes: number;
  activeDateKeys: string[];
  completedSessions: number;
  longestSessionMinutes: number;
  confirmedTaskCount: number;
  confirmedMilestoneCount: number;
  confirmedOutcomeCount: number;
  routineCompletedCount: number;
  routineActiveWeekKeys: string[];
  evidenceRefs: Array<{ type: string; id: string; occurredAt: string }>;
};
```

- 复用 `docs/development-spec.md` 的真实投入口径。
- ScheduleBlock 和 Routine occurrence 统一投影，按稳定来源 ID 去重。
- 改期链使用最终有效日程事实，不能把前驱与后继重复计入。
- `actualMinutes` 缺失回退计划时长时，证据标记 `estimated=true`。
- Review 当前没有 Goal 外键，因此 V0.4.0 不把 Review.confirmed 直接计入单目标成就或里程碑证据；只有能经关联实体确定归属的事实可使用。

### 3.3 解锁持久化（推荐混合模型）

- 进展值由当前事实动态计算，避免频繁写入 `3/7` 之类中间状态。
- 达到条件后写入 `GoalAchievement`，保存解锁时间、定义版本和证据快照，保证收藏记录稳定且可审计。
- 唯一键 `(goalId, achievementId)` 保证重试和历史回溯不会重复解锁。
- 首次上线运行一次历史回溯；以后在相关写入成功后调用评估服务，并保留按目标懒校验兜底。

建议模型：

```text
GoalAchievement
- id
- goalId
- achievementId
- definitionVersion
- unlockedAt
- evidence Json
- revokedAt (nullable)
- revokeReason (nullable)
- createdAt
UNIQUE(goalId, achievementId)
```

另设 append-only `GoalAchievementEvent` 审计流，记录 `unlocked / revoked / restored`、发生时间、证据快照和原因。`GoalAchievement` 表示当前收藏状态，事件流保留每次错误更正与再次满足条件的完整历史。

相关触发点：ExecutionRecord 写入、RoutineExecutionRecord 写入、Task 完成确认、Milestone 确认、Outcome 确认。

解锁生命周期：

- 达成有效事实后写入一次，普通暂停、改期、阈值回落或状态变化不删除、不降级。
- 源记录被明确修正为错误时，评估服务可填写 `revokedAt/revokeReason`；原 `unlockedAt/evidence` 保留用于审计。
- 被撤销成就在普通收藏视图不计入已解锁数；证据抽屉可用“已因数据更正撤销”的只读终态解释。
- 同一成就未来重新满足条件时，复原唯一状态记录并追加 `restored` 事件；新证据成为当前快照，原始解锁、撤销原因和历史证据继续保存在事件流中。

## 4. Steam 风格 UX 方向

### 4.1 主题与页面任务

- 主题：个人成长过程中的“陈列柜”，不是游戏商店。
- 受众：希望从长期目标中看见真实积累的单用户。
- 单一任务：快速看见最近值得记住的推进，并能查看全部成就及证据。

### 4.2 视觉计划

沿用现有品牌而不复制 Steam：

| Token | 颜色 | 用途 |
|---|---|---|
| Rhythm Canvas | `#F4F1F7` | 页面背景 |
| Porcelain | `#FFFDFB` | 卡片表面 |
| Night Ink | `#292533` | 主文字 |
| Quiet Violet | `#705A9F` | 技能/进行中/交互 |
| Living Sage | `#688A76` | 已解锁与真实发生 |
| Aged Brass | `#A8874F` | 稀有成就、解锁时间和边缘高光 |

字体继续使用现有体系：Georgia / Songti SC 用于成就标题的收藏感，Avenir Next / PingFang SC 用于正文，SFMono 用于日期、阈值和证据数据。

### 4.3 签名元素：Achievement Shelf

页面右侧“本周摘要”下方加入一个安静的最近成就陈列位；完整集合放在主栏“时间投入与日程”之后。唯一明显的视觉风险是：已解锁卡片采用带细微黄铜边缘的圆形压印章，而非现有通用线性图标，让它看起来像真正获得的纪念物。

```text
右侧最近解锁                    主栏完整收藏
┌ 最近解锁 ─────────┐          ┌ 成就收藏  5 / 13 ───────────────┐
│  ◉ 七日手感       │          │ [全部] [基础] [项目] [技能] [Routine]│
│  7 个有效练习日   │          │                                  │
│  7 月 16 日       │          │ ◉ 第一次发生   ◌ 五小时练习场      │
│  查看全部 →       │          │   已解锁          235 / 300m       │
└───────────────────┘          │                                  │
                               │ ◌ 阶段抵达     ◉ 七日手感          │
                               │   确认首个里程碑   已解锁 7/16      │
                               └──────────────────────────────────┘
```

### 4.4 卡片状态

- **已解锁**：Sage/Brass 压印章、标题、解锁日期、1 行证据；卡片可打开证据抽屉。
- **进行中**：Violet 轮廓、明确阈值（如 `235 / 300 分钟`）；进度条只属于该成就，不代表目标总进度。
- **未解锁**：低对比度，但条件可读，告诉用户什么行为值得尝试。

所有成就条件公开。V0.4.0 不展示问号卡、秘密条件或隐藏成就。

卡片点击打开轻量抽屉：触发条件、解锁时间、证据摘要、关联日程/里程碑，不展示原始 JSON。

### 4.5 动效与无障碍

- 新解锁只执行一次 500–700ms 的“压印显影”：边缘亮起 → 图标落位 → 文案出现；不撒彩纸、不循环发光。
- `prefers-reduced-motion` 下直接切换终态并由 aria-live 播报。
- 不只用颜色区分状态；同时使用图标、文字和边框。
- 卡片是 button 或 link，命中区至少 44px；键盘可打开证据抽屉。
- 移动端改为单列/横向最近成就，不产生页面横向滚动。

## 5. 自我评审

- 没有把 Steam 的深蓝商店皮肤搬进现有暖色产品；参考的是收藏卡片信息层级、解锁时间和证据感。
- “压印章”是唯一大胆元素，其余仍使用现有卡片、圆角与排版体系，避免成就区像嵌入的另一款产品。
- 完整成就集合放在下一步任务和时间事实之后；右侧只展示最近一枚，避免奖励系统压过实际行动。
- 不显示伪造的全局稀有百分比，因为当前是单用户系统；使用规则难度层级而非虚假社区统计。

## 6. 兼容与迁移

- Goal readiness 使用扩展/收缩迁移：先部署不再写 DRAFT 的兼容代码，再备份、归一化现有数据并核对基线，最后删除 enum/API/类型中的 DRAFT。
- 迁移基线必须以执行前生成的完整 JSON 快照为准，不能把规划期计数写死为守卫。2026-07-20 实施前快照为 7 Goal、13 Outcome、21 Milestone、51 Task、7 Routine、18 RoutineExecutionRecord、100 ScheduleBlock、54 ScheduleBlockTask、57 ExecutionRecord；迁移只允许其中 4 个 Goal 的 status 从 DRAFT 变为 ACTIVE。
- 迁移前后必须核对实体数量、主键集合、外键关系和 Goal 非 status 字段摘要；任何不一致都阻断发布并恢复备份。
- 首次部署对 7 个现有目标进行历史回溯，并产生幂等解锁记录。
- 缺少 Outcome/Milestone 的旧目标仍能获得投入型成就；结构缺口仅以非阻塞 planning hint 呈现。
- browser-local fallback 使用版本化本地 `goalAchievements / achievementEvents / milestoneSuggestions` 适配结构；首次读取从本地事实幂等回溯，之后遵守与服务端相同的永久解锁、审计撤销和建议冷却语义。不能用“每次刷新重新算当前状态”替代收藏历史。
- 服务端 summary API 应一次返回列表所需的本周投入、行动状态、最近成就，避免客户端再次扫描一年日程。

### 6.2 执行反馈 V2 契约

第一性原理：执行反馈应提供“未来能改变排程/任务粒度的最小事实”，不能把计划动作、主观体验和诊断问题混成一个完成状态。

```ts
type ExecutionOutcome = "achieved" | "progressed" | "no_progress";
type ExecutionFocusState =
  | "deep_focus"
  | "steady_focus"
  | "under_challenged"
  | "overloaded"
  | "fragmented";
type ExecutionQuality = "satisfying" | "expected" | "needs_rework";
```

- `outcome` 表达结果；`focusState` 表达专注和挑战—能力匹配；`quality` 表达产出是否需要返工；`note` 保存用户自己的解释。
- `rescheduled` 保留在 API 兼容结果中，但 UX 作为独立计划动作。
- `progressed` 将 ScheduleBlock 标记为已发生并计入真实投入，但必须带 `actualMinutes > 0`；`no_progress` 标记 missed 且投入为 0。
- V2 记录写 `feedbackVersion=2`。ExecutionRecord 复用 String `result/quality`，RhythmFeedback 增加 nullable `focusState`；RoutineExecutionRecord 增加 nullable `result/quality/focusState`。既有列不删除、不清空。
- 历史 `completed/not_completed/rescheduled`、旧 quality 和旧 tags 通过共享 normalizer 投影到新 UI/分析语义，但数据库原值保持不变。只有用户主动保存修正时才写 V2。
- V2 消费者忽略同一行中仅为兼容保存的 obstacle/nextAction/comfortable/timeFit；历史 V1 消费者继续使用它们。
- 更新请求中省略旧字段表示保留当前值；显式传 `focusState/quality/note: null` 表示用户主动清除。禁止用 schema 默认空数组把省略的旧 tags 变成覆盖写入。
- V1 可从可靠旧 tags 投影专注体验；V2 只读取显式 `focusState`，即使同一记录保留旧 tags，也不能在用户清除专注体验后重新推断。

视觉采用“安静的复盘刻度”：结果是三张横向短卡；专注体验是带一句诊断含义的单选条；质量与感受保持普通表单。唯一强调元素是专注体验被选择时出现一条对应的节奏提示，不增加动画或游戏化奖励。

### 6.1 API 契约建议

- Goal list summary：`lifecycleStatus`, `weekInvestedMinutes`, `activeDays`, `actionHint`, `recentAchievement`。
- Goal detail achievements：适用定义、动态进展、有效解锁记录与证据摘要；不把原始 JSON 直接发给 UI。
- Milestone suggestions：查询 pending/snoozed、确认完成、稍后、驳回。确认接口要求 suggestion 与 milestone 当前版本一致，避免旧建议误完成已编辑里程碑。
- 所有回溯/评估接口必须幂等；批量回溯只允许内部管理路径调用并记录审计摘要。

## 7. 验收场景

1. **新目标**：只填写标题即可保存为 active；详情提示可补 Outcome/Milestone，但不显示“待澄清”，也不阻塞手动安排任务。
2. **正在推进的旧 draft**：迁移后投入、任务、Routine、日程和执行记录不变，列表展示本周投入并进入 active 洞察。
3. **阶段证据达成**：有公开完成标准的 Milestone 获得新证据后生成一条待确认建议；刷新或重跑不重复创建。
4. **偏离与冷却**：用户驳回建议后，同一证据 14 天内不再提醒；出现新证据可产生新指纹并提前重评。
5. **用户确认边界**：Agent 建议不会完成 Milestone；只有用户确认接口能写 completed 状态。
6. **成就回溯**：现有目标按两类执行源去重解锁符合事实的成就；任务数量不会贡献目标进度或成就。
7. **错误数据更正**：删除/纠正错误来源后可审计撤销相关成就，普通改期、暂停和阈值回落不撤销。
8. **本地模式**：旧 browser-local draft 读取时归一化为 active；本地成就和建议通过版本化持久结构升级，刷新后不会丢失收藏、审计与冷却状态。

## 8. 已确认决策

- 2026-07-20：成就解锁后永久保留；普通状态变化不撤销；仅源数据错误更正允许审计撤销。
- 2026-07-20：不设计隐藏成就；所有条件与阈值公开。
- 2026-07-20：删除 Goal readiness，不新增 confirmed 字段；最终硬删除 DRAFT；迁移除 4 个旧 DRAFT→ACTIVE 外不得改变当前数据。
- 2026-07-20：Agent 可自动生成独立 Milestone 检查建议，无需 ChangeSet；只有用户确认能完成 Milestone，定义变更仍走 ChangeSet。
- 2026-07-20：人工快速记录的完成标准可选；只有公开且可机器判定的标准进入自动建议评估。
- 2026-07-21：V2 只保留结果、可选专注体验、可选质量和可选感受；实际时间折叠；旧低频字段只读兼容；改期与执行结果分离。
