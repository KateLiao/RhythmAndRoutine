const STORAGE_KEY = "rhythm-routine:preferred-signal-ids";

/**
 * 读取用户标记为「用于下次安排」的节奏信号 id 列表。
 */
export function readPreferredSignalIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 将节奏信号标记为排程偏好。
 * @param signalId - RhythmSignal id
 */
export function preferSignalForScheduling(signalId: string): void {
  if (typeof window === "undefined") return;
  const ids = readPreferredSignalIds();
  if (!ids.includes(signalId)) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([signalId, ...ids].slice(0, 12)));
  }
}

/**
 * 判断信号是否已被标记为排程偏好。
 * @param signalId - RhythmSignal id
 */
export function isSignalPreferred(signalId: string): boolean {
  return readPreferredSignalIds().includes(signalId);
}
