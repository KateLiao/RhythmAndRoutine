import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/server/api-response";
import { ensureLocalUser, LOCAL_USER_ID } from "@/server/auth";
import { generateReview, listReviews, syncDueReviews } from "@/server/services/reviews";

/**
 * 在列出回顾前同步最近已经到期的日、周回顾，支持数据库模式本地运行自愈。
 * @param request - 包含可选 limit 查询参数的回顾列表请求
 * @returns 最近回顾列表；自动生成失败时仍返回已有记录
 */
export async function GET(request: NextRequest) {
  try {
    const user = await ensureLocalUser();
    await syncDueReviews(user);
    return NextResponse.json({ data: await listReviews(LOCAL_USER_ID, Number(request.nextUrl.searchParams.get("limit") || 12)) });
  } catch (error) {
    return apiError(error);
  }
}

/**
 * 手动生成或重新生成回顾；未传周期时按用户设置补最近已经到期的日/周周期，避免 23:00 前误生成“今天”。
 * @param request - 包含 type，以及可选 periodStart/periodEnd 的 JSON 请求
 * @returns 新生成的回顾记录
 */
export async function POST(request: Request) {
  try {
    const input = z.object({
      type: z.enum(["daily", "weekly"]),
      periodStart: z.iso.datetime().optional(),
      periodEnd: z.iso.datetime().optional(),
    }).parse(await request.json());
    const user = await ensureLocalUser();
    let periodStart = input.periodStart ? new Date(input.periodStart) : null;
    let periodEnd = input.periodEnd ? new Date(input.periodEnd) : null;
    if (!periodStart || !periodEnd) {
      const { resolveMostRecentDueReviewPeriods } = await import("@/lib/review-schedule");
      const due = resolveMostRecentDueReviewPeriods(user, new Date())[input.type];
      periodStart = due.periodStart;
      periodEnd = due.periodEnd;
    }
    return NextResponse.json({ data: await generateReview(LOCAL_USER_ID, input.type, periodStart, periodEnd) }, { status: 201 });
  } catch (error) { return apiError(error); }
}
