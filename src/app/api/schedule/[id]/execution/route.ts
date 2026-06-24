import { NextResponse } from "next/server";
import { apiError } from "@/server/api-response";
import { LOCAL_USER_ID } from "@/server/auth";
import { upsertExecutionFeedback } from "@/server/services/schedule";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return NextResponse.json({ data: await upsertExecutionFeedback(LOCAL_USER_ID, (await params).id, await request.json()) }); }
  catch (error) { return apiError(error); }
}
