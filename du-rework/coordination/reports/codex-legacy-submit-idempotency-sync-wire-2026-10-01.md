# Legacy Submit Idempotency and Sync Wire Contract (2026-10-01)

## Scope

Read-only characterization of the legacy submit and operation GET paths, compared with the rework public action-submit and idempotency paths. No source files were changed, no tests were run, and no gate or COMP row was changed.

## 1. Legacy idempotency path

`runEndpoint()` reads `idempotency-key` directly from the request headers and passes the raw value into `submitPipelineJob()` (`lib/endpoints/runner.ts:226-248`). There is no format, length, or expiry validation in this path. Missing headers become `undefined`; an empty value is treated as absent by the truthy checks and `idempotencyKey || null` (`lib/pipelines/submit.ts:142-147,300-315`).

Before creating a new operation, `submitPipelineJob()` queries `operations` using only `operations.idempotencyKey = idempotencyKey`, then returns the found operation with `isIdempotent: true` (`lib/pipelines/submit.ts:141-147`). It does not compare the new request payload with the stored request, does not create a replacement operation, and returns before file storage, row insertion, or queue enqueue (`lib/pipelines/submit.ts:141-147,186-193,294-315,335-390`). Initial request parsing, pipeline construction, and the submit function's earlier pipeline/connector checks have already occurred before this lookup (`lib/endpoints/runner.ts:84-88,209-248`; `lib/pipelines/submit.ts:100-139`).

The race-recovery path catches PostgreSQL unique violation `23505`, repeats the same key-only lookup, and returns the row that won the race as `isIdempotent: true` (`lib/pipelines/submit.ts:317-332`). No request-hash comparison occurs in either lookup (`lib/pipelines/submit.ts:142-147,326-330`).

`Operation.idempotencyKey` is declared as a globally unique nullable text column; the unique constraint is on that single column, with no API-key or tenant component (`lib/db/schema.ts:10-15`). The lookup predicates likewise contain only the key and no ownership predicate (`lib/pipelines/submit.ts:142-145,326-329`). There is no key expiry column in the Operation schema (`lib/db/schema.ts:10-48`) and no expiry check in either lookup (`lib/pipelines/submit.ts:142-147,326-330`).

**MUST-NOT-REPLICATE —** Legacy's global unique key and key-only lookup are not scoped to the submitting API key or tenant; the existing row can be returned without comparing its `apiKeyId` to the current caller (`lib/db/schema.ts:10-15`; `lib/pipelines/submit.ts:142-147,326-330`).

### Replay response

The existing `Operation` row is passed through the same `formatOperationResponse()` used for a new submit (`lib/endpoints/runner.ts:256-277`). The response status is 200 because `result.isIdempotent` is true; the JSON does not add an idempotency/replay marker (`lib/endpoints/runner.ts:256-277`). Its body reflects the operation row's current state, so a replay can return the original operation while it is still running or after it is terminal (`lib/pipelines/format.ts:17-72`). A replay does not wait for completion, even if the retry also contains `?sync=true`, because the existing-row return exits `submitPipelineJob()` before the sync wait block (`lib/pipelines/submit.ts:141-147,369-385`; `lib/endpoints/runner.ts:256-257`).

## 2. Legacy sync-mode status and body

`sync=true` is read from the POST URL query string; `idempotency-key` is a separate header (`lib/endpoints/runner.ts:226-230`). `isSyncOrIdempotent` is exactly `result.isIdempotent || executeSync`, and the runner maps true to HTTP 200 and false to HTTP 202 (`lib/endpoints/runner.ts:256-257`). Thus 200 means “sync was requested or this was a replay”; it does **not** guarantee that the operation finished.

For a fresh sync request, the code enqueues the job and awaits `job.waitUntilFinished(queueEvents, SYNC_TIMEOUT_MS)` (`lib/pipelines/submit.ts:369-377`). The default timeout is 30,000 ms and can be overridden through `SYNC_TIMEOUT_MS` (`lib/config.ts:16`; `lib/queue/pipeline-queue.ts:18-19`). On either timeout or job failure, the catch logs and continues; it reloads the operation row and returns it rather than returning 202 or an error response (`lib/pipelines/submit.ts:376-385`). If still unfinished at timeout, the HTTP status remains 200 and the body contains the latest pending operation representation with no `result` (`lib/endpoints/runner.ts:256-277`; `lib/pipelines/format.ts:17-34`). If the reloaded operation is already successful, the formatter includes `result`; if failed, it includes `error` and may include a partial usage result (`lib/pipelines/format.ts:35-70`).

