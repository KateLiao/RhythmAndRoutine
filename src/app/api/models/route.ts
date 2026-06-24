import { NextResponse } from "next/server";
import { getProviderConfigs } from "@/agent/provider-config";

export async function GET() {
  return NextResponse.json({
    data: getProviderConfigs().map(({ id, label, model, baseUrl, enabled }) => ({ id, label, model, baseUrl, enabled })),
    defaultProvider: process.env.AI_DEFAULT_PROVIDER || "qwen",
  });
}
