import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/server/api-response";
import { LOCAL_USER_ID } from "@/server/auth";
import { createScheduleBlock, listScheduleBlocks } from "@/server/services/schedule";

export async function GET(request: NextRequest) {
  try {
    const from = new Date(request.nextUrl.searchParams.get("from") ?? new Date().setHours(0, 0, 0, 0));
    const to = new Date(request.nextUrl.searchParams.get("to") ?? new Date(from.getTime() + 7 * 86400000));
    return NextResponse.json({ data: await listScheduleBlocks(LOCAL_USER_ID, from, to) });
  } catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try { return NextResponse.json({ data: await createScheduleBlock(LOCAL_USER_ID, await request.json()) }, { status: 201 }); }
  catch (error) { return apiError(error); }
}
