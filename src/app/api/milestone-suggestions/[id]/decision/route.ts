import { NextResponse } from "next/server";
import { apiError } from "@/server/api-response";
import { LOCAL_USER_ID } from "@/server/auth";
import { decideMilestoneSuggestion } from "@/server/services/milestone-suggestions";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    return NextResponse.json({ data: await decideMilestoneSuggestion(LOCAL_USER_ID, (await context.params).id, await request.json()) });
  } catch (error) {
    return apiError(error);
  }
}
