# Rhythm & Routine MVP 开发规格

> 状态：开发方向已冻结  
> 决策日期：2026-06-19  
> 上游文档：`design-note.md`、`docs/ui-design-direction.md`、`prototype/`

## 1. MVP 目标

MVP 要验证一条完整、真实、可持续运行的目标推进闭环：

```text
创建目标
  -> 小律澄清目标
  -> 生成规划草案
  -> 用户确认
  -> 安排到内部日历
  -> 用户执行并反馈节奏
  -> 生成日/周回顾
  -> 小律提出调整草案
  -> 用户确认后更新计划
```

首版服务单个种子用户，但所有核心业务数据保留 `userId`，避免未来增加账号体系时重构数据所有权。

## 2. MVP 范围

### 2.1 必须实现

1. 目标、结果指标、里程碑、任务和 Routine 的创建、查看、编辑、归档与删除。
2. 小律通过对话澄清目标，并生成结构化规划草案。
3. 用户逐项或整体确认规划草案后写入正式业务数据。
4. 内部日历的日、周、月视图。
5. 日程块的手动创建、编辑、移动、改期、取消和删除。
6. Task 与 Routine 安排为日程块。
7. 日程块执行结果、实际耗时、偏差原因和 Rhythm Feedback 的记录与手动修正。
8. 日回顾、周回顾的手动生成与定时生成。
9. 小律根据执行记录提出计划调整，并展示变更前后差异。
10. 用户确认后才执行小律建议的正式写操作。
11. 所有关键 AI Run、Step、Tool Call、Token Usage、错误和耗时可追踪。
12. 首次使用、空状态、加载、失败、重试和 AI 降级状态。
13. 基础设置：时区、日回顾时间、周回顾时间、默认模型。

手动操作是系统可用性的兜底边界。任何由 AI 创建或调整的核心对象，都必须有对应的手动创建、编辑和纠错能力。

### 2.2 MVP 不做

- Google Calendar、Apple Calendar 或其他外部日历同步。
- 多用户协作、团队空间和权限体系。
- 外部 Agent Skill、Hermes、OpenClaw 集成验证。
- 复杂 RAG、向量数据库和自主长期记忆。
- 多个可被用户感知的 Agent。
- Agent 未经用户确认直接修改正式计划。
- 主题切换、成就体系和复杂游戏化。
- 移动端原生应用。

## 3. 实体裁剪

### 3.1 独立业务实体

| 实体 | MVP 职责 |
| --- | --- |
| User | 数据所有者、时区与偏好；MVP 只有一个本地用户 |
| Goal | 长期方向和承诺 |
| Outcome | 用户确认的目标结果指标 |
| Milestone | 可由用户确认完成的阶段节点 |
| Task | 一次性、可执行、可验收的行动 |
| Routine | 与目标关联的重复行动规则 |
| ScheduleBlock | 内部日历中的计划时间块 |
| ExecutionRecord | 日程块的实际执行结果 |
| RhythmFeedback | 对单次执行体验的轻量反馈 |
| Review | 日、周或阶段回顾及调整建议 |

### 3.2 简化实体

- Project、Skill 在 MVP 中作为 Goal 的分类和结构化属性，不建立独立管理页面。
- Rhythm Signal 由 Agent 从执行记录、反馈和回顾中提取并持久化，但不提供独立 CRUD 页面。
- Agent Adjustment Suggestion 归入 ChangeSet，不直接写入正式业务表。

## 4. 核心状态

状态值以代码中的 schema 为最终契约，数据库保存稳定英文枚举，界面负责中文展示。

```text
GoalStatus:
draft | active | paused | completed | archived

MilestoneStatus:
pending | ready_for_review | completed | rejected | archived

TaskStatus:
draft | ready | scheduled | in_progress | completed | blocked | cancelled | archived

RoutineStatus:
draft | active | paused | completed | archived

ScheduleBlockStatus:
planned | in_progress | completed | missed | rescheduled | cancelled

ReviewStatus:
generating | draft | awaiting_confirmation | confirmed | failed

AgentRunStatus:
queued | running | awaiting_confirmation | completed | failed | cancelled

ChangeSetStatus:
draft | awaiting_confirmation | approved | rejected | applied | failed
```

规则：

