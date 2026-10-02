# COMP-01 Slice E — Legacy webhook/callback contracts inventory (READ-ONLY)

**TaskRef:** task_bb3acf9108ac
**Spec:** `du-rework/coordination/dispatch-specs/2026-10-02-0205-COMP01-slice-e.md`
**Status:** characterization only; no source, test, task-row, gate, or docs edits; no tests run; no commit. Banned paths untouched: `services/orchestrator/src/server.ts` (not read), `packages/contracts`, `tasks/*.md`, `AGENTS.md`, execution overlay, `businesses/document-core/**`. No secret/API-key/token value was read — key names and usage points only.

## 1. Legacy receivers of `webhook_url` / callback

| Receiver | Field accepted | Where read | Persist / effect |
|---|---|---|---|
| `POST /api/v1/docs/ingest` | `webhook_url` (multipart) | thin wrapper `app/api/v1/docs/ingest/route.ts:5-6` → `runEndpoint` | `lib/endpoints/runner.ts:227` reads `form.get('webhook_url') as string \| null`, passes it to `submitPipelineJob` (`:234-248`) |
| `POST /api/v1/docs/extract` | same | `.../extract/route.ts:5-6` → same runner | same |
| `POST /api/v1/docs/analyze` | same | `.../analyze/route.ts:5-6` → same runner | same |
| `POST /api/v1/docs/transform` | same | `.../transform/route.ts:5-6` → same runner | same |
| `POST /api/v1/docs/generate` | same | `.../generate/route.ts:5-6` → same runner | same |
| `POST /api/v1/docs/compare` | same | `.../compare/route.ts:5-6` → same runner | same |
| `POST /api/internal/test-profile-endpoint` | same (runner-based) | `app/api/internal/test-profile-endpoint/route.ts:2` | same runner path |
| `POST /api/v1/docs/workflows` | **NONE** — route never reads a webhook field; it copies only registry-declared variables (`app/api/v1/docs/workflows/route.ts:36-41,88-95`) | — | workflow operations created here always have `webhookUrl = null` |
| `POST /api/v1/docs/workflows/schema` | **NONE** — reads `schemaSlug`/`input`/`files`/`apiKeyId` only (`.../workflows/schema/route.ts:18-59,81-91`); comment at `:36` explicitly allows text-only schemas with `callback` nodes | — | same |

Persistence: `submitPipelineJob` stores the raw string in `operations.webhookUrl` (`lib/pipelines/submit.ts:45,81,309`); the column is nullable text (`lib/db/schema.ts:35`), delivery marker `webhookSentAt` (`:36`). There is **no URL parsing, scheme allow-list, DNS/private-IP adjudication, or tenant check** on the value before it reaches `fetch` — the runner cast is the entire admission (`runner.ts:227`; `engine.ts:75`; `workflow-engine.ts:307`). `?sync=true` (`runner.ts:229`) changes only the HTTP status/wait behavior (`:256-277`); the worker still sends the webhook on terminal state.

## 2. Server-push trigger points, payloads, retry/timeout, signature (legacy)

**Normal pipeline** — worker entry `runPipeline` (`lib/pipelines/engine.ts:96`), dispatch from `worker.ts:50-55`:

| Trigger | Exact JSON body | Retry / timeout | Secret / signature |
|---|---|---|---|
| SUCCEEDED terminal (`engine.ts:427-441`) | `{"operation_id":"<uuid>","state":"SUCCEEDED","done":true}` (`:431`) | 3 attempts, `AbortSignal.timeout(10_000)` per attempt, sleeps 1s/2s between (`:72-90`); only HTTP 2xx counts (`:81`); on success sets `webhookSentAt` (`:434-437`), on total failure logs and leaves it unset (`:439`) | **None** — headers are only `Content-Type: application/json` (`:77`) |
| FAILED terminal (`engine.ts:450-480`) | `{"operation_id":"<uuid>","state":"FAILED","error":"<message>"}` — **no `done` field** (`:470`) | same as above | **None** |

