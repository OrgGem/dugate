# COMP-01 — Characterization matrix: legacy `app/api/v1` + `lib/` (read-only)

> **Dispatch** `task_comp01_matrix` (COMP-01a/01b/01c). **Date** 2026-10-01.
> **Method: static reading of source only.** No request was issued, no server started, no fixture executed.
> Every "behaviour" below is a **code-read inference from the cited `file:line`**, not an observed HTTP response.
> To turn any row into a real characterization fixture it must be executed against a live legacy instance.
> **Limits honoured:** read-only on `app/` + `lib/` + `du-rework/`; **no source edited**; **no gate ticked**; **no contract frozen** (COMP-02 waits COMP-00).
> Baseline doc audited: `du-rework/docs/14-reference-compatibility.md` section "Legacy API spec (from code)".

## 0. How to read this

- **Registry is the source of truth for the catalog.** `lib/endpoints/registry.ts` is CRLF, 427 lines.
- `required` appears **only** in the type declaration (`registry.ts:10`). `defaultLocked` appears **only** at `registry.ts:14`. No registry entry sets either.
- Consequence for the required/optional column: **every parameter is optional**. There is no required-field enforcement anywhere in the submit path.

## 1. COMP-01a — Six core routes + 31 sub-cases

### 1.1 Route table (filesystem is the wire)

| Route | Route file | Handler | Registry `route` | L1 comment |
|---|---|---|---|---|
| `POST /api/v1/docs/ingest` | `app/api/v1/docs/ingest/route.ts:5-7` | `runEndpoint(ingest)` | `registry.ts:73` | `// app/api/v1/ingest/route.ts` **wrong** |
| `POST /api/v1/docs/extract` | `app/api/v1/docs/extract/route.ts:5-7` | `runEndpoint(extract)` | `registry.ts:115` | `// app/api/v1/extract/route.ts` **wrong** |
| `POST /api/v1/docs/analyze` | `app/api/v1/docs/analyze/route.ts:5-7` | `runEndpoint(analyze)` | `registry.ts:174` | `// app/api/v1/analyze/route.ts` **wrong** |
| `POST /api/v1/docs/transform` | `app/api/v1/docs/transform/route.ts:5-7` | `runEndpoint(transform)` | `registry.ts:241` | `// app/api/v1/transform/route.ts` **wrong** |
| `POST /api/v1/docs/generate` | `app/api/v1/docs/generate/route.ts:5-7` | `runEndpoint(generate)` | `registry.ts:287` | `// app/api/v1/generate/route.ts` **wrong** |
| `POST /api/v1/docs/compare` | `app/api/v1/docs/compare/route.ts:5-7` | `runEndpoint(compare)` | `registry.ts:341` | `// app/api/v1/compare/route.ts` **wrong** |

All six files are byte-identical 8-line delegates: import `runEndpoint`, one `POST`, one return. **None** has route-specific logic. All six route into the same facade `lib/endpoints/runner.ts:58`.

### 1.2 Discriminator

| Service | Discriminator | Registry line | Invalid value |
|---|---|---|---|
| ingest | `mode` | `registry.ts:74` | 400 `Invalid Parameter` + valid list (`runner.ts:113-123`) |
| extract | `type` | `registry.ts:116` | same |
| analyze | `task` | `registry.ts:175` | same |
| transform | `action` | `registry.ts:242` | same |
| generate | `task` | `registry.ts:288` | same |
| compare | `mode` | `registry.ts:342` | same |
| workflows | `process` | `registry.ts:377` | 404 `Workflow Not Found` (`workflows/route.ts:26-28`) |

Resolution is `subCases[value] ?? subCases[_default]` (`runner.ts:114`). **No `_default` exists**, so an empty or absent discriminator always 400s. Lookup happens **before** file normalisation, so a bad discriminator wins over a missing file.

### 1.3 The 34 sub-cases (31 core + 3 workflow)

`params` = parameters actually **attached** to that sub-case. `conns` = business action.

| Service | Sub-case | Registry key line | params attached | conns (business action) |
|---|---|---|---|---|
| `ingest` | `parse` | `registry.ts:76` | output_format, language | ext-doc-layout |
| `ingest` | `ocr` | `registry.ts:84` | language | ext-doc-layout |
| `ingest` | `digitize` | `registry.ts:92` | (none) | ext-vision-reader |
| `ingest` | `split` | `registry.ts:100` | pages | ext-pdf-tools |
| `extract` | `invoice` | `registry.ts:118` | (none) | ext-data-extractor |
| `extract` | `contract` | `registry.ts:126` | (none) | ext-data-extractor |
| `extract` | `id-card` | `registry.ts:134` | (none) | ext-data-extractor |
| `extract` | `receipt` | `registry.ts:142` | (none) | ext-data-extractor |
| `extract` | `table` | `registry.ts:150` | (none) | ext-data-extractor |
| `extract` | `custom` | `registry.ts:158` | fields, schema | ext-data-extractor |
| `analyze` | `classify` | `registry.ts:177` | categories | ext-classifier |
| `analyze` | `sentiment` | `registry.ts:186` | (none) | ext-sentiment |
| `analyze` | `compliance` | `registry.ts:194` | criteria | ext-compliance |
| `analyze` | `fact-check` | `registry.ts:203` | reference_data, extract_fields | ext-data-extractor, ext-fact-verifier |
| `analyze` | `quality` | `registry.ts:212` | criteria | ext-quality-eval |
| `analyze` | `risk` | `registry.ts:220` | (none) | ext-quality-eval |
| `analyze` | `summarize-eval` | `registry.ts:228` | (none) | ext-content-gen |
| `transform` | `convert` | `registry.ts:244` | output_format | ext-doc-layout |
| `transform` | `translate` | `registry.ts:252` | (none) | ext-translator |
| `transform` | `rewrite` | `registry.ts:258` | style, tone | ext-rewriter |
| `transform` | `redact` | `registry.ts:266` | (none) | ext-redactor |
| `transform` | `template` | `registry.ts:272` | template | ext-redactor |
| `generate` | `summary` | `registry.ts:290` | (none) | ext-content-gen |
| `generate` | `outline` | `registry.ts:296` | format | ext-content-gen |
| `generate` | `report` | `registry.ts:304` | (none) | ext-content-gen |
| `generate` | `email` | `registry.ts:310` | tone | ext-content-gen |
| `generate` | `minutes` | `registry.ts:318` | format | ext-content-gen |
| `generate` | `qa` | `registry.ts:326` | questions | ext-qa-engine |
| `compare` | `diff` | `registry.ts:344` | output_format | ext-comparator |
| `compare` | `semantic` | `registry.ts:352` | focus | ext-comparator |
| `compare` | `version` | `registry.ts:361` | output_format | ext-comparator |
| `workflows` | `disbursement` | `registry.ts:379` | reference_data | (none) + isWorkflow |
| `workflows` | `lc-checker` | `registry.ts:388` | (none) | (none) + isWorkflow |
| `workflows` | `doc-compare` | `registry.ts:395` | (none) | (none) + isWorkflow |

