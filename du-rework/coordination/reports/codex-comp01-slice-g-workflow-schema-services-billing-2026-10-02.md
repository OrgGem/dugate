# COMP-01 Slice G — workflow-schema + services/billing deep matrix (field-level)

**Task:** `task_f20d81a46628` · **Date:** 2026-10-02 · **Status:** characterization only.
**READ-ONLY. No file was modified** except this receipt. No tests were run (not required by the spec); every number below is a source read, and read commands are recorded in §7.

Slice A already settled route shape for services/billing/workflows, so this receipt goes one level down: **fields, validation rules, and keying**. Route-shape is not repeated. PAR-00 (journey/cutover) and slice C (process→business) are not touched.

## 1. Schema CRUD route — ops → validation → slug → UI caller

Base path `/api/internal/workflow-schemas` (`app/api/internal/workflow-schemas/route.ts`, 67 lines).

| Op | Method + inputs | Auth | Validation | Success | Errors |
|---|---|---|---|---|---|
| List | `GET` no params | `requireAdmin` (`:14`) | none | `200 {schemas:[{slug,name}]}` (`:24-25`) | guard only |
| Detail | `GET ?slug=<slug>` | `requireAdmin` (`:14`) | none; `loadSchema` null → 404 (`:19-22`) | `200 {schema}` (`:20`) | 404 `Schema not found` |
| Save/upsert | `POST` body `{schema}` **or** `{xml}` | `requireAdmin` (`:29`) | `validateSchema` (`:44-47`) | `201 {ok:true,schema}` (`:50`) | 400 neither field (`:40-41`); 400 validation list; 400 thrown parse (`:52-55`) |
| Delete | `DELETE ?slug=<slug>` | `requireAdmin` (`:58`) | slug presence only (`:61-62`) | `200 {ok:true}` (`:64`) | 400 slug absent |

**Both body shapes are accepted in one POST and XML wins on conflict** — `body.xml` is tested before `body.schema` (`:36-39`), so a body carrying both ignores the JSON.

### 1.1 Validation rules — the complete list

`validateSchema` (`lib/workflow-builder/interpreter.ts:38-70`) returns a **string list**, it does not throw. Four structural checks with an early return (`:47`), then per-node and flow checks.

| # | Rule | Message | Line |
|---|---|---|---|
| V1 | schema is a non-null object | `Schema must be an object` | `:40` |
| V2 | `slug` truthy | `Schema requires a slug` | `:42` |
| V3 | `flow` is a non-empty array | `Schema requires a non-empty flow` | `:43` |
| V4 | `nodes` is an array | `Schema requires a nodes array` | `:44` |
| V5 | node ids unique | `Duplicate node id` + id | `:50` |
| V6 | `type` in the 10-name SUPPORTED list | `Unsupported node type` + type/id | `:58` |
| V7 | `connector` nodes carry a `connector` slug | `Connector node ... requires a connector slug` | `:60` |
| V8 | every `flow` id resolves to a node | `Flow references missing node` + id | `:68` |

`SUPPORTED` is exactly 10 names — `connector, parallel, join, file_parse, file_url_download, callback, archive_compress, archive_extract, human, input` (`:53-55`) — matching `NodeType` in `lib/workflow-builder/types.ts:22-32`.

**What V1–V8 do NOT check** (all read as absent from `:38-70`): that a `connector` slug exists in `externalApiConnections`; that any `$binding` resolves; that `name` is present; that `flow` is acyclic or that `parallel` branches terminate; that `input_schema` properties are well formed; that `join.combine` is one of its three declared values; that `archive_extract.maxTotalBytes` / `maxEntries` are numeric; that `file_url_download.allowedExtensions` is present. The override route also re-saves the loaded schema without re-validating (`app/api/internal/workflow-schemas/override/route.ts:32-46`).

### 1.2 Slug handling

| Concern | Behaviour | Evidence |
|---|---|---|
| storage | one `appSettings` row per schema, key `wb_schema:<slug>` | `loader.ts:10,13` |
| write | throws when `slug` falsy, then **upsert** on key conflict | `loader.ts:12-18` |
| read | exact key match; `JSON.parse` failure returns `null`, so a corrupt row reads as absent | `loader.ts:20-33` |
| delete | unconditional `DELETE` by key, **no existence check** — a missing slug still returns ok | `loader.ts:35-37`; `route.ts:63-64` |
| list | scans **all** `appSettings` rows and keeps the prefix; on parse failure uses the key suffix as `slug` and the full key as `name` | `loader.ts:39-52` |
| sanitisation | **none** — no lowercase, charset, length or separator rule anywhere | absence across `loader.ts`, `interpreter.ts:38-70`, `route.ts` |

