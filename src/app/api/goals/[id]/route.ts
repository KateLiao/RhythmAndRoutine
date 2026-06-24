import { NextResponse } from "next/server";
import { apiError } from "@/server/api-response";
import { LOCAL_USER_ID } from "@/server/auth";
import { archiveGoal, getGoal, updateGoal } from "@/server/services/goals";

type Context = { params: Promise<{ id: string }> };

export async function GET(_: Request, context: Context) {
  try { return NextResponse.json({ data: await getGoal(LOCAL_USER_ID, (await context.params).id) }); }
  catch (error) { return apiError(error); }
}

export async function PATCH(request: Request, context: Context) {
  try { return NextResponse.json({ data: await updateGoal(LOCAL_USER_ID, (await context.params).id, await request.json()) }); }
  catch (error) { return apiError(error); }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const expectedVersion = Number(new URL(request.url).searchParams.get("version"));
    await archiveGoal(LOCAL_USER_ID, (await context.params).id, expectedVersion);
    return new NextResponse(null, { status: 204 });
  } catch (error) { return apiError(error); }
}
