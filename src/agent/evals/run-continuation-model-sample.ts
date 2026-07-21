import { loadEnvConfig } from "@next/env";
import { FallbackModelAdapter } from "../fallback-model-adapter";
import { OpenAICompatibleAdapter } from "../openai-compatible-adapter";
import { validateReorderDecision, type ReorderContext, type ReorderDecision } from "../proposal-continuation";
import { resolveCapabilityProvider, resolveFallbackProvider } from "../provider-config";
import { generateReorderDecision, interpretAmbiguousProposalTime } from "@/server/services/proposal-continuation";

type Sample = {
  id: string;
  context: ReorderContext;
  semanticCheck: (decision: ReorderDecision) => boolean;
};

const dayWindow = { startsAt: "2026-07-20T22:00:00.000Z", endsAt: "2026-07-21T15:59:59.000Z" };
const samples: Sample[] = [
  {
    id: "continuation-model.reorder-before",
    context: {
      timezone: "Asia/Shanghai",
      instruction: "把银行放到阅读前面，具体时间你判断，保持各自时长",
      window: dayWindow,
      affectedOperations: [
        { operationId: "op-read", title: "阅读 LLM 论文", blockKind: "goal_task", durationMinutes: 90, currentStartsAt: "2026-07-21T02:30:00.000Z", currentEndsAt: "2026-07-21T04:00:00.000Z", fixed: false, explicitConstraints: [] },
        { operationId: "op-bank", title: "去银行", blockKind: "personal", durationMinutes: 60, currentStartsAt: "2026-07-21T06:00:00.000Z", currentEndsAt: "2026-07-21T07:00:00.000Z", fixed: false, explicitConstraints: [] },
      ],
      hardConstraints: ["保持每项原时长", "银行必须排在阅读之前", "不得与相邻提案重叠"],
      softConstraints: ["尽量避开午餐 11:30-13:30", "营业时间未经核实，只能作为显式假设"],
      availableIntervals: [{ startsAt: "2026-07-21T01:00:00.000Z", endsAt: "2026-07-21T08:15:00.000Z" }],
      neighboringProposalOperations: [{ operationId: "op-write", title: "写作", startsAt: "2026-07-21T08:30:00.000Z", endsAt: "2026-07-21T09:15:00.000Z" }],
    },
    semanticCheck: (decision) => {
      const candidates = new Map(decision.candidates.map((candidate) => [candidate.operationId, candidate]));
      return new Date(candidates.get("op-bank")?.startsAt ?? 0) < new Date(candidates.get("op-read")?.startsAt ?? 0);
    },
  },
  {
    id: "continuation-model.new-item",
    context: {
      timezone: "Asia/Shanghai",
      instruction: "在已有提案里新增 30 分钟散步，时间由你结合活动特点安排",
      window: dayWindow,
      affectedOperations: [
        { operationId: "op-new-walk", title: "散步", blockKind: "personal", durationMinutes: 30, currentStartsAt: "2026-07-21T06:00:00.000Z", currentEndsAt: "2026-07-21T06:30:00.000Z", fixed: false, explicitConstraints: ["当前时间只是日期锚点，需重新选择合理时段"] },
      ],
      hardConstraints: ["保持 30 分钟", "只修改新增项时间", "不得与相邻提案重叠"],
      softConstraints: ["尽量避开午餐和晚餐", "结合散步的活动语义选择时段"],
      availableIntervals: [
        { startsAt: "2026-07-21T04:00:00.000Z", endsAt: "2026-07-21T06:00:00.000Z" },
        { startsAt: "2026-07-21T07:00:00.000Z", endsAt: "2026-07-21T08:30:00.000Z" },
      ],
      neighboringProposalOperations: [
        { operationId: "op-read", title: "阅读", startsAt: "2026-07-21T02:30:00.000Z", endsAt: "2026-07-21T04:00:00.000Z" },
        { operationId: "op-write", title: "写作", startsAt: "2026-07-21T08:30:00.000Z", endsAt: "2026-07-21T09:15:00.000Z" },
      ],
    },
    semanticCheck: () => true,
  },
];

loadEnvConfig(process.cwd());
void main();

