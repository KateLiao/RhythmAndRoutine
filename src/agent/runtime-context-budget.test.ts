import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { AgentRuntime, type AgentRunStore, buildBudgetGuidance } from "./runtime";
import type { AgentTool, ModelAdapter, ModelRequest } from "./types";

test("runtime persists its budget, carries compact evidence, caches identical reads, and keeps only the latest tool protocol batch", async () => {
  const requests: ModelRequest[] = [];
  let modelCall = 0;
  let toolCall = 0;
  const model: ModelAdapter = {
    provider: "test",
    async *stream(request) {
      requests.push(request);
      modelCall += 1;
      if (modelCall <= 2) {
        yield { type: "tool_call" as const, id: `call-${modelCall}`, name: "read_goal_context", input: { goalId: "goal-1" } };
        yield { type: "usage" as const, inputTokens: 100, outputTokens: 20 };
        return;
      }
      yield { type: "text_delta" as const, text: "已完成" };
      yield { type: "usage" as const, inputTokens: 100, outputTokens: 20 };
    },
    async generateObject<T>() { return {} as T; },
  };
  const tool: AgentTool = {
    name: "read_goal_context",
    description: "test",
    risk: "read",
    policy: { parallelSafe: true, access: "read", resourceKeys: () => ["goal:goal-1"] },
    inputSchema: z.object({ goalId: z.string() }),
    async execute() {
      toolCall += 1;
      return { ok: true, data: { id: "goal-1", title: `目标版本 ${toolCall}`, huge: "x".repeat(20_000) } };
    },
  };
  const created: Array<Parameters<AgentRunStore["create"]>[0]> = [];
  const persistedToolOutputs: unknown[] = [];
  const store: AgentRunStore = {
    async create(input) { created.push(input); return { id: "run-1" }; },
    async appendStep(_runId, step) { step.toolCalls?.forEach((call) => persistedToolOutputs.push(call.output)); },
    async markAwaitingConfirmation() {}, async complete() {}, async fail() {}, async cancel() {},
  };
  const runtime = new AgentRuntime(model, new Map([[tool.name, tool]]), store);

  for await (const event of runtime.run({
    userId: "user-1",
    capability: "goal_clarification",
    prompt: "读取目标",
    model: "test-model",
    context: { user: { id: "user-1", timezone: "Asia/Shanghai", preferences: {} }, conversation: { recentMessages: [] }, business: {}, manifest: [] },
  })) { void event; }

  assert.equal(created[0]?.maxTokens, 24_000);
  assert.equal(created[0]?.maxSteps, 6);
  assert.deepEqual(requests.map((request) => request.messages.length), [1, 3, 3]);
  assert.equal(toolCall, 1, "an identical read in one Run must not access the data source twice");
  assert.match(requests[2]?.system ?? "", /目标版本 1/);
  assert.ok(JSON.stringify(persistedToolOutputs).length > 20_000, "audit storage must receive the uncompressed result");
});

test("budget guidance becomes progressively stricter near the hard cap", () => {
  assert.equal(buildBudgetGuidance(10_000, 64_000), "");
  assert.match(buildBudgetGuidance(50_000, 64_000), /停止重复查询/);
  assert.match(buildBudgetGuidance(58_000, 64_000), /禁止新的探索性查询/);
});
