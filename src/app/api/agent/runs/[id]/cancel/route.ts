import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/server/api-response";
import { LOCAL_USER_ID } from "@/server/auth";
import { getDb } from "@/lib/db";
import { PrismaRunStore } from "@/agent/prisma-run-store";

type Context = { params: Promise<{ id: string }> };

/**
 * POST /api/agent/runs/[id]/cancel - 取消指定 AgentRun（RUNNING 或 AWAITING_CONFIRMATION）。
 * 同时将关联的待审批 ChangeSet 标记为 REJECTED。
 * @body { reason?: string } - 可选取消原因
 */
export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const body = z.object({ reason: z.string().max(500).optional() }).parse(await request.json().catch(() => ({})));

    const run = await getDb().agentRun.findFirst({ where: { id, userId: LOCAL_USER_ID }, select: { id: true, status: true } });
    if (!run) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Run 不存在。" } }, { status: 404 });
    if (!["RUNNING", "AWAITING_CONFIRMATION", "QUEUED"].includes(run.status)) {
      return NextResponse.json({ error: { code: "INVALID_STATE", message: `Run 状态为 ${run.status}，无法取消。` } }, { status: 409 });
    }

    await new PrismaRunStore().cancel(id, body.reason ?? "用户取消");
    return new NextResponse(null, { status: 204 });
  } catch (error) { return apiError(error); }
}
