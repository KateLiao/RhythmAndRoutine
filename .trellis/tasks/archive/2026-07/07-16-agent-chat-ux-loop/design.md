# 设计：Agent 对话窗口与上下文

> 对应 PRD：`prd.md`  
> 需求：`docs/v0.3.0 版本需求/特性优化-Agent 对话窗口与上下文.md`  
> 注：已确认新建=取消 Run，且必须给出用户可感知提示

## 1. 边界

**改**：面板宽度/动效、过程卡与 SSE 契约（toolCallId）、仅当前 Session 存储、新建/清空/切目标状态机、异步摘要、停 merge AgentRun、面板接入 Abort + cancel API，以及 Runtime Token 预算、工具证据压缩和预算可观测性。

**不改**：工具白名单核心、ChangeSet 批准路径、固定 LLM workflow。模型上下文可压缩，但**不删除或压缩** step / ToolCall 原始审计落库。

## 2. 窗口

| Token | 建议 |
|-------|------|
| 默认宽 | `min(520px, 100vw - 32px)` |
| 展开宽 | `min(880px, 100vw - 32px)` |
| 内容列 max | `680px`（默认态自然受面板内宽限制） |
| 用户气泡 max | 内容列约 `75%` |
| 过程 / ChangeSet max | `720px` |
| 桌面动效 | `220–280ms ease-out`，右侧锚定、可打断 |

- `rr.agent.panel.expanded` 持久化展开偏好
- 展开不得重置消息滚动位置、输入焦点或输入草稿
- `prefers-reduced-motion: reduce` 下取消位移/宽度补间，直接呈现终态
- 移动端全屏忽略桌面宽

### 2.1 信息架构

```text
Header：小律 + 当前模型（弱化） | 新对话 | 清空上下文 | 展开 | 关闭
Context Bar：当前页面 / 当前目标 / 上下文是否重置
Conversation Scroll：用户消息 → 处理过程 → 助手回复 → ChangeSet
Sticky Activity（仅执行中/待确认）：当前步骤或待确认草案
Composer：可编辑输入 + 发送/停止 + ChangeSet 边界说明
```

- 「新对话」与「清空上下文」使用相同按钮规格并列展示；前者使用紫色新增对话图标，后者使用金色断开上下文图标
- 窄屏隐藏两者文字但保留 44px 图标按钮、title 与 aria-label；欢迎态禁用无意义的清空操作
- 默认视觉语言沿用现有暖白、紫、鼠尾草绿、金、珊瑚色，不新增通用蓝紫霓虹 AI 主题

### 2.2 视觉签名：节奏轨

- 处理步骤使用一条轻量纵向轨道串联，表达 Rhythm & Routine 的「节奏推进」而非普通日志列表
- 当前节点：紫色、轻微呼吸；完成：鼠尾草绿；等待确认：金色；失败/取消：珊瑚色/中性灰
- 状态始终同时提供图标和文字，颜色不是唯一信息
- 同一时刻最多一个持续动画；动画只用于当前活动节点

## 3. SSE / 工具卡

### 3.1 事件

```ts
tool_started: { tool, toolCallId, label?, inputSummary?, inputPreview? }
tool_completed: { tool, toolCallId, summary?, detail?, result }
// failed/cancelled 同 id 更新步骤 status
```

- Runtime 在 yield `tool_started`/`tool_completed` 时带上模型 tool call `id`
- `inputPreview`：脱敏+限长后的 JSON/键值；超限截断并标注
- 前端只按 `toolCallId` 合并步骤，禁止按同名 running 匹配

### 3.2 展示模型

理解≤1 → 工具卡×N → 失败恢复(可选) → 等待确认≤1；无重复最终卡；status=活动投影。

脱敏：key 名含 token/key/secret/password/authorization 等 → 打码；字符串 >500 字截断；数组 >20 元素摘要计数。

### 3.3 收起摘要与展开时间线

同一份扁平事件建立两种只读投影，均不修改原始事件：

1. 收起态使用「理解 / 查阅 / 结果」语义阶段生成一句摘要和当前状态。
2. 展开态严格按事件到达顺序线性展示：理解 → 工具调用 → 恢复 → 下一工具 → 确认/结束。

