# Rhythm & Routine · Agent 对话窗口与上下文优化

> 版本：v0.3.0  
> 状态：实现中（核心代码已落地，待手动验收）  

> 关联 Trellis：`07-16-agent-chat-ux-loop`  
> 父任务：`07-09-v03-release`  
> 相关：`docs/v0.2.0 版本需求/特性优化-AgentLoop优化需求描述.md`

## 1. 背景与问题

小律已具备 Agent Runtime、工具白名单、SSE、ChangeSet 审批与 localStorage 对话存储，但用户难以稳定回答：

1. 小律现在在做什么？
2. 它基于什么信息、调用了什么？
3. 清空 / 新建之后，哪些还在、哪些没了？

具体表现：窗口偏小；过程像静态模板；工具调用缺少 GPT/Cursor 式入参披露；历史无 Session 归属；AgentRun 痕迹与对话混在面板。

## 2. 产品目标（可验证）

1. 看到当前真实动作；status 是活动步骤投影。
2. 展开查看该动作输入（脱敏/限长）与结果 / 失败 / 取消。
3. 清空与新建的生命周期语义闭合，且 UI 不与 Run/ChangeSet 服务端状态矛盾。
4. 窗口更好用；不做可回看的聊天产品；不重做 Runtime 执行质量。

**继承 v0.2（不削弱）**：上下文优先推断再追问、有界失败恢复、ChangeSet 审批、结构化退出原因与 Loop 事件。本任务只调整披露与 Session/上下文生命周期。

## 3. 范围

### 包含

| 编号 | 内容 |
|------|------|
| R1 | 默认加宽、记住展开、展开更宽、丝滑动效、内容 max-width |
| R2 | SSE 驱动过程 UI；toolCallId；工具分层披露；可验收的步骤模型 |
| R3 | 仅当前 Session；新建/清空/切目标状态机；异步摘要契约；停 merge AgentRun |
| R4 | 呈现层收敛；摘要/取消不阻塞进入新 Session |
| R5 | 对话优先的前端交互：过程渐进披露、独立草案确认层、Composer 执行态、上下文边界与无障碍 |

### 不包含

- 历史 Session 列表 / 跳回 / 静默保留用户永远无法访问的旧 Session
- Conversation DB 表；关页后必须完成的服务端摘要任务
- thinking token / 每步 LLM 旁白 / 每轮结构化 Loop Decision LLM
- 外部 Agent 框架；绕过 ChangeSet 直写；Runtime 工具选型大改

## 4. 当前系统基线（已核实）

| 能力 | 现状 |
|------|------|
| 面板宽度 | 默认 `min(400px)`，展开 `min(700px)` |
| 过程 UI | `AgentProcessSteps`；结果摘要有，入参披露弱 |
| 工具事件匹配 | 按展示名找最后一个 running——同工具并发会错配 |
| 对话消息 | 仅 localStorage |
| AgentRun | DB 有；面板会 merge 成类消息 |
| summary | ContextBuilder **预留**入口；存储/协议/生成/并发/追溯均未实现 |
| 取消 | `streamChatWithAgent` 支持 signal，面板未用；`POST .../runs/:id/cancel` 会取消 Run 并拒绝关联 pending ChangeSet |
| pending 草案 | 列出用户全部 pending；面板取第一份，无 Session 归属 |

## 5. 期望行为

### 5.1 对话窗口（R1）

- 默认约 480–520px；展开约 820–900px（均受视口约束）；大于现状。
- localStorage 记住展开状态；width 过渡丝滑。
- 消息气泡、处理过程各自 max-width；面板未到内容 max 前可略增宽。
- 移动端全屏。

### 5.2 动态处理过程（R2）

#### 展示模型（可验收）

| 步骤 | 规则 |
|------|------|
| 理解/准备 | 同一 Run ≤ 1 |
| 工具调用 | 每次真实调用 1 卡；`toolCallId` 串联 started/completed/failed/cancelled |
| 失败恢复 | 仅真实失败 |
| 等待确认 | ≤ 1 |
| 最终输出卡 | 不与回复正文重复再出一张 |
| status | 活动步骤投影，不另造叙事 |

#### 工具披露

- **调用方式** = 工具参数（产品语义），不是 HTTP/API 实现细节。
- 默认：中文工具名 + 一行可读入参摘要。
- 展开：脱敏、限长后的参数；敏感字段打码；过大截断；不可序列化则降级说明。
- 断流/取消/异常：running → cancelled/failed，禁止永久转圈。

