import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { ScheduleBlockStatus, TaskStatus } from "../src/generated/prisma/enums";

type RepairCandidate = {
  id: string;
  title: string;
  status: TaskStatus;
  completedAt: Date | null;
  completionRecord: Prisma.JsonValue | null;
  version: number;
  scheduleBlocks: Array<{ id: string; status: ScheduleBlockStatus }>;
  linkedScheduleBlocks: Array<{ scheduleBlock: { id: string; status: ScheduleBlockStatus } }>;
};

const repairCandidateScope = {
  archivedAt: null,
  status: TaskStatus.COMPLETED,
  completionRecord: { equals: Prisma.DbNull },
} satisfies Prisma.TaskWhereInput;

/**
 * 构造单个候选任务的条件更新约束，防止并发确认完成或版本变化被修复覆盖。
 * @param id - 候选任务 ID
 * @param version - dry-run 查询时的任务版本
 * @returns 同时约束 ID、版本、未归档、已完成且无完成记录的 Prisma 条件
 */
export function buildRepairUpdateGuard(id: string, version: number): Prisma.TaskWhereInput {
  return { ...repairCandidateScope, id, version };
}

/**
 * 在脚本直接运行时加载项目根目录的环境变量。
 * @returns 无返回值
 */
function loadProjectEnvironment(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!process.env.DATABASE_URL && existsSync(envPath)) loadEnvFile(envPath);
}

/**
 * 根据任务关联的全部有效日程块，重算不会自动完成任务的推进状态。
 * @param statuses - 去重后的关联日程块状态
 * @returns READY、SCHEDULED、IN_PROGRESS 或 BLOCKED
 */
export function deriveRepairTaskStatus(statuses: ScheduleBlockStatus[]): TaskStatus {
  if (!statuses.length) return TaskStatus.READY;
  if (statuses.includes(ScheduleBlockStatus.IN_PROGRESS)) return TaskStatus.IN_PROGRESS;
  if (statuses.some((status) => status === ScheduleBlockStatus.PLANNED || status === ScheduleBlockStatus.COMPLETED)) return TaskStatus.SCHEDULED;
  if (statuses.every((status) => status === ScheduleBlockStatus.MISSED || status === ScheduleBlockStatus.RESCHEDULED || status === ScheduleBlockStatus.CANCELLED)) return TaskStatus.BLOCKED;
  return TaskStatus.READY;
}

/**
 * 合并主 taskId 与 ScheduleBlockTask 关联的日程块，并按日程块 ID 去重。
 * @param candidate - 待修复任务及其两类日程关联
 * @returns 去重后的日程块 ID、状态列表
 */
function collectCandidateBlocks(candidate: RepairCandidate): Array<{ id: string; status: ScheduleBlockStatus }> {
  const byId = new Map<string, { id: string; status: ScheduleBlockStatus }>();
  for (const block of candidate.scheduleBlocks) byId.set(block.id, block);
  for (const link of candidate.linkedScheduleBlocks) byId.set(link.scheduleBlock.id, link.scheduleBlock);
  return [...byId.values()];
}

/**
 * 为 apply 模式写入候选任务关键字段备份，便于按 ID 审计或人工回滚。
 * @param candidates - 执行前候选任务
 * @param path - JSON 备份文件路径
 * @returns 已写入的绝对路径
 */
function writeBackup(candidates: RepairCandidate[], path: string): string {
  const absolutePath = resolve(path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify({
    createdAt: new Date().toISOString(),
    candidateCount: candidates.length,
    tasks: candidates.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      completedAt: task.completedAt?.toISOString() ?? null,
      completionRecord: task.completionRecord,
      version: task.version,
    })),
  }, null, 2)}\n`, "utf8");
  return absolutePath;
}

/**
 * 查询缺少用户完成记录的已完成任务；有 completionRecord 的任务永远不进入候选集。
 * @param db - Prisma 客户端
 * @returns 待修复任务及其全部有效日程关联
 */
async function findCandidates(db: PrismaClient): Promise<RepairCandidate[]> {
  return db.task.findMany({
    where: repairCandidateScope,
    select: {
      id: true,
      title: true,
      status: true,
      completedAt: true,
      completionRecord: true,
      version: true,
      scheduleBlocks: {
        where: { deletedAt: null },
        select: { id: true, status: true },
      },
      linkedScheduleBlocks: {
        where: { scheduleBlock: { deletedAt: null } },
        select: { scheduleBlock: { select: { id: true, status: true } } },
      },
    },
    orderBy: { updatedAt: "asc" },
  });
}

/**
 * 输出候选任务的旧状态、新状态与关联块数量，供 dry-run 和 apply 共用。
 * @param candidates - 待修复任务
 * @returns 每个任务的审计摘要
 */
function buildAuditRows(candidates: RepairCandidate[]) {
  return candidates.map((candidate) => {
    const blocks = collectCandidateBlocks(candidate);
    return {
      id: candidate.id,
      title: candidate.title,
      oldStatus: candidate.status,
      newStatus: deriveRepairTaskStatus(blocks.map((block) => block.status)),
      linkedBlockCount: blocks.length,
      version: candidate.version,
    };
  });
}

/**
 * 执行存量误完成任务修复；默认只预览，传入 --apply 才条件更新数据库。
 * @returns 无返回值
 */
async function main(): Promise<void> {
  loadProjectEnvironment();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  const apply = process.argv.includes("--apply");
  const backupArg = process.argv.find((argument) => argument.startsWith("--backup="))?.slice("--backup=".length);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = backupArg ?? `.trellis/tasks/07-11-fix-review-rhythm-followups/artifacts/auto-completed-tasks-${stamp}.json`;
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  try {
    const confirmedBefore = await db.task.count({
      where: { status: TaskStatus.COMPLETED, completionRecord: { not: Prisma.DbNull } },
    });
    const candidates = await findCandidates(db);
    const rows = buildAuditRows(candidates);
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", candidates: candidates.length, confirmedCompleted: confirmedBefore, rows }, null, 2));

    if (!apply) return;
    const writtenBackup = writeBackup(candidates, backupPath);
    let updated = 0;
    for (const row of rows) {
      const result = await db.task.updateMany({
        where: buildRepairUpdateGuard(row.id, row.version),
        data: {
          status: row.newStatus,
          completedAt: null,
          completionRecord: Prisma.DbNull,
          version: { increment: 1 },
        },
      });
      updated += result.count;
    }

    const candidatesAfter = await findCandidates(db);
    const confirmedAfter = await db.task.count({
      where: { status: TaskStatus.COMPLETED, completionRecord: { not: Prisma.DbNull } },
    });
    console.log(JSON.stringify({
      result: "completed",
      backup: writtenBackup,
      attempted: rows.length,
      updated,
      candidatesAfter: candidatesAfter.length,
      confirmedCompletedBefore: confirmedBefore,
      confirmedCompletedAfter: confirmedAfter,
    }, null, 2));
  } finally {
    await db.$disconnect();
  }
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPath === import.meta.url) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
