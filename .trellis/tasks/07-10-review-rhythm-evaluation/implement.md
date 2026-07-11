# 实现计划：回顾 · 记录后的节奏评估

## 0. 前置阅读

- `prd.md`、`design.md`
- `docs/v0.3.0 版本需求/新增特性-回顾节奏评估.md`
- `.trellis/spec/guides/llm-structured-output.md`

验证命令（贯穿）：

```bash
npm run typecheck
npm run lint
```

---

## 1. 文档与规格同步（先做）

- [x] 确认本文件与需求文档、`prd.md` 一致
- [x] 实现结束后更新 `docs/development-spec.md`：
  - Task 仅用户确认完成；`aggregateTaskStatus` 不写 COMPLETED
  - 默认日/周回顾时间 `23:00`
- [x] 清单 `docs/v0.3.0 版本需求/0.3.0 版本需求清单` 第 2 项标记进度（实现完成后改已完成）

---

## 2. 前置：Task 状态聚合（D2）

**回滚点**：改动集中在 `aggregateTaskStatus`。

- [x] 修改 `src/server/services/schedule.ts` → `aggregateTaskStatus`
  - 禁止因 ScheduleBlock COMPLETED 将 Task 标为 COMPLETED
  - 已 COMPLETED/CANCELLED/ARCHIVED 的 Task 不被块状态打回（保护终态）
  - READY / SCHEDULED / IN_PROGRESS / BLOCKED 逻辑按 design §2.2
- [x] 手动路径验证：完成一块日程 → Task 仍非 completed（`scheduled`）→ `completeTask` 后才 completed（已用真实 API 走通并清理测试数据）
- [x] 工具函数 `isReadyForCompletionSuggest(task, blocks)` 供回顾 facts / UI（`schedule.ts` 导出，`reviews.ts` 的 `buildTaskProgress` 消费）

---

## 3. Domain Schema（D5）

- [x] 扩展 `src/domain/schemas.ts` → `reviewResultSchema`（可选区块）
- [x] 持久化选独立列：Prisma `Review.content Json?` + migration（`20260711092031_review_content_and_default_review_times`）
- [x] 更新 `ReviewRecord`（`client-api.ts`）与 serialize

---

## 4. Review 生成服务（D4 / D5 / D7）

**回滚点**：`reviews.ts`；保持幂等键与状态机。

- [x] 抽取 `assembleDailyFacts` / `assembleWeeklyFacts`
- [x] 实现周回顾压缩：`design.md` §3.3.1（日 findings 先验、note/异常摘录池、硬预算、有/无日回顾分支）
- [x] 日 prompt：块详情 + **用户 note 优先引用**指令
- [x] 周 prompt：只喂压缩后 facts；禁止逐块全量；要求缺证据声明数据不足
- [x] `tryAIDailyReview` / `tryAIWeeklyReview` 改用增强 schema；日/周分模板
- [x] `buildRulesDailyReview` / `buildRulesWeeklyReview` 填充必有字段 + 尽量填可选区块；`source=rules`
- [x] 写入 summary/findings/suggestions/`content`
- [x] 保留 Rhythm Signal 提取；失败不阻断主回顾（已加 try/catch 隔离）
- [x] 确认 `listReviews` / `confirmReview` 返回新字段（`content`）

---

## 5. 定时默认值（D7）

- [x] Prisma `User.dailyReviewTime` / `weeklyReviewTime` 默认改为 `23:00`（同一 migration；本地已有用户行也手动同步）
- [x] 前端 `SettingsView` / `product-shell` 初始 UserSettings 同步 `23:00`
- [x] 确认 `api/cron/reviews` 仍用用户设置比较时区时刻（逻辑未变，已复核）

---

## 6. 回顾页 UI（D8 / D9）

**风险文件**：`product-shell.tsx`（体量大，小步改 `ReviewView`）。

- [x] 日/周 Tab 标题：昨日回顾 / 上周回顾 + 周期标签（`describeReviewPeriod`）
- [x] 轻量指标（按当前 Tab 周期，来自该回顾自身的 `metrics`，日不再误用周数据）
- [x] 渲染 D5 评估正文区块；无值不渲染空壳（`REVIEW_CONTENT_SECTIONS` 过滤空数组）
- [x] 删除假 Pattern 三卡与 ChangeSet 主按钮（连带清理死 CSS）
- [x] **不**渲染逐条执行列表
- [x] 周：确认区（Milestone/Outcome + 建议确认 Task，Task 来自 `content.readyForCompletionTasks`）
- [x] 确认 / 重新生成 / 请小律解释
- [x] 空态：尚无昨日/上周回顾时的说明（等待 23:00 或手动生成）
- [x] 失败态：可重新生成

---

## 7. 规格与需求文档收尾

- [x] `docs/development-spec.md` 同步
- [x] `docs/v0.3.0 版本需求/新增特性-回顾节奏评估.md`（实现与需求文档一致，未回写偏差）
- [x] `0.3.0 版本需求清单` 第 2 项标记完成（验收通过后）

---

## 8. 验证清单

### 自动

```bash
npm run typecheck
npm run lint
npm run build
```

### 手动（均已在本机 dev + Postgres 上用真实 API 走通）

1. ✅ 数据库模式：新建测试 Task + ScheduleBlock，完成日程块后 Task 状态为 `scheduled`（≠ completed）；调用 `/api/tasks/:id/complete` 后变为 `completed` 且写入 `completionRecord`。测试数据已清理。
2. ✅ 手动生成日回顾（2026-07-09，真实历史数据）：findings/sessionHighlights 明确引用了用户 note 原文语义（如「自己有一点走神」「回朋友微信会分心」）。
3. ✅ `describeReviewPeriod` 生成「今日/昨日/上周」等相对标题；`ReviewView` 指标条读取该回顾自身 `metrics`，日/周不再互相误用。
4. ✅ 手动生成周回顾：`taskProgressNotes`/`routineNotes`/`goalCheckSuggestions` 均非空且引用真实任务/Routine/目标；额外造出一个 `estimatedMinutes` 已达标的任务，确认其出现在 `content.readyForCompletionTasks` 中。
5. ✅ 幂等：同一 idempotencyKey 重复 POST 只更新同一行（`upsert`），未观察到重复记录。
6. ✅ 规则降级：临时强制 `tryAIDailyReview`/`tryAIWeeklyReview` 返回 null 验证 `buildRulesDailyReview`/`buildRulesWeeklyReview` 均能产出可读回顾且 `source="rules"`；验证后已移除临时代码并重新生成 AI 版本恢复正常数据。
7. ✅ 确认/撤销确认：`PATCH /api/reviews/:id` 切换 `confirmed`/`draft` 状态与 `confirmedAt` 正确。

---

## 9. 建议实现顺序

1. D2 聚合修复（解锁干净评估数据）  
2. Schema + reviews 服务  
3. 默认 23:00  
4. ReviewView 重做  
5. 文档同步 + 全量验证  

**不要**在未修 D2 前把「任务完成率」写进周回顾主结论。