### 5.3 Session、Run、ChangeSet、摘要（R3）

#### 5.3.1 新建对话 = 终止当前任务生命周期（已确认）

**已确认：取消正在执行的 Run，并给出用户可感知的提示。**

```text
点击「新建对话」（Run 进行中可用）
  → 停止接收旧 SSE（Abort）
  → 取消 activeRun（服务端 cancel：同步拒该 Run 关联 pending ChangeSet）
  → 拒绝本 Session 记录的其余 pendingChangeSetIds（兜底）
  → 失效进行中的摘要任务（revision）
  → 删除旧 Session 本地数据 → 创建新 Session + 欢迎态
  → 【必做】按结果给出提示（见下表），不得静默
  → 清理未完全成功：仍进新 Session，但在非对话历史区持久提示 + 重试
  → 旧 SSE / 旧摘要：sessionId 或 revision 不匹配则丢弃
```

| 情况 | 用户应感知到 |
|------|----------------|
| 有进行中的 Run | 明确提示：已停止当前处理 / 已取消本次任务 |
| 有本 Session 待确认草案被拒绝 | 提示：已放弃待确认的变更草案 |
| 空闲新建 | 可选轻量「已开始新对话」 |
| 清理部分失败 | **持久**警告 + 重试，草案不得静默消失 |
| 过程卡 | 旧 running 步骤应变为 cancelled，与「已停止」一致 |

#### 5.3.2 Session 生命周期

| 事件 | 行为 |
|------|------|
| 首次打开 | 创建当前 Session；欢迎消息属 Session（可不装载） |
| 刷新 | 恢复当前 Session |
| 新建 | 删旧本地 Session，建新 |
| 清空 | 边界绑定 messageId/revision；清 summary；消息保留 |
| 存储 | **只保留当前 Session**；不静默堆旧 Session |
| v1→v2 | 一次性迁移，避免升级丢当前聊天 |
| 损坏/超限 | 空 Session，不崩 |
| 多标签 | 后写覆盖；异步结果靠 revision 防污染 |

Session 必含：`sessionId`、`revision`、消息、`contextBoundaryMessageId`、`summary`、`summarizedThroughMessageId`、`runIds` / `activeRunId`、`pendingChangeSetIds`。

#### 5.3.3 ChangeSet「当前」定义

只处理与**本 Session 已关联 runId / pendingChangeSetIds** 的 pending 草案。  
禁止：按「列表第一份」、全用户 pending、其他目标/Run 的草案连带拒绝。

#### 5.3.4 清空 vs 新建

| | 清空上下文 | 新建对话 |
|--|-----------|----------|
| Session | 同一 | 新（删旧） |
| 消息 | 保留，标界外 | 欢迎态 |
| Run | 不取消 | **取消** |
| ChangeSet | 不动 | 拒本 Session 关联 pending |
| 摘要 | 清并失效进行中任务 | 删除 |

**拒绝失败**：允许进入新 Session；未拒成功的草案**不得**仅从 UI 静默消失；持久提示 + 重试。

#### 5.3.5 切目标

- 仅 `selectedGoalId` 变化触发清空（含选中↔未选）；普通 `view` 切换不清空。
- Run 进行中切目标：先取消当前 Run（同新建中的 cancel），再清空上下文，**不**新建 Session。

#### 5.3.6 异步摘要

| 项 | 约定 |
|----|------|
| 性质 | best-effort；关页可不完成 |
| 触发 | 回合结束后且界内轮次 > N（建议 6） |
| 内容 | 用户/助手正文；不含工具原始 JSON / processSteps |
| 并发 | 请求带 `sessionId + revision`；不匹配禁止写回 |
| 降级 | 界外用户要点 + 助手结论首句；可验收 |
| 可观测 | contextManifest：`summaryUsed`、`summaryChars`、`summarizedThroughMessageId`、`summaryRevision`（可不存正文到 DB） |
| 主流程 | 发送/SSE 不等待摘要 |

清空边界：**绑定 messageId/revision**，不只依赖 `contextClearedAt` 时间戳。

### 5.4 呈现层（R4）

- 收敛无信息量模板展示；保留真实事件数据源以便调试。
- 不新增「每轮模型结构化 Loop Decision」调用。

### 5.5 已确认的前端 UX 方案（R5）

核心原则是「对话优先、过程可见、操作可控」：最终回复是主内容，真实过程通过渐进披露提供可信度，ChangeSet 形成独立确认层。

