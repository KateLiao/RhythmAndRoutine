# V0.4.0 Agent 能力、评测与效率现状研究

## 1. 当前能力矩阵

能力定义来自 `src/agent/types.ts`、`src/agent/capabilities.ts`、`src/agent/context-builder.ts` 与 `src/agent/tool-registry.ts`。

| Capability | 主要目标 | 上下文 | 允许工具 | 步数 / Token | 正式写入边界 |
|---|---|---|---|---|---|
| `goal_clarification` | 检查成功标准、范围、投入与约束，只问关键缺口 | goals | read_goal_context | 6 / 24k | 无直接写入 |
| `planning` | 生成 Goal/Outcome/Milestone/Task/Routine 规划树 | goals, schedule | 4 个读取/校验工具 + propose_planning | 12 / 64k | ChangeSet 待确认 |
| `review` | 基于执行与反馈形成回顾，不替用户判定成果 | schedule, executions, reviews, rhythmSignals | 4 个读取工具 + propose_change_set | 10 / 48k | ChangeSet 待确认；产品另有确定性 Review 工作流 |
| `adjustment` | 区分个人日程、目标日程与 Routine，调整安排 | 全部上下文 | 6 个读取/校验工具 + propose_change_set | 12 / 64k | ChangeSet 待确认 |
| `progress_evaluation` | 给出轨道、延迟、阻塞、需调整或待确认建议 | goals, executions, reviews, rhythmSignals | 4 个只读工具 | 8 / 32k | 不直接确认 Milestone/Outcome |

工具共 9 个：6 个业务读取/校验、1 个历史查询、2 个草案写入。工具风险只有 read / draft_write / system；正式业务写入通过 ChangeSet 决策流程执行。

## 2. 意图识别现状

- `src/agent/infer-capability.ts:8-36` 仅使用中文关键词正则、当前页面和默认兜底分类。
- 优先级固定为 review → routine/adjustment → progress → planning → clarification → adjustment。
- 所有无法识别的请求都落到 `adjustment`。
- 多意图请求只返回一个 capability；没有置信度、候选意图、必要参数、拆解计划或需要澄清的结构化中间结果。
- 当前没有针对 `inferCapability` 的单元测试或版本化意图测试集。
- 典型风险：
  - “帮我规划本周并看看目标进度”会丢失一个意图；
  - “把目标拆清楚”可能被 planning/clarification 的关键词顺序误分类；
  - 在 review 页面发送日程调整请求会因页面优先被强制判为 review；
  - 与目标无关的开放问答默认进入 adjustment，装载大量无用上下文。

## 3. 任务拆解现状

- Agent Loop 有 `goalStatus / nextAction / missingInformation / toolAttemptCount` 等审计字段，但初始 planning step 只是固定叙述，不是模型产出的结构化任务计划（`src/agent/runtime.ts`）。
- 模型可以连续调用工具，但系统没有显式 DAG、依赖边、并行组、确认屏障或完成条件清单。
- 任务拆解质量目前只能从最终回复、工具序列和 ChangeSet 反推，难以自动评分。
- planning capability 的 `planningDraftSchema` 能约束最终规划树，但不评价拆解是否遗漏、冗余、顺序错误或与用户意图不一致。

## 4. QA 与可观测性现状

### 已有基础

- `AgentRun` 持久化 capability、provider/model、maxSteps/maxTokens、exitReason、goalStatus、retryCount、错误和起止时间。
- `AgentStep` 持久化轮次、决策、token、duration 与工具尝试数。
- `ToolCall` 持久化工具名、风险、输入输出、结果、错误和 duration。
- 现有测试覆盖日程规划守卫、相似历史查询 planner、工具证据压缩、Agent 日程分析和 UI 呈现。
- v0.3 QA 文档是人工验收矩阵，但不是可复用的 Agent 能力基准集。

### 缺口

