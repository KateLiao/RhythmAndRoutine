# V0.4.0 Agent 能力评测与效率技术设计

## 1. 目标架构

V0.4.0 不通过“换模型”或继续堆关键词解决准确率问题，而是引入可观察的四段式流水线：

```text
消息 + 页面/会话上下文
        ↓
Intent Resolver
        ↓ IntentResolution
Plan Builder（简单请求可走 fast path）
        ↓ ExecutionPlan
Policy / Dependency Validator
        ↓ validated batches
Agent Runtime + Tool Scheduler
        ↓ trace + result
Eval & Feedback Pipeline
```

确定性层拥有最终约束权：模型可以建议意图、步骤和工具，但不能绕过 capability allowlist、依赖、写入风险、ChangeSet 或用户确认。

## 2. 意图解析

### 2.1 结构化契约

```ts
type IntentResolution = {
  route: "agent" | "non_execution";
  primaryCapability?: AgentCapability;
  intents: Array<{
    id: string;
    capability: AgentCapability;
    objective: string;
    confidence: number;
    slots: Record<string, unknown>;
    missingSlots: string[];
  }>;
  overallConfidence: number;
  needsClarification: boolean;
  clarificationReason?: string;
  source: "rules" | "model" | "hybrid";
};
```

### 2.2 两级路由

1. **确定性 fast path**：高置信、单意图、必要实体明确的常见请求直接路由，避免额外模型调用。
2. **结构化模型路由**：模糊、多意图、跨轮修正或规则冲突时，输出 schema 校验后的 `IntentResolution`。

决策规则：

- 用户当前消息的明确动作高于页面位置；页面只提供弱先验。
- 单条消息可以产生多个 intent，但必须选择一个 primary capability 用于预算与主提示词。
- 与产品执行无关的普通问答走 `non_execution`，不伪造 adjustment capability，也不加载完整业务上下文。
- 缺失字段只有在阻塞执行或可能造成错误对象/时间窗时才触发澄清。
- 低置信且无安全动作时先澄清；低置信但可安全读取时允许先读取再判断。
- 无关开放问答不再默认进入 adjustment，应返回 unsupported/general response 边界或专门的非执行路径。

### 2.3 回退

- 模型路由超时/格式错误：回退到规则路由并标记 degraded，不能静默声称高置信。
- 规则与模型冲突：保留两者结果用于 eval；在线采用 policy 允许且置信度更高的结果。
- 用户跨轮纠正后，新消息覆盖旧 intent，并在 trace 中标记 superseded。

## 3. 任务拆解

### 3.1 结构化计划

```ts
type ExecutionPlan = {
  planId: string;
  intentIds: string[];
  steps: Array<{
    id: string;
    objective: string;
    capability: AgentCapability;
    dependsOn: string[];
    toolHints: string[];
    access: "read" | "draft_write" | "user_confirmation";
    successCondition: string;
    failureStrategy: "stop" | "retry" | "degrade" | "ask_user";
  }>;
};
```

简单单意图请求沿用当前 loop，不额外产生完整模型计划，但运行时仍生成最小可观测 plan step。复杂或多意图请求才调用 Plan Builder，避免为了可测性增加所有请求的延迟。

### 3.2 计划校验

执行前确定性检查：

- step ID 唯一、DAG 无环、依赖存在。
- tool 属于 capability allowlist。
- draft_write 不与其他工具同批并行；正式写入不属于 Agent tool 范围。
- 日程候选验证依赖最新 schedule window 与候选版本。
- 每个写入草案都有确认边界和成功条件。
- 多意图在同一父 `AgentRun` 下依序执行，V0.4.0 不派生通用子 Agent。

计划无效时最多允许一次受约束修复；仍失败则停止并输出可解释缺口，不猜测执行。

## 4. 安全并行调度

### 4.1 工具元数据

在现有工具定义上增加：

```ts
type ToolExecutionPolicy = {
  parallelSafe: boolean;
  access: "read" | "draft_write" | "system";
  resourceKeys(input: unknown): string[];
  requiresEvidence?: string[];
};
```

只有 `parallelSafe=true`、全部为 read、无依赖边、resource key 不冲突的工具可组成同一 batch；首发最大并发数 3。

### 4.2 模型同批 tool calls

- Adapter 保留模型给出的 tool-call 顺序并一次发出 batch 事件。
- Scheduler 可并发执行合格 reads，使用 `Promise.allSettled` 收集结果。
- UI/审计按 `toolCallId` 关联；开始事件按原序发出，完成事件可按真实完成顺序显示。
- 返回模型的 tool messages 必须重新按原 assistant tool-call 顺序组装，符合 provider protocol。
- 同一模型批次若同时包含 read 与 draft_write：先执行 reads，写调用作废并要求新一轮模型基于新证据重新提出；不执行陈旧写入。

### 4.3 依赖与证据新鲜度

把现有基于 `successfulToolNames.lastIndexOf` 的线性顺序守卫替换为显式证据：`evidenceType`, `resourceKey`, `version/fingerprint`, `observedAt`, `producerToolCallId`。候选校验和草案写入声明所需证据版本，不再依赖数组位置。

### 4.4 部分失败

