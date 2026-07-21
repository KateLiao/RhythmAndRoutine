import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ContextBuilder, type ContextDataSource } from "./context-builder";
import { buildExecutionPlan, validateExecutionPlan } from "./execution-plan";
import { resolveIntent } from "./intent-resolver";
import { AgentRuntime, type AgentRunStore, buildToolIdempotencyKey } from "./runtime";
import { scheduleToolCalls } from "./tool-scheduler";
import type { AgentTool, ModelAdapter, ModelRequest } from "./types";

describe("intent resolver", () => {
  it("lets the explicit message override the current page", () => {
    const result = resolveIntent({ prompt: "把英语练习改到明天 20:00-21:00", view: "review", selectedGoalId: "goal-english" });
    assert.equal(result.primaryCapability, "adjustment");
    assert.deepEqual(result.intents.map((intent) => intent.capability), ["adjustment"]);
    assert.deepEqual(result.intents[0]?.slots.timeRanges, ["20:00-21:00"]);
  });

  it("keeps multiple explicit intents in message order", () => {
    const result = resolveIntent({ prompt: "先帮我规划本周，再看看这个目标有没有推进", view: "goal-detail", selectedGoalId: "goal-1" });
    assert.deepEqual(result.intents.map((intent) => intent.capability), ["planning", "progress_evaluation"]);
    assert.equal(result.needsClarification, false);
  });

  it("marks a generic adjustment as blocked instead of inventing target and time", () => {
    const result = resolveIntent({ prompt: "帮我安排一下", view: "today" });
    assert.equal(result.primaryCapability, "adjustment");
    assert.deepEqual(result.intents[0]?.missingSlots, ["target", "time_or_recurrence"]);
    assert.equal(result.needsClarification, true);
  });

  it("routes unrelated conversation away from business execution", () => {
    const result = resolveIntent({ prompt: "什么是大语言模型？", view: "settings" });
    assert.equal(result.route, "non_execution");
    assert.equal(result.intents.length, 0);
  });
});

describe("execution planner", () => {
  it("creates an ordered multi-intent plan with a confirmation barrier", () => {
    const plan = buildExecutionPlan(resolveIntent({ prompt: "规划本周并看看目标进度", view: "goal-detail", selectedGoalId: "goal-1" }));
    const validation = validateExecutionPlan(plan);
    assert.equal(validation.valid, true);
    assert.ok(plan.steps.some((step) => step.access === "draft_write"));
    assert.ok(plan.steps.some((step) => step.access === "user_confirmation"));
    assert.ok(plan.steps.filter((step) => step.access === "read").every((step) => step.dependsOn.length === 0 || step.toolHints.length === 0));
  });

  it("rejects cycles, illegal tools, and writes without confirmation", () => {
    const result = validateExecutionPlan({
      planId: "invalid",
      intentIds: ["intent-1"],
      steps: [{ id: "write", intentId: "intent-1", objective: "bad", capability: "planning", dependsOn: ["write"], toolHints: ["propose_change_set"], access: "draft_write", successCondition: "bad", failureStrategy: "stop" }],
    });
    assert.equal(result.valid, false);
    assert.deepEqual(new Set(result.issues.map((issue) => issue.code)), new Set(["TOOL_NOT_ALLOWED", "CONFIRMATION_MISSING", "CYCLIC_PLAN"]));
  });
});

describe("parallel context builder", () => {
  it("preserves successful sources when one independent source fails", async () => {
    const source = fakeContextSource({ reviews: new Error("review unavailable") }, 5);
    const context = await new ContextBuilder(source).build({ userId: "user", capability: "adjustment" });
    assert.deepEqual(context.business.goals, [{ id: "goal-1" }]);
    assert.deepEqual(context.business.reviews, []);
    assert.equal(context.sourceMetrics?.find((metric) => metric.source === "reviews")?.ok, false);
    assert.ok(context.manifest.some((item) => item.entityType === "context_source_error" && item.entityId === "reviews"));
  });

  it("reduces wall time by reading independent business sources together", async () => {
    const source = fakeContextSource({}, 30);
    const startedSerial = Date.now();
    await new ContextBuilder(source).build({ userId: "user", capability: "adjustment", strategy: "serial" });
    const serialMs = Date.now() - startedSerial;
    const startedParallel = Date.now();
    await new ContextBuilder(source).build({ userId: "user", capability: "adjustment", strategy: "parallel" });
    const parallelMs = Date.now() - startedParallel;
    assert.ok(parallelMs <= serialMs * 0.7, `expected at least 30% improvement, serial=${serialMs} parallel=${parallelMs}`);
  });
});

