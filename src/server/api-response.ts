import { NextResponse } from "next/server";
import { ZodError } from "zod";

export function apiError(error: unknown) {
  if (error instanceof ZodError) {
    return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "提交的信息不完整或格式不正确。", issues: error.issues } }, { status: 400 });
  }
  if (error instanceof DomainError) {
    return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  const infrastructureCode = (error as { code?: string } | null)?.code;
  if (infrastructureCode === "ECONNREFUSED" || infrastructureCode === "P1001") {
    return NextResponse.json({ error: { code: "DATABASE_UNAVAILABLE", message: "数据库暂时不可用，界面将继续使用本地数据。" } }, { status: 503 });
  }
  console.error(error);
  return NextResponse.json({ error: { code: "SERVICE_UNAVAILABLE", message: "数据库暂时不可用，界面将继续使用本地数据。" } }, { status: 503 });
}

export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}
