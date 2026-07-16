import type { ToolResult } from "./types";

const MAX_LEDGER_ENTRIES = 8;
const MAX_LEDGER_CHARS = 8_000;
const MAX_ENTRY_CHARS = 2_400;

type EvidenceEntry = {
  key: string;
  tool: string;
  input: unknown;
  result: ToolResult;
};

/**
 * 保存供后续推理使用的工具证据摘要。完整工具结果仍由 RunStore 持久化，
 * 这里仅控制每轮重复发送给模型的上下文大小。
 */
export class ToolEvidenceLedger {
  private entries: EvidenceEntry[] = [];

  record(tool: string, input: unknown, result: ToolResult) {
    const entry = { key: evidenceKey(tool, input), tool, input: compactValue(input, 0), result: compactToolResult(tool, result) };
    this.entries = [...this.entries.filter((item) => item.key !== entry.key), entry].slice(-MAX_LEDGER_ENTRIES);
  }

  toSystemContext(): string {
    if (!this.entries.length) return "";
    const bounded = this.entries.map(({ tool, input, result }) => boundForSerialization({ tool, input, result }, MAX_ENTRY_CHARS));
    while (bounded.length > 1 && JSON.stringify(bounded).length > MAX_LEDGER_CHARS) bounded.shift();
    return JSON.stringify(bounded);
  }
}

/** 为模型生成确定性的精简结果；不修改传给数据库的原始 ToolResult。 */
export function compactToolResult(tool: string, result: ToolResult): ToolResult {
  if (!result.ok) {
    return { ...result, message: result.message.slice(0, 600) };
  }

  const data = result.data;
  if (tool === "read_schedule_window") return { ok: true, data: compactScheduleWindow(data) };
  if (tool === "read_similar_schedule_history") return { ok: true, data: compactSimilarHistory(data) };
  if (tool === "validate_schedule_candidates") return { ok: true, data: compactCandidateValidation(data) };
  if (tool === "read_goal_context") return { ok: true, data: compactValue(data, 0) };
  return { ok: true, data: compactValue(data, 0) };
}

export function serializeCompactToolResult(tool: string, result: ToolResult): string {
  return JSON.stringify(boundForSerialization(compactToolResult(tool, result), MAX_ENTRY_CHARS));
}

function compactScheduleWindow(value: unknown) {
  const data = asRecord(value);
  const items = arrayAt(data, ["items", "blocks", "schedules"]);
  return {
    timezone: data.timezone,
    window: compactValue(data.window, 1),
    itemCount: numberOr(items.length, data.itemCount),
    items: items.slice(0, 40).map((item) => pick(asRecord(item), [
      "id", "title", "status", "blockKind", "startsAt", "endsAt", "localStartsAt", "localEndsAt", "goalId", "taskId", "routineId",
    ])),
    busyIntervals: arrayAt(data, ["busyIntervals"]).slice(0, 40).map((item) => pick(asRecord(item), ["startsAt", "endsAt", "localStartsAt", "localEndsAt", "title", "titles"])),
    availableIntervals: arrayAt(data, ["availableIntervals"]).slice(0, 40).map((item) => pick(asRecord(item), ["startsAt", "endsAt", "localStartsAt", "localEndsAt"])),
  };
}

function compactSimilarHistory(value: unknown) {
  const data = asRecord(value);
  const result = asRecord(data.result);
  const source = Object.keys(result).length ? result : data;
  return {
    matchedTier: data.matchedTier,
    queryPlan: compactValue(data.queryPlan, 1),
    attempts: arrayAt(data, ["attempts"]).map((item) => pick(asRecord(item), ["level", "query", "sampleCount"])),
    sampleCount: source.sampleCount,
    typicalStartTime: source.typicalStartTime,
    typicalDurationMinutes: source.typicalDurationMinutes,
    commonWindows: arrayAt(source, ["commonWindows", "commonTimeWindows"]).slice(0, 12).map((item) => compactValue(item, 1)),
    samples: arrayAt(source, ["samples", "items"]).slice(0, 12).map((item) => pick(asRecord(item), [
      "id", "title", "startsAt", "endsAt", "localStartsAt", "localEndsAt", "durationMinutes", "goalId", "taskId", "routineId",
    ])),
  };
}

function compactCandidateValidation(value: unknown) {
  const data = asRecord(value);
  return {
    allAvailable: data.allAvailable,
    candidates: arrayAt(data, ["candidates"]).slice(0, 20).map((item) => {
      const candidate = asRecord(item);
      return {
        ...pick(candidate, ["label", "startsAt", "endsAt", "localStartsAt", "localEndsAt", "available"]),
        conflicts: arrayAt(candidate, ["conflicts"]).slice(0, 12).map((conflict) => pick(asRecord(conflict), [
          "id", "title", "blockKind", "startsAt", "endsAt", "localStartsAt", "localEndsAt",
        ])),
      };
    }),
  };
}

function compactValue(value: unknown, depth: number): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 600);
  if (depth >= 4) return Array.isArray(value) ? `[${value.length} items]` : "[object]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => compactValue(item, depth + 1));
  if (typeof value !== "object") return String(value);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .slice(0, 30)
      .map(([key, item]) => [key, compactValue(item, depth + 1)]),
  );
}

function evidenceKey(tool: string, input: unknown): string {
  const scoped = compactValue(input, 0);
  return `${tool}:${trimSerialized(scoped, 500)}`;
}

function trimSerialized(value: unknown, limit: number): string {
  const serialized = JSON.stringify(value);
  return serialized.length <= limit ? serialized : `${serialized.slice(0, limit)}…`;
}

function boundForSerialization(value: unknown, limit: number): unknown {
  const serialized = JSON.stringify(value);
  if (serialized.length <= limit) return value;
  const compacted = compactAggressively(value, 0);
  const compactedText = JSON.stringify(compacted);
  if (compactedText.length <= limit) return compacted;
  return { truncated: true, evidence: compactedText.slice(0, Math.max(0, limit - 40)) };
}

function compactAggressively(value: unknown, depth: number): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 240);
  if (depth >= 3) return Array.isArray(value) ? `[${value.length} items]` : "[object]";
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => compactAggressively(item, depth + 1));
  if (typeof value !== "object") return String(value);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 20).map(([key, item]) => [key, compactAggressively(item, depth + 1)]));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayAt(record: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) if (Array.isArray(record[key])) return record[key] as unknown[];
  return [];
}

function pick(record: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.flatMap((key) => record[key] === undefined ? [] : [[key, compactValue(record[key], 1)]]));
}

function numberOr(fallback: number, value: unknown) {
  return typeof value === "number" ? value : fallback;
}