The submit response body uses `formatOperationResponse()`: top-level `name`, `done`, and `metadata`; `metadata` has `state`, processor-name `pipeline`, `current_step`, `progress_percent`, `progress_message`, `create_time`, `update_time`, and `pipeline_steps`. A successful terminal row adds `result` containing `output_format`, `content`, `extracted_data`, `pipeline_steps`, `usage`, and `download_url`; a failed terminal row adds `error` (`lib/pipelines/format.ts:17-72`).

The subsequent `GET /api/v1/operations/{id}` uses that same formatter, so it has the same JSON shape for the same operation state; field values can differ because the operation may have advanced since submit returned (`app/api/v1/operations/[id]/route.ts:14-37`; `lib/pipelines/format.ts:17-72`).

### Async 202 response and headers

For a fresh non-sync submission, the operation is inserted with `state: 'RUNNING'`, `done: false`, `progressPercent: 0`, and `progressMessage: 'Initializing pipeline...'` (`lib/pipelines/submit.ts:300-315`). The async branch enqueues and returns the inserted row without reloading it (`lib/pipelines/submit.ts:387-392`). The 202 JSON therefore contains `name: "operations/{id}"`, `done: false`, and `metadata` with the just-inserted state/progress, pipeline step names, current step, timestamps, and empty parsed pipeline-step results; it has no top-level `operationId` and no `result` field while `done` is false (`lib/pipelines/format.ts:17-34`).

The runner sets `Operation-Location: /api/v1/operations/{id}` only on the 202 branch. The 200 branch sets no custom response header; `NextResponse.json()` supplies the JSON response (`lib/endpoints/runner.ts:272-277`).

## 3. Legacy webhook/callback branch

The form field is named `webhook_url`; it is passed into submission and stored as `operations.webhookUrl` (`lib/endpoints/runner.ts:226-248`; `lib/pipelines/submit.ts:300-315`). It does not add or remove fields or change the submit status/body shape (`lib/endpoints/runner.ts:256-277`).

On ordinary pipeline success or failure, the worker first writes the terminal operation state and then awaits `sendWebhook()` with `{operation_id, state, done: true}` on success or `{operation_id, state, error}` on failure (`lib/pipelines/engine.ts:400-414,427-441,450-480`). The callback is part of the awaited worker execution (`worker.ts:44-58`): for a sync submit that returns because the job finished, callback attempts have completed before the wait resolves; if the sync wait times out, they may still be in progress (`lib/pipelines/submit.ts:369-385`). For async submit, the callback follows operation completion, but the queue worker can run concurrently with response delivery, so the code establishes no strict ordering between the callback POST and the client receiving the 202 (`lib/pipelines/submit.ts:387-392`; `worker.ts:44-58`).

Workflow jobs also send a `PAUSED` callback when entering `WAITING_USER_INPUT` (`lib/pipelines/workflow-engine.ts:246-272`).

## 4. Rework counterpart

### Public action submit

The public route passes `Idempotency-Key` into `SubmissionService.submit()` and does not call the generic `modules/idempotency` `readIdempotencyKey()`/`executeIdempotent()` path (`du-rework/services/orchestrator/src/server.ts:1730-1743`; generic admin call sites include `:2237-2241`). Public submit's scope is `(tenant_id, api_key_id, route_action, key)`, represented by the `submission_keys` primary key (`du-rework/services/orchestrator/migrations/0001_platform_v1.sql:57-68`). The preflight lookup supplies all four scope values and filters to `expires_at > now()` (`du-rework/services/orchestrator/src/modules/operations/submission.ts:210-229,678-691`).

Rework computes a canonical request hash over `input`, `artifacts`, `output`, `callback`, and `sourceUrl`; same scoped key with a different hash returns 409 `IDEMPOTENCY_CONFLICT`, while a same-hash replay loads the existing operation view and sets `replayed: true` (`du-rework/services/orchestrator/src/modules/operations/submission.ts:202-229`). The transactional recheck uses the same four scope values and hash before insertion (`:266-281`); creation of the operation, root task, key row, and outbox dispatch occurs in one transaction (`:284-359`). The replay response reloads the current operation view rather than storing and replaying the original public HTTP body (`:226-227,362-363`; `du-rework/services/orchestrator/src/server.ts:1751-1761`).

