import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/server/api-response";
import { LOCAL_USER_ID } from "@/server/auth";
import { getHomeInsights } from "@/server/services/home-insights";
import { bumpMomentAlternateIndex, recordMomentUserResponse } from "@/server/services/home-insights-snapshots";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("alternate") }),
  z.object({ action: z.literal("respond"), response: z.enum(["accepted", "ignored"]), applied: z.boolean().optional() }),
]);

/**
 * 更新此刻建议交互状态：轮换候选或记录用户响应。
 */
export async function PATCH(request: NextRequest) {
  try {
    const body = bodySchema.parse(await request.json());
    if (body.action === "alternate") {
      await bumpMomentAlternateIndex(LOCAL_USER_ID);
    } else {
      await recordMomentUserResponse(LOCAL_USER_ID, body.response, body.applied ?? false);
    }
    const data = await getHomeInsights(LOCAL_USER_ID);
    return NextResponse.json({ data });
  } catch (error) {
    return apiError(error);
  }
}
