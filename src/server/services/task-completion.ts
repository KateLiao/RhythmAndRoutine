import { ScheduleBlockStatus, TaskStatus } from "@/generated/prisma/enums";
import type { TaskCompletionRecord, TaskCompletionSummary } from "@/domain/schemas";
import { taskCompletionSummarySchema } from "@/domain/schemas";
import { getDb } from "@/lib/db";
import { DomainError } from "@/server/api-response";
import { ensureLocalUser } from "@/server/auth";
import { z } from "zod";

const completeTaskSchema = z.object({
  expectedVersion: z.number().int().positive(),
});

type TaskBlock = {
  id: string;
  title: string;
  status: ScheduleBlockStatus;
  startsAt: Date;
  endsAt: Date;
  executionRecord: {
    actualMinutes: number | null;
    result: string;
    deviationReason: string | null;
    obstacle: string | null;
    quality: string | null;
    rhythmFeedback: { tags: string[]; note: string | null; comfortable: boolean | null; timeFit: string | null } | null;
  } | null;
};

/**
 * 查询与任务关联的全部日程块（含多任务关联表）。
 * @param userId - 用户 ID
 * @param taskId - 任务 ID
 */
async function listTaskScheduleBlocks(userId: string, taskId: string) {
  return getDb().scheduleBlock.findMany({
    where: {
      userId,
      deletedAt: null,
      OR: [{ taskId }, { linkedTasks: { some: { taskId } } }],
    },
    include: { executionRecord: { include: { rhythmFeedback: true } } },
    orderBy: { startsAt: "asc" },
  }) as Promise<TaskBlock[]>;
}

/**
 * 计算任务已完成日程块的真实投入分钟数。
 * @param blocks - 关联日程块
 */
function sumInvestedMinutes(blocks: TaskBlock[]) {
  return blocks
    .filter((block) => block.status === ScheduleBlockStatus.COMPLETED)
    .reduce((sum, block) => sum + (block.executionRecord?.actualMinutes ?? Math.max(0, Math.round((block.endsAt.getTime() - block.startsAt.getTime()) / 60000))), 0);
}

/**
 * 将日程块序列化为 AI 可读摘要。
 * @param blocks - 关联日程块
 */
function serializeBlocksForPrompt(blocks: TaskBlock[]) {
  return blocks.map((block) => ({
    date: block.startsAt.toISOString(),
    title: block.title,
    status: block.status.toLowerCase(),
    plannedMinutes: Math.max(0, Math.round((block.endsAt.getTime() - block.startsAt.getTime()) / 60000)),
    actualMinutes: block.executionRecord?.actualMinutes ?? null,
    result: block.executionRecord?.result ?? null,
    obstacle: block.executionRecord?.obstacle ?? undefined,
    deviationReason: block.executionRecord?.deviationReason ?? undefined,
    quality: block.executionRecord?.quality ?? undefined,
    rhythmTags: block.executionRecord?.rhythmFeedback?.tags ?? [],
    rhythmNote: block.executionRecord?.rhythmFeedback?.note ?? undefined,
    timeFit: block.executionRecord?.rhythmFeedback?.timeFit ?? undefined,
  }));
}

/**
 * AI 不可用时，基于规则生成任务完成总结。
 * @param task - 任务信息
 * @param blocks - 关联日程块
 * @param investedMinutes - 真实投入分钟数
 */
function buildRulesCompletion(task: { title: string; intent: string | null; completionCriteria: unknown }, blocks: TaskBlock[], investedMinutes: number): TaskCompletionSummary {
  const completed = blocks.filter((block) => block.status === ScheduleBlockStatus.COMPLETED);
  const missed = blocks.filter((block) => block.status === ScheduleBlockStatus.MISSED || block.status === ScheduleBlockStatus.RESCHEDULED);
  const smooth = completed.filter((block) => block.executionRecord?.rhythmFeedback?.tags.includes("smooth")).length;
  const executionSummary = completed.length
    ? `任务「${task.title}」共安排 ${blocks.length} 次，其中 ${completed.length} 次已完成，累计真实投入 ${investedMinutes} 分钟。${smooth ? `有 ${smooth} 次执行反馈为顺畅。` : ""}${missed.length ? `另有 ${missed.length} 次未完成或改期，可作为后续调整参考。` : ""}`
    : `任务「${task.title}」尚未留下已完成的时间块记录，本次由你直接确认完成。`;
  const criteria = Array.isArray(task.completionCriteria) ? task.completionCriteria.map(String) : [];
  const overallEvaluation = criteria.length
    ? `对照完成标准（${criteria.join("；")}），你已确认此任务完成。${task.intent ? `原任务意图是：${task.intent}` : ""}`
    : `你已确认任务「${task.title}」完成。${task.intent ? `它原本指向：${task.intent}` : ""}`;
  return { executionSummary, overallEvaluation, source: "rules" };
}

