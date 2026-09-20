# Compatibility Matrix — Legacy DUGate vs New Architecture

This document catalogs differences between the legacy implementation (`lib/endpoints/`, `lib/pipelines/`) and the new modular `document-core` business architecture. It explicitly highlights anti-patterns avoided, changes in error handling, checkpoint fidelity, and migration mappings.

---

## 1. Architectural & Behavioral Differences

| Feature / Area | Legacy Behavior (`lib/`) | New Behavior (`businesses/document-core/`) | Rationale / Safety Fix |
|---|---|---|---|
| **Checkpoint Content** | Step output truncated to 500 characters preview in checkpoint record (`lib/pipelines/engine.ts`). | **Full step output** checkpointed (>500 chars guaranteed intact). | Prevents step $N$ from resuming with corrupted/truncated input from step $N-1$. Fixes `RUN-04`. |
| **Native Parser Fallback** | Implicitly returned raw parsed text directly to client on extraction/analysis endpoints if parser succeeded, bypassing LLM inference. | **Strict separation**: Native parsing is only a preprocessing step in `prepareSources`. Never replaces inference for `extract`, `analyze`, `generate`, `compare`. | Bypassing LLM inference produced incorrect empty/raw structures when structured JSON was requested. |
| **Prompt Precedence** | `_prompt` request parameter overrode profile and system prompt, allowing arbitrary jailbreaks/escapes. | **Profile-driven prompt templates**: Client cannot supply raw `_prompt`. System guardrails and profile template variables are strictly validated and merged. | Enforces security boundaries, tenant guardrails, and audit compliance (`PRF-01`). |
| **Transform Discriminator** | Form parameter name was `action` inside POST `/api/v1/docs/transform`, conflicting with endpoint routing vocabulary. | Normalized internally to `variant` (`convert`, `translate`, `rewrite`, `redact`, `template`) while maintaining facade mapping for `action`. | Prevents naming collision and routing ambiguity in unified dispatchers. |
| **Subcase Count** | Legacy registry had 28 total subcases with inconsistent names (e.g. `id-card` vs `receipt`, redundant `fact-check` vs `compliance`). | Exactly **28 canonical variants** (4 ingest, 5 extract, 5 analyze, 5 transform, 6 generate, 3 compare) aligned with Document-Core specification. | Clean domain modeling and deterministic testing catalog. |
| **Provider Output Validation** | Malformed JSON returned by provider was caught and treated as completed with empty or error text. | Strict schema validation with **failure taxonomy**: Malformed provider JSON fails step with `PROVIDER_INVALID_RESPONSE`. Controlled repair retry only if budget allows. | Prevents silent failures and corrupted downstream states (`CON-05`). |
| **Direct DB Access** | Legacy pipeline worker imported `db/index.ts` and updated operations directly. | **Worker has ZERO platform DB credentials**. All state transitions, leases, checkpoints, and artifact reads/writes occur via `TaskContext` / SDK facades. | Complete isolation between control plane and business execution (`BR-12`). |
| **Dual-sided Compare** | Single unstructured file list or ambiguous file fields. | Explicit `source` and `target` scopes, each supporting either artifact reference or text. Verified prior to dispatch. | Prevents order ambiguity and mis-aligned diffing (`DOC-06`). |

---

## 2. Parameter Name Mapping (Legacy snake_case to Canonical camelCase)

| Endpoint | Legacy Parameter | Canonical Field | Type | Handling in Facade |
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
| Transform | `redact_patterns` | `redactPatterns` | array[string] | String split by comma or parsed array |
| Generate | `task` | `task` | string | Canonical discriminator |
| Generate | `max_words` | `maxWords` | number | Coerced to integer |
| Generate | `questions` | `questions` | array[string] | String split by newline/comma or parsed array |
| Compare | `mode` | `mode` | string | Canonical discriminator |
| Compare | `source_file` | `source.artifactId` | string | Mapped to source object |
| Compare | `target_file` | `target.artifactId` | string | Mapped to target object |

---

## 3. Discontinued / Deferred Features in document-core v1

1. **Custom Client Prompts (`_prompt`)**: Discontinued. Prompt variations must be managed via Profile revisions in Admin.
2. **Arbitrary File URLs (`file_urls`)**: Direct worker downloading of external URLs disabled in initial release. Files must be staged via `/api/v1/artifacts` upload.
3. **Workflow processes (`workflows/disbursement`, `workflows/lc-checker`)**: Moved out of `document-core` into separate business projects (`businesses/example-review` and P9 backlog).
4. **Visual Workflow Builder DSL Execution**: Deferred to P9 schema-workflow business.

---

## 4. Error Code Standardization

| Old Ambiguous Error | New Standardized Error Code | HTTP Status Code | Description |
|---|---|---|---|
| `"Invalid parameters"` | `VALIDATION_ERROR` / `MISSING_DISCRIMINATOR` | `400` / `422` | Request violates schema or lacks discriminator. |
| `"Unsupported format"` | `UNSUPPORTED_FORMAT` | `422` | Requested `outputFormat` or input MIME is unsupported. |
| `"Model error"` | `PROVIDER_INVALID_RESPONSE` | `502` | Provider output does not match schema or is invalid JSON. |
| `"Provider timeout"` | `PROVIDER_TIMEOUT` | `504` | Upstream provider failed to respond within deadline. |
| `"Rate limited"` | `RATE_LIMITED` | `429` | Upstream provider or internal quota exceeded. |
| `"Artifact not found"` | `ARTIFACT_NOT_FOUND` | `404` | Specified artifact ID not found or not owned by tenant. |
