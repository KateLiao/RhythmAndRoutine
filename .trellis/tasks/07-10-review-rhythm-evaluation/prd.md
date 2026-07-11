# 回顾-记录后的节奏评估（日/周回顾）

## Goal

把「回顾」从演示壳升级为基于真实执行记录与节奏反馈的**节奏评估闭环**：用户在日/周周期结束后，能看到有证据支撑的评估正文，并据此确认目标阶段与回顾本身。

## Background

- 来源：`docs/v0.3.0 版本需求/0.3.0 版本需求清单` 第 2 项（每日回顾 / 每周回顾）
- 产品设计：`docs/Rhythm & Routine 应用设计与开发.md` §4.2.5 Review、§5.2.3 Review / Progress Evaluation Capability
- 原型：`prototype/review.html`（信息意图可参考；本任务 UI 按 D8 重做，不以原型布局为约束）
- 父任务：`07-09-v03-release`

### Confirmed facts（代码已核实）

- 后端已有 `src/server/services/reviews.ts`：手动/Cron 共用生成；AI `generateObject` + 规则降级；可提取并持久化 Rhythm Signal；支持确认状态机。
- 回顾结果 schema 仅有 `summary / findings / suggestions / source`，不足以承载 D5 增强区块。
- 回顾页 `ReviewView` 含占位 Pattern；日 Tab 指标误用本周数据；「下一步」仅打开 Agent。
- 首页洞察已消费部分节奏信号；回顾应做周期存档评估，不做「此刻建议」。
- Cron 已存在；默认日 `21:30`、周 `周日 20:30`，需改为用户时区 `23:00`。
- `aggregateTaskStatus` 任一日程块完成即标 Task 完成，与 `completeTask` / 规格冲突，是回顾噪声源（D2 前置修复）。

## Decisions

| # | 决策 | 选择 |
|---|------|------|
| D1 | MVP 边界 | 节奏评估闭环；不打通 Adjustment ChangeSet |
| D2 | Task 完成语义 | 仅用户确认；块完成 ≠ 任务完成；时长达标只建议确认 |
| D3 | 日/周角色 | 日=收工复盘；周=节奏与目标校准 |
| D4 | LLM 输入 | 日详块 + 周聚合；**用户自然语言补充感受（note 等）若存在须着重参考** |
| D5 | 输出 schema | 共用增强 schema（必有 + 可选区块） |
| D6 | 与首页分工 | 首页=当前信号/即时行动；回顾=周期评估存档 |
| D7 | 定时与展示 | 每晚/周日 23:00 生成；展示「昨日回顾」「上周回顾」直至下一份生成 |
| D8 | 回顾页 UI | **按评估正文为主重做**；保留手动重新生成；**不在回顾页再详细罗列执行明细** |
| D9 | 手动生成 | 保留，作为失败重试与补生成入口；主路径为定时 |
| D10 | 周回顾上下文压缩 | **服务端确定性压缩后再单跳 LLM**：日 findings 先验、数字规则算死、note/异常优先摘录池、实体裁剪、硬预算；禁止整周逐块原文（见 design §3.3.1） |

### D2 细则

- Schedule Block = 一次投入会话；Task = 可验收交付物，仅用户 `completeTask` 后为 `completed`。
- 聚合不得因任一/全部块完成而把 Task 标为 `completed`。
- `estimatedMinutes` 仅作进度与「建议确认」阈值。

### D3 / D6 细则

| | 日回顾 | 周回顾 | 首页 |
|--|--------|--------|------|
| 角色 | 昨日收工评估 | 上周节奏与目标校准 | 当前信号与即时行动 |
| 用户看到的 | 评估正文 + 轻量指标 + 确认操作 | 评估正文（含任务/Routine/目标检查建议）+ 确认操作 | 节奏发现 / 本周轨道 / 此刻建议 |

### D4 LLM 输入（已定稿）

**共用**：`period`、`productConstraints`、`periodMetrics`

**日回顾（生成时注入）**
- `todayBlocks[]`：每个日程的执行详情（时间、status、planned/actualMinutes、result、tags、comfortable、timeFit、quality、obstacle、deviationReason、nextAction、关联标题）
- **`note` / 用户补充感受：若有，须在 prompt 中明确要求优先参考，不得被标签统计淹没**
- `pendingFeedbackCount`
- `activeRhythmSignals[]`（≤5）

**周回顾（生成时注入）**
- `weekBlocksSummary`（含带 note 的块优先保留原文摘要）
- `taskProgress[]`（含 `readyForCompletionSuggest`）
- `routineStability[]`、`scheduleDeviation`、`goalProgressHints[]`
- `activeRhythmSignals[]`、`recentDailyReviewFindings[]`