- Task 和 ScheduleBlock 可以由执行行为更新状态，但两者的“完成”含义不同：ScheduleBlock 完成只代表一次投入会话已结束，Task 完成必须由用户在完成标准区主动确认。
- `aggregateTaskStatus`（`src/server/services/schedule.ts`）据关联 ScheduleBlock 状态聚合 Task 的非终态（`ready` / `scheduled` / `in_progress` / `blocked`），**禁止**写入 `completed`；已是 `completed` / `cancelled` / `archived` 的 Task 不会被块状态变化打回。`estimatedMinutes` 只作为「建议确认完成」信号（`isReadyForCompletionSuggest`：累计真实投入达到预计时长，或已无剩余计划块且存在完成投入）的参考阈值，不触发自动完成。
- Task 由用户在完成标准区主动「确认完成」；服务端汇总关联 ScheduleBlock 的真实投入与 ExecutionRecord，调用 `review` capability 生成两段式总结（`executionSummary` + `overallEvaluation`），写入 `Task.completionRecord`（JSON），并将 `status` 置为 `completed`。AI 不可用时使用规则模板兜底。这是 Task 状态变为 `completed` 的唯一入口。
- Outcome 和 Milestone 只能由用户确认完成。
- 删除优先采用软删除或归档；有关联执行历史的对象不可物理级联删除。
- ScheduleBlock 改期时保留原计划与变更原因，避免丢失节奏分析依据。

### 4.1 Goal 与 Routine 字段契约

- Goal 保存长期方向。`category` 表达目标类型，`project`、`skill` 是 MVP 阶段的结构化属性，`targetDate` 表达目标期限；这些值不得拼接进 `description`。
- Outcome 单独表达“怎样算成功”，不应塞进 Goal 描述。
- Routine 保存重复规则，不预生成未来任务。`startDate` / `endDate` 表达有效期，`recurrenceRule` 表达重复日期，`preferredStartTime` / `preferredEndTime` 表达建议时间窗，`durationMinutes` 表达一次执行的预计时长。
- `description` 只说明为什么值得保持；`minimumVersion` 只描述状态不佳时仍可执行的退阶动作，例如“只练 5 分钟”。时间段、频率和有效期不得写入这两个字段。
- Routine 在查询日历范围时动态产生虚拟发生实例；只有执行、跳过或改期后才持久化对应的执行记录。
- Routine 页面右侧详情提供有效期与开启状态快捷操作：用户可直接修改 `startDate` / `endDate`，并在 `active` 与 `paused` 间切换。保存后重新读取当前日历窗口，关闭或缩短有效期会删除/隐藏未来未发生的 planned Routine 实例；重新开启后按 Routine Definition 重新展开后续实例。已有执行记录不因缩短有效期或暂停而删除。

## 5. 技术方案

### 5.1 应用栈

- Next.js + TypeScript，采用 App Router。
- PostgreSQL 作为业务数据库。
- Prisma 负责 schema、迁移和类型安全的数据访问。
- Zod 作为表单、API、工具参数和 AI 结构化输出的共同校验层。
- Tailwind CSS 与 design tokens 实现 Soft Humanist 视觉系统。
- Vercel 作为首选部署平台。
- 定时任务触发日回顾和周回顾；执行逻辑必须幂等（幂等键 `${userId}:${type}:${periodStart}:${periodEnd}`），手动触发与定时触发共用同一服务（`generateReview`）。默认日回顾时间与周回顾时间均为用户时区 `23:00`（周回顾默认周日），用户可在设置中调整。回顾页在新周期生成前展示上一份回顾（「昨日回顾」/「上周回顾」语义）。
- 日回顾聚焦当日执行与感受的「收尾评估」，周回顾聚焦节奏与目标校准；两者共用同一份增强输出 schema（`summary`/`findings`/`suggestions`/`source` 必填，`sessionHighlights`/`rhythmNotes`/`taskProgressNotes`/`routineNotes`/`goalCheckSuggestions`/`nextCycleSuggestions` 为可选区块），日回顾通常只填前者，周回顾按需填充后者。周回顾的 LLM 输入在服务端做确定性压缩（数字先算好、日回顾 findings 作先验、用户 note 与异常优先摘录、普通完成块只进聚合计数），不会把整周逐条日程原文传给模型。回顾正文中的「建议检查/建议确认」措辞不代表 Task、Milestone 或 Outcome 已完成，最终确认动作仍分别走 Task 完成、Milestone/Outcome 确认的既有接口。
- 默认时区为 `Asia/Shanghai`，时间存储使用 UTC，展示与调度使用用户时区。

### 5.2 账号边界

MVP 不实现正式登录，但不使用无归属的全局数据。初始化时创建本地种子用户，所有业务查询必须携带 `userId`。未来增加认证时，只替换用户身份解析层。

## 6. Agent Harness 架构

### 6.1 设计原则

