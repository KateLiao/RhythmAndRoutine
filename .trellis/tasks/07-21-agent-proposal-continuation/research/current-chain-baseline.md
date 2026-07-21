# Current Chain Baseline

## Verified scenario

第一轮输入：安排当天四项活动。第二轮输入：`第一个日程可以从 10.15 开始，其他没问题`。

| Run | Loop | Tool calls | Input tokens | Output tokens | Total |
|---|---:|---:|---:|---:|---:|
| 初次安排 | 6 | 6 | 21,139 | 2,704 | 23,843 |
| 局部修订 | 4 | 3 | 12,764 | 1,562 | 14,326 |

第二轮重新读取全天日程、重新校验全部四个候选，并重新生成四项 ChangeSet。三个工具调用本身共约 83ms；主要成本来自四轮模型推理和重复上下文。

第一轮具体方案只有自然语言，没有 ChangeSet。第一轮还对两个关联目标分别重复读取两次，证明现有 evidence ledger 没有形成确定性只读缓存。

## Verified code causes

- `getContextMessages()` 只发送最近自然语言；process steps、ChangeSet operations 和工具证据不进入下一轮。
- `AgentRuntime.run()` 每次新建空 evidence ledger、successfulToolNames 和 successfulTools。
- schedule safety guard 只承认当前 Run 的工具成功序列。
- `resolveIntent()` 接收 recentMessages 但未使用，时间 slot 不完整支持 `10.15` 和单点开始时间。
- adjustment 使用 capability 级通用上下文与执行计划，没有 itinerary_create / proposal revision delta plan。
- ChangeSet operation 没有稳定 operation ID 或 revision/supersede 链。
- 创建型 schedule 在 apply 时没有对应窗口 fingerprint 的最终冲突校验。