Per-service core counts: ingest **4**, extract **6**, analyze **7**, transform **5**, generate **6**, compare **3** = **31**. Plus **3** workflows = **34**. 15 distinct connection slugs.

### 1.4 Required vs optional — the honest answer

- `ParamSchema.required` is **declared** (`registry.ts:10`) and **never set**.
- `mergeParameters` (`lib/endpoints/profile-resolver.ts:53-94`) never consults `required`; it only enforces `isLocked`.
- **Therefore every sub-case parameter is optional at the API boundary.** A caller omitting `criteria` on `analyze:compliance` still gets a 202; the failure surfaces later in the worker.

### 1.5 Seven declared-but-unattached entries — six of them are silently dropped params

`PARAMS` (`registry.ts:39-63`) declares 22 parameters, and only **15** are attached to a sub-case, so 22 − 15 = **7** entries are declared-but-unattached. **Seven is the arithmetic; six is the number of parameters a client can actually lose.** The seventh, `type`, is the extract discriminator rather than a sub-case parameter — see the last row.

| Declared | Its natural sub-case | Net effect on the wire |
|---|---|---|
| `target_language` (`:53`) | `transform:translate` has `parameters: {}` | client value **silently dropped** |
| `redact_patterns` (`:57`) | `transform:redact` has `parameters: {}` | **silently dropped** |
| `max_words` (`:59`) | none | **silently dropped** |
| `audience` (`:61`) | none | **silently dropped** |
| `focus_areas` (`:52`) | none | **silently dropped** |
| `glossary` (`:55`) | none | **silently dropped** |
| `type` (`:43`) | — | **not a dropped param**: it is the extract **discriminator**, consumed at `runner.ts:113` before `mergeParameters` ever runs |

Silently dropped is precise and load-bearing: `mergeParameters` iterates `subCaseParameters` union `dbParams` (`profile-resolver.ts:65-68`) and reads **only** those keys (`:74-89`). A form field outside that set is never read and never rejected — the request succeeds and the value vanishes. Unknown fields are never rejected at all.

### 1.6 Locking

- Lock resolution: `dbParams[key].isLocked ?? schema.defaultLocked ?? false` (`profile-resolver.ts:72`).
- A locked field present in the form returns **400** (not 403), `type: https://dugate.vn/errors/forbidden-field` (`profile-resolver.ts:76-87`).
- `GET /api/v1/services` filters `defaultLocked` params out of `clientParameters` (`services/route.ts:53-58`); swagger drops them too.
- **But no registry parameter ever sets `defaultLocked`**, so that filter currently removes nothing. The mechanism is wired and advertised, and its input is always empty.

### 1.7 File and URL policy

| Concern | Behaviour | Fixture |
|---|---|---|
| accepted field names | `files[]` (multi), `source_file`, `target_file`, `file` (single) — all filtered `size > 0` | `runner.ts:36-56` |
| ordering | `files[]`, `source_file`, `target_file`, `file` | `runner.ts:39-52` |
| zero files | allowed on the 6 core routes; **required** on `/docs/workflows` | `runner.ts:126`; `workflows/route.ts:31-34` |
| `file_urls` transport | JSON **string** in the form, must be an array | `runner.ts:129-138` |
| `file_urls` cap | `MAX_FILE_URL_ENTRIES = 20` | `file-url-downloader.ts:40`; enforced `runner.ts:141-142` |
| `file_urls` entry shape | non-empty string `url`; `filename`/`mime_type` optional | `runner.ts:145-149` |
| `file_urls` URL check | `new URL(entry.url)` — **parseability only** | `runner.ts:150-152` |
| SSRF / scheme safety | **not** in the runner; deferred to `assertSafeUrl` at download | `file-url-downloader.ts:7` |
| extension allowlist | from the profile: `profileEndpoint.allowedFileExtensions` | `runner.ts:232,239` |
| remote auth | `getFileUrlAuthConfig(profileEndpoint)` | `runner.ts:231` |

**Characterization note:** a `file_urls` entry such as `file:///etc/passwd` passes the runner (parseable) and is rejected only later, at download, by `assertSafeUrl`. The submit-time check is weaker than the baseline doc table implies.

### 1.8 Output vs business action

- **Output** = `output_format` form field, default `json` (`runner.ts:226`; default at `registry.ts:40`), allowed `md | json | html | csv`; echoed in `result.output_format` (`format.ts:37`).
- **Business action** = the connection chain. `parseConnectionSteps` resolves `connectionsOverride` (profile) over the sub-case `connections` (`runner.ts:210-221`), then emits one pipeline step per connection.
- A profile override can therefore **replace the sub-case business action entirely**; the registry chain is only the default.
- **Extract presets alter the input, not the registry.** `runner.ts:200-207` injects `fields`/`schema` from `EXTRACT_PRESETS[discriminator]` when absent. Presets exist for **6** keys (`presets.ts:12,17,22,27,32,37`): `invoice, contract, id-card, receipt, po, payslip`.
- **Two of those six are unreachable**: `po` and `payslip` are not registry sub-cases, so `subCases[value]` 400s before a preset is consulted. Conversely `table` and `custom` are registry sub-cases with **no** preset and get no injected `fields`.

## 2. COMP-01b — Workflows, schema, services, billing

### 2.1 `POST /api/v1/docs/workflows`

| Aspect | Value | Fixture |
|---|---|---|
| handler | `POST` at L15 | `workflows/route.ts:15` |
| L1 comment | `// app/api/v1/workflows/route.ts` — **missing `docs/`** | `:1` |
| discriminator | `process`; 400 `Missing Parameter` if absent | `:19-23` |
| unknown process | 404 `Workflow Not Found` | `:26-28` |
| files | **required**, at least 1, else 400 `Missing Files` | `:31-34` |
| variables | only sub-case params, and only when **truthy** — an empty-string param is dropped | `:37-41` |
| placeholder | hardcoded `ext-classifier`, ignored by the workflow engine | `:45` |
| endpointSlug | `workflows:<process>` (2 segments) | `:48` |
| identity | `apiKeyId` read from a **form field**; accepts internal UUID or raw key via sha256 | `:49-75` |
| identity fallback | oldest `role = ADMIN` key | `:77-86` |
| response | **not** `formatOperationResponse`; hand-built 202 `{name, done:false, metadata:{state:"RUNNING", workflow, progress_percent:0, progress_message}}` | `:99-116` |

### 2.2 `POST /api/v1/docs/workflows/schema`