`tool_completed` 只按 `toolCallId` 原位更新对应行；新的 `tool_started` 永远追加到底部。逐轮 `verification` 是 Runtime 内部控制/审计事件，不进入主时间线，也不能在 Agent 尚未结束信息收集时显示“验证成功”。真实失败恢复和等待确认事件仍按顺序保留。

收起态阶段状态优先级为 running → failed → confirm → cancelled → pending → done。已恢复的历史失败不能污染当前终态。

工具步骤三层披露：

1. 默认层：中文行动 + 一行输入摘要；完成后原位替换为结果摘要
2. 展开层：格式化 key-value、结果/detail、耗时（若已有）
3. 原始层：用户再次主动点击「查看原始参数/结果」后显示限高 JSON；内部工具名在此层弱化显示

过程容器状态：

- `active`：默认展开，当前步骤在节奏轨上高亮
- `answer_streaming`：若用户未手动展开，过程收成「已完成 N 步 · 关键动作 · 查看过程」一行；保持滚动锚点，避免正文跳动
- `completed_manual_open`：用户手动展开过，本轮完成后保持打开
- `failed/cancelled`：收口到明确终态和恢复动作，禁止永久 running

输入框上方可有 sticky activity，仅显示当前动作；点击滚到对应 assistant turn。过程卡在视口内时降低 sticky activity 的视觉强调。

## 4. conversation-store v2（仅当前 Session）

```ts
type ConversationDataV2 = {
  version: 2;
  panelExpanded?: boolean;
  session: {
    id: string;
    revision: number;
    createdAt: string;
    messages: StoredMessage[]; // 含 id
    contextBoundaryMessageId?: string; // 此 id 及之前不装载
    summary?: string;
    summarizedThroughMessageId?: string;
    runIds: string[];
    activeRunId?: string;
    pendingChangeSetIds: string[];
    contextScope?: { view?: string; goalId?: string | null };
  };
};
```

- **不**保存 `sessions[]` 历史
- 新建：丢弃整个旧 `session` 对象，写新 session
- v1→v2：messages 迁入；`contextClearedAt` 映射为边界（找第一条 timestamp > clearedAt 的前一条 messageId，找不到则边界=最后一条）
- 欢迎消息：有 id，标记 `kind: "welcome"` 可选，不进入 getContextMessages

### 4.1 装载

```
messages
  .filter(after boundary)
  .slice(-N*2)  // N 轮
+ summary (if any)
```

## 5. 新建 / 清空 / 切目标

### 5.1 新建（终止生命周期）

```
abortController.abort()
if (activeRunId) await runs.cancel(activeRunId)  // 已含关联 CS reject
for (id of pendingChangeSetIds) decide(false) // 幂等/已处理则忽略
revision++ / 或直接 replace session
清除面板 changeSet 展示
用户感知：
  - 曾有 activeRun → toast/面板条：「已停止当前处理」
  - 曾拒绝草案 → 「已放弃待确认的变更草案」
  - 失败 → stickyWarning + 重试（非闪消失）
  - 过程卡 running → cancelled（若仍短暂可见）
```

确认框按状态生成具体文案：

| 当前状态 | 是否确认 | 标题 / 主操作 |
|----------|----------|----------------|
| 无 Run、无草案 | 否 | 直接新建并聚焦输入框 |
| Run 进行中 | 是 | 「停止当前处理并开始新对话？」/「停止并新建」 |
| 有 pending 草案 | 是 | 「开始新对话？」并说明草案会放弃、正式计划不变 /「放弃草案并新建」 |
| Run + 草案 | 是 | 合并说明两项后果，只确认一次 |

- 取消确认后焦点回到「新对话」触发按钮
- 清理失败进入新 Session，但 sticky warning 跨对话保留并提供「重试」

### 5.2 清空

- 设 `contextBoundaryMessageId = lastMessage.id`，`revision++`，`summary=undefined`
- 不 cancel Run；不 reject CS
- 在消息流准确位置插入持久边界：「上方内容已移出上下文」+ 解释文案
- 下一次发送前允许撤销；发送后撤销入口消失
- 旧消息保持正常对比度，不用整体 opacity 作为主要提示

### 5.3 切目标

- 仅 `selectedGoalId` 变化
- 若 `activeRunId`：先走 cancel（同新建片段），再清空；**不** replace session
- 插入系统边界并写明新目标名；不能只靠 toast

## 6. 异步摘要

