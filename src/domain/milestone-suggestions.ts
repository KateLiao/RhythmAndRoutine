import type { GoalEvidenceRef, GoalExecutionFacts } from "@/domain/goal-achievements";

export type MilestoneCriteriaEvaluator =
  | "linked_task_completed"
  | "routine_completed_count"
  | "invested_minutes"
  | "active_days"
  | "manual_only";

export type MilestoneCriteria = {
  version: 1;
  mode: "all" | "any";
  items: Array<{
    id: string;
    label: string;
    evaluator: MilestoneCriteriaEvaluator;
    sourceIds?: string[];
    threshold?: number;
  }>;
};

export type MilestoneCriterionResult = {
  id: string;
  label: string;
  evaluator: MilestoneCriteriaEvaluator;
  current: number;
  target: number;
  met: boolean;
  evidenceRefs: GoalEvidenceRef[];
};

export type MilestoneCriteriaEvaluation = {
  met: boolean;
  mode: MilestoneCriteria["mode"];
  results: MilestoneCriterionResult[];
  evidenceRefs: GoalEvidenceRef[];
};

/**
 * Evaluate a public, versioned milestone criterion against goal-scoped facts.
 * `null` means the criterion must remain a manual decision and must not create
 * an automatic review suggestion.
 */
export function evaluateMilestoneCriteria(criteria: MilestoneCriteria, facts: GoalExecutionFacts): MilestoneCriteriaEvaluation | null {
  if (criteria.version !== 1 || !criteria.items.length || criteria.items.some((item) => item.evaluator === "manual_only")) return null;

  const results = criteria.items.map((item) => evaluateCriterion(item, facts));
  const met = criteria.mode === "all" ? results.every((result) => result.met) : results.some((result) => result.met);
  const evidence = new Map<string, GoalEvidenceRef>();
  for (const result of results.filter((entry) => entry.met)) {
    for (const ref of result.evidenceRefs) evidence.set(`${ref.type}:${ref.id}`, ref);
  }
  return {
    met,
    mode: criteria.mode,
    results,
    evidenceRefs: [...evidence.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id)),
  };
}

function evaluateCriterion(item: MilestoneCriteria["items"][number], facts: GoalExecutionFacts): MilestoneCriterionResult {
  const sourceIds = new Set(item.sourceIds ?? []);
  const target = item.evaluator === "linked_task_completed"
    ? Math.max(1, sourceIds.size)
    : Math.max(1, item.threshold ?? 1);
  let evidenceRefs: GoalEvidenceRef[] = [];
  let current = 0;

  switch (item.evaluator) {
    case "linked_task_completed":
      evidenceRefs = facts.evidenceRefs.filter((ref) => ref.type === "task" && sourceIds.has(ref.id));
      current = new Set(evidenceRefs.map((ref) => ref.id)).size;
      break;
    case "routine_completed_count":
      evidenceRefs = facts.evidenceRefs.filter((ref) => ref.type === "routine" && (!sourceIds.size || [...sourceIds].some((id) => ref.id.startsWith(`routine:${id}:`))));
      current = evidenceRefs.length;
      break;
    case "invested_minutes":
      evidenceRefs = executionRefs(facts, sourceIds);
      current = evidenceRefs.reduce((sum, ref) => sum + (ref.minutes ?? 0), 0);
      break;
    case "active_days":
      evidenceRefs = executionRefs(facts, sourceIds);
      current = new Set(evidenceRefs.map((ref) => ref.dateKey ?? ref.occurredAt.slice(0, 10))).size;
      break;
    case "manual_only":
      break;
  }

  return { id: item.id, label: item.label, evaluator: item.evaluator, current, target, met: current >= target, evidenceRefs };
}

function executionRefs(facts: GoalExecutionFacts, sourceIds: Set<string>): GoalEvidenceRef[] {
  return facts.evidenceRefs.filter((ref) => {
    if (ref.type !== "schedule" && ref.type !== "routine") return false;
    if (!sourceIds.size) return true;
    return sourceIds.has(ref.id) || [...sourceIds].some((id) => ref.id.startsWith(`routine:${id}:`));
  });
}
