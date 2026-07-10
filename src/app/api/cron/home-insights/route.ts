import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { regenerateHomeInsightTarget } from "@/server/services/home-insights";
import { shouldRunMomentSchedule, shouldRunSlowSchedule } from "@/server/services/home-insights-schedule";

/**
 * 定时任务：按用户时区生成首页洞察快照（moment 每小时整点；slow 周三 08:00 / 周日 20:00）。
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const users = await getDb().user.findMany({ select: { id: true, timezone: true } });
  const generated: string[] = [];

  for (const user of users) {
    const timezone = user.timezone ?? "Asia/Shanghai";
    if (shouldRunMomentSchedule(now, timezone)) {
      await regenerateHomeInsightTarget(user.id, "moment", "scheduled");
      generated.push(`${user.id}:moment`);
    }
    if (shouldRunSlowSchedule(now, timezone)) {
      await regenerateHomeInsightTarget(user.id, "slow", "scheduled");
      generated.push(`${user.id}:slow`);
    }
  }

  return NextResponse.json({ data: { generated } });
}