```
onAssistantPersisted:
  if (inContextTurns > N) {
    const rev = session.revision
    const sid = session.id
    fetch summarize({ sessionId, revision: rev, priorSummary, messages: overflow })
      .then(res => {
        if (store.session.id !== sid || store.session.revision !== rev) return
        write summary + summarizedThroughMessageId
      })
  }
```

- 规则降级函数纯客户端也可写，不依赖 API 成功
- chat 请求体增加 `conversationSummary?`
- ContextBuilder 传入；`contextManifest` 增加 summary 可观测字段
- 遵守 `llm-structured-output`（Qwen 关 thinking）

## 7. 兼容与回滚

- 宽度/工具披露/Session/摘要可分 PR
- 回滚：恢复旧 CSS；不传 input；读 v1；关 summarize flag

## 8. 风险

| 风险 | 缓解 |
|------|------|
| cancel 与 SSE 竞态 | 先 abort 再 cancel；generation 计数丢弃事件 |
| 误拒无关草案 | 只认 Session 关联 id |
| 摘要污染 | sessionId+revision |
| 多标签覆盖 | 接受 MVP 限制；revision 丢弃过期写 |

## 9. ChangeSet 确认层与 Composer

### 9.1 ChangeSet 确认层

ChangeSet 不作为普通聊天气泡渲染，而是在对应助手回复后形成独立确认层：

```text
变更草案 · N 项 · 风险标签
一句话原因
可选择操作列表
[应用选中的 N 项]  [放弃这份草案]
```

- 用户继续对话时不得 `setChangeSet(null)` 或隐藏既有 pending 草案
- 草案滚离视口后，在 Composer 上方显示「有一份变更草案等待确认 · 查看」；点击滚回草案
- 应用成功：卡片原位只读显示「已应用 N 项」
- 拒绝成功：卡片原位收为「已放弃这份草案」并说明正式计划未改变
- 不再为 apply/reject 额外追加重复的 assistant message
- 继续讨论不等于应用草案；Composer helper 持续说明审批边界

### 9.2 Composer 执行态

- Run 中输入框仍可编辑并持久保留本地草稿
- 发送按钮切为停止按钮；本版不排队、不自动发送预先输入内容
- Stop、展开/还原、确认框开关不得清空草稿
- 停止成功后按钮恢复发送；错误在 Composer 邻近区域给出原因与重试，不只用 toast

### 9.3 欢迎态

- 只给 2–3 个由当前页面/目标派生的建议动作
- 不展示历史会话、模式选择、模型选择或大型功能宫格
- 新 Session 建立后焦点落到输入框

## 10. 响应式、动效与无障碍

- 桌面验证 1024/1440 宽；移动端验证 375px 与横屏
- 移动端面板全屏；Context Bar 压缩为单行可展开胶囊；页面本身不得横向滚动
- 原始 JSON 使用内部限高/横向滚动容器，不扩大页面宽度
- 所有图标按钮命中区域至少 44×44px；不能依赖 hover 才能完成关键动作
- 面板打开时聚焦 Composer；关闭后焦点回到触发按钮；对话框关闭后焦点回触发源
- SSE 状态变化使用节流后的 `aria-live="polite"`，只播报步骤变化，不逐 token 播报
- 展开按钮、步骤、过程容器提供 `aria-expanded`；状态同时用文字/图标表达
- reduced-motion 下禁用呼吸/位移动画，但保留完整状态语义

## 11. 2026-07-16 草案视觉与规划护栏增量

### 11.1 消息与 ChangeSet 布局

- `agent-message-row` 占满消息内容列并负责左右对齐；用户行 `align-items: flex-end`，避免把 `align-self` 放在被普通 block wrapper 包裹的内层节点上
- 待确认草案采用白底决策卡：头部只承载方案与数量，中部承载选择状态和操作列表，底部独立审批区说明“继续讨论不会应用”
- 操作项用完整边框和轻背景表达选择，不再依赖左侧彩条；实体类型改为小标签，字段 diff 作为第二层信息
- 终态去掉外层大卡片边框与阴影，仅保留 34px 左右的状态回执、2px 状态导轨与文本说明
- 375px 下操作区允许按钮换行，用户气泡最大宽度 88%，字段详情取消额外左缩进

### 11.2 相似日程历史工具

