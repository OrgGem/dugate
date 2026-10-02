# COMP-05 — Executable legacy projection fixture spec

## Result type

**This is an executable fixture spec, not a live-verified observation.** The prior tester receipt says the legacy HTTP service was unreachable on ports 2023/3000 and explicitly used a fixture spec instead (`coordination/reports/tester.md:11858-11872`). No live request or test was run for this report.

The spec is based on `formatOperationResponse(op)` and the public routes that pass it an `Operation` row. A test harness must seed or control that row/worker outcome, then assert the HTTP response; request input alone cannot prescribe a worker's result.

## Route and request setup

The mounted handler and registry identify legacy ingest as `POST /api/v1/docs/ingest` (`app/api/v1/docs/ingest/route.ts:1-6`, `lib/endpoints/registry.ts:70-80`). `next.config.mjs` has no rewrite. The older e2e helper builds `/api/v1/ingest` (`tests/e2e/utils.ts:4,26`) and the old `ingest.e2e.test.ts` uses that path (`:10,26`); that URI has no matching route in the current route tree. The requests below use the mounted `/docs/ingest` path.

Use these common headers for legacy submission:

```http
x-api-key: dg_test_key_e2e_12345
Accept: application/json
```

That key is the e2e fixture key (`tests/e2e/setup.ts:15-17`). Do not send `x-api-key-id`, `x-user-id`, or `x-user-role` as caller assertions. Let the multipart client set its own `Content-Type` boundary. `runEndpoint` reads `req.formData()`, accepts `file` or `files[]`, and reads `output_format` and `?sync=true` (`lib/endpoints/runner.ts:84,226-229`, `:36-53`).

Common formatter read request after a fixture operation exists:

```http
GET /api/v1/operations/{operationId}
x-api-key: dg_test_key_e2e_12345
Accept: application/json
```

Predicted status is **200** for an existing, non-deleted fixture row; the route returns `NextResponse.json(formatOperationResponse(op))` (`app/api/v1/operations/[id]/route.ts:14-37`). Missing/deleted ID predicts 404 (`:22-26`).

The `x-api-key` header here matches the e2e request convention; this GET fixture is only a response-shape exercise, not an auth assertion. The route's conditional check reads `x-api-key-id` (`operations/[id]/route.ts:29-34`), while middleware strips caller-supplied identity headers on `/api/v1/*` (`middleware.ts:32-52`).

The async submission response includes `Operation-Location: /api/v1/operations/{id}` and predicts 202; sync requests predict 200. Both response bodies pass the returned `Operation` through the same formatter (`lib/endpoints/runner.ts:256-277`). Sync mode waits for the worker and reloads the row before formatting (`lib/pipelines/submit.ts:369-392`).

## Legacy response assertion schema

In the table, “decoded JSON” means `safeParseJson`: malformed/absent JSON gets the stated fallback, but a valid JSON literal can decode to any JSON value (`lib/pipelines/format.ts:10-15`). Dates are `Date` inputs in the Drizzle `Operation` model and serialize as JSON timestamp strings (`lib/db/schema.ts:40-41`).

