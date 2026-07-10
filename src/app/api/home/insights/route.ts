import { NextResponse } from "next/server";
import { apiError } from "@/server/api-response";
import { LOCAL_USER_ID } from "@/server/auth";
import { getHomeInsights } from "@/server/services/home-insights";

/**
 * 读取首页三张洞察卡片（必要时触发生成并落库）。
 */
export async function GET() {
  try {
    const data = await getHomeInsights(LOCAL_USER_ID);
    return NextResponse.json({ data });
  } catch (error) {
    return apiError(error);
  }
}
