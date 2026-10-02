# COMP-01 Slice A — Legacy Route Shape Matrix (READ-ONLY)

**Task:** `task_0abc62f2559f`  
**Status:** characterization only; no source, gate, or task-row edits; no tests run.

## 1. Scope and route dispatch

The six core route files each export only `POST` and delegate to `runEndpoint(service, req)`: ingest (`app/api/v1/docs/ingest/route.ts:5-6`), extract (`.../extract/route.ts:5-6`), analyze (`.../analyze/route.ts:5-6`), transform (`.../transform/route.ts:5-6`), generate (`.../generate/route.ts:5-6`), and compare (`.../compare/route.ts:5-6`). Their actual URL paths include `/docs/`, as recorded in `SERVICE_REGISTRY` (`lib/endpoints/registry.ts:70-75,112-117,171-176,238-243,283-289,337-343`). The registry declares each discriminator and each sub-case parameter set; it does not mark any per-case parameter `required` (`lib/endpoints/registry.ts:7-14,17-26`). `runEndpoint` reads the selected discriminator from multipart form data and returns 400 if it does not resolve to a registered case (`lib/endpoints/runner.ts:84,112-123`).

For each core row below, the discriminator is route-required; the listed sub-case parameters are optional and string-typed in the registry. A missing `required` flag is not a claim that downstream processing succeeds without a document. The core route adapter itself does not enforce a minimum file count; it normalizes and forwards inputs (`lib/endpoints/runner.ts:32-54,125-156,234-248`). `max_words` is typed as a number in the reusable constants but is not attached to any sub-case; likewise `audience`, `target_language`, `focus_areas`, `glossary`, and `redact_patterns` are declared constants but not attached to a sub-case (`lib/endpoints/registry.ts:47-61,408-424`).

### Common core request fields

- **Body encoding:** all six core handlers enter `runEndpoint`, which calls `req.formData()` (`lib/endpoints/runner.ts:58-59,84`). This is multipart form data at the route boundary.
- **File fields:** `files[]` (repeated), then `source_file`, `target_file`, and `file` (single fields) are collected in that order; only `File` values with `size > 0` are kept (`lib/endpoints/runner.ts:32-53`). The route does not bind those names to specific actions.
- **`file_urls`:** optional form field containing a JSON array; the runner parses it, checks it is an array under imported `MAX_FILE_URL_ENTRIES`, requires each entry to have a non-empty string `url`, checks that `new URL(url)` parses, then passes the entries alongside local files (`lib/endpoints/runner.ts:12,128-156,234-239`). The form-level contract documented elsewhere gives optional `filename` and `mime_type` fields (`docs/API_PROFILES_SPEC.md:54`); this runner validation only visibly checks `url` (`lib/endpoints/runner.ts:144-155`). This receipt characterizes route admission only; it does not infer downstream URL-fetch policy.
- **Common controls:** optional `output_format` is read directly and defaults to `json`; optional `webhook_url` is read as a form field; `sync=true` is read from the URL query (`lib/endpoints/runner.ts:225-230`). Optional `idempotency-key` is read from the request header, and `x-correlation-id` is used when supplied or generated otherwise (`:59,228-248`). Async submissions return 202 plus `Operation-Location`; sync or idempotent submissions return 200 (`lib/endpoints/runner.ts:256-276`). Unknown query keys are not rejected in this runner; the only query value it reads for submission is `sync` (`:229`).
- **Operation output:** core responses use `formatOperationResponse`; its common envelope exposes state, pipeline, current step, progress fields, times, and `pipeline_steps`; a successful result includes output format/content/extracted data/usage and `/api/v1/operations/{id}/download` (`lib/pipelines/format.ts:17-50`).

## 2. Core matrix — all 31 registered sub-cases

`CORE FILES/URL` means the common input behavior above. Registry parameters listed here are optional; `output_format` has registry default `json` where declared (`lib/endpoints/registry.ts:39-44`). Rework target names are the matching document-core action and variant unless a mismatch is called out in §6.

