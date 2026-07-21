# Goal Execution Feedback Contracts

## 1. Scope / Trigger

Use this contract when changing Goal status, target-list feedback, execution investment projection, achievements, milestone criteria/suggestions, or historical Goal migrations.

## 2. Signatures

```ts
projectGoalExecutionFacts(goal, schedule, timezone, now): GoalExecutionFacts
definitionsForModules(modules): AchievementDefinition[]
evaluateAchievement(definition, facts): AchievementEvaluation
evaluateMilestoneCriteria(criteria, facts): MilestoneCriteriaEvaluation | null
evaluateGoalAchievementsBestEffort(goalIds): Promise<void>
evaluateMilestoneSuggestionsBestEffort(goalIds): Promise<void>
```

DB lifecycle: `GoalStatus = ACTIVE | PAUSED | COMPLETED | ARCHIVED`. Achievement history is `GoalAchievement` + append-only `GoalAchievementEvent`; milestone automation is `Milestone.completionCriteria` + `MilestoneReviewSuggestion`.

## 3. Contracts

- Goal list feedback is weekly real investment, active days, achievement events, and an action hint. Never derive a Goal completion percentage from task or milestone counts.
- Actual execution minutes outrank scheduled duration. Planned duration is an explicit fallback and must be marked estimated.
- Cancelled/deleted/rescheduled/missed blocks do not count. A reschedule predecessor stays superseded even if its successor loses direct Goal/Task linkage.
- Routine calendar and Routine execution rows representing the same local occurrence count once; timezone-local date/week keys are authoritative.
- Confirmed-task achievements require both `completedAt` and `completionRecord`; splitting work into many task rows cannot unlock delivery achievements.
- Achievement definitions are reusable modules (`core`, `project`, `skill`, `routine`). There are no hidden achievements. Ordinary regressions never revoke an unlock; explicit data correction appends a `REVOKED` event with reason and original evidence retained.
- Machine milestone criteria only produce a review suggestion. Only a user decision can write `Milestone.status=COMPLETED`.
- Suggestion identity is milestone + evidence fingerprint. Same evidence reuses one row; snooze and dismiss apply cooldowns; materially new evidence may reopen.
- Historical same-title milestones may be grouped in the detail read model, but edit paths and stored rows remain unchanged.

## 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Manual-only milestone criteria | No machine suggestion |
| Threshold below target | Milestone stays pending, no completion suggestion |
| Threshold reached | Pending review suggestion; no automatic completion |
| Same evidence recalculated | Existing suggestion/event reused; no duplicate |
| Ordinary data value decreases | Achievement remains unlocked |
| Explicit correction | `REVOKED` event requires correction reason |
| Legacy Goal DRAFT migration | Only status changes to ACTIVE; IDs/relations/business fields stay equal |

## 5. Good / Base / Bad Cases

- Good: a completed 45-minute record displays 45m, unlocks the first-investment event once, and may suggest a milestone review when its public threshold is met.
- Base: a new active Goal with no execution displays an honest empty state and a planning/action hint, not 0%.
- Bad: three newly split tasks make a Goal look 60% complete or auto-complete a milestone without user confirmation.

## 6. Tests Required

- Actual-vs-planned minutes, reschedule predecessor exclusion, Routine occurrence deduplication, timezone-local dates.
- Confirmed task evidence, goal module composition, unlock idempotency, correction-only revocation.
- Milestone all/any thresholds, below-threshold behavior, manual-only behavior, cooldown/fingerprint reuse.
- Migration backup validation, entity count/ID/foreign-key/non-status comparison, repeated backfill idempotency.
- Desktop and mobile Goal list/detail screenshots; achievement details keyboard-expandable; no horizontal overflow.

## 7. Wrong vs Correct

Wrong: `progress = completedTasks / totalTasks`, `GoalStatus.DRAFT` means “not fully planned”, and meeting an investment threshold writes Milestone completed.

Correct: project immutable execution facts, keep planning gaps as non-blocking hints, generate a review suggestion from public evidence, and let the user confirm the milestone.

## Scenario: Execution Feedback V2

### 1. Scope / Trigger

Use this scenario when changing the execution-feedback modal, schedule/Routine execution APIs, review facts, rhythm-signal extraction, task-completion summaries, or Agent execution-history context. The contract is versioned because V1 fields must remain readable without continuing to burden daily V2 input.

### 2. Signatures

