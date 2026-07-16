# Rhythm & Routine

AI Native 的个人目标推进系统（**v0.3.1**）。当前版本已经可以在没有数据库和 AI Key 的情况下运行，目标、Task、Routine、内部日程和执行反馈会保存在浏览器中；连接 PostgreSQL 后自动切换为数据库模式。

## 直接运行

要求：Node.js 22 或更高版本。

```bash
npm install
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。

页面顶部显示“本地模式”时，所有手动功能仍然可用，数据存储在当前浏览器。

## 启用 PostgreSQL

要求：Docker Desktop 正在运行。

```bash
npm run db:setup
npm run dev
```

`db:setup` 会启动 `postgres:17-alpine`、执行已有迁移并写入种子数据。默认开发连接位于 `.env`，仅用于本机容器。

常用命令：

```bash
npm run db:up
npm run db:down
npm run db:migrate -- --name <migration-name>
npm run db:seed
```

## AI 模型

Agent Harness 已包含 Runtime、Context Builder、Tool Registry、目标驱动 Loop、Trace 和 ChangeSet 人工确认边界，并通过 OpenAI-compatible 适配器支持 Qwen、DeepSeek、MiniMax、OpenAI、Moonshot、智谱、OpenRouter、SiliconFlow 和自定义供应商。

复制 `.env.example` 为 `.env`，填写所需供应商的 API Key，并通过 `DEFAULT_MODEL_PROVIDER` 选择默认供应商。模型名称和接口地址都可独立覆盖；没有任何 AI Key 时，目标、任务、Routine、日历、反馈与 Review 等手动功能仍可使用。

## v0.3.1 更新

- **周视图列对齐修复**：表头与时间网格共用同一个滚动坐标系，出现纵向滚动条或横向滚动时，时间刻度和七个日期列仍保持严格对齐。
- **日期状态表达统一**：只有“今天”使用贯穿表头和网格的整列淡底色；当前锚点日期使用轻量下划线标识，避免相邻两列同时看似被选中。
- **周视图布局回归修复**：显式固定时间刻度列与七天日程网格的网格位置，确保刻度在左、日程出现在对应时间行。

## v0.3.0 更新

- **首页右侧洞察卡片（Action → Insight → Progress）**：三张卡片基于真实执行数据给出可操作建议——**此刻建议**（即时行动与轻量改期/新增）、**节奏发现**（近 7–14 天执行节奏洞察）、**本周轨道**（本周负荷与目标推进状态）；支持「接受安排」「换个建议」与手动刷新。
- **Facts + LLM 生成与快照落库**：服务端聚合执行事实（Facts），由 LLM 生成洞察内容并写入 `HomeInsightSnapshot`；进入首页时读取各 kind 最新快照，无 AI Key 或数据库时回退到客户端规则计算。
- **定时刷新策略**：此刻建议按用户时区每小时整点生成；节奏发现与本周轨道每周三 08:00、周日 20:00 生成；提供 Cron 入口与手动重新生成 API。
- **回顾漏跑恢复**：Vercel Cron、读取回顾列表，以及本地 `next dev` / `next start` 进程内每 5 分钟的定时器，都会同步最近已经到期的日/周回顾；不依赖命中设置时间的精确单分钟。手动生成 / 重新生成绑定到期周期或当前展示回顾，不会在 23:00 前把「今天」当成已到期日回顾。每次最多补一份日回顾和一份周回顾，不批量回填历史缺口。
- **洞察卡桌面 UX**：右侧三卡与左侧日历同高均分；次要信息（原因 / 证据·影响 / 调整建议）默认折叠，可「展开详情」；手动更新时先清空正文并展示生成中文案，超时/失败可重试。
- **结构化 LLM 调用修复**：`generateObject` 对 Qwen/DashScope 非流式 JSON 输出关闭 `enable_thinking`，并归一化常见缺字段；避免思考模式导致挂起超时（Agent 流式路径不受影响）。
- **首页日历布局（飞书式）**：
  - **三视图统一顶栏**：`今天` / 前后导航 / 标题 / `Routine`·`已完成` 筛选 / 日·周·月切换；周一起算，切换视图保留当前锚点日期。
  - **日视图**：07:00–24:00 纵向时间轴（`HOUR_HEIGHT=64`），日程块 `top`/`height` 映射真实时长；当前时间红线；双击空白创建日程；块内快捷「记录执行 / 完成」。
  - **周视图**：7 列时间网格共用日视图刻度；列窄时不放块内按钮，单击打开详情。
  - **月视图**：事件 `时间 + 标题`、同日 `+N` 更多、点击日期进入日视图、今日/选中高亮。
  - **侧滑详情**：在左侧日历区域内嵌滑入（不遮挡右侧洞察卡片）；打开时对应块高亮 + 顶部同色条；220–280ms 动效。
  - **拖拽改期**：日/周支持拖拽移动与边缘拉伸（15 分钟吸附）；Routine 静默仅调整本次实例；Task/个人日程写入改期链并记录 `changeReason`；Agent 可读移动审计。
  - **重叠布局**：同时段日程等宽分列，超过 3 条显示 `+N`。
  - **实现位置**：`src/components/calendar/`、`src/lib/calendar/`、`src/components/product-shell.tsx`（`TodayView`）。

## v0.2.0 更新

- **Routine 闭环优化**：Routine 作为独立一等实体维护重复规则与有效期；详情页支持快捷修改 `startDate` / `endDate` 与 `active` / `paused` 状态，日历按当前窗口动态展开发生实例，暂停或缩短有效期会清理未来未执行实例。
- **个人日程占位**：今日安排支持创建不关联目标/任务的「个人日程」，用于会议、通勤、休息等时间占位；样式与目标任务区分，不计入目标投入与 Routine 完成率统计。
- **Agent Loop 升级**：从“工具执行完即结束”改为目标驱动循环；每轮记录目标状态、工具验证、下一步动作与结构化退出原因，前端处理过程展示完整 Loop 决策细节，便于调试 Agent 行为。

## 当前能力

- Outcome、Milestone、Task、Routine 的手动管理与确认边界
- Routine 有效期、暂停/恢复与日历动态实例
- 个人日程与目标日程的类型区分与独立管理
- 内部日历的飞书式日、周、月视图：时间轴定位、侧滑详情、拖拽改期、重叠分列与移动审计
- 首页此刻建议、节奏发现、本周轨道洞察卡片与轻量日程调整（桌面高度对齐、信息折叠、手动更新生成态）
- 执行结果、实际耗时、节奏反馈与偏差原因记录
- 日/周 Review 的生成、确认、撤回与定时生成入口
- Agent 对话、业务 Context、目标驱动 Tool Loop 和待确认 ChangeSet
- 多供应商模型设置以及数据库不可用时的浏览器本地兜底；Qwen 等思考模型的非流式结构化输出（`enable_thinking: false`）
## 验证

```bash
npm run typecheck
npm run lint
npm run prisma:validate
npm run build
npm audit --omit=dev
```

产品与架构范围见 [`docs/development-spec.md`](docs/development-spec.md)。v0.3.0 需求说明见 [`docs/v0.3.0 版本需求/`](docs/v0.3.0%20版本需求/)；v0.2.0 见 [`docs/v0.2.0 版本需求/`](docs/v0.2.0%20版本需求/)。