For compact matrix cells, `registry.ts` means `lib/endpoints/registry.ts`; `manifest.ts` means `businesses/document-core/src/manifest/document-core.manifest.ts`; and `recipe-definitions.ts` means `businesses/document-core/src/recipes/recipe-definitions.ts`.

| # | Legacy route / discriminator | Required discriminator | Optional per-case fields | File / URL policy | Rework action target and evidence |
|---:|---|---|---|---|---|
| 1 | `POST /api/v1/docs/ingest` — `mode=parse` | `mode=parse` | `output_format` (default `json`), `language` | CORE FILES/URL | `ingest:parse` — `document-core.manifest.ts:29-40`; recipe `recipe-definitions.ts:25-35`; legacy `registry.ts:70-83` |
| 2 | same — `mode=ocr` | `mode=ocr` | `language` | CORE FILES/URL | `ingest:ocr` — manifest `:29-40`; recipe `:37-47`; registry `:84-91` |
| 3 | same — `mode=digitize` | `mode=digitize` | none declared | CORE FILES/URL | `ingest:digitize` — manifest `:29-40`; recipe `:49-59`; registry `:92-99` |
| 4 | same — `mode=split` | `mode=split` | `pages` | CORE FILES/URL | `ingest:split` — manifest `:29-40`; recipe `:61-71`; registry `:100-107` |
| 5 | `POST /api/v1/docs/extract` — `type=invoice` | `type=invoice` | none declared | CORE FILES/URL | `extract:invoice` — manifest `:73-85`; recipe `:75-86`; registry `:112-125` |
| 6 | same — `type=contract` | `type=contract` | none declared | CORE FILES/URL | `extract:contract` — manifest `:73-85`; recipe `:88-99`; registry `:126-133` |
| 7 | same — `type=id-card` | `type=id-card` | none declared | CORE FILES/URL | `extract:id-card` — manifest `:73-85`; recipe `:101-112`; registry `:134-141` |
| 8 | same — `type=receipt` | `type=receipt` | none declared | CORE FILES/URL | `extract:receipt` — manifest `:73-85`; recipe `:114-125`; registry `:142-149` |
| 9 | same — `type=table` | `type=table` | none declared | CORE FILES/URL | `extract:table` — manifest `:73-85`; recipe `:127-138`; registry `:150-157` |
| 10 | same — `type=custom` | `type=custom` | `fields`, `schema` | CORE FILES/URL | `extract:custom` — manifest `:73-85`; recipe `:140-151`; registry `:158-167` |
| 11 | `POST /api/v1/docs/analyze` — `task=classify` | `task=classify` | `categories` | CORE FILES/URL | `analyze:classify` — manifest `:106-120`; recipe `:155-166`; registry `:171-185` |
| 12 | same — `task=sentiment` | `task=sentiment` | none declared | CORE FILES/URL | `analyze:sentiment` — manifest `:106-120`; recipe `:168-179`; registry `:186-193` |
| 13 | same — `task=compliance` | `task=compliance` | `criteria` | CORE FILES/URL | `analyze:compliance` — manifest `:106-120`; recipe `:181-192`; registry `:194-202` |
| 14 | same — `task=fact-check` | `task=fact-check` | `reference_data`, `extract_fields` | CORE FILES/URL | `analyze:fact-check` — manifest `:106-120`; recipe `:220-233`; registry `:203-211` |
| 15 | same — `task=quality` | `task=quality` | `criteria` | CORE FILES/URL | `analyze:quality` — manifest `:106-120`; recipe `:194-205`; registry `:212-219` |
| 16 | same — `task=risk` | `task=risk` | none declared | CORE FILES/URL | `analyze:risk` — manifest `:106-120`; recipe `:207-218`; registry `:220-227` |
| 17 | same — `task=summarize-eval` | `task=summarize-eval` | none declared | CORE FILES/URL | `analyze:summarize-eval` — manifest `:106-120`; recipe `:235-248`; registry `:228-234` |
| 18 | `POST /api/v1/docs/transform` — `action=convert` | `action=convert` | `output_format` (default `json`) | CORE FILES/URL | `transform:convert` — manifest `:140-156`; recipe `:251-261`; registry `:238-251` |
| 19 | same — `action=translate` | `action=translate` | none declared by registry | CORE FILES/URL | `transform:translate` — manifest `:140-156`; recipe `:263-273`; registry `:252-257` |
| 20 | same — `action=rewrite` | `action=rewrite` | `style`, `tone` | CORE FILES/URL | `transform:rewrite` — manifest `:140-156`; recipe `:275-285`; registry `:258-265` |
| 21 | same — `action=redact` | `action=redact` | none declared | CORE FILES/URL | `transform:redact` — manifest `:140-156`; recipe `:287-297`; registry `:266-271` |
| 22 | same — `action=template` | `action=template` | `template` | CORE FILES/URL | `transform:template` — manifest `:140-156`; recipe `:299-309`; registry `:272-280` |
| 23 | `POST /api/v1/docs/generate` — `task=summary` | `task=summary` | none declared | CORE FILES/URL | `generate:summary` — manifest `:176-191`; recipe `:313-323`; registry `:284-295` |
| 24 | same — `task=outline` | `task=outline` | `format` | CORE FILES/URL | `generate:outline` — manifest `:176-191`; recipe `:325-335`; registry `:296-303` |
| 25 | same — `task=report` | `task=report` | none declared | CORE FILES/URL | `generate:report` — manifest `:176-191`; recipe `:337-347`; registry `:304-309` |
| 26 | same — `task=email` | `task=email` | `tone` | CORE FILES/URL | `generate:email` — manifest `:176-191`; recipe `:349-359`; registry `:310-317` |
| 27 | same — `task=minutes` | `task=minutes` | `format` | CORE FILES/URL | `generate:minutes` — manifest `:176-191`; recipe `:361-371`; registry `:318-325` |
| 28 | same — `task=qa` | `task=qa` | `questions` | CORE FILES/URL | `generate:qa` — manifest `:176-191`; recipe `:373-384`; registry `:326-334` |
| 29 | `POST /api/v1/docs/compare` — `mode=diff` | `mode=diff` | `output_format` (default `json`) | CORE FILES/URL | `compare:diff` — manifest `:211-224`; recipe `:387-397`; registry `:337-351` |
| 30 | same — `mode=semantic` | `mode=semantic` | `focus` | CORE FILES/URL | `compare:semantic` — manifest `:211-224`; recipe `:399-409`; registry `:352-360` |
| 31 | same — `mode=version` | `mode=version` | `output_format` (default `json`) | CORE FILES/URL | `compare:version` — manifest `:211-224`; recipe `:411-422`; registry `:361-369` |

