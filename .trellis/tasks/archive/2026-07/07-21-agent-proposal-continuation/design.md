# V0.4.1 Agent 提案续接与增量调整技术设计

## 1. 设计目标

把 adjustment 从“每条消息启动一套完整 Agent Loop”改为两类可观察执行模式：

```text
itinerary_create
  → 完整上下文与候选生成
  → 全量候选校验
  → 待确认 ChangeSet

proposal_patch / proposal_item_reschedule / proposal_reorder
  → 定位上一份结构化提案
  → 构造差量上下文
  → 局部修订或模型重排推理
  → 局部校验
  → 新 ChangeSet revision
```

模型拥有“什么时间更合理”的语义判断权；确定性层拥有真实数据、硬约束、冲突校验、修订状态和正式写入权。

## 2. 当前问题与边界

当前客户端下一轮只发送最近自然语言消息和摘要；服务端为每次消息创建新 Run、新 evidence ledger 和通用 adjustment 计划。上一轮 ToolCall 虽然持久化，但没有以版本化证据进入下一轮。ChangeSet operation 没有稳定 ID，也没有修订链。

第一轮具体时间方案还可能在已校验后直接以自然语言结束，未创建 ChangeSet。这使“第一个改到 10:15”只能从文字重建四项安排。

本设计不跨 Conversation 自动续接，不把完整 ToolCall 注入模型，也不允许模型绕过 ChangeSet。

## 3. 意图与执行模式

在现有 `Capability=adjustment` 内增加：

```ts
type AdjustmentKind =
  | "itinerary_create"
  | "proposal_patch"
  | "proposal_reorder"
  | "proposal_item_reschedule"
  | "existing_adjustment";

type AdjustmentResolution = {
  kind: AdjustmentKind;
  conversationId?: string;
  continuationOfRunId?: string;
  changeSetId?: string;
  operationRefs: string[];
  patch?: Record<string, unknown>;
  timingSpecified: boolean;
  confidence: number;
};
```

路由优先级：当前消息显式新建意图 > 有效提案续接词和 operation 引用 > 页面弱先验。`recentMessages` 和服务端 continuation capsule 必须真正参与解析。

## 4. 持久化与修订链

推荐最小数据扩展：

- `AgentRun.conversationId`、`parentRunId`、`continuationKind`、`continuationState Json?`。
- `ChangeSet.supersedesChangeSetId`、`revision`、`scheduleEvidence Json?`；状态增加 `SUPERSEDED`。
- 新 ChangeSet operation 强制 `operationId`；历史 operation 在读取时生成只读兼容 ID，不回写旧记录。

客户端只上传 Conversation/Run/ChangeSet ID。服务端验证用户归属、状态和修订链后加载 operations，禁止客户端把 operations 当作可信事实回传。

修订时创建新 ChangeSet，旧版本原子地转为 `SUPERSEDED`。任何时刻同一修订链最多一个 `AWAITING_CONFIRMATION`。

## 5. Continuation capsule

`continuationState` 只保存下一轮真正需要的状态：

```ts
type ContinuationCapsule = {
  proposalId: string;
  parentRunId: string;
  status: "awaiting_feedback" | "awaiting_confirmation";
  operations: Array<{
    operationId: string;
    entity: string;
    type: string;
    title: string;
    startsAt?: string;
    endsAt?: string;
    goalId?: string;
    taskId?: string;
    fixed: boolean;
  }>;
  evidence: Array<{
    resourceKey: string;
    fingerprint: string;
    observedAt: string;
    operationIds: string[];
  }>;
  unresolved: string[];
};
```

胶囊上限 1,500 字符；服务端按目标 operation、相邻依赖和证据引用裁剪，不截断 JSON。存在胶囊时，从 prompt 中删除表达同一提案的长助手回复和 UI 过程步骤。

## 6. 模型重排推理

### 6.1 职责划分

