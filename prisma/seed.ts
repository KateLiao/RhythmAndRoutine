import { PrismaPg } from "@prisma/adapter-pg";
import { loadEnvFile } from "node:process";
import { PrismaClient } from "../src/generated/prisma/client";

loadEnvFile();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required to seed the database.");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

async function main() {
  const user = await prisma.user.upsert({
    where: { id: "seed-user" },
    update: {},
    create: {
      id: "seed-user",
      displayName: "Calcifer",
      timezone: "Asia/Shanghai",
      defaultModel: "qwen-plus",
    },
  });

  const existing = await prisma.goal.findFirst({ where: { userId: user.id, title: "完成 Rhythm & Routine MVP" } });
  if (existing) return;

  await prisma.goal.create({
    data: {
      userId: user.id,
      title: "完成 Rhythm & Routine MVP",
      description: "跑通目标、日程、执行反馈与 AI 动态调整的完整闭环。",
      category: "mixed",
      project: "Rhythm & Routine MVP",
      skill: "AI Agent 产品开发",
      status: "ACTIVE",
      outcomes: {
        create: [{ description: "完成一个可日常使用的 AI Native 个人目标推进产品 MVP" }],
      },
      milestones: {
        create: [
          { title: "基础业务闭环", description: "手动创建目标、安排日程并记录执行反馈。", position: 0 },
          { title: "小律规划与调整", description: "AI 建议通过 ChangeSet 确认后写入。", position: 1 },
        ],
      },
      routines: {
        create: [{ title: "一天的轻回顾", recurrenceRule: "FREQ=DAILY;BYHOUR=21;BYMINUTE=30", durationMinutes: 15, preferredStartTime: "21:30", minimumVersion: "记录今天最明显的一次顺畅或阻力", status: "ACTIVE" }],
      },
      tasks: {
        create: [
          {
            title: "实现目标手动编辑流程",
            intent: "保证没有 AI 时，核心目标仍然可维护。",
            completionCriteria: ["可创建目标", "可编辑目标", "可归档目标"],
            suggestedSteps: ["建立表单 schema", "实现领域服务", "连接目标页面"],
            estimatedMinutes: 90,
            energyLevel: "high",
            focusLevel: "high",
            status: "READY",
          },
        ],
      },
    },
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
