import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/server/api-response";
import { LOCAL_USER_ID } from "@/server/auth";
import { confirmReview } from "@/server/services/reviews";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { const input = z.object({ confirmed: z.boolean() }).parse(await request.json()); return NextResponse.json({ data: await confirmReview(LOCAL_USER_ID, (await params).id, input.confirmed) }); }
  catch (error) { return apiError(error); }
}