POST is therefore an **upsert, not a create**: posting an existing slug overwrites silently, with no version comparison and no conflict response (`:49-50`).

### 1.3 XML import shape

`xmlToSchema` (`lib/workflow-builder/xml-converter.ts:14-173`), attribute prefix `@_`.

| XML | JSON | Note |
|---|---|---|
| `<workflow slug name version description>` | `slug, name, version, description` | `slug` defaults to empty string (`:25`); `name` defaults to `slug` (`:26`); `version` defaults to 1 through `Number()` (`:160`) |
| `<input><property name type required label widget description>` | `input_schema.properties{}` | `required` is true **only** for the exact string `true` (`:38`); `type` defaults `string` (`:37`); a property with no `name` is skipped (`:35`) |
| `<nodes><node id type .../>` | `nodes[]` | missing `<nodes>` throws (`:48`); unknown type throws (`:143`) |
| `<flow><step id/></flow>` | `flow[]` | steps with no `id` are dropped (`:153`) |
| `<output from extra_data_from/>` | `output{from, extra_data_from}` | only when `<output>` is present (`:167-170`) |

The XML switch covers the same 10 types (`:59,76,91,96,102,108,115,123,129,137`). `input_schema` is omitted entirely when no property survives (`:162`). `schemaToXml` exists (`:246`) but is referenced only from `tests/workflow-builder/xml-converter.test.ts:2,42` — **no route exposes XML export**, so XML is import-only.

### 1.4 UI caller — what the builder page actually uses

| UI action | Call | Line |
|---|---|---|
| list | `GET /api/internal/workflow-schemas` | `app/workflow-builder/page.tsx:159` |
| detail | `GET ?slug=` | `:173`, `:247` |
| import | `POST` with `{xml}` when the filename ends `.xml`, else `{schema: parsed}`; a JSON parse error becomes a toast | `:191-204` |
| delete | `DELETE ?slug=` behind `confirm()` | `:222-224` |
| run, legacy path | `submitRunSchema` to `POST /api/v1/docs/workflows/schema` | `:306-318` |
| run, du path | `submitDuAdapterFlow` when `decideRunEngine` selects it | `:298-303` |
| mappings | `GET …/pipeline-mappings?slug=`, local edits keyed by `nodeId` | `:974-983` |
| override save | `PUT …/override` with `{slug, nodeId, overrides}` | `:992-995` |

The multipart body the UI composes is `schemaSlug` always, `input` as a JSON string only when non-empty, and `files[]` per file (`app/workflow-builder/run-schema-client.ts:92-100`).

**Two UI-only behaviours with no server counterpart:**

| Behaviour | Where | Server equivalent |
|---|---|---|
| required-field check on run | `findMissingRequiredField` (`run-schema-client.ts:70-83`), called at `page.tsx:284-291`; treats undefined, null and empty string as missing | **none** — the run route only `JSON.parse`s `input` (`app/api/v1/docs/workflows/schema/route.ts:40-48`) |
| engine selection | `schema.useDuAdapter` tri-state at `page.tsx:260-261,298` | **none** — `useDuAdapter` is not a field of `WorkflowSchema` (`types.ts:157-168`) and `validateSchema` never mentions it |
## 2. Services + billing, field-level

### 2.1 `GET /api/v1/services` — response fields

Handler `:8`, guard at `:9-22` (**`x-api-key-id` — see §6 for the MUST-NOT-REPLICATE reference**). No query and no body field is read. Enumeration comes from `getAllEndpointSlugs()` (`:29`), so the catalog is registry-derived and per-profile filtered.

| Path in body | Type | Source | Note |
|---|---|---|---|
| `status` | number | `:70` | literal 200 |
| `message` | string | `:71` | fixed Vietnamese string |
| `services[]` | array | `:72` | one entry per **enabled** registry service |
| `services[].serviceId` | string | `:46` | registry slug |
| `services[].serviceName` | string | `:47` | registry `displayName` |
| `services[].discriminatorKey` | string | `:48` | `mode` / `type` / `task` / `action` / `process` |
| `services[].subCases[]` | array | `:60` | id is the sub-case key, or `_default` when the value is null |
| `services[].subCases[].id` | string | `:61` | |
| `services[].subCases[].displayName` | string | `:62` | |
| `services[].subCases[].description` | string | `:63` | |
| `services[].subCases[].clientParameters` | object | `:64` | `parametersSchema` minus `defaultLocked` (`:53-56`) |

