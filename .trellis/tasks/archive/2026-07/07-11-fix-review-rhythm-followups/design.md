# 设计：修复回顾节奏遗留问题

> 对应 PRD：`prd.md`  
> 来源任务：`.trellis/tasks/archive/2026-07/07-10-review-rhythm-evaluation/`

## 1. 边界与原则

- 不新增导航状态 API；由 `ProductShell` 已加载的 `schedule`、`reviews` 与用户时区派生。
- 日回顾与周回顾共用内容渲染原语，但使用不同的信息架构。
- Task 完成保持单一写入口：`completeTaskWithSummary`。
- 数据修复只处理 `status=COMPLETED AND completionRecord IS NULL`，绝不按标题判断。
- 新增或修改的函数均补充用途、参数与返回值注释。

## 2. 导航状态

### 2.1 「今天」

数据流：

```text
schedule + userSettings.timezone
  → 当前用户时区日期
  → date=今天 && status∈{planned,in_progress}
  → count
  → 0 隐藏，否则显示数字
```

计数包含过期但未记录执行结果的日程块；完成、missed、rescheduled、cancelled 不计数。使用稳定的纯函数集中定义，避免 TodayView 与导航各自发明口径。

### 2.2 「回顾」

```text
reviews
  → status=awaiting_confirmation
  → any
  → 有则显示「新」，否则隐藏
```

进入页面不改变业务状态；确认回顾后现有 `setReviews` 更新会立即清除提示。应用首次加载与手动生成后都复用现有 reviews 状态。

## 3. 回顾页标题与布局

### 3.1 顶层页头

`viewMeta.review` 不再使用周语境标语。顶层仅表达页面用途：

- eyebrow：`周期复盘`
- h1：`回顾`

具体周期、状态与报告摘要只在回顾页内部出现，消除双层竞争标题。

### 3.2 页面级切换

将 segmented control 从 `review-hero` 移到 `review-page` 顶部独立 toolbar：

```text
[ 日回顾 | 周回顾 ]                         [周期说明]
```

按钮保留 44px 以上点击高度、键盘 focus 与 `aria-pressed` / `role=tab` 语义。

### 3.3 日回顾

```text
周期 + 状态
摘要 Hero + 轻量指标
关键发现
建议 / 执行亮点 / 节奏解读
确认、重新生成、请小律解释
```

日回顾保持单主线阅读；可选区块按自然阅读顺序收拢，不展示周目标确认区。

### 3.4 周回顾

```text
周期 + 状态
周摘要 Hero + 周指标

主栏（评估）                 侧栏（校准）
├ 关键发现                  ├ 任务进展
├ 节奏解读                  ├ Routine 坚持
├ 本周建议                  ├ 目标检查
└ 下周建议                  └ 只由你确认

底部操作条
```

- 周专属内容不再统一塞进「补充观察」卡。
- `taskProgressNotes`、`routineNotes`、`goalCheckSuggestions` 与确认项进入结构化周校准侧栏。
- `nextCycleSuggestions` 在周回顾中命名为「下周建议」，在日回顾中命名为「明天可以这样调整」。
- 宽屏两栏；≤1100px 单栏，确认区紧随目标检查；正文行宽保持可读。
- 保留现有 Soft Humanist 色彩、字体与 semantic token，不引入新的视觉主题。

## 4. Task 完成状态

### 4.1 写入约束

```text
ScheduleBlock 执行反馈
  → aggregateLinkedTaskStatuses(taskId / ScheduleBlockTask.taskId)
  → READY / SCHEDULED / IN_PROGRESS / BLOCKED
  → 永不 COMPLETED

用户确认完成
  → POST /api/tasks/:id/complete
  → completeTaskWithSummary
  → COMPLETED + completedAt + completionRecord
```

`updateTask` 若收到 `status=completed`，返回明确的 400 DomainError，提示使用完成确认入口。其他允许编辑的非终态状态维持兼容。

### 4.2 周回顾多任务关联

`buildTaskProgress` 的任务 ID 来源改为：

```text
periodBlocks[].taskId
  ∪ periodBlocks[].linkedTasks[].taskId
```

服务端查询周期块时必须带回联结表任务 ID，后续投入汇总仍按稳定 ID 去重。

## 5. 存量数据修复

新增可重复执行的修复脚本，默认 dry-run，显式参数才 apply：

1. 查询未归档且 `status=COMPLETED AND completionRecord IS NULL` 的 Task。
2. 为每个 Task 读取 `taskId` 与 `ScheduleBlockTask.taskId` 关联的有效块。
3. 使用与 `aggregateTaskStatus` 相同的非终态规则重算：
   - 有 `IN_PROGRESS` → `IN_PROGRESS`
   - 否则有 `PLANNED` 或 `COMPLETED` → `SCHEDULED`
   - 否则全部 missed/rescheduled/cancelled → `BLOCKED`
   - 无块 → `READY`
4. apply 时使用条件更新，清空 `completedAt` / `completionRecord`，version + 1。
5. 输出 Task ID、标题、旧状态、新状态、关联块数及汇总数量。
6. 已有 `completionRecord` 的 Task 跳过。

脚本可重复执行：首次修复后候选集为空；并发变化通过条件更新避免覆盖。

## 6. 验证与回滚

- UI：验证 0/1/多项导航提示、日周切换、空态、生成中、失败、确认后状态。
- 服务：验证块完成不完成 Task、PATCH 旁路被拒绝、唯一完成入口写记录。
- 数据：先 dry-run 保存输出，再 apply；执行后候选数为 0，用户确认记录数不变。
- 回滚：修复脚本执行前导出候选行的 `id/status/completedAt/completionRecord/version`；如需回滚按 ID 恢复。

### 6.1 回顾定时漏跑恢复

新增服务层 `syncDueReviews(user, now)`，统一供 Cron 与回顾列表 API 使用：

1. 按用户时区及 `dailyReviewTime` 计算最近已经到期的日周期；当前时间未到当天设置时间时，目标为前一日。
2. 按 `weeklyReviewDay` / `weeklyReviewTime` 计算最近已经到期的周周期。
3. 使用与 `generateReview` 完全相同的幂等键检查记录；不存在或状态为 `FAILED` 时才生成。
4. Cron 每次触发都执行同步，不再要求当前分钟与设置时间完全相等。
5. 数据库模式读取回顾列表前也执行同步，使无外部调度器的本地运行在再次打开应用时自愈。

一次同步最多生成一份日回顾与一份周回顾，避免历史缺口导致页面请求触发无界 LLM 调用。在 7 月 14 日 23:00 前，自动同步的最近到期目标为 7 月 13 日；修复上线验收时另以幂等方式一次性补生成已确认缺失的 7 月 12、13 日日回顾。

## 7. 关键文件

- `src/components/product-shell.tsx`
- `src/app/globals.css`
- `src/server/services/goals.ts`
- `src/server/validation.ts`
- `src/server/services/reviews.ts`
- `src/server/services/review-schedule.ts`
- `src/app/api/cron/reviews/route.ts`
- `src/app/api/reviews/route.ts`
- `src/server/services/schedule.ts`
- `scripts/repair-auto-completed-tasks.ts`
- `package.json`
- `docs/development-spec.md`
- `docs/v0.3.0 版本需求/新增特性-回顾节奏评估.md`
