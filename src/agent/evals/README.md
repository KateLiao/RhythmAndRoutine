# Agent QA 评测与反馈流程

## 固定门禁

- `router.v0.4.0.jsonl`：120 例，覆盖五项能力、非执行问答与 20 个多意图请求。
- `planner.v0.4.0.jsonl`：30 例，检查步骤覆盖、依赖、工具白名单和用户确认屏障。
- `runtime.v0.4.0.jsonl`：30 例，检查并行批次、部分失败、读写混批、证据依赖与重复写入。
- `performance.v0.4.0.jsonl`：10 例，用稳定延迟注入比较串行/并行的 P50、P95。
- `continuation.v0.4.1.jsonl`：8 例，检查提案续接子意图、operation 定位，以及“未指定时间重排必须调用模型”的策略门禁。

每次变更运行 `npm run eval:agent`。脚本同时输出旧路由基线、当前候选、混淆矩阵、失败 ID、准确率、安全不变量和性能差值；任一门禁不通过即以非零状态结束。

发布前运行 `npm run eval:agent:model-sample` 抽样真实模型意图路由；涉及提案续接时再运行 `npm run eval:agent:continuation-model-sample`。后者只发送合成日程，检查模型真实调用、Token usage、结构化 ReorderDecision、operation allowlist、时长和用户指定顺序，不读取或修改业务数据库。

## 失败反馈闭环

1. 根据报告把失败定位到 `router / planner / policy / context / tool / runtime / response`。
2. 先复核期望答案。只有产品语义确实错误时才能修改 expected，并添加 `human-reviewed-expectation` 标签；不得为了过门禁删除困难样本。
3. 用户对线上结果提出纠正时，先脱敏，再由人工确认预期；未获授权的原始对话不得进入测试集。
4. 修复实现并重新跑完整固定集，保留基线对比和失败 ID。
5. 发布前使用固定模型、固定参数抽样真实模型场景。真实模型波动只作为发布证据，不替代确定性 PR 门禁。

## 指标解释

- Router：overall top-1、单能力 top-1、multi-intent recall、slot F1。
- Planner：必要步骤覆盖率与安全项通过率。
- Runtime：脚本化任务成功率、部分失败保留率、未授权写入与重复写入数。
- Performance：上下文 P50、合格工具批次 P95；速度提升必须与任务成功率一起判断。
- Token/成本：确定性规则阶段为 0 模型调用；真实模型抽样另行记录 input/output tokens，不能把缺失用量当作 0 成本。
