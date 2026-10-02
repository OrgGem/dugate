# COMP-01 Slice D — Legacy Lifecycle & List/Pagination Semantics (READ-ONLY)

**Task:** `task_9ef290685a7f`  
**Status:** characterization only. No source, gate, or task-row edits. No tests run.  
**Continuity:** continues slice A (`codex-comp01-slice-a-legacy-route-matrix-2026-10-02.md`). Route shape is NOT repeated; sections 4-5 of slice A are assumed. This slice covers transitions, preconditions, status codes and pagination, using the same section-numbering scheme.

## 1. State machine — every state/done value written by legacy code

Observed state literals in code: **6** — `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED`, `WAITING_USER_INPUT`, and `PENDING` (filterable but never written, see M2). The UI type enumerates the same five written values (`app/operations/[id]/page.tsx:22`).

| # | From | To | done | Writer | Condition / file:line |
|---|---|---|---|---|---|
| T1 | (none) | `RUNNING` | false | submit insert | initial row (`lib/pipelines/submit.ts:310-311`) |
| T2 | (none) | `RUNNING` | false | workflow start | `workflow-engine.ts:133-134` |
| T3 | `WAITING_USER_INPUT` | `RUNNING` | unchanged | resume route | requires exact source state (`resume/route.ts:31-33,85`) |
| T4 | `RUNNING` | `SUCCEEDED` | true | pipeline engine | end of step loop, unconditional on id (`engine.ts:399-414`) |
| T5 | `RUNNING` | `SUCCEEDED` | true | workflow engine | `workflow-engine.ts:219-220` |
| T6 | running | `FAILED` | true | engine error paths | `engine.ts:132-133, 166-167, 455-456` |
| T7 | running | `FAILED` | true | workflow engine | `workflow-engine.ts:280-281` |
| T8 | `RUNNING` + not done | `FAILED` | true | recover-stalled cron | older than threshold (`app/api/internal/recover-stalled/route.ts:35-58`) |
| T9 | `RUNNING` | `WAITING_USER_INPUT` | false | workflow HITL pause | `workflow-engine.ts:256-257` |
| T10 | not-done | `CANCELLED` | true | cancel route | `op.done` guard rejects terminal first (`cancel/route.ts:32-37, 40-41`) |

`WAITING_USER_INPUT` is the only non-terminal pause state. There is **no timeout state**: a stalled operation is force-FAILED (T8), never a distinct value.

**`done` and `state` are independent columns.** `done` alone gates the `result`/`error` blocks (`lib/pipelines/format.ts:35,53`); no transition enforces done=true only for terminal states — see F1.

## 2. Lifecycle route matrix

| Route | Source-state precondition | Effects | Status codes by source state |
|---|---|---|---|
| `GET /operations/{id}` | row exists AND `deletedAt IS NULL` | none (read) | `404` missing/deleted (`[id]/route.ts:22`); `403` when `x-api-key-id` present and mismatched (`:30`); `200` envelope |
| `DELETE /operations/{id}` | row exists, `deletedAt IS NULL` | soft-delete `deletedAt=new Date()` (`:62`) | `404` missing/deleted (`:47`, **no `detail`**); `403` mismatch (`:55`); `204` empty body (`:64`) |
| `POST .../cancel` | `!op.done` | writes `done:true`, `state:'CANCELLED'`, `progressMessage:null` (`:40-42`); returns formatted envelope (`:45`) | `404` missing/deleted; `403` mismatch; `409` Already Completed when `op.done` (`:32-37`); `200` otherwise |
| `POST .../resume` | source state exactly `WAITING_USER_INPUT` | merges `extracted_data` into the matching step only when `step` AND `extracted_data` both present (`:56-63`); sets `state:'RUNNING'` + progress message + re-encoded steps (`:85-90`); `queue.add` re-enqueue (`:95`) | `404` bare `{error}` — **different envelope** (`:27`); `400` bare `{error}` for any non-paused state (`:31-33`); `500` `{error: err.message}` (`:101`); `200` `{success,message}` (`:98`) |
| `GET .../download` | `op.done AND op.state === 'SUCCEEDED'` AND `deletedAt IS NULL` | inline streams `outputContent`; file path does traversal check then streams | `404` missing/deleted; `403` mismatch; `409` Not Ready if not SUCCEEDED (`:37-42`); `404` No Output if neither content nor path (`:116`); `200` binary |

### Legacy fail-open points (evidence for COMP-00 #4; none reproduced here)