**Workflow-engine path** — `completeWorkflow` / `pauseWorkflow` / `failWorkflow` (`lib/pipelines/workflow-engine.ts`), URL read from `operation.webhookUrl` into `ctx` (`:404`):

| Trigger | Exact JSON body | Retry / timeout | Secret / signature |
|---|---|---|---|
| `completeWorkflow` (`:216-244`) | `{operation_id, state:'SUCCEEDED', done:true}` (`:243` → helper `:299-304`) | **single `await fetch`**, no abort/timeout, no status check, no retry (`:296-319`); any HTTP response sets `webhookSentAt` and logs “sent” (`:312-315`); only a rejected fetch is caught/warned (`:316-318`) | **None** |
| `pauseWorkflow` (`:246-271`, HITL) | `{operation_id, state:'PAUSED', done:false, error:"<pause message>"}` — `'PAUSED'` is passed via `'PAUSED' as any` although the helper parameter type is `'SUCCEEDED' \| 'FAILED'` (`:271,296,302`) | same single-shot behavior | **None** |
| `failWorkflow` (`:274-292`) | `{operation_id, state:'FAILED', done:true, error:"<message>"}` (`:292,304`) | same single-shot behavior | **None** |

Consequences observable from code (no runtime test): a workflow receiver that never responds can hold the workflow worker indefinitely (`:307` has no signal); a 4xx/5xx still sets `webhookSentAt` (`:312-315`); and because BullMQ stalls re-queue the whole job (`worker.ts:68-69`, `maxStalledCount: 2`) while `webhookSentAt` is never consulted before re-sending (`engine.ts:428`/`:467` check only `operation.webhookUrl`), duplicate terminal webhooks are possible on job redelivery.

## 3. Second legacy path — workflow-builder `callback` node (per-node, not terminal)

`lib/workflow-builder/types.ts:107-118` defines `CallbackNode { url, payload?, method?: 'POST'|'GET', auth?: { type: 'none'|'bearer'|'header'|'query', token?, header_name?, header_value? } }`; XML import maps it from `<node type="callback" url="…" method="…" payload="…">` (`lib/workflow-builder/xml-converter.ts:115-121,196-200`). Execution happens inline when the DAG reaches the node (`lib/workflow-builder/real-exec.ts:136-147`):

- Trigger: schema flow step execution (`lib/workflow-builder/run-schema.ts:66-77`), invoked through the schema-driven workflow branch (`lib/pipelines/workflow-engine.ts:439-449`) — i.e. can fire mid-workflow, not only at terminal.
- Body: `resolve(n.payload)` serialized when method is POST (`real-exec.ts:140,144`); GET sends no body.
- Auth: optional `Authorization: Bearer <token>` or a custom header from **inline schema values** (`real-exec.ts:34-39`; `types.ts:112-117`).
- Retry/timeout/signature: **none** — single `await fetch(url, init)` with no signal, no `res.ok` check, no retry, no HMAC (`real-exec.ts:143-147`); a non-2xx response is recorded as `{content:'callback sent'}`.
- Storage note: schema JSON (including any inline `auth.token`/`header_value`) is persisted in the generic AppSetting store under key `wb_schema:<slug>` (`lib/workflow-builder/loader.ts:3,16-36`).

## 4. Webhook (server-push) vs demo client-poll — explicit distinction

- The bundled demo never uses webhooks. `app/doc-pipeline/hooks/useWorkflowPolling.ts` submits `POST /api/v1/docs/workflows` (`:60`) then **polls `GET /api/v1/operations/{id}` every 1500 ms** (`:80-125`), terminal on `done`/`FAILED`/`WAITING_USER_INPUT` (`:87-89`).
- Poll endpoint: `app/api/v1/operations/[id]/route.ts:14-37` returns `formatOperationResponse` (`lib/pipelines/format.ts:17-72`: metadata/progress/pipeline_steps; result or error on terminal); its only identity check is an optional `x-api-key-id` header equality (`:29-35`). `GET /api/v1/operations` list exposes `webhookUrl`/`webhookSentAt` read-only (`app/api/v1/operations/route.ts:85-86`).
- Therefore: **client-poll is the interaction the in-repo UI actually consumes**; server-push `webhook_url` is an external-API contract reachable only through the six core runner routes (not through either workflow route). For COMP-01/G-COMP counting, legacy workflow terminal webhooks have **no HTTP entry point** and the workflow route silently ignores a submitted webhook field.

