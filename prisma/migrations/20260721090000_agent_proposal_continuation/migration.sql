-- Additive continuation metadata. Existing AgentRun and ChangeSet rows remain valid.
ALTER TYPE "ChangeSetStatus" ADD VALUE IF NOT EXISTS 'SUPERSEDED';

ALTER TABLE "AgentRun"
  ADD COLUMN "conversationId" TEXT,
  ADD COLUMN "parentRunId" TEXT,
  ADD COLUMN "continuationKind" TEXT,
  ADD COLUMN "continuationState" JSONB;

ALTER TABLE "ChangeSet"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "scheduleEvidence" JSONB,
  ADD COLUMN "supersedesChangeSetId" TEXT;

CREATE INDEX "AgentRun_conversationId_createdAt_idx" ON "AgentRun"("conversationId", "createdAt");
CREATE INDEX "AgentRun_parentRunId_idx" ON "AgentRun"("parentRunId");
CREATE UNIQUE INDEX "ChangeSet_supersedesChangeSetId_key" ON "ChangeSet"("supersedesChangeSetId");
CREATE INDEX "ChangeSet_userId_supersedesChangeSetId_idx" ON "ChangeSet"("userId", "supersedesChangeSetId");

ALTER TABLE "AgentRun"
  ADD CONSTRAINT "AgentRun_parentRunId_fkey"
  FOREIGN KEY ("parentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ChangeSet"
  ADD CONSTRAINT "ChangeSet_supersedesChangeSetId_fkey"
  FOREIGN KEY ("supersedesChangeSetId") REFERENCES "ChangeSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
