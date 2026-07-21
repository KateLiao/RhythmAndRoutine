-- Expand-only foundation for V0.4.0 goal execution.
-- This migration intentionally keeps GoalStatus.DRAFT and existing rows unchanged.

CREATE TYPE "MilestoneSuggestionStatus" AS ENUM ('PENDING', 'SNOOZED', 'DISMISSED', 'ACCEPTED', 'SUPERSEDED');
CREATE TYPE "AchievementEventType" AS ENUM ('UNLOCKED', 'REVOKED', 'RESTORED');

ALTER TABLE "Goal" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

ALTER TABLE "Milestone"
  ADD COLUMN "completionCriteria" JSONB,
  ADD COLUMN "completedByUserId" TEXT;

CREATE TABLE "MilestoneReviewSuggestion" (
  "id" TEXT NOT NULL,
  "milestoneId" TEXT NOT NULL,
  "milestoneVersion" INTEGER NOT NULL,
  "evidenceFingerprint" TEXT NOT NULL,
  "evidence" JSONB NOT NULL,
  "reason" TEXT NOT NULL,
  "status" "MilestoneSuggestionStatus" NOT NULL DEFAULT 'PENDING',
  "suggestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "snoozedUntil" TIMESTAMP(3),
  "decisionReason" TEXT,
  "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MilestoneReviewSuggestion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GoalAchievement" (
  "id" TEXT NOT NULL,
  "goalId" TEXT NOT NULL,
  "achievementId" TEXT NOT NULL,
  "definitionVersion" INTEGER NOT NULL,
  "unlockedAt" TIMESTAMP(3) NOT NULL,
  "evidence" JSONB NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "revokeReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GoalAchievement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GoalAchievementEvent" (
  "id" TEXT NOT NULL,
  "goalAchievementId" TEXT NOT NULL,
  "type" "AchievementEventType" NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "evidence" JSONB NOT NULL,
  "reason" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  CONSTRAINT "GoalAchievementEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MilestoneReviewSuggestion_milestoneId_evidenceFingerprint_key"
  ON "MilestoneReviewSuggestion"("milestoneId", "evidenceFingerprint");
CREATE INDEX "MilestoneReviewSuggestion_milestoneId_status_suggestedAt_idx"
  ON "MilestoneReviewSuggestion"("milestoneId", "status", "suggestedAt");
CREATE UNIQUE INDEX "GoalAchievement_goalId_achievementId_key"
  ON "GoalAchievement"("goalId", "achievementId");
CREATE INDEX "GoalAchievement_goalId_revokedAt_unlockedAt_idx"
  ON "GoalAchievement"("goalId", "revokedAt", "unlockedAt");
CREATE UNIQUE INDEX "GoalAchievementEvent_idempotencyKey_key"
  ON "GoalAchievementEvent"("idempotencyKey");
CREATE INDEX "GoalAchievementEvent_goalAchievementId_occurredAt_idx"
  ON "GoalAchievementEvent"("goalAchievementId", "occurredAt");

ALTER TABLE "Milestone"
  ADD CONSTRAINT "Milestone_completedByUserId_fkey"
  FOREIGN KEY ("completedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MilestoneReviewSuggestion"
  ADD CONSTRAINT "MilestoneReviewSuggestion_milestoneId_fkey"
  FOREIGN KEY ("milestoneId") REFERENCES "Milestone"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GoalAchievement"
  ADD CONSTRAINT "GoalAchievement_goalId_fkey"
  FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GoalAchievementEvent"
  ADD CONSTRAINT "GoalAchievementEvent_goalAchievementId_fkey"
  FOREIGN KEY ("goalAchievementId") REFERENCES "GoalAchievement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
