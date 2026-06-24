import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { generateReview } from "@/server/services/reviews";
import { zonedParts, zonedPeriod } from "@/lib/timezone";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const users = await getDb().user.findMany(); const now = new Date(); const generated: string[] = [];
  for (const user of users) {
    const parts = zonedParts(now, user.timezone); const currentTime = `${pad(parts.hour)}:${pad(parts.minute)}`;
    if (currentTime === user.dailyReviewTime) {
      const { start, end } = zonedPeriod(now, user.timezone, "daily");
      await generateReview(user.id, "daily", start, end); generated.push(`${user.id}:daily`);
    }
    if (parts.weekday === user.weeklyReviewDay && currentTime === user.weeklyReviewTime) {
      const { start, end } = zonedPeriod(now, user.timezone, "weekly");
      await generateReview(user.id, "weekly", start, end); generated.push(`${user.id}:weekly`);
    }
  }
  return NextResponse.json({ data: { generated } });
}

function pad(value: number) { return String(value).padStart(2, "0"); }
