import { NextResponse } from "next/server";
import { apiError } from "@/server/api-response";
import { LOCAL_USER_ID } from "@/server/auth";
import { completeTaskWithSummary } from "@/server/services/task-completion";

type Context = { params: Promise<{ id: string }> };

/**
 * POST /api/tasks/[id]/complete - 确认完成任务并生成/入库 AI 完成总结。
 */
export async function POST(request: Request, context: Context) {
  try {
    return NextResponse.json({ data: await completeTaskWithSummary(LOCAL_USER_ID, (await context.params).id, await request.json()) });
  } catch (error) {
    return apiError(error);
  }
}