| Aspect | Value | Fixture |
|---|---|---|
| handler | `POST` at L15 | `schema/route.ts:15` |
| L1 comment | `// app/api/v1/docs/workflows/schema/route.ts` — **correct**, unlike 2.1 | `:1` |
| discriminator | `schemaSlug`; 400 `Missing Parameter` | `:19-22` |
| schema lookup | DB `appSettings` key `wb_schema:<slug>`; 404 `Schema Not Found` | `:25-28` |
| schema validation | `validateSchema`; 400 `Invalid Schema` | `:31-34` |
| files | **optional** — text-only schemas allowed | `:36-37` |
| business input | `input` form field, JSON string; 400 `Invalid Input` on parse failure | `:40-48` |
| endpointSlug | `workflows:schema:<slug>` (**3** segments) | `:56` |
| identity | same form-field `apiKeyId` + ADMIN fallback | `:59-79` |
| response | same hand-built 202 shape as 2.1 | `:95-110` |

**Asymmetry worth pinning:** `/docs/workflows` requires at least one file; `/docs/workflows/schema` does not. The baseline doc lists both routes but never states the difference.

### 2.3 `GET /api/v1/services`

Handler `:8`; 401 when `x-api-key-id` absent (`:12-22`, problem+json). Body `{status, message, services[]}`; each service `{serviceId, serviceName, discriminatorKey, subCases[]}`; each sub-case `{id, displayName, description, clientParameters}` (`:44-66`). A generic lock on the service slug disables all its sub-cases (`:38-40`).

### 2.4 `GET /api/v1/billing/balance`

Handler `:17`; 401 `:19-21`. `balance = spendingLimit - totalUsed` when `spendingLimit > 0`, else `null` (`:35-38`). Body `{object, api_key_id, api_key_name, currency, details:{spending_limit, total_used, balance}, updated_at}` (`:40-49`). `updated_at` is `new Date().toISOString()` — **request time**, not a stored key timestamp.

### 2.5 `GET /api/v1/billing/usage`

Handler `:24`; 401 `:26-28`. `start_date` / `end_date`; defaults to the last 30 days; `end_date` gets `T23:59:59Z` appended; invalid date gives 400 (`:35-42`). Counts only `state = SUCCEEDED AND done = true` inside the range (`:52-53`), grouped by `modelUsed ?? unknown`. Body `{object, start_date, end_date, total_cost_usd, total_input_tokens, total_output_tokens, total_operations, usage[]}` (`:87-95`).

## 3. COMP-01c — Lifecycle, pagination, state map

### 3.1 Inventory: 16 route files under `app/api/v1`

| # | Method + path | Route file | Handler line |
|---|---|---|---|
| 1 | `POST /api/v1/docs/ingest` | `docs/ingest/route.ts` | `:5` |
| 2 | `POST /api/v1/docs/extract` | `docs/extract/route.ts` | `:5` |
| 3 | `POST /api/v1/docs/analyze` | `docs/analyze/route.ts` | `:5` |
| 4 | `POST /api/v1/docs/transform` | `docs/transform/route.ts` | `:5` |
| 5 | `POST /api/v1/docs/generate` | `docs/generate/route.ts` | `:5` |
| 6 | `POST /api/v1/docs/compare` | `docs/compare/route.ts` | `:5` |
| 7 | `POST /api/v1/docs/workflows` | `docs/workflows/route.ts` | `:15` |
| 8 | `POST /api/v1/docs/workflows/schema` | `docs/workflows/schema/route.ts` | `:15` |
| 9 | `GET /api/v1/operations` | `operations/route.ts` | `:29` |
| 10 | `GET /api/v1/operations/{id}` | `operations/[id]/route.ts` | `:14` |
| 11 | `DELETE /api/v1/operations/{id}` | `operations/[id]/route.ts` | `:40` |
| 12 | `POST /api/v1/operations/{id}/cancel` | `operations/[id]/cancel/route.ts` | `:10` |
| 13 | `POST /api/v1/operations/{id}/resume` | `operations/[id]/resume/route.ts` | `:20` |
| 14 | `GET /api/v1/operations/{id}/download` | `operations/[id]/download/route.ts` | `:15` |
| 15 | `GET /api/v1/services` | `services/route.ts` | `:8` |
| 16 | `GET /api/v1/billing/balance` | `billing/balance/route.ts` | `:17` |
| 17 | `GET /api/v1/billing/usage` | `billing/usage/route.ts` | `:24` |

(17 handlers across 16 files; `[id]/route.ts` exports two.) There is **no** artifacts route and **no** DELETE at the collection level.

### 3.2 Per-route behaviour and fencing

| Route | Success | Errors | Tenant fence | Notes |
|---|---|---|---|---|
| `GET /operations` | 200 list + `next_page_token` | 400 invalid `state` filter | **conditional** `if (apiKeyId)` `:35-38` | no fence at all when the header is absent |
| `GET /operations/{id}` | 200 `formatOperationResponse` | 404 incl. soft-deleted | **conditional** `:29-35` | 404 body adds `requested_id` |
| `DELETE /operations/{id}` | **204**, no body | 404 | **conditional** `:54-60` | soft delete: sets `deletedAt` only |
| `POST /cancel` | 200 `formatOperationResponse` | 404, 403, **409 if `done`** `:32-37` | **conditional** `:24-30` | writes `done=true, state=CANCELLED` `:39-43`; no worker fence, the worker may still be running |
| `POST /resume` | 200 `{success:true, message:"Resumed successfully"}` | 404, 400 unless `WAITING_USER_INPUT`, 500 | **NONE** | does **not** check `deletedAt` and does **not** check `done`; body `{step, extracted_data}` marks `is_human_edited` `:57-63` |
| `GET /download` | **200** raw stream, never 302 | 404, 403, **409 unless `done && SUCCEEDED`** | **conditional** `:29-35` | local backend validates path traversal `:63-72`; S3 via `backend.download` |
| `/docs/workflows` | 202 hand-built | 400, 404, 500 | **form field** + ADMIN fallback | `disableHistory:false` so polling works `:94` |
| `/docs/workflows/schema` | 202 hand-built | 400, 404, 500 | **form field** + ADMIN fallback | `disableHistory:false` `:87` |
| `GET /services` | 200 | 401, 500 | requires `x-api-key-id` | 401 is the fence |
| `GET /billing/balance` | 200 | 401, 404 | requires `x-api-key-id` | |
| `GET /billing/usage` | 200 | 401, 400 | requires `x-api-key-id` | |

The conditional fence is uniform in shape — `if (apiKeyId && op.apiKeyId !== apiKeyId)` — and uniformly defeatable, because `x-api-key-id` is deleted at the edge (`middleware.ts:36`). A caller presenting only `x-api-key` makes `apiKeyId` undefined and every one of those branches is skipped.

### 3.3 Pagination

| Aspect | Value | Fixture |
|---|---|---|
| `page_size` | `Math.min(parseInt(... ?? 20), 100)` | `operations/route.ts:31` |
| `page_token` | id of the **last item of the previous page**; resolved to its `createdAt` | `:32,58-64` |
| keyset predicate | `createdAt < cursorItem.createdAt` (strict `<`) | `:62` |
| ordering | `desc(createdAt)` | `:93` |
| fetch | `limit(pageSize + 1)`, `hasMore` from the overflow row | `:94-97` |
| next token | last returned item `id`, else `null` | `:98,129` |
| `filter` | CSV `state=...,processor=...`; `processor` is `ilike` on `pipelineJson` | `:42-56` |

