# Routine 模块需求优化说明

# 一、当前问题

当前版本中，Routine 的交互没有形成闭环。

目前 Agent 生成 Routine 后，只是把 Routine 展开成大量重复的 Schedule Block，并插入到日程中。这会带来几个问题：

1. Routine 本身没有独立的实体属性。
2. Routine 与普通 Task 在日历中表现形式一致，导致重复日程块过多，视觉上冗余。
3. Routine 的重复规则没有独立维护，修改 Routine 时无法区分“修改单次执行”与“修改整个重复计划”。
4. Routine 的执行情况没有被持续统计，用户无法看到坚持情况、完成率、断档情况和长期趋势。
5. Agent 无法基于 Routine 的执行记录进行有效分析，也无法判断是否需要降低门槛、调整频率或更换时间段。

因此，本次修改的目标是：将 Routine 从“重复生成的日程块”升级为一个独立的一等实体，并围绕 Routine 建立创建、重复、展示、执行、统计和 AI 分析的完整闭环。

---

## 二、核心设计原则

### 1. Routine 不是 Task

Task 是一次性、可完成、可验收的行动。

Routine 是需要长期重复、通过持续执行产生复利价值的行为模式。

例如：

* Task：今天 14:00-16:00 完成 Routine 数据模型设计。
* Routine：每天早上 9:00 练习英语口语 20 分钟。
* Routine：每周三次力量训练。
* Routine：每周六上午写一篇 Gap Log。

因此，Routine 不应该被简单拆成大量独立 Task，也不应该在数据层只表现为多个重复 Schedule Block。

### 2. Routine 是主实体，Schedule Block 是它的发生实例

Routine 负责定义长期重复规则。

Schedule Block 只负责承载某一次具体发生。

```text
Routine
  -> Routine Occurrence / Schedule Block
  -> Execution Record
  -> Rhythm Feedback
  -> Routine Stats
  -> AI Analysis
  -> Adjustment Suggestion
```

### 3. 日历视图中弱化 Routine 的视觉占用

Routine 是重复性的背景节奏，不应该像普通 Task 一样强势占据日历视觉注意力。

普通 Task 更接近“今天必须完成的具体行动”，需要更明确地显示。

Routine 更接近“长期节奏提醒”，应在日历中以更轻量、更弱化的方式显示。

---

## 三、Routine 实体属性设计

新增或重构 Routine 数据模型。

### Routine 基础字段

```ts
type Routine = {
  id: string
  title: string
  description?: string

  goalId?: string
  skillId?: string
  projectId?: string

  startDate: string
  endDate?: string

  durationMinutes: number

  recurrenceRule: RecurrenceRule

  preferredTime?: {
    startTime?: string
    endTime?: string
    timeOfDay?: 'morning' | 'afternoon' | 'evening' | 'night'
  }

  priority?: 'low' | 'medium' | 'high'

  status: 'active' | 'paused' | 'completed' | 'archived'

  displayMode?: 'subtle' | 'normal' | 'hidden_from_calendar'

  createdAt: string
  updatedAt: string
}
```

### RecurrenceRule 重复规则

重复规则参考 Apple Calendar / Google Calendar 的交互形式。

```ts
type RecurrenceRule = {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom'

  interval: number

  byWeekday?: Array<'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'>

  byMonthDay?: number[]

  endCondition: {
    type: 'never' | 'on_date' | 'after_count'
    endDate?: string
    count?: number
  }
}
```

示例：

```text
每天：
frequency = daily
interval = 1

每两天：
frequency = daily
interval = 2

每周一、三、五：
frequency = weekly
interval = 1
byWeekday = ['MO', 'WE', 'FR']

每月 1 号：
frequency = monthly
interval = 1
byMonthDay = [1]

每两周一次：
frequency = weekly
interval = 2
```

---

## 四、Routine 创建与编辑交互

### 1. 创建 Routine

用户可以通过两种方式创建 Routine：

#### 方式 A：手动创建

入口可以放在：

* Routine 页面
* 日历页面的新增按钮
* Goal / Skill 详情页中