- 没有 `EvalCase / EvalRun / EvalResult` 或文件化 golden dataset 契约。
- 没有意图混淆矩阵、参数提取准确率、拆解评分或端到端任务成功率。
- 没有稳定的 mock model / scripted model 场景来重放多轮工具调用与失败恢复。
- package scripts 没有统一 `test` / `test:agent-evals` 门禁；Agent 相关测试分散。
- 没有优化前后的 P50/P95 首包、上下文构建、模型等待、工具执行和总时延对比。

## 5. 执行速度与并行现状

### 已确认的串行点

- `ContextBuilder.build` 在读取 user 后，按 goals → schedule → executions → reviews → rhythmSignals 顺序逐个 await；除依赖 user timezone 的实现细节外，这些业务数据基本互不依赖。
- 模型一轮返回多个 tool_call 时，OpenAI adapter 会在流结束后逐个 emit；`AgentRuntime` 收到每个事件后立即 `await executeTool`，因此工具按顺序执行。
- 每个工具都完成后才产生下一轮模型请求。

### 已有可并行范例

- `PrismaContextSource.getExecutionHistory` 已用 `Promise.all` 同时查询普通日程执行与 Routine 执行。

### 推荐并行边界

- 可并行：无依赖的只读上下文查询；模型同一批产生且输入独立的 read 工具；同一时间窗的多个独立候选读取。
- 必须串行：`read_similar_schedule_history → read_schedule_window → validate_schedule_candidates → propose_change_set`；任何依赖前一步输出的调用；draft_write；共享可变资源；用户确认屏障。
- 同批调用若含写工具，建议整批按依赖分析后分层执行，不得简单 `Promise.all`。

## 6. 推荐 QA 体系

### 6.1 三层评测

1. **Router Eval（确定性）**：输入 prompt/page/history，输出 capability、secondary intents、confidence、required slots、clarification need。
2. **Planner Eval（模型或规则）**：输出步骤、依赖、parallelGroup、tool、successCondition、confirmationBoundary。
3. **Runtime Scenario Eval（脚本化）**：用 mock model + fake tools 重放成功、缺参、工具失败、重试、冲突、ChangeSet、取消与并行。

### 6.2 指标

- 意图：top-1 accuracy、multi-intent recall、clarification precision/recall、slot F1。
- 拆解：必要步骤覆盖率、非法/冗余步骤率、依赖正确率、确认边界合规率。
- 执行：任务成功率、工具选择准确率、重试恢复率、重复写入率（必须为 0）。
- 效率：TTFT、context build、model time、tool wall time、end-to-end 的 P50/P95；tool calls、input/output tokens。
- 安全：越权写入率、未确认正式写入率、冲突日程输出率（均必须为 0）。

### 6.3 反馈闭环

`失败用例 → 自动归因到 router/planner/tool/runtime/policy → 人工确认 → 加入版本化回归集 → 修复 → 与基线比较 → 门禁`

首版不建议让 LLM judge 单独决定是否通过。结构化字段、工具序列、状态和 ChangeSet 可确定性评分；只有自然语言解释质量使用带 rubric 的人工或 LLM 辅助评审。

## 7. 主要技术风险

- 仅靠增加 Prompt 很难稳定提升路由准确率，且无法形成可回归证据。
- 并行执行会改变工具事件顺序；UI、审计序列、toolCallId 和模型工具消息必须保持一一对应。
- OpenAI tool protocol 要求每个 assistant tool call 都有对应 tool message；并行完成可乱序执行，但送回模型时应按原 tool-call 顺序组装。
- 现有 schedule guard 使用成功工具的线性顺序判断先后；引入并行后必须改为显式依赖/证据版本，避免仅靠数组 index 推断。
- 真实模型评测有成本与波动，必须同时保留确定性 mock 门禁和低频真实模型基准。

## 8. 设计收敛

- 首发采用“PR 确定性离线集 + 发布前真实模型抽样 + 失败样本人工复核”；具体规模与门槛留到最终确认。
- 支持多意图识别与单父运行内的有序拆解，不建设通用多 Agent 编排平台。
- 并行首发限定为独立上下文读取和同批只读工具；draft_write、正式写入和依赖前序输出的工具保持串行。
