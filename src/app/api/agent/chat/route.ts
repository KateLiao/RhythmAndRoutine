import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { AgentRuntime } from "@/agent/runtime";
import { OpenAICompatibleAdapter } from "@/agent/openai-compatible-adapter";
import { resolveCapabilityProvider, resolveFallbackProvider } from "@/agent/provider-config";
import { FallbackModelAdapter } from "@/agent/fallback-model-adapter";
import { createToolRegistry, type AgentDomainGateway } from "@/agent/tool-registry";
import { buildToolStepDetail, formatToolInputPreview, summarizeToolInput, summarizeToolResult, toolDisplayLabel, toolProcessingLabel } from "@/agent/tool-labels";
import type { RunEvent } from "@/agent/types";
import type { ChangeSetDraft } from "@/domain/schemas";
import { createPendingChangeSet } from "@/server/services/change-sets";
import { ContextBuilder } from "@/agent/context-builder";
import { PrismaContextSource } from "@/agent/prisma-context-source";
import { PrismaRunStore } from "@/agent/prisma-run-store";
import { ensureLocalUser, LOCAL_USER_ID } from "@/server/auth";
import { parseAgentScheduleWindow } from "@/lib/timezone";
import { listScheduleBlocks, readSimilarScheduleHistory } from "@/server/services/schedule";
import { buildAgentScheduleWindowResult, validateScheduleCandidates } from "@/server/services/agent-schedule-analysis";
import { planSimilarScheduleQueries, runProgressiveSimilarScheduleSearch } from "@/agent/similar-schedule-query-planner";
import { resolveIntent, type AgentView } from "@/agent/intent-resolver";
import { buildExecutionPlan, validateExecutionPlan } from "@/agent/execution-plan";
import { resolveIntentWithModel, shouldUseModelIntentRouter } from "@/agent/model-intent-resolver";
import { executeProposalContinuation, supportsProposalContinuation } from "@/server/services/proposal-continuation";
import { resolveAgentPageGoalId } from "@/lib/agent-page-context";

const requestSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  capability: z.enum(["goal_clarification", "planning", "review", "adjustment", "progress_evaluation"]).default("adjustment"),
  provider: z.string().optional(),
  model: z.string().optional(),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) })).max(20).default([]),
  conversationSummary: z.string().max(2000).optional(),
  page: z.object({ path: z.string().max(100), selectedEntityId: z.string().optional() }).optional(),
  business: z.record(z.string(), z.unknown()).default({}),
  conversationId: z.string().min(1).max(120).optional(),
  parentRunId: z.string().min(1).max(120).optional(),
  activeChangeSetId: z.string().min(1).max(120).optional(),
});

type StreamChangeSet = ChangeSetDraft & { id: string; revision?: number; supersedesChangeSetId?: string };

type StreamPayload =
  | { type: "status"; phase: "context" | "thinking" | "tool" | "writing"; message: string }
  | (RunEvent & { label?: string; summary?: string; detail?: ReturnType<typeof buildToolStepDetail> | Extract<RunEvent, { type: "loop_step" }>["detail"] })
  | { type: "done"; text: string; provider: string; model: string; changeSet: StreamChangeSet | null }
  | { type: "error"; message: string };

/**
 * 为工具相关 RunEvent 补充用户可读标签、结果摘要与展开详情。
 * @param event - 运行时原始事件
 * @param timeZone - 用户时区
 */
