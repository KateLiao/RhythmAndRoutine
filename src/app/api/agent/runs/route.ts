import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/server/api-response";
import { LOCAL_USER_ID } from "@/server/auth";
import { getDb } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const limit = Math.min(Number(request.nextUrl.searchParams.get("limit") ?? 20), 50);
    const data = await getDb().agentRun.findMany({
      where: { userId: LOCAL_USER_ID }, orderBy: { createdAt: "desc" }, take: limit,
      include: { contextItems: true, changeSets: true, steps: { orderBy: { sequence: "asc" }, include: { toolCalls: true } } },
    });
    return NextResponse.json({ data });
  } catch (error) { return apiError(error); }
}