1. 业务规则不依赖具体模型或 Agent 框架。
2. 模型只能通过注册工具读取或提出业务变更，不能绕过服务层直接访问数据库。
3. 所有模型输出在进入业务层前必须通过 Zod 校验。
4. Agent Run 必须可观测、可取消、可恢复、可重试。
5. 写操作默认进入 ChangeSet；需要确认时暂停 Run，不能只依赖前端弹窗维持状态。
6. Context Builder 只装配当前任务需要的数据，避免把整个用户数据库塞入 prompt。
7. Loop 必须有最大步数、最大 Token、最大耗时和工具调用白名单。
8. 确定性流程优先使用显式 workflow；只有需要动态判断工具的部分进入 agent loop。

### 6.2 分层

```text
UI / Scheduled Job
  -> Agent Application Service
      -> Capability Router
      -> Context Builder
      -> Agent Runtime
          -> Model Adapter
          -> Tool Registry
          -> Loop Controller
          -> Policy / Approval Gate
          -> Run Store / Trace Store
      -> Domain Services
      -> PostgreSQL
```

#### Agent Application Service

接收用户或定时任务请求，创建 AgentRun，选择 Capability，并负责流式事件输出、取消、恢复和最终结果持久化。

#### Capability Router

首版注册五类 Capability：

- `goal_clarification`
- `planning`
- `review`
- `adjustment`
- `progress_evaluation`

Capability 是配置与策略的组合，不必各自启动一个 Agent 实例。它定义允许读取的上下文、可用工具、输出 schema、停止条件和是否需要确认。

#### Context Builder

通过组合式 loader 构建版本化 `AgentContext`：

```text
identity + current_page + conversation_summary + selected_entity
+ relevant_goals + relevant_tasks + schedule_window
+ execution_history + rhythm_signals + latest_reviews
+ user_preferences + pending_changes
```

Context Builder 必须记录本次 Run 使用了哪些数据及其版本。默认按关联关系、时间窗口和条数预算裁剪；自然语言对话只保留近期消息与摘要。

#### Model Adapter

应用层只识别逻辑模型配置，不直接依赖供应商 SDK：

```ts
interface ModelAdapter {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
  generateObject<T>(request: StructuredRequest<T>): Promise<ModelResult<T>>;
}
```

首版配置 Qwen、DeepSeek V4 Pro、MiniMax 2.7。具体供应商 model ID、endpoint 和凭证通过环境配置注册，不写死在业务代码中。默认模型、Capability 模型和降级模型可以分别配置。

模型切换不改变 Tool、Context、Run、ChangeSet 和领域服务接口。

#### Tool Registry

工具按读写风险分级：

- Read：读取目标、任务、Routine、日程、执行记录、回顾和节奏信号。
- Draft Write：创建 ChangeSet，描述拟新增、修改、移动或归档的对象。
- Confirmed Write：只接受已批准 ChangeSet，由服务端执行，不直接暴露给自由 Agent Loop。
- System：获取当前时间、预算、Run 状态等受控能力。

每个工具必须包含 Zod 输入输出、权限检查、幂等键、超时、审计事件和对模型友好的错误结果。

#### Loop Controller

```text
build context
  -> call model
  -> validate event
  -> if tool call: policy check -> execute -> append result -> continue
  -> if proposed write: create ChangeSet -> suspend for confirmation
  -> if final answer: persist result -> complete
  -> if budget/error exceeded: fail safely with retryable state
```

默认限制：最大 12 个模型步骤、单工具调用 15 秒、Run 总时长 90 秒。具体数值后续通过真实 Trace 调整。

#### Approval Gate 与 ChangeSet

ChangeSet 保存：变更原因、目标对象、before/after、依赖的数据版本、风险级别及用户决策。

用户批准后，系统重新校验对象版本：

- 数据未变化：事务性应用变更。
- 数据已变化：不覆盖新数据，提示重新生成或人工合并。

这样可以保证 AI 建议到用户确认之间即使发生手动编辑，也不会静默覆盖。

#### Run Store 与 Trace

最少持久化：

- AgentRun：触发来源、Capability、模型、状态、预算、开始结束时间。
- AgentStep：输入摘要、输出类型、顺序、耗时。
- ToolCall：工具、参数摘要、结果摘要、错误和耗时。
- TokenUsage：输入、输出和估算成本。
- ContextManifest：实际装配的数据引用和版本。
- ChangeSet：暂停、确认和正式应用的完整轨迹。

敏感正文与可观测日志分离，日志默认不保存完整 prompt、密钥或无关用户内容。

### 6.3 框架边界与调研结论

参考项目：

