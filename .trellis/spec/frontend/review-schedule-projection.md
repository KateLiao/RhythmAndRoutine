# Review Schedule Projection

## 1. Scope / Trigger

Apply this contract whenever daily or weekly review facts are derived from persisted `ScheduleBlock` rows. Rescheduling intentionally keeps history, so the storage set must be projected to the final calendar set before metrics, summaries, task/goal progress, excerpts, or LLM prompts are assembled.

## 2. Signatures

```ts
excludeSupersededPeriodBlocks<T extends { id: string }>(
  periodBlocks: T[],
  successorLinks: Array<{ rescheduledFromId: string | null }>,
): T[]
```

`fetchPeriodBlocks(userId, periodStart, periodEnd)` owns the database lookup and must return this projected set to every downstream review consumer.

## 3. Contracts

- A reschedule successor points to its immediate predecessor through `ScheduleBlock.rescheduledFromId`.
- Candidate membership is determined by each block's own `startsAt` within `[periodStart, periodEnd)` and `deletedAt = null`.
- A candidate is superseded when any same-user row references its `id` through `rescheduledFromId`, even when that successor is outside the review period or is later soft-deleted.
- Persisted predecessor rows are never deleted or overwritten by this projection.
- Review metrics and all daily/weekly fact builders consume the same projected block array.

## 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| No period candidates | Return `[]` without a successor lookup |
| Candidate has one successor | Exclude the candidate |
| Multi-hop chain is inside the period | Exclude every referenced node; retain only the leaf |
| Successor is outside the period | Exclude the in-period predecessor; do not pull the successor into the period |
| `RESCHEDULED` row has no successor reference | Preserve the existing review semantics; do not infer missing history from status alone |
| Database lookup fails | Propagate the error to the existing review-generation failure path |

## 5. Good / Base / Bad Cases

- Good: `A <- B <- C` with all rows in the week produces review facts for `C` only.
- Base: unrelated blocks `A` and `B` without successor references both remain.
- Bad: filtering only `status === RESCHEDULED` couples the review contract to a mutable status and can mishandle exceptional historical rows.
- Bad: querying successors only inside the review period makes an old block reappear when its final replacement moved to another period.

## 6. Tests Required

- Single reschedule: assert predecessor exclusion and successor retention.
- Repeated reschedule: assert all referenced nodes are excluded and only the leaf remains.
- Cross-period successor: provide only the predecessor as a period candidate and assert an empty result.
- Compatibility: assert ordinary and successor-less candidates are unchanged.
- Run review regression tests, type-check, lint, and Prisma validation.

## 7. Wrong vs Correct

### Wrong

```ts
const blocks = await db.scheduleBlock.findMany({
  where: { userId, startsAt: { gte: periodStart, lt: periodEnd } },
});
return computePeriodMetrics(blocks);
```

This treats retained reschedule history as simultaneous calendar commitments.

### Correct

```ts
const blocks = await fetchPeriodCandidates(userId, periodStart, periodEnd);
const successorLinks = await fetchSuccessorLinks(userId, blocks.map((block) => block.id));
const finalBlocks = excludeSupersededPeriodBlocks(blocks, successorLinks);
return computePeriodMetrics(finalBlocks);
```
