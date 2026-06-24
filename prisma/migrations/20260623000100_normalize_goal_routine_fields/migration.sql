ALTER TABLE "Routine" RENAME COLUMN "targetMinutes" TO "durationMinutes";
ALTER TABLE "Routine" ADD COLUMN "preferredEndTime" TEXT;

-- Repair legacy Agent payloads that stored schedule metadata in description/minimumVersion.
WITH legacy AS (
  SELECT
    id,
    COALESCE(NULLIF(description, ''), "minimumVersion") AS details
  FROM "Routine"
  WHERE COALESCE(NULLIF(description, ''), "minimumVersion")
    ~ '^时段 [0-9]{2}:[0-9]{2}-[0-9]{2}:[0-9]{2}；有效期 [0-9]{4}-[0-9]{2}-[0-9]{2} [–-] [0-9]{4}-[0-9]{2}-[0-9]{2}$'
)
UPDATE "Routine" AS routine
SET
  "preferredStartTime" = COALESCE(routine."preferredStartTime", substring(legacy.details FROM '时段 ([0-9]{2}:[0-9]{2})-')),
  "preferredEndTime" = COALESCE(routine."preferredEndTime", substring(legacy.details FROM '时段 [0-9]{2}:[0-9]{2}-([0-9]{2}:[0-9]{2})')),
  "preferredTimeOfDay" = COALESCE(
    routine."preferredTimeOfDay",
    CASE
      WHEN substring(legacy.details FROM '时段 ([0-9]{2})')::int < 12 THEN 'morning'
      WHEN substring(legacy.details FROM '时段 ([0-9]{2})')::int < 18 THEN 'afternoon'
      WHEN substring(legacy.details FROM '时段 ([0-9]{2})')::int < 22 THEN 'evening'
      ELSE 'night'
    END
  ),
  "startDate" = substring(legacy.details FROM '有效期 ([0-9]{4}-[0-9]{2}-[0-9]{2})')::date::timestamp - interval '8 hours',
  "endDate" = substring(legacy.details FROM '[–-] ([0-9]{4}-[0-9]{2}-[0-9]{2})$')::date::timestamp + interval '15 hours 59 minutes',
  "durationMinutes" = CASE
    WHEN routine."preferredStartTime" IS NULL THEN
      EXTRACT(EPOCH FROM (
        substring(legacy.details FROM '时段 [0-9]{2}:[0-9]{2}-([0-9]{2}:[0-9]{2})')::time
        - substring(legacy.details FROM '时段 ([0-9]{2}:[0-9]{2})-')::time
      ))::int / 60
    ELSE routine."durationMinutes"
  END,
  description = CASE WHEN routine.description = legacy.details THEN NULL ELSE routine.description END,
  "minimumVersion" = CASE WHEN routine."minimumVersion" = legacy.details THEN NULL ELSE routine."minimumVersion" END,
  "recurrenceRule" = routine."recurrenceRule"
    || CASE WHEN routine."recurrenceRule" NOT LIKE '%BYHOUR=%' THEN ';BYHOUR=' || substring(legacy.details FROM '时段 ([0-9]{2})') ELSE '' END
    || CASE WHEN routine."recurrenceRule" NOT LIKE '%BYMINUTE=%' THEN ';BYMINUTE=' || substring(legacy.details FROM '时段 [0-9]{2}:([0-9]{2})') ELSE '' END,
  version = version + 1
FROM legacy
WHERE routine.id = legacy.id;