| Fixture | Response key | Predicted JSON type / presence / nullability | Prediction source |
|---|---|---|---|
| A–D | `name` | Required string, `operations/{id}` | `lib/pipelines/format.ts:20-22` |
| A–D | `done` | Required boolean, copied from row | `format.ts:20-22`; schema default false/not-null: `lib/db/schema.ts:15` |
| A–D | `metadata.state` | Required string, copied from row | `format.ts:23-25`; schema default RUNNING/not-null: `schema.ts:16` |
| A–D | `metadata.pipeline` | Required string array for the normal stored pipeline; malformed/absent `pipelineJson` falls back to `[]` | `format.ts:17-18,23-26` |
| A–D | `metadata.current_step` | Required integer, non-null | `format.ts:23-27`; schema default 0/not-null: `schema.ts:21` |
| A–D | `metadata.progress_percent` | Required integer, non-null | `format.ts:23-28`; schema default 0/not-null: `schema.ts:17` |
| A–D | `metadata.progress_message` | Required key; string or JSON `null` | `format.ts:23-29`; nullable DB column: `schema.ts:18` |
| A–D | `metadata.create_time` | Required JSON timestamp string | `format.ts:23-30`; non-null Date input: `schema.ts:40` |
| A–D | `metadata.update_time` | Required JSON timestamp string | `format.ts:23-31`; non-null Date input: `schema.ts:41` |
| A–D | `metadata.pipeline_steps` | Required decoded JSON value; fallback `[]` (normally an array) | `format.ts:23-32` |
| A, D | `result.output_format` | Required string on success | `format.ts:35-38`; column is string/not-null: `schema.ts:24` |
| A, D | `result.content` | Required key on success; string or JSON `null` | `format.ts:35-39`; nullable column: `schema.ts:25` |
| A, D | `result.extracted_data` | Required decoded JSON value or `null`; absent/malformed storage falls back to `null` | `format.ts:35-40`; nullable column: `schema.ts:27` |
| A, D | `result.pipeline_steps` | Required decoded JSON value; fallback `[]` (normally an array) | `format.ts:35-41` |
| A, D | `result.usage.input_tokens` | Required number, non-null | `format.ts:41-48`; column default 0/not-null: `schema.ts:29` |
| A, D | `result.usage.output_tokens` | Required number, non-null | `format.ts:41-48`; column default 0/not-null: `schema.ts:30` |
| A, D | `result.usage.pages_processed` | Required number, non-null | `format.ts:41-48`; column default 0/not-null: `schema.ts:31` |
| A, D | `result.usage.model_used` | Required key; string or JSON `null` | `format.ts:41-48`; nullable column: `schema.ts:32` |
| A, D | `result.usage.cost_usd` | Required number, non-null | `format.ts:41-48`; column default 0/not-null: `schema.ts:33` |
| A, D | `result.usage.breakdown` | Required decoded JSON value; fallback `[]` (normally an array) | `format.ts:41-49`; nullable source: `schema.ts:34` |
| A, D | `result.download_url` | Required string on success, regardless of content size | `format.ts:35-50` |
| B | `result`, `error` | Both absent while not done; formatter adds neither block | `format.ts:35,53` |
| C | `error.code` | Required key when done + FAILED; string or JSON `null` | `format.ts:53-58`; nullable source: `schema.ts:37` |
| C | `error.message` | Required key when done + FAILED; string or JSON `null` | `format.ts:53-58`; nullable source: `schema.ts:38` |
| C | `error.failed_step` | Required key when done + FAILED; integer or JSON `null` | `format.ts:53-58`; nullable source: `schema.ts:22` |
| C | `result` | Present if `stepsResultJson` is truthy; contains partial `pipeline_steps` and partial `usage` with input/output/cost/breakdown only | `format.ts:59-68` |

`result` is present only for `done && state === 'SUCCEEDED'`; `error` only for `done && state === 'FAILED'` (`format.ts:35-68`). The failure result is conditional on truthy `stepsResultJson`; this spec seeds/produces the string `[]`, which is truthy and yields a partial result block (`:59-68`).

## Fixture classes A–D

Fixtures use a controlled processor/worker fixture or seeded operation row. The multipart request creates the operation; it does not provide `outputContent`, usage totals, failure fields, or progress values directly. Those are deterministic fixture setup values.

### A. Success with full result

**Request:**

```http
POST /api/v1/docs/ingest?sync=true
x-api-key: dg_test_key_e2e_12345
Accept: application/json
Content-Type: multipart/form-data; boundary=<client-generated>

mode=parse
output_format=md
language=vi
files[]=<fixture.pdf; application/pdf>
```

Configure the fixture profile for `ingest:parse` to use one `fixture-processor`; have it return content `# COMP05 fixture\n`, extracted data `{"invoice_id":"FIX-001"}`, input/output tokens `17/9`, pages `1`, model `fixture-model`, and cost `$0.004`. The corresponding step result is `{step:0, processor:"fixture-processor", output_format:"md", content_preview:"# COMP05 fixture\\n", extracted_data:{invoice_id:"FIX-001"}}`; usage breakdown is `[{processor:"fixture-processor",input_tokens:17,output_tokens:9,cost_usd:0.004}]`. Keep mock completion inside the sync wait. Predicted HTTP status: **200**; response is the formatted final operation (`runner.ts:256-277`; sync reload: `submit.ts:369-385`).

**Assertions:**

