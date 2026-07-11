# 设计：回顾 · 记录后的节奏评估

> 对应 PRD：`prd.md` · 需求文档：`docs/v0.3.0 版本需求/新增特性-回顾节奏评估.md`

## 1. 架构与边界

```text
Cron (23:00 日 / 周日 23:00 周)     手动重新生成
              │                              │
              └──────────┬───────────────────┘
                         ▼
              assembleReviewFacts(type, period)
                         │
                         ▼
         tryAIReview(D4 input → D5 schema)
              │ 失败
              ▼
         buildRulesReview(降级)
                         │
                         ▼
         Review upsert（幂等键）+ 可选 RhythmSignal 提取
                         │
                         ▼
         GET /api/reviews → ReviewView（昨日/上周语义 + 评估正文）
```

**本任务边界**

- 改：Task 状态聚合、Review 生成输入/输出、默认定时、回顾页 UI。
- 不改：首页三卡生成逻辑、Agent 对话窗、Adjustment ChangeSet 管道。

**层职责**


| 层                       | 职责                                   |
| ----------------------- | ------------------------------------ |
| Domain (`schemas.ts`)   | 增强 `reviewResultSchema`              |
| Service (`reviews.ts`)  | Facts 组装、AI/规则、持久化、信号提取              |
| Service (`schedule.ts`) | D2：`aggregateTaskStatus` 不再自动完成 Task |
| API                     | 既有 reviews + cron；设置默认值              |
| UI (`ReviewView`)       | 昨日/上周 + 评估正文；无执行明细列表                 |


## 2. Task ↔ ScheduleBlock（D2）

### 2.1 现状问题

`aggregateTaskStatus`：`statuses.includes(COMPLETED) → TaskStatus.COMPLETED`。

### 2.2 目标规则

```text
无有效块          → READY
有 PLANNED/IN_PROGRESS → SCHEDULED 或 IN_PROGRESS（有 IN_PROGRESS 块则优先）
仅有终态块且用户未确认 → 保持 SCHEDULED / IN_PROGRESS（有完成投入时），绝不因块完成而 COMPLETED
用户 completeTask   → COMPLETED + completionRecord + completedAt
```

- 本函数**禁止**写入 `TaskStatus.COMPLETED`（完成只走 `task-completion.ts`）。
- 若 Task 已是 `COMPLETED` / `CANCELLED` / `ARCHIVED`，聚合跳过或仅保护终态，避免执行反馈把已确认任务打回。
- 「建议确认」为派生信号（`investedMinutes >= estimatedMinutes` 或无剩余计划块且有完成投入），可在周回顾 `taskProgress` / UI 确认区使用，**不落新 TaskStatus 枚举亦可**（优先计算属性，避免迁移）。

### 2.3 兼容

- 历史已被误标为 `COMPLETED` 的 Task：本任务不做批量回滚；新行为从部署后生效。若需数据修复，单列后续脚本（非本 MVP）。

## 3. Review Facts 与 LLM 契约

### 3.1 共用 facts

```ts
type ReviewPeriodFacts = {
  period: { type: "daily" | "weekly"; periodStart: string; periodEnd: string; timezone: string };
  productConstraints: string; // 结束后记录；不捏造；不宣布完成
  periodMetrics: {
    total: number; completed: number; missed: number; rescheduled: number;
    cancelled: number; investedMinutes: number; smoothCount: number; resistanceCount: number;
  };
};
```

### 3.2 日回顾 facts

- `todayBlocks[]`：全量当日块执行字段；`**note` 非空时在 prompt 中单独列出「用户补充感受」并要求优先引用**。
- `pendingFeedbackCount`
- `activeRhythmSignals[]`（≤5）

### 3.3 周回顾 facts

- `weekBlocksSummary`：按日聚合；含 note 的块保留短摘录（优先于无 note 块塞满 token）。
- `taskProgress[]`、`routineStability[]`、`scheduleDeviation`、`goalProgressHints[]`
- `activeRhythmSignals[]`、`recentDailyReviewFindings[]`（本周期已生成/已确认日回顾）

### 3.3.1 周回顾上下文压缩（信息密度优先）

原则：**服务端先做确定性压缩，再把「高密度摘要」交给 LLM 写结论**；禁止把整周逐条 ScheduleBlock 原文塞进 prompt。

