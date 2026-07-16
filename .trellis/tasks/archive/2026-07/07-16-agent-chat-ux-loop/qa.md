# QA：Agent 对话窗口与上下文

> 验收依据：`prd.md` Acceptance Criteria 1–15  
> 执行日期：2026-07-16  
> 结论：**QA 缺陷已修复，自动化质量门禁通过；真实 Run/ChangeSet 场景仍建议发布前手动复验**

## 1. 结论摘要

- 自动化回归：43/43 通过（其中本次 UX 投影新增 5 条）。
- TypeScript：通过。
- Production build：通过。
- ESLint：通过。
- 桌面浏览器冒烟：面板可打开/展开，展开后草稿保留，Header 与三层过程入口可访问。
- 原发现的 2 个阻断缺陷、1 个重要交互问题和 1 个质量门禁问题均已修复。

代码级 QA 已通过。由于真实 Run/ChangeSet 验证会调用模型并改变当前会话/草案状态，发布前仍需按第 5 节执行一次隔离数据下的端到端复验。

## 2. 自动化与静态检查

| 检查 | 结果 | 说明 |
|---|---|---|
| `npm run typecheck` | PASS | 无 TypeScript 错误 |
| `npm run build` | PASS | Next.js 生产构建与 20 个静态页面生成成功 |
| `npm run lint` | PASS | effect 状态恢复移入 animation frame；移除未使用变量 |
| 既有 Node tests | PASS 25/25 | review followups 14、schedule investment 6、calendar active block 3、routines 2 |
| `conversation-store.test.ts` | PASS 5/5 | 边界、撤销、切页/切目标、摘要 revision、新 Session |
| `tool-labels.test.ts` | PASS 3/3 | 敏感字段脱敏、文本/数组截断、可读入参摘要 |

## 3. PRD 验收矩阵

| AC | 场景 | 方法 | 结果 | 证据/备注 |
|---|---|---|---|---|
| 1 | 默认/展开宽度、内容列、草稿与焦点 | CSS 静态 + Chrome 冒烟 | PARTIAL PASS | CSS 为 520/880/680/75%；实际展开后草稿 `QA 草稿：展开后应保留` 保留；未完成 1024/375 全矩阵 |
| 2 | toolCallId、同名工具、多层披露、失败终态 | 静态 + 单测 | PARTIAL PASS | toolCallId 代码链存在；脱敏/截断单测通过；未以真实并发同名工具验证 |
| 3 | status 仅投影活动步骤 | 静态 | PARTIAL PASS | status 来源为 streaming step；未覆盖断流竞态 |
| 4 | 执行中展开、回复出现后自动收起、手动展开保持 | 状态流审查 + 单测 | PASS | 回复开始即收起；手动展开优先的状态矩阵已覆盖 |
| 5 | Run 中新建：取消、拒草案、迟到事件、提示、欢迎态 | 状态流审查 + 单测 | PARTIAL PASS | 重复 reject 已幂等，组合提示已覆盖；未对用户当前真实会话执行破坏性 E2E |
| 6 | 清空保留消息、边界、Run/CS 不动、摘要失效 | 单测 + 静态 | PASS | `conversation-store` 边界与消息保留通过 |
| 7 | 仅 goalId 变化清空；换页不清空 | 单测 | PASS | view change 不 bump revision；goal change 插入含目标名边界 |
| 8 | 长对话 summaryUsed 且不阻塞 SSE | 单测 + 静态 | PARTIAL PASS | stale summary 被 revision 拒绝；未用真实长对话核验 manifest |
| 9 | 冷启动不 merge AgentRun | 静态 | PASS | 面板只加载 conversation store，无 Run merge 请求 |
| 10 | reject 失败不静默、持久警告+重试 | 静态 + 单测 | PASS | 正常 cancel→reject 幂等收敛；真实失败仍进入持久 warning |
| 11 | ChangeSet 持续可见、sticky、原位终态 | 静态 | PARTIAL PASS | 组件结构存在；未制造 pending 草案完成滚动/批准/拒绝 E2E |
| 12 | 空闲直接新建；Run/草案条件确认 | 静态 + 单测 | PASS | 四种状态文案覆盖；Run+草案合并为单条完整提示 |
| 13 | 持久边界、发送前撤销、旧消息可读 | 单测 + CSS | PASS | clear/undo 与边界外消息保持可读 |
| 14 | Run 中可编辑、停止按钮、草稿不丢 | Chrome 冒烟 + 静态 | PARTIAL PASS | 展开不丢草稿已验证；Stop/确认框未跑真实 Run |
| 15 | 375px、44px、键盘、reduced-motion | CSS 静态 | PARTIAL PASS | mobile full-screen、44px、reduced-motion 规则存在；未完成 375px/读屏实测 |