创建表单字段：

```text
Routine 名称
关联目标 / 能力 / 项目
开始日期
结束日期，可选
重复方式
执行时长
建议执行时间
优先级
是否在日历中显示
```

重复方式参考 Apple Calendar：

```text
不重复
每天
每周
每月
每年
自定义
```

自定义重复需要支持：

```text
每 X 天
每 X 周，可选择周几
每 X 月，可选择每月几号
结束条件：永不结束 / 到某日期结束 / 执行 N 次后结束
```

#### 方式 B：Agent 创建

当 Agent 根据目标规划生成 Routine 时，不允许直接批量插入大量 Schedule Block。

Agent 应该生成 Routine Draft，由用户确认后写入 Routine 表。

Agent 输出结构应类似：

```json
{
  "type": "routine_draft",
  "title": "每天英语口语练习",
  "reason": "这个 Routine 可以帮助你持续提升英语表达流利度",
  "linkedGoal": "提升英语面试表达能力",
  "suggestedSchedule": {
    "startDate": "2026-06-22",
    "durationMinutes": 20,
    "recurrence": "daily",
    "preferredTime": "morning"
  }
}
```

用户确认后，系统创建 Routine，而不是直接创建一堆重复日程块。

---

## 五、Routine 与日历视图的关系

### 1. 不再预先生成大量 Schedule Block

不要在 Routine 创建时，把未来所有重复事件一次性写入 Schedule Block 表。

应采用“按时间范围动态展开”的方式。

例如：

用户打开本周日历时，系统根据 Routine 的 recurrenceRule 计算本周会出现哪些 Routine Occurrence。

```text
Routine Definition
  -> expand occurrences for current calendar range
  -> render on calendar
```

这样可以避免数据库中产生大量冗余时间块，也方便后续修改整个 Routine。

### 2. Routine Occurrence 是虚拟实例

Routine Occurrence 不一定需要提前落库。

只有当用户对某一次 Routine 做出操作时，才需要生成对应记录。

需要落库的情况包括：

```text
用户标记完成
用户跳过
用户改期
用户修改某一次
用户添加执行反馈
用户补充备注
```

### 3. 单次修改与整体修改

编辑 Routine Occurrence 时，需要提供类似日历应用的选择：

```text
只修改这一次
修改这一次及之后
修改整个 Routine
```

MVP 阶段可以优先实现：

```text
只修改这一次
修改整个 Routine
```

暂缓实现“这一次及之后”。

### 4. Routine 在日历中的展示方式

Routine 在日历中需要弱化显示效果，与普通 Task 区分。

#### 普通 Task 时间块

特点：

```text
视觉权重较高
实色背景
明确边框
显示任务标题
显示关联目标或项目
```

#### Routine 时间块

特点：

```text
视觉权重较低
浅色背景或半透明背景
虚线边框或细边框
左侧使用小圆点 / 细竖线标识
标题前可加循环图标
不抢占主要视觉注意力
```

建议 UI 文案：

```text
↻ 英语口语练习
↻ 控笔练习
↻ 力量训练
```

如果同一天 Routine 较多，可以折叠显示：

```text
3 个 Routine
```

点击后展开查看。

### 5. 日历视图筛选

日历页面增加筛选项：

```text
显示 Task
显示 Routine
显示 Review
显示已完成
隐藏 Routine
```

默认：

```text
Task 正常显示
Routine 弱化显示
已完成 Routine 可进一步降低透明度
```

---

## 六、Routine 执行交互

用户点击某个 Routine Occurrence 后，打开执行卡片。

### Routine 执行卡片字段

```text
Routine 名称
关联目标 / 能力
计划时间
计划时长
当前连续完成天数 / 周数
最近完成情况
操作按钮
```

### 操作按钮

```text
完成
跳过
改期
今天不做
添加反馈
```

### 完成后记录 Execution Record

```ts
type RoutineExecutionRecord = {
  id: string
  routineId: string
  occurrenceDate: string

  plannedStartTime?: string
  plannedEndTime?: string

  status: 'completed' | 'skipped' | 'missed' | 'rescheduled'

  actualDurationMinutes?: number

  feedback?: RhythmFeedback

  note?: string

  createdAt: string
  updatedAt: string
}
```