The registry count is 4 + 6 + 7 + 5 + 6 + 3 = **31 core sub-cases** (`lib/endpoints/registry.ts:69-370`). The step-key module itself describes six actions and 31 variants (`businesses/document-core/src/recipes/step-keys.ts:1-3`). The rework manifest enumerates the corresponding variants in its six action schemas (`businesses/document-core/src/manifest/document-core.manifest.ts:27-240`); `recipe-definitions.ts` contains a same-named recipe key for each row (`:25-422`).

## 3. Workflow routes — separately counted, not part of the 31 core rows

| Route | Required / optional route fields | Files and output | Rework action target / observed delta |
|---|---|---|---|
| `POST /api/v1/docs/workflows`, discriminator `process` | Required `process`; accepted values `disbursement`, `lc-checker`, `doc-compare`. `resolution_data` is the only registry-declared optional field, on disbursement; the route copies declared values only when truthy (`registry.ts:372-402`; `workflows/route.ts:20-29,36-41`). | Uses the common four-field file normalizer and explicitly requires at least one non-empty file (`workflows/route.ts:31-34`). This route does not parse `file_urls` or read `sync`/`webhook_url`. It returns 202 and `Operation-Location` (`:99-115`). | `disbursement` has a separate rework action and workflow recipe (`document-core.manifest.ts:243-332`; `recipe-definitions.ts:425-440`). No `lc-checker` or `doc-compare` action/recipe appears in the inspected rework manifest/recipe files (`manifest.ts:26-333`; `recipe-definitions.ts:22-440`). |
| `POST /api/v1/docs/workflows/schema` | Required `schemaSlug`; optional `input` JSON string and optional normalized files (`route.ts:18-48`). `input` parse failure returns 400 (`:39-48`). | Files are optional; this route does not parse `file_urls` or `sync`. It returns 202 and `Operation-Location` (`:36-37,95-109`). | Schema slug is loaded dynamically by the legacy handler; there is no matching schema-slug registry in the inspected document-core manifest/recipe files. |

