import { NextResponse } from "next/server";
import { apiError } from "@/server/api-response";
import { LOCAL_USER_ID } from "@/server/auth";
import { revokeGoalAchievementForCorrection } from "@/server/services/goal-execution";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    return NextResponse.json({ data: await revokeGoalAchievementForCorrection(LOCAL_USER_ID, (await context.params).id, await request.json()) });
  } catch (error) {
    return apiError(error);
  }
}
