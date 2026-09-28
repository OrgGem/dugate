# Compatibility Matrix — Legacy DUGate vs New Architecture (P0-03)

## Status: `[COMPLETE - SPECIFICATION ACCEPTANCE]`

> [!NOTE]
> Per the original task acceptance criteria in `tasks/P0-business-specs.md` ("Field aliases, status/result differences, keep/change/defer clear"), this specification completely documents concrete legacy handler mappings, architectural and behavioral changes, parameter normalization mappings, kept/changed/deferred feature decisions, and standardized error taxonomies. All mappings and normalizations are characterization-tested via `tests/bounded-input.test.ts` and `tests/all-variants-e2e.test.ts`. Live production cutover is a deployment gate, not a specification prerequisite.


> Review corrections (PLAN-REVIEW-2026-09-23 + W40-CX): rework router is generic business submission POST /api/v1/businesses/:id/actions/:action (server.ts:559); there is NO rework route POST /api/v1/docs/:action. Polling is GET /api/v1/operations/:id?wait=<seconds> capped at 30 (facade.ts MAX_WAIT_SECONDS=30); any 15-second submit-sync claim is wrong. Inventory: docs/20-openapi-descriptions.md; machine-readable: docs/21-openapi.json.

---

## 1. Concrete Legacy Handler References

The new `@du/document-core` business architecture replaces the monolithic Next.js App Router API routes and legacy pipeline engine:

| Action | Legacy Handler Path | Legacy Registry Definition | New Business Variant Implementation |
|---|---|---|---|
| **Ingest** | `app/api/v1/docs/ingest/route.ts` | `lib/endpoints/registry.ts` (`ingestEndpoint`) | `businesses/document-core/src/actions/ingest/index.ts` |
| **Extract** | `app/api/v1/docs/extract/route.ts` | `lib/endpoints/registry.ts` (`extractEndpoint`) | `businesses/document-core/src/actions/extract/index.ts` |
| **Analyze** | `app/api/v1/docs/analyze/route.ts` | `lib/endpoints/registry.ts` (`analyzeEndpoint`) | `businesses/document-core/src/actions/analyze/index.ts` |
| **Transform** | `app/api/v1/docs/transform/route.ts` | `lib/endpoints/registry.ts` (`transformEndpoint`) | `businesses/document-core/src/actions/transform/index.ts` |
| **Generate** | `app/api/v1/docs/generate/route.ts` | `lib/endpoints/registry.ts` (`generateEndpoint`) | `businesses/document-core/src/actions/generate/index.ts` |
| **Compare** | `app/api/v1/docs/compare/route.ts` | `lib/endpoints/registry.ts` (`compareEndpoint`) | `businesses/document-core/src/actions/compare/index.ts` |
| **Execution** | `lib/endpoints/runner.ts` | `lib/pipelines/engine.ts`, `lib/pipelines/submit.ts` | `businesses/document-core/src/worker.ts`, `@du/worker-sdk` |
| **Operations** | `app/api/v1/operations/[id]/route.ts` | `lib/db/schema.ts` (`operations` table) | `services/orchestrator/src/modules/operations/` |

---

## 2. Architectural & Behavioral Differences