| 层 | 负责 | 不负责 |
|---|---|---|
| 服务端 Context | 读取提案、真实忙闲、时区、硬约束、轻量活动元数据 | 决定何时最合理 |
| 大模型 | 根据语义与软约束选择合理顺序和时间、解释理由 | 读取数据库、正式写入、宣称未验证事实 |
| Validator | schema、持续时间、固定约束、候选冲突、operation allowlist | 评价活动语义 |
| ChangeSet service | 修订链、幂等、确认、应用时最终校验 | 改写模型理由 |

### 6.2 ReorderContext

服务端先构造一次精简上下文，而不是让模型在 Loop 中重复探索：

```ts
type ReorderContext = {
  timezone: string;
  instruction: string;
  affectedOperations: Array<{
    operationId: string;
    title: string;
    blockKind: string;
    durationMinutes: number;
    currentStartsAt: string;
    currentEndsAt: string;
    fixed: boolean;
    explicitConstraints: string[];
    focusLevel?: string;
    energyLevel?: string;
  }>;
  hardConstraints: string[];
  softConstraints: string[];
  availableIntervals: Array<{ startsAt: string; endsAt: string }>;
  neighboringProposalOperations: Array<{ operationId: string; startsAt: string; endsAt: string }>;
};
```

完整目标树、Review、执行历史和原始工具结果不进入该上下文。只有已有结构化字段能证明相关时，才加入轻量 focus/energy/rhythm 偏好。

ISO `Z` 字段继续作为确定性校验的绝对时刻；送入模型时同步派生 `localStartsAt/localEndsAt`。模型判断作息、饭点和“上午/晚上”必须使用本地投影，避免把 `01:00Z` 错述为 Asia/Shanghai 的凌晨 1 点。

### 6.3 ReorderDecision

模型通过受约束 structured output 返回：

```ts
type ReorderDecision = {
  affectedOperationIds: string[];
  candidates: Array<{
    operationId: string;
    startsAt: string;
    endsAt: string;
    reason: string;
  }>;
  reasoningSummary: string;
  assumptions: string[];
  needsClarification: boolean;
  clarificationQuestion?: string;
};
```

服务端拒绝未知 operation、未授权字段、持续时间静默变化、覆盖 fixed operation、窗口外时间和 schema 错误。模型不能输出完整 ChangeSet，以避免无关 operation 漂移。

### 6.4 有界修复

1. 第一次模型推理生成候选。
2. `validate_schedule_candidates` 校验受影响候选，并额外检查提案内未应用的相邻候选。
3. 验证通过：生成新 ChangeSet revision。
4. 验证失败：把结构化 conflicts、available intervals 和不变量错误交给同一模型修正一次。
5. 再失败：停止，不创建草案，只输出一个最小取舍问题。

不允许模型自行反复读取日历。重排路径主模型调用最多 2 次。

## 7. 其他差量路径

### `proposal_item_reschedule`

明确给出时间时不需要模型重新决定合理性。服务端应用字段 patch、默认保持持续时间，再只校验被改项和受影响关系；最终说明仍可由当前 Agent 模型自然生成，但不得因此启动完整探索 Loop。

缺少日间限定词的自然时间（如“5 点半”）使用一次更小的 `AmbiguousTimeDecision`：输入只含当前本地日期时间、原表达、提前/推迟关系、目标项和相邻提案；输出只允许 `HH:mm`、简短理由、假设或一个澄清问题。服务端随后验证方向、保持原日期/时长并执行局部冲突检查。带“下午/晚上”等限定词以及明确 24 小时制仍走零模型确定性 patch。

### `proposal_patch`

增删或改内容时，模型只在语义不明确或新增项需要选时段时参与。纯删除、标题更正等确定性 patch 不调用额外推理模型。

### `itinerary_create`

保留完整模型规划流程，但最终候选校验后必须创建真实待确认 ChangeSet。完全相同的只读工具调用使用 Run 内 read-through cache。

## 8. 证据新鲜度与最终安全

- Schedule evidence 使用查询窗口、有效日程 id/version/status/起止时间生成 fingerprint。
- 同 fingerprint 且 `observedAt` 在 5 分钟内，可复用未变 operation 的校验。
- 指纹变化时只读取受影响窗口；影响边界不确定才扩大窗口。
- ChangeSet 保存覆盖窗口和 fingerprint。
- 应用时在事务中重新读取最终窗口并校验所有待写日程；不一致返回 `STALE_PLAN`，零正式写入。

