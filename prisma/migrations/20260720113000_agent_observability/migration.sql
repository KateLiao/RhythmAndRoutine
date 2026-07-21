ALTER TABLE "AgentRun"
ADD COLUMN "intentResolution" JSONB,
ADD COLUMN "executionPlan" JSONB,
ADD COLUMN "contextMetrics" JSONB;

ALTER TABLE "ToolCall"
ADD COLUMN "toolCallId" TEXT,
ADD COLUMN "batchId" TEXT,
ADD COLUMN "completionOrder" INTEGER;

CREATE INDEX "ToolCall_agentStepId_batchId_idx" ON "ToolCall"("agentStepId", "batchId");
