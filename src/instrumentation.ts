/**
 * Next.js 进程启动钩子：在 Node 运行时挂载本地回顾到期同步，弥补非 Vercel 环境缺少平台 Cron 的问题。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.DATABASE_URL) return;
  const { startLocalReviewScheduler } = await import("@/server/services/review-cron-runner");
  startLocalReviewScheduler();
}
