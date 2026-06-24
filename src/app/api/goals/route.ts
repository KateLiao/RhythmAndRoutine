import { NextResponse } from "next/server";
import { apiError } from "@/server/api-response";
import { LOCAL_USER_ID } from "@/server/auth";
import { createGoal, listGoals } from "@/server/services/goals";

export async function GET() {
  try { return NextResponse.json({ data: await listGoals(LOCAL_USER_ID) }); }
  catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try { return NextResponse.json({ data: await createGoal(LOCAL_USER_ID, await request.json()) }, { status: 201 }); }
  catch (error) { return apiError(error); }
}