应用时校验是权威安全边界；对话阶段缓存只影响效率，不决定是否允许正式写入。

## 9. API 与工具

建议增加服务端能力，而不是让模型传完整旧草案：

- `GET /api/change-sets/:id/continuation`：返回归属校验后的精简提案。
- `POST /api/change-sets/:id/revisions`：提交 operation patch 或已验证 ReorderDecision，创建修订版。
- `read_pending_proposal`：只读工具，按服务端 continuation reference 读取精简提案。
- `propose_change_set_revision`：只接受 baseChangeSetId、目标 operation ID 和 patch/decision reference。

若 Route 已在 Agent 调用前加载 continuation，可不向模型暴露 `read_pending_proposal`，减少一个模型工具轮次；工具仍可用于恢复和显式审计。

## 10. UI 流程

- 第一轮安排完成后直接展示待确认 ChangeSet 卡片。
- 用户继续输入时，当前待确认卡片保持可见并成为续接对象。
- 重排未指定时间时显示“正在结合活动特点重新安排受影响片段”。
- 完成后展示版本差异：哪些 operation 变化、模型为什么这样安排、哪些事实是显式假设。
- 旧版本标注“已被修订版替代”，不能继续应用。

## 11. Token 预算

- Continuation capsule ≤ 1,500 字符。
- `ReorderContext` 目标 ≤ 3,000 字符，禁止完整目标树和 ToolCall raw output。
- 歧义单点时间解释最多 1 次模型调用、输出上限 240 Token，不读取目标树、执行历史、回顾或 Rhythm signals。
- 明确时间局部修订最多 2 次主模型调用；未指定时间重排为 1 次推理 + 最多 1 次修复。
- 截图基准第二轮总 Token ≤ 7,000。
- 报告分别记录 continuation resolver、reorder reasoning、repair 和最终回复 Token，避免遗漏独立结构化调用。

## 12. 兼容与回滚

- 新字段均允许历史 null；旧 ChangeSet 按原流程审批。
- feature flags 分离 continuation routing、model reorder reasoning、revision API 和 apply-time validation。
- 任一快路径失败可回退旧 adjustment，但不能同时留下两个可应用 ChangeSet。
- 关闭模型重排 flag 时，对未指定时间的 reorder 必须询问用户新时间，不能静默退化为机械交换。

## 13. 关键验收场景

1. “第一个从 10.15 开始，其他没问题”：只 patch 第一项并增量校验。
2. “把银行和阅读换个顺序，你看怎么安排合理”：真实模型输出 ReorderDecision，工具验证后形成修订版。
3. 模型把银行安排到未验证的营业时间：理由标记为假设；若没有可靠窗口且会影响执行，询问一次。
4. 第一次候选与会议冲突：反馈结构化冲突，模型只修复一次。
5. 用户确认前日历发生变化：应用返回 STALE_PLAN，零写入并进入增量恢复。
6. 旧版本 ChangeSet 被直接应用：返回不可应用状态，不影响最新修订版。

## 14. 页面上下文权威边界

页面中的 `selectedGoalId` 会跨导航保留，用于返回目标详情，但不能直接作为 Agent 上下文。客户端和服务端共用 `resolveAgentPageGoalId`：仅 `goal-detail` 接受非空目标 ID；其余页面一律归一化为 `null`。

这条派生范围依次约束：面板标签与快捷入口 → 意图识别 → business/page 请求 → Conversation scope → ContextBuilder selected entity。服务端再次归一化，避免旧客户端或错误调用方绕过 UI 边界。

Conversation 的 parent Run 和 pending proposal 都增加 revision 关联。清空上下文或离开目标详情后，历史 Run/ChangeSet 继续可见和可审计，但不再作为 `parentRunId` / `activeChangeSetId` 自动注入；手动清空的撤销会恢复引用，页面范围切换边界不可撤销。
