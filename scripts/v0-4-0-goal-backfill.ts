import { getDb } from "../src/lib/db";
import { Prisma } from "../src/generated/prisma/client";
import { evaluateGoalAchievements } from "../src/server/services/goal-execution";
import { evaluateMilestoneSuggestions } from "../src/server/services/milestone-suggestions";

async function main() {
  const envPath = resolve(process.cwd(), ".env");
  if (!process.env.DATABASE_URL && existsSync(envPath)) loadEnvFile(envPath);
  const db = getDb();
  const apply = process.argv.includes("--apply");
  try {
    const before = await Promise.all([
      db.goal.count({ where: { archivedAt: null } }),
      db.goalAchievement.count(),
      db.goalAchievementEvent.count(),
      db.milestoneReviewSuggestion.count(),
      db.milestone.count({ where: { completionCriteria: { not: Prisma.JsonNull } } }),
    ]);
    if (!apply) {
      console.log(JSON.stringify({ mode: "dry-run", activeGoals: before[0], existingAchievements: before[1], existingAchievementEvents: before[2], existingMilestoneSuggestions: before[3], milestonesWithCriteria: before[4], next: "Run with --apply to create idempotent historical records." }, null, 2));
      return;
    }

    const [achievements, milestoneSuggestions] = await Promise.all([
      evaluateGoalAchievements(),
      evaluateMilestoneSuggestions(),
    ]);
    const after = await Promise.all([
      db.goalAchievement.count(),
      db.goalAchievementEvent.count(),
      db.milestoneReviewSuggestion.count(),
    ]);
    console.log(JSON.stringify({ mode: "apply", achievements, milestoneSuggestions, totals: { achievements: after[0], achievementEvents: after[1], milestoneSuggestions: after[2] } }, null, 2));
  } finally {
    await db.$disconnect();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