## 4. 缺陷

### QAF-001 · P0 · 最终回复开始后过程不会自动收起

**PRD**：AC4，最终回复开始出现后自动收成一行；用户手动展开后保持打开。

**证据**：

- `AgentProcessSteps` 只有在 `!active && answerStarted && !userExpanded` 时收起。
- 调用方传入 `active={item.streaming}`，同时传入 `answerStarted={item.streaming && item.text.length > 0}`。
- streaming 结束后 `active=false`，但 `answerStarted` 也同步变为 false；因此自动收起条件永远不能成立。

**复测**：发起含至少一个工具调用的请求；观察第一段助手正文出现以及流结束后，过程是否自动变为“已完成 N 步”一行；手动展开过的另一轮必须保持展开。

### QAF-002 · P0 · 新建对话可能把已成功清理误报为失败

**PRD**：AC5、AC10，新建应取消 Run、拒绝当前 Session 草案；仅真实失败显示持久警告。

**证据**：

1. `executeNewConversation` 先调用 Run cancel。
2. cancel route 明确会同时将关联 pending ChangeSet 标记为 REJECTED。
3. 随后前端仍遍历同一 `pendingChangeSetIds` 调用 reject。
4. `decideChangeSet` 只查 `AWAITING_CONFIRMATION`；已被 cancel 拒绝的草案返回 404。
5. 前端会把该 404 计入 `failedCs`，显示“仍有未处理草案”持久警告。

**期望**：兜底 reject 必须幂等，或排除已由 cancel 处理的关联草案；“已处理/不存在”需按契约区分为成功收敛而非清理失败。

**复测**：创建 AWAITING_CONFIRMATION Run + 关联草案 → 新建对话 → DB 中 Run=CANCELLED、CS=REJECTED；UI 无错误警告，且旧 SSE 不写入新 Session。

### QAF-003 · P1 · 同时存在 Run 与草案时用户只能看到后一条 toast

**PRD**：AC5、AC12，用户应同时感知“已停止处理”和“已放弃草案”。

**证据**：`showToast` 在同一同步流程连续调用两次；单 toast state 会被后一条覆盖。

**期望**：合并为一条完整文案，或使用可排队通知。

### QAF-004 · P1 · ESLint 质量门禁失败

- `src/components/agent-panel.tsx:991`：effect 内同步 `setExpanded(...)`，触发 `react-hooks/set-state-in-effect` error。
- `src/components/agent-panel.tsx:1084`：`readOnly` 未使用 warning。

## 5. 修复后必跑复测

1. `npm run lint && npm run typecheck && npm run build`。
2. 两个新增 Task 测试 + 全部既有测试。
3. 真实 Run：执行中默认展开 → 首段正文 → 自动收起；另起一轮手动展开后不收起。
4. Run + pending ChangeSet 新建：仅一次确认；取消/拒绝成功；无假 warning；合并提示完整。
5. 人为让 cancel 或 reject 失败：仍进入新 Session；warning 持久存在；重试成功后消失。
6. 真实同名工具并发/连续调用：卡片数量与 toolCallId 一一对应。
7. 375px、1024px、1440px；键盘完成展开、停止、新建、草案确认/拒绝；reduced-motion。

## 6. 本次新增回归资产

- `src/lib/conversation-store.test.ts`
- `src/agent/tool-labels.test.ts`

初次 QA 仅新增文档和测试；第 7 节记录后续产品修复与复测结果。

## 7. 2026-07-16 修复复测

| 缺陷 | 修复 | 复测结果 |
|---|---|---|
| QAF-001 | `answerStarted` 独立于 streaming；正文首段出现即自动收起，用户手动展开优先 | PASS |
| QAF-002 | 服务端将重复拒绝 `REJECTED` 草案视为幂等成功；其他终态重复审批返回 409 | PASS |
| QAF-003 | Run + ChangeSet 清理结果合并为单条 toast | PASS |
| QAF-004 | Session 恢复状态移入 `requestAnimationFrame`；移除未使用变量 | PASS |

最终门禁：`lint`、`typecheck`、production build、43 条 Node tests 全部通过。

## 8. 2026-07-16 展开执行记录运行时修复

**现象**：展开某次 Agent 执行记录时，React 报告
`Cannot update a component (AgentPanel) while rendering a different component (AgentProcessSteps)`。

**根因**：`AgentProcessSteps.toggleCollapsed` 在 `setCollapsed` 的 functional
updater 内调用 `onUserExpandChange`，该回调同步更新父组件 `AgentPanel`。React
可能在子组件渲染阶段执行 updater，因此禁止此时更新父组件。

