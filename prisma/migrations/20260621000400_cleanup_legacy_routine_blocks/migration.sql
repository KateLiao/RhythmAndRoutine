-- Routine occurrences are now virtual. Remove only legacy projections that never received execution data.
DELETE FROM "ScheduleBlock" AS block
WHERE block."source" = 'routine'
  AND NOT EXISTS (
    SELECT 1 FROM "ExecutionRecord" AS execution
    WHERE execution."scheduleBlockId" = block."id"
  );
