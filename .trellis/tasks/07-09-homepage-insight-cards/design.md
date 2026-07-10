# 设计：首页洞察刷新策略（Phase B.1）

> 替代 Phase B 的 `factsHash` / `validUntil` / invalidate 钩子方案。

## 架构

```text
定时（cron）                    手动（UI 按钮）
    │                                │
    ▼                                ▼
generateMomentInsight / generateSlowInsight
    │                                │
    ▼                                ▼
append HomeInsightSnapshot（kind=moment|slow，trigger=scheduled|manual|cold_start）
    │
    ▼
cleanupOldSnapshots（保留窗口外删除）
    │
    ▼
GET /api/home/insights → 各 kind 最新一条合并返回
```

## 定时配置（用户时区）

| kind | 触发条件 | 常量 |
|------|----------|------|
| `moment` | 每小时 `minute === 00` | `MOMENT_CRON_MINUTE=0` |
| `slow` | 周三 `08:00` | `SLOW_CRON_WEDNESDAY=3`（weekday）+ `08:00` |
| `slow` | 周日 `20:00` | `SLOW_CRON_SUNDAY=0` + `20:00` |

实现方式：复用 `GET /api/cron/reviews` 模式，新增 `GET /api/cron/home-insights`（`CRON_SECRET` Bearer）。

## API 变更

### `GET /api/home/insights`

- 读 `moment`、`slow` 各自 `orderBy generatedAt desc` 第一条。
- **不**调用 `ensure*Snapshot` 重算（除非该 kind 无记录 → cold_start 生成一次）。
- 响应 `meta` 扩展：
  - `momentGeneratedAt` / `slowGeneratedAt`
  - `regeneratedMoment` / `regeneratedSlow` 改为仅表示本次 GET 是否 cold_start 生成

### `POST /api/home/insights/regenerate`

```json
{ "target": "moment" | "slow" }
```

- `moment`：立即 `generateMomentInsight` + append 快照，`alternateIndex=0`。
- `slow`：立即 `generateSlowInsight` + append 快照（rhythm + weekly 同包）。
- 返回与 GET 相同结构。

### `PATCH /api/home/insights/moment`

- 保持不变：`alternate` / `respond`（只改 `alternateIndex` / `userResponse`，不触发 LLM）。

## 数据模型

`HomeInsightSnapshot` **不删表**，字段调整：

| 字段 | Phase B.1 |
|------|-----------|
| `factsHash` | 保留列，仅审计/调试，**不参与**过期判定 |
| `validUntil` | 废弃写入；可留列兼容 |
| `generatedAt` | 排序与展示「更新时间」 |
| `trigger`（新增，可选） | `scheduled` \| `manual` \| `cold_start` |

读写策略从「每 kind 只保留一条（deleteMany 后 create）」改为 **append + cleanup**。

## 清理策略（已确认）

| kind | 保留规则 |
|------|----------|
| `moment` | 最近 **7 天** 或每用户最多 **168 条**（取较严） |
| `slow` | 最近 **180 天** 或每用户最多 **32 条**（取较严） |

cron / 手动生成后执行 `cleanupOldSnapshots(userId)`。

## 前端

- 每张卡标题行增加「更新」按钮（`RefreshCcw`），调用 `POST regenerate`。
- 展示 `generatedAt` 友好文案（如「2 小时前更新」）+ 来源标签（小律生成/规则建议）。
- 手动更新中显示 loading，失败 toast。

## 删除的代码路径

- `isSnapshotStale` 在 GET 路径的调用
- `saveInsightSnapshot` 开头的 `deleteMany`（改为 create only）
- `schedule.ts` / `reviews.ts` 中的 `invalidateMomentInsights` / `invalidateSlowInsights` 调用
- `home-insights-facts.ts` 中 `buildMomentFactsHashInput` / `buildSlowFactsHashInput` 可保留计算但仅写入快照审计字段

## AI 失败策略（推荐）

- 定时/手动生成时 AI 失败 → 规则降级写入新快照（与现逻辑一致）。
- **若已有 AI 快照且新一轮 AI 失败** → **保留读最新 AI 快照**，不覆盖为 rules（避免刷新掉回规则）。此条可在实现时落地。

## 回滚

保留 Phase A 本地规则；feature flag 或回退 GET 逻辑可恢复哈希方案（不推荐）。
