# V0.4.0 Agent 能力矩阵

> 本矩阵只列出当前代码可以证明的能力。候选优化放在后半部分，不把规划中的能力写成既有事实。

## 1. 当前能力项

| Capability | 用户意图 | 必要上下文 | 当前允许工具 | 输出/副作用 | 确认边界 | 主要失败模式 | 可观测证据 |
|---|---|---|---|---|---|---|---|
| `goal_clarification` | 澄清目标、范围、成功标准、限制 | goals | `read_goal_context` | 问题、建议；无正式写入 | 无直接写入 | 关键词误路由、重复询问已有信息、把结构缺口当阻塞 | capability、steps、tool calls、final text |
| `planning` | 把目标拆成 Outcome/Milestone/Task/Routine | goals, schedule | goal/schedule/history 读取、候选校验、`propose_planning` | 规划 ChangeSet 草案 | 用户确认 ChangeSet 后生效 | 缺少依赖显式化、日程证据顺序错误、拆得过细 | planning draft、ChangeSet、tool sequence |
| `review` | 回看执行与反馈、给出调整建议 | schedule, executions, reviews, rhythmSignals | execution/schedule/review/signal 读取、`propose_change_set` | 回顾解释或调整草案 | 不替用户确认 Outcome/Milestone；变更走 ChangeSet | 与确定性 Review 流程混淆、页面上下文压过明确消息 | read facts、ChangeSet、run trace |
| `adjustment` | 调整日程、任务或 Routine | 全上下文 | 六类读取/校验、`propose_change_set` | 调整 ChangeSet | 所有业务变化待确认 | 默认兜底吸收无关请求、资源冲突、写前未重新验证 | validation result、ChangeSet、tool errors |
| `progress_evaluation` | 判断是否在轨、阻塞、偏离或待确认 | goals, executions, reviews, rhythmSignals | 四类只读工具 | 解释与建议，无正式写入 | 不直接完成阶段成果 | 用投入冒充完成、无法处理多意图、缺少结构化判定 | facts、final text、exit reason |

## 2. 当前工具属性

| 工具 | 风险 | 主要资源 | 首发可并行性 | 依赖/限制 |
|---|---|---|---|---|
| `read_goal_context` | read | goal tree | 可与独立读取并行 | 目标 ID 必须可解析 |
| `read_schedule_window` | read | user schedule/window | 可与独立读取并行 | 候选校验前必须有对应窗口证据 |
| `read_similar_schedule_history` | read | historical schedule | 可与独立读取并行 | 规划场景中通常先于候选生成 |
| `validate_schedule_candidates` | read/system validation | candidate set + schedule evidence | 不可与其前置读取并行 | 依赖候选与最新窗口证据 |
| `read_execution_history` | read | execution records | 可与独立读取并行 | 注意普通/Routine 双来源 |
| `read_recent_reviews` | read | reviews | 可与独立读取并行 | Review 暂无 Goal FK |
| `read_rhythm_signals` | read | rhythm signals | 可与独立读取并行 | 无直接写入 |
| `propose_planning` | draft_write | planning draft/ChangeSet | 串行 | 需要最新读取与校验；待用户确认 |
| `propose_change_set` | draft_write | ChangeSet | 串行 | 需要最新证据；待用户确认 |

## 3. Agent Loop 与确定性工作流边界

- Agent Loop 适合：自然语言意图不确定、需要组合读取、需要解释与生成草案的任务。
- 确定性工作流适合：Review 状态流转、ChangeSet 应用、日程冲突校验、权限、幂等、Milestone 用户确认等硬约束。
- 路由、计划和解释可以使用模型；权限、依赖、写入屏障、证据新鲜度和最终完成判定必须由代码验证。

## 4. V0.4.0 新增的可测能力（完成后）

| 能力 | 结构化产物 | 验证方式 |
|---|---|---|
| 意图解析 | `IntentResolution` | golden router dataset、混淆矩阵、slot scorer |
| 多意图拆解 | `ExecutionPlan` | 必要步骤/依赖/确认点确定性校验 |
| 安全并行读取 | `ExecutionBatch` | mock tools、时序、故障和重复写入不变量 |
| 部分失败恢复 | per-step result + retry decision | 脚本化 runtime scenario |
| 性能基线 | stage timings + tokens/tool counts | baseline/experiment 对比报告 |

这些项目在实现完成前不得出现在产品能力介绍中。
