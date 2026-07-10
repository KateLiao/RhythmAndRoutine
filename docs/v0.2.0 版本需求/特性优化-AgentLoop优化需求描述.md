# Agent Loop 优化需求描述

> 版本：v0.2.0
> 状态：已澄清，可进入开发拆解
> 更新日期：2026-06-25

## 1. 背景与问题

当前小律已经具备 Agent Runtime、工具白名单、上下文构建、工具调用、ChangeSet 审批暂停、Run/Step/ToolCall 追踪等基础能力，但现有 Loop 的核心结束条件仍偏向“模型不再调用工具即完成”。工具返回后，Runtime 没有显式记录本轮工具结果是否符合预期、用户目标是否真正达成、下一步为何继续或为何停止。

这会导致以下问题：

1. Agent 行为难以调试：只能看到工具调用过程，无法看到每轮判断依据。
2. Agent 容易过早结束：工具执行完成不等于用户目标达成。
3. 工具失败后的策略不稳定：缺少统一的重试、换工具、追问和停止规则。
4. 退出原因不可追溯：后续难以按失败原因、追问原因、预算耗尽等维度查询 Run。

本需求目标是将小律从“单轮工具调用 + 自然结束”升级为“目标驱动的循环执行”。Agent 每轮执行后都必须显式判断：当前目标是什么、工具结果说明了什么、距离目标达成还缺什么、下一步应该继续执行、调整策略、追问用户、等待确认，还是结束。

## 2. Agent 与固定 LLM 工作流边界

Agent Loop 只适用于“小律作为 Agent 自主选择工具、判断下一步动作”的功能。

必须遵循 Agent Loop 的功能包括：

- 目标澄清
- 目标拆解计划
- 计划调整
- 行程变动
- 进度评估
- 其他未来新增的、由小律自主读取上下文并决定工具链路的 Agent 功能

不纳入 Agent Loop 的功能包括：

- 日回顾、周回顾的固定生成流程
- 任务完成总结
- Rhythm Signal 提取
- 其他输入输出明确、步骤固定、无需模型自主选择工具的 LLM-as-a-function 能力

这类固定流程应继续作为显式 workflow 或服务函数实现，可以使用结构化输出和规则降级，但不应强行套用 Agent Loop。

## 3. 设计目标

1. Agent 的终止条件从“工具执行完成”改为“用户目标达成或无法继续推进”。
2. 每轮 Loop 都必须产生可追踪的结构化决策结果和面向人类的简短解释。
3. 工具执行结果必须被验证，失败时根据失败原因选择重试、换工具、追问或停止。
4. Agent 因信息不足无法继续时，必须先从上下文和对话中自行推断所需参数；推断后仍缺关键字段时，才向用户追问。
5. 写操作仍必须进入 ChangeSet。生成待确认草案本身即视为 Agent 目标达成，正式应用草案属于用户确认后的系统行为，不属于 Agent 自主完成范围。
6. Debug 优先于轻量展示。v0.2.0 应尽量展示细节，后续在 Agent 行为稳定后再做面向普通用户的轻量化。
7. Run 必须记录结构化退出原因，方便后续追溯查询。

## 4. Loop 核心流程

每次 Agent Run 应按以下流程执行：

```text
构建上下文
  -> 理解用户目标
  -> 制定当前轮计划
  -> 调用工具或直接回答
  -> 获取工具结果
  -> 验证工具结果
  -> 判断目标状态
  -> 决定下一步动作
      -> 继续调用工具
      -> 调整策略后继续
      -> 向用户追问
      -> 创建 ChangeSet 并等待确认
      -> 输出最终结果并结束
      -> 因预算/错误/无法推进而停止
  -> 重复直到完成或停止
```

每轮 Loop 的核心问题：

- 当前用户目标是什么？
- 本轮尝试完成什么子目标？
- 工具结果是否成功、可信、足够？
- 当前目标是否已经达成？
- 如果未达成，还缺少哪些信息或动作？
- 下一步最合理的动作是什么？
- 是否应该继续执行？

## 5. 结构化状态与自然语言说明

目标状态、下一步动作、退出原因应使用结构化字段存储；判断依据、失败过程和给用户的解释使用自然语言存储。

原因：

1. 结构化字段便于查询、统计、调试和 UI 过滤。
2. 自然语言便于回看当时的业务判断。
3. 当前系统已经有 `AgentRun`、`AgentStep`、`ToolCall`，适合继续扩展 trace，而不是把所有判断埋在最终回复里。

建议新增或等价支持以下结构：

