import type { InsightSnapshotKind } from "@/server/services/home-insights-snapshots";

/** moment 快照最长保留天数 */
export const MOMENT_SNAPSHOT_RETENTION_DAYS = 7;

/** moment 每用户最多保留条数 */
export const MOMENT_SNAPSHOT_MAX_COUNT = 168;

/** slow 快照最长保留天数 */
export const SLOW_SNAPSHOT_RETENTION_DAYS = 180;

/** slow 每用户最多保留条数 */
export const SLOW_SNAPSHOT_MAX_COUNT = 32;

/**
 * 返回指定 kind 的保留天数与条数上限。
 * @param kind - moment 或 slow
 */
export function retentionLimitsForKind(kind: InsightSnapshotKind) {
  if (kind === "moment") {
    return { retentionDays: MOMENT_SNAPSHOT_RETENTION_DAYS, maxCount: MOMENT_SNAPSHOT_MAX_COUNT };
  }
  return { retentionDays: SLOW_SNAPSHOT_RETENTION_DAYS, maxCount: SLOW_SNAPSHOT_MAX_COUNT };
}
