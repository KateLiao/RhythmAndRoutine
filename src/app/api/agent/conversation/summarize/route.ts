import { z } from "zod";
import { NextResponse } from "next/server";
import { apiError } from "@/server/api-response";
import { ensureLocalUser } from "@/server/auth";
import { OpenAICompatibleAdapter } from "@/agent/openai-compatible-adapter";
import { resolveCapabilityProvider } from "@/agent/provider-config";

const bodySchema = z.object({
  sessionId: z.string().min(1),
  revision: z.number().int().positive(),
  priorSummary: z.string().max(2000).optional(),
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().max(8000),
    id: z.string().optional(),
  })).min(1).max(40),
});

const summarySchema = z.object({
  summary: z.string().min(1).max(2000),
});

/**
 * POST /api/agent/conversation/summarize
 * 异步压缩滑出窗口的对话消息；失败时由客户端规则降级。
 * 不阻塞主对话路径。
 */
export async function POST(request: Request) {
  try {
    await ensureLocalUser();
    const body = bodySchema.parse(await request.json());
    const resolved = resolveCapabilityProvider("adjustment");
    const adapter = new OpenAICompatibleAdapter(resolved.provider);

    const transcript = body.messages
      .map((message) => `${message.role === "user" ? "用户" : "小律"}：${message.content.slice(0, 400)}`)
      .join("\n");

    const summary = await adapter.generateObject({
      model: resolved.model,
      system: "你是对话摘要器。只输出 JSON。保留用户目标、约束、未决问题与已生成草案要点；删除寒暄。中文，2000 字以内。",
      prompt: `${body.priorSummary ? `已有摘要：\n${body.priorSummary}\n\n` : ""}请增量压缩以下对话：\n${transcript}`,
      schema: summarySchema,
      maxOutputTokens: 800,
      signal: AbortSignal.timeout(20_000),
      maxRetries: 1,
    });

    const throughId = body.messages[body.messages.length - 1]?.id;
    return NextResponse.json({
      data: {
        sessionId: body.sessionId,
        revision: body.revision,
        summary: summary.summary.slice(0, 2000),
        summarizedThroughMessageId: throughId,
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