```ts
type LoopGoalStatus =
  | "achieved"
  | "needs_more_action"
  | "needs_user_input"
  | "awaiting_confirmation"
  | "blocked";

type LoopNextAction =
  | "call_tool"
  | "retry_tool"
  | "switch_tool"
  | "ask_user"
  | "propose_change_set"
  | "final_answer"
  | "stop";

type AgentExitReason =
  | "goal_achieved"
  | "awaiting_user_confirmation"
  | "awaiting_user_input"
  | "blocked_by_missing_information"
  | "blocked_by_tool_error"
  | "stopped_by_max_steps"
  | "stopped_by_max_retries"
  | "stopped_by_token_budget"
  | "stopped_by_time_budget"
  | "cancelled_by_user"
  | "runtime_error";
```

每个 Loop Step 至少应记录：

- `sequence`：第几轮
- `kind`：`planning`、`tool`、`verification`、`decision`、`final` 等
- `goalStatus`：本轮目标状态
- `nextAction`：下一步动作
- `reason`：自然语言判断依据
- `missingInformation`：若需要追问，列出缺失字段
- `toolAttemptCount`：当前工具或当前子目标已尝试次数
- `inputTokens` / `outputTokens` / `durationMs`

## 6. 追问规则

当 Agent 因缺少信息而无法执行后续动作完成任务时，必须向用户追问。

但在追问前，Agent 必须先尝试从以下来源推断或提取字段：

1. 当前用户消息
2. 最近对话上下文
3. 当前页面选中实体
4. Context Builder 提供的业务上下文
5. 工具返回的候选对象或时间范围

只有在推断后仍缺少关键字段，且继续调用工具可能产生错误、误读或错误草案时，才追问用户。

必须追问的典型情况：

- 无法确定用户想操作哪个目标、任务、Routine 或日程块。
- 行程变动缺少必要时间信息，且上下文无法合理推断。
- 多个候选对象同样匹配，Agent 无法安全选择。
- 生成计划所需的成功标准、时间范围、投入强度或约束缺失，且缺失会显著影响计划质量。
- 工具参数缺失，且无法从上下文补齐。
- 用户请求包含互相冲突的约束，需要用户取舍。

不应追问的情况：

- 字段可以从当前页面选中实体或近期对话中可靠提取。
- 可以通过读工具先获取候选上下文。
- 缺失信息不影响当前轮继续推进，可以先给出草案并明确假设。
- 写操作会进入 ChangeSet，用户后续可以在确认前检查。

## 7. 工具失败策略

工具失败后，Agent 应根据失败原因自行推理，并在同一 Run 内选择以下策略之一：

1. 换下一个更合适的工具。
2. 因参数不足向用户询问。
3. 修正参数后重新执行工具。

失败处理规则：

- 单个 Run 内最多允许 5 次失败恢复尝试。
- 每次失败恢复尝试都必须记录失败原因、采取的策略和结果。
- 如果失败是参数格式错误，优先根据 schema 错误修正参数并重试。
- 如果失败是缺少业务实体或候选对象不明确，先尝试读取上下文或候选列表；仍不明确再追问。
- 如果失败是工具超时，可以重试一次或缩小查询范围。
- 如果失败是权限、版本冲突、工具不允许或不可重试错误，应停止自动尝试，并在最终回复中解释原因。
- 达到 5 次尝试后停止 Loop，将工具失败原因、已采取动作和停止原因作为输入，让 Agent 生成最后回复。

最终回复必须包含：

- 哪一步失败了。
- Agent 尝试过哪些恢复动作。
- 为什么现在不能继续自动推进。
- 用户下一步可以补充什么或手动做什么。

## 8. ChangeSet 与目标达成

当用户目标是“帮我生成计划草案”“帮我调整安排”“帮我提出变更方案”时，Agent 创建待确认 ChangeSet 即视为目标达成。

原因：

- Agent 的职责是生成草案，而不是直接修改正式计划。
- 正式应用草案是用户确认后的系统行为，不属于 Agent 自主执行范围。
- Run 状态应进入等待确认或完成态，并记录退出原因为 `awaiting_user_confirmation` 或等价结构。

用户拒绝或批准 ChangeSet 后，系统可以更新关联 Run 的最终状态，但这属于审批流程，不应让自由 Agent Loop 继续绕过确认边界。

## 9. UI 调试展示

v0.2.0 应在前端处理过程里展示更完整的 Loop 细节，方便调试 Agent 行为。

需要展示的步骤类型：

- 理解目标
- 读取上下文
- 调用工具
- 验证工具结果
- 判断目标状态
- 决定下一步
- 工具失败恢复
- 等待用户补充信息
- 等待用户确认草案
- 输出最终结果