**Two pagination observations from the code read.** (a) The keyset is a **timestamp** comparison, not a tuple of `(createdAt, id)`; two operations sharing a `createdAt` value can cause one to be skipped. (b) `page_size` is not validated: `page_size=abc` yields `NaN` into `limit(NaN + 1)`, and a negative value passes the `Math.min` untouched.

### 3.4 State map (what the code actually writes)

| State | Written by | Fixture |
|---|---|---|
| `RUNNING` | initial create; workflow start | `submit.ts:310`; `workflow-engine.ts:133`; column default `db/schema.ts:16` |
| `SUCCEEDED` | pipeline and workflow completion | `engine.ts:401,431`; `workflow-engine.ts:220` |
| `FAILED` | pipeline and workflow failure | `engine.ts:133,167,456,470`; `workflow-engine.ts:281` |
| `WAITING_USER_INPUT` | HITL wait | `workflow-engine.ts:257` |
| `CANCELLED` | cancel route only | `[id]/cancel/route.ts:41` |
| `PENDING` | **never written by legacy code** | only in the list filter allowlist, `operations/route.ts:40` |
| `ACCEPTED` | **never written to `operations`** | only a UI-adapter fallback, `app/workflow-builder/du-operation-adapter.ts:33,242` |

`operations.state` is a **free-text column** (`text("state").default("RUNNING").notNull()`, `lib/db/schema.ts:16`) — there is no enum or CHECK constraint, so the state map is a convention, not a schema guarantee.

Two gaps fall straight out of this. (a) `PENDING` is **filterable but unproducible**: `VALID_STATES` (`operations/route.ts:40`) accepts it while no legacy code path ever writes it. (b) `CANCELLED` and `WAITING_USER_INPUT` are producible but **not filterable** — they are absent from `VALID_STATES`, so filtering by them returns 400. A caller therefore cannot ask the list endpoint for cancelled operations.

### 3.5 Error-shape inventory (two conventions coexist)

| Convention | Routes |
|---|---|
| problem+json `{type,title,status,detail}` | runner (`runner.ts:18-28`), `/services`, `/operations/{id}` GET+DELETE, `/cancel`, `/download`, locked-field 400 |
| bare `{error: string}` | `/resume` (404 and 400), `/billing/balance` (401, 404), `/billing/usage` (401, 400) |
| bare `{error: string}` for one case inside problem+json routes | `GET /operations` invalid state filter, `operations/route.ts:45` |

The `type` slug is derived mechanically from the title: `https://dugate.vn/errors/` + `title.toLowerCase()` with spaces to hyphens (`runner.ts:20-22`). So a new title silently mints a new error type.

## 4. MISMATCH register

Three sources are compared: the baseline doc `du-rework/docs/14-reference-compatibility.md`, the rework tree, and the integration guide `du-rework/docs/06b-api-spec-overview.md`. Severity is my judgement, not a gate decision.

### 4.A The three named by the dispatch

| ID | MISMATCH | Legacy truth | Doc claim | Severity |
|---|---|---|---|---|
| **M-01** | catalog **31 vs 28** | registry holds **31** core sub-cases: ingest 4, extract 6, analyze 7, transform 5, generate 6, compare 3 | rework holds **28**: `IngestMode` 4, `ExtractType` **5**, `AnalyzeTask` **5**, `TransformVariant` 5, `GenerateTask` 6, `CompareMode` 3 | confirmed, and **not a counting error on either side** |
| **M-02** | comment path | real path `app/api/v1/docs/workflows/route.ts` | L1 comment reads `// app/api/v1/workflows/route.ts` | confirmed; also true for the other 5 core routes (see M-04) |
| **M-03** | guide path | real path `POST /api/v1/docs/extract` | `06b` L53 lists `POST /extract` under base `/api/v1`, and L117 draws `POST /api/v1/extract` | confirmed; see 4.C for why this may be intentional |

M-01 resolved to exactly three named deltas, each with a fixture:

| Delta | Legacy only | Rework fixture |
|---|---|---|
| `extract:id-card` | `registry.ts:134` | absent from `ExtractType`, `actions.ts:46`; absent from the allowlist, `input-normalizer.ts:99` |
| `analyze:fact-check` | `registry.ts:203` | absent from `AnalyzeTask`, `actions.ts:103`; absent, `input-normalizer.ts:149` |
| `analyze:summarize-eval` | `registry.ts:228` | absent from `AnalyzeTask`, `actions.ts:103`; absent, `input-normalizer.ts:149` |

31 minus 28 equals 3, and the three are exactly those. The rework file header states the intent outright: "6 actions and **28 variants**" (`actions.ts:2`), so 28 is deliberate, not drift.

### 4.B Baseline doc vs legacy code

| ID | Doc says | Code does | Severity |
|---|---|---|---|
| M-04 | only the ingest L1 comment is wrong (doc row for ingest) | **all six** core route L1 comments omit `/docs` | low, but the doc understates it by 5 |
| M-05 | `source_file`, `target_file` at `runner.ts:47-49` | `source_file` is at `:44`; `:47` is `target_file` | low, citation drift |
| M-06 | 17 "sub-case params" citing `registry.ts:43-62` | 6 are declared but attached to **no** sub-case, so they are silently dropped (1.5) | **high for migration** |
| M-07 | not mentioned | `EXTRACT_PRESETS` rewrites the effective `fields`/`schema` for 4 extract types (`runner.ts:200-207`); 2 preset keys are unreachable | medium |
| M-08 | "param da `defaultLocked` trong profile khong lo ra client" | the mechanism is wired but **no registry entry sets it**, so nothing is ever hidden | medium |
| M-09 | not mentioned | `required` is never set and never enforced; every sub-case param is optional (1.4) | medium |
| M-10 | not mentioned | unknown form fields are silently dropped, never rejected (`profile-resolver.ts:65-89`) | **high for migration** |
| M-11 | `file_urls` "validate URL" at `runner.ts:129-156` | the runner only checks parseability; SSRF safety is deferred to `assertSafeUrl` at download (`file-url-downloader.ts:7`) | medium |
| M-12 | not mentioned | `output_format` allows `csv`, but `download` maps anything not html/json to **md** (`download/route.ts:46`), so a CSV result is served as `text/markdown` with a `.md` filename | medium |
| M-13 | not mentioned | `/resume` returns bare `{error}` and skips both the `deletedAt` and `done` checks | medium |
| M-14 | not mentioned | `PENDING` is filterable but never written; `CANCELLED`/`WAITING_USER_INPUT` are writable but not filterable (3.4) | medium |

### 4.C Guide (`06b`) vs legacy code

