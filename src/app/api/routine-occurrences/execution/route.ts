import { NextResponse } from "next/server";
import { apiError } from "@/server/api-response";
import { LOCAL_USER_ID } from "@/server/auth";
import { recordRoutineExecution } from "@/server/services/routines";

export async function PUT(request: Request) {
  try { return NextResponse.json({ data: await recordRoutineExecution(LOCAL_USER_ID, await request.json()) }); }
  catch (error) { return apiError(error); }
}