每个可展开步骤应尽量展示：

- 检查范围
- 工具结果
- 简短判断
- 缺失信息
- 下一步动作
- 失败原因和恢复策略

当前阶段不要求轻量化隐藏这些细节。后续版本可以在 Agent 稳定后，把详细 trace 收进调试模式或历史详情。

### 9.1 底部状态指示器与处理步骤同步

> 已实现，2026-06-25

处理过程卡片内的步骤列表与底部"正在…"状态指示器必须保持一致。具体规则：

- `tool_completed` 事件到达时，状态指示器应切换为"正在验证工具结果…"，不得继续显示已完成工具的"正在…"文案。
- `loop_step` 事件到达时，状态指示器应根据 `kind` 切换：
  - `verification` + `nextAction === "call_tool"`："正在继续分析…"
  - `verification`（其他情况）："正在验证结果…"
  - `decision`："正在判断下一步…"
  - `recovery`："正在尝试修复…"
  - `final`："正在整理结果…"
- Agent Run 结束后，状态指示器清空。

此规则防止底部指示器因状态过时而与卡片中已完成的步骤产生矛盾。

## 10. 持久化与追溯

Run 层应记录：

- `exitReason`
- `goalStatus`
- `retryCount` 或失败恢复尝试次数
- `finalSummary`
- `errorCode` / `errorMessage`

Step 层应记录：

- `kind`
- `goalStatus`
- `nextAction`
- `reason`
- `missingInformation`
- `toolCalls`
- `durationMs`
- `inputTokens`
- `outputTokens`

ToolCall 层应继续记录：

- 工具名
- 风险等级
- 输入
- 输出
- 状态
- 错误码
- 耗时
- 幂等键

如果为了降低迁移成本，也可以先通过 JSON 字段保存 Loop Decision，再在后续版本拆成更严格的列。但 v0.2.0 必须保证退出原因和每轮决策可以被查询和回看。

## 11. 首批验收场景

### 11.1 目标拆解计划

用户请求示例：

```text
帮我把这个目标拆成可执行计划。
```

验收要点：

1. Agent 能读取当前选中 Goal 的上下文。
2. 如果目标成功标准、期限或投入强度缺失，Agent 先从对话和目标字段推断；无法推断时追问。
3. Agent 能生成 Outcome、Milestone、Task、Routine 的结构化规划草案。
4. 生成 `propose_planning` ChangeSet 后，Run 视为目标达成并等待用户确认。
5. 处理过程能看到目标理解、上下文读取、结果验证、目标达成判断和等待确认原因。
6. Run 可以查询到退出原因为 `awaiting_user_confirmation`。

### 11.2 行程变动

用户请求示例：

```text
我明天下午临时有事，帮我把相关安排挪开。
```

验收要点：

1. Agent 能推断或读取“明天下午”的日程窗口。
2. 如果多个日程都可能受影响，Agent 应读取候选日程后判断；仍无法安全选择时追问。
3. Agent 能生成 schedule update/archive/create 类型的 ChangeSet 草案，而不是直接修改正式日程。
4. 如果工具参数不完整或读取失败，Agent 按失败策略重试、换工具或追问。
5. 最多 5 次失败恢复尝试后停止，并在最终回复中说明失败过程和原因。
6. 处理过程能展示工具失败恢复、目标状态判断和下一步决策。
7. Run 可以查询到结构化退出原因。

## 12. 非目标

本需求不包含：

- 让 Agent 绕过 ChangeSet 直接写正式业务数据。
- 为固定 LLM workflow 引入 Agent Loop。
- 引入外部 Agent 框架替换当前自研 Runtime。
- 实现长期自主记忆或跨会话自动行动。
- 对普通用户隐藏调试细节的轻量化 UI。

## 13. 开发提示

当前代码中已有可复用基础：

- `src/agent/runtime.ts`：已有循环外壳、工具执行、审批暂停、预算限制。
- `src/agent/capabilities.ts`：已有各 capability 的工具白名单和预算。
- `src/agent/tool-registry.ts`：已有读工具和 ChangeSet 草案工具。
- `prisma/schema.prisma`：已有 `AgentRun`、`AgentStep`、`ToolCall`。
- `src/components/agent-process-steps.tsx`：已有处理过程展示组件。
- `src/app/api/agent/chat/route.ts`：已有 SSE 事件输出。

开发时应优先在现有 Runtime 上补充 Loop Decision、退出原因和调试事件，而不是推翻现有 Agent Harness。