| ID | `06b` says | Legacy reality | Reading |
|---|---|---|---|
| M-03 | `POST /extract` … `POST /compare` under base `/api/v1` (L52-57); L117 `POST /api/v1/extract` | all six live under `/api/v1/docs/*` | either a stale path or the intended **new** shape |
| M-15 | `POST /workflows/{id}` (L58) | `POST /api/v1/docs/workflows`, selected by a `process` **form field**, no `{id}` segment | shape differs |
| M-16 | `202 {operationId, state: ACCEPTED}` (L125) | initial state is **`RUNNING`** (`submit.ts:310`); both workflow routes hardcode `state:"RUNNING"`; `ACCEPTED` is never written to `operations` | **state-map mismatch** |
| M-17 | `POST /artifacts`, `GET /artifacts/{id}/download` (L67-68) | no artifacts route exists under `app/api/v1` | new surface, not legacy |
| M-18 | `GET /operations` with "cursor, limit, state, **sort**" (L59) | `page_size` / `page_token` / `filter`; **no sort parameter** | name drift |
| M-19 | `GET /operations/{id}` with `?wait=` (L60) | no `wait` parameter on the route | new surface |
| M-20 | 17 public endpoints (L52-68) | 17 handlers over 16 files, and the list **omits** `/api/v1/docs/workflows/schema` | count coincides, membership does not |

M-03 deserves a caveat rather than a verdict. `06b` is a **rework** document describing the intended new surface, and dropping the `/docs/` segment may be a deliberate redesign rather than an error. I am not able to settle that from source alone, and COMP-00 owns the decision. What I can state without interpretation: **no legacy route is reachable at `/api/v1/extract`.**

### 4.D Rework gaps that are not mismatches but will bite a migration

| ID | Observation | Fixture |
|---|---|---|
| M-21 | transform discriminator renamed: legacy `action`, rework `variant` with `action` accepted as an alias | `input-normalizer.ts:184` (`raw.variant ?? raw.action`) |
| M-22 | the 4 params the legacy registry declares but never attaches **are** honoured by the rework: `targetLanguage`, `redactPatterns`, `maxWords`, `audience` | `actions.ts:166,170,188,191` |
| M-23 | `focus_areas` and `glossary` are legacy-declared and modelled **nowhere** in the rework | `registry.ts:52,55`; no counterpart in `actions.ts` |
| M-24 | `output_format` unions differ: legacy `md/json/html/csv`; rework `json/md/text` — `html` and `csv` have no rework counterpart | `registry.ts:40`; `actions.ts:26,52,177,246` |
| M-25 | input model differs: legacy uploads files or `file_urls`; rework takes `artifactIds` references | `runner.ts:36-56`; `actions.ts:12` |

## 5. Limits honoured, and what I did not do

- **Read-only.** Nothing under `app/`, `lib/`, or any `du-rework/` source file was modified. The only file created is this report.
- **No gate ticked.** No `tasks/` row, no `P*-release-readiness` entry, no `docs/28` / `docs/35` change — COMP-01 produced no new test evidence, and inventing inventory rows for an API matrix would be the wrong artefact.
- **No contract frozen.** Every MISMATCH above is recorded, none is dispositioned. COMP-02 waits COMP-00, and the `M-03` caveat in 4.C is exactly the kind of decision that belongs there, not here.
- **No fixture executed.** Rows are code-read inferences. The highest-value next step is not more reading: it is replaying a small set of requests against a live legacy instance to convert M-06, M-10 and M-12 from inference into observation. **This runnable triad is deliberately not the same set as the severity triad** (M-06, M-10, M-16) — see §7.2.

### Counts at a glance

| Measure | Value |
|---|---|
| route files under `app/api/v1` | 16 (17 handlers) |
| core sub-cases (legacy registry) | **31** |
| workflow sub-cases | **3** (plus 1 schema-driven route) |
| variants (rework) | **28** |
| distinct connection slugs | 15 |
| registry params declared / attached | 22 / **15** → 7 declared-not-attached, of which **6** are droppable params (1.5) |
| states written by legacy code | 5 (`PENDING` filterable only; `ACCEPTED` never) |
| MISMATCH entries | **25** (3 named by dispatch, 22 found) |
| of which HIGH for migration | 3 (M-06, M-10, and M-16 as state-map) |
---

## 6. COMP-04 — Gap analysis: can rework actually EXECUTE all 31 core variants?

> **Appended 2026-10-01.** Same read-only discipline as COMP-01: **no source edited**, no gate ticked, no contract frozen.
> Companion to §1.3. Question answered here: the decoder is 31-complete, so **where does the chain actually break?**

### 6.0 The hard check, stated as a rule

A name that decodes is not parity. I did **not** stop at the allow-list. For every variant I traced the full chain:

> `input-normalizer` discriminator → `actions.ts` type → `RecipeRegistry` recipe → traceability entry → **real business action in the action module** → **connector slot actually invoked** → output validator → `output_format` handling → output target

Two things this rule caught that a decoder check would have called parity:

- **The `recipe` argument is not the execution driver.** `executeRecipe(ctx, recipe, input, sources)` receives the recipe and **never reads it** — the branch is on `input.mode` / `input.type` / `input.task` / `input.variant`, and step keys come from a separate `STEP_KEYS` module. A recipe can therefore be perfectly well-formed while the handler behind it does nothing. So I checked the handler, not the recipe.
- **The `requiredSlot` in a recipe is a claim, not evidence.** It is only real if the handler calls `connector.invoke(<that slot>)`. I verified each one individually (§6.3).

### 6.1 The 31-row table

`chain` = all seven links present. `gap class` = the residual defect. Recipe and traceability ids are real registry values.