**Filtering, in order** (`:33-42`): an entry is dropped when a `profileEndpoints` row exists for **either** the full `service:variant` slug **or** the bare service slug with `enabled === false`. A service-level lock therefore removes all of its sub-cases.

**`clientParameters` is a projection that currently never filters anything.** The `defaultLocked` test at `:55` is the only filter, and no registry parameter sets `defaultLocked` — the field is declared once, at `registry.ts:14`, and never assigned. So for every entry this object equals the raw `parametersSchema`. Slice A recorded the same observation for the declared-but-unattached parameters; this is the *lock* side of it and is a separate mechanism.

### 2.2 `GET /api/v1/billing/balance` — fields and units

Handler `:17`; guard `:19-21`. No query or body field. Reads the `apiKeys` row for the presented key id (`:26-33`).

| Path in body | Unit / domain | Derivation | Line |
|---|---|---|---|
| `object` | literal `billing_balance` | constant | `:40` |
| `api_key_id` | uuid string | `apiKeys.id` | `:41` |
| `api_key_name` | string | `apiKeys.name` | `:42` |
| `currency` | ISO code, literal `USD` | constant — **not** read from any column | `:43` |
| `details.spending_limit` | **USD, major units** | `spendingLimit` when `> 0`, else `null` | `:45` |
| `details.total_used` | USD, same unit | `apiKeys.totalUsed` | `:46` |
| `details.balance` | USD | `spendingLimit − totalUsed` when limit `> 0`, else `null` | `:36` |
| `updated_at` | ISO-8601 string | `new Date().toISOString()` — **request time**, not a stored key timestamp | `:49` |

Two field-level notes: `spendingLimit` is not selected into the response as a raw column, only through the two derived fields (`:28-32`), and **`balance` can go negative** because the subtraction is unguarded (`:36`) — nothing clamps it at zero, and nothing rejects a `totalUsed` above the limit.

### 2.3 `GET /api/v1/billing/usage` — params, filters, units

Handler `:24`; guard `:26-28`.

| Param | Domain | Default | Validation | Line |
|---|---|---|---|---|
| `start_date` | date | now − 30 days (`30 * 24 * 60 * 1000`) | `new Date(...)`; `NaN` → 400 | `:33-34`, `:37-39` |
| `end_date` | date | now | `T23:59:59Z` appended when supplied; `NaN` → 400 | `:35`, `:37-39` |

Filters, all conjunctive (`:49-56`): `apiKeys.id` match · `state = SUCCEEDED` (`:52`) · `done = true` (`:53`) · `createdAt >= start` · `createdAt <= end`. Rows are grouped by `modelUsed`, falling back to the literal `unknown` when the column is null (`:60`).

| Path in body | Unit / domain | Derivation | Line |
|---|---|---|---|
| `object` | literal `billing_usage` | constant | `:87` |
| `start_date` | **date only** | `toISOString().split(T)[0]` — response drops the time the query used | `:88-89` |
| `end_date` | date only | same | `:89` |
| `total_cost_usd` | USD | summed per row | `:90` |
| `total_input_tokens` | token count | summed per row | `:91` |
| `total_output_tokens` | token count | summed per row | `:92` |
| `total_operations` | count | `opsList.length` | `:93` |
| `usage[].model` | string | `modelUsed ?? "unknown"` | `:60`, `:77` |
| `usage[].prompt_tokens` | token count | summed per model | `:75` |
| `usage[].completion_tokens` | token count | summed per model | `:76` |
| `usage[].pages_processed` | page count | summed per model | `:78` |
| `usage[].cost_usd` | USD | summed per model | `:79` |

There is **no currency parameter and no currency field** on this response, unlike `balance` which pins `USD`; cost is carried in a field name suffix instead. The date round-trip also means a caller cannot recover which instant `end_date` resolved to — the `T23:59:59Z` applied on input is not echoed.

## 3. Mappings / override keying matrix

There are **three independent override mechanisms**, with different keys, different storage, and different auth. They are easy to conflate and none of them references another.

