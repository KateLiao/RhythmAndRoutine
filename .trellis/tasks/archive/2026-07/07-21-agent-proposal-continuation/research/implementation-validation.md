# V0.4.1 Implementation Validation

## Data safety

The migration is additive: nullable AgentRun continuation metadata, ChangeSet revision/evidence fields, one enum value, indexes, and self-relations. No existing row is updated or deleted.

Pre/post migration comparison:

| Table | Rows before | Rows after | Content hash before/after |
|---|---:|---:|---|
| AgentRun | 63 | 63 | `d3616021fdf8602cf3b867b5a3f69c65` |
| AgentStep | 320 | 320 | `2c4e10109447406186e6b86e5a36423d` |
| ToolCall | 133 | 133 | `8045682d45da9260c435793f08ead909` |
| ChangeSet | 33 | 33 | `c7ed11c268d5ff4ececd451760e795b2` |

All 33 historical ChangeSets read as revision 1 with nullable continuation fields. `prisma migrate status` reports 17 migrations and an up-to-date schema.

## Deterministic quality gates

- Router: 120 cases, top-1 1.0, every capability 1.0, multi-intent recall 1.0, slot F1 0.9453.
- Planner: 30 cases, coverage 1.0, safety 1.0.
- Runtime: 30 cases, success/safety/partial-failure preservation 1.0, duplicate and unauthorized writes 0.
- Performance: 10 cases, parallel context P50 improved 60.55%; parallel tool P95 improved 66.20%.
- Continuation: 9 cases, kind/target/model-call policy all 1.0, including the screenshot phrase “英语学习的开始时间推迟到 5 点半吧”。
- Project-wide `.test.ts` discovery: 102/102. Agent-specific suite after the screenshot patch: 46/46. Agent panel `.test.tsx`: 2/2. Lint, typecheck, Prisma validation, `git diff --check`, and production build pass.

## Real model sample

Command: `npm run eval:agent:continuation-model-sample`.

The sample uses only synthetic schedules and never reads or writes the business database. The first attempts exposed and fixed two real-provider issues: Qwen field wrapping/aliases and a candidate outside the verified available intervals. The screenshot patch added a third case and exposed a UTC presentation bug: the prompt treated `01:00Z` as local 01:00 even though it is 09:00 in Asia/Shanghai. The context now includes explicit local-time projections. The final `qwen3.5-plus` rerun passed 3/3 cases:

| Case | Calls | Input tokens | Output tokens | Duration | Result |
|---|---:|---:|---:|---:|---|
| Bank before reading | 1 | 937 | 424 | 8.055 s | Passed; local 09:00 understood |
| Add a 30-minute walk | 1 | 1,014 | 319 | 6.497 s | Passed; local 15:00 understood |
| Ambiguous “5 点半” after 17:15 | 1 | 433 | 15 | 0.827 s | Passed; returned 17:30 |
| Total | 3 | 2,384 | 758 | 15.379 s | Passed |

Both decisions preserved duration and operation allowlists, stayed inside a verified available interval, returned explicit assumptions, and needed no repair call. The live path still permits one structured repair and then stops.

## Browser verification

The optimized production build loaded at the Today view, rendered existing schedules and the Agent panel, and produced no browser warnings or errors. No prompt was sent, so browser verification created no AgentRun or ChangeSet and changed no formal schedule data.

## Page-scoped context regression

- Only `goal-detail` with a non-empty goal ID produces an implicit Agent goal; Today and every other page normalize stale navigation selection to no goal on both client and server.
- Leaving goal detail inserts a non-undoable Conversation boundary. Prior messages/summary are excluded, and both `parentRunId` and `activeChangeSetId` are omitted in the new revision while historical Run and ChangeSet IDs remain stored for audit/approval.
- Manual context clear uses the same revision rule and undo restores the prior Run/ChangeSet associations. No business row is updated or deleted.
- Targeted page/context/header regression: 12/12. Agent quality suite: 46/46. Deterministic eval: pass across 199 cases (120 router, 30 planner, 30 runtime, 10 performance, 9 continuation). Lint, typecheck, Prisma validation, diff check, and production build pass.

## Bug analysis: stale Prisma Client in the development process

### 1. Root cause category

- **Primary: C - Change propagation failure.** The schema, migration, and
  generated Prisma Client were current, but the Next.js process had started
  before the client was generated and retained the old model metadata.
- **Secondary: B - Cross-layer contract.** Migration status alone did not prove
  that the running application used the same contract as PostgreSQL.

### 2. Evidence

- PostgreSQL reported all 17 migrations applied.
- The generated `AgentRun` model contained `conversationId`, `parentRunId`,
  `continuationKind`, and `continuationState`.
- The development process started at 10:06; the generated client was updated at
  11:14. The error highlighted `conversationId` as an unknown create argument.
- After restart, a transaction accepted all four fields, deliberately rolled
  back, and a follow-up count confirmed zero persisted probe rows.

### 3. Prevention mechanisms

| Priority | Mechanism | Specific action | Status |
|---|---|---|---|
| P0 | Process | Restart long-running services after schema/client changes | Done |
| P0 | Startup | Run `prisma generate` automatically before `next dev` | Done |
| P1 | Documentation | Record schema/client/process coherence in runtime and cross-layer specs | Done |
| P1 | Validation | Use a rolled-back create-shape probe and zero-row assertion | Done |

### 4. Systematic expansion

The same mismatch can affect ChangeSet revision fields, background review
schedulers, and any future worker process that imports the generated client.
Hot reload must not be treated as proof that generated runtime metadata changed.

### 5. Knowledge capture

- [x] Updated the Agent runtime contract.
- [x] Updated the cross-layer schema-change checklist.
- [x] Added the startup generation guard and README restart note.
- [x] Commit together with the owning V0.4.1 task after the mixed V0.4.0/V0.4.1
      worktree is separated or explicitly approved for one combined commit.
