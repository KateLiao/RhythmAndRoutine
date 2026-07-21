import { z } from "zod";
import { changeSetDraftSchema, planningDraftSchema } from "@/domain/schemas";
import { AgentTool, type ToolExecutionPolicy } from "./types";

const readPolicy = (resourceKeys: ToolExecutionPolicy["resourceKeys"], requiresEvidence?: string[]): ToolExecutionPolicy => ({ parallelSafe: true, access: "read", resourceKeys, requiresEvidence });
const draftPolicy = (resourceKeys: ToolExecutionPolicy["resourceKeys"]): ToolExecutionPolicy => ({ parallelSafe: false, access: "draft_write", resourceKeys });

export type AgentDomainGateway = {
  readGoalContext(userId: string, goalId?: string): Promise<unknown>;
  readScheduleWindow(userId: string, from: string, to: string): Promise<unknown>;
  readSimilarScheduleHistory(userId: string, input: { query?: string; goalId?: string; taskId?: string; routineId?: string; days: number; limit: number }): Promise<unknown>;
  validateScheduleCandidates(userId: string, candidates: Array<{ label?: string; startsAt: string; endsAt: string }>): Promise<unknown>;
  readExecutionHistory(userId: string, days: number): Promise<unknown>;
  readRecentReviews(userId: string, limit: number): Promise<unknown>;
  readRhythmSignals(userId: string, limit: number): Promise<unknown>;
  createChangeSet(input: { userId: string; runId: string; idempotencyKey: string; draft: z.infer<typeof changeSetDraftSchema>; scheduleEvidence?: unknown }): Promise<{ id: string }>;
};

const similarScheduleHistorySchema = z.object({
  query: z.string().trim().min(2).max(80).optional(),
  goalId: z.string().optional(),
  taskId: z.string().optional(),
  routineId: z.string().optional(),
  days: z.number().int().min(7).max(180).default(90),
  limit: z.number().int().min(1).max(20).default(12),
}).refine((input) => Boolean(input.query || input.goalId || input.taskId || input.routineId), {
  message: "请至少提供活动关键词或关联目标/任务/Routine。",
});

const scheduleCandidateSchema = z.object({
  label: z.string().trim().max(80).optional(),
  startsAt: z.string().min(10),
  endsAt: z.string().min(10),
});

