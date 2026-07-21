# Goal “待澄清 / 已确认”状态决策分析

## 1. 问题重述

用户需要知道目标现在是否正在发生，而不是系统认为这份目标结构是否已经写完整。

当前 `draft` 被展示为“待澄清”，但它不阻止任务、Routine、日程与执行，因此页面状态与真实行为冲突。

## 2. 已验证事实

### 2.1 `DRAFT` 没有形成行为边界

- 手动创建 Goal 固定写入 `DRAFT`（`src/server/services/goals.ts:37`）。
- `assertGoalOwner`、Task/Routine 创建与 Schedule 关联只检查 Goal 存在且未归档，不检查 Goal.status（`src/server/services/goals.ts:216-218`、`src/server/services/schedule.ts:581-586`）。
- 当前数据库 4 个 DRAFT 目标中：健身已有 210 分钟投入，阅读表达已有 455 分钟，吉他已有 235 分钟，精神状态 Routine 已完成 8 次。
- 因此 DRAFT 不能被解释为“还没开始”“不可执行”或“尚未推进”。

### 2.2 手动与 Agent 路径不一致

- 手动创建 Goal → DRAFT。
- Agent `propose_planning` 确认后把 Goal 更新为 active（`src/agent/tool-registry.ts:82`）。
- ChangeSet 新建 Goal 直接 ACTIVE（`src/server/services/change-sets.ts:206`）。
- 用户是否看到“待澄清”取决于创建路径，不取决于目标事实。

### 2.3 DRAFT 不只是文案问题，还造成事实遗漏

- 目标列表/详情把 active 显示为“推进中”、draft 显示为“待澄清”（`src/components/product-shell.tsx:1433,1475`）。
- 首页慢洞察和本周轨道只统计 active 目标（`src/server/services/home-insights-facts.ts:224`、`src/lib/home-insights/compute-weekly.ts:48,95`）。
- 已经真实投入的 draft 目标因此可能不进入目标投入与偏航判断。

### 2.4 “已确认”没有稳定确认对象

Goal 的标题、说明、Outcome、Milestone、Task 和 Routine 都可继续修改。若保存“已确认”，系统必须回答究竟确认了哪一版结构；当前没有 readiness 快照、confirmedAt 或确认版本。

为此增加独立确认状态会制造一个很快过期的事实，并增加迁移、交互和 Agent 权限复杂度，但没有解决用户下一步要做什么。

## 3. 方案比较

| 方案 | 优点 | 问题 | 结论 |
|---|---|---|---|
| 保留并解释文案 | 代码改动小 | 仍然没有行为差异，无法解释已投入的 draft | 不采用 |
| 只隐藏 UI 标签 | 立即减少困惑 | 首页/Agent 筛选仍遗漏，手动/Agent 写入仍分叉 | 不采用 |
| 新增独立 readiness/confirmed 字段 | 语义上可拆维度 | 确认对象会过期，产品复杂度高，现阶段无实际约束价值 | 不采用 |
| 删除 readiness 语义，status 只表达生命周期 | 与真实行为一致；减少状态；修复洞察遗漏 | 需要迁移 DRAFT 和清理跨层契约 | 推荐 |

## 4. 推荐产品模型

### 4.1 Goal 只保留生命周期

```text
ACTIVE → PAUSED → ACTIVE
ACTIVE/PAUSED → COMPLETED
任何非归档状态 → ARCHIVED
```

- 新建目标默认 ACTIVE，页面显示“推进中”。
- 不新增“已确认”字段，也不显示“已确认”作为 Goal 主状态。
- 保留 paused/completed/archived，因为它们会改变用户下一步行为与查询范围。

### 4.2 规划信息缺口改为动态、非阻塞提示

Goal 结构可以不完整，但系统可根据当前字段派生 `planningHints`：

- 缺少 Outcome：提示“补充成功标准，小律才能判断阶段成果”。
- 缺少 Milestone：提示“可以增加一个阶段检查点”。
- 项目型目标缺少 targetDate：提示“如果有期限，可以补充日期”。
- 已经有真实执行时，文案必须承认事实：“这个目标已经开始推进；补充结构可让后续建议更准确。”

这些提示：

- 不存为 Goal 状态；
- 不出现在列表主状态位置；
- 不阻止手动任务、日程或执行；
- Agent 在具体请求中按缺失信息决定继续推断还是追问。

### 4.3 迁移策略

推荐硬删除 DRAFT 语义，而非长期软删除：

1. 数据迁移：所有现存 `GoalStatus.DRAFT` → `ACTIVE`。
2. 默认值：Goal.status 默认改为 ACTIVE。
3. API/类型：移除 draft 输入与客户端联合类型。
4. UI：移除“待澄清”标签与 draft 样式。
5. Agent/ChangeSet：规划不再负责激活 Goal，去除 `status: active` 的隐式副作用。
6. 洞察：生命周期 active 目标全部参与目标投入统计。
7. PostgreSQL enum：通过新 enum 类型迁移移除 DRAFT；若发布回滚风险较高，可将 enum 清理拆成紧随其后的兼容迁移，但产品和代码不得继续产生 DRAFT。
8. browser-local：读取旧 localStorage 时把 draft 归一化为 active。

没有字段内容损失：DRAFT 当前没有独有数据，迁移只改变生命周期分类。

## 5. 验收场景

1. 手动新建一个只有标题的目标：立即显示“推进中”，可以继续补充结构。
2. 目标缺少 Outcome：详情给出非阻塞补充建议，不显示“待澄清”。
3. 旧 DRAFT 且已有投入：迁移后为 ACTIVE，历史投入和成就不变，并进入首页目标投入统计。
4. Agent 为已有目标生成规划：只创建/更新结构化内容，不额外切换 Goal readiness。
5. 暂停目标：列表显示“已暂停”，首页不把它当当前推进目标；恢复后重新进入 active。
6. 本地旧数据含 draft：客户端加载时归一化，不崩溃、不继续显示旧标签。

## 6. 决策状态

2026-07-20 用户确认删除，并明确要求不得影响当前数据。

迁移采用扩展/收缩流程：

1. 先部署兼容代码：停止新写 DRAFT，读取旧 draft 时按 active 展示；旧客户端提交 draft 时在兼容期归一化为 active。
2. 迁移前生成数据库可恢复备份，并记录所有相关表的 row count、主键集合、关系计数和 Goal 非 status 字段摘要。
3. 在事务中将现存 DRAFT 更新为 ACTIVE，并把默认值改为 ACTIVE。
4. 以执行前 JSON 快照逐行验证所有相关实体；2026-07-20 实施前计数为 7 Goal、13 Outcome、21 Milestone、51 Task、7 Routine、18 RoutineExecutionRecord、100 ScheduleBlock、54 ScheduleBlockTask、57 ExecutionRecord，只允许 4 个 Goal 的 status 从 DRAFT 变为 ACTIVE。
5. 稳定验证后再通过 enum 替换迁移删除 PostgreSQL `GoalStatus.DRAFT`，随后移除 API、TypeScript 与 browser-local 兼容分支。
6. 任一基线校验失败立即停止收缩迁移，并使用备份恢复；不得继续发布。