#### 窗口与视觉

- 桌面默认约 520px、展开约 880px；助手正文保持约 640–680px 可读宽度，过程区 / ChangeSet 可略宽但不铺满面板。
- 面板右侧为视觉锚点，向左舒展；动效约 220–280ms、可打断，不能重置滚动位置、输入焦点或草稿。
- 延续现有暖白、紫/鼠尾草绿/金/珊瑚色视觉语言；处理过程采用产品化「节奏轨」，不引入通用蓝紫霓虹 AI 风格。
- Header 将「新对话」与「清空上下文」作为同级操作直接展示；两者使用不同图标与颜色表达不同后果，窄屏可隐藏文字但保留 44px 命中区、title 与 aria-label。

#### 处理过程

- **执行中默认展开；最终回复出现后自动收成一行；完整参数始终需要手动展开。**用户本轮手动展开过详情后，完成时不自动收起。
- 每次工具调用按三层披露：中文行动/结果摘要 → 格式化 key-value 技术详情 → 用户再次主动点击后显示脱敏限长的原始 JSON。
- 输入框上方可显示粘性当前状态，只投影当前活动步骤；点击可定位到对应助手回合，不能与过程卡重复叙述。
- 当前、完成、确认、失败除颜色外必须同时有图标和文字；取消/失败后不得留下永久 running。

#### ChangeSet 确认层

- 草案独立于普通聊天气泡，展示标题、原因、风险/数量、可选择操作、确认与放弃动作。
- 用户继续讨论时草案不得消失；滚动离开草案后，输入框上方持续显示「有一份变更草案等待确认 · 查看」。
- 应用或拒绝后，卡片在原位进入只读终态；不再追加重复的助手消息。
- 继续讨论不代表应用草案，正式写入仍只由用户显式确认触发。

#### 新建、清空与输入区

- 无 Run、无草案时，新建对话直接进入欢迎态；有 Run/草案时才确认，并用具体文案说明「停止处理」「放弃草案」「正式计划不会改变」等真实后果。
- 清空上下文后，在消息流准确位置插入持久边界；旧消息保持正常可读，在下一次发送前允许撤销。
- 自动切目标也插入写明新目标名称的上下文边界，不能只依赖短暂 toast。
- Run 执行中输入框仍可编辑并保留草稿；本版不做消息排队；发送按钮切换为明确的停止控制。
- 欢迎态只显示 2–3 个与当前页面/目标相关的快捷入口，不加入历史列表、模式切换或大型功能宫格。
- 移动端保持全屏；交互命中区至少 44px；支持键盘操作、`aria-expanded`、节流后的状态播报与 reduced-motion。

### 5.6 习惯查询 Planner 与日程事实防幻觉（R6）

- 用户明确要求“照往常/按习惯”时，历史工具内部先运行独立结构化 planner，根据原始请求生成 `exact → related → broad` 三层查询。
- exact 必须保留完整活动语义，例如“阅读《原则》/原则阅读”；只有 exact 零结果才查询“原则”，仍为零才允许查询“阅读”。一层命中立即停止，禁止把多层样本混合统计。
- planner 最多等待 8 秒；超时、供应商失败或结构化输出无效时，使用本地确定性规则生成同样的三层计划，不能阻断主 Agent Loop。
- 习惯证据默认只取 `COMPLETED` 日程；`PLANNED`、`CANCELLED`、`RESCHEDULED` 不用于证明用户通常何时执行。
- 日程窗口结果直接返回用户时区下的本地时间、有效 items、合并 busyIntervals 与 availableIntervals；模型不得自行把原始 UTC 列表推断成“空闲”。
- 无 offset 的工具时间按用户时区解释；窗口外 Routine 与旧改期记录在 Agent 投影层过滤。
- 任何包含具体起止时间的建议或 ChangeSet 前，必须调用 `validate_schedule_candidates`。只有 `allAvailable=true` 且最终候选没有变化时才能继续。
- Runtime 对缺少候选校验、仍有冲突、校验后修改候选分别返回结构化可重试错误，并拦截尚未验证的具体时间回复。

## 6. 错误、降级与边界

| 场景 | 行为 |
|------|------|
| 摘要失败/超时 | 规则降级；不阻断对话 |
| 摘要未完成又发送 | 用已有摘要或仅窗口原文 |
| 新建时 cancel/reject 部分失败 | 进新 Session + 持久警告 + 重试 |
| 迟到 SSE / 摘要 | 丢弃 |
| localStorage 不可用 | 内存当前 Session |

