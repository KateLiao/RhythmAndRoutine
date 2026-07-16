import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { syncDueReviews } from "@/server/services/reviews";

/**
 * 校验 Cron 请求后，为每位用户同步最近已经到期的日、周回顾。
 * @param request - Vercel Cron 请求，配置 CRON_SECRET 时需携带 Bearer 凭证
 * @returns 本次生成与失败的用户、回顾类型清单
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const users = await getDb().user.findMany();
  const now = new Date();
  const generated: string[] = [];
  const failed: Array<{ userId: string; type: "daily" | "weekly"; message: string }> = [];
  for (const user of users) {
    try {
      const result = await syncDueReviews(user, now);
      generated.push(...result.generated.map((type) => `${user.id}:${type}`));
      failed.push(...result.failed.map((item) => ({ userId: user.id, ...item })));
    } catch (error) {
      const message = error instanceof Error ? error.message : "回顾到期同步失败";
      failed.push(
        { userId: user.id, type: "daily", message },
        { userId: user.id, type: "weekly", message },
      );
    }
  }
  return NextResponse.json({ data: { generated, failed } });
}
