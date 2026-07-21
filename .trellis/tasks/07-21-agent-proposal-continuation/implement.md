# V0.4.1 Agent 提案续接与增量调整实施记录

> 2026-07-21 已按推荐方案完成核心实现与验证；保留本文原阶段划分作为实施追踪。

## Phase A：固定真实基线和续接评测集

1. 把已验证的两轮真实 Run 指标写入版本化 baseline：23,843 / 14,326 Token、6 / 4 Loop、6 / 3 工具调用。
2. 新增 continuation fixtures，覆盖 create、明确时间 patch、增删项、未指定时间 reorder、证据过期、并发变化和无有效提案。
3. 报告 model calls、分类准确率、operation 保留率、复用证据、重读范围、Token、重复/未授权写入和最终冲突。

验证：固定集可在旧实现上复现冗余，不能先改 expected 掩盖失败。

## Phase B：数据模型与兼容迁移

1. 扩展 AgentRun 的 Conversation/父 Run/continuation 元数据。
2. 扩展 ChangeSet 修订关系、revision、scheduleEvidence 和 SUPERSEDED 状态。
3. 为新 operation 写入稳定 operationId；为旧 JSON 提供只读兼容投影。
4. 迁移前备份并比较 AgentRun、AgentStep、ToolCall、ChangeSet 数量、ID、状态和 operations 哈希。

验证：历史 Run/ChangeSet 可读；同一修订链最多一个可应用版本；回滚不删除历史数据。

## Phase C：续接路由与精简上下文

1. 扩展 IntentResolution 为 adjustmentKind、continuation reference、operation refs 和 timingSpecified。
2. 让 resolver 实际使用最近对话和服务端 capsule，支持自然序号、`10.15`、`10:15` 和单点时间。
3. 实现 continuation loader、1,500 字符胶囊和按 kind 选择的 ContextPlan。
4. 增加 Run 内同版本只读缓存，避免完全相同工具重复访问数据源。

验证：错误 Conversation/用户/状态引用不可读取；无提案时安全回退；上下文不包含 raw ToolCall。

## Phase D：ChangeSet revision 服务

1. 增加稳定 operation patch 和 revision 创建事务。
2. 新版本创建与旧版本 SUPERSEDED 原子完成。
3. 仅允许修改目标 operation 和授权字段；未变 operation 深度相等且 ID 不变。
4. API/UI 永远指向修订链最新可应用版本。

验证：并发修订、重复提交、已应用/拒绝/过期版本、部分失败均不产生双 pending。

## Phase E：模型驱动的 ReorderDecision

1. 新增 ReorderContext builder，只装配受影响 operations、硬/软约束、忙闲和轻量活动元数据。
2. 新增 ReorderDecision schema 与一次主推理调用；使用当前选择的 provider/model，并记录独立 token/耗时。
3. 对模型输出执行 operation allowlist、duration、fixed、window 和 schema 校验。
4. 调用候选验证；失败时只携带结构化错误进行一次模型修复。
5. 二次失败只问一个取舍问题，不生成 ChangeSet。

验证：测试必须证明真实 model adapter 被调用；纯工具交换或固定算法不能通过未指定时间 reorder 用例。

## Phase F：证据指纹与应用时最终校验

1. 为日程窗口生成稳定 fingerprint，并保存覆盖范围、observedAt 和 operation IDs。
2. 修订时按 fingerprint/TTL 复用未变证据，只重读受影响窗口。
3. ChangeSet 应用事务内重新校验全部最终日程候选和提案内部冲突。
4. stale 返回结构化错误并进入 continuation recovery，正式写入为 0。

验证：并发插入冲突日程、跨时区、改期链、取消/已改期旧块和 apply race 均覆盖。

## Phase G：Agent Runtime 与 UI 集成

1. itinerary_create 校验后强制创建 ChangeSet；recommend-only 保留纯建议边界。
2. proposal patch 走 delta plan；明确时间不调用额外重排推理，未指定时间 reorder 必须调用模型。
3. UI 展示复用、模型重排、局部校验和修订差异；旧卡片不可应用。
4. 清空上下文、新对话、取消 Run 和拒绝草案同步清理有效 continuation 引用。

验证：刷新恢复、SSE 到达顺序、取消/超时、旧客户端和 browser-local 降级。

## Phase H：质量门禁与灰度

建议命令：

```bash
npm run typecheck
npm run lint
npm run prisma:validate
npm run test:agent-quality
npm run eval:agent
npm run build
```

新增 continuation 专项门禁：

- continuation kind 与 operation 定位准确率 100%（固定安全集）。
- 未指定时间 reorder 的模型调用证据 100%。
- 未变 operation 保留率 100%。
- 安全、确认、重复写入和 stale apply 不变量 100%。
- 截图基准第二轮 ≤ 2 次模型调用、≤ 7,000 Token、不读取完整目标/Routine、不校验未变三项。

