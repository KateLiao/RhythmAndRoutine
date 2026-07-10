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
  const startedAt = Date.now();
  try {
    const body = bodySchema.parse(await request.json());
    console.info("[home-insights] regenerate request", { target: body.target, trigger: "manual" });
    const data = await regenerateHomeInsightTarget(LOCAL_USER_ID, body.target, "manual");
    console.info("[home-insights] regenerate response", {
      target: body.target,
      ms: Date.now() - startedAt,
      regeneratedMoment: data.meta.regeneratedMoment,
      regeneratedSlow: data.meta.regeneratedSlow,
      momentSource: data.moment.source,
      rhythmSource: data.rhythm.source,
    });
    return NextResponse.json({ data });
  } catch (error) {
    console.error("[home-insights] regenerate failed", {
      ms: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
    });
    return apiError(error);
  }
}
