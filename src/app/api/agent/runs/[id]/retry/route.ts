import { NextResponse } from "next/server";
import { apiError } from "@/server/api-response";
import { LOCAL_USER_ID } from "@/server/auth";
import { getDb } from "@/lib/db";
import { AgentRunStatus, TriggerSource } from "@/generated/prisma/enums";

type Context = { params: Promise<{ id: string }> };

/**
 * POST /api/agent/runs/[id]/retry - 对失败的 AgentRun 发起重试，创建关联的新 Run。
 * 新 Run 保留原 Run 的 capability、modelId、modelProvider 配置，
 * 不复用已失败 ToolCall 的幂等键（新 Run 有独立 ID）。
 * 返回新 Run 的 ID 供客户端发起重试请求。
 */
export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;

    const original = await getDb().agentRun.findFirst({
      where: { id, userId: LOCAL_USER_ID },
      select: { id: true, status: true, capability: true, modelId: true, modelProvider: true, inputSummary: true },
    });
    if (!original) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Run 不存在。" } }, { status: 404 });
    if (original.status !== "FAILED") {
      return NextResponse.json({ error: { code: "INVALID_STATE", message: `只能重试失败的 Run，当前状态为 ${original.status}。` } }, { status: 409 });
    }

    // 创建新 Run，关联原 Run（通过 inputSummary 标记重试来源）
    const newRun = await getDb().agentRun.create({
      data: {
        userId: LOCAL_USER_ID,
        capability: original.capability,
        triggerSource: TriggerSource.USER,
        modelProvider: original.modelProvider,
        modelId: original.modelId,
        status: AgentRunStatus.QUEUED,
        inputSummary: `重试 Run ${original.id}${original.inputSummary ? `：${original.inputSummary.slice(0, 200)}` : ""}`,
      },
      select: { id: true, capability: true, modelId: true, modelProvider: true },
    });

    return NextResponse.json({ data: { runId: newRun.id, capability: newRun.capability, model: newRun.modelId } }, { status: 201 });
  } catch (error) { return apiError(error); }
}