**修复**：在点击事件阶段先计算 `nextCollapsed`，分别更新子组件状态并通知父组件；
functional updater 保持无副作用。项目级规则已写入
`.trellis/spec/frontend/component-guidelines.md`。

## 9. 2026-07-16 阶段节奏轨 UX 重构与复测

### 改造结果

- 扁平步骤卡改为三个用户语义阶段：理解需求、查阅信息、形成方案/结果。
- 每个真实工具调用继续按 `toolCallId` 一对一展示；同名工具不会合并。
- verification / decision 等 Loop 自检默认进入「技术记录」，原始事件未删除。
- 工具详情继续保留行动摘要、格式化参数和原始 JSON 三层披露。
- 失败状态优先于等待确认，避免失败与可确认状态同时出现时误导用户。
- ChangeSet 待确认层按原型重排；应用/拒绝后收为轻量只读处理回执。
- 确认/拒绝按钮提高到 44px 触控高度。

### 新增回归资产

- `src/lib/agent-process-presentation.ts`
- `src/lib/agent-process-presentation.test.tsx`

覆盖：三阶段投影、重复同名工具的 toolCallId 保真、状态优先级、收起摘要，以及组件渲染时不得通知父组件。

### 质量门禁

| 检查 | 结果 |
|---|---|
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm run build` | PASS，20 个静态页面生成成功 |
| 全量 Node tests | PASS，43/43 |
| `git diff --check` | PASS |

当前会话的 Browser 控制插件因初始化时 `process` 属性冲突无法连接，因此没有重新执行自动截图/点击矩阵；本次以生产构建、服务端组件渲染测试、状态投影测试和 CSS 响应式/无障碍静态检查替代。发布前仍建议在真实模型 Run 下手动复验 375px、1024px 与 ChangeSet 确认/拒绝一次。

## 10. 2026-07-16 草案视觉与日程规划增量 QA

### 覆盖结果

| 场景 | 验证 | 结果 |
|---|---|---|
| 宽屏用户气泡 | `agent-message-row.user` 占满内容列并由外层 `align-items:flex-end` 对齐；内层保持 75%/510px 上限 | PASS（结构与 CSS） |
| 草案待确认态 | 独立摘要头、选择工具栏、操作列表、审批 footer；审批按钮 44px | PASS（构建与静态检查） |
| 草案终态 | 去除大卡片边框/阴影，应用与放弃均收束为只读状态回执 | PASS（构建与静态检查） |
| 375px | 用户气泡上限 88%；审批区可换行；按钮可伸缩且无固定超宽 | PASS（响应式静态检查） |
| 未查日程直接提草案 | Runtime 返回 `SCHEDULE_WINDOW_REQUIRED`，不会执行 `propose_change_set` | PASS（自动化） |
| 查历史后直接提草案 | 要求在历史工具之后重新调用 `read_schedule_window` | PASS（自动化） |
| 习惯工具默认参数 | 90 天 / 12 条；无关键词或实体关联时 schema 拒绝 | PASS（自动化） |
| 历史时段聚合 | 用户时区、30 分钟起始桶、中位开始时间与时长、空结果 | PASS（自动化） |
| 饭点意识 | planning / adjustment 均包含 11:30–13:30、18:00–19:30 软约束与偏离说明 | PASS（policy 自动化） |

### 质量门禁

| 检查 | 结果 |
|---|---|
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| 全量 Node tests | PASS，51/51 |
| `npm run build` | PASS，20 个静态页面生成成功 |
| `git diff --check` | PASS |

### 受限项

Browser 控制运行时仍在初始化阶段报 `Cannot redefine property: process`，因此没有把桌面/375px 自动截图与真实点击确认标记为通过。生产构建、结构测试、CSS 检查及业务逻辑回归均已通过；发布前保留一次人工视觉复验：展开面板用户气泡右对齐、待确认草案、确认终态、放弃终态、375px 按钮换行。

## 11. 2026-07-16 Loop 状态投影收敛修复

**根因**：Runtime 为每个 Loop 轮次保留 verification / recovery / decision 审计事件；展示层此前把审计事件逐条当作用户步骤，并用原始历史中的任意失败决定整个过程状态。因此 proposal 首次失败、补查日程后成功时，会同时出现“未完成”和“已完成”；无工具终止也被错误显示成“验证工具结果”。

**修复**：

- proposal 重试在主流程中只显示最新一次；旧失败尝试保留在默认收起的技术记录
- recovery 和逐轮 verification 不再重复平铺，只保留最终语义判断
- 无工具终止改为 `确认处理结束`，旧会话记录同步做兼容投影
- 外层失败/确认状态改为读取阶段投影，已恢复失败不再污染当前状态

| 回归场景 | 结果 |
|---|---|
| 失败 proposal → 查日程 → proposal 成功 | PASS，主流程仅保留成功项，阶段为待确认 |
| 连续两轮工具验证 → 结束判断 | PASS，技术记录只保留最终判断 |
| 旧记录“没有新的工具调用” | PASS，显示为“确认处理结束” |
| 已恢复失败的过程头部 | PASS，不再显示“需要处理” |
| 全量 Node tests | PASS，55/55 |
| lint / typecheck / production build / diff check | PASS |

## 12. 2026-07-16 Header 同级会话操作

- 「新对话」与「清空上下文」从不同层级调整为 Header 并列操作
- 新对话：紫色新增对话图标；清空上下文：金色断链图标，避免误解为删除消息
- 两个操作共享 44px 高度、边框、hover/active/focus-visible 状态；移动端转为 44px 纯图标
- 欢迎态禁用清空上下文；移除更多菜单及其无用状态、外部点击监听

## 13. 2026-07-16 Agent 日程幻觉修复 QA

### 原始场景重放

| 检查 | 优化前 | 优化后 | 结果 |
|---|---|---|---|
| 《原则》历史查询 | query=`阅读` 混入 6 条下午/内容创作/PLANNED 数据 | exact=`阅读《原则》/原则阅读` 命中 2 条即停止 | PASS |
| 典型开始时间 | 混合中位数 19:08 | 22:45；样本为 22:30 与 23:00 | PASS |
| 7/16 晚间有效日程 | 11/12 条完整领域对象，含旧改期与窗口外 Routine | 3 条紧凑有效记录 | PASS |
| 忙碌区间 | 模型自行换算 UTC 并误判“19:30 后空闲” | 直接返回本地 19:30–20:00、20:30–22:10 | PASS |
| 可用区间 | 无确定性结论 | 18:00–19:30、20:00–20:30、22:10–24:00 | PASS |
| 具体推荐 | 查过窗口即可输出 | 必须 `validate_schedule_candidates` 且 allAvailable=true | PASS（自动化） |

### 自动化覆盖

- planner fallback 保留完整活动语义；exact 命中后不进入 related/broad
- 三层均为空时每层只执行一次，不重复 broad 查询
- timezone-less wall-clock 按 Asia/Shanghai 解析；显式 `Z` 保持绝对时刻
- 窗口外 Routine 与 RESCHEDULED 旧记录被过滤
- `[startsAt,endsAt)` 冲突与端点相接语义
- 未验证候选的文字推荐被 Runtime 拦截
- ChangeSet 缺少候选校验、校验仍冲突时返回结构化可重试错误

### 最终质量门禁

| 检查 | 结果 |
|---|---|
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| 全量 Node tests | PASS，66/66 |
| `npm run build` | PASS，20 个静态页面生成成功 |
| `git diff --check` | PASS |

真实数据库只读重放同样通过：exact 层命中 2 条《原则》完成记录后立即停止；7/16 18:00–24:00 投影为 3 条有效日程、2 个忙碌区间和 3 个可用区间。

## 14. 2026-07-16 Token 预算、工具证据压缩与线性过程 QA

### 自动化场景

| 场景 | 预期 | 结果 |
|---|---|---|
| 日程窗口压缩 | 保留本地窗口、日程标题/类型/起止、忙碌和可用区间；丢弃无关大字段 | PASS |
| 候选校验压缩 | 保留 `allAvailable`、精确候选时间与冲突日程 | PASS |
| 同范围重复查询 | 证据账本用最新结果替换旧结果 | PASS |
| 账本边界 | 最多 8 条且约 8k 字符，最新证据仍存在 | PASS |
| 展开过程 | planning、工具、恢复、下一工具按到达顺序展示 | PASS |
| 内部校验 | `verification-*` 不进入主时间线 | PASS |
| React 渲染 | 渲染期间不回调更新父组件 | PASS |

### 数据与预算契约

- planning / adjustment：64,000；review：48,000；progress：32,000；goal clarification：24,000。
- Runtime create 将 policy 的 `maxSteps/maxRunTokens` 写入 `AgentRun`，不再留下 `maxTokens=null`。
- `ToolCall.output` 仍接收原始 `ToolResult`；压缩只用于模型消息和 system 证据账本。
- 模型消息不再无限累计历史工具批次，仅保留最近一轮配对协议；更早事实由有界证据账本继续传递。
- 75% / 88% 水位分别提示停止重复查询和禁止新的探索性查询。

### 当前门禁

| 检查 | 结果 |
|---|---|
| 新增证据与时间线定向测试 | PASS，13/13 |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS，无 warning |
| `npm run typecheck` | PASS |
| 全量 Node tests | PASS，72/72 |
| `npm run build` | PASS，20 个静态页面生成成功 |
| `git diff --check` | PASS |
