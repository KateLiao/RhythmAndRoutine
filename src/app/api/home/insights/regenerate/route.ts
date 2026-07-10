import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/server/api-response";
import { LOCAL_USER_ID } from "@/server/auth";
import { regenerateHomeInsightTarget } from "@/server/services/home-insights";

const bodySchema = z.object({
  target: z.enum(["moment", "slow"]),
});

/**
 * 手动触发首页洞察重生成（moment 或 slow）。
 */
export async function POST(request: NextRequest) {
  try {
    const body = bodySchema.parse(await request.json());
    const data = await regenerateHomeInsightTarget(LOCAL_USER_ID, body.target, "manual");
    return NextResponse.json({ data });
  } catch (error) {
    return apiError(error);
  }
}
