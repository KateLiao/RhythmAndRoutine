# Agent Runtime Budget and Evidence Contracts

## 1. Scope / Trigger

Use this contract when changing Agent token budgets, multi-step tool loops, model message history, tool-result serialization, Run persistence, or process-event presentation.

## 2. Runtime Budgets

| Capability | `maxRunTokens` |
|---|---:|
| `goal_clarification` | 24,000 |
| `planning` | 64,000 |
| `review` | 48,000 |
| `adjustment` | 64,000 |
| `progress_evaluation` | 32,000 |

The budget counts usage events reported by the main Agent loop as cumulative `inputTokens + outputTokens`. A separate structured planner call is not currently included. Persist `maxSteps` and `maxTokens` on every `AgentRun`; a null database value is an observability defect.

At 75% usage, instruct the model to stop duplicate discovery and finish required checks. At 88%, allow only indispensable validation/draft work or a conclusion from existing evidence. This is a convergence hint; the hard cap remains authoritative.

## 3. Dual-Track Tool Results

- Audit track: persist the original tool input and full `ToolResult` in `ToolCall`; never replace it with a model-context summary.
- Reasoning track: send a deterministic compact result to the model and retain a bounded evidence ledger in the system context.
- Keep only the most recent tool protocol batch (`assistant.toolCalls` + paired `tool` messages). Older protocol messages must not accumulate across every loop.
- The evidence ledger is the durable reasoning carrier. It is bounded to 8 entries / about 8,000 characters and replaces repeated reads of the same tool scope with the newest result.

## 4. Evidence That Must Survive Compression

- Schedule window: timezone, queried window, item count, item id/title/status/block kind, UTC and local start/end, busy and available intervals.
- Candidate validation: `allAvailable`, exact candidate UTC/local ranges, `available`, and conflict identity/title/time.
- Similar history: `matchedTier`, tier attempts, sample count, typical start/duration, common windows, compact samples, and query-plan semantics.
- Goal and other context: ids, titles, status, linked entities, and bounded nested business fields.
- Tool errors: code, retryability, and a bounded actionable message.

## 5. Process Event Presentation

- `processSteps` is append-only by event arrival. `tool_completed` updates the existing row with the same `toolCallId`; a new tool call appends a new row.
- Expanded UI renders this order directly. It must not regroup tools by semantic stage or move a later proposal above an earlier lookup.
- Per-loop `verification` is internal audit/control data and is excluded from the primary timeline. Never show “validation succeeded” merely because one tool completed while the Agent is still gathering information.
- Collapsed UI may derive a semantic summary from stages. Summary projection must not reorder or mutate the source events.
- Real recovery, failure, approval, and terminal-decision events remain visible in sequence.

## 6. Validation Matrix

| Change | Required proof |
|---|---|
| Tool compactor | Critical schedule/history/validation facts survive; bulky fields are dropped; ledger stays bounded |
| Message loop | Previous tool batches do not accumulate; latest paired tool protocol remains valid |
| Budget policy | Capability values and persisted `AgentRun.maxTokens/maxSteps` agree |
| Expanded process | Arrival order is preserved; internal verification rows are absent; active tool is last |
| Live completion | `tool_completed` updates by `toolCallId` and does not set a premature validation status |

## 7. Wrong vs Correct

Wrong: append every raw 12k tool result to `messages` forever, then truncate arbitrary JSON at a character boundary.

Correct: persist raw output for replay, extract deterministic evidence, retain one paired protocol batch, and carry bounded evidence in subsequent system context.

## Scenario: Structured intent, execution plans, and safe read batches

### 1. Scope / Trigger

Use this contract when changing `infer-capability`, the Agent chat route, `ContextBuilder`, tool metadata, model tool-call batching, or `AgentRun` observability fields.

### 2. Signatures

```ts
resolveIntent(input): IntentResolution
buildExecutionPlan(resolution): ExecutionPlan
validateExecutionPlan(plan): { valid; issues }
scheduleToolCalls(calls, availableEvidence, maxConcurrency=3): { batches; rejected }
ContextBuilder.build({ ..., strategy?: "parallel" | "serial" }): Promise<AgentContext>
```

Nullable DB trace fields: `AgentRun.intentResolution`, `AgentRun.executionPlan`, `AgentRun.contextMetrics`; tool correlation fields: `ToolCall.toolCallId`, `batchId`, `completionOrder`. Old rows with null fields remain valid.

### 3. Contracts

