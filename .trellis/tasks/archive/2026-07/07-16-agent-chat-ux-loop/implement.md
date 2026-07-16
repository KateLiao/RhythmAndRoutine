# 实现计划：Agent 对话窗口与上下文

> 对应 `prd.md` / `design.md`  
> **先闭合状态机，再抠窗口视觉**（评审建议）

## 顺序清单

### P0 — Session / Run / ChangeSet 状态机
- [x] `conversation-store` v2：仅当前 Session；revision；boundaryMessageId；runIds / pendingChangeSetIds；v1 迁移
- [x] 面板：AbortController 接入 `streamChatWithAgent`
- [x] 记录 `run_started` → activeRunId；`approval_required` → pendingChangeSetIds
- [x] 「新建对话」：abort → cancel Run → reject 关联 CS → 删旧 Session → 欢迎态
- [x] 用户感知提示：已停止处理 / 已放弃草案；失败则 sticky 警告 + 重试（不得静默）
- [x] 清空：边界+revision；不动 Run/CS
- [x] 切目标：仅 goalId；Run 中先 cancel 再清空
- [x] 移除 AgentRun merge

### P1 — 工具披露契约
- [x] Runtime/SSE：`toolCallId` 贯穿 started/completed
- [x] `summarizeToolInput` + 脱敏限长 `inputPreview`
- [x] 过程 UI 按 id 合并；cancelled/failed 终态
- [x] 展示模型：理解≤1、无重复最终卡、status=投影
- [x] 工具详情三层披露：行动摘要 → 格式化 key-value → 手动展开原始 JSON

### P2 — 异步摘要
- [x] summarize API + 规则降级
- [x] 回合后 fire-and-forget；sessionId+revision 校验
- [x] chat 传 summary；ContextBuilder 装载；manifest 可观测字段

### P3 — 前端对话与过程 UX
- [x] 面板信息架构：Header / Context Bar / Conversation / Sticky Activity / Composer
- [x] 默认 520、展开 880；内容列 680、过程/草案 720；右侧锚定且不重置滚动/焦点/草稿
- [x] 过程「节奏轨」状态样式；状态不只依赖颜色
- [x] 执行中默认展开；最终回复出现后自动收成一行；用户手动展开后本轮不自动收起
- [x] Sticky Activity 只投影当前步骤，点击滚到活动回合；避免与过程卡重复高亮
- [x] ChangeSet 独立确认层；滚离后的待确认 sticky 提醒；继续对话不隐藏草案
- [x] Apply/Reject 后卡片原位只读终态，不追加重复 assistant message
- [x] Composer：Run 中可编辑草稿；发送切为停止；本版不排队；交互不丢草稿
- [x] 新建按钮使用文字；有 Run/草案时按状态显示具体确认文案，无风险时直接新建
- [x] 新对话与清空上下文作为 Header 同级图标操作；消息流插入持久边界；下一次发送前支持撤销
- [x] 切目标边界写明目标名称；不能只用 toast
- [x] 欢迎态仅保留 2–3 个上下文相关入口
- [x] 展开过程改为真实事件顺序线性追加；完成事件按 toolCallId 原位更新
- [x] 内部逐轮 verification 不进入主时间线，不再提前显示验证成功

### P3.1 — Runtime Token 与工具证据
- [x] planning / adjustment 上限提升至 64k，其余能力按复杂度提升
- [x] `maxSteps` / `maxTokens` 随 AgentRun 持久化
- [x] 工具原始结果完整审计；模型上下文使用确定性证据摘要
- [x] 只保留最近一轮工具协议消息，旧结果由 8k 有界证据账本传递
- [x] 75% / 88% 预算水位加入收敛提示

### P4 — 响应式 / 动效 / 无障碍
- [x] 375px/横屏/1024/1440 响应式验证；移动端全屏无页面横向滚动
- [x] 原始 JSON 内部限高/滚动；图标按钮命中区 ≥44px
- [x] 动效 220–280ms、可打断；支持 reduced-motion
- [x] 键盘焦点回归；`aria-expanded`；节流 `aria-live` 仅播报步骤变化

### P5 — 文档
- [x] 实现中同步需求文档；清单第 3 项已完成并封板

## 验证

```bash
npx tsc --noEmit
# 手动矩阵：
# - Run 中新建 → 流停、Run CANCELLED、关联 CS REJECTED、无迟到写入
# - 拒绝失败 → 新 Session + sticky 警告
# - 同工具连调两张卡
# - 执行中过程默认展开；最终回复出现后自动收起；手动展开后保持打开
# - 工具参数三层披露；未点击原始层时不出现大段 JSON
# - Sticky Activity 点击能定位活动回合；过程卡可见时不重复抢焦点
# - 继续对话不隐藏 pending 草案；滚离后仍有待确认提醒
# - Apply/Reject 原位进入只读终态，无重复 assistant message
# - Run 中 Composer 可编辑、停止按钮可用，展开/确认/停止均不丢草稿
# - 空闲新建不弹框；Run/草案场景确认文案与真实后果一致
# - 清空不拒草案；切页不清空；切目标清空
# - 清空边界持续可见且下一次发送前可撤销；切目标边界含目标名
# - 长对话 summaryUsed；关页摘要可不完成
# - 375px 无页面横向滚动；键盘/读屏/reduced-motion 可完成核心流程
```

## `task.py start` 前

- [x] 评审意见已吸收进 prd/design/需求文档
- [x] 用户确认「新建=取消 Run」+ 可感知提示
- [x] 用户同意开始实现并完成多轮真实场景验收

## 2026-07-16 草案视觉与规划护栏增量

- 修复消息 wrapper 导致的宽屏用户气泡右对齐失效
- 重构 ChangeSet 待确认决策卡与应用/放弃终态回执
- 新增 `read_similar_schedule_history` 工具及服务端历史时段聚合
- planning / adjustment 增加冲突检查、饭点软约束和习惯工具条件
- Runtime 对一次性日程草案强制执行当前窗口检查，并要求历史参考后重新检查
- 新增 planning policy、工具注册/标签、历史聚合回归测试
- 过程投影按当前有效状态收敛：proposal 重试只显示最新尝试，逐轮校验压缩为最终判断，旧无工具 verification 兼容改写

## 2026-07-16 历史查询与忙闲事实修复

- [x] 新增独立结构化 query planner：exact / related / broad，8 秒超时后规则降级
- [x] 新增逐级短路检索：上一层零结果才放宽，命中后停止
- [x] 历史习惯仅使用 COMPLETED；样本补用户时区本地时间和命中层级
- [x] `read_schedule_window` 改为紧凑的本地时间 items / busyIntervals / availableIntervals
- [x] 修复 timezone-less Agent 时间按服务器环境解释的问题
- [x] 过滤窗口外 Routine、CANCELLED、RESCHEDULED 对决策的污染
- [x] 新增 `validate_schedule_candidates`，具体建议与 ChangeSet 均要求最终校验
- [x] Runtime 阻止缺少校验、仍有冲突或校验后变更候选的草案
- [x] Runtime 拦截“查过窗口但未验证候选”的具体时间回复，要求继续工具循环
- [x] 使用真实数据库重放《原则》+ 7/16 晚间场景
- [x] 新增 planner、时区、忙闲投影、候选冲突和 Runtime guard 回归测试
