import type { Prisma } from "@/generated/prisma/client";
import { AgentRunStatus, ToolRisk, TriggerSource } from "@/generated/prisma/enums";
import { getDb } from "@/lib/db";
import type { AgentRunStore } from "./runtime";

const riskMap = { read: ToolRisk.READ, draft_write: ToolRisk.DRAFT_WRITE, system: ToolRisk.SYSTEM } as const;

export class PrismaRunStore implements AgentRunStore {
  async create(input: Parameters<AgentRunStore["create"]>[0]) {
    const manifest = Array.isArray(input.contextManifest) ? input.contextManifest as Array<Record<string, unknown>> : [];
    return getDb().agentRun.create({
      data: {
        userId: input.userId, capability: input.capability, triggerSource: TriggerSource.USER,
        modelProvider: input.provider, modelId: input.model, status: AgentRunStatus.RUNNING, inputSummary: input.inputSummary?.slice(0, 2000), startedAt: new Date(),
        contextItems: { create: manifest.flatMap((item) => typeof item.entityId === "string" ? [{ entityType: String(item.entityType ?? "unknown"), entityId: item.entityId, version: typeof item.version === "number" ? item.version : undefined, reason: String(item.reason ?? "Agent 上下文") }] : []) },
      },
      select: { id: true },
    });
  }

  async appendStep(runId: string, step: Parameters<AgentRunStore["appendStep"]>[1]) {
    await getDb().agentStep.create({ data: {
      agentRunId: runId, sequence: step.sequence, kind: step.kind,
      loopIteration: step.loopIteration, goalStatus: step.goalStatus, nextAction: step.nextAction,
      reason: step.reason?.slice(0, 2000), missingInformation: step.missingInformation ? json(step.missingInformation) : undefined,
      toolAttemptCount: step.toolAttemptCount,
      inputSummary: summarize(step.input), outputSummary: summarize(step.output), durationMs: step.durationMs,
      inputTokens: step.inputTokens, outputTokens: step.outputTokens,
      toolCalls: step.toolCalls?.length ? { create: step.toolCalls.map((call, index) => ({
        toolName: call.name, risk: riskMap[call.risk], input: json(call.input), output: call.output === undefined ? undefined : json(call.output),
        idempotencyKey: `${runId}:${step.sequence}:${index}`, status: call.ok ? "completed" : "failed", errorCode: call.errorCode, durationMs: call.durationMs,
      })) } : undefined,
    } });
  }

  async markAwaitingConfirmation(runId: string, _changeSetId: string, summary: string, retryCount: number) {
    await getDb().agentRun.update({ where: { id: runId }, data: { status: AgentRunStatus.AWAITING_CONFIRMATION, exitReason: "awaiting_user_confirmation", goalStatus: "awaiting_confirmation", retryCount, finalSummary: summary.slice(0, 2000) } });
  }
  async complete(runId: string, finalText: string, exitReason: string, goalStatus: string, retryCount: number) {
    await getDb().agentRun.update({ where: { id: runId }, data: { status: AgentRunStatus.COMPLETED, exitReason, goalStatus, retryCount, finalSummary: finalText.slice(0, 2000), completedAt: new Date() } });
  }
  async fail(runId: string, code: string, message: string, exitReason: string, retryCount: number) {
    await getDb().agentRun.update({ where: { id: runId }, data: { status: AgentRunStatus.FAILED, exitReason, goalStatus: "blocked", retryCount, errorCode: code, errorMessage: message.slice(0, 2000), completedAt: new Date() } });
  }

  /**
   * 取消一个 Run（RUNNING 或 AWAITING_CONFIRMATION 状态），同步取消关联的待审批 ChangeSet。
   * @param runId - AgentRun ID
   * @param reason - 可选取消原因
   */
  async cancel(runId: string, reason?: string) {
    await getDb().$transaction(async (tx) => {
      await tx.agentRun.update({ where: { id: runId }, data: { status: AgentRunStatus.CANCELLED, exitReason: "cancelled_by_user", goalStatus: "blocked", completedAt: new Date(), finalSummary: reason ?? "用户取消" } });
      await tx.changeSet.updateMany({ where: { agentRunId: runId, status: "AWAITING_CONFIRMATION" }, data: { status: "REJECTED", decidedAt: new Date(), decisionNote: reason ?? "Run 被取消" } });
    });
  }
}

function summarize(value: unknown) { if (value === undefined) return undefined; const text = typeof value === "string" ? value : JSON.stringify(value); return text.slice(0, 2000); }
function json(value: unknown) { return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue; }
