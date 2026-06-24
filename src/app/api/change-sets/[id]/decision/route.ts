import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/server/api-response";
import { LOCAL_USER_ID } from "@/server/auth";
import { decideChangeSet } from "@/server/services/change-sets";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { const { approved, selectedOperationIndexes } = z.object({ approved: z.boolean(), selectedOperationIndexes: z.array(z.number().int().nonnegative()).max(120).optional() }).parse(await request.json()); return NextResponse.json({ data: await decideChangeSet(LOCAL_USER_ID, (await params).id, approved, selectedOperationIndexes) }); }
  catch (error) { return apiError(error); }
}