| Mechanism | Key | Stored in | Mergeable fields | Auth |
|---|---|---|---|---|
| **A.** per-node connector override | `(schemaSlug, nodeId)` | inside the schema JSON, on the connector node | `prompt`, `staticFormFields`, `extraHeaders`, `responseContentPath`, `timeoutSec` | `requireAdmin` (`override/route.ts:10`) |
| **B.** connection/profile prompt override | `(connectionId, apiKeyId, endpointSlug, stepId)` | `externalApiOverrides` table | `promptOverride` only | `requireProfileAccess(apiKeyId)` + admin check on the endpoint (`ext-overrides/route.ts:33,71,80-85`) |
| **C.** pipeline mapping (read-only projection) | `slug` → `nodeId` → `connectorSlug` | not stored; joins schema nodes to `externalApiConnections` | n/a (GET) | `requireAuth` — **not** `requireAdmin` (`pipeline-mappings/route.ts:14`) |

### 3.1 Mechanism A — per-node override (`PUT …/workflow-schemas/override`)

| Aspect | Behaviour | Line |
|---|---|---|
| required body | `slug`, `nodeId`, `overrides` all truthy, else 400 | `:15-19` |
| node lookup | must exist **and** be `type === "connector"`, else 404 | `:25-28` |
| merge | field-by-field, only keys whose value is not `undefined` — existing values survive | `:33-39` |
| empty result | `overrideConnector` deleted when the merged object has no keys | `:42-44` |
| persist | `saveSchema` — a whole-row upsert, so it also refreshes `updatedAt` | `:46` |
| unknown override keys | **silently ignored** — only the 5 named fields are read | `:33-39` |

### 3.2 Mechanism B — connection/profile override (`…/ext-overrides`)

| Aspect | Behaviour | Line |
|---|---|---|
| required body | `connectionId`, `apiKeyId`, `endpointSlug` (all truthy) | `:65-70` |
| `stepId` default | `stepId ?? "_default"` | `:62` |
| upsert target | the **4-column tuple** `connectionId, apiKeyId, endpointSlug, stepId` | `:121-123` |
| value | `promptOverride?.trim() ?? null` — stored trimmed, or null | `:118`, `:122` |
| deactivation | `isActive === false` deletes that exact 4-tuple | `:100-107` |
| existence | `connectionId` and `apiKeyId` each checked against their table, 404 when absent | `:88-97` |
| non-admin | the target `profileEndpoints` row must exist **and** be `enabled`, else 403 | `:80-85` |
| **DELETE width** | keys on **`(connectionId, apiKeyId)` only** — narrower than POST, so it removes every `endpointSlug` and `stepId` row for that pair | `:151-153` |

The DELETE/POST asymmetry in the last row is the sharp edge here: a caller who deletes one step to fall back to a default also silently discards overrides for every other step and endpoint on that connection.

### 3.3 Mechanism C — pipeline mappings (read-only)

`GET …/pipeline-mappings?slug=` returns one row per **connector node** in the schema, keyed `nodeId` (`:77`). A node whose `connector` slug has no matching DB row is **omitted silently** (`:72-73`) rather than reported. Each row carries the connector defaults (`defaultPrompt`, `staticFormFields`, `extraHeaders`, `responseContentPath`, `timeoutSec`) alongside `currentOverrides` read from the node (`:79-86`), which is exactly what the builder page renders as editable fields. `authSecret` is replaced by a fixed mask string when present and an empty string when absent (`:37`) — masked, and not otherwise projected into the response.

## 4. MISMATCH ledger — doc claim vs code

Docs compared: `docs/workflow-schema-guide.md` (713 lines, the schema guide), `docs/fix-plan-workflow-builder.md`, and slice A's already-settled entries. Evidence is source read only.

