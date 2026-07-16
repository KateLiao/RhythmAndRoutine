# Agent Schedule Planning Contracts

## Scenario: Habit-grounded schedule planning without fabricated availability

### 1. Scope / Trigger

Use this contract whenever an Agent interprets phrases such as “as usual”, queries similar schedule history, recommends a concrete time range, or creates/updates `schedule` / `personal_schedule` operations. It prevents broad keyword contamination, UTC interpretation mistakes, and the false assumption that calling a calendar tool proves a candidate is free.

### 2. Signatures

```ts
planSimilarScheduleQueries(adapter, { prompt, queryHint, model, signal }): Promise<SimilarScheduleQueryPlan>
runProgressiveSimilarScheduleSearch(plan, search): Promise<{ result; matchedTier; attempts }>
readSimilarScheduleHistory(userId, { queries, matchMode, days, limit }, timezone)
buildAgentScheduleWindowResult(items, from, to, timezone): AgentScheduleWindowResult
validateScheduleCandidates(candidates, schedule): { allAvailable; candidates }
```

Agent tools:

```text
read_similar_schedule_history(query?/goalId?/taskId?/routineId?, days=90, limit=12)
read_schedule_window(from, to)
validate_schedule_candidates(candidates[{ label?, startsAt, endsAt }])
```

### 3. Contracts

- Query planner tiers are ordered `exact -> related -> broad`.
- Execute the next tier only when the current tier returns `sampleCount=0`; stop immediately on a match.
- `exact` preserves the complete activity meaning, e.g. `阅读《原则》` and `原则阅读`; `related` keeps the core object, e.g. `原则`; `broad` may use `阅读`.
- Planner structured output has an 8-second budget. Timeout/schema/provider failure falls back to deterministic local planning and does not fail the main tool.
- Habit samples default to `ScheduleBlockStatus.COMPLETED`. Planned, cancelled, and rescheduled blocks are not habit evidence.
- History output includes `matchedTier`, `attempts`, UTC instants, and `localStartsAt/localEndsAt` in the user timezone.
- A timezone-less Agent input is a wall-clock value in the user timezone. Inputs with `Z` or an explicit offset are absolute instants.
- Schedule-window output is compact and contains `items`, `busyIntervals`, and `availableIntervals`; it excludes cancelled/rescheduled rows and applies a final exact overlap filter to Routine occurrences.
- Any concrete time recommendation must use `validate_schedule_candidates`. A schedule ChangeSet must use exactly the candidates from the latest successful validation.

### 4. Validation & Error Matrix

| Condition | Behavior / Error |
|---|---|
| No similarity clue | Tool schema rejects the call |
| Planner times out or returns invalid JSON | Use deterministic fallback query plan |
| Exact tier returns samples | Stop; never execute related/broad |
| No completed history in all tiers | Return explicit empty summary |
| History lookup occurs after last window read | `SCHEDULE_WINDOW_REQUIRED` before ChangeSet |
| Final candidate validation missing | `SCHEDULE_CANDIDATE_VALIDATION_REQUIRED` |
| Candidate validation has conflicts | `SCHEDULE_CONFLICT` |
| Draft time differs from validated candidate | `SCHEDULE_CANDIDATE_CHANGED` |
| Timezone-less input | Parse in `context.user.timezone`, never host timezone |

### 5. Good / Base / Bad Cases

- Good: `阅读《原则》/原则阅读` returns two completed samples at 22:30 and 23:00; exact tier stops; candidate 22:10–23:10 is checked against current local busy intervals.
- Base: exact and related return zero; broad `阅读` returns samples. The result is labelled broad and may rank candidates, but must not be described as a specific-book habit.
- Bad: query only `阅读`, mix PLANNED TypeScript work and “Notion 阅读库” content creation, calculate a global median, then claim 20:00 is habitual and free.

### 6. Tests Required

- Planner: exact query preservation, short-circuit on match, all-empty executes three tiers once.
- History: completed-only samples, local time fields, explicit empty result.
- Timezone: wall-clock Asia/Shanghai conversion and explicit-offset preservation.
- Window analysis: stale status filtering, Routine overlap filtering, local busy/free intervals.
- Candidate validation: half-open interval overlap and adjacent endpoints.
- Runtime: missing validation, conflicting validation, changed candidate, and interception of unvalidated concrete recommendations.
- Database replay for any reported hallucination: compare stored `ToolCall.output` with current `ScheduleBlock` rows.

### 7. Wrong vs Correct

#### Wrong

```ts
const history = await search({ query: "阅读" });
// Tool call existence is treated as proof that 20:00 is free.
```

#### Correct

```ts
const plan = await planSimilarScheduleQueries(adapter, request);
const history = await runProgressiveSimilarScheduleSearch(plan, searchTier);
const window = buildAgentScheduleWindowResult(rows, from, to, timezone);
const validation = validateScheduleCandidates(finalCandidates, window);
if (!validation.allAvailable) retryWithAdjustedCandidates();
```

The prompt is a behavioral hint; the service projection and Runtime guard are the authoritative safety boundary.
