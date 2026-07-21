import { NextResponse } from "next/server";
import { LOCAL_USER_ID } from "@/server/auth";
import { apiError } from "@/server/api-response";
import { listChangeSetRevisionHistory } from "@/server/services/change-sets";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return NextResponse.json({ data: await listChangeSetRevisionHistory(LOCAL_USER_ID, (await params).id) });
  } catch (error) {
    return apiError(error);
  }
}