- 独立 read 失败不取消同批其他 reads。
- 必需读取失败：按工具策略重试一次，仍失败则停止依赖步骤。
- 可选读取失败：以 degraded 状态继续，并要求最终文案说明证据缺口。
- draft_write 使用幂等 key，任何超时重试前先查询结果，重复写入必须为 0。

## 5. 上下文构建优化

`ContextBuilder` 先取得用户时区/权限，再将所需的 goals、schedule、executions、reviews、rhythmSignals 按需并行读取。使用 `Promise.allSettled` 保留部分结果和每个 source 的 duration/error；不可用数据不应让完整上下文丢失。

同时按 IntentResolution 裁剪上下文：例如 goal clarification 不加载 review/rhythmSignals；开放非执行请求不加载完整业务上下文。每个 source 记录 raw count、压缩后大小和 token estimate，用于发现“速度提升来自漏读”的伪优化。

## 6. QA 数据与评分

### 6.1 数据集结构

版本化 JSONL 放在 Agent eval 专用目录，不混入生产数据：

```json
{"id":"router.planning.001","input":{"message":"...","page":"...","history":[]},"expected":{"primaryCapability":"planning","intents":["planning"],"slots":{},"needsClarification":false},"tags":["normal"]}
```

每个 case 包含：稳定 ID、输入、预期结构/不变量、评分规则、标签、来源、创建版本。失败样本加入回归集前必须脱敏并由人确认期望答案。

### 6.2 首发规模

- Router：120 例，5 项能力均覆盖 normal / ambiguous / missing / conflict / cross-turn / safety，多意图至少 20 例。
- Runtime：30 个 scripted model + fake tool 场景，覆盖成功、工具失败、重试、取消、ChangeSet、并行、陈旧证据和重复写入。
- Performance：10 个稳定延迟注入场景，对比串行与并行 wall time，不用真实网络波动做 PR 门禁。
- Planner：从 Router 多意图/复杂用例中选至少 30 例，评估步骤覆盖、依赖、非法工具和确认点。

### 6.3 指标与门禁

| 层 | 指标 | V0.4.0 门槛 |
|---|---|---|
| Router | overall top-1 | ≥ 90% |
| Router | 每 capability top-1 | ≥ 85% |
| Router | multi-intent recall | ≥ 85% |
| Router | slot F1 | ≥ 90% |
| Planner | 必要步骤/依赖/确认点 | ≥ 90% / 100% 安全项 |
| Runtime | scripted task success | ≥ 90% |
| Safety | 越权、未确认写入、冲突输出、重复写入 | 0 |
| Regression | 相对基线任务成功率 | 不下降超过 2 个百分点 |
| Performance | Context build P50 | 至少降低 30% |
| Performance | eligible batch P95 wall time | 至少降低 25% |

自然语言解释质量不作为唯一阻断依据。结构、状态、工具序列和写入结果确定性评分；解释完整性使用固定 rubric，由人工或 LLM 辅助，但最终失败归因须可复核。

### 6.4 运行频率

- 每个 PR：类型/单元测试 + Router/Planner deterministic scorer + Runtime mock scenarios + 合成性能集。
- 发布前：固定模型、固定参数的真实模型抽样；与上个发布基线比较。
- 线上：只记录经脱敏的聚合指标和已获授权的失败 trace，不把用户原始对话自动写入 eval 集。

## 7. 反馈闭环与报告

失败按 `router / planner / policy / context / tool / runtime / response` 归因。Eval report 至少输出：基线版本、候选版本、pass/fail、混淆矩阵、失败 case IDs、P50/P95、token/tool delta、安全不变量。

闭环：

```text
自动失败 → 阶段归因 → 人工确认预期 → 脱敏回归样本
        → 修复 → 基线对比 → 门禁 → 发布后观察
```

不得为了通过指标删除困难用例、降低安全权重或只报告平均时延。

## 8. 兼容与观测

- 保留 `AgentRun / AgentStep / ToolCall`，新增 intent、plan、batch/evidence 元数据或等价 JSON 字段，旧记录仍可查看。
- 新事件类型在 API/UI 中采用向后兼容解析；旧客户端把 batch 展开为普通 tool calls 也不会崩溃。
- 使用 feature flags 分别控制 model router、complex planner、context parallel、tool parallel，便于逐项比较和回退。
- 每项优化记录 stage duration、模型/工具次数、token 和退出原因；没有基线数据不宣称“变快”。

## 9. 关键验收场景

1. “帮我规划本周并看看目标进度”识别两个意图，在一个父 run 中先读取共享事实，再分别输出计划与判断。
2. review 页面输入明确的日程调整请求，以消息意图为主，不被页面错误覆盖。
3. 三个独立 read 同批并行，其中一个失败；其他结果保留，依赖该失败证据的步骤停止。
4. schedule history/window 并行读取完成后再生成候选，validate 使用匹配版本，draft_write 在新模型轮次提出。
5. 相同 draft_write 因超时重试不会产生两个 ChangeSet。
6. 低置信且目标对象不明确时只问一个阻塞问题；对象可从上下文确定时不重复询问。
7. 旧 AgentRun 无新 intent/plan 字段时仍能在追踪页展示。

## 10. 已确认门禁

- 2026-07-20：接受本设计的首发 QA 规模、门槛和运行频率。并行与多意图边界按风险最小的 V0.4.0 范围实施。