## 7. 验收场景

1. 窗口宽度、动效、max-width、展开偏好。
2. 同工具连调两张卡；toolCallId 对齐；入参/结果/取消态正确。
3. status 与步骤一致；无重复最终卡。
4. Run 中新建：流停、Run 取消、**用户看到已停止/已取消类提示**；本 Session 草案处理正确且有「已放弃草案」提示（若有）；无迟到写入。
5. 清空：消息在、草案在、摘要失效。
6. 拒绝失败：新对话可用，草案**持久**提示仍在（不得静默消失）。
7. 切目标清空；换页不清空；Run 中切目标先取消 Run。
8. 长对话 summaryUsed 可验证；不阻塞首包。
9. 冷启动无 AgentRun 回放进对话。
10. 执行中过程默认展开；最终回复出现后自动收为一行；用户手动展开后保持打开；原始参数只在再次主动展开后出现。
11. 继续对话时 pending ChangeSet 不消失；滚离后仍有待确认提醒；应用/拒绝后原位进入只读终态。
12. 空闲新建不弹框；有 Run/草案时，确认文案与实际后果一致且只确认一次。
13. 清空/切目标在消息流中留下持久可读边界；清空后在下一次发送前可撤销。
14. Run 中 Composer 可继续编辑但不排队；发送键变为停止；停止、展开、确认框开关均不丢草稿。
15. 375px 和移动端全屏无页面横向滚动；键盘可完成展开、停止、新建、确认/拒绝；reduced-motion 下状态仍清晰。
16. “按习惯阅读《原则》”优先命中完整活动历史；有精确结果时不得继续用“阅读”宽泛查询。
17. 每层零结果才放宽；结果披露 `matchedTier/attempts`，宽泛结果不得陈述成具体活动习惯。
18. 日程窗口返回本地忙闲区间；timezone-less 输入不受服务器时区影响；窗口外/无效记录不污染结论。
19. 未通过最终候选校验的具体时间建议不会输出，未校验或冲突候选不会生成 ChangeSet。
20. 展开处理过程按真实事件顺序线性追加；工具完成按 `toolCallId` 原位更新，后续工具追加在底部；内部逐轮 verification 不提前显示成校验成功。
21. planning / adjustment 单 Run Token 上限为 64k；各能力实际 `maxSteps/maxTokens` 可从 AgentRun 追溯。
22. 工具完整输入输出保留在审计记录；后续模型只携带最近一轮工具协议和有界证据账本，且日程时间、冲突与校验结论仍能正确传递。

## 8. 开发提示

- `product-shell.tsx` — AbortController、新建状态机、停 merge Run
- `agent-process-steps.tsx` — 工具卡分层
- `conversation-store.ts` — 仅当前 Session + revision/边界
- `chat/route.ts` + `types` — toolCallId、inputSummary
- `runs/[id]/cancel` — 取消 Run + 关联 CS
- `context-builder` + 新 summarize API — 摘要装载与生成
- `tool-labels.ts` — summarizeToolInput、脱敏限长
- `similar-schedule-query-planner.ts` — 三层 query planner、8 秒规则降级、逐级短路
- `agent-schedule-analysis.ts` — 本地忙闲投影与候选冲突校验
- `runtime.ts` — 文字建议拦截与 ChangeSet 候选一致性守卫
- `tool-evidence-ledger.ts` — 工具结果的确定性精简、证据替换与总量上限
- `agent-process-presentation.ts` — 收起语义摘要与展开真实事件时间线双投影

## 9. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-16 | brainstorm 初版 |
| 2026-07-16 | 吸收外部评审：新建/Run/CS 状态机、摘要契约、toolCallId、仅当前 Session、验收冲突修复 |
| 2026-07-16 | 确认新建=取消 Run，并要求用户可感知提示（toast/状态条 + 失败持久警告） |
| 2026-07-16 | 确认前端 UX：执行中展开/完成后收拢、三层工具披露、节奏轨、独立草案确认层与 Composer 执行态 |
| 2026-07-16 | 修复习惯/忙闲幻觉：独立查询 planner、逐级放宽、完成记录证据、本地忙闲投影与最终候选校验 |
| 2026-07-16 | 提升 Token 预算；新增完整审计/精简推理双轨工具证据；展开过程改为真实事件线性时间线 |
