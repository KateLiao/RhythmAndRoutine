import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

type MissingLinkRow = {
  scheduleBlockId: string;
  title: string;
  taskId: string;
  taskTitle: string;
  status: string;
  startsAt: Date;
};

type DeepWorkLinkRow = {
  scheduleBlockId: string;
  title: string;
  goalId: string;
  taskId: string;
  taskTitle: string;
  status: string;
  startsAt: Date;
};

type RepairPlan = {
  missingLinks: MissingLinkRow[];
  deepWorkLinks: DeepWorkLinkRow[];
};

/**
 * 在脚本直接运行时加载项目根目录的环境变量。
 */
function loadProjectEnvironment(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!process.env.DATABASE_URL && existsSync(envPath)) loadEnvFile(envPath);
}

/**
 * 写入修复前备份，便于审计与人工回滚。
 * @param plan - 待修复计划
 * @param path - 备份文件路径
 */
function writeBackup(plan: RepairPlan, path: string): string {
  const absolutePath = resolve(path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify({ createdAt: new Date().toISOString(), plan }, null, 2)}\n`);
  return absolutePath;
}

/**
 * 查找已有主 taskId，但缺少对应 ScheduleBlockTask 行的日程块。
 * @param db - Prisma 客户端
 */
async function findMissingPrimaryLinks(db: PrismaClient): Promise<MissingLinkRow[]> {
  const blocks = await db.scheduleBlock.findMany({
    where: { deletedAt: null, taskId: { not: null } },
    select: {
      id: true,
      title: true,
      taskId: true,
      status: true,
      startsAt: true,
      task: { select: { title: true } },
      linkedTasks: { select: { taskId: true } },
    },
    orderBy: { startsAt: "asc" },
  });
  return blocks
    .filter((block) => block.taskId && !block.linkedTasks.some((link) => link.taskId === block.taskId))
    .map((block) => ({
      scheduleBlockId: block.id,
      title: block.title,
      taskId: block.taskId!,
      taskTitle: block.task?.title ?? block.taskId!,
      status: block.status,
      startsAt: block.startsAt,
    }));
}

/**
 * 查找阅读目标下标题含「深度工作」、尚未挂任务的日程块，并映射到对应读书任务。
 * 仅用稳定任务 ID 写入关联，不引入运行时标题匹配。
 * @param db - Prisma 客户端
 */
async function findDeepWorkOrphans(db: PrismaClient): Promise<DeepWorkLinkRow[]> {
  const task = await db.task.findFirst({
    where: {
      archivedAt: null,
      title: { contains: "深度工作" },
      goal: { archivedAt: null, title: { contains: "充分阅读" } },
    },
    select: { id: true, title: true, goalId: true },
  });
  if (!task) return [];

  const blocks = await db.scheduleBlock.findMany({
    where: {
      deletedAt: null,
      goalId: task.goalId,
      taskId: null,
      routineId: null,
      title: { contains: "深度工作" },
    },
    select: { id: true, title: true, goalId: true, status: true, startsAt: true },
    orderBy: { startsAt: "asc" },
  });

  return blocks
    .filter((block) => block.goalId)
    .map((block) => ({
      scheduleBlockId: block.id,
      title: block.title,
      goalId: block.goalId!,
      taskId: task.id,
      taskTitle: task.title,
      status: block.status,
      startsAt: block.startsAt,
    }));
}

/**
 * 汇总修复计划：补齐缺失的 ScheduleBlockTask，并把明确的深度工作会话挂回对应任务。
 * @param db - Prisma 客户端
 */
export async function buildScheduleLinkRepairPlan(db: PrismaClient): Promise<RepairPlan> {
  const [missingLinks, deepWorkLinks] = await Promise.all([
    findMissingPrimaryLinks(db),
    findDeepWorkOrphans(db),
  ]);
  return { missingLinks, deepWorkLinks };
}

/**
 * 执行修复：只新增关联与回填主 taskId，不删除任何日程或任务。
 * @param db - Prisma 客户端
 * @param plan - 修复计划
 */
async function applyRepairPlan(db: PrismaClient, plan: RepairPlan) {
  let linkRows = 0;
  let primaryFilled = 0;

  await db.$transaction(async (tx) => {
    for (const row of plan.missingLinks) {
      await tx.scheduleBlockTask.create({
        data: { scheduleBlockId: row.scheduleBlockId, taskId: row.taskId, position: 0 },
      });
      linkRows += 1;
    }

    for (const row of plan.deepWorkLinks) {
      await tx.scheduleBlock.update({
        where: { id: row.scheduleBlockId },
        data: { taskId: row.taskId, version: { increment: 1 } },
      });
      primaryFilled += 1;
      await tx.scheduleBlockTask.create({
        data: { scheduleBlockId: row.scheduleBlockId, taskId: row.taskId, position: 0 },
      });
      linkRows += 1;
    }
  });

  return { linkRows, primaryFilled };
}

/**
 * CLI 入口：默认 dry-run，传 --apply 才写库。
 */
async function main() {
  loadProjectEnvironment();
  const apply = process.argv.includes("--apply");
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter });

  try {
    const plan = await buildScheduleLinkRepairPlan(db);
    console.log(JSON.stringify({
      mode: apply ? "apply" : "dry-run",
      missingPrimaryLinks: plan.missingLinks.length,
      deepWorkOrphans: plan.deepWorkLinks.length,
      missingLinks: plan.missingLinks.map((row) => ({
        id: row.scheduleBlockId,
        title: row.title,
        task: row.taskTitle,
        status: row.status,
        date: row.startsAt.toISOString().slice(0, 10),
      })),
      deepWorkLinks: plan.deepWorkLinks.map((row) => ({
        id: row.scheduleBlockId,
        title: row.title,
        task: row.taskTitle,
        status: row.status,
        date: row.startsAt.toISOString().slice(0, 10),
      })),
    }, null, 2));

    if (!apply) {
      console.log("\nDry-run only. Re-run with --apply to write links (no deletions).");
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = writeBackup(plan, `tmp/repair-schedule-task-links-${stamp}.json`);
    const result = await applyRepairPlan(db, plan);
    console.log(JSON.stringify({ backupPath, ...result }, null, 2));
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
