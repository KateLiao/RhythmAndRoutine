ALTER TABLE "Outcome" ADD COLUMN "archivedAt" TIMESTAMP(3);
CREATE INDEX "Outcome_goalId_archivedAt_idx" ON "Outcome"("goalId", "archivedAt");