- Explicit message actions outrank page location. Page is only a fallback when the message has no business signal.
- Multiple intents remain in message order under one parent Run. The primary capability selects budget/provider; the runtime tool allowlist is the union of resolved capabilities.
- `ExecutionPlan` step IDs are unique, dependencies form a DAG, tools belong to each capability, and every `draft_write` reaches a `user_confirmation` step.
- Context reads start only after user/timezone resolution. Independent required sources use `Promise.all`; a source failure yields an empty chunk, a failed `sourceMetric`, and a `context_source_error` manifest item rather than deleting successful chunks.
- A model batch may run at most three `parallelSafe` reads together. Dependency reads, resource conflicts, `draft_write`, and `system` calls are serial.
- Read + draft in one model batch rejects the draft with `STALE_DRAFT_BATCH`. More than one draft rejects every draft with `MULTIPLE_DRAFT_WRITES`.
- Assistant tool calls return to the provider in original model order even if completion events finish in another order.
- Draft retries use a stable semantic idempotency key based on Run + tool + normalized input. Provider call IDs or loop numbers must not create a second ChangeSet.
- `AGENT_MODEL_ROUTER_ENABLED=1` enables the bounded structured model router only for multi-intent, low-confidence, or blocking-clarification cases. Timeout/schema/provider failure returns the rules result with `degraded=true`.

### 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Plan cycle / missing dependency | `CYCLIC_PLAN` / `MISSING_DEPENDENCY` |
| Tool outside capability allowlist | `TOOL_NOT_ALLOWED` |
| Draft without confirmation step | `CONFIRMATION_MISSING` |
| Dependent read lacks prior evidence | `TOOL_EVIDENCE_REQUIRED` |
| Read and draft in same batch | `STALE_DRAFT_BATCH`, reads may continue |
| Multiple drafts in one batch | `MULTIPLE_DRAFT_WRITES`, zero writes |
| One parallel read fails | Other read results remain available; dependent steps stop/degrade by policy |
| Model router fails | Rule resolution with `degraded=true`; never invent high confidence |

### 5. Good / Base / Bad Cases

- Good: “规划本周并看看目标进度” resolves planning + progress, builds ordered outputs, shares independent reads, and ends at a ChangeSet confirmation barrier.
- Base: an unrelated knowledge question resolves `non_execution`, exposes no business tools, and does not build full business context.
- Bad: the model emits schedule reads and a ChangeSet together; runtime executes both concurrently and accepts a draft produced before the reads finish.

### 6. Tests Required

- Resolver: message-over-page, multi-intent order, missing blocking slots, non-execution, date/time slot normalization.
- Planner: DAG, dependency existence, allowlist, draft confirmation barrier.
- Context: serial/parallel equivalence, one-source failure preservation, P50 comparison.
- Scheduler/runtime: maximum concurrency, resource conflict, partial failure, original tool-message order, read/write mix, multiple drafts, semantic idempotency.
- Eval gate: Router 120, Planner 30, Runtime 30, Performance 10; safety invariants must be 100%.

### 7. Wrong vs Correct

Wrong: execute each streamed `tool_call` immediately, use `Promise.all` for every call, and key draft writes by `loopIteration:toolCallId`.

Correct: collect the provider batch, validate policy/evidence, schedule only independent reads, reconstruct tool messages in original order, and use a semantic draft idempotency key.

## Scenario: Pending-proposal continuation and bounded revisions

### 1. Scope / Trigger

Use this contract when a chat turn adjusts an `AWAITING_CONFIRMATION` ChangeSet, or when changing continuation routing, stable operation IDs, model-driven reorder behavior, revision history, or apply-time schedule validation. It prevents a one-field correction from restarting the full Agent loop and prevents token savings from weakening conflict safety.

### 2. Signatures

```ts
type AdjustmentKind =
  | "itinerary_create"
  | "proposal_patch"
  | "proposal_reorder"
  | "proposal_item_reschedule"
  | "existing_adjustment";

supportsProposalContinuation(resolution: IntentResolution): boolean;
executeProposalContinuation(input): Promise<{
  runId: string;
  text: string;
  changeSet: ChangeSetDraft & { id: string; revision: number; supersedesChangeSetId?: string } | null;
}>;
createChangeSetRevision(input): Promise<ChangeSetRevision>;
GET /api/change-sets/:id/revisions;
```

Database contract:

- `AgentRun.conversationId`, `parentRunId`, `continuationKind`, and `continuationState` are nullable for historical rows.
- `ChangeSet.revision` defaults to `1`; `supersedesChangeSetId` is a unique self-reference; `scheduleEvidence` is nullable; replaced drafts use `SUPERSEDED`.
- New operations receive a stable `operationId`. Historical operations get a deterministic read projection and are not rewritten during migration.

