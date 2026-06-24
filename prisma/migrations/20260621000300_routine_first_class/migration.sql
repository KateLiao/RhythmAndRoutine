ALTER TYPE "RoutineStatus" ADD VALUE IF NOT EXISTS 'COMPLETED';

ALTER TABLE "Routine"
  ADD COLUMN "startDate" TIMESTAMP(3),
  ADD COLUMN "endDate" TIMESTAMP(3),
  ADD COLUMN "preferredStartTime" TEXT,
  ADD COLUMN "preferredTimeOfDay" TEXT,
  ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'medium',
  ADD COLUMN "displayMode" TEXT NOT NULL DEFAULT 'subtle';

UPDATE "Routine" SET "startDate" = "createdAt" WHERE "startDate" IS NULL;
UPDATE "Routine" SET "targetMinutes" = 20 WHERE "targetMinutes" IS NULL;
ALTER TABLE "Routine" ALTER COLUMN "startDate" SET NOT NULL;
ALTER TABLE "Routine" ALTER COLUMN "startDate" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Routine" ALTER COLUMN "targetMinutes" SET NOT NULL;
ALTER TABLE "Routine" ALTER COLUMN "targetMinutes" SET DEFAULT 20;

CREATE TABLE "RoutineExecutionRecord" (
  "id" TEXT NOT NULL,
  "routineId" TEXT NOT NULL,
  "occurrenceDate" TIMESTAMP(3) NOT NULL,
  "plannedStartAt" TIMESTAMP(3),
  "plannedEndAt" TIMESTAMP(3),
  "status" TEXT NOT NULL,
  "actualMinutes" INTEGER,
  "feedbackTags" TEXT[],
  "note" TEXT,
  "rescheduledStartAt" TIMESTAMP(3),
  "rescheduledEndAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RoutineExecutionRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RoutineExecutionRecord_routineId_occurrenceDate_key" ON "RoutineExecutionRecord"("routineId", "occurrenceDate");
CREATE INDEX "RoutineExecutionRecord_routineId_occurrenceDate_idx" ON "RoutineExecutionRecord"("routineId", "occurrenceDate");
ALTER TABLE "RoutineExecutionRecord" ADD CONSTRAINT "RoutineExecutionRecord_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "Routine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Old materialized Routine blocks are legacy projections. Their historical execution data is retained,
-- but fresh calendar reads ignore them and dynamically expand Routine definitions instead.
