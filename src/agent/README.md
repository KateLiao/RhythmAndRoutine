# Agent Harness

这一层不依赖页面组件或 Prisma 生成类型，负责小律的运行边界：

- `capabilities.ts`：五类业务能力的工具白名单、提示词和预算。
- `context-builder.ts`：按能力装配最小业务上下文，并生成 Context Manifest。
- `model-registry.ts`：Qwen、DeepSeek、MiniMax 的可替换适配入口。
- `tool-registry.ts`：只读工具与 ChangeSet 草案工具；不向自由 Loop 暴露正式写入。
- `runtime.ts`：有步数限制、持久化轨迹和人工确认暂停点的 Agent Loop。

下一阶段接数据库时，实现 `ContextDataSource`、`AgentDomainGateway` 和 `AgentRunStore`；接供应商时实现 `ModelAdapter`。领域层不需要感知供应商 SDK。
