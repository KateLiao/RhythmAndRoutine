ALTER TABLE "AgentRun"
ADD COLUMN "exitReason" TEXT,
ADD COLUMN "goalStatus" TEXT,
ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "AgentStep"
ADD COLUMN "loopIteration" INTEGER,
ADD COLUMN "goalStatus" TEXT,
ADD COLUMN "nextAction" TEXT,
ADD COLUMN "reason" TEXT,
ADD COLUMN "missingInformation" JSONB,
ADD COLUMN "toolAttemptCount" INTEGER;

CREATE INDEX "AgentRun_exitReason_idx" ON "AgentRun"("exitReason");
CREATE INDEX "AgentStep_agentRunId_kind_idx" ON "AgentStep"("agentRunId", "kind");