```ts
type ExecutionResult = "achieved" | "progressed" | "no_progress" | "rescheduled";
type ExecutionFocusState = "deep_focus" | "steady_focus" | "under_challenged" | "overloaded" | "fragmented";
type ExecutionQuality = "satisfying" | "expected" | "needs_rework";

PUT /api/schedule/:id/execution
PUT /api/routine-occurrences/execution

resolveExecutionFocusState(
  feedbackVersion: number | null | undefined,
  focusState?: string | null,
  legacyTags?: string[],
): ExecutionFocusState | undefined;
```

DB additions are additive: `ExecutionRecord.feedbackVersion`, `RhythmFeedback.focusState`, and `RoutineExecutionRecord.result/quality/focusState/feedbackVersion`. Existing rows keep `feedbackVersion=1`; no legacy column is renamed, deleted, or rewritten.

### 3. Contracts

- V2 clients send `feedbackVersion: 2`. `result` is required; `focusState`, `quality`, and `note` are optional lightweight feedback.
- `achieved` and `progressed` count as real investment. The UI initializes `achieved` with planned minutes; `progressed` requires the user to enter positive real minutes. `no_progress` records zero minutes. `rescheduled` is a separate action, not an accomplishment level.
- Omitted legacy/update fields mean **preserve the stored value**. Explicit `null` for `focusState`, `quality`, or `note` means **clear the current V2 value**. Never use a schema default that turns omission into an empty-array overwrite.
- V1 records may project reliable tags into V2 display (`smooth -> steady_focus`, `resistant/barely_completed -> overloaded`, `interrupted -> fragmented`). V2 records never infer focus from retained V1 tags; absence of explicit V2 focus remains “not recorded”.
- The V2 form does not submit `obstacle`, `nextAction`, `comfortable`, or `timeFit`. These fields remain stored and appear only inside the collapsed historical compatibility section.
- Reviews, task summaries, rhythm signals, and Agent context use the same version-aware focus resolver. For V2 records, deprecated fields are excluded from live signals and Agent context even though they remain in storage.
- Ordinary schedule blocks and virtual Routine occurrences share the same outcome/focus/quality vocabulary. Completed records expose a “correct record” entry so historical and V2 values remain editable.

### 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| `progressed` without positive `actualMinutes` | Reject; ask for real invested minutes |
| `no_progress` with positive `actualMinutes` | Reject; use `progressed` when real progress exists |
| V2 focus/quality outside the published enum | Reject at request validation |
| Legacy `completed/not_completed` request | Accept as V1 compatibility input |
| V2 request omits tags or deprecated fields | Preserve existing values on update; create empty/default values only for a new row |
| V2 request explicitly sends `focusState/quality/note: null` | Clear that V2 value |
| V2 record has an old `smooth` tag but no explicit focus | Do not create a focus signal |

### 5. Good / Base / Bad Cases

- Good: “有效推进 + 35 分钟 + 挑战过高 + 补充感受” is stored once and later produces an overload/splitting signal without asking for a separate obstacle field.
- Base: “达成预期” saves with planned minutes while focus, quality, and note remain optional.
- Good legacy: opening a V1 completed record shows projected focus for convenience and a collapsed read-only compatibility section; saving V2 preserves untouched V1 columns.
- Bad: retaining a V1 `smooth` tag causes a V2 record with cleared focus to be counted as stable focus.
- Bad: omitted `tags` is parsed as `[]` and silently erases historical tags during correction.

### 6. Tests Required

- Domain projection: V1 tag mappings, explicit V2 focus precedence, and V2 ignoring retained V1 tags.
- Validation: partial progress minutes, no-progress zero minutes, legacy result acceptance, version marker, omit-vs-null semantics.
- UI SSR/interactions: three outcomes, five optional focus states, three optional quality levels, separate reschedule action, progressed-save guard, collapsed legacy section, correction entry.
- Review/Agent projection: deprecated V2 fields are absent, explicit focus is preserved, and rule signals distinguish under-challenged, overloaded, and fragmented patterns.
- Migration: pre-migration row snapshot, post-migration legacy-field digest equality, and V1/null defaults for every historical row.
- Visual QA: desktop card hierarchy, mobile single-column layout, modal scrolling, and no console errors.

### 7. Wrong vs Correct

Wrong:

```ts
const focus = normalizeExecutionFocusState(record.focusState, record.tags);
const update = { tags: input.tags ?? [] };
```

Correct:

```ts
const focus = resolveExecutionFocusState(record.feedbackVersion, record.focusState, record.tags);
const update = {
  ...(input.tags !== undefined && { tags: input.tags }),
  focusState: input.focusState, // undefined preserves; null clears
};
```
