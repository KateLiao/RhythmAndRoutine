import { z } from "zod";
import { AgentRuntime } from "@/agent/runtime";
import { OpenAICompatibleAdapter } from "@/agent/openai-compatible-adapter";
import { resolveCapabilityProvider, resolveFallbackProvider } from "@/agent/provider-config";
import { FallbackModelAdapter } from "@/agent/fallback-model-adapter";
import { createToolRegistry, type AgentDomainGateway } from "@/agent/tool-registry";
import { buildToolStepDetail, summarizeToolResult, toolDisplayLabel, toolProcessingLabel } from "@/agent/tool-labels";
import type { RunEvent } from "@/agent/types";
import type { ChangeSetDraft } from "@/domain/schemas";
import { createPendingChangeSet } from "@/server/services/change-sets";
import { ContextBuilder } from "@/agent/context-builder";
import { PrismaContextSource } from "@/agent/prisma-context-source";
import { PrismaRunStore } from "@/agent/prisma-run-store";
import { ensureLocalUser, LOCAL_USER_ID } from "@/server/auth";
import { parseAgentScheduleWindow } from "@/lib/timezone";
import { listScheduleBlocks } from "@/server/services/schedule";

const requestSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  capability: z.enum(["goal_clarification", "planning", "review", "adjustment", "progress_evaluation"]).default("adjustment"),
  provider: z.string().optional(),
  model: z.string().optional(),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) })).max(20).default([]),
  page: z.object({ path: z.string().max(100), selectedEntityId: z.string().optional() }).optional(),
  business: z.record(z.string(), z.unknown()).default({}),
});

type StreamPayload =
  | { type: "status"; phase: "context" | "thinking" | "tool" | "writing"; message: string }
  | (RunEvent & { label?: string; summary?: string; detail?: ReturnType<typeof buildToolStepDetail> })
  | { type: "done"; text: string; provider: string; model: string; changeSet: (ChangeSetDraft & { id: string }) | null }
  | { type: "error"; message: string };

/**
 * 为工具相关 RunEvent 补充用户可读标签、结果摘要与展开详情。
 * @param event - 运行时原始事件
 * @param timeZone - 用户时区
 */
function enrichRunEvent(event: RunEvent, timeZone: string): StreamPayload {
  if (event.type === "tool_started") {
    return { ...event, label: toolDisplayLabel(event.tool) };
  }
  if (event.type === "tool_completed") {
    const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : undefined;
    return {
      ...event,
      label: toolDisplayLabel(event.tool),
      summary: summarizeToolResult(event.tool, event.result),
      detail: buildToolStepDetail(event.tool, event.result, input, timeZone),
    };
  }
  return event;
}

