# LLM Structured Output (generateObject)

> When calling models as a function for JSON / Zod-validated output — not Agent streaming.

## Thinking Triggers

- [ ] Using `generateObject` / non-streaming Chat Completions with `response_format`
- [ ] Provider is Qwen / DashScope / another hybrid-thinking model
- [ ] Agent streaming works but structured calls hang, time out, or return 400
- [ ] Schema validation fails after the model "almost" returns the right shape

→ Follow the contracts below before adding more client timeouts or retries.

---

## Scope / Trigger

Applies to `src/agent/openai-compatible-adapter.ts` → `generateObject`, and callers such as:

- `src/server/services/home-insights-generate.ts`
- `src/server/services/reviews.ts`
- `src/server/services/task-completion.ts`

## Contracts

| Concern | Rule |
|---------|------|
| Thinking models + JSON | Non-streaming + `json_object` / `json_schema` **must** send `enable_thinking: false` for Qwen/DashScope (and similar). Thinking mode requires streaming and is incompatible with structured JSON mode. |
| Agent path | `stream()` may keep thinking enabled; do not copy Agent request bodies into `generateObject`. |
| Model field | Always send `request.model \|\| config.model` — never ignore the capability-resolved model. |
| Schema tolerance | Prefer preprocess/normalize for common LLM drift (`null` vs omit, field aliases, missing `label`). Invalid **alternate** candidates may be dropped; **primary** must still validate. |
| Timeouts | Prefer a server-side AbortSignal around the LLM call + rules fallback over only aborting the browser fetch. |
| Logging | Log provider, model, attempt, `disableThinking`, duration, and a short content preview on parse failure (`[llm]` / `[home-insights]`). |

## Wrong vs Correct

**Wrong**: Non-streaming `generateObject` to `qwen3.5-plus` with only `response_format: { type: "json_object" }` and no `enable_thinking: false` → request hangs until client/server timeout; Agent chat still looks fine.

**Correct**: Same call with `enable_thinking: false` (and preferably `json_schema`), plus Zod preprocess for `label` / `null` optionals → typically returns in ~10–20s.

## Manual refresh policy (home insights)

- Scheduled / cold_start: do **not** overwrite an existing AI snapshot with a rules fallback.
- Manual: **allow** rules to overwrite so the user always sees a fresh result after clicking update.