| # | Where | Fail-open behaviour |
|---|---|---|
| F1 | cancel `:40-41` | Writes `done:true`/`CANCELLED` **without signalling the worker**. The engine never reads state mid-run and T4 overwrites `SUCCEEDED` unconditionally (`engine.ts:399-414`), so a cancelled-but-running operation reports CANCELLED then silently becomes SUCCEEDED. **Fake terminal state — MUST-NOT-REPLICATE.** |
| F2 | cancel `:40` | No CAS or state predicate on the UPDATE; concurrent cancel/complete races. |
| F3 | resume | **No tenant fence** — no `apiKeyId` read anywhere in the file, unlike cancel/GET/DELETE/download. Any caller knowing an id can resume it and write `extracted_data` (`:56-63`). **MUST-NOT-REPLICATE.** |
| F4 | resume | No CAS and no idempotency: read-then-update (`:31,85`) then `queue.add` (`:95`); two resumes both pass the gate and double-enqueue. |
| F5 | resume `:101` | 500 leaks `err.message` verbatim. |
| F6 | all five routes + list | Fence is `if (apiKeyId && op.apiKeyId !== apiKeyId)` — **opt-in**; an absent header means no check at all. **List-no-resolve / tenant-unfenced read. MUST-NOT-REPLICATE.** |
| F7 | resume `:56` | `{step}` without `extracted_data` is accepted, silently no-ops, yet still re-enqueues — a resume that applies no human edit. |

## 3. Pagination mechanics

| Aspect | Observed | file:line |
|---|---|---|
| `page_size` bound | `Math.min(parseInt(page_size ?? '20'), 100)` — **upper bound only, no lower bound, no validation** | `:31` |
| default | 20 | `:31` |
| `page_token` meaning | an **operation id**; resolved by selecting that row `createdAt`, then filtering `createdAt < cursor.createdAt` | `:59-64` |
| ordering | `ORDER BY createdAt DESC`, `LIMIT pageSize+1`; `hasMore = len > pageSize` | `:93-96` |
| token emission | last item **id**, only when `hasMore`, else null | `:98,129` |
| soft-deleted rows | excluded via `isNull(deletedAt)` | `:37` |
| item shape | `name`, `done`, `metadata{state, endpoint_slug, current_step, progress_percent, progress_message, create_time, update_time}`, plus `error` when done+FAILED, plus `result.usage` when done+SUCCEEDED | `:101-125` |
| `filter` keys | `state`, `processor` | `:42-56` |
| `filter` states | `RUNNING`, `SUCCEEDED`, `FAILED`, `PENDING` (exact match) | `:40,47-49` |
| invalid state filter | `400` with `{error: ...}` | `:48` |
| `processor` filter | `ilike(pipelineJson, '%val%')` — substring match against **raw JSON**, not a parsed processor index | `:52-54` |

## 4. Pagination edge cases (read from code, not executed)

| # | Input | Result | Evidence |
|---|---|---|---|
| E1 | `page_size=0` | `LIMIT 1`; if any row is visible then `hasMore=true`, `items=[]`, and `items[items.length-1].id` dereferences undefined → **throws (500)** | `:94-98` |
| E2 | `page_size=-5` | `LIMIT -4`; PostgreSQL rejects a negative LIMIT | `:31,94` |
| E3 | `page_size=abc` | `parseInt` yields NaN, `Math.min(NaN,100)` yields NaN, `LIMIT NaN` | `:31,94` |
| E4 | `page_token` unknown id | `cursorItem` undefined so **no cursor condition is applied** — silently returns page 1 instead of 404 (fail-open) | `:60-64` |
| E5 | `page_token` = another tenant's op id | Cursor lookup selects **by id alone**, with no `apiKeyId` or `deletedAt` predicate, and is then used as a pagination anchor — leaks ordering position of a foreign row | `:60` |
| E6 | rows sharing `createdAt` | Cursor is `createdAt` **only** with no id tiebreak, so a page boundary can skip or repeat rows within the same millisecond | `:62,93,98` |
| E7 | `filter=state=SUCCEEDED&foo` | Unknown segment silently ignored (no else branch) | `:44-55` |
| E8 | `filter=state=A=B` | `split('=')` keeps only `[0]`/`[1]`, so the value truncates to `A` and yields 400 | `:45` |
| E9 | `processor` containing `%` or `_` | Injected **unescaped** into the LIKE pattern, so wildcard semantics apply instead of substring | `:53` |

## 5. MISMATCH ledger (spec/docs claim vs handler)

