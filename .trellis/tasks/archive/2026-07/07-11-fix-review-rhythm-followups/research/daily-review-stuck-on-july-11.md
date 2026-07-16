# Research: 每日回顾停留在 7 月 11 日

- **Query**: 完整追踪定时触发、日回顾生成与幂等、数据库记录、API/前端选取、服务启动方式，定位“每日回顾仍停留在 7 月 11 日”的根因
- **Scope**: internal
- **Date**: 2026-07-14

## 结论

确切根因是：**当前本地服务只运行了 `next dev`，没有任何进程或平台定时器调用 `/api/cron/reviews`。** 项目所谓 scheduler 实际只是一个等待外部 HTTP 调用的 Next.js Route Handler；`vercel.json` 的 Cron 只在 Vercel 部署环境生效，本地 `npm run dev` 不会读取并执行它。因此服务即使从 7 月 11 日持续运行，也不会在 23:00 自行生成回顾。

这不是 API 或前端选错记录：

- 数据库中最新日回顾确实是用户时区 7 月 11 日。
- `GET /api/reviews` 返回数据库真实记录。
- 前端按类型过滤后，以 `periodStart` 降序取最新日回顾，因此只能显示 7 月 11 日。

当前触发逻辑还有一个可靠性限制：Cron Route 仅在调用发生的分钟与用户设置 **精确相等** 时生成；若机器休眠、进程停止或外部 Cron 延迟/漏调，恢复后没有补偿或追赶逻辑。它不是这次“完全没有 Cron 请求”的首要原因，但会继续造成同类漏生成。

## Findings

### Files Found

| File Path | Description |
|---|---|
| `vercel.json:1-4` | 唯一的 Review 外部 Cron 配置，每 30 分钟请求 `/api/cron/reviews` |
| `package.json:5-20` | `dev` 仅为 `next dev`、`start` 仅为 `next start`，没有本地 scheduler 进程或脚本 |
| `README.md:5-27` | 本地启动说明只要求 `npm run dev`，没有启动 Cron runner |
| `src/app/api/cron/reviews/route.ts:6-21` | Cron HTTP 入口；按用户时区与设置时间精确匹配后调用生成服务 |
| `src/lib/timezone.ts:3-25` | 用户时区拆分与日/周周期边界计算 |
| `src/server/services/reviews.ts:58-61` | 回顾列表按 `periodEnd desc` 返回 |
| `src/server/services/reviews.ts:72-76` | 生成入口及周期幂等键 |
| `src/server/services/reviews.ts:109-130` | 生成成功/失败后的同键 upsert |
| `src/app/api/reviews/route.ts:7-15` | 回顾列表与手动生成 API |
| `src/components/product-shell.tsx:151-182` | 页面启动时独立请求 Review API 并保存到状态 |
| `src/components/product-shell.tsx:624-635` | 手动生成当前日/周回顾 |
| `src/components/product-shell.tsx:1863-1866` | 回顾页按类型过滤并按 `periodStart` 取最新记录 |
| `src/components/product-shell.tsx:1996-2014` | 依据最新记录周期显示今日/昨日/显式日期 |
| `src/app/api/home/insights/route.ts:9-15` | 首页 API 只返回三张洞察卡，不返回 Review 列表 |
| `src/server/services/home-insights-facts.ts:154-167` | 首页事实只读取最近 4 条可用 Review 的 findings |
| `src/server/services/home-insights-facts.ts:244-260` | Review findings 仅作为慢洞察生成输入，不参与回顾页选取 |
| `prisma/schema.prisma:99-105` | 用户时区及默认日/周回顾时间 |
| `prisma/schema.prisma:339-356` | Review 表与唯一 `idempotencyKey` |
| `docs/v0.3.0 版本需求/新增特性-回顾节奏评估.md:38-45` | 需求规定用户时区每日 23:00、周日 23:00 生成 |
| `docs/v0.3.0 版本需求/新增特性-回顾节奏评估.md:88-92` | 日回顾定时及“昨日回顾”展示预期 |
| `docs/v0.3.0 版本需求/新增特性-回顾节奏评估.md:200-206` | Cron/手动共用服务、幂等与手动重试约束 |

### 定时触发配置与运行条件

1. `vercel.json:2-4` 配置：

   ```json
   { "path": "/api/cron/reviews", "schedule": "*/30 * * * *" }
   ```

   该配置的职责只是让 Vercel 平台每半小时调用 HTTP Route；它不会让 `next dev` 或 `next start` 内部出现定时循环。

