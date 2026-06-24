import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/server/api-response";
import { LOCAL_USER_ID } from "@/server/auth";
import { generateReview, listReviews } from "@/server/services/reviews";

export async function GET(request: NextRequest) {
  try { return NextResponse.json({ data: await listReviews(LOCAL_USER_ID, Number(request.nextUrl.searchParams.get("limit") || 12)) }); }
  catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try {
    const input = z.object({ type: z.enum(["daily", "weekly"]), periodStart: z.iso.datetime(), periodEnd: z.iso.datetime() }).parse(await request.json());
    return NextResponse.json({ data: await generateReview(LOCAL_USER_ID, input.type, new Date(input.periodStart), new Date(input.periodEnd)) }, { status: 201 });
  } catch (error) { return apiError(error); }
}