The schema workflow handler also reads an `apiKeyId` form field (`app/api/v1/docs/workflows/schema/route.ts:58-75`); the code-driven workflow handler has the corresponding route-level identity selection code (`app/api/v1/docs/workflows/route.ts:47-86`). These are excluded from business input mapping and marked **MUST-NOT-REPLICATE** in §7.

## 4. Operations, service catalog, and billing route shapes

| Route | Method and route inputs | Observed response shape / notes |
|---|---|---|
| `/api/v1/operations` | `GET`; optional query `page_size` (default 20, maximum 100), `page_token`, and `filter`; filter recognizes `state` in `RUNNING/SUCCEEDED/FAILED/PENDING` and `processor` (`app/api/v1/operations/route.ts:29-56`). | `operations` array plus `next_page_token`; lightweight metadata per item (`:66-130`). |
| `/api/v1/operations/{id}` | `GET` and `DELETE`; path `id`; no body read (`app/api/v1/operations/[id]/route.ts:14-20,40-45`). | GET returns `formatOperationResponse` (`:37`); DELETE soft-deletes and returns 204 (`:62-65`). |
| `/api/v1/operations/{id}/cancel` | `POST`; path `id`; no body read (`app/api/v1/operations/[id]/cancel/route.ts:10-15`). | Rejects already-done with 409; otherwise writes `done=true`, state `CANCELLED`, and clears progress message before formatting the response (`:32-46`). The direct terminal write is **MUST-NOT-REPLICATE** (§7). |
| `/api/v1/operations/{id}/resume` | `POST`; path `id`; reads JSON body. If both `step` and `extracted_data` are supplied, it updates the matching step; otherwise no human edit is applied (`app/api/v1/operations/[id]/resume/route.ts:20-33,56-63`). | Requires current state `WAITING_USER_INPUT`; sets `RUNNING`, writes a progress message and re-encoded steps, re-enqueues, then returns `{success,message}` (`:31-33,75-98`). |
| `/api/v1/operations/{id}/download` | `GET`; path `id`; no body read (`app/api/v1/operations/[id]/download/route.ts:15-20`). | Requires `SUCCEEDED`; serves `outputContent`, or streams `outputFilePath`, otherwise returns 404/409 (`:37-42,44-57,60-118`). |
| `/api/v1/services` | `GET`; no query/body fields read. It calls `getAllEndpointSlugs()` (`app/api/v1/services/route.ts:8-10,28-29`). | Groups enabled registry entries into service objects with `discriminatorKey`, sub-case `id`, and client-safe parameters (`:31-65,68-75`). It includes workflow entries because the helper flattens all registry services (`lib/endpoints/registry.ts:408-424`). |
| `/api/v1/billing/balance` | `GET`; no query/body fields read (`app/api/v1/billing/balance/route.ts:17-22`). | Requires an `x-api-key-id` header and returns a `billing_balance` object with API-key identity, limit/use/balance details and timestamp (`:23-50`). |
| `/api/v1/billing/usage` | `GET`; optional `start_date`, `end_date` query; absent dates default to a trailing date range ending now (`app/api/v1/billing/usage/route.ts:30-39`). | Filters succeeded/done operations by API-key id and date range; groups records by model and returns aggregate fields (`:41-57,59-95`). |

### Access-boundary observations (not a design proposal)

