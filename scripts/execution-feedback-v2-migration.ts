import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const DEFAULT_SNAPSHOT = ".trellis/tasks/07-20-v0-4-0-goal-execution/research/backups/execution-feedback-v2-legacy-baseline.json";

function loadProjectEnvironment(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!process.env.DATABASE_URL && existsSync(envPath)) loadEnvFile(envPath);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function summarizeTable<T extends { id: string }>(rows: T[]) {
  const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  return { count: sorted.length, digest: digest(sorted), rows: sorted };
}

async function collectLegacySnapshot(db: PrismaClient) {
  const [executionRecords, rhythmFeedback, routineExecutionRecords] = await Promise.all([
    db.executionRecord.findMany({ select: {
      id: true, scheduleBlockId: true, actualStartedAt: true, actualEndedAt: true,
      actualMinutes: true, result: true, quality: true, obstacle: true,
      deviationReason: true, nextAction: true, createdAt: true, updatedAt: true,
    } }),
    db.rhythmFeedback.findMany({ select: {
      id: true, executionRecordId: true, tags: true, note: true, comfortable: true,
      timeFit: true, createdAt: true, updatedAt: true,
    } }),
    db.routineExecutionRecord.findMany({ select: {
      id: true, routineId: true, occurrenceDate: true, plannedStartAt: true,
      plannedEndAt: true, status: true, actualMinutes: true, feedbackTags: true,
      note: true, rescheduledStartAt: true, rescheduledEndAt: true,
      createdAt: true, updatedAt: true,
    } }),
  ]);
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    tables: {
      executionRecords: summarizeTable(executionRecords),
      rhythmFeedback: summarizeTable(rhythmFeedback),
      routineExecutionRecords: summarizeTable(routineExecutionRecords),
    },
  };
}

type Snapshot = Awaited<ReturnType<typeof collectLegacySnapshot>>;

function comparable(snapshot: Snapshot) {
  return { schemaVersion: snapshot.schemaVersion, tables: snapshot.tables };
}

function verifySnapshots(before: Snapshot, after: Snapshot): void {
  if (JSON.stringify(comparable(before)) !== JSON.stringify(comparable(after))) {
    throw new Error("执行反馈 V2 迁移校验失败：历史字段或记录发生了变化。");
  }
}

async function verifyNewColumnDefaults(db: PrismaClient) {
  const [executionRecords, rhythmFeedback, routineExecutionRecords] = await Promise.all([
    db.executionRecord.findMany({ select: { id: true, feedbackVersion: true } }),
    db.rhythmFeedback.findMany({ select: { id: true, focusState: true } }),
    db.routineExecutionRecord.findMany({ select: { id: true, result: true, quality: true, focusState: true, feedbackVersion: true } }),
  ]);
  const invalidExecutionRecords = executionRecords.filter((record) => record.feedbackVersion !== 1);
  const invalidRhythmFeedback = rhythmFeedback.filter((record) => record.focusState !== null);
  const invalidRoutineRecords = routineExecutionRecords.filter((record) => record.feedbackVersion !== 1 || record.result !== null || record.quality !== null || record.focusState !== null);
  if (invalidExecutionRecords.length || invalidRhythmFeedback.length || invalidRoutineRecords.length) {
    throw new Error("执行反馈 V2 迁移校验失败：历史记录的新列默认值不符合兼容约定。");
  }
  return {
    executionRecordsAtV1: executionRecords.length,
    rhythmFeedbackWithoutFocusState: rhythmFeedback.length,
    routineExecutionRecordsAtV1: routineExecutionRecords.length,
  };
}

async function main(): Promise<void> {
  loadProjectEnvironment();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const command = process.argv[2] ?? "snapshot";
  const snapshotPath = resolve(process.argv[3] ?? DEFAULT_SNAPSHOT);

  try {
    if (command === "snapshot") {
      const snapshot = await collectLegacySnapshot(db);
      mkdirSync(dirname(snapshotPath), { recursive: true });
      writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
      console.log(JSON.stringify({
        mode: "snapshot",
        path: snapshotPath,
        counts: Object.fromEntries(Object.entries(snapshot.tables).map(([key, table]) => [key, table.count])),
        digests: Object.fromEntries(Object.entries(snapshot.tables).map(([key, table]) => [key, table.digest])),
      }, null, 2));
      return;
    }

    if (command === "verify") {
      const before = JSON.parse(readFileSync(snapshotPath, "utf8")) as Snapshot;
      const after = await collectLegacySnapshot(db);
      verifySnapshots(before, after);
      const defaults = await verifyNewColumnDefaults(db);
      console.log(JSON.stringify({ mode: "verify", ok: true, allowedChanges: "new_v2_columns_only", defaults }, null, 2));
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } finally {
    await db.$disconnect();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
