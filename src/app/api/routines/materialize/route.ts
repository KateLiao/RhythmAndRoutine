import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/server/api-response";
import { LOCAL_USER_ID } from "@/server/auth";
import { expandRoutineOccurrences } from "@/server/services/routines";

export async function POST(request: Request) {
  try { const input = z.object({ from: z.iso.datetime(), to: z.iso.datetime() }).parse(await request.json()); const occurrences = await expandRoutineOccurrences(LOCAL_USER_ID, new Date(input.from), new Date(input.to)); return NextResponse.json({ data: { created: 0, occurrences } }); }
  catch (error) { return apiError(error); }
}
