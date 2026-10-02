# COMP-03b-adjacent — strict legacy input decoder + legacy operation serializer (UNMOUNTED)

- **Recorded:** 2026-10-01. **Mode:** implementation, module level only.
- **Status: PURE, UNMOUNTED, UNFROZEN.** No route mount, no contract freeze. These are evidence-ready modules for COMP-00/COMP-02, which have not decided anything.

## 1. Files written (my entire footprint)

| File | Bytes | Status |
|---|---|---|
| `du-rework/services/orchestrator/src/compat/legacy-input-decoders.ts` | 19,048 | NEW |
| `du-rework/services/orchestrator/src/compat/legacy-operation-serializers.ts` | 10,775 | NEW |
| `du-rework/services/orchestrator/tests/compat-decoders.test.ts` | 43 tests | NEW |

**Additive export lines added to EXISTING compat files: NONE.** `legacy-action-router.ts`, `legacy-wire-decoders.ts`, `legacy-operations.ts`, `legacy-headers.ts` were read only and are byte-unchanged.

**Lease respected.** `packages/contracts`, `server.ts`, `main.ts`, `docs/21-openapi.json`, `tasks/*.md`, `gates/*` — none written. `main.ts` shows as modified in `git status`; its diff is another lane's admin-shell env wiring (`ORCHESTRATOR_PORT`, `ADMIN_SHELL_COOKIE_SECRET`) with no `compat`/`legacy` reference. Verified, not assumed.

## 2. Legacy field -> rework field -> decoder branch

`file:line` is the branch in **`src/compat/legacy-input-decoders.ts`** unless stated otherwise. Legacy source is `lib/endpoints/runner.ts` + `lib/endpoints/registry.ts`.

| Legacy field | Rework field | Decoder branch | Legacy origin | Notes |
|---|---|---|---|---|
| `mode` (ingest/compare) | `input.variant` | `:133-147` pickDiscriminator | `registry.ts:74,342` | also accepts `variant`/`discriminator` aliases |
| `type` (extract) | `input.variant` | same | `registry.ts:116` | |
| `task` (analyze/generate) | `input.variant` | same | `registry.ts:175,288` | |
| `action` (transform) | `input.variant` | same | `registry.ts:242` | |
| — (computed) | `endpointSlug` | `:206` | `runner.ts:151-155` | `service:variant` dialect |
| declared `PARAMS.*` | `input.<camelCase>` | `:176-180` | `registry.ts` per-variant `parameters` | only params the registry ATTACHES |
| `output_format` | `output.format` | `:169`, default `'json'` at `:196` | `runner.ts:226` | default matches legacy's `?? 'json'` |
| `webhook_url` | `callback.url` | `:172`, `:187` | `runner.ts:227` | |
| `callback` | `callback.url` | `:178-186` | — | strict object form |
| `source_url` | `sourceUrl` | `:170`, `:199` | — | capped 2048 per contract |
| `file_urls` (JSON array) | `input.fileUrls` | `:183`, `:194` | `runner.ts:100-133` | |
| `files[]`,`file`,`source_file`,`target_file` | (file parts, not submission) | `:481-499` | `runner.ts:36-54` | roles preserved |
| `sync` (query only) | `executeSync` | `:205` | `runner.ts:228` | body `sync` ignored |
| `idempotency-key` (header) | `idempotencyKey` | `:203` | `runner.ts:228` | |
| `x-correlation-id` (header) | `correlationId` | `:204` | `runner.ts:58` | |
| **`x-api-key-id`** | **REJECTED** | `:213-227` | `app/api/internal/profile-endpoints/route.ts:110` | legacy vulnerability |
| **`apiKeyId` / `api_key_id` / `xApiKeyId`** | **REJECTED** | `:229-241` | `docs/workflows/schema/route.ts:59` | legacy vulnerability |
| **`tenantId`/`userId`/`authorization`/`role`** | **REJECTED** | `:229-241` | same | |
| **any unlisted field** | **REJECTED** | `:158-163` | — | legacy silently dropped |

Serializer side (`legacy-operation-serializers.ts`):

| Canonical field | Legacy field | Branch |
|---|---|---|
| `state` | `metadata.state` + `metadata.canonical_state` | `:170-183` |
| `state` (terminal only) | `done` | `:167` |
| `state === 'SUCCEEDED'` | `result{output_format,content,extracted_data,pipeline_steps,usage,download_url}` | `:189-207` |
| `error` (supplied only) | `error{code,message,failed_step}` | `:210-215` |
| `(updatedAt ?? createdAt, id)` | `next_page_token` | `:243-262` |