```text
read_similar_schedule_history
input: query?/goalId?/taskId?/routineId? + days(7..180) + limit(1..20)
output: sampleCount + typicalStartTime + typicalDurationMinutes
        + commonWindows[] + samples[]
```

- 数据源为历史 `ScheduleBlock`，排除 `CANCELLED` / `RESCHEDULED` 与软删除记录
- 候选先按 Routine、Task、标题、Goal 关联评分，再按新近程度排序
- 服务端在用户时区聚合 30 分钟起始桶和中位时长，避免模型自行统计 ISO 时间戳
- 工具只在用户明确提出习惯参考时使用；无历史结果时正常返回空摘要

### 11.3 两层冲突防线

1. Capability policy：要求候选生成前读取窗口，按 `[startsAt, endsAt)` 比较，默认避开饭点和冲突。
2. Runtime guard：`propose_change_set` 含一次性 `schedule` / `personal_schedule` create/update 时，若本 Run 尚无成功的 `read_schedule_window`，返回可重试 `SCHEDULE_WINDOW_REQUIRED`；若刚读取过历史习惯，则要求在其后再查一次当前窗口。

饭点属于可解释软约束，保留用户明确指定和个体习惯覆盖；冲突窗口检查属于生成草案前的强制前置条件。

### 11.4 审计事件到当前状态的投影

- `processSteps` 保留原始事件与 `toolCallId`，用于追溯；主阶段不是事件列表的直接映射
- 同一 proposal 的多次尝试只将最后一次放入 `result.steps`，更早尝试进入 `technicalSteps`
- `recovery` 与失败工具详情重复时不单独展示；多轮 `verification` / `decision` 只保留最后一次语义判断
- result stage 和过程容器状态只由当前投影计算，已被后续成功恢复的失败不参与 `hasFailure`
- 新 Runtime 将无工具终止事件标记为 `decision / 确认处理结束`；投影层同时把旧记录中的“没有新的工具调用”规范化为相同语义

## 12. 2026-07-16 历史查询 Planner 与确定性忙闲校验

### 12.1 独立查询 Planner Loop

```text
用户原始请求 + 主 Agent queryHint
  → structured query planner（8 秒预算，失败走本地规则）
  → exact: 完整活动语义，如 阅读《原则》 / 原则阅读
  → 0 条才执行 related: 核心对象，如 原则
  → 仍为 0 条才执行 broad: 活动类别，如 阅读
  → 返回 matchedTier + attempts + 历史聚合
```

- planner 使用 `generateObject`，Qwen 结构化输出继续遵守 `enable_thinking=false`；超时或 schema 失败不能阻断 Agent，必须使用确定性本地 plan
- progressive search 严格短路：一层命中立即停止；禁止先把所有层结果混合后再打分
- 历史样本默认只取 `COMPLETED`，样本同时返回 UTC instant 与用户时区 `localStartsAt/localEndsAt`
- `matchedTier=broad` 只代表宽泛类别参考，UI 与模型不得把它陈述成具体作品或具体活动的习惯

### 12.2 Agent 日程窗口投影

`read_schedule_window` 不再把完整领域对象直接交给模型，而是返回紧凑投影：

```ts
{
  timezone,
  window: { from, to, localFrom, localTo },
  itemCount,
  items: [{ id, title, status, blockKind, startsAt, endsAt, localStartsAt, localEndsAt }],
  busyIntervals: [{ startsAt, endsAt, localStartsAt, localEndsAt, titles }],
  availableIntervals: [{ startsAt, endsAt, localStartsAt, localEndsAt }]
}
```

- 进入投影前执行精确 `[from,to)` overlap 过滤，修正 Routine 按日期展开带来的窗口外实例
- 排除 `CANCELLED` / `RESCHEDULED`；相邻 busy block 合并，半开区间端点相接不算冲突
- 无 offset 的 `YYYY-MM-DDTHH:mm:ss` 按用户时区解释；带 `Z/+08:00` 的值按绝对时刻解释

### 12.3 三层防线

1. `read_schedule_window` 给模型本地忙闲事实，而非要求模型手工换算 UTC。
2. `validate_schedule_candidates` 对最终候选执行真实数据查询与半开区间冲突判断；`allAvailable=false` 必须调整后重试。
3. Runtime 拦截未校验的具体时间回复；ChangeSet 还必须满足：窗口检查在历史查询之后、候选校验在窗口检查之后、草案时间与最后校验候选一致。