按 continuation routing → revision → model reorder → apply-time validation → UI 顺序分别启用 feature flag；每阶段可独立回退。

## 2026-07-21 实施结果

- Phase A：新增 8 条 continuation 固定样本，并保留截图场景 23,843 / 14,326 Token 基线。
- Phase B：完成全增量迁移；历史四张 Agent/ChangeSet 表在迁移前后数量与内容哈希一致。
- Phase C：完成五类 adjustment 子意图、稳定引用、1,500 字符胶囊、Run 内相同读取缓存和局部上下文快路径。
- Phase D：完成稳定 operation ID、原子 supersede、新 revision 与只读版本链 API/UI。
- Phase E：完成结构化 `ReorderDecision`、当前模型真实推理、一次结构化修复上限、供应商形状归一化和可用区间硬校验。
- Phase F：完成 schedule evidence 保存与串行化应用事务内的正式日程、提案内部和 Routine 冲突终检。
- Phase G：完成客户端 Conversation/Run/ChangeSet 引用传递、局部过程文案与历史版本查看；正式计划仍只在确认后写入。
- Phase H：类型、Lint、完整测试、专项测试、198 条固定评测、Prisma 与生产构建通过；Qwen 真实模型 2/2 合成样本通过。

### 截图问题复查补丁

- 补充“5 点半/五点半”等自然时间抽取；缺少上午/下午时注入真实当前本地时间并只调用一次小型结构化时间解释，显式日间限定词仍零模型归一化。
- 待确认 ChangeSet 成为续接防火墙：无法确定局部动作时只追问一次，不再进入全量目标/日程/历史读取并另建独立草案。
- 同批工具按 `历史与独立读取 → 新鲜日程窗口 → 最终候选校验` 分层；层内无依赖读取仍并行，模型协议消息仍按原顺序回传。
- 日程草案保存最后一次成功候选校验的 `scheduleEvidence`；前置条件补齐在 UI 显示为正常校验步骤，不再一律标红为工具故障。
- 专项测试增至 46/46 通过；continuation 固定集增至 9 条，kind/target/model-call policy 均为 100%。未修改或清理任何现有业务数据。

### 页面上下文作用域补丁

- 目标焦点改为页面派生值：仅 `goal-detail` 自动关联目标，其他页面统一为未关联。
- 客户端在快捷入口、意图识别、business 裁剪、page payload、Conversation scope 和面板标签使用同一派生值；服务端在规则/模型路由与 ContextBuilder 前再次复核。
- 离开目标详情会建立不可撤销边界；旧对话摘要、父 Run 和旧草案不再自动影响首页指令，历史 Run/草案仍保留可见、可审计和可审批。
- 审计确认 selected task、Routine、calendar block、modal seed、home insight 当前都不会作为隐藏实体注入 Agent；日期、时区、近期日程和能力所需业务源属于显式通用上下文，继续保留。

### ChangeSet 跨操作引用补丁

- 根因归类为“跨层契约 + 测试覆盖缺口”：模型把 Goal create 的 `operationId` 写入 Schedule `goalId`，预览层能展示，但确认层只把 `clientRef/tempId` 映射为真实 ID。
- 服务端现在把匹配 create operation 的临时 `*Id` 规范化为 `*Ref`，并在事务中登记 `operationId/clientRef/tempId → 真实 ID`。
- 部分确认计算递归依赖闭包；乱序操作按稳定拓扑顺序执行；未知、重复、循环和错误实体类型的引用在草案持久化前拒绝。
- 现有数据库 ID 在草案持久化前验证用户归属；`deadline/dueDate` 同时规范化为 `targetDate`。
- 截图中的真实 7 项旧草案只读兼容解析通过；无效引用探针保持 ChangeSet 37→37；事务回滚探针在事务内正确关联 Goal/Schedule，结束后 Goal/Schedule 测试行均为 0。
- ChangeSet/Agent 专项 53 项、仓库全量 141 项、TypeScript 和 ESLint 全部通过。

详细证据见 `research/implementation-validation.md`。

## 风险文件与回滚点

- `prisma/schema.prisma` 与 ChangeSet/AgentRun migrations：先备份，旧字段保持 nullable。
- `src/agent/intent-resolver.ts`、`execution-plan.ts`、`runtime.ts`：保留 existing_adjustment 回退路径。
- `src/server/services/change-sets.ts`：revision 与 apply-time 校验必须同事务验证。
- `src/components/agent-panel.tsx`、`src/lib/conversation-store.ts`：服务端为状态真源，客户端不持有可信 operations。
- `src/domain/schemas.ts`：旧 operation schema 继续可读，新 schema 才要求 operationId。