### Rhythm Feedback

Routine 完成后，提供轻量反馈。

```text
顺畅
有阻力
勉强完成
状态很好
状态很差
被打断
没开始
```

用户可以补充一句自然语言说明。

示例：

```text
今天虽然完成了，但启动很困难。
晚上训练可以，但训练后不适合继续写代码。
早上练口语更自然，晚上容易拖延。
```

---

## 七、Routine 独立页面 / 模块

新增 Routine 页面，或者在现有 Goal 页面中新增 Routine 模块。

MVP 建议先做独立 Routine 页面。

### 页面入口

主导航新增：

```text
Routine
```

### Routine 页面结构

#### 1. Routine 列表区

展示所有 active Routine。

每个 Routine Card 显示：

```text
Routine 名称
关联目标 / 能力
重复规则
开始日期
当前状态
近 7 次完成情况
连续完成次数
完成率
下一次计划时间
```

示例：

```text
英语口语练习
每天 · 20 分钟 · 早上
关联目标：提升英语面试表达能力
近 7 次：✅ ✅ ✅ — ✅ ❌ ✅
连续完成：3 天
近 30 天完成率：76%
下一次：明天 09:00
```

#### 2. Routine 详情页

点击 Routine Card 进入详情页。

详情页包含：

```text
基础信息
重复规则
关联目标
执行统计
执行记录时间线
AI 分析
调整建议
```

---

## 八、Routine 统计数据

Routine 需要有独立统计能力。

### 统计指标

MVP 需要支持：

```text
总计划次数
总完成次数
总跳过次数
总错过次数
完成率
当前连续完成次数
最长连续完成次数
近 7 天完成率
近 30 天完成率
最近一次完成时间
最容易完成的时间段
最容易失败的时间段
```

### 可视化方式

MVP 可以先用简单卡片和列表，不必做复杂图表。

建议模块：

```text
本周完成情况
近 30 天趋势
连续完成记录
失败 / 跳过原因
AI 总结
```

### 统计口径

```text
完成率 = completed / planned_occurrences

planned_occurrences = 根据 Routine recurrenceRule 在统计时间范围内展开得到的计划次数

missed = 到了计划日期之后，用户没有完成、跳过或改期的 occurrence
```

注意：

如果用户主动标记“今天不做”，可以记为 skipped。

如果用户没有任何操作，过期后系统自动视为 missed。

---

## 九、AI 分析与调整建议

Routine 页面需要展示 AI Analysis 模块。

### AI 分析输入

AI 分析 Routine 时，需要读取：

```text
Routine 基础信息
重复规则
关联目标
近 7 天 / 近 30 天执行记录
Rhythm Feedback
跳过 / 错过原因
用户自然语言备注
相关目标进展
```

### AI 分析输出

AI Analysis 输出包括：

```text
坚持情况总结
主要阻力
适合执行的时间段
当前频率是否过高
是否建议降低门槛
是否建议调整时间
是否建议暂停或归档
下一步建议
```

示例：

```text
过去 30 天你计划完成 20 次英语口语练习，实际完成 13 次，完成率为 65%。从反馈看，晚上练习时更容易出现拖延和羞耻感，早上完成率更高。

建议将这个 Routine 从晚上调整到早上，并把单次时长从 20 分钟降低到 10 分钟，先恢复稳定性。
```

### AI 不直接修改 Routine

AI 只能生成 Adjustment Suggestion。

用户确认后，系统才修改 Routine。

```text
AI Analysis
  -> Adjustment Suggestion
  -> User Confirmation
  -> Update Routine
```

---

## 十、需要 Coding Agent 修改的内容

### 1. 数据模型

新增或重构以下模型：

```text
Routine
RecurrenceRule
RoutineExecutionRecord
RhythmFeedback
RoutineAdjustmentSuggestion
```

不要再把 Routine 简单实现为一组重复 Schedule Block。