## 5. AppSetting keys related to webhook

- No webhook-related AppSetting key exists. `SETTING_DEFAULTS` / `ENCRYPTED_KEYS` cover ai/openai/api_secret/s3 keys only (`lib/settings.ts:88-111`); generic reader/writer `:115-160`.
- Webhook URL lives per-operation (`operations.webhookUrl`, `lib/db/schema.ts:35`), never in AppSetting.
- The workflow-builder schema JSON is stored in AppSetting (`wb_schema:<slug>`), so a `callback` node’s destination and optional inline auth values ride a settings row (`loader.ts:3,16-36`; shape at `types.ts:107-118`). No values were read.
- No webhook signing secret/env key found in legacy source or repo config files searched (grep `webhook|WEBHOOK` over `lib/** app/** *.yml *.yaml *.env *.example`); legacy has no signature at all.

## 6. Rework counterpart (orchestrator only — contracts/server.ts not read per slice-E ban)

| Slice item | Status | Evidence |
|---|---|---|
| Receiver field | **PRESENT** | Canonical `callback.url` validated on submission (`services/orchestrator/src/compat/legacy-wire-decoders.ts:191-193,427-439` maps legacy `webhook_url`/`webhookUrl`); decoder delegates URL syntax + static destination policy to canonical submission (prior report `codex-webhook-wire-contract-2026-10-01.md` §4 documents contract refs; contracts not re-read here) |
| Trigger points | **PRESENT** | Transactional `maybeScheduleWebhook(client, operationId)` on terminal transitions: `modules/webhooks/webhooks.ts:59-100`; call sites `modules/lifecycle/lifecycle.ts:65,97`, `modules/runtime/runtime.ts:572,677,1243,1464`, `modules/operations/ingestion-consumer.ts:455` |
| Payload | **PRESENT** | `{deliveryId,eventType,operationId,state,stateVersion,occurredAt}` built from terminal state (`webhooks.ts:33-47,76-83`); no `done`/`error` fields |
| Retry/timeout | **PRESENT** | Durable rows: `attempts=0`, `max_attempts=5`, `next_at=now()` (`migrations/0007_webhook_deliveries.sql:18-25`); claim/backoff/2xx-only in dispatcher (`webhooks.ts:309-345`); 10 s default dispatch timeout (`:317,340`) |
| Secret/signature | **PRESENT** | HMAC-SHA256 over `{timestamp}.{body}` → `sha256=<hex>` (`webhooks.ts:106-117`); headers `x-du-signature` / `x-du-timestamp` / `x-du-delivery-id` (`:447,453-457`) |
| Per-node callback action | **ABSENT** (orchestrator scope) | No callback-node executor found in `services/orchestrator/src/modules/**`; document-core workflow surface intentionally not inspected (D3 lease) |
| Client-poll API | **PRESENT** | `GET /operations/{id}` (`?wait=` long-poll) marked Implement in `docs/06-public-api.md:20`; route wiring lives in server.ts (out of scope per slice-E ban) |
| Delivery encryption | **PRESENT** (delta) | Encrypt-wrapper build at `webhooks.ts:210`; enabled-but-failing encryption posts nothing (`:441-445`); wire-shape/encryption details in prior report `codex-webhook-wire-contract-2026-10-01.md` §3 |

## 7. MISMATCH ledger — docs claim vs actual handler