describe("tool scheduler", () => {
  it("batches at most three independent reads and separates resource conflicts", () => {
    const reads = [
      pendingCall("a", readTool("read_goal_context", "goal:1"), 0),
      pendingCall("b", readTool("read_recent_reviews", "review:1"), 1),
      pendingCall("c", readTool("read_rhythm_signals", "rhythm:1"), 2),
      pendingCall("d", readTool("read_execution_history", "goal:1"), 3),
    ];
    const result = scheduleToolCalls(reads, [], 3);
    assert.deepEqual(result.batches.map((batch) => batch.calls.map((call) => call.id)), [["a", "b", "c"], ["d"]]);
  });

  it("rejects mixed read/write and multiple writes without executing a draft", () => {
    const read = pendingCall("read", readTool("read_goal_context", "goal:1"), 0);
    const write = pendingCall("write", draftTool("propose_change_set"), 1);
    assert.deepEqual(scheduleToolCalls([read, write], [], 3).rejected.map((call) => call.result.code), ["STALE_DRAFT_BATCH"]);
    assert.deepEqual(scheduleToolCalls([write, { ...write, id: "write-2", originalIndex: 2 }], [], 3).rejected.map((call) => call.result.code), ["MULTIPLE_DRAFT_WRITES", "MULTIPLE_DRAFT_WRITES"]);
  });

  it("requires prior evidence for dependent validation", () => {
    const validator = readTool("validate_schedule_candidates", "validation:1", false, ["read_schedule_window"]);
    const result = scheduleToolCalls([pendingCall("validate", validator, 0)], [], 3);
    assert.equal(result.rejected[0]?.result.code, "TOOL_EVIDENCE_REQUIRED");
  });

  it("orders history before the current window and validation without losing parallel reads", () => {
    const schedule = pendingCall("schedule", readTool("read_schedule_window", "schedule"), 0);
    const goal = pendingCall("goal", readTool("read_goal_context", "goal"), 1);
    const history = pendingCall("history", readTool("read_similar_schedule_history", "history"), 2);
    const validator = pendingCall("validate", readTool("validate_schedule_candidates", "validation", false, ["read_schedule_window"]), 3);
    const result = scheduleToolCalls([schedule, goal, history, validator], [], 3);
    assert.deepEqual(result.rejected, []);
    assert.deepEqual(result.batches.map((batch) => batch.calls.map((call) => call.id)), [["goal", "history"], ["schedule"], ["validate"]]);
    assert.deepEqual([schedule, goal, history, validator].map((call) => call.originalIndex), [0, 1, 2, 3]);
  });

  it("reuses a semantic idempotency key when the same draft is retried", () => {
    const tool = draftTool("propose_change_set");
    const first = buildToolIdempotencyKey("run", 1, { id: "call-1", name: tool.name, tool, input: { title: "草案", operations: [{ entity: "task", type: "update" }] } });
    const retried = buildToolIdempotencyKey("run", 2, { id: "call-2", name: tool.name, tool, input: { operations: [{ type: "update", entity: "task" }], title: "草案" } });
    assert.equal(first, retried);
  });
});

