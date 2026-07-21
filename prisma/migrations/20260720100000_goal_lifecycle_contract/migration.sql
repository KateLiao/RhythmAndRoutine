-- Contract GoalStatus only after all legacy DRAFT rows were normalized.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Goal" WHERE "status"::text = 'DRAFT') THEN
    RAISE EXCEPTION 'GoalStatus contract blocked: DRAFT rows still exist';
  END IF;
END $$;

ALTER TABLE "Goal" ALTER COLUMN "status" DROP DEFAULT;
CREATE TYPE "GoalStatus_v040" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED');
ALTER TABLE "Goal"
  ALTER COLUMN "status" TYPE "GoalStatus_v040"
  USING ("status"::text::"GoalStatus_v040");
DROP TYPE "GoalStatus";
ALTER TYPE "GoalStatus_v040" RENAME TO "GoalStatus";
ALTER TABLE "Goal" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