2. `package.json:6-8` 的运行命令只有：

   ```json
   "dev": "next dev",
   "build": "next build",
   "start": "next start"
   ```

   仓库中未找到 `node-cron`、scheduler worker、`setInterval` 服务端轮询、launchd/crontab 配置或本地 Cron runner。

3. 当前实际运行日志显示，开发服务从 `2026-07-11T10:04:59Z` 起以 `npm run dev` / `next dev` 持续运行。日志中有大量 `GET /api/reviews` 和手动 `POST /api/reviews`，但没有任何 `GET /api/cron/reviews`。这与“只启动 Web Server、没有外部 Cron”完全一致。

4. 即便 Route 被调用，`src/app/api/cron/reviews/route.ts:11-18` 仍要求：

   ```ts
   const currentTime = `${pad(parts.hour)}:${pad(parts.minute)}`;
   if (currentTime === user.dailyReviewTime) {
     // generate daily
   }
   ```

   当前数据库用户设置为 `timezone=Asia/Shanghai`、`dailyReviewTime=23:00`、`weeklyReviewDay=0`、`weeklyReviewTime=23:00`。每半小时调度在正常准点执行时会覆盖 23:00，但错过该分钟后没有 catch-up。

### 日回顾生成与幂等逻辑

- `src/app/api/cron/reviews/route.ts:13-14` 使用 `zonedPeriod(now, timezone, "daily")` 计算用户本地当天 00:00 到次日 00:00 的 UTC 边界。
- `src/server/services/reviews.ts:75-76` 使用
  `${userId}:${type}:${periodStart.toISOString()}:${periodEnd.toISOString()}`
  作为唯一键，并先 upsert 为 `GENERATING`。
- 成功后 `src/server/services/reviews.ts:109-113` 对同一键 upsert 为 `AWAITING_CONFIRMATION`；失败时 `:129-131` 把同一行标记为 `FAILED`。
- `prisma/schema.prisma:352` 对 `idempotencyKey` 有唯一约束，因此重复调用同一周期不会创建重复行。
- 这里的“幂等”是**同周期唯一且可覆盖重生成**，不是“已有成功记录就直接跳过”。手动重试或重复 Cron 会更新同一行的内容和状态。

### 数据库现存 Review 记录

2026-07-14 18:52（UTC+8）通过当前运行服务的 `GET /api/reviews?limit=50` 读取到 3 行：

| 类型 | 用户本地周期 | UTC 周期 | 状态 | 创建时间（UTC） |
|---|---|---|---|---|
| weekly | 7 月 6 日 00:00 – 7 月 13 日 00:00 | `2026-07-05T16:00Z` – `2026-07-12T16:00Z` | confirmed | `2026-07-11T09:39:37Z` |
| daily | **7 月 11 日** | `2026-07-10T16:00Z` – `2026-07-11T16:00Z` | confirmed | `2026-07-11T10:46:49Z` |
| daily | 7 月 9 日 | `2026-07-08T16:00Z` – `2026-07-09T16:00Z` | confirmed | `2026-07-11T09:37:37Z` |

7 月 12–14 日对应的日回顾周期均不存在：

- 7 月 12 日：`2026-07-11T16:00Z` – `2026-07-12T16:00Z`，**未生成**
- 7 月 13 日：`2026-07-12T16:00Z` – `2026-07-13T16:00Z`，**未生成**
- 7 月 14 日：`2026-07-13T16:00Z` – `2026-07-14T16:00Z`，**未生成，但调查时尚未到当天 23:00，因此按需求尚未到期**

所以“7 月 12–14 日是否生成”的严格答案是：三天数据库都没有记录；其中 12、13 日是确定漏生成，14 日在调查时尚未到计划生成时刻。

### API 返回与前端选取

#### 回顾页

- `GET /api/reviews` 直接调用 `listReviews`；服务按 `periodEnd desc` 返回最多 12 条。
- 页面 mount 后 `reviewApi.list().then(setReviews)`，没有额外缓存层或服务端“固定 7 月 11 日”的逻辑。
- `ReviewView` 对 `reviews` 按当前 Tab 类型过滤，再按 `periodStart` 字符串降序取第一条。ISO 时间字符串可按字典序正确比较，因此选取逻辑会选到该类型真实最新周期。
- 当前日回顾最新数据就是 7 月 11 日，所以 UI 显示 7 月 11 日符合数据库事实。
- 页面默认 Tab 是 weekly（`product-shell.tsx:1864`）；用户切换到 daily 后才会看到最新日回顾。这不影响本次日记录缺失结论。

