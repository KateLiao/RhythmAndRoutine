import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const DEFAULT_SNAPSHOT = ".trellis/tasks/07-20-v0-4-0-goal-execution/research/backups/v0-4-0-goal-baseline.json";

type Snapshot = Awaited<ReturnType<typeof collectSnapshot>>;

function loadProjectEnvironment(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!process.env.DATABASE_URL && existsSync(envPath)) loadEnvFile(envPath);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function summarizeTable<T extends { id: string }>(rows: T[]) {
  const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  return { count: sorted.length, ids: sorted.map((row) => row.id), digest: digest(sorted), rows: sorted };
}

async function collectSnapshot(db: PrismaClient) {
  const [goals, outcomes, milestones, tasks, routines, routineExecutions, scheduleBlocks, scheduleBlockTasks, executionRecords] = await Promise.all([
    db.goal.findMany({ select: { id: true, userId: true, title: true, description: true, category: true, project: true, skill: true, status: true, targetDate: true, version: true, archivedAt: true, createdAt: true, updatedAt: true } }),
    db.outcome.findMany({ select: { id: true, goalId: true, description: true, completedAt: true, version: true, archivedAt: true, createdAt: true, updatedAt: true } }),
    db.milestone.findMany({ select: { id: true, goalId: true, title: true, description: true, status: true, targetDate: true, completedAt: true, position: true, version: true, createdAt: true, updatedAt: true } }),
    db.task.findMany({ select: { id: true, goalId: true, milestoneId: true, parentTaskId: true, title: true, intent: true, completionCriteria: true, suggestedSteps: true, estimatedMinutes: true, energyLevel: true, focusLevel: true, rhythmConditions: true, status: true, position: true, completedAt: true, completionRecord: true, version: true, archivedAt: true, createdAt: true, updatedAt: true } }),
    db.routine.findMany({ select: { id: true, goalId: true, title: true, description: true, recurrenceRule: true, startDate: true, endDate: true, durationMinutes: true, preferredStartTime: true, preferredEndTime: true, preferredTimeOfDay: true, priority: true, displayMode: true, minimumVersion: true, status: true, version: true, archivedAt: true, createdAt: true, updatedAt: true } }),
    db.routineExecutionRecord.findMany({ select: { id: true, routineId: true, occurrenceDate: true, plannedStartAt: true, plannedEndAt: true, status: true, actualMinutes: true, feedbackTags: true, note: true, rescheduledStartAt: true, rescheduledEndAt: true, createdAt: true, updatedAt: true } }),
    db.scheduleBlock.findMany({ select: { id: true, userId: true, goalId: true, taskId: true, routineId: true, title: true, startsAt: true, endsAt: true, status: true, flexibility: true, source: true, rescheduledFromId: true, changeReason: true, version: true, deletedAt: true, createdAt: true, updatedAt: true } }),
    db.scheduleBlockTask.findMany({ select: { id: true, scheduleBlockId: true, taskId: true, position: true, createdAt: true } }),
    db.executionRecord.findMany({ select: { id: true, scheduleBlockId: true, actualStartedAt: true, actualEndedAt: true, actualMinutes: true, result: true, quality: true, obstacle: true, deviationReason: true, nextAction: true, createdAt: true, updatedAt: true } }),
  ]);

  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    goalStatusCounts: Object.fromEntries([...new Set(goals.map((goal) => goal.status))].sort().map((status) => [status, goals.filter((goal) => goal.status === status).length])),
    tables: {
      goals: summarizeTable(goals),
      outcomes: summarizeTable(outcomes),
      milestones: summarizeTable(milestones),
      tasks: summarizeTable(tasks),
      routines: summarizeTable(routines),
      routineExecutions: summarizeTable(routineExecutions),
      scheduleBlocks: summarizeTable(scheduleBlocks),
      scheduleBlockTasks: summarizeTable(scheduleBlockTasks),
      executionRecords: summarizeTable(executionRecords),
    },
  };
}

function normalizedForComparison(snapshot: Snapshot, allowDraftToActive: boolean): Snapshot {
  if (!allowDraftToActive) return snapshot;
  const rows = snapshot.tables.goals.rows.map((goal) => ({ ...goal, status: String(goal.status) === "DRAFT" ? "ACTIVE" : goal.status }));
  return {
    ...snapshot,
    createdAt: "ignored",
    goalStatusCounts: {},
    tables: { ...snapshot.tables, goals: summarizeTable(rows) },
  };
}

function comparable(snapshot: Snapshot, allowDraftToActive: boolean): unknown {
  const normalized = normalizedForComparison(snapshot, allowDraftToActive);
  return { schemaVersion: normalized.schemaVersion, tables: normalized.tables };
}

function verifySnapshots(before: Snapshot, after: Snapshot, allowDraftToActive: boolean): void {
  const expected = comparable(before, allowDraftToActive);
  const actual = comparable(after, false);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("迁移校验失败：检测到 DRAFT→ACTIVE 之外的数据变化。数据库事务已停止，请使用备份排查。");
  }
}

function writeSnapshot(snapshot: Snapshot, path: string): string {
  const absolutePath = resolve(path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return absolutePath;
}

function readSnapshot(path: string): Snapshot {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as Snapshot;
}

async function main(): Promise<void> {
  loadProjectEnvironment();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const command = process.argv[2] ?? "snapshot";
  const snapshotPath = process.argv[3] ?? DEFAULT_SNAPSHOT;

  try {
    if (command === "snapshot") {
      const snapshot = await collectSnapshot(db);
      console.log(JSON.stringify({ mode: "snapshot", path: writeSnapshot(snapshot, snapshotPath), goalStatusCounts: snapshot.goalStatusCounts, counts: Object.fromEntries(Object.entries(snapshot.tables).map(([key, value]) => [key, value.count])) }, null, 2));
      return;
    }

    if (command === "verify") {
      const before = readSnapshot(snapshotPath);
      const after = await collectSnapshot(db);
      verifySnapshots(before, after, false);
      console.log(JSON.stringify({ mode: "verify", allowedChanges: "none", ok: true, goalStatusCounts: after.goalStatusCounts }, null, 2));
      return;
    }

    if (command === "verify-normalized") {
      const before = readSnapshot(snapshotPath);
      const after = await collectSnapshot(db);
      verifySnapshots(before, after, true);
      console.log(JSON.stringify({ mode: "verify-normalized", allowedChanges: "DRAFT_TO_ACTIVE", ok: true, goalStatusCounts: after.goalStatusCounts }, null, 2));
      return;
    }

    if (command === "apply") {
      const before = readSnapshot(snapshotPath);
      const current = await collectSnapshot(db);
      verifySnapshots(before, current, false);
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "Goal" SET "status" = 'ACTIVE'::"GoalStatus" WHERE "status" = 'DRAFT'::"GoalStatus"`;
        const after = await collectSnapshot(tx as unknown as PrismaClient);
        verifySnapshots(before, after, true);
      });
      const after = await collectSnapshot(db);
      verifySnapshots(before, after, true);
      console.log(JSON.stringify({ mode: "apply", ok: true, goalStatusCounts: after.goalStatusCounts }, null, 2));
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
