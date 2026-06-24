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
        modelProvider: input.provider, modelId: input.model, status: AgentRunStatus.RUNNING, startedAt: new Date(),
        contextItems: { create: manifest.flatMap((item) => typeof item.entityId === "string" ? [{ entityType: String(item.entityType ?? "unknown"), entityId: item.entityId, version: typeof item.version === "number" ? item.version : undefined, reason: String(item.reason ?? "Agent 上下文") }] : []) },
      },
      select: { id: true },
    });
  }

  async appendStep(runId: string, step: Parameters<AgentRunStore["appendStep"]>[1]) {
    await getDb().agentStep.create({ data: {
      agentRunId: runId, sequence: step.sequence, kind: step.kind,
      inputSummary: summarize(step.input), outputSummary: summarize(step.output), durationMs: step.durationMs,
      inputTokens: step.inputTokens, outputTokens: step.outputTokens,
      toolCalls: step.toolCalls?.length ? { create: step.toolCalls.map((call, index) => ({
        toolName: call.name, risk: riskMap[call.risk], input: json(call.input), output: call.output === undefined ? undefined : json(call.output),
        idempotencyKey: `${runId}:${step.sequence}:${index}`, status: call.ok ? "completed" : "failed", errorCode: call.errorCode, durationMs: call.durationMs,
      })) } : undefined,
    } });
  }

  async markAwaitingConfirmation(runId: string) { await getDb().agentRun.update({ where: { id: runId }, data: { status: AgentRunStatus.AWAITING_CONFIRMATION } }); }
  async complete(runId: string, finalText: string) { await getDb().agentRun.update({ where: { id: runId }, data: { status: AgentRunStatus.COMPLETED, finalSummary: finalText.slice(0, 2000), completedAt: new Date() } }); }
  async fail(runId: string, code: string, message: string) { await getDb().agentRun.update({ where: { id: runId }, data: { status: AgentRunStatus.FAILED, errorCode: code, errorMessage: message.slice(0, 2000), completedAt: new Date() } }); }

  /**
   * 取消一个 Run（RUNNING 或 AWAITING_CONFIRMATION 状态），同步取消关联的待审批 ChangeSet。
   * @param runId - AgentRun ID
   * @param reason - 可选取消原因
   */
  async cancel(runId: string, reason?: string) {
    await getDb().$transaction(async (tx) => {
      await tx.agentRun.update({ where: { id: runId }, data: { status: AgentRunStatus.CANCELLED, completedAt: new Date(), finalSummary: reason ?? "用户取消" } });
      await tx.changeSet.updateMany({ where: { agentRunId: runId, status: "AWAITING_CONFIRMATION" }, data: { status: "REJECTED", decidedAt: new Date(), decisionNote: reason ?? "Run 被取消" } });
    });
  }
}

function summarize(value: unknown) { if (value === undefined) return undefined; const text = typeof value === "string" ? value : JSON.stringify(value); return text.slice(0, 2000); }
function json(value: unknown) { return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue; }