The route returns 202 for a fresh submit and 200 for a replay. The body is `{operationId, state, stateVersion, replayed, correlationId, links}`; fresh submits use `replayed: false`, replays use `true` (`du-rework/services/orchestrator/src/server.ts:1730-1762`). The route passes the raw header value (`:1740`); no public submit key-format validation is performed there. `SubmitContext` has an optional TTL, and the public route does not pass it, so the default is 24 hours (`du-rework/services/orchestrator/src/modules/operations/submission.ts:40-50,234`; `du-rework/services/orchestrator/src/server.ts:1735-1743`). The storage row has `expires_at` (`du-rework/services/orchestrator/migrations/0001_platform_v1.sql:58-68`). The fast lookup filters expired rows, but the transactional recheck does not include `expires_at`; an expired row still present therefore reaches the recheck and returns the old operation for a matching hash or a 409 for a different hash (`du-rework/services/orchestrator/src/modules/operations/submission.ts:266-281,678-691`). The HTTP listener sets `x-correlation-id` and JSON `content-type` for responses generally; the public submit route adds no `Operation-Location` or replay-specific header (`du-rework/services/orchestrator/src/server.ts:716-720,1730-1762,798-810`).

The public POST action route has no sync/wait query handling; it returns after submit and the dispatch kick (`du-rework/services/orchestrator/src/server.ts:1730-1762`). A separate `GET /api/v1/operations/:id?wait=<seconds>` polls for a terminal operation, clamped to 0–30 seconds, and returns the latest operation view at timeout (`du-rework/services/orchestrator/src/server.ts:1806-1840`; `du-rework/services/orchestrator/src/modules/operations/facade.ts:16,57-85`). This GET wait is not a synchronous POST submit mode.

### Generic idempotency module is a separate surface

`modules/idempotency/idempotency.ts` supports admin mutating POSTs: it accepts `Idempotency-Key` or `Client-Token`, validates 8–200 printable ASCII characters, and stores status/body keyed by `key`, with route and canonical payload hash checked on replay (`du-rework/services/orchestrator/src/modules/idempotency/idempotency.ts:72-110`). The admin table has a global key primary key and stores route, payload hash, response code/body, and creation time (`du-rework/services/orchestrator/migrations/0012_admin_idempotency.sql:17-28`). `executeIdempotent()` replays the stored response and reports `replayed`; the admin handlers add `idempotent-replay: true` (`idempotency.ts:113-153`; `server.ts:2237-2241,2265-2274`). Its purge helper is explicitly not wired to a timer (`idempotency.ts:155-165`). This stored-response admin mechanism is distinct from the public operations `submission_keys` mechanism described above.

### Rework callback timing

Public submit accepts `submission.callback.url`, includes it in the request hash, and stores it as `operations.callback_url` (`du-rework/services/orchestrator/src/modules/operations/submission.ts:202-208,301-303`). It does not add callback data to the submit response body (`du-rework/services/orchestrator/src/server.ts:1751-1761`). A terminal transition schedules a durable `webhook_deliveries` row in the same transaction (`du-rework/services/orchestrator/src/modules/webhooks/webhooks.ts:18-25,49-99`); a background interval dispatches deliveries (`du-rework/services/orchestrator/src/server.ts:905-929`). Therefore callback delivery is tied to a terminal transition and is separately dispatched; source does not promise it arrives before or after the client's 202 response.

## 5. Wire delta summary

| Behavior | Legacy | Rework public submit |
|---|---|---|
| Fresh async status | 202 unless `sync=true` (`runner.ts:256-257`) | 202 (`server.ts:1751-1753`) |
| Fresh sync wait | POST `?sync=true`; wait default 30 seconds (`runner.ts:229`; `submit.ts:369-385`; `config.ts:16`) | No POST sync wait; GET `?wait=` is separate (`server.ts:1730-1762,1806-1840`) |
| Replay status/body | 200; formatted current original operation; no replay flag; no wait (`runner.ts:256-277`; `format.ts:17-72`) | 200; current operation view in submit envelope with `replayed: true` (`submission.ts:226-227`; `server.ts:1751-1761`) |
| Key scope and equivalence | Global unique key; no owner scope or request hash (`schema.ts:10-15`; `submit.ts:142-147`) | `(tenant, API key, route action, key)` plus canonical request hash (`0001_platform_v1.sql:58-68`; `submission.ts:202-229,678-691`) |
| Key retention/validation | No expiry or app-level key format/length check found (`schema.ts:10-48`; `runner.ts:228`; `submit.ts:142-147`) | Public submit defaults to 24-hour `expires_at`; lookup filters expiry, transaction recheck does not (`submission.ts:234,266-281,678-691`) |
| Response header | `Operation-Location` only on fresh async 202 (`runner.ts:272-277`) | No replay-specific header on public action submit; response envelope carries links (`server.ts:1751-1762`) |
| Callback | `webhook_url` stored; terminal callback awaited by worker; no submit-shape change (`runner.ts:227`; `submit.ts:309`; `engine.ts:427-441,467-480`) | `callback.url` stored; durable delivery scheduled at terminal transition and background-dispatched (`submission.ts:301-303`; `webhooks.ts:59-99`; `server.ts:905-929`) |