### 2. 日历展开逻辑

实现基于 recurrenceRule 的 occurrence expansion。

输入：

```text
routine
calendarRangeStart
calendarRangeEnd
```

输出：

```text
RoutineOccurrence[]
```

RoutineOccurrence 可以是虚拟对象。

只有用户对某一次 occurrence 做操作时，才创建 RoutineExecutionRecord 或 Schedule Exception。

### 3. 日历 UI

修改日历中的事件渲染逻辑：

```text
Task Block 使用当前强视觉样式
Routine Block 使用弱化样式
Routine 标题前加重复标识
支持隐藏 / 显示 Routine
支持多个 Routine 折叠
```

### 4. Routine 创建表单

新增 Routine 创建和编辑表单。

支持：

```text
名称
关联目标 / 能力 / 项目
开始日期
结束日期
重复方式
执行时长
建议执行时间
优先级
日历显示方式
```

重复方式至少支持：

```text
每天
每周
每月
自定义每周几
结束日期
永不结束
```

### 5. Routine 执行交互

点击 Routine Occurrence 后，打开执行卡片。

支持：

```text
完成
跳过
改期
添加反馈
```

完成或跳过后写入 RoutineExecutionRecord。

### 6. Routine 页面

新增 Routine 独立页面。

至少包含：

```text
Routine 列表
Routine 详情
执行统计
执行记录
AI 分析区域
调整建议确认入口
```

### 7. Agent 输出结构

修改 Agent 规划能力。

当 Agent 生成 Routine 时，输出 Routine Draft，而不是直接批量创建 Schedule Block。

Agent 创建 Routine 的输出结构需要包含：

```text
Routine title
关联目标
建议重复规则
建议开始日期
建议执行时长
建议时间段
创建理由
```

用户确认后写入 Routine。

### 8. 验收标准

本次修改完成后，需要满足以下验收标准：

1. 用户可以创建一个带开始日期、结束日期和重复规则的 Routine。
2. Routine 支持每天、每周、每月和自定义重复。
3. Routine 不会在数据库中提前生成大量重复 Schedule Block。
4. 日历可以根据当前视图范围动态展示 Routine Occurrence。
5. Routine 在日历中的视觉表现明显弱于普通 Task。
6. 用户可以隐藏或显示 Routine。
7. 用户可以对某一次 Routine 标记完成、跳过、改期或添加反馈。
8. 系统可以统计 Routine 的完成率、连续完成次数、近 7 天和近 30 天表现。
9. 用户可以在 Routine 页面查看每个 Routine 的执行效果。
10. AI 可以基于 Routine 执行记录生成分析和调整建议。
11. AI 不直接修改 Routine，必须等待用户确认。
12. 修改 Routine 时，系统需要区分“只修改这一次”和“修改整个 Routine”。

---

## 十一、MVP 实现优先级

### P0：必须实现

```text
Routine 独立实体
开始日期 / 结束日期
每天 / 每周 / 每月重复
日历动态展开 Routine Occurrence
Routine 弱化显示
Routine 完成 / 跳过记录
Routine 页面基础列表
完成率和连续完成统计
Agent 生成 Routine Draft
```

### P1：重要但可以后置

```text
自定义复杂重复规则
Routine 详情页完整统计
AI Analysis
Adjustment Suggestion
单次修改 vs 整体修改
隐藏 / 显示 Routine 筛选
```

### P2：后续增强

```text
热力图
长期趋势图
Routine 与 Goal 进展因果分析
自动识别最佳执行时间段
连续失败后自动建议降低门槛
游戏化成就系统
```

---

## 十二、本次修改的产品目标

本次修改后，Routine 不再只是“日历里的重复时间块”，而应该成为系统中能够长期追踪、分析和调整的核心实体。

用户应该能够回答三个问题：

1. 我正在坚持哪些 Routine？
2. 这些 Routine 最近执行得怎么样？
3. 系统是否能根据我的执行情况，帮助我调整到更容易坚持的节奏？

这才是 Rhythm & Routine 中 Routine 模块真正应该形成的闭环。
