import { readFileSync } from "node:fs";
import { loadEnvConfig } from "@next/env";
import { FallbackModelAdapter } from "../fallback-model-adapter";
import { resolveIntent } from "../intent-resolver";
import { resolveIntentWithModel } from "../model-intent-resolver";
import { OpenAICompatibleAdapter } from "../openai-compatible-adapter";
import { resolveCapabilityProvider, resolveFallbackProvider } from "../provider-config";
import type { Capability } from "../types";

type RouterCase = {
  id: string;
  input: { message: string; page: "today" | "goals" | "goal-detail" | "task-detail" | "routines" | "review" | "settings"; selectedGoalId?: string };
  expected: { primaryCapability?: Capability; intents: Capability[] };
  tags: string[];
};

const allCases = readFileSync("src/agent/evals/fixtures/router.v0.4.0.jsonl", "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as RouterCase);
const sampleIds = ["router.multi.001", "router.multi.002", "router.multi.003", "router.multi.006", "router.multi.010", "router.multi.014", "router.multi.017", "router.single.009", "router.single.036", "router.single.072"];
const sample = sampleIds.map((id) => allCases.find((testCase) => testCase.id === id)).filter((testCase): testCase is RouterCase => Boolean(testCase));

loadEnvConfig(process.cwd());
void main();

async function main() {
  let resolved: ReturnType<typeof resolveCapabilityProvider>;
  try {
    resolved = resolveCapabilityProvider("adjustment");
  } catch (error) {
    console.error(JSON.stringify({
      schemaVersion: 1,
      datasetVersion: "v0.4.0-model-sample-1",
      status: "blocked_before_request",
      reason: "provider_not_configured",
      message: error instanceof Error ? error.message : "模型供应商尚未配置。",
      requestsSent: 0,
    }, null, 2));
    process.exitCode = 1;
    return;
  }
  const fallback = resolveFallbackProvider(resolved.provider.id);
  const adapter = new FallbackModelAdapter(new OpenAICompatibleAdapter(resolved.provider), fallback ? { adapter: new OpenAICompatibleAdapter(fallback.provider), model: fallback.model } : undefined);
  const results = [];
  for (const testCase of sample) {
    const rules = resolveIntent({ prompt: testCase.input.message, view: testCase.input.page, selectedGoalId: testCase.input.selectedGoalId });
    const startedAt = Date.now();
    const actual = await resolveIntentWithModel({ adapter, model: resolved.model, prompt: testCase.input.message, view: testCase.input.page, selectedGoalId: testCase.input.selectedGoalId, rules });
    const intentRecall = testCase.expected.intents.filter((intent) => actual.intents.some((candidate) => candidate.capability === intent)).length / Math.max(1, testCase.expected.intents.length);
    results.push({ id: testCase.id, expected: testCase.expected, actual: { primaryCapability: actual.primaryCapability, intents: actual.intents.map((intent) => intent.capability), source: actual.source, degraded: Boolean(actual.degraded) }, top1: actual.primaryCapability === testCase.expected.primaryCapability, intentRecall, durationMs: Date.now() - startedAt, provider: adapter.activeProvider, model: resolved.model });
  }
  const report = {
    schemaVersion: 1,
    datasetVersion: "v0.4.0-model-sample-1",
    generatedAt: new Date().toISOString(),
    cases: results.length,
    top1: results.filter((result) => result.top1).length / results.length,
    multiIntentRecall: results.reduce((sum, result) => sum + result.intentRecall, 0) / results.length,
    degraded: results.filter((result) => result.actual.degraded).length,
    results,
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.degraded > 0 || report.top1 < 0.8 || report.multiIntentRecall < 0.8) process.exitCode = 1;
}
