-- V2 is additive: historical feedback fields and values remain untouched.
ALTER TABLE "ExecutionRecord"
  ADD COLUMN "feedbackVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "RhythmFeedback"
  ADD COLUMN "focusState" TEXT;

ALTER TABLE "RoutineExecutionRecord"
  ADD COLUMN "result" TEXT,
  ADD COLUMN "quality" TEXT,
  ADD COLUMN "focusState" TEXT,
  ADD COLUMN "feedbackVersion" INTEGER NOT NULL DEFAULT 1;