describe("runtime read batches", () => {
  it("executes a model batch in parallel and returns tool messages in original order", async () => {
    const requests: ModelRequest[] = [];
    let modelRound = 0;
    const model: ModelAdapter = {
      provider: "test",
      async *stream(request) {
        requests.push(request);
        modelRound += 1;
        if (modelRound === 1) {
          yield { type: "tool_call" as const, id: "call-b", name: "read_recent_reviews", input: { limit: 4 } };
          yield { type: "tool_call" as const, id: "call-a", name: "read_goal_context", input: {} };
          yield { type: "tool_call" as const, id: "call-c", name: "read_rhythm_signals", input: { limit: 4 } };
          return;
        }
        yield { type: "text_delta" as const, text: "完成" };
      },
      async generateObject<T>() { return {} as T; },
    };
    const tools = new Map<string, AgentTool>([
      ["read_recent_reviews", readTool("read_recent_reviews", "reviews", true, [], 35)],
      ["read_goal_context", readTool("read_goal_context", "goals", true, [], 35)],
      ["read_rhythm_signals", readTool("read_rhythm_signals", "signals", true, [], 35)],
    ]);
    const persisted: Array<NonNullable<Parameters<AgentRunStore["appendStep"]>[1]["toolCalls"]>[number]> = [];
    const store = memoryStore((calls) => persisted.push(...calls));
    const runtime = new AgentRuntime(model, tools, store);
    const startedAt = Date.now();
    for await (const event of runtime.run({ userId: "user", capability: "progress_evaluation", prompt: "看看进度", model: "test", context: { user: { id: "user", timezone: "Asia/Shanghai", preferences: {} }, conversation: { recentMessages: [] }, business: {}, manifest: [] } })) void event;
    const durationMs = Date.now() - startedAt;
    assert.ok(durationMs < 90, `three 35ms reads should run together, duration=${durationMs}`);
    assert.deepEqual(requests[1]?.messages.slice(-4).map((message) => message.role === "assistant" ? message.toolCalls?.map((call) => call.id) : message.toolCallId), [["call-b", "call-a", "call-c"], "call-b", "call-a", "call-c"]);
    assert.equal(new Set(persisted.map((call) => call.batchId)).size, 1);
  });
});

function fakeContextSource(errors: Partial<Record<"goals" | "schedule" | "executions" | "reviews" | "rhythmSignals", Error>>, delayMs: number): ContextDataSource {
  const result = async (key: keyof typeof errors, data: unknown) => { await delay(delayMs); if (errors[key]) throw errors[key]; return { data, references: [] }; };
  return {
    async getUser(id) { await delay(delayMs); return { id, timezone: "Asia/Shanghai", preferences: {} }; },
    getGoalContext: async () => result("goals", [{ id: "goal-1" }]),
    getScheduleWindow: async () => result("schedule", [{ id: "schedule-1" }]),
    getExecutionHistory: async () => result("executions", [{ id: "execution-1" }]),
    getRecentReviews: async () => result("reviews", [{ id: "review-1" }]),
    getRhythmSignals: async () => result("rhythmSignals", [{ id: "signal-1" }]),
  };
}

function readTool(name: string, resource: string, parallelSafe = true, requiresEvidence: string[] = [], delayMs = 0): AgentTool {
  return {
    name, description: name, risk: "read", inputSchema: z.object({}).passthrough(),
    policy: { parallelSafe, access: "read", resourceKeys: () => [resource], requiresEvidence },
    async execute() { if (delayMs) await delay(delayMs); return { ok: true, data: { source: name } }; },
  };
}

function draftTool(name: string): AgentTool {
  return { name, description: name, risk: "draft_write", inputSchema: z.object({}).passthrough(), policy: { parallelSafe: false, access: "draft_write", resourceKeys: () => ["change-set"] }, async execute() { return { ok: true, data: { changeSetId: "change-1" } }; } };
}

function pendingCall(id: string, tool: AgentTool, originalIndex: number) { return { id, name: tool.name, input: {}, tool, originalIndex }; }

function memoryStore(onCalls: (calls: NonNullable<Parameters<AgentRunStore["appendStep"]>[1]["toolCalls"]>) => void): AgentRunStore {
  return {
    async create() { return { id: "run-1" }; },
    async appendStep(_runId, step) { if (step.toolCalls?.length) onCalls(step.toolCalls); },
    async markAwaitingConfirmation() {}, async complete() {}, async fail() {}, async cancel() {},
  };
}