### 3. Contracts

- The client sends only `conversationId`, `parentRunId`, and `activeChangeSetId`. The server verifies ownership/status and loads operations; client operations are never trusted.
- `proposal_item_reschedule` with an explicit start time deterministically preserves duration and every untouched operation, then validates only the changed candidate plus proposal overlaps.
- A natural-language clock without a day period (for example `5 点半`) stays on the same proposal-continuation path. The model receives only the raw expression, current local date/time, target operation, relation (`earlier`/`later`), and bounded neighboring operations; it returns one `HH:mm`. Date, duration, operation identity, and conflict decisions remain deterministic. Explicit day periods and unambiguous 24-hour clocks do not spend this model call.
- While a client references an active pending ChangeSet, an unresolved adjustment must stop inside the bounded continuation service and ask one target question. It must never fall through to the full-context adjustment loop and create an unrelated concurrently applicable ChangeSet.
- Pure delete/title patches are deterministic. A newly added item without a time and every `proposal_reorder` without explicit times must call the selected model with a bounded `ReorderContext`; tools may provide facts and validate candidates but must not mechanically select the final times.
- `ReorderContext` keeps ISO instants for deterministic validation and also supplies explicit local-time projections for human-schedule reasoning. A model must not infer day periods directly from a `Z` timestamp.
- Model output is limited to allowlisted operation IDs and time candidates. One primary reasoning call plus one structured-conflict repair call is the maximum.
- A successful edit creates a new ChangeSet and atomically supersedes the old pending version. Formal schedule data remains unchanged until the newest revision is approved.
- The continuation capsule is valid JSON, prioritizes affected operations, excludes raw ToolCall output, and stays at or below 1,500 serialized characters.
- Approval performs authoritative proposal-internal, persisted schedule, and Routine occurrence conflict checks inside the same serializable transaction as writes. Conversation-time evidence is an optimization, not the safety boundary.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Missing/foreign/non-pending ChangeSet | Reject continuation; never trust client payload |
| Ambiguous target operation | Ask one target question; do not build full business context |
| Clock lacks 上午/下午 | At most one bounded structured time-interpretation call with current local time; then validate relation and conflicts |
| Explicit-time candidate conflict | No revision; report the bounded conflict and request another time |
| Unknown/missing/duplicate model operation | Reject `ReorderDecision` deterministically |
| Fixed operation or changed duration | Reject candidate; never silently override |
| First model candidate conflicts | Send only structured issues for one repair |
| Second candidate conflicts | No draft; ask one preference question |
| Old revision approval | Reject because status is `SUPERSEDED` |
| Schedule changed before approval | Return `STALE_PLAN`; transaction writes zero formal changes |

### 5. Good / Base / Bad Cases

- Good: “第一个从 10.15 开始，其他没问题” loads the active ChangeSet, keeps the original duration and other operation objects, validates the first item, and returns revision 2 without a reasoning-model call.
- Good: “把银行放到阅读前面，时间你判断” calls the selected model once, records `model_reasoning` tokens, validates the structured candidate, and exposes unverified business-hour beliefs as assumptions.
- Good: “英语学习的开始时间推迟到 5 点半” interprets only `5 点半` with the current local time and original 17:15 start, returns 17:30, preserves the original duration and every guitar-operation field, then atomically supersedes revision 1.
- Base: “删除第三项，再加一个 30 分钟散步” preserves every untouched operation ID; only the new item is sent to model scheduling if no time is specified.
- Bad: replay the previous assistant paragraph, reread all goals/reviews/Routines, mechanically swap two timestamps, then create a second simultaneously applicable ChangeSet.

### 6. Tests Required

- Resolver: dotted/colon times, ordinal/title references, patch/reorder/item kinds, no valid proposal fallback.
- Pure proposal helpers: duration preservation, deep equality of untouched operations, stable IDs, bounded capsule, patch parsing, fixed/allowlist/duration/window validation.
- Runtime/service: selected adapter is actually called for unspecified times; maximum one repair; explicit-time patches call no reasoning model; supersede transaction leaves one pending revision.
- Apply safety: proposal overlap, persisted schedule conflict, virtual Routine conflict, stale old revision, and zero formal writes on failure.
- Quality gates: continuation kind/target/model-call policy are 100%; duplicate and unauthorized writes are zero; full lint, typecheck, tests, deterministic eval, Prisma validation, and production build pass.

### 7. Wrong vs Correct

Wrong: inject the entire previous conversation and ToolCall JSON, then let a general adjustment loop rediscover the plan; or replace two timestamps in code when the user asked the Agent to decide what is reasonable.