| # | Legacy variant | Discriminator | `actions.ts` | Recipe | Business action (verified) | Slot invoked | Out. validator | chain | gap class |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `ingest:parse` | `mode` ok | ok | recipe-ingest-parse-v1 | local parse, `ingest/index.ts:158` | none (local) | action-level `:84` | 7/7 | OUTPUT-FORMAT-GAP |
| 2 | `ingest:ocr` | `mode` ok | ok | recipe-ingest-ocr-v1 | OCR call, `:250` | `ocr` `:268` | action-level `:84` | 7/7 | OUTPUT-FORMAT-GAP |
| 3 | `ingest:digitize` | `mode` ok | ok | recipe-ingest-digitize-v1 | vision call, `:291` | `vision` `:309` | action-level `:84` | 7/7 | OUTPUT-FORMAT-GAP |
| 4 | `ingest:split` | `mode` ok | ok | recipe-ingest-split-v1 | PdfSplitter + real artifact write, `:202,:226` | none (local) | `splitArtifacts` `:92` | 7/7 | OUTPUT-FORMAT-GAP |
| 5 | `extract:invoice` | `type` ok | ok | recipe-extract-invoice-v1 | generic reasoning call, task `extract_invoice`, `:90` | `reasoning` `:90` | `case invoice` `:110` | 7/7 | OUTPUT-FORMAT-GAP |
| 6 | `extract:contract` | `type` ok | ok | recipe-extract-contract-v1 | generic reasoning call, task `extract_contract`, `:90` | `reasoning` `:90` | `case contract` `:122` | 7/7 | OUTPUT-FORMAT-GAP |
| 7 | `extract:receipt` | `type` ok | ok | recipe-extract-receipt-v1 | generic reasoning call, task `extract_receipt`, `:90` | `reasoning` `:90` | `case receipt` `:134` | 7/7 | OUTPUT-FORMAT-GAP |
| 8 | `extract:table` | `type` ok | ok | recipe-extract-table-v1 | generic reasoning call, task `extract_table`, `:90` | `reasoning` `:90` | `case table` `:146` | 7/7 | OUTPUT-FORMAT-GAP |
| 9 | `extract:custom` | `type` ok | ok | recipe-extract-custom-v1 | generic reasoning call, task `extract_custom` + jsonSchema, `:90` | `reasoning` `:90` | `case custom` `:158` | 7/7 | OUTPUT-FORMAT-GAP |
| 10 | `extract:id-card` | **NOT in allowlist** `input-normalizer.ts:99` | **absent** `actions.ts:46` | **absent** | **none** | **none** | **none** | **0/7** | **MISSING-RECIPE** |
| 11 | `analyze:classify` | `task` ok | ok | recipe-analyze-classify-v1 | generic reasoning call, task `analyze_classify`, `:101` | `reasoning` `:101` | `case classify` `:178` | 7/7 | OUTPUT-FORMAT-GAP |
| 12 | `analyze:sentiment` | `task` ok | ok | recipe-analyze-sentiment-v1 | generic reasoning call, task `analyze_sentiment`, `:101` | `reasoning` `:101` | `case sentiment` `:193` | 7/7 | OUTPUT-FORMAT-GAP |
| 13 | `analyze:compliance` | `task` ok | ok | recipe-analyze-compliance-v1 | generic reasoning call, task `analyze_compliance`, `:101` | `reasoning` `:101` | `case compliance` `:203` | 7/7 | OUTPUT-FORMAT-GAP |
| 14 | `analyze:quality` | `task` ok | ok | recipe-analyze-quality-v1 | generic reasoning call, task `analyze_quality`, `:101` | `reasoning` `:101` | `case quality` `:213` | 7/7 | OUTPUT-FORMAT-GAP |
| 15 | `analyze:risk` | `task` ok | ok | recipe-analyze-risk-v1 | generic reasoning call, task `analyze_risk`, `:101` | `reasoning` `:101` | `case risk` `:223` | 7/7 | OUTPUT-FORMAT-GAP |
| 16 | `analyze:fact-check` | **NOT in allowlist** `:149` | **absent** `actions.ts:103` | **absent** | **none** | **none** | **none** | **0/7** | **MISSING-RECIPE** |
| 17 | `analyze:summarize-eval` | **NOT in allowlist** `:149` | **absent** `actions.ts:103` | **absent** | **none** | **none** | **none** | **0/7** | **MISSING-RECIPE** |
| 18 | `transform:convert` | **`variant`** (legacy `action` aliased `:184`) | ok | recipe-transform-convert-v1 | local convert, `:82` | none (local) | action-level `:67` | 7/7 | DISCRIMINATOR-ALIAS |
| 19 | `transform:translate` | **`variant`** (alias `:184`) | ok | recipe-transform-translate-v1 | reasoning call, `:101` | `reasoning` `:117` | action-level `:67` | 7/7 | DISCRIMINATOR-ALIAS |
| 20 | `transform:rewrite` | **`variant`** (alias `:184`) | ok | recipe-transform-rewrite-v1 | reasoning call, `:148` | `reasoning` `:164` | action-level `:67` | 7/7 | DISCRIMINATOR-ALIAS |
| 21 | `transform:redact` | **`variant`** (alias `:184`) | ok | recipe-transform-redact-v1 | local redact, `:196` | none (local) | action-level `:67` | 7/7 | DISCRIMINATOR-ALIAS |
| 22 | `transform:template` | **`variant`** (alias `:184`) | ok | recipe-transform-template-v1 | local TemplateEngine, `:214` | none (local) | action-level `:67` | 7/7 | DISCRIMINATOR-ALIAS |
| 23 | `generate:summary` | `task` ok | ok | recipe-generate-summary-v1 | reasoning call, `:102` | `reasoning` `:102` | `case summary` `:253` | 7/7 | OUTPUT-FORMAT-GAP |
| 24 | `generate:outline` | `task` ok | ok | recipe-generate-outline-v1 | reasoning call, `:102` | `reasoning` `:102` | `case outline` `:254` | 7/7 | OUTPUT-FORMAT-GAP |
| 25 | `generate:report` | `task` ok | ok | recipe-generate-report-v1 | reasoning call, `:102` | `reasoning` `:102` | `case report` `:255` | 7/7 | OUTPUT-FORMAT-GAP |
| 26 | `generate:email` | `task` ok | ok | recipe-generate-email-v1 | reasoning call, `:102` | `reasoning` `:102` | `case email` `:256` | 7/7 | OUTPUT-FORMAT-GAP |
| 27 | `generate:minutes` | `task` ok | ok | recipe-generate-minutes-v1 | reasoning call, json responseFormat, `:102,:105` | `reasoning` `:102` | `case minutes` `:257` | 7/7 | OUTPUT-FORMAT-GAP |
| 28 | `generate:qa` | `task` ok | ok | recipe-generate-qa-v1 | reasoning call, json responseFormat, `:102,:120` | `reasoning` `:102` | `case qa` `:267` | 7/7 | OUTPUT-FORMAT-GAP |
| 29 | `compare:diff` | `mode` ok | ok | recipe-compare-diff-v1 | native DiffEngine, `:72` | none (local) | `case diff` `:293` | 7/7 | OUTPUT-FORMAT-GAP |
| 30 | `compare:semantic` | `mode` ok | ok | recipe-compare-semantic-v1 | reasoning call, task `compare_semantic`, `:91` | `reasoning` `:97` | `case semantic` `:302` | 7/7 | OUTPUT-FORMAT-GAP |
| 31 | `compare:version` | `mode` ok | ok | recipe-compare-version-v1 | reasoning call, task `compare_version`, `:127` | `reasoning` `:133` | `case version` `:319` | 7/7 | OUTPUT-FORMAT-GAP |

**Totals:** `MISSING-RECIPE` **3** · `DISCRIMINATOR-ALIAS` **5** · `OUTPUT-FORMAT-GAP` **23** · `MISSING-CONNECTOR` **0** · chain-complete **28/31**.
- **Một tuyên bố tôi đã sửa giữa chừng.** Trước khi đọc kỹ `worker.ts` tôi nói `formatResult` chỉ được gọi cho 4/6 action. Sai: nó được gọi cho **cả 6** (`worker.ts:469,491,513,535,557,579`); analyze và generate chỉ truyền **2** tham số vì input của chúng không có `outputFormat`, chứ không phải vì thiếu lời gọi. Sự khác biệt này quan trọng — một lần hiểu sai ở đây đã dẫn tới kết luận sai về hai action — nên tôi ghi lại thay vì sửa ngầm
### 6.2 Why MISSING-CONNECTOR is zero — and why that is not the same as parity

