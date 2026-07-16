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