Middleware passes `/api/v1/*` through after deleting incoming `x-api-key-id`, `x-user-id`, and `x-user-role`, then may inject session user headers (`middleware.ts:32-52`). The core runner reads the post-middleware `x-api-key-id`, and if absent hashes a presented `x-api-key` for lookup (`lib/endpoints/runner.ts:84-110`). The service and billing handlers read `x-api-key-id` directly (`app/api/v1/services/route.ts:9-22`; billing routes cited above); these route contracts therefore differ from the core runner's raw-key resolution path. No client-supplied identity header is treated as a valid mapping input here.

## 5. Count reconciliation and current catalog shape

- Registry: 31 core rows, broken down 4/6/7/5/6/3; workflows add three distinct `process` entries (`lib/endpoints/registry.ts:69-108,111-167,170-234,237-280,283-334,337-402`).
- The legacy service catalog is runtime-derived from every registry entry (`app/api/v1/services/route.ts:28-65`; `lib/endpoints/registry.ts:408-424`). With all entries enabled, the registry helper yields 34 entries (31 core + 3 workflows); per-profile disable flags can reduce a response (`services/route.ts:33-42`).
- The OpenAPI endpoint is generated from `getAllEndpointSlugs()` and the first six core service groups (`app/api/swagger/route.ts:1-18`). It derives each route from `SERVICE_REGISTRY.route` and derives the enum from registered sub-case values (`:15-18,38-42`). Its generated request schema says required fields are `file` and the discriminator (`:25-41`), while the route normalizer supports four file field names (`lib/endpoints/runner.ts:32-53`). The generator adds basic operation list/detail paths (`app/api/swagger/route.ts:72-96`) but does not add the workflows route, operations cancel/resume/download, `/api/v1/services`, or billing paths in this generator (`:8-18,72-96`).
- A currently present rework coordination snapshot says “Six actions/28 variants” (`du-rework/coordination/WORKLOAD-REBALANCE-04.md:14,40,45,48`). The inspected current manifest says 31 variants (`businesses/document-core/src/manifest/document-core.manifest.ts:15`) and its six discriminator enums total 31 (`:35,79,112,146,182,217`); the inspected recipes likewise have 31 core keys (`recipe-definitions.ts:25-422`). The 28 count is therefore stale relative to the code read for this receipt, not the count produced by the legacy runtime service catalog.

## 6. Mismatch ledger (evidence only)

