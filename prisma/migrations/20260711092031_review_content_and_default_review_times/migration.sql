-- DropIndex
DROP INDEX "AgentRun_exitReason_idx";

-- DropIndex
DROP INDEX "AgentStep_agentRunId_kind_idx";

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "content" JSONB;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "dailyReviewTime" SET DEFAULT '23:00',
ALTER COLUMN "weeklyReviewTime" SET DEFAULT '23:00';
