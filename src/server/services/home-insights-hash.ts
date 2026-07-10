import { createHash } from "node:crypto";

/**
 * 对可序列化对象计算稳定 SHA-256 哈希，用于 facts 变更检测。
 * @param value - 待哈希数据
 */
export function hashFacts(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** 此刻建议快照 TTL（毫秒） */
export const MOMENT_INSIGHT_TTL_MS = 15 * 60 * 1000;

/** 慢路径洞察快照 TTL（毫秒） */
export const SLOW_INSIGHT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 根据 TTL 计算 validUntil 时间。
 * @param ttlMs - 有效时长（毫秒）
 */
export function validUntilFromNow(ttlMs: number): Date {
  return new Date(Date.now() + ttlMs);
}

/**
 * 判断快照是否因 TTL 或 facts 哈希而过期。
 * @param snapshot - 库内快照记录
 * @param currentHash - 当前 facts 哈希
 */
export function isSnapshotStale(snapshot: { factsHash: string; validUntil: Date | null }, currentHash: string): boolean {
  if (snapshot.factsHash !== currentHash) return true;
  if (snapshot.validUntil && snapshot.validUntil.getTime() < Date.now()) return true;
  return false;
}