function enrichRunEvent(event: RunEvent, timeZone: string): StreamPayload {
  if (event.type === "tool_started") {
    const inputSummary = summarizeToolInput(event.tool, event.input);
    return {
      ...event,
      label: toolDisplayLabel(event.tool),
      summary: inputSummary,
      detail: {
        inputSummary,
        inputPreview: formatToolInputPreview(event.input),
        rawInputJson: formatToolInputPreview(event.input),
        toolName: event.tool,
      },
    };
  }
  if (event.type === "tool_completed") {
    const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : undefined;
    const inputSummary = summarizeToolInput(event.tool, event.input);
    const detail = buildToolStepDetail(event.tool, event.result, input, timeZone);
    return {
      ...event,
      label: toolDisplayLabel(event.tool),
      summary: summarizeToolResult(event.tool, event.result),
      detail: {
        ...detail,
        inputSummary,
        inputPreview: formatToolInputPreview(event.input),
        rawInputJson: formatToolInputPreview(event.input),
        toolName: event.tool,
      },
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
  const agentView = normalizeAgentView(input.page?.path);
  const pageGoalId = resolveAgentPageGoalId(agentView, input.page?.selectedEntityId);
  const rejectedStalePageSelection = Boolean(input.page?.selectedEntityId && !pageGoalId);
  const rulesResolution = resolveIntent({
    prompt: input.prompt,
    view: agentView,
    selectedGoalId: pageGoalId,
    recentMessages: input.messages,
    conversationId: input.conversationId,
    parentRunId: input.parentRunId,
    activeChangeSetId: input.activeChangeSetId,
  });

  const bodyStream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let proposedChangeSet: StreamChangeSet | null = null;

      /**
       * 向 SSE 流写入一条 JSON 事件。
       * @param payload - 要发送的事件对象
       */
      const emit = (payload: StreamPayload) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      try {
        emit({ type: "status", phase: "context", message: "正在理解你的请求…" });
        const rulesCapability = rulesResolution.primaryCapability ?? input.capability;
        const routerResolved = resolveCapabilityProvider(rulesCapability, input.provider, input.model);
        const routerFallback = resolveFallbackProvider(routerResolved.provider.id);
        const routerAdapter = new FallbackModelAdapter(new OpenAICompatibleAdapter(routerResolved.provider), routerFallback ? { adapter: new OpenAICompatibleAdapter(routerFallback.provider), model: routerFallback.model } : undefined);
        const intentResolution = process.env.AGENT_MODEL_ROUTER_ENABLED === "1" && shouldUseModelIntentRouter(rulesResolution)
          ? await resolveIntentWithModel({ adapter: routerAdapter, model: routerResolved.model, prompt: input.prompt, view: agentView, selectedGoalId: pageGoalId ?? undefined, rules: rulesResolution, signal: request.signal })
          : rulesResolution;
        const primaryCapability = intentResolution.primaryCapability ?? rulesCapability;
        const executionPlan = buildExecutionPlan(intentResolution);
        const planValidation = validateExecutionPlan(executionPlan);
        if (!planValidation.valid) throw new Error(planValidation.issues[0]?.message ?? "执行计划无效。");
        const resolved = resolveCapabilityProvider(primaryCapability, input.provider, input.model);
        const provider = resolved.provider;
        const fallback = resolveFallbackProvider(provider.id);
        const adapter = new FallbackModelAdapter(new OpenAICompatibleAdapter(provider), fallback ? { adapter: new OpenAICompatibleAdapter(fallback.provider), model: fallback.model } : undefined);

        if (supportsProposalContinuation(intentResolution)) {
          const user = await new PrismaContextSource().getUser(LOCAL_USER_ID);
          const continuation = await executeProposalContinuation({
            userId: LOCAL_USER_ID,
            prompt: input.prompt,
            resolution: intentResolution,
            adapter,
            model: resolved.model,
            timezone: user.timezone,
            signal: request.signal,
            emit: (event) => emit(enrichRunEvent(event, user.timezone)),
          });
          proposedChangeSet = continuation.changeSet;
          emit({
            type: "done",
            text: continuation.text,
            provider: adapter.activeProvider,
            model: adapter.activeProvider === provider.id ? resolved.model : fallback?.model || resolved.model,
            changeSet: proposedChangeSet,
          });
          return;
        }

        let context;
        try {
          context = await new ContextBuilder(new PrismaContextSource()).build({
            userId: LOCAL_USER_ID,
            capability: primaryCapability,
            page: input.page
              ? {
                  path: agentView,
                  selectedEntity: pageGoalId
                    ? { entityType: "goal", entityId: pageGoalId, reason: "目标详情页当前目标" }
                    : undefined,
                }
              : undefined,
            recentMessages: input.messages,
            conversationSummary: input.conversationSummary,
          });
          if (input.conversationSummary?.trim()) {
            context.manifest = [
              ...context.manifest,
              {
                entityType: "conversation_summary",
                entityId: `chars:${input.conversationSummary.length}`,
                reason: `summaryUsed=true;summaryChars=${input.conversationSummary.length}`,
              },
            ];
          }
        } catch {
          const scopedGoals = rejectedStalePageSelection
            ? []
            : pageGoalId && Array.isArray(input.business.goals)
              ? (input.business.goals as Array<{ id?: string }>).filter((goal) => goal.id === pageGoalId)
              : input.business.goals;
          context = {
            user: { id: LOCAL_USER_ID, timezone: typeof input.business.timezone === "string" ? input.business.timezone : "Asia/Shanghai", preferences: { provider: provider.id } },
            page: input.page
              ? {
                  path: agentView,
                  selectedEntity: pageGoalId
                    ? { entityType: "goal", entityId: pageGoalId, reason: "目标详情页当前目标" }
                    : undefined,
                }
              : undefined,
            conversation: { recentMessages: input.messages, summary: input.conversationSummary },
            business: { ...input.business, goals: scopedGoals },
            manifest: input.conversationSummary?.trim()
              ? [{ entityType: "conversation_summary", entityId: `chars:${input.conversationSummary.length}`, reason: `summaryUsed=true;summaryChars=${input.conversationSummary.length}` }]
              : [],
          };
        }

        emit({ type: "status", phase: "thinking", message: "正在分析并准备回复…" });

        const contextSource = new PrismaContextSource();
        const gateway: AgentDomainGateway = {
          readGoalContext: async (_userId, goalId) => (await contextSource.getGoalContext(LOCAL_USER_ID, goalId)).data,
          readScheduleWindow: async (_userId, from, to) => {
            const window = parseAgentScheduleWindow(from, to, context.user.timezone);
            const items = await listScheduleBlocks(LOCAL_USER_ID, window.from, window.to);
            return buildAgentScheduleWindowResult(items, window.from, window.to, context.user.timezone);
          },
          readSimilarScheduleHistory: async (_userId, historyInput) => {
            const plan = await planSimilarScheduleQueries(adapter, {
              prompt: input.prompt,
              queryHint: historyInput.query,
              model: resolved.model,
              signal: request.signal,
            });
            const search = await runProgressiveSimilarScheduleSearch(plan, (tier) => readSimilarScheduleHistory(
              LOCAL_USER_ID,
              {
                ...historyInput,
                query: undefined,
                queries: tier.queries,
                matchMode: tier.level === "exact" ? "exact" : "contains",
              },
              context.user.timezone,
            ));
            return { ...search.result, queryPlan: plan, matchedTier: search.matchedTier, attempts: search.attempts };
          },
          validateScheduleCandidates: async (_userId, candidates) => {
            const normalized = candidates.map((candidate) => {
              const window = parseAgentScheduleWindow(candidate.startsAt, candidate.endsAt, context.user.timezone);
              return { ...candidate, startsAt: window.from.toISOString(), endsAt: window.to.toISOString() };
            });
            const from = new Date(Math.min(...normalized.map((candidate) => new Date(candidate.startsAt).getTime())));
            const to = new Date(Math.max(...normalized.map((candidate) => new Date(candidate.endsAt).getTime())));
            const items = await listScheduleBlocks(LOCAL_USER_ID, from, to);
            const window = buildAgentScheduleWindowResult(items, from, to, context.user.timezone);
            const result = validateScheduleCandidates(normalized, window);
            const fingerprint = createHash("sha256").update(JSON.stringify(window.items.map((item) => [item.id, item.status, item.startsAt, item.endsAt]))).digest("hex");
            return { ...result, scheduleEvidence: { resourceKey: `schedule:${from.toISOString()}:${to.toISOString()}`, from: from.toISOString(), to: to.toISOString(), fingerprint, observedAt: new Date().toISOString(), operationLabels: normalized.map((candidate) => candidate.label).filter(Boolean) } };
          },
          readExecutionHistory: async (_userId, days) => (await contextSource.getExecutionHistory(LOCAL_USER_ID, days)).data,
          readRecentReviews: async (_userId, limit) => (await contextSource.getRecentReviews(LOCAL_USER_ID, limit)).data,
          readRhythmSignals: async (_userId, limit) => (await contextSource.getRhythmSignals(LOCAL_USER_ID, limit)).data,
          createChangeSet: async ({ draft, idempotencyKey, runId, scheduleEvidence }) => {
            try {
              const stored = await createPendingChangeSet(LOCAL_USER_ID, draft, idempotencyKey, runId, scheduleEvidence ? JSON.parse(JSON.stringify(scheduleEvidence)) as Prisma.InputJsonValue : undefined);
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
        const runtime = new AgentRuntime(adapter, createToolRegistry(gateway), store);
        let text = "";
        let hasText = false;

        for await (const event of runtime.run({
          userId: LOCAL_USER_ID,
          capability: primaryCapability,
          prompt: input.prompt,
          model: resolved.model,
          context,
          intentResolution,
          executionPlan,
          conversationId: input.conversationId,
          parentRunId: input.parentRunId,
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

function normalizeAgentView(value?: string): AgentView {
  return (["today", "goals", "goal-detail", "task-detail", "routines", "review", "settings"] as AgentView[]).includes(value as AgentView) ? value as AgentView : "today";
}
