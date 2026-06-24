import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/server/api-response";
import { LOCAL_USER_ID } from "@/server/auth";
import { cancelScheduleBlock, deleteScheduleBlock, updateScheduleBlock } from "@/server/services/schedule";

type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, context: Context) {
  try { return NextResponse.json({ data: await updateScheduleBlock(LOCAL_USER_ID, (await context.params).id, await request.json()) }); }
  catch (error) { return apiError(error); }
}

/**
 * DELETE /api/schedule/[id] - 软删除日程块（仅限无执行历史的草稿）。
 * 已有执行记录请调用 POST /api/schedule/[id]/cancel。
 */
export async function DELETE(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const version = Number(new URL(request.url).searchParams.get("version"));
    await deleteScheduleBlock(LOCAL_USER_ID, id, version);
    return new NextResponse(null, { status: 204 });
  } catch (error) { return apiError(error); }
}

/**
 * POST /api/schedule/[id]/cancel - 取消日程块（保留历史可见记录）。
 */
export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const body = z.object({ expectedVersion: z.number().int().positive(), changeReason: z.string().max(500).optional() }).parse(await request.json());
    await cancelScheduleBlock(LOCAL_USER_ID, id, body.expectedVersion, body.changeReason);
    return new NextResponse(null, { status: 204 });
  } catch (error) { return apiError(error); }
}