## 3. Per-variant allow-list (measured, not assumed)

Extracted by brace-counting every `parameters: { ... }` block in `registry.ts` and listing its `PARAMS.*` references:

- **ingest** parse `[output_format, language]` · ocr `[language]` · digitize `[]` · split `[pages]`
- **extract** invoice/contract/id-card/receipt/table `[]` · custom `[fields, schema]`
- **analyze** classify `[categories]` · sentiment `[]` · compliance `[criteria]` · fact-check `[reference_data, extract_fields]` · quality `[criteria]` · risk `[]` · summarize-eval `[]`
- **transform** convert `[output_format]` · translate `[]` · rewrite `[style, tone]` · redact `[]` · template `[template]`
- **generate** summary `[]` · outline `[format]` · report `[]` · email `[tone]` · minutes `[format]` · qa `[questions]`
- **compare** diff `[output_format]` · semantic `[focus]` · version `[output_format]`

**Consequence:** the seven registry-declared-but-unattached params (`type`, `focus_areas`, `target_language`, `glossary`, `redact_patterns`, `max_words`, `audience`) are rejected here as unknown. Legacy silently dropped them. This is an intentional strictness divergence and is covered by a test per field.

## 4. Relationship to the COMP-02 decoder — deliberate, not contradiction

`legacy-wire-decoders.ts` (COMP-02) is **lenient**: it drops unknown fields and never rejects. This module is **strict**. Both can coexist — COMP-02 answers "what did the client mean?", this answers "is this request admissible?". A request that passes COMP-02 can still be refused here. `legacy-wire-decoders.ts` is NOT imported (its `VARIANTS` map is module-private; re-declaring avoids coupling to an in-flight sibling).

## 5. Divergences raised for adjudication (not decided here)

1. **Token dialect vs COMP-06.** `legacy-operations.ts` mints `next_page_token` as a bare **operation ID**; this packet specifies the **4-slot cursor dialect**, which I implemented via `encode/decodeAdminResourceListSortCursor` from `@du/contracts`. Two dialects now exist for one field. COMP-00/COMP-02 must pick one.
2. **Fabricated error.** COMP-06's `toLegacyOperationError` synthesizes `{code:'CANCELLED', message:'Operation was cancelled'}` when a terminal state arrives with no error. That is precisely the fabrication this packet forbids, so this module is imported nowhere from there and emits `error` only when a real one was supplied. A `FAILED` operation with no error serializes as `done:true` with **no** `error` block.
3. **Envelope shape.** COMP-06 emits `response`/`error`; this emits `result`/`error` (the `formatOperationResponse` shape). Different shapes for the same surface.

## 6. Cursor round-trip is value-equal, not byte-equal

The 4-slot dialect stores microseconds and re-emits the canonical six-digit form, so `.000Z` decodes back as `.000000Z`. **This was found by a failing test I wrote, not guessed** — my first expectation was wrong, not the module. Corrected and pinned by a dedicated test.

## 7. Evidence

- **Tests:** `npx jest --runInBand tests/compat-decoders.test.ts` — **3 consecutive runs**, each `Tests: 43 passed, 43 total`, `Test Suites: 1 passed, 1 total`, ExitCode 0. Offline; no DB/Redis/S3.
- **Typecheck:** `npx tsc --noEmit -p services/orchestrator/tsconfig.json` — **ExitCode 0, zero diagnostics**, re-run against the final post-mutation-restored state.
- **Non-vacuity (mutations, each reverted and byte-verified):**
  - disable unknown-field rejection -> **3 failed**
  - disable body identity rejection -> **2 failed**
  - treat `CANCEL_REQUESTED` as terminal -> **2 failed**
  - restoration verified clean: 19,048 / 10,775 bytes.
- **Positive control:** the `x-api-key` test asserts both that the credential never appears in output AND that a control field (`fields`) from the same form does — so it cannot pass by dropping the whole body.

## 8. Gates

**No release gate ticked.** `G-ADMIN-OPS`, `G-SEC`, `G-DATA`, `G-ENC`, `G-COMP`, `G-LOCAL-ADMIN`, `G6` all remain **NO-GO** and unchanged. No commit. No other lane's changes touched.
