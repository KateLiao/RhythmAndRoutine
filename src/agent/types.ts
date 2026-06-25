import { z } from "zod";

export type Capability =
  | "goal_clarification"
  | "planning"
  | "review"
  | "adjustment"
  | "progress_evaluation";

export type AgentRunStatus =
  | "queued"
  | "running"
  | "awaiting_confirmation"
  | "completed"
  | "failed"
  | "cancelled";

export type ToolRisk = "read" | "draft_write" | "system";

export type LoopGoalStatus =
  | "achieved"
  | "needs_more_action"
  | "needs_user_input"
  | "awaiting_confirmation"
  | "blocked";

export type LoopNextAction =
  | "call_tool"
  | "retry_tool"
  | "switch_tool"
  | "ask_user"
  | "propose_change_set"
  | "final_answer"
  | "stop";

export type AgentExitReason =
  | "goal_achieved"
  | "awaiting_user_confirmation"
  | "awaiting_user_input"
  | "blocked_by_missing_information"
  | "blocked_by_tool_error"
  | "stopped_by_max_steps"
  | "stopped_by_max_retries"
  | "stopped_by_token_budget"
  | "stopped_by_time_budget"
  | "cancelled_by_user"
  | "runtime_error";

export type ContextReference = {
  entityType: string;
  entityId: string;
  version?: number;
  reason: string;
};

export type AgentContext = {
  user: { id: string; timezone: string; preferences: Record<string, unknown> };
  page?: { path: string; selectedEntity?: ContextReference };
  conversation: { recentMessages: Array<{ role: "user" | "assistant"; content: string }>; summary?: string };
  business: Record<string, unknown>;
  manifest: ContextReference[];
};

export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
};

export type ModelTool = {
  name: string;
  description: string;
  inputSchema: z.ZodType;
};

export type ModelRequest = {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ModelTool[];
  maxOutputTokens?: number;
};

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "model_fallback"; from: string; to: string; reason: string }
  | { type: "finish"; reason: "stop" | "tool_calls" | "length" };

export interface ModelAdapter {
  readonly provider: string;
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
  /**
   * 单次调用模型并返回符合给定 Zod schema 的结构化对象。
   * 用于不需要多轮工具调用的结构化输出场景（如 AI Review 生成）。
   * @param request - 包含 prompt、system 和 schema 的结构化请求
   */
  generateObject<T>(request: StructuredRequest<T>): Promise<T>;
}

/** generateObject 的请求参数 */
export type StructuredRequest<T> = {
  model: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxOutputTokens?: number;
};

export type ToolResult = { ok: true; data: unknown } | { ok: false; code: string; message: string; retryable: boolean };

export type AgentTool = ModelTool & {
  risk: ToolRisk;
  execute: (input: unknown, execution: ToolExecutionContext) => Promise<ToolResult>;
};

export type ToolExecutionContext = {
  userId: string;
  runId: string;
  idempotencyKey: string;
};

export type RunEvent =
  | { type: "run_started"; runId: string }
  | { type: "loop_step"; kind: "planning" | "verification" | "decision" | "final" | "recovery"; label: string; summary?: string; goalStatus?: LoopGoalStatus; nextAction?: LoopNextAction; detail?: { scope?: string; result?: string; judgment?: string; nextAction?: string; missingInformation?: string[] } }
  | { type: "text_delta"; text: string }
  | { type: "model_fallback"; from: string; to: string; reason: string }
  | { type: "tool_started"; tool: string }
  | { type: "tool_completed"; tool: string; input?: unknown; result: ToolResult }
  | { type: "approval_required"; changeSetId: string }
  | { type: "run_completed"; text: string }
  | { type: "run_failed"; code: string; message: string };

export type AgentRunRequest = {
  userId: string;
  capability: Capability;
  prompt: string;
  model: string;
  context: AgentContext;
  signal?: AbortSignal;
};
