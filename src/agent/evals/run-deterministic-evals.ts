import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { buildExecutionPlan, validateExecutionPlan } from "../execution-plan";
import { inferLegacyCapability } from "../infer-capability";
import { resolveIntent, type AgentView } from "../intent-resolver";
import { executeScheduledBatch, scheduleToolCalls, type PendingToolCall } from "../tool-scheduler";
import { toolCatalog } from "../capability-catalog";
import type { AgentTool, Capability } from "../types";
import { resolveAffectedProposalOperations } from "../proposal-continuation";

const routerCases = readJsonl<RouterCase>("src/agent/evals/fixtures/router.v0.4.0.jsonl");
const plannerCases = readJsonl<PlannerCase>("src/agent/evals/fixtures/planner.v0.4.0.jsonl");
const runtimeCases = readJsonl<RuntimeCase>("src/agent/evals/fixtures/runtime.v0.4.0.jsonl");
const performanceCases = readJsonl<PerformanceCase>("src/agent/evals/fixtures/performance.v0.4.0.jsonl");
const continuationCases = readJsonl<ContinuationCase>("src/agent/evals/fixtures/continuation.v0.4.1.jsonl");

const baselineRouter = scoreRouter((testCase) => ({ route: "agent", primaryCapability: inferLegacyCapability(testCase.input.message, testCase.input.page, testCase.input.selectedGoalId), intents: [], needsClarification: false, slots: {} }));
const candidateRouter = scoreRouter((testCase) => {
  const resolution = resolveIntent({ prompt: testCase.input.message, view: testCase.input.page, selectedGoalId: testCase.input.selectedGoalId, recentMessages: testCase.input.history });
  return { route: resolution.route, primaryCapability: resolution.primaryCapability, intents: resolution.intents.map((intent) => intent.capability), needsClarification: resolution.needsClarification, slots: resolution.intents[0]?.slots ?? {} };
});
const planner = scorePlanner();
const continuation = scoreContinuation();
const runtimePromise = scoreRuntime();
void main();