```text
整周原始块 / 反馈 / 任务树
        │
        ▼  规则层（零 LLM）
periodMetrics + 标签分布 + Top 偏差原因
日聚合 7 行 + note 优先摘录
task/routine/goal 进展表（有活动才进）
日回顾 findings 去重合并
        │
        ▼  硬预算裁剪（见下表）
WeeklyReviewFacts（目标 ≤ ~2.5–4k tokens 量级的 JSON）
        │
        ▼  单次 generateObject
D5 评估正文
```

**压缩手法（按优先级）**

| 手法 | 做法 | 保密度的方式 |
|------|------|--------------|
| 1. 用日回顾当先验 | `recentDailyReviewFindings` 每条日回顾最多取 2–3 条 findings，全周去重后 ≤12 条；有日回顾时 **不再** 喂该日的逐块明细 | 日回顾已是压缩后的人话证据 |
| 2. 数字先算死 | `periodMetrics`、按日完成率、标签计数、投入分钟由规则计算；LLM 只解释、不重算 | 结论可核对数字 |
| 3. note 优先、无 note 降采样 | 有 `note` 的块：保留标题+结果+note（截断 ≤80 字）；无 note：只进当日聚合计数，不进摘录池 | 用户感受是最高密度信号 |
| 4. 异常优先于常规 | 摘录池排序：有 note > missed/rescheduled+obstacle > resistance 标签 > 普通 completed；同类封顶 | 支撑「偏差/阻力」类结论 |
| 5. 实体只保留有活动的 | `taskProgress` / `routineStability` / `goalProgressHints` 仅本周有块或有投入的对象；归档 Goal 排除 | 避免空树灌水 |
| 6. 信号去重 | `activeRhythmSignals` ≤5，按 confidence；与日回顾 findings 语义重复的可丢掉 statement 较短者 | 避免同一模式说三遍 |
| 7. 单跳生成 | 周评估 **不做**「先摘要再总结」双跳 LLM（费钱且漂移）；规则压缩足够 | 稳定、可测 |

**硬预算（实现常量，可调）**

| 字段 | 上限 | 说明 |
|------|------|------|
| `periodMetrics` + 按日 7 行聚合 | 固定小结构 | 每天一行：`{ date, done, total, investedMin, smooth, resistance }` |
| `noteExcerpts[]` | ≤12 | 全周 note/异常摘录，每条 ≤80 字 |
| `taskProgress[]` | ≤10 | 按投入或偏差排序；含 `readyForCompletionSuggest` |
| `routineStability[]` | ≤8 | |
| `goalProgressHints[]` | ≤5 | 活跃 Goal；Milestone/Outcome 只带待检查项标题 |
| `scheduleDeviation` | 计数 + Top3 reason/obstacle | 不附全部偏差块 |
| `recentDailyReviewFindings[]` | ≤12 | 已去重 |
| `activeRhythmSignals[]` | ≤5 | |
| 整包 JSON 字符 | 建议 soft cap ~8–12k 字符 | 超限时按：无 note 聚合已够 → 再砍 task 列表尾部 → 再砍 findings |

**有日回顾 vs 无日回顾**

- **本周 ≥4 份日回顾**：`weekBlocksSummary` 只保留 7 日聚合 + `noteExcerpts`；不传逐块数组。结论主要靠「日 findings + 聚合数字 + note」。
- **日回顾稀缺（&lt;4）**：提高 `noteExcerpts` 与异常块权重，仍不传全量块；可额外允许 ≤15 条「代表块」短记录（title/status/tags/note）。

**Prompt 约束（与预算配套）**

- 明确：只能基于提供的数字与摘录下结论；缺证据写「数据不足」，禁止脑补。
- 要求 findings 尽量能指回摘录/指标（便于规则侧抽检）。
- 用户 note 出现时，至少一条 finding 或 rhythmNote 须回应其内容。

### 3.4 输出 schema（D5）

扩展 `reviewResultSchema`：

- 必有：`summary`、`findings`、`suggestions`、`source`
- 可选数组/字符串区块：`sessionHighlights`、`rhythmNotes`、`taskProgressNotes`、`routineNotes`、`goalCheckSuggestions`、`nextCycleSuggestions`

**持久化建议**（兼容现表）：


| 内容                            | 落点                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| summary / status / metrics 汇总 | 现有列                                                                                       |
| findings / suggestions        | 现有 Json 列                                                                                 |
| 扩展区块                          | 新增 `Review.content` Json 列 **或** 并入 `metrics.content`；推荐独立 `content` Json，避免 metrics 语义污染 |


若加列：Prisma migration + serialize 一并改。规则降级路径填充必有字段 + 尽量填充可推断的可选区块。