```text
done === true
metadata.state === "SUCCEEDED"
metadata.pipeline deep-equals ["fixture-processor"]
metadata.current_step === 0
metadata.progress_percent === 100                 # success finalization: engine.ts:397-414
metadata.progress_message === null
metadata.pipeline_steps deep-equals the single fixture step above
result exists
result.output_format === "md"
result.content === "# COMP05 fixture\n"
result.extracted_data deep-equals {"invoice_id":"FIX-001"}
result.pipeline_steps deep-equals the single fixture step above
result.usage deep-equals {input_tokens:17,output_tokens:9,pages_processed:1,model_used:"fixture-model",cost_usd:0.004,breakdown:[{processor:"fixture-processor",input_tokens:17,output_tokens:9,cost_usd:0.004}]}
typeof result.download_url === "string"
error is absent
```

Request-derived `output_format=md` is preserved from runner to row (`runner.ts:226-246`, `lib/pipelines/submit.ts:306-313`) and copied by the formatter (`format.ts:35-49`).

### B. In-flight metadata

**Request:** use the same multipart body/headers as A, without `?sync=true`:

```http
POST /api/v1/docs/ingest
x-api-key: dg_test_key_e2e_12345
Accept: application/json
Content-Type: multipart/form-data; boundary=<client-generated>

mode=parse
output_format=md
language=vi
files[]=<fixture.pdf; application/pdf>
```

Hold the first processor in the controlled worker. Predicted submit status: **202**, with `Operation-Location`; the returned initial row is not done. Poll the location using:

```http
GET /api/v1/operations/{operationId}
x-api-key: dg_test_key_e2e_12345
Accept: application/json
```

Predicted GET status: **200**. Assert `done === false`, state is the persisted in-flight state, metadata exists, and `result` and `error` are absent (`format.ts:20-32,35-58`; GET handler `app/api/v1/operations/[id]/route.ts:14-37`).

On a held first processor, legacy can report `metadata.progress_percent === 0`: it initializes to zero (`lib/pipelines/submit.ts:309-313`) and sets `round(i / pipeline.length * 100)` before invoking a step (`lib/pipelines/engine.ts:282-298`). This is the legacy fixture prediction only. The corresponding rework prediction of zero is explicitly **SYNTHETIC / GAP**, not a parity assertion; see S1 below.

### C. Failure envelope

**Request:** use A's multipart body with a fixture profile overriding `ingest:parse` to two controlled processors. The first returns known content and usage (`input=17`, `output=9`, `cost_usd=0.004`); the second throws `fixture processor 2 failed`. Add `?sync=true`:

```http
POST /api/v1/docs/ingest?sync=true
x-api-key: dg_test_key_e2e_12345
Accept: application/json
Content-Type: multipart/form-data; boundary=<client-generated>

mode=parse
output_format=md
language=vi
files[]=<fixture.pdf; application/pdf>
```

The fixture fails after operation admission, not request validation. The sync wait catches the worker failure and reloads the failed operation (`submit.ts:376-385`); `runEndpoint` still selects HTTP status **200** for sync submissions (`runner.ts:256-277`).

**Assertions:**

```text
done === true
metadata.state === "FAILED"
error.code === "PIPELINE_ERROR"               # engine.ts:454-465
error.message === "fixture processor 2 failed" # deterministic thrown fixture message
error.failed_step === 1                        # one completed step in stepsResult
result exists because stepsResultJson contains the first completed step
result.pipeline_steps equals the first-step fixture result
result.usage.input_tokens === 17
result.usage.output_tokens === 9
result.usage.cost_usd === 0.004
result.usage.breakdown equals first-step fixture breakdown
result.usage has no pages_processed or model_used
```

The engine assigns `failedAtStep = stepsResult.length`, `errorCode = 'PIPELINE_ERROR'`, the thrown message, and counters accumulated after step 1 (`lib/pipelines/engine.ts:365-394,450-465`); the formatter determines presence and shape (`lib/pipelines/format.ts:53-68`).

### D. Large result / attempted content-download split

**Request:** same controlled success as A, but make the fixture processor return a fixed **2 MiB** `outputContent` string. This is merely the test payload size, **not** an inferred or proposed threshold.

```http
POST /api/v1/docs/ingest?sync=true
x-api-key: dg_test_key_e2e_12345
Accept: application/json
Content-Type: multipart/form-data; boundary=<client-generated>

mode=parse
output_format=md
files[]=<fixture.pdf; application/pdf>
```

Predicted POST status: **200**. Assert `typeof result.content === 'string'`, its value equals the entire 2 MiB fixture output, and `result.download_url` is a string. Then issue:

```http
GET /api/v1/operations/{operationId}/download
x-api-key: dg_test_key_e2e_12345
Accept: */*
```