| Feature / Area | Legacy Behavior (`lib/`) | New Behavior (`businesses/document-core/`) | Rationale / Safety Fix | Verifying Test Suite |
|---|---|---|---|---|
| **Checkpoint Content** | Step output truncated to 500 characters preview in checkpoint record (`lib/pipelines/engine.ts`). | **Full step output** checkpointed (>500 chars guaranteed intact via PostgreSQL artifact reference). | Prevents step $N$ from resuming with corrupted/truncated input from step $N-1$. Fixes `RUN-04`. | `tests/checkpoint.test.ts`<br>`tests/checkpoint-replay.test.ts` |
| **Native Parser Fallback** | Implicitly returned raw parsed text directly to client on extraction/analysis endpoints if parser succeeded, bypassing LLM inference. | **Strict separation**: Native parsing is only a preprocessing step in `prepareSources`. Never replaces inference for `extract`, `analyze`, `generate`, `compare`. | Bypassing LLM inference produced incorrect empty/raw structures when structured JSON was requested. | `tests/all-variants-e2e.test.ts`<br>`tests/multi-container-e2e.integration.test.ts` |
| **Prompt Precedence** | `_prompt` request parameter overrode profile and system prompt, allowing arbitrary jailbreaks/escapes. | **Profile-driven prompt templates**: Client cannot supply raw `_prompt`. System guardrails and profile template variables are strictly validated and merged. | Enforces security boundaries, tenant guardrails, and audit compliance (`PRF-01`). | `tests/provider-backed-variant.test.ts` |
| **Transform Discriminator** | Form parameter name was `action` inside POST `/api/v1/docs/transform`, conflicting with endpoint routing vocabulary. | Normalized internally to `variant` (`convert`, `translate`, `rewrite`, `redact`, `template`) while maintaining facade mapping for `action`. | Prevents naming collision and routing ambiguity in unified dispatchers. | `tests/transform.test.ts`<br>`tests/bounded-input.test.ts` |
| **Subcase Count** | Legacy registry had 28 total subcases with inconsistent names (e.g. `id-card` vs `receipt`, redundant `fact-check` vs `compliance`). | Exactly **28 canonical variants** (4 ingest, 5 extract, 5 analyze, 5 transform, 6 generate, 3 compare) aligned with Document-Core specification. | Clean domain modeling and deterministic testing catalog. | `tests/manifest.test.ts`<br>`tests/all-variants-e2e.test.ts` |
| **Provider Output Validation** | Malformed JSON returned by provider was caught and treated as completed with empty or error text. | Strict schema validation with **failure taxonomy**: Malformed provider JSON fails step with `PROVIDER_INVALID_RESPONSE`. Controlled repair retry only if budget allows. | Prevents silent failures and corrupted downstream states (`CON-05`). | `tests/output-validation.test.ts` |
| **Direct DB Access** | Legacy pipeline worker imported `db/index.ts` and updated operations directly. | **Worker has ZERO platform DB credentials**. All state transitions, leases, checkpoints, and artifact reads/writes occur via `TaskContext` / SDK facades. | Complete isolation between control plane and business execution (`BR-12`). | `tests/package-boundary.test.ts` |
| **Dual-sided Compare** | Single unstructured file list or legacy runner form fields (`source_file`/`target_file`/`file`; runner.ts) with no compare source/target schema in registry.ts. | Explicit `source` and `target` scopes, each supporting either artifact reference or text. Verified prior to dispatch. | Prevents order ambiguity and mis-aligned diffing (`DOC-06`). | `tests/compare.test.ts`<br>`tests/bounded-input.test.ts`<br>`tests/multi-container-e2e.integration.test.ts` |

---

## 3. Parameter Name Mapping (Legacy snake_case to Canonical camelCase)

All parameter mappings are implemented in `src/validation/input-normalizer.ts` and verified in `tests/bounded-input.test.ts`:

| Endpoint | Legacy Parameter | Canonical Field | Type | Handling in Normalizer |
|---|---|---|---|---|
| All | `output_format` | `outputFormat` | string | Auto-mapped; validates against allowed formats |
| Ingest | `mode` | `mode` | string | Canonical discriminator |
| Ingest | `pages` | `pages` | string | Validated page range parser (`"1-3,5"`) |
| Extract | `type` | `type` | string | Canonical discriminator |
| Extract | `fields` | `fields` | array[string] | String split by comma or parsed array |
| Extract | `schema` | `schema` | object | JSON Schema validated (no network `$ref`) |
| Analyze | `task` | `task` | string | Canonical discriminator |
| Analyze | `categories` | `categories` | array[string] | String split by comma or parsed array |
| Analyze | `criteria` | `criteria` | string | String or array normalized |
| Analyze | `reference_data` | `referenceData` | object | JSON string parsed to object |
| Transform | `action` | `variant` | string | Form `action` mapped to internal `variant` |
| Transform | `target_language` | `targetLanguage` | string | Auto-mapped |
| Transform | `redact_patterns` | `redactPatterns` | array[string] | String split by comma or parsed array; case-insensitive |
| Generate | `task` | `task` | string | Canonical discriminator |
| Generate | `max_words` | `maxWords` | number | Coerced to integer |
| Generate | `questions` | `questions` | array[string] | String split by newline/comma or parsed array |
| Compare | `mode` | `mode` | string | Canonical discriminator |
| Compare | `source_file` | `source.artifactId` | string | Mapped to source object |
| Compare | `target_file` | `target.artifactId` | string | Mapped to target object |

