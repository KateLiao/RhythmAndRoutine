import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/server/api-response";
import { ensureLocalUser, LOCAL_USER_ID } from "@/server/auth";
import { getDb } from "@/lib/db";

const schema = z.object({ timezone: z.string().min(1).max(80), dailyReviewTime: z.string().regex(/^\d{2}:\d{2}$/), weeklyReviewDay: z.number().int().min(0).max(6), weeklyReviewTime: z.string().regex(/^\d{2}:\d{2}$/), defaultModel: z.string().min(1).max(120) });
export async function GET() { try { const user = await ensureLocalUser(); return NextResponse.json({ data: pick(user) }); } catch (error) { return apiError(error); } }
export async function PATCH(request: Request) { try { await ensureLocalUser(); const input = schema.parse(await request.json()); const user = await getDb().user.update({ where: { id: LOCAL_USER_ID }, data: input }); return NextResponse.json({ data: pick(user) }); } catch (error) { return apiError(error); } }
function pick(user: { timezone: string; dailyReviewTime: string; weeklyReviewDay: number; weeklyReviewTime: string; defaultModel: string }) { return { timezone: user.timezone, dailyReviewTime: user.dailyReviewTime, weeklyReviewDay: user.weeklyReviewDay, weeklyReviewTime: user.weeklyReviewTime, defaultModel: user.defaultModel }; }