1. `lib/pipelines/workflows/README.md:347` documents `-F "webhookUrl=https://your-app.com/webhook"` for `POST /api/v1/docs/workflows`. The handler reads **no** webhook field (`app/api/v1/docs/workflows/route.ts:36-41,88-95`); and even on core routes the field is snake_case `webhook_url` (`runner.ts:227`). A client following the README gets no webhook and no error.
2. `lib/pipelines/workflows/README.md:373-379` claims the payload is always `{ "operation_id", "state", "done", "error": null }`. Actual: normal-failure omits `done` (`engine.ts:470`); success omits `error` (`:431`); workflow pause carries `error` = pause message and `done:false` (`workflow-engine.ts:299-304`); only workflow failure matches the README field set (`:292,304`).
3. `docs/API_PROFILES_SPEC.md:35` claims webhooks send `{operation_id, state, done}` and retry “tối đa 3 lần” as a blanket contract. The workflow path has **zero** retry, zero timeout, and no status check (`workflow-engine.ts:296-319`), so the retry claim is false for workflow operations.
4. `docs/workflow-schema-guide.md:224-246,541` documents the `callback` node (`url`/`payload`/`method` POST|GET/auth). Code matches at `real-exec.ts:136-147` / `types.ts:107-118` except: a GET callback silently sends **no payload** (docs list `payload` unconditionally), and neither doc nor code defines retry/timeout/signature semantics for the node.
5. `app/api/v1/docs/workflows/route.ts:1` header comment names the file `app/api/v1/workflows/route.ts`; the executable path is `/api/v1/docs/workflows` (consumer evidence: `useWorkflowPolling.ts:60`). Stale comment, already implied by slice-A route matrix (`codex-comp01-slice-a-legacy-route-matrix-2026-10-02.md` §3).

## 8. MUST-NOT-REPLICATE (recorded, not reproduced)

- Unsigned, unauthenticated callbacks with no delivery id (both terminal paths and the callback node): no HMAC, no timestamp, no replay/dedup key (`engine.ts:77`; `workflow-engine.ts:309`; `real-exec.ts:142`).
- Client-supplied destination fetched directly with no scheme/host policy (`runner.ts:227` → `engine.ts:75` / `workflow-engine.ts:307`) — SSRF surface.
- Secrets embeddable inline in a stored workflow schema (`CallbackNode.auth.token/header_value` → AppSetting `wb_schema:<slug>`; `types.ts:112-117` + `loader.ts:16-36`), i.e. secret material in a generic settings row.
- Fire-and-forget semantics: no status check and/or no timeout on the workflow path and callback node; `webhookSentAt` set on any HTTP response (`workflow-engine.ts:312-315`).
- Duplicate-delivery risk on job redelivery/stall (`worker.ts:68-69`; no resend guard against `webhookSentAt`).
- Type hole `'PAUSED' as any` diverging from the declared helper contract (`workflow-engine.ts:271,296`).

## 9. Commands / tooling and boundaries

- No shell commands and no tests were run. Evidence was gathered exclusively with read-only file reads, content grep, and glob patterns (literal file:line citations above). Per spec acceptance §5 there is nothing to paste as command output.
- No file was modified except this receipt; no gate was ticked; no commit; no message to `nocobase-10`; secrets values were not read.
- Rework files read for the counterpart: `services/orchestrator/src/modules/webhooks/webhooks.ts`, `.../modules/lifecycle/lifecycle.ts`, `.../modules/runtime/runtime.ts` (grep only), `.../modules/operations/ingestion-consumer.ts` (grep only), `.../compat/legacy-wire-decoders.ts`, `migrations/0007_webhook_deliveries.sql`, `docs/06-public-api.md`. Prior report `codex-webhook-wire-contract-2026-10-01.md` is referenced as prior evidence for contract/encryption refs that slice-E is forbidden to re-read (`packages/contracts`, `server.ts`).

## Verdict

Legacy exposes exactly one outbound notifier family — `webhook_url` on the six core runner routes — with two divergent implementations (3×10 s retrying pipeline vs single-shot workflow), plus an independent per-node `callback` action in workflow-builder. All are unsigned, destination-unvalidated, and the workflow terminal path is unreachable from the HTTP workflow routes (silent ignore). COMP-01/G-COMP should count workflow webhooks as **legacy contract documented but not reachable through its own route**, and client-poll (demo) as the actually consumed retrieval mechanism.
