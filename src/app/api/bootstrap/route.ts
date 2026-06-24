import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/server/api-response";
import { LOCAL_USER_ID, ensureLocalUser } from "@/server/auth";
import { listGoals } from "@/server/services/goals";
import { listScheduleBlocks } from "@/server/services/schedule";

export async function GET(request: NextRequest) {
  try {
    const user = await ensureLocalUser();
    const from = new Date(request.nextUrl.searchParams.get("from") ?? new Date().setHours(0, 0, 0, 0));
    const to = new Date(request.nextUrl.searchParams.get("to") ?? new Date(from.getTime() + 7 * 86400000));
    const [goals, schedule, rhythmSignals] = await Promise.all([listGoals(LOCAL_USER_ID), listScheduleBlocks(LOCAL_USER_ID, from, to), (await import("@/lib/db")).getDb().rhythmSignal.findMany({ where: { userId: LOCAL_USER_ID, OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }] }, orderBy: [{ confidence: "desc" }, { updatedAt: "desc" }], take: 6 })]);
    return NextResponse.json({ data: { user, goals, schedule, rhythmSignals } });
  } catch (error) { return apiError(error); }
}