| # | Claim | Code reality | Evidence |
|---|---|---|---|
| M1 | Swagger documents `page_size` default 20 max 100 | Matches, but there is **no minimum and no type validation** | swagger block `:16-18` vs `:31` |
| M2 | Filter states look exhaustive | `PENDING` is **filterable but never written**; `CANCELLED` and `WAITING_USER_INPUT` are written but **not filterable** | `:40` vs write sites in section 1 |
| M3 | Detail and list share one envelope | They differ: detail carries `result.pipeline_steps` and a 6-field `result.usage`; list carries only `usage.{input,output,cost}`. A client cannot treat one as the other | `format.ts:57-74` vs `:117-123` |
| M4 | Lifecycle errors use the problem+json envelope | `resume` returns bare `{error}` objects, not `{type,title,status,detail}` | `resume:27,31,101` vs `cancel:33` |
| M5 | Cancel performs a real cancellation | Advisory only; T4 overwrites it (F1) | `cancel:40-41` vs `engine.ts:399-414` |
| M6 | 404 detail is uniform | GET 404 includes `detail` + `requested_id`; DELETE/cancel/download 404s have **no `detail`** | `[id]:24` vs `:47` |
| M7 | `sync=true` waits for completion | It waits up to `SYNC_TIMEOUT_MS` (default **30000**), **swallows timeout/failure**, reloads, and returns **HTTP 200 regardless of terminal state** — a still-RUNNING operation is returned 200 | `submit.ts:377-385`, `pipeline-queue.ts:19`, runner status rule |
| M8 | Idempotency key is scoped per API key | Lookup is `WHERE idempotencyKey = $1` against a **globally unique** column with **no `apiKeyId` predicate**, so a key used by tenant A returns **A's operation to tenant B** | `submit.ts:143-146`, `schema.ts:26` |

## 6. Rework counterpart (read-only comparison)

| Aspect | Legacy | Rework today | Same/different |
|---|---|---|---|
| terminal set | `SUCCEEDED`, `FAILED`, `CANCELLED` | plus `TIMED_OUT` | **DIFFERENT** — rework has a real timeout state; legacy force-FAILs via cron (T8) |
| wait state | `WAITING_USER_INPUT` | `WAITING_INPUT` | **DIFFERENT** (rename) |
| non-terminal set | `RUNNING` plus `WAITING_USER_INPUT` | `PENDING_INGESTION`, `ACCEPTED`, `QUEUED`, `RUNNING`, `WAITING_CHILDREN`, `WAITING_INPUT`, `RETRY_PENDING`, `CANCEL_REQUESTED` | **DIFFERENT** — rework splits one legacy bucket into 8 |
| filter semantics | 4 exact string matches | `LEGACY_STATE_FILTERS` maps each legacy bucket onto a canonical **set** (`compat/legacy-operations.ts`) | **DIFFERENT in kind** — set membership vs exact equality |
| `next_page_token` | operation **id** (`:98`) | COMP-06 mints `lastItem?.id` (op-id); `legacy-operation-serializers.ts` mints the **4-slot cursor** | **CONFLICT — two dialects already exist** |

**Two items this slice surfaces, not decided here:**
1. `next_page_token` dialect — op-id (legacy + COMP-06) vs 4-slot cursor (serializer). One field, two implementations; COMP-00 must pick.
2. Whether the COMP-06 **set** semantics may replace legacy **exact** semantics on the legacy path. A client filtering `state=RUNNING` today receives only literal `state='RUNNING'` rows; under rework it would also receive `WAITING_INPUT`, `CANCEL_REQUESTED` and others. That is a **behaviour change on the legacy wire**, not a compat improvement.

## 7. Read-only evidence / completion

- **No tests and no `tsc` run** — neither was needed to answer the semantics questions; every claim cites `file:line` from source read directly.
- Sources read: the five operations routes, `lib/pipelines/submit.ts`, `lib/pipelines/engine.ts`, `lib/pipelines/workflow-engine.ts`, `lib/pipelines/format.ts`, `lib/db/schema.ts` (Operation model), `lib/queue/pipeline-queue.ts`, `app/api/internal/recover-stalled/route.ts`, and rework `services/orchestrator/src/compat/legacy-operations.ts`. Route admission semantics come from slice A.
- `server.ts`, `contracts`, `tasks/*.md`, `AGENTS.md`, execution overlay and `businesses/document-core/**` were **not touched**.

**Gates:** none ticked; all `G-*` remain **NO-GO**. No commit. No message to nocobase-10.