/**
 * 调用 AI 生成任务完成总结；失败时返回 null。
 * @param task - 任务信息
 * @param blocks - 关联日程块
 * @param investedMinutes - 真实投入分钟数
 */
async function tryAICompletion(task: { title: string; intent: string | null; completionCriteria: unknown }, blocks: TaskBlock[], investedMinutes: number): Promise<TaskCompletionSummary | null> {
  try {
    const { resolveCapabilityProvider } = await import("@/agent/provider-config");
    const { OpenAICompatibleAdapter } = await import("@/agent/openai-compatible-adapter");
    const { provider, model } = resolveCapabilityProvider("review");
    const adapter = new OpenAICompatibleAdapter(provider);
    const criteria = Array.isArray(task.completionCriteria) ? task.completionCriteria.map(String) : [];
    const prompt = `用户正在确认完成一个任务，请基于真实执行数据给出两段式总结。

任务：${task.title}
任务意图：${task.intent || "未填写"}
完成标准：${criteria.length ? criteria.join("；") : "未明确列出"}
累计真实投入：${investedMinutes} 分钟

关联日程与执行记录：
${JSON.stringify(serializeBlocksForPrompt(blocks), null, 2)}

请输出：
1. executionSummary：先总结总计投入时间与各时间块的执行过程（计划/实际、反馈、阻碍等），只陈述事实。
2. overallEvaluation：再对照完成标准，评价这个任务是否算完成、完成质量如何、还缺什么或下一步建议。
3. source：固定填 "ai"`;

    return await adapter.generateObject({
      model,
      system: "你是 Rhythm & Routine 的任务完成分析助手。先总结真实投入与执行过程，再给出整体完成评价。语气客观、支持性，区分事实与判断。",
      prompt,
      schema: taskCompletionSummarySchema,
      maxOutputTokens: 1400,
    });
  } catch {
    return null;
  }
}

/**
 * 确认完成任务：汇总关联日程执行记录，AI 生成完成总结并入库。
 * @param userId - 用户 ID
 * @param taskId - 任务 ID
 * @param raw - 请求体，须包含 expectedVersion
 */
export async function completeTaskWithSummary(userId: string, taskId: string, raw: unknown) {
  await ensureLocalUser();
  const input = completeTaskSchema.parse(raw);
  const task = await getDb().task.findFirst({
    where: { id: taskId, version: input.expectedVersion, archivedAt: null, goal: { userId } },
    select: { id: true, title: true, intent: true, completionCriteria: true, goalId: true, version: true },
  });
  if (!task) throw new DomainError("VERSION_CONFLICT", "任务已经发生变化，请刷新后再完成。", 409);

  const blocks = await listTaskScheduleBlocks(userId, taskId);
  const investedMinutes = sumInvestedMinutes(blocks);
  const completedSessions = blocks.filter((block) => block.status === ScheduleBlockStatus.COMPLETED).length;
  const summary = (await tryAICompletion(task, blocks, investedMinutes)) ?? buildRulesCompletion(task, blocks, investedMinutes);
  const completionRecord: TaskCompletionRecord = {
    ...summary,
    investedMinutes,
    completedSessions,
    generatedAt: new Date().toISOString(),
  };

  const result = await getDb().task.updateMany({
    where: { id: taskId, version: input.expectedVersion, archivedAt: null, goal: { userId } },
    data: {
      status: TaskStatus.COMPLETED,
      completedAt: new Date(),
      completionRecord: completionRecord as object,
      version: { increment: 1 },
    },
  });
  if (!result.count) throw new DomainError("VERSION_CONFLICT", "任务已经发生变化，请刷新后再完成。", 409);

  const updated = await getDb().task.findFirst({ where: { id: taskId, goal: { userId } } });
  if (!updated) throw new DomainError("TASK_NOT_FOUND", "没有找到这个任务。", 404);
  return {
    id: updated.id,
    status: updated.status.toLowerCase(),
    completedAt: updated.completedAt?.toISOString() ?? null,
    completionRecord: updated.completionRecord as TaskCompletionRecord,
    version: updated.version,
  };
}