> [!NOTE]
> **Comparison Alias Conflict & Validation Policy (Wave 13)**:
> 1. **Conflict Rejection**: A request supplying both a canonical side parameter (`source` / `target`) and a legacy file alias (`source_file` / `target_file`) is rejected immediately with `CONFLICTING_COMPARISON_PARAMETERS`. Silent override is prohibited.
> 2. **Ambiguity Rejection**: A side object specifying both `artifactId` and `text` is rejected with `AMBIGUOUS_COMPARISON_SIDE` (BRD precondition: each scope must specify either an artifact reference or text, never both).
> 3. **Type & Bounds Validation**: Non-string values (numbers, booleans, arrays) and empty/whitespace-only values throw `INVALID_COMPARISON_SIDE`. All malformed inputs fail validation deterministically (`tests/bounded-input.test.ts`).

---

## 4. Discontinued / Deferred Features in document-core v1

1. **Custom Client Prompts (`_prompt`)**: Discontinued. Prompt variations must be managed via Profile revisions in Admin.
2. **Arbitrary File URLs (`file_urls`)**: Direct worker downloading of external URLs disabled in initial release. Files must be staged via `/api/v1/artifacts` upload.
3. **Workflow processes (`workflows/disbursement`, `workflows/lc-checker`)**: Moved out of `document-core` into separate business projects (`businesses/example-review` and P9 backlog).
4. **Visual Workflow Builder DSL Execution**: Deferred to P9 schema-workflow business.

---

## 5. Error Code Standardization (evidenced subset)

| Old Ambiguous Error | New Standardized Error Code | HTTP Status Code | Evidence |
|---|---|---|---|
| `"Invalid parameters"` | `MISSING_DISCRIMINATOR` / `INVALID_DISCRIMINATOR` | `422` | input-normalizer.ts:33/36; bounded-input + per-action tests |
| `"Model error"` / `"Unsupported format"` | `SCHEMA_VALIDATION_ERROR` / `EMPTY_PROVIDER_OUTPUT` / `MALFORMED_PROVIDER_OUTPUT` | `422` / `502` | output-validators.ts:13ff; output-validation.test.ts `rejects null and undefined provider data with EMPTY_PROVIDER_OUTPUT` family |
| `"Rate limited"` | `TOO_MANY_ARTIFACTS` / `TOO_MANY_QUESTIONS` | `422` | normalizer MAX_ARTIFACTS 20/10, MAX_QA 20; connector quota path is connector-suite owned |
| `"Artifact not found"` | `MISSING_COMPARISON_SIDE` / `INVALID_COMPARISON_SIDE` | `422` | normalizer comparison validation; ownership 404 is platform-route owned |
| `"Lost connection"` | `INVOCATION_UNKNOWN` | non-retryable | worker.ts:118-133; provider-backed-variant 4 non-retryable tests |

### 5.1 UNVERIFIED (not evidenced in document-core; doc error vs product gap)

- `VALIDATION_ERROR` (bare): DOCUMENTATION ERROR. Code emits `SCHEMA_VALIDATION_ERROR`; no bare `VALIDATION_ERROR` literal in document-core src. Fix: drop the label (done above).
- `UNSUPPORTED_FORMAT`: DOCUMENTATION ERROR. Normalizer maps outputFormat via normalizeOutputFormat (returns undefined, no such code); no such literal in src or tests. Fix: covered by validator codes above.
- `PROVIDER_INVALID_RESPONSE`: REAL PRODUCT GAP (test-only). Emitted in actions/extract/index.ts:138,146 + analyze/index.ts:123, but ZERO literal hits in document-core tests. Needs: a test asserting malformed provider JSON throws PROVIDER_INVALID_RESPONSE (owner: business lane). Do not cite until it exists.
- `ARTIFACT_NOT_FOUND`: REAL PRODUCT GAP (ownership). No such literal in document-core src or tests; artifact 404 belongs to the platform route (server.ts artifact access). Needs: platform test or an explicit scope decision that document-core never emits it.
- `_prompt` negative case: REAL PRODUCT GAP (test-only). Legacy bypass proven; new side has only results.ts promptOverrides type field, no rejection test. Needs: negative override test (owner: business/platform).
- `file_urls` rejection: REAL PRODUCT GAP (test-only). Absent from new src (rg empty) but no explicit rejection test. Needs: rejection test or a written discontinued-by-design decision.