async function main() {
  let resolved: ReturnType<typeof resolveCapabilityProvider>;
  try {
    resolved = resolveCapabilityProvider("adjustment");
  } catch (error) {
    console.error(JSON.stringify({
      schemaVersion: 1,
      datasetVersion: "v0.4.1-continuation-model-sample-1",
      status: "blocked_before_request",
      reason: "provider_not_configured",
      message: error instanceof Error ? error.message : "模型供应商尚未配置。",
      requestsSent: 0,
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const fallback = resolveFallbackProvider(resolved.provider.id);
  const adapter = new FallbackModelAdapter(
    new OpenAICompatibleAdapter(resolved.provider),
    fallback ? { adapter: new OpenAICompatibleAdapter(fallback.provider), model: fallback.model } : undefined,
  );
  const results = [];
  for (const sample of samples) {
    let inputTokens = 0;
    let outputTokens = 0;
    let usageEvents = 0;
    let modelCalls = 0;
    const startedAt = Date.now();
    try {
      const onUsage = (usage: { inputTokens: number; outputTokens: number }) => {
        usageEvents += 1;
        inputTokens += usage.inputTokens;
        outputTokens += usage.outputTokens;
      };
      modelCalls += 1;
      let decision = await generateReorderDecision(adapter, resolved.model, sample.context, undefined, undefined, onUsage);
      let validation = validateReorderDecision(sample.context, decision);
      if (!validation.valid) {
        modelCalls += 1;
        decision = await generateReorderDecision(adapter, resolved.model, sample.context, undefined, { prior: decision, issues: validation.issues }, onUsage);
        validation = validateReorderDecision(sample.context, decision);
      }
      const semanticPassed = sample.semanticCheck(decision);
      results.push({
        id: sample.id,
        ok: validation.valid && semanticPassed,
        modelCalls,
        inputTokens,
        outputTokens,
        usageEvents,
        durationMs: Date.now() - startedAt,
        provider: adapter.activeProvider,
        model: resolved.model,
        semanticPassed,
        validationIssues: validation.issues,
        affectedOperationIds: decision.affectedOperationIds,
        candidates: decision.candidates,
        assumptions: decision.assumptions,
        reasoningSummary: decision.reasoningSummary,
      });
    } catch (error) {
      results.push({
        id: sample.id,
        ok: false,
        modelCalls,
        inputTokens,
        outputTokens,
        usageEvents,
        durationMs: Date.now() - startedAt,
        provider: adapter.activeProvider,
        model: resolved.model,
        error: error instanceof Error ? error.message : "真实模型抽样失败。",
      });
    }
  }
  {
    let inputTokens = 0;
    let outputTokens = 0;
    let usageEvents = 0;
    const startedAt = Date.now();
    try {
      const decision = await interpretAmbiguousProposalTime(adapter, resolved.model, {
        timezone: "Asia/Shanghai",
        currentLocalDateTime: "2026/07/21周二 13:45:00",
        instruction: "英语学习的开始时间推迟到 5 点半吧。",
        timeExpression: "5 点半",
        relation: "later",
        target: { operationId: "op-english", title: "英语学习", currentStartsAt: "2026-07-21T09:15:00.000Z", currentEndsAt: "2026-07-21T09:45:00.000Z", currentLocalRange: "17:15–17:45" },
        neighboringOperations: [{ operationId: "op-guitar", title: "吉他练习", startsAt: "2026-07-21T13:30:00.000Z", endsAt: "2026-07-21T14:30:00.000Z" }],
      }, undefined, (usage) => {
        usageEvents += 1;
        inputTokens += usage.inputTokens;
        outputTokens += usage.outputTokens;
      });
      results.push({
        id: "continuation-model.ambiguous-five-thirty",
        ok: decision.localTime === "17:30" && !decision.needsClarification,
        modelCalls: 1,
        inputTokens,
        outputTokens,
        usageEvents,
        durationMs: Date.now() - startedAt,
        provider: adapter.activeProvider,
        model: resolved.model,
        semanticPassed: decision.localTime === "17:30",
        affectedOperationIds: ["op-english"],
        assumptions: decision.assumptions,
        reasoningSummary: decision.reasoningSummary,
        localTime: decision.localTime,
      });
    } catch (error) {
      results.push({
        id: "continuation-model.ambiguous-five-thirty",
        ok: false,
        modelCalls: 1,
        inputTokens,
        outputTokens,
        usageEvents,
        durationMs: Date.now() - startedAt,
        provider: adapter.activeProvider,
        model: resolved.model,
        error: error instanceof Error ? error.message : "歧义时间真实模型抽样失败。",
      });
    }
  }

  const report = {
    schemaVersion: 1,
    datasetVersion: "v0.4.1-continuation-model-sample-2",
    generatedAt: new Date().toISOString(),
    status: results.every((result) => result.ok) ? "passed" : "failed",
    cases: results.length,
    passed: results.filter((result) => result.ok).length,
    modelCalls: results.reduce((sum, result) => sum + result.modelCalls, 0),
    inputTokens: results.reduce((sum, result) => sum + result.inputTokens, 0),
    outputTokens: results.reduce((sum, result) => sum + result.outputTokens, 0),
    durationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
    results,
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "passed" || results.some((result) => result.usageEvents < 1)) process.exitCode = 1;
}
