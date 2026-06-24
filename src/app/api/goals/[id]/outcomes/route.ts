import { NextResponse } from "next/server";
import { apiError } from "@/server/api-response";
import { LOCAL_USER_ID } from "@/server/auth";
import { createOutcome } from "@/server/services/goals";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return NextResponse.json({ data: await createOutcome(LOCAL_USER_ID, (await params).id, await request.json()) }, { status: 201 }); }
  catch (error) { return apiError(error); }
}
