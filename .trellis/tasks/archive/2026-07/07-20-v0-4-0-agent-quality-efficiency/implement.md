# V0.4.0 Agent 能力评测与效率实施计划

> 当前仅完成实施设计。未获得实现批准前不修改 Agent 运行时代码。

## 1. Phase A：先建立基线，不先改算法

### 工作

1. 固化 `research/capability-matrix.md`，为 5 项 capability 与 9 个工具建立机器可读元数据。
2. 新建 eval JSONL schema、loader、deterministic scorer 和报告格式。
3. 补齐 Router 120、Planner 30、Runtime 30、Performance 10 个首发 case；用当前实现跑 baseline，保留失败而不是修饰结果。
4. 从 `AgentRun / AgentStep / ToolCall` 提取分阶段时延、token、工具次数和退出原因。

### 验证/回滚

- 数据集 ID 唯一、schema 校验、tag/能力覆盖检查通过。
- baseline 可重复运行并生成同结构报告。
- 本阶段只加评测与读取逻辑，不改变线上行为，可直接停用。

## 2. Phase B：结构化 Intent Resolver

### 工作

1. 为当前规则路由增加 `IntentResolution` 适配层和可观测 confidence/slots/missingSlots。
2. 保留高置信 fast path；加入结构化模型 router 处理模糊、多意图和跨轮修正。
3. 明确 message > page 的优先规则、degraded 回退与 unsupported 非执行路径。
4. 在不改变原 capability 配置的前提下灰度记录 shadow resolution，与当前结果比较。

### 验证/门禁

- Router 指标达到 overall ≥90%、每能力 ≥85%、multi-intent recall ≥85%、slot F1 ≥90%。
- 所有 safety/confirmation cases 通过；模型 router 失败可回退。
- 先 shadow、后小流量启用；flag 关闭即可恢复原路由。

## 3. Phase C：复杂请求 ExecutionPlan

### 工作

1. 为多意图/复杂请求生成结构化 plan；简单请求保持 fast path。
2. 实现 DAG、allowlist、access、确认点、success condition 和失败策略校验。
3. 在一个父 AgentRun 中记录 intent/plan/step 关联；不引入通用子 Agent。
4. 用一次受约束修复处理无效计划，失败后停止并解释。

### 验证/回滚

- cyclic/missing dependency/illegal tool/parallel write/confirmation missing 均被拒绝。
- Planner 必要步骤覆盖 ≥90%，所有安全项 100%。
- flag 关闭后复杂请求回到原 loop，不改变持久业务数据。

## 4. Phase D：上下文按需与并行

### 工作

1. ContextBuilder 在用户权限/时区后对独立 source 使用 `Promise.allSettled`。
2. 按 intent/capability 只加载必要 source，并记录每个 source 的 duration/count/size/error。
3. 将部分失败传入 prompt/trace，区分必需与可选上下文。

### 验证/门禁

- 所有 capability 的上下文完整性快照不丢必需字段。
- 单 source 失败不会清空其他结果；必需证据缺失不会继续危险步骤。
- 合成场景 context P50 至少降低 30%，任务成功率下降不超过 2 个百分点。
- 独立 feature flag 可回退串行构建。

## 5. Phase E：同批只读工具并行

### 工作

1. 增加 ToolExecutionPolicy、resourceKeys 和显式 evidence version。
2. Adapter 发出 batch 事件；Scheduler 最大并发 3，仅调度无依赖 read。
3. 结果按 toolCallId 审计、按原调用顺序返回模型；UI 兼容完成乱序。
4. read+draft_write 混批时只执行 reads，要求新模型轮次重新提出写草案。
5. 将 schedule 的线性 lastIndex guard 改为显式证据校验。

### 验证/门禁

- 顺序协议、部分失败、超时、取消、依赖阻断、混合风险 batch 均有 runtime scenario。
- draft_write 永不并行；重复写入为 0；未确认正式写入为 0。
- eligible batch P95 wall time 至少降低 25%，无安全或成功率回归。
- 运行时 flag 可恢复串行执行；事件/记录格式保持可读。

## 6. Phase F：反馈闭环与发布门禁

### 工作

1. 增加 baseline/candidate 对比、混淆矩阵、失败归因和性能报告。
2. 将确定性 eval 接入 PR 质量门禁；真实模型抽样放在发布前流程。
3. 定义失败样本脱敏、人工确认、回归集新增和版本升级流程。
4. 在 Agent trace UI 展示 intent、plan、parallel batch、degraded source 与确认屏障。

### 验证/回滚

- 报告能从失败 case 定位到 router/planner/policy/context/tool/runtime/response。
- 旧 AgentRun/客户端兼容；关闭新 UI 字段不影响执行。
- 只有稳定、可复现、安全不变量全通过的改动允许作为 V0.4.0 发布候选。

## 7. 推荐变更集

1. Eval infrastructure + baseline dataset。
2. IntentResolution + shadow router。
3. ExecutionPlan + validator。
4. ContextBuilder parallel/partial results。
5. Tool batch protocol + scheduler + evidence guard。
6. QA gate + trace UI + release report。

每个变更集独立开关、独立基准和独立回滚。不要在同一个变更集中同时切换 router、planner 和 tool scheduler，否则准确率或时延变化难以归因。

## 8. 完成定义

- 能力矩阵与真实代码一致，新增能力有对应实现与测试证据。
- 固定集达到设计门槛，安全不变量 100%，重复写入 0。
- 性能改善按 P50/P95 和端到端成功率共同证明，不只报告平均值。
- 意图、计划、依赖、批次和失败均可从单次 AgentRun 追踪。
- 线上旧记录、ChangeSet 确认和手动业务路径不受影响。