### 3.5 LLM 调用

- 复用 `resolveCapabilityProvider("review")` + `generateObject`。
- 遵守 `.trellis/spec/guides/llm-structured-output.md`（Qwen 关 thinking 等）。
- 日/周 **prompt 模板分开**；schema 共用。
- 节奏信号提取可保留现有第二跳；失败不影响 Review 主写入。

## 4. 定时与展示语义（D7）


| 项   | 值                                                   |
| --- | --------------------------------------------------- |
| 日   | 每天 `dailyReviewTime`，默认 `23:00`                     |
| 周   | `weeklyReviewDay=0` 且 `weeklyReviewTime`，默认 `23:00` |
| 周期  | 现有 `zonedPeriod(now, timezone, "daily"|"weekly")`   |
| 幂等  | `${userId}:${type}:${periodStart}:${periodEnd}`     |


**UI 标题规则**

- 日 Tab：取该用户最新一份 `type=daily` Review；若其 `periodEnd` 早于「用户时区今天 00:00」对应的日周期结束，或今天的日回顾尚未生成，则展示为「昨日回顾」（通常即最新日回顾）。实现时以「最新 daily 的 period 日期标签」+ 相对今天的文案映射为准。
- 周 Tab：最新 `type=weekly` → 「上周回顾」，直到新的周日生成覆盖。

手动重新生成：对**当前应展示的那一周期**重跑同一幂等键（覆盖 GENERATING → 成功/失败）。

## 5. 回顾页 UI（D8）

### 5.1 信息架构

```text
[日回顾 | 周回顾]
页头：（今日）昨日回顾 / （本周）上周回顾 · 区间 · 状态
轻量指标（次要）
评估正文（主）：按 D5 有值区块渲染
（仅周）只由你确认：Milestone / Outcome / 建议确认 Task
操作：确认 | 重新生成 | 请小律解释
```

- 删除假 Pattern 三卡与「生成调整建议」主按钮（可保留「请小律解释」打开 Agent）。
- **禁止**渲染周期内逐条 ScheduleBlock 执行列表。

### 5.2 数据依赖

- `reviews` API 需返回扩展 `content`（或等价字段）与 `metrics`。
- 周确认区：goals 上 milestone/outcome + 前端/API 计算的 `readyForCompletion` tasks（可在 listReviews 旁挂轻量字段，或前端用 workspace tasks + 投入汇总；优先服务端在 generate 时写入 `goalCheckSuggestions` 文案，确认动作仍调现有 complete API）。

### 5.3 视觉

沿用现有产品 CSS 变量与回顾页容器类名演进；不新开品牌主题。保持桌面/移动可读：正文优先单列，指标横滑或换行。

## 6. 数据流（跨层）

```text
ExecutionRecord + RhythmFeedback.note
  → assembleReviewFacts
  → generateObject(reviewResultSchema)
  → Review 行
  → ReviewView 评估正文
  →（确认）Review.status=CONFIRMED
  → 首页 slow facts 可继续读 recentReviewFindings（既有）
```

Task 完成：

```text
ScheduleBlock COMPLETED → aggregateTaskStatus（不完成 Task）
  → 可选 UI「建议确认」
  → POST /api/tasks/:id/complete → COMPLETED
```

## 7. 风险与回滚


| 风险                 | 缓解                                 |
| ------------------ | ---------------------------------- |
| schema 变严导致 AI 常失败 | 可选字段 `.optional()`；preprocess；规则降级 |
| 周 facts token 过大   | 聚合 + note 优先截断 + 上限                |
| 改聚合影响旧「自动完成」习惯     | 产品明确仅用户确认；文档同步 development-spec    |
| migration 加列       | 可先 `metrics.content` 免迁移，再视需要加列    |


回滚点：聚合函数可特性开关；Review UI 可回退只渲染 summary/findings；定时默认值可配置回旧时间。

## 8. 关键文件

- `src/server/services/schedule.ts` — `aggregateTaskStatus`
- `src/server/services/reviews.ts` — facts / AI / 规则 / serialize
- `src/server/services/task-completion.ts` — 唯一完成入口（保持）
- `src/domain/schemas.ts` — `reviewResultSchema`
- `src/app/api/cron/reviews/route.ts`
- `prisma/schema.prisma` — User 默认时间；可选 Review.content
- `src/components/product-shell.tsx` — `ReviewView`、`generateReview`
- `src/lib/client-api.ts` — `ReviewRecord` 类型
- `docs/development-spec.md` — 同步语义

