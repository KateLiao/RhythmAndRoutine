# Rhythm & Routine

AI Native 的个人目标推进系统（**v0.2.0**）。当前版本已经可以在没有数据库和 AI Key 的情况下运行，目标、Task、Routine、内部日程和执行反馈会保存在浏览器中；连接 PostgreSQL 后自动切换为数据库模式。

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

## v0.2.0 更新

- **Routine 闭环优化**：Routine 作为独立一等实体维护重复规则与有效期；详情页支持快捷修改 `startDate` / `endDate` 与 `active` / `paused` 状态，日历按当前窗口动态展开发生实例，暂停或缩短有效期会清理未来未执行实例。
- **个人日程占位**：今日安排支持创建不关联目标/任务的「个人日程」，用于会议、通勤、休息等时间占位；样式与目标任务区分，不计入目标投入与 Routine 完成率统计。
- **Agent Loop 升级**：从“工具执行完即结束”改为目标驱动循环；每轮记录目标状态、工具验证、下一步动作与结构化退出原因，前端处理过程展示完整 Loop 决策细节，便于调试 Agent 行为。

## 当前能力

- Outcome、Milestone、Task、Routine 的手动管理与确认边界
- Routine 有效期、暂停/恢复与日历动态实例
- 个人日程与目标日程的类型区分与独立管理
- 内部日历的日、周、月视图和 Routine 动态发生实例
- 执行结果、实际耗时、节奏反馈与偏差原因记录
- 日/周 Review 的生成、确认、撤回与定时生成入口
- Agent 对话、业务 Context、目标驱动 Tool Loop 和待确认 ChangeSet
- 多供应商模型设置以及数据库不可用时的浏览器本地兜底

## 验证

```bash
npm run typecheck
npm run lint
npm run prisma:validate
npm run build
npm audit --omit=dev
```

产品与架构范围见 [`docs/development-spec.md`](docs/development-spec.md)。v0.2.0 需求说明见 [`docs/v0.2.0 版本需求/`](docs/v0.2.0%20版本需求/)。