export function createToolRegistry(gateway: AgentDomainGateway): Map<string, AgentTool> {
  const tools: AgentTool[] = [
    {
      name: "read_goal_context", description: "读取一个目标及其结果指标、里程碑、任务和 Routine。", risk: "read",
      policy: readPolicy((input) => [`goal:${typeof input === "object" && input && "goalId" in input ? String((input as { goalId?: unknown }).goalId ?? "all") : "all"}`]),
      inputSchema: z.object({ goalId: z.string().optional() }),
      execute: async (raw, context) => ({ ok: true, data: await gateway.readGoalContext(context.userId, z.object({ goalId: z.string().optional() }).parse(raw).goalId) }),
    },
    {
      name: "read_schedule_window", description: "读取指定时间窗口内的内部日历。", risk: "read",
      policy: readPolicy((input) => [`schedule:${JSON.stringify(input)}`]),
      inputSchema: z.object({ from: z.string(), to: z.string() }),
      execute: async (raw, context) => { const input = z.object({ from: z.string(), to: z.string() }).parse(raw); return { ok: true, data: await gateway.readScheduleWindow(context.userId, input.from, input.to) }; },
    },
    {
      name: "read_similar_schedule_history", description: "查询过去相似活动通常被安排在哪些时段。仅在用户明确要求照往常、按习惯或参考过去安排时使用；返回的习惯时段仍需用 read_schedule_window 检查当前冲突。", risk: "read",
      policy: readPolicy((input) => [`schedule-history:${JSON.stringify(input)}`]),
      inputSchema: similarScheduleHistorySchema,
      execute: async (raw, context) => ({
        ok: true,
        data: await gateway.readSimilarScheduleHistory(context.userId, similarScheduleHistorySchema.parse(raw)),
      }),
    },
    {
      name: "validate_schedule_candidates", description: "对准备推荐或写入的具体候选时段做最终冲突校验。提出任何具体时间建议前必须调用；返回 allAvailable=false 时必须调整候选后重试，不能声称该时段空闲。", risk: "read",
      policy: { parallelSafe: false, access: "read", resourceKeys: (input) => [`schedule-validation:${JSON.stringify(input)}`], requiresEvidence: ["read_schedule_window"] },
      inputSchema: z.object({ candidates: z.array(scheduleCandidateSchema).min(1).max(20) }),
      execute: async (raw, context) => {
        const input = z.object({ candidates: z.array(scheduleCandidateSchema).min(1).max(20) }).parse(raw);
        return { ok: true, data: await gateway.validateScheduleCandidates(context.userId, input.candidates) };
      },
    },
    {
      name: "read_execution_history", description: "读取近期执行记录和 Rhythm Feedback。", risk: "read",
      policy: readPolicy((input) => [`execution:${JSON.stringify(input)}`]),
      inputSchema: z.object({ days: z.number().int().min(1).max(90).default(28) }),
      execute: async (raw, context) => ({ ok: true, data: await gateway.readExecutionHistory(context.userId, z.object({ days: z.number().int().min(1).max(90).default(28) }).parse(raw).days) }),
    },
    {
      name: "read_recent_reviews", description: "读取最近的日回顾和周回顾。", risk: "read",
      policy: readPolicy((input) => [`reviews:${JSON.stringify(input)}`]),
      inputSchema: z.object({ limit: z.number().int().min(1).max(10).default(4) }),
      execute: async (raw, context) => ({ ok: true, data: await gateway.readRecentReviews(context.userId, z.object({ limit: z.number().int().min(1).max(10).default(4) }).parse(raw).limit) }),
    },
    {
      name: "read_rhythm_signals", description: "读取从真实执行中提取的当前有效节奏信号。", risk: "read",
      policy: readPolicy((input) => [`rhythm-signals:${JSON.stringify(input)}`]),
      inputSchema: z.object({ limit: z.number().int().min(1).max(30).default(12) }),
      execute: async (raw, context) => ({ ok: true, data: await gateway.readRhythmSignals(context.userId, z.object({ limit: z.number().int().min(1).max(30).default(12) }).parse(raw).limit) }),
    },
    {
      name: "propose_planning", description: "生成严格符合 Planning schema 的 Outcome→Milestone→Task→Routine 规划树，并保存为待确认草案。", risk: "draft_write",
      policy: draftPolicy((input) => [`planning:${typeof input === "object" && input && "goalId" in input ? String((input as { goalId?: unknown }).goalId ?? "unknown") : "unknown"}`]),
      inputSchema: z.object({ goalId: z.string(), planning: planningDraftSchema }),
      execute: async (raw, context) => {
        const { goalId, planning } = z.object({ goalId: z.string(), planning: planningDraftSchema }).parse(raw);
        const operations: z.infer<typeof changeSetDraftSchema>["operations"] = [];
        operations.push({ type: "update", entity: "goal", entityId: goalId, before: {}, after: { title: planning.goal.title, description: planning.goal.description, category: planning.goal.category, project: planning.goal.project, skill: planning.goal.skill, targetDate: planning.goal.targetDate, status: "active" } });
        planning.outcomes.forEach((outcome) => operations.push({ type: "create", entity: "outcome", payload: { goalId, ...outcome } }));
        planning.milestones.forEach((milestone, index) => {
          const milestoneRef = `milestone-${index}`;
          operations.push({ type: "create", entity: "milestone", payload: { goalId, clientRef: milestoneRef, title: milestone.title, description: milestone.description, position: index } });
          milestone.tasks.forEach((task) => operations.push({ type: "create", entity: "task", payload: { goalId, milestoneRef, ...task } }));
        });
        planning.routines.forEach((routine) => operations.push({ type: "create", entity: "routine", payload: { goalId, ...routine } }));
        const draft = changeSetDraftSchema.parse({ title: `${planning.goal.title} · 规划草案`, reason: "根据澄清信息生成结构化目标规划，确认后才会写入。", riskLevel: "medium", operations });
        const created = await gateway.createChangeSet({ userId: context.userId, runId: context.runId, idempotencyKey: context.idempotencyKey, draft, scheduleEvidence: context.scheduleEvidence });
        return { ok: true, data: { changeSetId: created.id, status: "awaiting_confirmation" } };
      },
    },
    {
      name: "propose_change_set", description: "提出业务变更草案。工具只创建待确认 ChangeSet，不修改正式数据。", risk: "draft_write",
      policy: draftPolicy(() => ["change-set"]),
      inputSchema: changeSetDraftSchema,
      execute: async (raw, context) => {
        const draft = changeSetDraftSchema.parse(raw);
        const created = await gateway.createChangeSet({ userId: context.userId, runId: context.runId, idempotencyKey: context.idempotencyKey, draft, scheduleEvidence: context.scheduleEvidence });
        return { ok: true, data: { changeSetId: created.id, status: "awaiting_confirmation" } };
      },
    },
  ];
  return new Map(tools.map((tool) => [tool.name, tool]));
}