Predicted download status: **200** for a successful row with `outputContent`; body equals the same fixture string. The route returns `op.outputContent` directly and selects content type from `outputFormat` (`app/api/v1/operations/[id]/download/route.ts:44-57`). The formatter always includes both `result.content` and `download_url` on success (`format.ts:35-50`).

**There is no `maxInlineBytes` decision point in the reviewed formatter or legacy download route.** Do not assert that the legacy response omits content or crosses to download-only mode at any size. The 2 MiB fixture tests absence of a split; it does not define a cutoff.

## Rework requests for all MISSING / SYNTHETIC groups

The public rework submit request used to obtain an operation is JSON, not legacy multipart:

```http
POST /api/v1/businesses/{registeredBusinessId}/actions/{registeredAction}
x-api-key: <valid tenant API key>
Accept: application/json
Content-Type: application/json

{"input":{"fixture":true}}
```

`SubmissionSchema` requires the `input` object and permits optional `sourceUrl`, `artifacts`, `output`, `callback`, and `clientReference` (`du-rework/packages/contracts/src/operations.ts:282-294`). The route resolves `x-api-key` server-side and returns 202 for a new operation (`services/orchestrator/src/server.ts:1730-1763`). For each row below, operation reads use `GET /api/v1/operations/{id}`; result reads use `GET /api/v1/operations/{id}/result`, both with `x-api-key` and `Accept: application/json`. Existing operation detail predicts 200 (`server.ts:1813-1841`); `/result` predicts 200 only on SUCCEEDED, 409 otherwise (`server.ts:1926-1937`).

### Six MISSING groups

| Group / legacy key(s) | Rework request needed to try to observe it | Predicted rework result and current deciding source |
|---|---|---|
| **M1 `metadata.pipeline`** | Submit JSON as above; then `GET /api/v1/operations/{id}`. | **No such key.** `OperationView` contains business/action/state/progress/links, not the processor list (`packages/contracts/src/operations.ts:129-146`); `toOperationView` emits that view (`modules/operations/facade.ts:32-50`). `action` is not the legacy ordered `pipeline`. |
| **M2 `metadata.current_step`** | During RUNNING, `GET /api/v1/operations/{id}`. A worker checkpoint request is `PUT /api/runtime/v1/tasks/{taskId}/steps/{stepKey}` with `Authorization: Bearer <worker-runtime-token>`, JSON `{"leaseEpoch":1,"inputHash":"fixture-hash","outputRef":"fixture-ref","status":"SUCCEEDED"}`. | **No current numeric step key.** Checkpoints persist step key/generation/ref, not legacy numeric position (`modules/runtime/runtime.ts:424-480`); the view exposes no step number (`modules/operations/facade.ts:32-50`). |
| **M3 `metadata.pipeline_steps`, `result.pipeline_steps`** | `GET /api/v1/operations/{id}` while running and `GET /api/v1/operations/{id}/result` after success. | **Neither response has the legacy step-result arrays.** Checkpoint rows hold identity/status/opaque refs (`modules/runtime/runtime.ts:424-480`); result emits `data`, `artifacts`, `usage`, and `warnings` (`server.ts:1979-1984`). The worker child view likewise contains task refs/status rather than pipeline step output (`modules/runtime/runtime.ts:875-897`). |
| **M4 `result.content`, `result.extracted_data`** | After success, `GET /api/v1/operations/{id}/result`. If `artifacts[]` contains an output, follow its `download` with `GET /api/v1/artifacts/{artifactId}/download`. | `/result` predicts **200** with `data: {resultRef: ...}` when one exists and artifact descriptors; artifact download predicts raw bytes. No response projects inline `result.content` or `extracted_data`. The server labels `resultRef` opaque and returns it verbatim (`server.ts:1920-1924,1971-1984`); bytes are a separate download (`:2003-2083`). `{resultRef}` is not an assertion substitute for content. |
| **M5 `result.usage.pages_processed`, `model_used`, `breakdown`** | Ingest a real usage event with `POST /api/runtime/v1/usage-events`, `Authorization: Bearer <usage-token>`, `Content-Type: application/json`, for example `{"eventId":"fixture-1","invocationId":"invoke-1","operationId":"<operation-uuid>","taskId":"<task-uuid>","units":{"inputTokens":5,"outputTokens":3,"pages":2},"costMicrousd":12,"measurement":"measured","occurredAt":"2026-10-01T00:00:00Z"}`; substitute the fixture's real UUIDs, then GET `/api/v1/operations/{id}/result`. | Ingest predicts 200 when authorized (`server.ts:1243-1253`). The schema accepts `units.pages` but has no model/breakdown fields (`packages/contracts/src/runtime.ts:405-419`). `/result` usage projection predicts token/cost totals and measurement only; it never sums pages (`modules/usage/usage.ts:357-376`) and does not return model or per-step breakdown. |
| **M6 `error.code`, `error.message`, `error.failed_step`** | On a running task, `POST /api/runtime/v1/tasks/{taskId}/fail`, `Authorization: Bearer <worker-runtime-token>`, JSON `{"leaseEpoch":1,"errorCode":"FIXTURE_FAILURE","retryable":false,"detail":"fixture processor failed"}`; then `GET /api/v1/operations/{id}` and `/result`. | Fail report predicts 200 ack (`server.ts:1658-1662`). Detail view predicts 200 but omits an `error` field (`modules/operations/facade.ts:32-50`); `/result` predicts 409 for FAILED (`server.ts:1931-1937`). Runtime persists `error_code`, but not detail/message or numeric failed step (`modules/runtime/runtime.ts:658-675`). The input schema's optional `detail` does not make it a persisted/public field (`packages/contracts/src/runtime.ts:170-176`). |