- [LangGraph.js](https://github.com/langchain-ai/langgraphjs)：低层、可控、状态化编排，强调 durable execution、memory 和 human-in-the-loop。
- [Vercel AI SDK](https://github.com/vercel/ai)：TypeScript provider abstraction、结构化输出、ToolLoopAgent 和前端流式 UI 集成。
- [Mastra](https://github.com/mastra-ai/mastra)：Agent/Workflow 分层、模型路由、持久化 suspend-resume 和可观测性。
- [OpenAI Agents SDK JS](https://github.com/openai/openai-agents-js)：工具、guardrail、session、human-in-the-loop 和 tracing 的轻量组合。

MVP 不直接把领域架构建立在某个完整 Agent 框架的私有类型上。优先采用自有 Harness 接口，并用 AI SDK 或供应商兼容适配器解决多模型流式调用与结构化工具调用。若实现中发现 durable resume、interrupt 或复杂 workflow 的维护成本过高，可在 Agent Runtime 内部引入 LangGraph 或 Mastra，领域服务与上层 UI 不受影响。

## 7. AI 失败与降级

- AI 不可用时，目标、任务、Routine、内部日历、执行反馈和回顾编辑仍可手动使用。
- 结构化输出校验失败时允许有限次数的自动修复重试，仍失败则保留 Run 和错误信息。
- 定时 Review 失败不重复创建数据；用户可在界面手动重试。
- 模型失败可按配置切换降级模型，但切换必须写入 Trace。
- 工具局部失败不能伪装成成功；Agent 最终答复必须明确未执行的变更。

## 8. MVP 验收 Checklist

### 8.1 核心闭环

- [x] 用户可以手动创建并编辑 Goal、Outcome、Milestone、Task 和 Routine。
- [x] 用户输入模糊目标后，小律能够追问缺失信息。
- [x] 小律能够生成符合 schema 的目标规划草案。
- [x] 未经确认，规划草案不会进入正式业务数据。
- [x] 确认后，规划内容可在目标详情中继续手动编辑。
- [x] Task 和 Routine 可以手动安排到内部日历。
- [x] 用户可以移动、改期、取消和删除日程块。
- [x] 用户可以记录完成、未完成、改期、实际耗时、原因和 Rhythm Feedback。
- [x] 用户可以修正此前填写的执行记录。
- [x] 系统可以基于一周真实数据生成周回顾。
- [x] 小律能够提出含 before/after 的调整 ChangeSet。
- [x] 拒绝 ChangeSet 不改变正式计划；批准后才应用。
- [x] Milestone 和 Outcome 只能由用户确认完成。
- [x] 任务详情「完成标准」区可确认完成；系统汇总投入与执行记录后生成完成总结并持久化到 `completionRecord`。

### 8.2 Agent Harness

- [x] Qwen、DeepSeek 和 MiniMax 可通过配置切换，业务代码不出现供应商分支散落。
- [x] Agent Run、Step、Tool Call、Token Usage 和错误可查询。
- [x] Context Builder 能说明本次 Run 使用了哪些业务上下文。
- [x] Agent Loop 达到步数、耗时或 Token 上限时安全停止。
- [x] 小律 system prompt 注入用户时区下的当前日期时间锚点，避免臆造「今天」。
- [x] `read_schedule_window` 通过 `listScheduleBlocks` 实时查询（含 Routine 虚拟实例），并按 `from`/`to` 过滤。
- [x] 写工具不能绕过 ChangeSet 和 Approval Gate。
- [x] 等待确认的 Run 在刷新页面或服务重启后仍可恢复。
- [x] 同一 ChangeSet 不会重复应用。
- [x] AI 失败时核心手动流程仍然可用。

### 8.3 日程与时间

- [x] 日、周、月视图显示同一份内部日历数据。
- [x] 日视图在时间轴顶部提示「↑ 上方还有 N 个未完成日程」：仅在今天视图、存在已开始且仍为 `planned` 或 Routine 过期未执行的 `missed` 日程块、且该块滚出视口上方时显示；点击平滑滚动至离当前视口最近的一条。
- [~] 时区转换、跨日时间块和夏令时边界不改变真实时刻。
- [x] Routine 能按规则生成日程块且不会重复生成。
- [x] 日回顾和周回顾的定时任务具备幂等性。

## 9. 推荐开发顺序

1. 工程骨架、数据库、design tokens 和本地种子用户。
2. Goal/Task/Routine 的手动 CRUD 和目标详情。
3. 内部日历、ScheduleBlock、ExecutionRecord、RhythmFeedback。
4. Agent Harness 基础：Model Adapter、Run Store、Tool Registry、Loop、Trace。
5. Goal Clarification 与 Planning，接入 ChangeSet/Approval Gate。
6. Review、Rhythm Signal、Adjustment 与 Progress Evaluation。
7. 定时任务、模型降级、异常恢复和端到端验收。
