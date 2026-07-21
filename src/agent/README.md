# Agent Harness

这一层不依赖页面组件或 Prisma 生成类型，负责小律的运行边界：

- `capabilities.ts`：五类业务能力的工具白名单、提示词和预算。
- `context-builder.ts`：按能力装配最小业务上下文，并生成 Context Manifest。
- `model-registry.ts`：Qwen、DeepSeek、MiniMax 的可替换适配入口。
- `tool-registry.ts`：只读工具与 ChangeSet 草案工具；不向自由 Loop 暴露正式写入。
- `runtime.ts`：有步数限制、持久化轨迹和人工确认暂停点的 Agent Loop。
- `intent-resolver.ts`：消息优先、支持多意图与阻塞字段的确定性 Router；复杂或低置信场景可通过开关进入结构化模型 Router。
- `execution-plan.ts`：为复杂请求生成依赖、工具白名单、成功条件与确认屏障，并做 DAG 安全校验。
- `capability-catalog.ts`：与五项能力和九个工具实现对应的机器可读能力目录。
- `tool-scheduler.ts`：最多并行三个独立只读工具；读写混批、多个写草案和缺少证据会被拒绝。
- `evals/`：版本化 Router / Planner / Runtime / Performance 数据集、确定性门禁与发布前真实模型抽样。

下一阶段接数据库时，实现 `ContextDataSource`、`AgentDomainGateway` 和 `AgentRunStore`；接供应商时实现 `ModelAdapter`。领域层不需要感知供应商 SDK。