### Three SYNTHETIC groups

| Group / legacy key(s) | Rework request that exercises the current path | Predicted synthetic output / line that decides it is not parity |
|---|---|---|
| **S1 `metadata.progress_percent`, `metadata.progress_message`** | During a leased task, `POST /api/runtime/v1/tasks/{taskId}/progress`, `Authorization: Bearer <worker-runtime-token>`, JSON `{"leaseEpoch":1,"percent":42,"message":"fixture stage"}`; then `GET /api/v1/operations/{id}`. | Progress POST predicts 200 `{}` (`server.ts:1636-1643`). Detail predicts `progress.percent: 0` and `progress.message` equal to operation state, not the submitted report (`modules/operations/facade.ts:45`). Runtime does not persist the report (`modules/runtime/runtime.ts:483-492`). **Those are synthetic predictions / GAP assertions. Do not assert that 0 is expected parity for a RUNNING operation.** |
| **S2 `result.output_format`** | Submit JSON such as `{"input":{"output_format":"md"}}`; after success, `GET /api/v1/operations/{id}/result`. A worker can declare `mimeType` when requesting an output artifact (`POST /api/runtime/v1/tasks/{taskId}/artifacts`, JSON fields `leaseEpoch`, `purpose:"output"`, `mimeType`, `fileName`, `sizeBytes`; schema `packages/contracts/src/runtime.ts:197-204`). | `/result` predicts artifact `mimeType`, not `output_format` (`server.ts:1966-1984`). `ResultEnvelopeSchema` has no `output_format` key (`packages/contracts/src/operations.ts:171-177`). The adapter's default `json` is therefore synthetic if no real legacy format value is supplied (`compat/legacy-action-router.ts:295-299`). |
| **S3 `result.download_url`** | After success, `GET /api/v1/operations/{id}/result`; follow the returned per-artifact `download` with `GET /api/v1/artifacts/{artifactId}/download`. Also try the legacy-style `GET /api/v1/operations/{id}/download` only as a negative route assertion. | Rework `/result` predicts only artifact-specific download URLs (`server.ts:1971-1978`). The artifact route matches `/api/v1/artifacts/{id}/download` (`:2003-2011`); no operation-level download matcher exists, so `/operations/{id}/download` falls through to 404 (`server.ts:2746`). The isolated action adapter's unconditional operation URL (`compat/legacy-action-router.ts:315-331`) is **synthetic and points to no rework handler**. |

The FULL usage rows also require an explicit pending assertion on rework. With zero ingested events, `GET /result` predicts numeric zeros **and** `measurement: "pending"` (`modules/usage/usage.ts:357-376`). Any compat assertion that drops that marker and treats those zeros as final legacy usage is a **synthetic gap**, not parity.

## Non-observation and execution limits

- This artifact is the **spec** option; no response values above are live observations.
- Fixture expectations are traced to `formatOperationResponse` and the listed input row columns. A future harness should assert each class without turning predictions into receipts.
- The 2 MiB D fixture is a chosen test payload only; no `maxInlineBytes` threshold is stated or inferred.
- Read-only: no source edits, tests, gate ticks, or contract freeze.
