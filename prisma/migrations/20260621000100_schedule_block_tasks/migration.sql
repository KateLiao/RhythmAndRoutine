-- CreateTable
CREATE TABLE "ScheduleBlockTask" (
    "id" TEXT NOT NULL,
    "scheduleBlockId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleBlockTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduleBlockTask_taskId_idx" ON "ScheduleBlockTask"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleBlockTask_scheduleBlockId_taskId_key" ON "ScheduleBlockTask"("scheduleBlockId", "taskId");

-- AddForeignKey
ALTER TABLE "ScheduleBlockTask" ADD CONSTRAINT "ScheduleBlockTask_scheduleBlockId_fkey" FOREIGN KEY ("scheduleBlockId") REFERENCES "ScheduleBlock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleBlockTask" ADD CONSTRAINT "ScheduleBlockTask_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migrate existing single task links into junction table
INSERT INTO "ScheduleBlockTask" ("id", "scheduleBlockId", "taskId", "position")
SELECT
    md5("ScheduleBlock"."id" || ':' || "ScheduleBlock"."taskId"),
    "ScheduleBlock"."id",
    "ScheduleBlock"."taskId",
    0
FROM "ScheduleBlock"
WHERE "ScheduleBlock"."taskId" IS NOT NULL
ON CONFLICT ("scheduleBlockId", "taskId") DO NOTHING;
