import type { AgentTool, ToolResult } from "./types";

export type PendingToolCall = {
  id: string;
  name: string;
  input: unknown;
  tool: AgentTool;
  originalIndex: number;
};

export type ToolExecutionBatch = {
  id: string;
  mode: "parallel" | "serial";
  calls: PendingToolCall[];
};

export type RejectedToolCall = PendingToolCall & { result: Extract<ToolResult, { ok: false }> };

export function scheduleToolCalls(
  calls: PendingToolCall[],
  availableEvidence: string[],
  maxConcurrency = 3,
): { batches: ToolExecutionBatch[]; rejected: RejectedToolCall[] } {
  const rejected: RejectedToolCall[] = [];
  const hasRead = calls.some((call) => call.tool.policy.access === "read");
  const namesProvidedInBatch = new Set(calls.map((call) => call.name));
  const draftCount = calls.filter((call) => call.tool.policy.access === "draft_write").length;
  const runnable = calls.filter((call) => {
    if (call.tool.policy.access === "draft_write" && draftCount > 1) {
      rejected.push({ ...call, result: { ok: false, code: "MULTIPLE_DRAFT_WRITES", message: "同一模型批次包含多个写草案请求；为避免重复写入，本批次未执行写操作。请合并为一个草案后重试。", retryable: true } });
      return false;
    }
    if (hasRead && call.tool.policy.access === "draft_write") {
      rejected.push({ ...call, result: { ok: false, code: "STALE_DRAFT_BATCH", message: "同一批次包含新的读取与写草案请求；已只执行读取，请基于新证据在下一轮重新提出草案。", retryable: true } });
      return false;
    }
    const missingEvidence = (call.tool.policy.requiresEvidence ?? []).filter((name) => !availableEvidence.includes(name) && !namesProvidedInBatch.has(name));
    if (missingEvidence.length) {
      rejected.push({ ...call, result: { ok: false, code: "TOOL_EVIDENCE_REQUIRED", message: `${call.name} 需要先取得证据：${missingEvidence.join("、")}。`, retryable: true } });
      return false;
    }
    return true;
  });

  const batches: ToolExecutionBatch[] = [];
  let parallelCalls: PendingToolCall[] = [];
  let parallelResources = new Set<string>();
  const flushParallel = () => {
    if (!parallelCalls.length) return;
    batches.push({ id: `batch-${batches.length + 1}`, mode: parallelCalls.length > 1 ? "parallel" : "serial", calls: parallelCalls });
    parallelCalls = [];
    parallelResources = new Set<string>();
  };

  // 相似历史会改变候选时段，因此同一模型批次中必须先读历史，再读当前窗口；
  // 最终候选校验永远排在窗口读取之后。其余无依赖读取仍可并行。
  const hasHistoryLookup = runnable.some((call) => call.name === "read_similar_schedule_history");
  const executionRank = (call: PendingToolCall) => call.name === "validate_schedule_candidates"
    ? 2
    : call.name === "read_schedule_window" && hasHistoryLookup
      ? 1
      : 0;
  const orderedRunnable = [...runnable].sort((left, right) => executionRank(left) - executionRank(right) || left.originalIndex - right.originalIndex);

  let activeRank = -1;
  for (const call of orderedRunnable) {
    const rank = executionRank(call);
    if (activeRank >= 0 && rank !== activeRank) flushParallel();
    activeRank = rank;
    const resources = call.tool.policy.resourceKeys(call.input);
    const conflicts = resources.some((key) => parallelResources.has(key));
    if (!call.tool.policy.parallelSafe || call.tool.policy.access !== "read") {
      flushParallel();
      batches.push({ id: `batch-${batches.length + 1}`, mode: "serial", calls: [call] });
      continue;
    }
    if (parallelCalls.length >= maxConcurrency || conflicts) flushParallel();
    parallelCalls.push(call);
    resources.forEach((key) => parallelResources.add(key));
  }
  flushParallel();
  return { batches, rejected: rejected.sort((left, right) => left.originalIndex - right.originalIndex) };
}

export async function executeScheduledBatch<T>(
  batch: ToolExecutionBatch,
  execute: (call: PendingToolCall) => Promise<T>,
): Promise<Array<{ call: PendingToolCall; value: T; completedAt: number }>> {
  if (batch.mode === "serial") {
    const completed: Array<{ call: PendingToolCall; value: T; completedAt: number }> = [];
    for (const call of batch.calls) completed.push({ call, value: await execute(call), completedAt: Date.now() });
    return completed;
  }
  return Promise.all(batch.calls.map(async (call) => ({ call, value: await execute(call), completedAt: Date.now() })));
}