| Mismatch | Evidence |
|---|---|
| Core route path in route-file comment omits `/docs`; README and API design tables also publish the shorter path. | Example route comment says `app/api/v1/ingest/route.ts` (`app/api/v1/docs/ingest/route.ts:1`), while the actual file is under `app/api/v1/docs/` and registry route is `/api/v1/docs/ingest` (`registry.ts:70-75`). README table uses `/api/v1/ingest` (`README.md:30,135`); the design proposal uses the short path for all six (`docs/API_DESIGN_PROPOSAL.md:49-54,617-622`). `docs/API_PROFILES_SPEC.md:11,130` shows the `/docs/` path. The six route file comments all carry the same shorter-prefix discrepancy (`app/api/v1/docs/{ingest,extract,analyze,transform,generate,compare}/route.ts:1`). |
| A system sequence diagram describes a JSON body for extract; the live runner reads multipart form data. | Documentation shows `body: { type: "invoice", files }` (`docs/SOLUTION_ARCHITECTURE.md:446`); the route calls `req.formData()` (`lib/endpoints/runner.ts:84`) and generated OpenAPI declares `multipart/form-data` (`app/api/swagger/route.ts:25-29`). |
| The OpenAPI request schema presents `file` as the only file property and required, while the route normalizer collects `files[]`, `source_file`, `target_file`, and `file`; the six core route adapters themselves do not enforce a file minimum. | Generator `required: ['file', discriminator]` / `file` property (`app/api/swagger/route.ts:25-41`); normalizer field collection (`lib/endpoints/runner.ts:32-53`); core runner has no file-count check between normalization and submit (`:125-156,234-248`). |
| API design/README route paths are stale; API_PROFILES_SPEC has the current `/docs` path. | `README.md:30-35,135-140`; `docs/API_DESIGN_PROPOSAL.md:49-54,617-622`; compared with `registry.ts:70-75,112-117,171-176,238-243,283-289,337-343` and `docs/API_PROFILES_SPEC.md:130,165,206,244,274,304`. |
| Transform discriminator differs across the legacy and rework input schemas. | Legacy requires the `action` discriminator (`registry.ts:238-243`; `runner.ts:112-123`); rework declares `variant` as the enum and `action` as a legacy alias, with no required fields (`document-core.manifest.ts:143-155`). |
| Rework uses a narrower/different output format field shape than the legacy form route. | Legacy `output_format` allows `md/json/html/csv` and defaults to `json` (`registry.ts:40`); the runner reads `output_format` (`runner.ts:225-226`); rework ingest exposes camel-case `outputFormat` with `json/md/text` (`document-core.manifest.ts:35-39`). |
| Rework input field names/types differ for custom extract and fact-check. | Legacy custom extract declares string `fields` and string `schema` (`registry.ts:43-45,158-167`); rework declares `fields` array-or-string and `schema` object (`document-core.manifest.ts:79-85`). Legacy fact-check declares string `reference_data` and `extract_fields` (`registry.ts:49-50,203-211`); rework uses camel-case `referenceData` and `extractFields`, with object/string or array/string types (`document-core.manifest.ts:112-119`). |
| Rework compare requires structured source and target properties, while legacy compare selects `mode` and receives file fields through the common multipart normalizer. | Rework requires `mode`, `source`, and `target` (`document-core.manifest.ts:214-223`); legacy `mode` cases and optional per-case fields are in `registry.ts:337-369`, and file normalization is `runner.ts:32-53`. |
| Legacy disbursement process form shape differs from rework disbursement action input shape; two legacy workflow processes have no counterpart in the inspected rework manifest/recipe set. | Legacy route requires `process` and at least one file, and the only declared process variable is `resolution_data` (`registry.ts:372-402`; `app/api/v1/docs/workflows/route.ts:20-41,31-34`). Rework disbursement requires `inputVersion`, `artifactIds`, `fileNames`, and `failurePolicy` (`document-core.manifest.ts:243-268`). Rework exposes a disbursement workflow recipe only (`recipe-definitions.ts:425-457`); no `lc-checker` or `doc-compare` target is in the inspected action/recipe files (`manifest.ts:26-333`; `recipe-definitions.ts:22-440`). |
| API design proposal names processor and health endpoints that are not present in the current `app/api/v1` route inventory. | Proposal lists `GET /api/v1/processors` and `GET /api/v1/health` (`docs/API_DESIGN_PROPOSAL.md:55-57,623-625`); current route inventory consists of services, operations, docs, and billing handlers (`rg --files app/api/v1`, recorded in §8). |
| Transform translation description references target language/tone, but the registry gives `translate` no parameters; `target_language` exists only as a reusable constant and is not attached to this sub-case. | `PARAMS.target_language` at `registry.ts:53`; translate description/empty parameter object at `:252-257`. `PARAMS.tone` is attached to rewrite (`:258-265`). |
| Registry exposes `language` options `vi/en/ja/zh`, while ingest OCR description gives `vie,eng` as its example. | `registry.ts:41,84-91` (OCR description at `:86`). |
| Compare documentation says two files are required, but the core route normalizer only collects files and does not enforce the count at this adapter boundary. This receipt does not infer downstream validation. | `docs/API_PROFILES_SPEC.md:304`; `normalizeFiles` and route pass-through (`lib/endpoints/runner.ts:32-53,125-156,234-248`). |
| Workflow schema guide plan text says there is no API to trigger a schema workflow; the route exists in the current tree. | `docs/fix-plan-workflow-builder.md:151-161`; `app/api/v1/docs/workflows/schema/route.ts:15-27`. |
| A rework coordination count of 28 conflicts with the current checked-in manifest and recipe map count of 31. | `du-rework/coordination/WORKLOAD-REBALANCE-04.md:14,40,45,48`; current manifest description/enums (`businesses/document-core/src/manifest/document-core.manifest.ts:15,35,79,112,146,182,217`); recipe keys (`businesses/document-core/src/recipes/recipe-definitions.ts:25-422`). The legacy runtime catalog helper itself is registry-driven (`lib/endpoints/registry.ts:408-424`). |
| Rework recipe grouping comment says Analyze (5), but the recipe map contains seven analyze keys. | Comment `businesses/document-core/src/recipes/recipe-definitions.ts:154`; keys include classify, sentiment, compliance, quality, risk, fact-check, summarize-eval at `:155-248`. |
| Core and workflow wire discriminators/fields are not uniform: core uses each registry discriminator; workflow code path has its own required `process` and its own fixed 202 response; schema workflow uses `schemaSlug` + JSON-string `input`. | Core lookup/response (`lib/endpoints/runner.ts:112-123,225-276`); workflow (`registry.ts:372-402`; `app/api/v1/docs/workflows/route.ts:19-45,99-115`); schema route (`app/api/v1/docs/workflows/schema/route.ts:18-48,95-109`). |