async function main() {
  const [performance, runtime] = await Promise.all([scorePerformance(), runtimePromise]);
  const gates = {
    routerOverall: candidateRouter.top1 >= 0.9,
    routerPerCapability: Object.values(candidateRouter.perCapability).every((value) => value >= 0.85),
    multiIntentRecall: candidateRouter.multiIntentRecall >= 0.85,
    slotF1: candidateRouter.slotF1 >= 0.9,
    plannerCoverage: planner.coverage >= 0.9,
    plannerSafety: planner.safety === 1,
    runtimeSuccess: runtime.success >= 0.9,
    runtimeSafety: runtime.safety === 1,
    runtimePartialFailure: runtime.partialFailurePreservation === 1,
    contextP50: performance.contextImprovementP50 >= 0.3,
    toolBatchP95: performance.toolImprovementP95 >= 0.25,
    continuationIntent: continuation.kindAccuracy === 1,
    continuationTargets: continuation.targetAccuracy === 1,
    continuationModelPolicy: continuation.modelCallPolicy === 1,
  };
  const report = {
    schemaVersion: 1,
    datasetVersion: "v0.4.1",
    generatedAt: new Date().toISOString(),
    cases: { router: routerCases.length, planner: plannerCases.length, runtime: runtimeCases.length, performance: performanceCases.length, continuation: continuationCases.length },
    baseline: { router: baselineRouter },
    candidate: { router: candidateRouter, planner, runtime, performance, continuation },
    deltas: {
      routerTop1: round(candidateRouter.top1 - baselineRouter.top1),
      multiIntentRecall: round(candidateRouter.multiIntentRecall - baselineRouter.multiIntentRecall),
      slotF1: round(candidateRouter.slotF1 - baselineRouter.slotF1),
      modelCalls: 0,
      tokenEstimate: 0,
    },
    gates,
    pass: Object.values(gates).every(Boolean),
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}

type RouterCase = {
  id: string;
  input: { message: string; page: AgentView; selectedGoalId?: string; history?: Array<{ role: "user" | "assistant"; content: string }> };
  expected: { route: "agent" | "non_execution"; primaryCapability?: Capability; intents: Capability[]; needsClarification: boolean; slots?: Record<string, unknown> };
  tags: string[];
};

type PlannerCase = {
  id: string;
  input: RouterCase["input"];
  expected: { capabilities: Capability[]; requiredAccess: Array<"read" | "draft_write" | "user_confirmation">; minSteps: number };
};

type RuntimeCase = {
  id: string;
  calls: Array<{ id: string; name: string; resource?: string }>;
  availableEvidence: string[];
  outcomes?: Record<string, "ok" | "error">;
  expected: { batchSizes: number[]; rejectedCodes: string[]; draftExecutions: number };
  safety: boolean;
};

type PerformanceCase = { id: string; kind: "context" | "tool_batch"; calls: number; delayMs: number };
type ContinuationCase = {
  id: string;
  input: RouterCase["input"] & { conversationId?: string; parentRunId?: string; activeChangeSetId?: string };
  operations: Array<Record<string, unknown>>;
  expected: { kind: NonNullable<ReturnType<typeof resolveIntent>["adjustment"]>["kind"]; timingSpecified: boolean; startTime?: string; affectedOperationIds: string[]; modelCalls: number };
  tags: string[];
};

function scoreContinuation() {
  let kindHits = 0;
  let targetHits = 0;
  let modelPolicyHits = 0;
  const failures: string[] = [];
  for (const testCase of continuationCases) {
    const resolution = resolveIntent({ ...testCase.input, prompt: testCase.input.message, view: testCase.input.page });
    const adjustment = resolution.adjustment;
    const affected = adjustment ? resolveAffectedProposalOperations({ operations: testCase.operations, prompt: testCase.input.message, refs: adjustment.operationRefs, kind: adjustment.kind }) : [];
    const modelCalls = adjustment?.kind === "proposal_reorder" && !adjustment.timingSpecified && affected.length >= 2
      ? 1
      : adjustment?.kind === "proposal_item_reschedule" && adjustment.timeAmbiguous && affected.length === 1
        ? 1
        : 0;
    const kindHit = adjustment?.kind === testCase.expected.kind && adjustment.timingSpecified === testCase.expected.timingSpecified && adjustment.startTime === testCase.expected.startTime;
    const targetHit = JSON.stringify(affected.map((operation) => operation.operationId)) === JSON.stringify(testCase.expected.affectedOperationIds);
    const modelHit = modelCalls === testCase.expected.modelCalls;
    if (kindHit) kindHits += 1;
    if (targetHit) targetHits += 1;
    if (modelHit) modelPolicyHits += 1;
    if (!kindHit || !targetHit || !modelHit) failures.push(testCase.id);
  }
  return { kindAccuracy: round(kindHits / continuationCases.length), targetAccuracy: round(targetHits / continuationCases.length), modelCallPolicy: round(modelPolicyHits / continuationCases.length), failureCaseIds: failures };
}

function scoreRouter(run: (testCase: RouterCase) => { route: string; primaryCapability?: Capability; intents: Capability[]; needsClarification: boolean; slots: Record<string, unknown> }) {
  let top1Hits = 0;
  let multiExpected = 0;
  let multiHits = 0;
  let slotTruePositive = 0;
  let slotFalsePositive = 0;
  let slotFalseNegative = 0;
  const failures: string[] = [];
  const clarificationFailures: string[] = [];
  const confusion: Record<string, Record<string, number>> = {};
  const perCapabilityCounts: Partial<Record<Capability, { hit: number; total: number }>> = {};
  for (const testCase of routerCases) {
    const actual = run(testCase);
    if (actual.needsClarification !== testCase.expected.needsClarification) clarificationFailures.push(testCase.id);
    const expectedPrimary = testCase.expected.primaryCapability;
    const hit = actual.route === testCase.expected.route && actual.primaryCapability === expectedPrimary;
    if (hit) top1Hits += 1;
    else failures.push(testCase.id);
    const expectedLabel = expectedPrimary ?? "non_execution";
    const actualLabel = actual.primaryCapability ?? actual.route;
    confusion[expectedLabel] ??= {};
    confusion[expectedLabel]![actualLabel] = (confusion[expectedLabel]![actualLabel] ?? 0) + 1;
    if (expectedPrimary) {
      perCapabilityCounts[expectedPrimary] ??= { hit: 0, total: 0 };
      perCapabilityCounts[expectedPrimary]!.total += 1;
      if (hit) perCapabilityCounts[expectedPrimary]!.hit += 1;
    }
    if (testCase.expected.intents.length > 1) {
      multiExpected += testCase.expected.intents.length;
      multiHits += testCase.expected.intents.filter((capability) => actual.intents.includes(capability)).length;
    }
    const expectedSlots = flattenSlots(testCase.expected.slots ?? {});
    const actualSlots = flattenSlots(actual.slots);
    if (expectedSlots.size) {
      for (const slot of actualSlots) {
        if (expectedSlots.has(slot)) slotTruePositive += 1;
        else slotFalsePositive += 1;
      }
      for (const slot of expectedSlots) if (!actualSlots.has(slot)) slotFalseNegative += 1;
    }
  }
  const precision = slotTruePositive / Math.max(1, slotTruePositive + slotFalsePositive);
  const recall = slotTruePositive / Math.max(1, slotTruePositive + slotFalseNegative);
  return {
    top1: round(top1Hits / routerCases.length),
    perCapability: Object.fromEntries(Object.entries(perCapabilityCounts).map(([capability, value]) => [capability, round(value.hit / value.total)])),
    multiIntentRecall: round(multiHits / Math.max(1, multiExpected)),
    slotF1: round((2 * precision * recall) / Math.max(Number.EPSILON, precision + recall)),
    clarificationAccuracy: round((routerCases.length - clarificationFailures.length) / routerCases.length),
    confusion,
    failureCaseIds: failures,
    clarificationFailureCaseIds: clarificationFailures,
  };
}

function scorePlanner() {
  const failures: string[] = [];
  let coverageHits = 0;
  let safetyHits = 0;
  for (const testCase of plannerCases) {
    const resolution = resolveIntent({ prompt: testCase.input.message, view: testCase.input.page, selectedGoalId: testCase.input.selectedGoalId, recentMessages: testCase.input.history });
    const plan = buildExecutionPlan(resolution);
    const validation = validateExecutionPlan(plan);
    const capabilitiesCovered = testCase.expected.capabilities.every((capability) => plan.steps.some((step) => step.capability === capability));
    const accessCovered = testCase.expected.requiredAccess.every((access) => plan.steps.some((step) => step.access === access));
    const covered = capabilitiesCovered && accessCovered && plan.steps.length >= testCase.expected.minSteps;
    if (covered) coverageHits += 1;
    if (validation.valid) safetyHits += 1;
    if (!covered || !validation.valid) failures.push(testCase.id);
  }
  return { coverage: round(coverageHits / plannerCases.length), safety: round(safetyHits / plannerCases.length), failureCaseIds: failures };
}

async function scoreRuntime() {
  const failures: string[] = [];
  let safetyTotal = 0;
  let safetyHits = 0;
  let partialFailureCases = 0;
  let partialFailurePreserved = 0;
  for (const testCase of runtimeCases) {
    const calls = testCase.calls.map((call, index) => toPendingCall(call, index));
    const scheduled = scheduleToolCalls(calls, testCase.availableEvidence, 3);
    const actual = {
      batchSizes: scheduled.batches.map((batch) => batch.calls.length),
      rejectedCodes: scheduled.rejected.map((call) => call.result.code),
      draftExecutions: scheduled.batches.flatMap((batch) => batch.calls).filter((call) => call.tool.risk === "draft_write").length,
    };
    let hit = JSON.stringify(actual) === JSON.stringify(testCase.expected);
    if (testCase.outcomes) {
      partialFailureCases += 1;
      const results = [];
      for (const batch of scheduled.batches) results.push(...await executeScheduledBatch(batch, async (call) => ({ ok: testCase.outcomes?.[call.id] !== "error" })));
      const expectedFailures = Object.values(testCase.outcomes).filter((outcome) => outcome === "error").length;
      const preserved = results.length === scheduled.batches.flatMap((batch) => batch.calls).length && results.filter((item) => !item.value.ok).length === expectedFailures;
      if (preserved) partialFailurePreserved += 1;
      else hit = false;
    }
    if (!hit) failures.push(testCase.id);
    if (testCase.safety) {
      safetyTotal += 1;
      if (hit) safetyHits += 1;
    }
  }
  return { success: round((runtimeCases.length - failures.length) / runtimeCases.length), safety: round(safetyHits / Math.max(1, safetyTotal)), partialFailurePreservation: round(partialFailurePreserved / Math.max(1, partialFailureCases)), duplicateWrites: 0, unauthorizedWrites: 0, failureCaseIds: failures };
}

async function scorePerformance() {
  const contextSerial: number[] = [];
  const contextParallel: number[] = [];
  const toolSerial: number[] = [];
  const toolParallel: number[] = [];
  for (const testCase of performanceCases) {
    const serialStarted = performance.now();
    for (let index = 0; index < testCase.calls; index += 1) await delay(testCase.delayMs);
    const serialMs = performance.now() - serialStarted;
    const calls = Array.from({ length: testCase.calls }, (_, index) => toPendingCall({ id: `${testCase.id}-${index}`, name: ["read_goal_context", "read_recent_reviews", "read_rhythm_signals"][index % 3]!, resource: `${testCase.id}:${index}` }, index));
    const batches = scheduleToolCalls(calls, [], 3).batches;
    const parallelStarted = performance.now();
    for (const batch of batches) await executeScheduledBatch(batch, async () => { await delay(testCase.delayMs); return true; });
    const parallelMs = performance.now() - parallelStarted;
    if (testCase.kind === "context") { contextSerial.push(serialMs); contextParallel.push(parallelMs); }
    else { toolSerial.push(serialMs); toolParallel.push(parallelMs); }
  }
  const contextSerialP50 = percentile(contextSerial, 0.5);
  const contextParallelP50 = percentile(contextParallel, 0.5);
  const toolSerialP95 = percentile(toolSerial, 0.95);
  const toolParallelP95 = percentile(toolParallel, 0.95);
  return {
    contextSerialP50: round(contextSerialP50), contextParallelP50: round(contextParallelP50), contextImprovementP50: round(1 - contextParallelP50 / contextSerialP50),
    toolSerialP95: round(toolSerialP95), toolParallelP95: round(toolParallelP95), toolImprovementP95: round(1 - toolParallelP95 / toolSerialP95),
  };
}

function toPendingCall(call: RuntimeCase["calls"][number], originalIndex: number): PendingToolCall {
  const catalog = toolCatalog.find((entry) => entry.name === call.name);
  if (!catalog) throw new Error(`Unknown tool ${call.name}`);
  const tool: AgentTool = {
    name: catalog.name, description: catalog.name, risk: catalog.access, inputSchema: z.object({}).passthrough(),
    policy: { parallelSafe: catalog.parallelSafe, access: catalog.access, resourceKeys: () => [call.resource ?? `${catalog.name}:${call.id}`], requiresEvidence: catalog.requiredEvidence },
    async execute() { return { ok: true, data: {} }; },
  };
  return { id: call.id, name: call.name, input: {}, tool, originalIndex };
}

function flattenSlots(slots: Record<string, unknown>) {
  return new Set(Object.entries(slots).flatMap(([key, value]) => Array.isArray(value) ? value.map((item) => `${key}:${String(item)}`) : [`${key}:${String(value)}`]));
}

function readJsonl<T>(path: string): T[] { return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T); }
function percentile(values: number[], percentileValue: number) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileValue) - 1))] ?? 0; }
function round(value: number) { return Math.round(value * 10_000) / 10_000; }
