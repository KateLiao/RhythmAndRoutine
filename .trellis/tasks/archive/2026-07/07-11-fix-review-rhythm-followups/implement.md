# 实施计划：修复回顾节奏遗留问题

## 0. 前置阅读

- `prd.md`
- `design.md`
- `docs/v0.3.0 版本需求/新增特性-回顾节奏评估.md`
- `.trellis/spec/guides/cross-layer-thinking-guide.md`

## 1. 导航真实状态

- [x] 在 `product-shell.tsx` 增加有完整函数注释的纯计算函数：
  - 当前用户时区日期键
  - 今天待处理日程数量
  - 是否存在待确认回顾
- [x] 用派生值替换 `hint="4"` / `hint="新"`。
- [x] 0 项时隐藏 badge；确认回顾与记录执行后即时更新。

## 2. 回顾页标题与信息架构

- [x] 将顶层回顾标题改为中性页面标题，移除固定周标语。
- [x] 将日/周 segmented control 移到 Hero 外的页面级 toolbar。
- [x] 拆分日/周内容编排：
  - 日：摘要、轻量指标、关键发现、建议与日专属补充。
  - 周：摘要、周指标、主报告、任务/Routine/目标校准、确认区、下周建议。
- [x] 调整 CSS，并验证 375 / 768 / 1024 / 1440px 布局、focus 与 reduced-motion。

## 3. Task 完成入口封堵

- [x] `updateTask` 明确拒绝 `status=completed`，提示走 `/complete`。
- [x] 复核 validation 与客户端编辑表单，确保正常非终态编辑不受影响。
- [x] 保持 `aggregateTaskStatus` 只产出非完成状态。

## 4. 周回顾多任务关联

- [x] 周期块查询带出 `ScheduleBlockTask.taskId`。
- [x] `buildTaskProgress` 合并主/多任务关联 ID，按 ID 去重。
- [x] 验证仅作为非主关联的 Task 能进入周回顾任务进展。

## 5. 存量误完成数据

- [x] 新增默认 dry-run 的 `scripts/repair-auto-completed-tasks.ts`。
- [x] package scripts 增加清晰的 dry-run / apply 入口。
- [x] 执行 dry-run，核对当前 7 个候选及重算状态。
- [x] 备份候选行关键字段。
- [x] 执行 apply，将候选恢复为非终态并清空伪 `completedAt`。
- [x] 执行后验证：
  - `completed AND completionRecord IS NULL` = 0
  - 有 completionRecord 的 completed 数量未减少
  - 关联块与 Task ID 未变化

## 6. 文档同步

- [x] 更新 `docs/v0.3.0 版本需求/新增特性-回顾节奏评估.md`：
  - 导航 badge 口径
  - 日/周独立信息架构
  - Task 唯一完成入口与历史数据修复
- [x] 更新 `docs/development-spec.md`，补充 PATCH 禁止完成与数据修复边界。
- [x] 更新 `docs/v0.3.0 版本需求/0.3.0 版本需求清单` 的修复说明（如清单已有对应条目）。

## 7. 验证

### 自动检查

```bash
npm run typecheck
npm run lint
npm run build
```

### 手动 / 数据场景

1. 今天无待处理块 → 无 badge；新增 planned 块 → 数字 +1；完成/未完成/改期/取消 → 数字 -1。
2. 无待确认回顾 → 无「新」；生成回顾 → 显示；确认全部待确认回顾 → 隐藏。
3. 日/周切换不再改变顶层为固定周标语；各自显示自己的 summary 与内容结构。
4. 两个同名 Task / ScheduleBlock 只按 ID 关联，不串联状态。
5. 完成块后 Task 为 scheduled/in_progress/blocked/ready 之一；PATCH completed 被拒绝；`/complete` 正常写记录。
6. 修复脚本重复 dry-run / apply 不产生二次变更。

## 7.1 定时生成漏跑恢复

- [x] 提取最近到期日/周周期计算函数，覆盖设置时间前后、跨日与周边界。
- [x] 新增幂等的 `syncDueReviews`，已有记录跳过、失败记录重试。
- [x] Cron 改为每次调用同步到期周期，不再依赖分钟完全相等，并隔离单个用户失败。
- [x] 回顾列表读取前执行同一同步，支持本地运行自愈。
- [x] 增加回归测试：7 月 14 日 23:00 前目标为 7 月 13 日日回顾，23:00 后目标切换为 7 月 14 日；覆盖延迟触发、跨时区、周边界与幂等判定。
- [x] 更新需求文档与 README 的调度/本地自愈说明。
- [x] 一次性幂等补生成 7 月 12、13 日缺失日回顾；复查均为 `awaiting_confirmation`，再次同步 daily/weekly 均跳过。
- [x] 补本地进程内 5 分钟定时同步（`instrumentation`），解决 `next dev` 无 Vercel Cron 的问题。
- [x] 手动生成 / 重新生成绑定最近到期或当前展示周期；回顾页优先展示到期周期，避免未到期“今天”盖住昨日。
- [x] 2026-07-16 补生成 7 月 15 日缺失日回顾，并验证展示优先为昨日。

## 8. 风险与回滚点

- UI 改动集中在 `ReviewView` 与 `review-*` CSS；可按组件块回退。
- API 封堵可能影响未知客户端；错误信息应明确迁移到 `/complete`。
- 数据 apply 前必须保存候选备份；没有备份不得执行。