I checked every `requiredSlot` declared in a recipe against the slot the handler actually invokes. All match:

| Recipe `requiredSlot` | Variants | Handler invocation | Verdict |
|---|---|---|---|
| `ocr` | ingest:ocr | `connector.invoke("ocr")` `ingest/index.ts:268` | matches |
| `vision` | ingest:digitize | `connector.invoke("vision")` `:309` | matches |
| `reasoning` | extract ×5, analyze ×5, generate ×6, transform:translate + rewrite, compare:semantic + version | `connector.invoke("reasoning")` `extract:90`, `analyze:101`, `generate:102`, `transform:117,164`, `compare:97,133` | matches |
| `undefined` (local) | ingest:parse, ingest:split, transform:convert, transform:redact, transform:template, compare:diff | no connector call; local engine (`PdfSplitter`, `DiffEngine`, `TemplateEngine`) | matches |

So **zero rows are MISSING-CONNECTOR at the orchestration layer**, and the manifest declares exactly the slots used (`ocr`/`vision` on ingest `:56,:61`; `reasoning` on the other five). That is a real result and I state it as one — but it is **not** parity, for a reason that a slot check cannot see:

> **The per-variant semantics for 20 of the 28 live outside this repository.**
> For every reasoning variant the "business action" is: assemble a payload, send `task: "<action>_<variant>"` (`extract:91`, `analyze:102`, `generate:102`, `compare:98,134`) — and the connector HTTP adapter **forwards `task` verbatim to the upstream provider** (`services/connector/src/adapters/http.ts:49` for JSON, `:93` for multipart).
> Those 20 task strings appear **nowhere** in `worker-sdk/src` or `connector/src` as a handler. I grepped: the only occurrences are the `send` site in document-core and document-core's own tests asserting the string was sent (`tests/provider-backed-variant.test.ts:200`, `tests/execution-pin.functional.test.ts:289`).
> So whether `extract_invoice` or `analyze_quality` actually does invoice extraction or quality scoring is a **contract with an external provider**, unverified by anything in this tree. A green traceability matrix cannot make that true.

The local variants are the opposite case and are genuinely repo-owned: `compare:diff` really computes a diff (`DiffEngine`), `ingest:split` really slices a PDF and **writes a real artifact** (`ctx.artifacts.write`, `ingest/index.ts:226`), `transform:convert`/`redact`/`template` run local engines.

### 6.3 What the traceability matrix does and does not prove

`VARIANT_TRACEABILITY_MATRIX` (`manifest/traceability.ts:22`) holds 28 entries and `verifyTraceabilityMatrix()` (`:292`) checks five things: count is 28, action declared in the manifest, recipe exists **and its id matches**, `requiredSlot` is declared by the action, and `validateOutput` is a function.

Two limits on what that establishes:

- **It is called from a test and nowhere else.** `verifyTraceabilityMatrix` appears in exactly four places: its own definition and `tests/traceability.test.ts:3,11,80`. Nothing in `worker.ts` or `main.ts` calls it, so at runtime the 28-variant claim is not enforced.
- **It never checks the handler.** It proves a recipe id matches and a slot is declared. It does not prove the action module branches on that variant, and it would pass unchanged if `executeRecipe` ignored the recipe entirely — which, per §6.0, it does.

So the traceability matrix is real evidence about **wiring declarations**, and I used it as a checklist. It is not evidence of executable capability, and I did not treat it as such.

### 6.4 `output_format` — the gap that touches all 31 rows

Legacy reads `output_format` in the runner for **every** service (`runner.ts:226`, default `json`, allowed `md|json|html|csv`). The rework handles it six different ways:

| Action | How rework treats `output_format` | Fixture | Consequence for a legacy caller |
|---|---|---|---|
| ingest | `normalizeOutputFormat` → `json` / `md` / `text` | `:90`, `:515-522` | `html`/`csv` **silently dropped to undefined**, no error |
| extract | **hardcoded** `outputFormat: "json"` | `:140` | the caller's value is **never read at all** — `md`/`html`/`csv` all ignored |
| analyze | **no `outputFormat` field on the input**; `formatResult` called with 2 args | manifest `:109-137`; `worker.ts:513` | any `output_format` request is discarded |
| transform | unconstrained passthrough, cast to `string` | `:222-224` | `html`/`csv` are **accepted but never rendered** — `formatResult(_ctx, data, _format)` ignores the argument |
| generate | **no `outputFormat` field**; `formatResult` with 2 args | `worker.ts:557` | discarded |
| compare | `normalizeOutputFormat` → `json` / `md` / `text` | `:310`, `:515-522` | `html`/`csv` silently dropped |

`normalizeOutputFormat` returns `undefined` for anything it does not recognise (`:521`) — it **never throws**. So `output_format=html` is accepted by the API, discarded silently, and the caller receives a JSON envelope. This is the same silent-drop class as the six dead parameters in §1.5: the contract accepts a value and then loses it without saying so.