| ID | Doc claims | Code does | Evidence |
|---|---|---|---|
| **G-01** | trigger-run body field is `files` (file array) | the normalizer reads `files[]`, `source_file`, `target_file`, `file` — never `files`; the UI itself sends `files[]` | `workflow-schema-guide.md:593`; `lib/endpoints/runner.ts:36-56`; `run-schema-client.ts:99` |
| **G-02** | `slug` is `[REQUIRED] Unique ID, lowercase, no spaces` | only truthiness is checked; no format, case, charset or length rule exists | `workflow-schema-guide.md:44`; `interpreter.ts:42` |
| **G-03** | `name` is `[REQUIRED]` | `validateSchema` never inspects `name`; a nameless schema validates and saves (the XML path papers over it by defaulting `name` to `slug`, the JSON path does not) | `workflow-schema-guide.md:45`; `interpreter.ts:38-70`; `xml-converter.ts:26` |
| **G-04** | `version` defaults to 1 on import | true for the XML path only; a JSON import stores whatever `version` the body carries, including absent | `workflow-schema-guide.md:46`; `xml-converter.ts:160`; `route.ts:38-39` |
| **G-05** | `join.combine = "merge"` merges objects | the runner has one branch — `first` yields element 0, **every other value including `merge` yields the raw array** | `workflow-schema-guide.md:171,179`; `interpreter.ts:130-137` |
| **G-06** | a connector node's `connector` must be a slug of an `ExternalApiConnection` that exists | V7 only checks the field is truthy; a dangling slug passes validation and fails later at execution | `workflow-schema-guide.md:32`; `interpreter.ts:60` |
| **G-07** | every `$binding` must point at a real node / input / file | `validateSchema` never reads a binding | `workflow-schema-guide.md:34`; `interpreter.ts:38-70` |
| **G-08** | `input_schema.properties[].required` means the field is mandatory | enforced **only in the browser** by `findMissingRequiredField`; the run route accepts any `input` JSON without checking it | `workflow-schema-guide.md:68`; `run-schema-client.ts:70-83`; `schema/route.ts:40-48` |
| **G-09** | — (undocumented field) | the UI reads `schema.useDuAdapter` to pick the execution engine, but the field is absent from `WorkflowSchema` and unvalidated, so an arbitrary value rides in the stored JSON | `page.tsx:260-261,298`; `types.ts:157-168` |
| **G-10** | — (dispatch spec path) | the dispatch spec cites `app/api/internal/pipeline-mappings/route.ts`; the file is actually `app/api/internal/workflow-schemas/pipeline-mappings/route.ts` | dispatch spec §"Được phép đọc"; directory listing |

G-01 and G-05 are the two that change behaviour for a caller following the guide; G-08 and G-09 are the two that change it for an operator who assumes the server is checking.

## 5. Cross-reference to MUST-NOT-REPLICATE (slice A §7)

Not re-analysed here, by instruction. Recorded only so the field-level reader knows these fields exist in the shapes above:

- The run route documents and reads an optional `apiKeyId` form field with an ADMIN-key default — the run body in §1.4 is the caller-facing surface for it. **MUST-NOT-REPLICATE** (slice A).
- `services` and both `billing` routes fence on the edge-supplied `x-api-key-id` header — the guards in §2.1–§2.3 are that mechanism. **MUST-NOT-REPLICATE** (slice A).

One field-level detail belongs with the second item rather than in the ledger above: mechanism B (`ext-overrides`) resolves its identity through `requireProfileAccess(apiKeyId)` and a NextAuth session role, **not** through a trusted header, so it is the one override surface in this set whose authorization is not header-dependent. Stated as an observation about shape, not as a design proposal.

## 6. Not done / limits

- **No file was modified.** The only file written is this receipt. No source, test, task row, manifest, contract or gate was touched.
- **No tests run** — the spec did not require them, and characterization here is static. §7 lists the read commands actually run so the numbers can be reproduced.
- **Not read:** `server.ts` (excluded by the spec), `contracts`, `tasks/*.md`, `AGENTS.md`, the execution overlay, and `businesses/document-core/**` (D3 lease).
- **No secret or key value was read** — only field names, types and `file:line`. Where a mask exists it is described, not bypassed.
- **Nothing implemented, mapped or projected.** COMP-00 has not settled, so no replacement behaviour is proposed for any observation here; the ledger is evidence.
- **No gate ticked, nothing committed**, and no other lane's uncommitted work was reverted.

## 7. Read commands used (literal)

```
npx tsc --noEmit                       # not required; NOT run
npx jest                               # NOT run
```

All findings come from `read_file` on the allowed paths plus `grep_search`/`glob` for line pinning and the cross-reference. The line numbers in §1–§4 were produced by a line-pinning scan over:

```
app/api/internal/workflow-schemas/route.ts
app/api/internal/workflow-schemas/override/route.ts
app/api/internal/workflow-schemas/pipeline-mappings/route.ts
app/api/internal/ext-overrides/route.ts
app/api/v1/services/route.ts
app/api/v1/billing/balance/route.ts
app/api/v1/billing/usage/route.ts
app/api/v1/docs/workflows/schema/route.ts
lib/workflow-builder/{types,loader,interpreter,xml-converter}.ts
app/workflow-builder/{page.tsx,run-schema-client.ts}
docs/{workflow-schema-guide,fix-plan-workflow-builder}.md
```

One spec-path discrepancy is recorded rather than silently corrected: the dispatch names `app/api/internal/pipeline-mappings/route.ts`, and the real path is `app/api/internal/workflow-schemas/pipeline-mappings/route.ts` (see G-10). I read the file that exists.