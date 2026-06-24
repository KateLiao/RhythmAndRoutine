import { NextResponse } from "next/server";
import { apiError } from "@/server/api-response";
import { LOCAL_USER_ID } from "@/server/auth";
import { archiveRoutine, updateRoutine } from "@/server/services/goals";

type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, context: Context) {
  try { return NextResponse.json({ data: await updateRoutine(LOCAL_USER_ID, (await context.params).id, await request.json()) }); }
  catch (error) { return apiError(error); }
}
export async function DELETE(request: Request, context: Context) {
  try { await archiveRoutine(LOCAL_USER_ID, (await context.params).id, Number(new URL(request.url).searchParams.get("version"))); return new NextResponse(null, { status: 204 }); }
  catch (error) { return apiError(error); }
}
