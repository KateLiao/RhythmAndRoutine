CREATE SCHEMA IF NOT EXISTS "public";

CREATE TYPE "GoalStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED');
CREATE TYPE "MilestoneStatus" AS ENUM ('PENDING', 'READY_FOR_REVIEW', 'COMPLETED', 'REJECTED', 'ARCHIVED');
CREATE TYPE "TaskStatus" AS ENUM ('DRAFT', 'READY', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED', 'CANCELLED', 'ARCHIVED');
CREATE TYPE "RoutineStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');
CREATE TYPE "ScheduleBlockStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'MISSED', 'RESCHEDULED', 'CANCELLED');
CREATE TYPE "ReviewStatus" AS ENUM ('GENERATING', 'DRAFT', 'AWAITING_CONFIRMATION', 'CONFIRMED', 'FAILED');
CREATE TYPE "ReviewType" AS ENUM ('DAILY', 'WEEKLY', 'MILESTONE');
CREATE TYPE "AgentRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'AWAITING_CONFIRMATION', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "ChangeSetStatus" AS ENUM ('DRAFT', 'AWAITING_CONFIRMATION', 'APPROVED', 'REJECTED', 'APPLIED', 'FAILED');
CREATE TYPE "TriggerSource" AS ENUM ('USER', 'SCHEDULED', 'SYSTEM');
CREATE TYPE "ToolRisk" AS ENUM ('READ', 'DRAFT_WRITE', 'CONFIRMED_WRITE', 'SYSTEM');

CREATE TABLE "User" (
    "id" TEXT NOT NULL, "displayName" TEXT NOT NULL, "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "dailyReviewTime" TEXT NOT NULL DEFAULT '21:30', "weeklyReviewDay" INTEGER NOT NULL DEFAULT 0,
    "weeklyReviewTime" TEXT NOT NULL DEFAULT '20:30', "defaultModel" TEXT NOT NULL DEFAULT 'qwen-plus',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Goal" (
    "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "title" TEXT NOT NULL, "description" TEXT, "category" TEXT,
    "project" TEXT, "skill" TEXT, "status" "GoalStatus" NOT NULL DEFAULT 'DRAFT', "targetDate" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1, "archivedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Outcome" (
    "id" TEXT NOT NULL, "goalId" TEXT NOT NULL, "description" TEXT NOT NULL, "completedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "Outcome_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Milestone" (
    "id" TEXT NOT NULL, "goalId" TEXT NOT NULL, "title" TEXT NOT NULL, "description" TEXT,
    "status" "MilestoneStatus" NOT NULL DEFAULT 'PENDING', "targetDate" TIMESTAMP(3), "completedAt" TIMESTAMP(3),
    "position" INTEGER NOT NULL DEFAULT 0, "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Milestone_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Task" (
    "id" TEXT NOT NULL, "goalId" TEXT NOT NULL, "milestoneId" TEXT, "parentTaskId" TEXT, "title" TEXT NOT NULL,
    "intent" TEXT, "completionCriteria" JSONB, "suggestedSteps" JSONB, "estimatedMinutes" INTEGER,
    "energyLevel" TEXT, "focusLevel" TEXT, "rhythmConditions" JSONB,
    "status" "TaskStatus" NOT NULL DEFAULT 'DRAFT', "position" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3), "version" INTEGER NOT NULL DEFAULT 1, "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Routine" (
    "id" TEXT NOT NULL, "goalId" TEXT NOT NULL, "title" TEXT NOT NULL, "description" TEXT,
    "recurrenceRule" TEXT NOT NULL, "targetMinutes" INTEGER, "minimumVersion" TEXT,
    "status" "RoutineStatus" NOT NULL DEFAULT 'DRAFT', "version" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "Routine_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ScheduleBlock" (
    "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "goalId" TEXT, "taskId" TEXT, "routineId" TEXT, "title" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL, "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "ScheduleBlockStatus" NOT NULL DEFAULT 'PLANNED', "flexibility" TEXT, "source" TEXT NOT NULL DEFAULT 'manual',
    "rescheduledFromId" TEXT, "changeReason" TEXT, "version" INTEGER NOT NULL DEFAULT 1, "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ScheduleBlock_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ExecutionRecord" (
    "id" TEXT NOT NULL, "scheduleBlockId" TEXT NOT NULL, "actualStartedAt" TIMESTAMP(3), "actualEndedAt" TIMESTAMP(3),
    "actualMinutes" INTEGER, "result" TEXT NOT NULL, "quality" TEXT, "obstacle" TEXT, "deviationReason" TEXT,
    "nextAction" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExecutionRecord_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "RhythmFeedback" (
    "id" TEXT NOT NULL, "executionRecordId" TEXT NOT NULL, "tags" TEXT[], "note" TEXT, "comfortable" BOOLEAN,
    "timeFit" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RhythmFeedback_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "RhythmSignal" (
    "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "type" TEXT NOT NULL, "statement" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION, "evidence" JSONB, "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "RhythmSignal_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Review" (
    "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "type" "ReviewType" NOT NULL, "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL, "status" "ReviewStatus" NOT NULL DEFAULT 'DRAFT', "summary" TEXT,
    "metrics" JSONB, "findings" JSONB, "suggestions" JSONB, "confirmedAt" TIMESTAMP(3), "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "capability" TEXT NOT NULL, "triggerSource" "TriggerSource" NOT NULL,
    "modelProvider" TEXT NOT NULL, "modelId" TEXT NOT NULL, "status" "AgentRunStatus" NOT NULL DEFAULT 'QUEUED',
    "maxSteps" INTEGER NOT NULL DEFAULT 12, "maxTokens" INTEGER, "inputSummary" TEXT, "finalSummary" TEXT,
    "errorCode" TEXT, "errorMessage" TEXT, "startedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AgentStep" (
    "id" TEXT NOT NULL, "agentRunId" TEXT NOT NULL, "sequence" INTEGER NOT NULL, "kind" TEXT NOT NULL,
    "inputSummary" TEXT, "outputSummary" TEXT, "inputTokens" INTEGER, "outputTokens" INTEGER,
    "estimatedCost" DECIMAL(12,6), "durationMs" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentStep_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ToolCall" (
    "id" TEXT NOT NULL, "agentStepId" TEXT NOT NULL, "toolName" TEXT NOT NULL, "risk" "ToolRisk" NOT NULL,
    "input" JSONB NOT NULL, "output" JSONB, "idempotencyKey" TEXT, "status" TEXT NOT NULL, "errorCode" TEXT,
    "durationMs" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ToolCall_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ContextManifestItem" (
    "id" TEXT NOT NULL, "agentRunId" TEXT NOT NULL, "entityType" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "version" INTEGER, "reason" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContextManifestItem_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ChangeSet" (
    "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "agentRunId" TEXT, "status" "ChangeSetStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL, "reason" TEXT NOT NULL, "riskLevel" TEXT NOT NULL, "operations" JSONB NOT NULL,
    "baseVersions" JSONB NOT NULL, "decisionNote" TEXT, "decidedAt" TIMESTAMP(3), "appliedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "ChangeSet_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Goal_userId_status_idx" ON "Goal"("userId", "status");
CREATE INDEX "Milestone_goalId_position_idx" ON "Milestone"("goalId", "position");
CREATE INDEX "Task_goalId_status_idx" ON "Task"("goalId", "status");
CREATE INDEX "Routine_goalId_status_idx" ON "Routine"("goalId", "status");
CREATE INDEX "ScheduleBlock_userId_startsAt_idx" ON "ScheduleBlock"("userId", "startsAt");
CREATE UNIQUE INDEX "ExecutionRecord_scheduleBlockId_key" ON "ExecutionRecord"("scheduleBlockId");
CREATE UNIQUE INDEX "RhythmFeedback_executionRecordId_key" ON "RhythmFeedback"("executionRecordId");
CREATE INDEX "RhythmSignal_userId_type_idx" ON "RhythmSignal"("userId", "type");
CREATE UNIQUE INDEX "Review_idempotencyKey_key" ON "Review"("idempotencyKey");
CREATE INDEX "AgentRun_userId_createdAt_idx" ON "AgentRun"("userId", "createdAt");
CREATE UNIQUE INDEX "AgentStep_agentRunId_sequence_key" ON "AgentStep"("agentRunId", "sequence");
CREATE UNIQUE INDEX "ToolCall_idempotencyKey_key" ON "ToolCall"("idempotencyKey");
CREATE INDEX "ContextManifestItem_agentRunId_entityType_idx" ON "ContextManifestItem"("agentRunId", "entityType");
CREATE UNIQUE INDEX "ChangeSet_idempotencyKey_key" ON "ChangeSet"("idempotencyKey");
CREATE INDEX "ChangeSet_userId_status_idx" ON "ChangeSet"("userId", "status");

ALTER TABLE "Goal" ADD CONSTRAINT "Goal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Outcome" ADD CONSTRAINT "Outcome_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "Milestone"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_parentTaskId_fkey" FOREIGN KEY ("parentTaskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Routine" ADD CONSTRAINT "Routine_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScheduleBlock" ADD CONSTRAINT "ScheduleBlock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScheduleBlock" ADD CONSTRAINT "ScheduleBlock_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ScheduleBlock" ADD CONSTRAINT "ScheduleBlock_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ScheduleBlock" ADD CONSTRAINT "ScheduleBlock_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "Routine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExecutionRecord" ADD CONSTRAINT "ExecutionRecord_scheduleBlockId_fkey" FOREIGN KEY ("scheduleBlockId") REFERENCES "ScheduleBlock"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RhythmFeedback" ADD CONSTRAINT "RhythmFeedback_executionRecordId_fkey" FOREIGN KEY ("executionRecordId") REFERENCES "ExecutionRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RhythmSignal" ADD CONSTRAINT "RhythmSignal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Review" ADD CONSTRAINT "Review_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentStep" ADD CONSTRAINT "AgentStep_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ToolCall" ADD CONSTRAINT "ToolCall_agentStepId_fkey" FOREIGN KEY ("agentStepId") REFERENCES "AgentStep"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContextManifestItem" ADD CONSTRAINT "ContextManifestItem_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChangeSet" ADD CONSTRAINT "ChangeSet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChangeSet" ADD CONSTRAINT "ChangeSet_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