## 7. MUST-NOT-REPLICATE observations

These are labels on observed legacy behavior, not implementation guidance; no replacement behavior is proposed.

- **Client-selected identity and privileged fallback:** the two workflow handlers read a form `apiKeyId` and contain fallback identity-selection code. **MUST-NOT-REPLICATE** (`app/api/v1/docs/workflows/route.ts:47-86`; `app/api/v1/docs/workflows/schema/route.ts:58-79`). These fields are excluded from the business input matrix.
- **List without resolved identity:** operations list adds an API-key filter only when `x-api-key-id` is present; no key resolution occurs in this handler. **MUST-NOT-REPLICATE** (`app/api/v1/operations/route.ts:35-38`).
- **Vacuous optional fences:** detail, cancel, and download compare operation ownership only when `x-api-key-id` is present; resume has no such check in the handler. **MUST-NOT-REPLICATE** (`app/api/v1/operations/[id]/route.ts:29-35`; `app/api/v1/operations/[id]/cancel/route.ts:24-30`; `app/api/v1/operations/[id]/download/route.ts:29-35`; `app/api/v1/operations/[id]/resume/route.ts:20-33`).
- **Direct terminal state write:** cancel writes `done=true` and `state='CANCELLED'` in the route. **MUST-NOT-REPLICATE** (`app/api/v1/operations/[id]/cancel/route.ts:39-45`).
- **Identity header as selector:** services and billing read `x-api-key-id` directly. **MUST-NOT-REPLICATE** (`app/api/v1/services/route.ts:9-22`; `app/api/v1/billing/balance/route.ts:17-29`; `app/api/v1/billing/usage/route.ts:24-28`).

## 8. Read-only evidence / completion

No tests were run (the dispatch spec does not require tests). The route inventory command was `rg --files app/api/v1 | Sort-Object`; its literal output was:

```text
app/api/v1\billing\balance\route.ts
app/api/v1\billing\usage\route.ts
app/api/v1\docs\analyze\route.ts
app/api/v1\docs\compare\route.ts
app/api/v1\docs\extract\route.ts
app/api/v1\docs\generate\route.ts
app/api/v1\docs\ingest\route.ts
app/api/v1\docs\transform\route.ts
app/api/v1\docs\workflows\route.ts
app/api/v1\docs\workflows\schema\route.ts
app/api/v1\operations\[id]\cancel\route.ts
app/api/v1\operations\[id]\download\route.ts
app/api/v1\operations\[id]\resume\route.ts
app/api/v1\operations\[id]\route.ts
app/api/v1\operations\route.ts
app/api/v1\services\route.ts
```

The registry check `rg -n "required:" lib/endpoints/registry.ts` produced no matches; the only declaration is optional `required?: boolean` on `ParamSchema` (`registry.ts:7-14`). The runtime helper is registry-derived (`lib/endpoints/registry.ts:67-404,408-424`). The 31 rows above reconcile the core count; three workflow processes are separate. No gate was ticked, no commit was created, and no source file was changed.
