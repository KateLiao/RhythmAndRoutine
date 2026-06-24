import { NextResponse } from "next/server";
import { apiError } from "@/server/api-response";
import { LOCAL_USER_ID } from "@/server/auth";
import { listPendingChangeSets } from "@/server/services/change-sets";

export async function GET() { try { return NextResponse.json({ data: await listPendingChangeSets(LOCAL_USER_ID) }); } catch (error) { return apiError(error); } }