#### 首页

- `/api/home/insights` 不返回 Review 实体，也不决定回顾页当前周期。
- 首页事实构建按 `createdAt desc` 读取最近 4 条有效 Review，只抽取每条前 2 个 findings 作为慢洞察输入。
- 因此首页可能继续间接消费旧 Review findings，但它不会让回顾页“卡在”旧日期；两者数据流彼此独立。

### 预期与实现对照

需求明确规定：

- 用户时区每天 23:00 生成当天日回顾。
- 下一份生成前展示上一份回顾；跨过一天而没有新记录时，应显示旧记录的显式日期。
- Cron 与手动生成共用服务并依赖周期唯一键。

生成服务和前端旧记录展示基本符合这些规则；缺口在**运行部署契约没有覆盖当前本地启动方式**。文档把“定时生成入口存在”和“定时任务正在运行”混为一体，当前实际只满足前者。

## 最小且可靠的修复方案

### 1. 先补数据

- 使用用户时区周期边界手动补生成 7 月 12 日、7 月 13 日两份日回顾。
- 7 月 14 日应等当天 23:00 后由修复后的调度生成；若业务决定提前补，只能接受它是未完整收工的当日评估。
- 同周期唯一键可避免补生成产生重复行。

### 2. 让 scheduler 真正运行

按当前主要运行环境二选一，但必须明确采用其中一种：

- **Vercel 部署**：确认实际应用部署到读取该 `vercel.json` 的 Vercel 项目，并验证平台 Cron 执行日志。
- **本地长期运行**：增加一个明确的本地 scheduler/worker 启动方式，随应用启动并定期调用受保护的 `/api/cron/reviews`；仅 `npm run dev` 不足以完成此职责。也可由 launchd 等系统级调度器调用，但必须写进启动和验收文档。

### 3. 把精确分钟判断改为“到期且缺失”

为了避免机器休眠、重启或 Cron 延迟继续漏生成，每次轮询应按用户时区判断：

1. 当前本地时间已达到 `dailyReviewTime`；
2. 当天目标周期不存在成功 Review；
3. 不存在则调用既有 `generateReview`；
4. 对最近漏掉的已到期周期做有限追赶，至少覆盖上一次服务停止后的日期。

仍保留现有唯一幂等键。这样调度器只需“最终至少调用一次”，不再要求恰好在 23:00 那一分钟命中。

这三部分中，补数据解决现状；启动真实调度器解决本次首要根因；到期检查与有限追赶解决同类问题的可靠性。

## 推荐验收步骤

1. **现状基线**：查询 Review，保存当前 3 行及用户时区/23:00 设置。
2. **补历史**：生成 7 月 12、13 日周期；确认数据库各新增 1 行，周期 UTC 边界分别正确。
3. **幂等**：对 7 月 12 日再次触发生成；确认 Review 总行数不增加、同一 `id` 被更新。
4. **真实调度**：通过最终采用的平台 Cron 或本地 scheduler 触发一次，日志必须出现 `/api/cron/reviews` 请求，而不只是 `next dev` 进程仍在运行。
5. **准点场景**：在测试用户时区达到配置时间后，确认当天 Review 自动生成。
6. **错过后追赶**：让 scheduler 在到期时停止或模拟休眠，过 23:00 后恢复；确认无需人工点击即可补出缺失周期。
7. **重复轮询**：恢复后连续触发两次，确认同周期始终只有一行。
8. **API**：`GET /api/reviews` 返回补齐后的周期，顺序为最新周期优先。
9. **前端**：刷新页面并切换日回顾，确认自动显示最新周期；7 月 11 日不再是 latest。
10. **失败路径**：临时让 AI 生成失败，确认规则降级仍能写回顾；若主流程抛错则保留单行 `FAILED`，手动重试更新同一行。
11. **安全**：若配置 `CRON_SECRET`，无 Bearer 请求返回 401，scheduler 携带正确凭据后成功。

## Caveats / Not Found

- 项目没有独立的 Cron 执行审计表；“Cron 未调用”的运行证据来自持续运行的开发服务访问日志中完全没有 `/api/cron/reviews` 请求。
- 未发现本机仓库之外另行配置的 launchd/crontab；即使外部曾配置，它也没有在当前 Web 服务日志中形成请求。
- 7 月 14 日在调查时为 18:52（UTC+8），尚未到需求规定的 23:00；不能把它与 7 月 12、13 日同样判定为“已到期但漏生成”。