Correct: resolve the active server-side ChangeSet, inject a bounded structured capsule, patch explicit fields deterministically, use the selected model only for semantic time choice, validate deterministically, and create one auditable revision.

## Scenario: Page-scoped Agent context without stale entity leakage

### 1. Scope / Trigger

Use this contract whenever page navigation, panel context chips, chat request payloads, Conversation boundaries, or pending ChangeSet continuation references change. It prevents a goal selected on an earlier page from silently influencing an instruction sent from Today or another unrelated page.

### 2. Signatures

```ts
resolveAgentPageGoalId(view: string | undefined, selectedGoalId?: string | null): string | null;
getActiveParentRunId(): string | undefined;
getActivePendingChangeSetId(): string | undefined;

type ConversationSession = {
  revision: number;
  runIds: string[];
  runRevisions: Record<string, number>;
  pendingChangeSetIds: string[];
  pendingChangeSetRevisions: Record<string, number>;
  contextScope?: { view?: string; goalId?: string | null };
};
```

Chat page payload remains `{ path, selectedEntityId? }`, but `selectedEntityId` is only accepted as an implicit goal when normalized `path === "goal-detail"`.

### 3. Contracts

- UI selection state is navigation state, not Agent authority. A retained `selectedGoalId` may keep Goal navigation convenient, but only `goal-detail` derives an Agent goal scope.
- Today, goal list, task detail, Routine, review, and settings send no implicit goal ID. Their panel chip reads `未关联目标`.
- The client derives scope before capability inference, business-goal narrowing, page payload construction, prompt shortcuts, context-boundary synchronization, and header rendering.
- The server independently derives scope again before rule/model intent routing, ContextBuilder selected-entity loading, and browser-local fallback narrowing. A stale selected goal sent for a non-goal-detail page is ignored; fallback goal data from that stale singleton payload is discarded.
- Leaving a goal scope creates a non-undoable Conversation boundary, clears summary/recent-message influence, and prevents an older pending ChangeSet from automatic continuation. The ChangeSet ID remains stored and visible for explicit approval/rejection; no data is deleted.
- Parent Run linkage is revision-scoped by the same rule. Historical Run IDs remain available for display/audit, but a new turn after a context boundary sends no `parentRunId` from the prior goal scope.
- Pending ChangeSets are automatically continuable only when their stored context revision equals the current Conversation revision. A manual context clear deactivates them; undoing that manual clear restores the prior revision association.
- Selected task, Routine, calendar block, modal seed, and home insight state are not implicit Agent entities unless a future page-specific contract explicitly adds them.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Today payload contains stale goal ID | Ignore goal ID; no selected goal in resolver, ContextBuilder, or prompt |
| Goal-detail contains valid goal ID | Load/focus exactly that goal |
| Goal-detail has no goal ID | No implicit goal; resolver may ask for a target |
| Leave goal-detail with old messages/summary | Insert non-undoable boundary; old content stays visible but is excluded |
| Old pending ChangeSet after scope boundary | Keep visible/approvable; omit from `activeChangeSetId` |
| Old parent Run after scope boundary | Keep in history; omit from `parentRunId` |
| Manual clear then undo | Restore messages and the formerly active pending proposal reference |
| Old client sends stale singleton fallback goals | Discard them rather than treating the singleton as page focus |

### 5. Good / Base / Bad Cases

- Good: open Goal A, return to Today, open Agent; chip says `未关联目标`, prior Goal A conversation is above a boundary, and a new general schedule instruction has no Goal A ID or proposal reference.
- Base: stay on Goal A detail; chip shows Goal A and resolver/context tools receive only Goal A as the selected entity.
- Bad: preserve `selectedGoalId=goal-a` in React state and directly send it from every page, or merely hide the chip while the API and ContextBuilder still receive Goal A.

### 6. Tests Required

- Pure scope matrix: only `goal-detail + non-empty id` returns a goal.
- Panel SSR: Today with a stale goal prop renders `未关联目标` and does not render the stale title; goal-detail renders the title.
- Conversation store: leaving a goal bumps revision, keeps historical Run/ChangeSet IDs, and makes `getActiveParentRunId()` plus `getActivePendingChangeSetId()` undefined.
- Manual clear/undo: proposal continuation reference deactivates then restores.
- Typecheck and production build prove the shared client/server helper stays browser-safe.

### 7. Wrong vs Correct

Wrong:

```ts
page: { path: view, selectedEntityId: selectedGoalId ?? undefined }
```

Correct:

```ts
const goalId = resolveAgentPageGoalId(view, selectedGoalId);
page: { path: view, selectedEntityId: goalId ?? undefined }
```

## Scenario: Prisma client and running-process schema coherence

### Contract

- `prisma/schema.prisma`, the applied database migrations, the generated client,
  and the running Agent service must describe the same `AgentRun` and
  `ChangeSet` fields.
- `npm run dev` regenerates the client before Next.js starts. This protects a
  fresh launch, but it does not refresh an already-running Turbopack module.
- After any schema change or migration, restart the development service and any
  worker that imported the generated client. Hot reload is not sufficient.
- Never omit continuation fields as a fallback for an `Unknown argument` error;
  doing so silently discards the parent Run and proposal revision contract.

### Required proof

1. `prisma validate` succeeds and `prisma migrate status` reports the target
   database up to date.
2. The generated `AgentRunCreateInput` contains the new continuation fields.
3. The application process started after client generation.
4. A create-shape probe succeeds inside a transaction that is deliberately
   rolled back, followed by a zero-row assertion for the probe identifier.

## Scenario: ChangeSet cross-operation references

### 1. Scope / Trigger

Use this contract whenever one ChangeSet creates an entity and another operation in the same draft refers to it, such as creating a Goal together with ScheduleBlocks, or a Milestone together with Tasks.

### 2. Signatures

```ts
type PersistedReference = { goalId?: string; taskId?: string; milestoneId?: string };
type DraftReference = { goalRef?: string; taskRef?: string; milestoneRef?: string };
```

`*Id` fields contain only IDs that already exist in the database. `*Ref` fields contain the stable `operationId` of a create operation in the same ChangeSet. `clientRef` and `tempId` are read-only compatibility aliases, not the preferred contract.

### 3. Contracts

- The server canonicalizes legacy temporary values found in `*Id` fields to the matching `*Ref` before persistence or application.
- Every create operation registers its `operationId`, `clientRef`, and `tempId` against the real ID produced inside the apply transaction.
- The server computes a recursive dependency closure for partial approval. Selecting a child automatically includes its required parent; selecting a parent alone does not imply all children.
- Operations are applied in stable topological order, regardless of model output order. Cycles, duplicate aliases, unknown refs, and wrong-entity refs are rejected before a pending ChangeSet is shown.
- Direct persisted IDs are checked for current-user ownership before the draft is stored. Apply-time ownership and version checks remain authoritative.
- Field aliases such as `deadline` and `dueDate` are canonicalized at the same boundary; UI display success must not be treated as proof that the write contract is valid.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Schedule `goalId` equals a Goal create `operationId` | Rewrite to `goalRef` and apply parent first |
| `goalRef` has no matching Goal create | Reject before persistence with `INVALID_CHANGE_REFERENCE` |
| `goalRef` points to a Task create | Reject before persistence as wrong entity type |
| Child selected without parent | Add parent to dependency closure |
| Parent and child form a cycle | Reject with `CYCLIC_CHANGE_REFERENCE` |
| Direct Goal ID is absent or belongs to another user | Reject before persistence; create zero ChangeSet rows |
| Any apply operation fails | Roll back the entire approval transaction |

### 5. Good / Base / Bad Cases

- Good: Goal create has `operationId=goal-op`; Schedule create has `goalRef=goal-op`; confirmation creates both and stores the real Goal ID on the ScheduleBlock.
- Base: Schedule create points to an existing Goal through `goalId`; preflight verifies ownership and application keeps the persisted ID.
- Bad: Schedule create puts `goal-op` in `goalId`, the UI renders it as a plausible link, and the service waits until confirmation to discover that no database Goal has that ID.

### 6. Tests Required

- Exact regression payload for Goal plus multiple schedules.
- Legacy `goalId=operationId` canonicalization and preferred `goalRef` behavior.
- Out-of-order operations, partial child selection, duplicate aliases, unknown refs, wrong entity types, and cycles.
- Persisted-ID preflight proves zero ChangeSet rows are added on failure.
- A real transaction probe proves the created ScheduleBlock uses the newly created Goal ID, then deliberately rolls back and leaves zero probe rows.

### 7. Wrong vs Correct

Wrong:

```ts
{ operationId: "goal-op", type: "create", entity: "goal", payload: { title: "Learn" } }
{ type: "create", entity: "schedule", payload: { goalId: "goal-op", title: "Lesson" } }
```

Correct:

```ts
{ operationId: "goal-op", type: "create", entity: "goal", payload: { title: "Learn" } }
{ type: "create", entity: "schedule", payload: { goalRef: "goal-op", title: "Lesson" } }
```