export async function POST(request: Request) {
  let input: z.infer<typeof requestSchema>;
  try {
    input = requestSchema.parse(await request.json());
  } catch {
    return new Response(JSON.stringify({ error: { code: "INVALID_REQUEST", message: "请求参数无效。" } }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  await ensureLocalUser();
  const resolved = resolveCapabilityProvider(input.capability, input.provider, input.model); const provider = resolved.provider;
  const fallback = resolveFallbackProvider(provider.id);

  const bodyStream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let proposedChangeSet: (ChangeSetDraft & { id: string }) | null = null;

      /**
       * 向 SSE 流写入一条 JSON 事件。
       * @param payload - 要发送的事件对象
       */
      const emit = (payload: StreamPayload) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      try {
        emit({ type: "status", phase: "context", message: "正在理解你的请求…" });

        let context;
        try {
          context = await new ContextBuilder(new PrismaContextSource()).build({
            userId: LOCAL_USER_ID,
            capability: input.capability,
            page: input.page
              ? {
                  path: input.page.path,
                  selectedEntity: input.page.selectedEntityId
                    ? { entityType: "goal", entityId: input.page.selectedEntityId, reason: "用户当前选择" }
                    : undefined,
                }
              : undefined,
            recentMessages: input.messages,
          });
        } catch {
          const scopedGoals = input.page?.selectedEntityId && Array.isArray(input.business.goals)
            ? (input.business.goals as Array<{ id?: string }>).filter((goal) => goal.id === input.page?.selectedEntityId)
            : input.business.goals;
          context = {
            user: { id: LOCAL_USER_ID, timezone: typeof input.business.timezone === "string" ? input.business.timezone : "Asia/Shanghai", preferences: { provider: provider.id } },
            page: input.page
              ? {
                  path: input.page.path,
                  selectedEntity: input.page.selectedEntityId
                    ? { entityType: "goal", entityId: input.page.selectedEntityId, reason: "用户当前选择" }
                    : undefined,
                }
              : undefined,
            conversation: { recentMessages: input.messages },
            business: { ...input.business, goals: scopedGoals },
            manifest: [],
          };
        }

        emit({ type: "status", phase: "thinking", message: "正在分析并准备回复…" });

        const contextSource = new PrismaContextSource();
        const gateway: AgentDomainGateway = {
          readGoalContext: async (_userId, goalId) => (await contextSource.getGoalContext(LOCAL_USER_ID, goalId)).data,
          readScheduleWindow: async (_userId, from, to) => {
            const window = parseAgentScheduleWindow(from, to, context.user.timezone);
            return listScheduleBlocks(LOCAL_USER_ID, window.from, window.to);
          },
          readExecutionHistory: async (_userId, days) => (await contextSource.getExecutionHistory(LOCAL_USER_ID, days)).data,
          readRecentReviews: async (_userId, limit) => (await contextSource.getRecentReviews(LOCAL_USER_ID, limit)).data,
          readRhythmSignals: async (_userId, limit) => (await contextSource.getRhythmSignals(LOCAL_USER_ID, limit)).data,
          createChangeSet: async ({ draft, idempotencyKey, runId }) => {
            try {
              const stored = await createPendingChangeSet(LOCAL_USER_ID, draft, idempotencyKey, runId);
              proposedChangeSet = {
                title: stored.title,
                reason: stored.reason,
                riskLevel: draft.riskLevel,
                operations: stored.operations as ChangeSetDraft["operations"],
                id: stored.id,
              };
              return { id: stored.id };
            } catch {
              proposedChangeSet = { ...draft, id: idempotencyKey };
              return { id: idempotencyKey };
            }
          },
        };

        const store = new PrismaRunStore();
        const adapter = new FallbackModelAdapter(new OpenAICompatibleAdapter(provider), fallback ? { adapter: new OpenAICompatibleAdapter(fallback.provider), model: fallback.model } : undefined);
        const runtime = new AgentRuntime(adapter, createToolRegistry(gateway), store);
        let text = "";
        let hasText = false;

        for await (const event of runtime.run({
          userId: LOCAL_USER_ID,
          capability: input.capability,
          prompt: input.prompt,
          model: resolved.model,
          context,
          signal: request.signal,
        })) {
          if (event.type === "text_delta") {
            if (!hasText) {
              hasText = true;
              emit({ type: "status", phase: "writing", message: "正在组织回复…" });
            }
            text += event.text;
          }
          if (event.type === "tool_started") {
            emit({ type: "status", phase: "tool", message: `${toolProcessingLabel(event.tool)}…` });
          }
          if (event.type === "model_fallback") emit({ type: "status", phase: "thinking", message: `主模型暂不可用，已切换到 ${event.to}。` });
          if (event.type === "run_failed") throw new Error(event.message);
          emit(enrichRunEvent(event, context.user.timezone));
        }

        const finalText = text || (proposedChangeSet ? "我整理了一份变更草案，请你确认后再应用。" : "这次没有生成可用回复。");
        emit({
          type: "done",
          text: finalText,
          provider: adapter.activeProvider,
          model: adapter.activeProvider === provider.id ? resolved.model : fallback?.model || resolved.model,
          changeSet: proposedChangeSet,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "小律暂时无法完成这次请求。";
        emit({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(bodyStream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