**`html` and `csv` have no counterpart in any rework action** (M-24 confirmed at the manifest level: the widest union is ingest's `json|md|text`, `:38`; extract is `json` only, `:82`; analyze, generate, compare declare none; transform is an unconstrained string, `:151`).

### 6.5 Output target — inline vs artifact/download

| Variant group | Output target | Fixture |
|---|---|---|
| ingest:split | **artifact** — real bytes written, id returned inline | `ingest/index.ts:226,233` |
| ingest:digitize | inline structured `formFields` | `:322` |
| all other 29 | inline `data` inside `ResultEnvelope` | e.g. `compare/index.ts:170-182` |

Legacy exposes `result.download_url` on **every** `SUCCEEDED` operation (`format.ts:49`) and serves it with a 200 stream (`download/route.ts:15`). The rework returns inline `data` for 30 of 31, with **no** `download_url` equivalent; only `ingest:split` produces a fetchable artifact. So the legacy download affordance has no counterpart for 30 rows. This is not one of the five given classes, so I report it as a column rather than forcing it into a class — but it is a real migration difference.

### 6.6 The three MISSING-RECIPE rows in detail

These fail at **link 1**, before any orchestration happens. A request naming them is rejected by the normalizer, so the absence is total, not partial:

| Link | id-card | fact-check | summarize-eval |
|---|---|---|---|
| normalizer allowlist | absent `input-normalizer.ts:99` | absent `:149` | absent `:149` |
| `actions.ts` type | absent `:46` | absent `:103` | absent `:103` |
| `RecipeRegistry` | absent | absent | absent |
| traceability entry | absent | absent | absent |
| handler branch | absent | absent | absent |
| output validator case | absent | absent | absent |
| **decoder allow-list** | **present (31-complete)** | **present** | **present** |

The last row is the whole point of this section. The decoder accepts all three names, so a wire-level test against the orchestrator will pass. Everything downstream of the decoder is absent. **A decoder-completeness check is exactly the check that would have declared these three done.**

### 6.7 Leads from COMP-01, adjudicated

| Lead | Verdict | Evidence |
|---|---|---|
| **M-21** transform legacy `action` vs rework `variant` | **CONFIRMED, and it works** | `input-normalizer.ts:184` reads `raw.variant ?? raw.action`, so both spellings are accepted. The alias is a rename, not a break — hence `DISCRIMINATOR-ALIAS` rather than a gap |
| **M-22** rework honours `targetLanguage` / `redactPatterns` / `maxWords` / `audience` | **CONFIRMED, and it is a real advantage** | `input-normalizer.ts:220` maps `redactPatterns ?? redact_patterns`; `TransformInput` carries `targetLanguage` (`actions.ts:166`). Four params the legacy registry declares and silently drops are honoured end-to-end here. The rework is **ahead** of legacy on these |
| **M-23** `focus_areas` + `glossary` modelled nowhere | **CONFIRMED** | no counterpart in `actions.ts` or the manifest. These two remain dead in both worlds — legacy drops them, rework never had them |
| **M-24** `output_format` legacy `{md,json,html,csv}` vs rework `{json,md,text}` | **CONFIRMED and worse than stated** | `html`/`csv` absent everywhere (§6.4); `text` is rework-only; and extract **ignores the caller entirely** (`:140`) |
| **M-25** legacy files/`file_urls` vs rework `artifactIds` | **CONFIRMED** | rework input is reference-only (`actions.ts:12`); there is no upload path inside document-core. Expected for the new architecture, but it means no legacy file payload can be replayed against it as-is |

### 6.8 Limits

- **Read-only.** No file under `businesses/`, `packages/`, `services/`, or any `app/` was modified. This section is the only change, appended to my own report.
- **No gate ticked, no contract frozen.** Every row above is a measurement plus a gap class. Deciding what to do about the 3 `MISSING-RECIPE` rows, the 5 aliases, or the `html`/`csv` hole is COMP-00/COMP-02 work, and I have deliberately left all three open.
- **Still static.** Same limit as COMP-01: no request was issued and no recipe was executed. The 7/7 chain verdicts are code-read inferences. The claim most worth executing is §6.2 — that a reasoning variant's `task` string is honoured by whatever provider is configured, which is the one link in this whole matrix that **cannot** be settled from inside this repository.
## 7. Review annotations (not a new finding)

> Added 2026-10-01 after coordinator review of the settled COMP-01 matrix. **No source was read for a new conclusion and none was changed** — this section only records two review notes, what I verified in each, and one correction I have to make to the review itself.

### 7.1 M-06 — `22 / 15` versus "six", resolved

**The review is right, and the original text was genuinely ambiguous.** The counts row said `22 / 15`, which is 7, while the prose said "six". Both numbers were defensible in isolation and a reader had no way to tell which question each answered.

Verified before changing anything:

- `PARAMS.type` is referenced by **no** sub-case — `re.search(r"PARAMS\.type", registry)` is `False`, and the 15 distinct `PARAMS.<x>` references confirm the attached set exactly.
- `type` is nonetheless **not a droppable parameter**. It is the extract discriminator: `discriminatorName: 'type'` (`registry.ts:116`), read at `runner.ts:113` as `form.get(service.discriminatorName)`. That read happens **before** `mergeParameters` runs, so a client sending `type=invoice` has it consumed as the discriminator and never reaches the merge path where an unrecognised field would be dropped.

So the reconciliation is: **7 declared-not-attached, of which 6 are silently dropped params** — `focus_areas`, `target_language`, `glossary`, `redact_patterns`, `max_words`, `audience`. §1.5 heading, prose, the `type` row and the counts row now all say this the same way.

### 7.1a One correction to the review note

The review cited the discriminator as **documented separately at `runner.ts:106`**. That line is not the discriminator — it is a `catch` block inside the `x-api-key` resolution path (`runner.ts:106-108`, logging `"[AUTH] Failed to resolve apiKeyId from x-api-key"`).

The discriminator block is **`runner.ts:112-123`**: the section comment `// ── 2. Resolve sub-case ──` at `:112`, `form.get(service.discriminatorName)` at **`:113`**, the `_default` fallback at `:114`, and the 400 with the valid-value list at `:116-123`. This document already cited `:113-123`; I have used `:113` in the corrected `type` row rather than propagating the off-by-seven.

The review's **conclusion** is unaffected — `type` is the discriminator either way. Only the supporting line number was wrong.

### 7.2 M-16 — severity, and two triads that are not the same set

**M-16 (`state: ACCEPTED` in `06b` vs `RUNNING` in legacy) is HIGH for migration.** It was already counted as such in the §5 summary; the review is right that it needed to be stated rather than left to be inferred from a count.

Why it earns the rating on its own: a consumer written against `06b` polls for `state: ACCEPTED` and for `SUCCEEDED`/`FAILED`. Legacy never writes `ACCEPTED` anywhere — the initial value is `RUNNING` (`submit.ts:310`, and the column default `db/schema.ts:16`), and both workflow routes hardcode `state:"RUNNING"`. `ACCEPTED` exists only as a UI-adapter fallback (`app/workflow-builder/du-operation-adapter.ts:33,242`) and in tests. A poll loop written to the guide therefore waits on a state that the system never enters, and there is no error to tell it so — it simply never resolves.

**The clarification the review asked for — this document contains two different triads, and I had not labelled them:**

| Triad | Members | Question it answers |
|---|---|---|
| **severity** | M-06, M-10, **M-16** | which mismatches will silently break a migrating consumer |
| **runnable** | M-06, M-10, **M-12** | which rows can be converted from inference to observation fastest, because they are observable at the HTTP boundary |

The difference is **M-16 vs M-12**, and both belong. M-12 (`output_format=csv` served as `text/markdown`, `download/route.ts:46`) is trivially observable — one request, one response header. M-16 is the more dangerous defect but is **not** observable from the legacy HTTP surface alone, because the `ACCEPTED` value lives in a *rework* document, not in a legacy response. §5 and §4 bullets now point at §7.2 instead of leaving the two lists to be compared by eye.

### 7.3 What this section does not do

- **No new measurement.** Both notes were checked against the sources already cited; no new file was opened for a new conclusion, and every figure quoted here is the one already in §1–§6.
- **No gate, no contract.** COMP-01 remains settled and COMP-04 unchanged in substance; this is annotation, not revision. The 25 MISMATCH entries, the 31-row table and the `MISSING-RECIPE 3 / DISCRIMINATOR-ALIAS 5 / OUTPUT-FORMAT-GAP 23 / MISSING-CONNECTOR 0` totals are all untouched.
- **No source edits.** The only file changed is this report.