### D5 输出 schema（已定稿）

| 字段 | 日 | 周 |
|------|----|----|
| `summary` / `findings` / `suggestions` / `source` | ✓ | ✓ |
| `sessionHighlights` | ✓ | 可空 |
| `rhythmNotes` | 轻量 | ✓ |
| `taskProgressNotes` / `routineNotes` / `goalCheckSuggestions` | 通常空 | ✓ |
| `nextCycleSuggestions` | 今晚/明天轻调 | 下周建议（非 ChangeSet） |

### D7 细则

- 默认：`dailyReviewTime=23:00`，`weeklyReviewDay=0`（周日），`weeklyReviewTime=23:00`（用户时区）。
- 日回顾周期 = 当天 00:00–24:00；次日新日回顾生成前，日 Tab 标题为「昨日回顾」。
- 周回顾周期 = `zonedPeriod(..., "weekly")`；下一周日生成前，周 Tab 标题为「上周回顾」。
- Cron 与手动共用服务，幂等键不变。

### D8 回顾页 UI（已定稿）

回顾页是**读评估、做确认**的页面，不是再看一遍日程账本。

**日 Tab（昨日回顾）**
1. 页头：标题「昨日回顾」+ 日期 + 状态
2. 轻量指标条（完成 / 未记反馈 / 投入 / 顺畅·阻力）——辅助，不占主视觉
3. **评估正文（主内容）**：summary → sessionHighlights → findings → rhythmNotes → nextCycleSuggestions
4. 操作：确认 / 重新生成 / 请小律解释  
❌ 不展示逐条执行明细列表（详情留在日历/任务侧）

**周 Tab（上周回顾）**
1. 页头：「上周回顾」+ 周区间 + 状态
2. 轻量周指标
3. **评估正文（主内容）**：按 D5 区块分段；节奏相关写入 `rhythmNotes`（可引用信号，不单独堆砌原始信号墙）
4. 「只由你确认」：Milestone / Outcome / 建议确认完成的 Task
5. 操作：确认 / 重新生成 / 请小律解释（无 ChangeSet 主按钮）  
❌ 不逐条罗列本周执行明细

## Requirements

1. 前置按 D2 修正 Task↔ScheduleBlock 完成态。
2. 按 D4/D5 分流组装 LLM 输入/输出；有用户 note 时着重参考。
3. 按 D7 默认 23:00 定时生成，并实现「昨日/上周回顾」展示语义；保留手动重生成（D9）。
4. 按 D8 重设计回顾页：以评估正文为主，不重复详细执行列表。
5. 按 D6 与首页错开；Outcome/Milestone/Task 仅用户确认；AI 失败规则降级；生成幂等。

## Acceptance Criteria

- [x] 完成一个关联日程块不会把 Task 标为 `completed`；仅用户确认完成才会；达标时可出现「建议确认」而不自动完成。（真实 API 走通并清理测试数据）
- [x] 日回顾在用户时区 23:00 可被 Cron 幂等生成；生成后至下一份日前，日 Tab 展示为「昨日回顾」。（Cron 逻辑复核 + 默认值已改 + `describeReviewPeriod` 标题逻辑验证）
- [x] 周回顾在周日 23:00 可被 Cron 幂等生成；至下一份周回顾前，周 Tab 展示为「上周回顾」。
- [x] 日/周 LLM 输入符合 D4；存在用户补充 note 时，评估 findings 能反映其内容（非仅标签计数）。（真实数据验证，AI 与规则降级均命中）
- [x] 持久化结果符合 D5；回顾页按 D8 渲染评估正文，**不**再详细列出周期内每条执行记录。
- [x] 用户可确认/撤销确认回顾；失败可手动重新生成；规则降级时 `source=rules` 仍可读。
- [x] 周回顾可展示 Milestone/Outcome（及建议确认的 Task）确认入口，系统不自动标完成。
- [x] 回顾页不提供「此刻建议」式即时改期主路径；不自动产出 Adjustment ChangeSet。

## Out of Scope

- 阶段回顾（goal-phase review）
- Agent 对话窗口体验优化（清单第 3 项）
- 首页洞察卡能力改造（除消费已确认回顾 findings 的既有路径）
- Review → Adjustment ChangeSet
- 时长达标自动完成 Task
- 回顾页内嵌完整执行账本/日历

## Open Questions

（无阻塞项。D1–D10 已定；文档已落盘。用户确认后可 `task.py start` 开始实现。）
