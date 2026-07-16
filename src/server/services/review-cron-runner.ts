import { getDb } from "@/lib/db";
import { syncDueReviews } from "@/server/services/reviews";

const LOCAL_REVIEW_SYNC_INTERVAL_MS = 5 * 60 * 1000;

type ReviewSchedulerGlobal = typeof globalThis & {
  __rrReviewScheduler?: {
    timer: ReturnType<typeof setInterval>;
    startedAt: string;
  };
};

/**
 * 在 Node 运行时启动本地回顾到期同步定时器，供 `next dev` / `next start` 在没有 Vercel Cron 时自动补跑。
 * 热重载时复用同一全局句柄，避免重复创建多个 interval。
 * @returns 本次是否新启动了定时器；已在运行则返回 false
 */
export function startLocalReviewScheduler(): boolean {
  if (!process.env.DATABASE_URL) return false;
  const store = globalThis as ReviewSchedulerGlobal;
  if (store.__rrReviewScheduler) return false;

  const tick = async () => {
    try {
      const users = await getDb().user.findMany();
      const now = new Date();
      for (const user of users) {
        try {
          const result = await syncDueReviews(user, now);
          if (result.generated.length || result.failed.length) {
            console.info("[reviews] local scheduler sync", {
              userId: user.id,
              generated: result.generated,
              failed: result.failed,
            });
          }
        } catch (error) {
          console.warn("[reviews] local scheduler user sync failed", {
            userId: user.id,
            message: error instanceof Error ? error.message : "unknown",
          });
        }
      }
    } catch (error) {
      console.warn("[reviews] local scheduler tick failed", error);
    }
  };

  void tick();
  const timer = setInterval(() => {
    void tick();
  }, LOCAL_REVIEW_SYNC_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  store.__rrReviewScheduler = { timer, startedAt: new Date().toISOString() };
  console.info("[reviews] local scheduler started", {
    intervalMs: LOCAL_REVIEW_SYNC_INTERVAL_MS,
    startedAt: store.__rrReviewScheduler.startedAt,
  });
  return true;
}
