# LDBA-00 — Legacy/rework schema mapping (static analysis)

Owner: `codex_arch`  
Dispatch: `LDBA-00-2026-10-09`  
Canonical plan: `du-rework/coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md`  
Scope: root legacy schema and du-rework schema/migrations; read-only analysis.

## Resume point and method

Read `du-rework/coordination/dispatch-specs/2026-10-09-0225-LDBA-00.md`, the canonical LDBA plan, root `lib/db/schema.ts` and `lib/auth.ts`, rework docs `docs/14-reference-compatibility.md` and `docs/04-data-state.md`, Orchestrator migrations `0001` through `0037`, and Connector migrations `001` through `009`. Searched all migration files for table creation and column alteration. No DB, build, or test command was run. No source, test, migration, plan, or design document was edited.

Legacy schema path references below are relative to `D:\Git\dugate`; rework migration/document paths are relative to `D:\Git\dugate\du-rework`.

Status labels: **MATCH** = same semantic value with a column rename; **TYPE** = storage type differs; **TRANSFORM** = split, normalize, derive, encrypt, or cast/validate; **MISSING** = no equivalent field in the inspected migration set; **PARTIAL** = only some source semantics fit the target.

Citation shorthand: `schema.ts` = root `lib/db/schema.ts`; `plan` = `du-rework/coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md`; Orchestrator migration numbers are relative to `orchestrator/services/orchestrator/migrations/`; Connector migration numbers are relative to `orchestrator/services/connector/src/db/migrations/`.

## Nine-table map

### 1. `Operation` → `operations`

Declarations: legacy `lib/db/schema.ts:10-43` (`pgTable('Operation', ...)`); rework `orchestrator/services/orchestrator/migrations/0001_platform_v1.sql:36-56`, extended by `0004:31-33`, `0007:7`, `0009:12`, and `0024:34-67`.

| Legacy column (source line) | Rework destination (migration line) | Status and mapping note |
|---|---|---|
| `id` (`schema.ts:11`) | `operations.id uuid` (`0001:37`) | **TYPE/TRANSFORM**: text UUID string → UUID; validate every value before cast. |
| `apiKeyId` (`:12`) | `api_key_id uuid` (`0001:39`) | **TYPE/TRANSFORM**: nullable text → nullable FK UUID; tenant assignment also required. |
| `createdByUserId` (`:13`) | None today; proposed `created_by_user_id uuid` (plan `:177`) | **MISSING** in migrations `0001..0037`. |
| `idempotencyKey` (`:14`) | Candidate `submission_keys.key` (`0001:58-68`) | **PARTIAL**: source has the key, but target row also requires tenant, API key, route action, request hash, operation, expiry. Cannot reconstruct a complete submission row from this column alone. Plan `:104` calls `submission_keys` rework-only; qualify as “no complete source row,” not literally no related source value. |
| `done` (`:15`) | No `done` field; target `state` (`0001:43`) | **TRANSFORM/MISSING**: possible derived compatibility flag, but plan `:178` proposes a separate `done` field if a consumer requires it. |
| `state` (`:16`) | `state text` (`0001:43`) | **PARTIAL**: same concept/name, but old and new lifecycle vocabularies differ; define a value map. |
| `progressPercent`, `progressMessage`, `endpointSlug` (`:17-19`) | `progress_percent`, `progress_message`, `endpoint_slug` (`0024:42-45`) | **MATCH** for names/shape, subject to state/value validation. |
| `pipelineJson` (`:20`) | `pipeline_json jsonb` (`0024:39`) | **TYPE/TRANSFORM**: parse text JSON; malformed rows must fail visibly. |
| `currentStep`, `failedAtStep` (`:21-22`) | `current_step` (`0024:41`), `failed_at_step` (`:66-67`) | **MATCH**, with normal integer-range validation. |
| `filesJson` (`:23`) | No `files_json`; `submit_artifacts jsonb` exists (`0009:12`) | **PARTIAL/MISSING**: submit-artifact references are not proven equivalent to the legacy files JSON. Plan `:177` proposes `files_json jsonb`. |
| `outputFormat`, `outputContent`, `outputFilePath` (`:24-26`) | `output_format`, `output_content`, `output_file_path` (`0024:48-51`) | **MATCH** by rename. |
| `extractedData`, `stepsResultJson`, `usageBreakdown` (`:27-28, :34`) | `extracted_data`, `steps_result_json`, `usage_breakdown` JSONB (`0024:40,50,62`) | **TYPE/TRANSFORM**: JSON text → JSONB parse. |
| `totalInputTokens`, `totalOutputTokens`, `pagesProcessed`, `modelUsed` (`:29-32`) | `total_input_tokens bigint`, `total_output_tokens bigint`, `pages_processed`, `model_used` (`0024:57-60`) | **MATCH/TYPE**: token integer widens to bigint; check nonnegative and range. |
| `totalCostUsd` (`:33`) | `total_cost_usd numeric(20,6)` (`0024:61`) | **TYPE/TRANSFORM**: float → decimal USD; do not convert this operation column to micro-USD. |
| `webhookUrl` (`:35`) | Candidate `callback_url text` (`0007:7`); plan proposes `webhook_url` (`plan:177`) | **PARTIAL/PLAN GAP**: callback URL is present under a different name; confirm whether it has identical semantics before adding a second field. |
| `webhookSentAt` (`:36`) | Candidate `webhook_deliveries.delivered_at` (`0007:9-25`); plan also proposes operation `webhook_sent_at` (`plan:177`) | **PARTIAL**: delivery rows model event/status/attempts and are not a one-column equivalent. |
| `errorCode`, `errorMessage` (`:37-38`) | `error_code` (`0001:49`), `error_message` (`0024:66`) | **MATCH** by rename. |
| `filesDeleted` (`:39`) | None today; proposed in plan `:177` | **MISSING**. |
| `createdAt`, `updatedAt` (`:40-41`) | `created_at`, `updated_at timestamptz` (`0001:51-52`) | **TYPE/TRANSFORM**: old Drizzle `timestamp` has no `withTimezone` option; define UTC interpretation when converting to timestamptz. |
| `deletedAt` (`:42`) | `deleted_at timestamptz` (`0024:35`) | **TYPE/TRANSFORM** as timestamp above. |
| No old field | `tenant_id`, `business_id`, `business_version`, `action`, `correlation_id` (`0001:38,40-42,50`) | **NEW/DERIVED**: plan `:92` already identifies these as absent from legacy `Operation`; tenant must be assigned and business/action derived from a documented mapping. |

### 2. `ApiKey` → `api_keys`

Declarations: legacy `lib/db/schema.ts:53-64`; rework `0001_platform_v1.sql:14-22`, `0024:80-83`, `0021_admin_list_sort_timestamps.sql:8-11`.

| Legacy column | Rework destination | Status and mapping note |
|---|---|---|
| `id` (`schema.ts:54`) | `api_keys.id uuid` (`0001:15`) | **TYPE/TRANSFORM**: text UUID → UUID, validate before cast. |
| `name` (`:55`) | `name text` (`0024:81`) | **MATCH** by rename. |
| `keyHash` (`:56`) | `hash text` (`0001:17`) | **MATCH** in stored representation; never import raw key material. |
| `prefix` (`:57`) | `prefix text` (`0001:18`) | **MATCH**. |
| `role`, `note` (`:58-59`) | None in `api_keys` migrations; plan `:176` proposes both | **MISSING**. Do not confuse API-key role with local-user role. |
| `spendingLimit`, `totalUsed` (`:60-61`) | `spending_limit`, `total_used numeric(20,6)` (`0024:82-83`) | **TYPE/TRANSFORM** from double precision to decimal USD. |
| `status` (`:62`) | `status text` (`0001:19`) | **PARTIAL**: normalize values/case (`active` vs `ACTIVE`) and validate allowed statuses. |
| `createdAt`, `updatedAt` (`:63-64`) | `created_at` (`0001:20`), `updated_at` (`0021:8-11`) | **TYPE/TRANSFORM**: timestamp interpretation; `tenant_id uuid NOT NULL` is new (`0001:16`). |

### 3. `ExternalApiConnection` → `connector_revisions` + `secret_versions`

Declarations: legacy `lib/db/schema.ts:72-94`; Connector base `orchestrator/services/connector/src/db/migrations/001_connector.sql:1-18`, credential-source evolution `007:8-16`, tenant/account binding `008:14-29`.

| Legacy columns | Rework destination | Status and mapping note |
|---|---|---|
| `id` (`schema.ts:73`) | `connector_id text` (`001_connector.sql:2`) | **MATCH/TRANSFORM**: text remains text; new revision key is `(connector_id, tenant_id, revision)` after `008:26-29`. The target is not a UUID-only ID model. |
| `name`, `slug`, `description`, `endpointUrl`, `httpMethod`, `authType`, `authKeyHeader`, `promptFieldName`, `fileFieldName`, `fileUrlFieldName`, `defaultPrompt`, `staticFormFields`, `extraHeaders`, `responseContentPath`, `sessionIdResponsePath`, `sessionIdFieldName`, `timeoutSec` (`schema.ts:74-91`) | `config jsonb` (`001_connector.sql:4-5`) | **TRANSFORM**: pack into versioned config JSON; adapter identifier must be derived/selected rather than copied from a same-named column. Config keys are not constrained by this SQL schema. |
| `authSecret` (`:81`) | `credential_ref` (`001:6`) + `secret_versions.encrypted_value bytea` (`001:12-17`) | **TRANSFORM**: secret must be encrypted and referenced; plaintext text cannot be inserted as ciphertext. `credential_source` becomes required JSONB in `007:8-16`. |
| `state` (`:92`) | `state` (`001:7`, lifecycle constraints in `006:16-21`) | **TRANSFORM**: map legacy `ENABLED`/other values to the revision state union. |
| `createdAt` (`:93`) | `created_at` (`001:8`) | **TYPE/TRANSFORM** for timestamp/timezone. |
| `updatedAt` (`:94`) | No `updated_at` column on `connector_revisions` in migrations `001..009` | **MISSING** as a revision timestamp; `secret_versions.rotated_at` is not equivalent. |
| No old field | `revision`, `adapter`, `credential_ref`, `tenant_id`, `account_id`, `credential_source` (`001:3-6`, `007:8-16`, `008:14-21`) | **NEW/DERIVED**: one source row needs a revision policy (plan chooses revision 1); tenant/account/source metadata must be explicit. |

### 4. `ExternalApiOverride` → `connector_prompt_overrides`

Declarations: legacy `lib/db/schema.ts:103-111`; rework `orchestrator/services/orchestrator/migrations/0026_profile_policy.sql:121-139`.

| Legacy column | Rework destination | Status and mapping note |
|---|---|---|
| `id` (`schema.ts:104`) | `id uuid` (`0026:122`) | **TYPE/TRANSFORM**: validate text UUID before cast. |
| `connectionId` (`:105`) | `connection_id uuid` (`:124`) | **TYPE/TRANSFORM**: migration explicitly keeps this UUID-only; old text IDs need validation (`0026:114-120`). |
| `apiKeyId` (`:106`) | `api_key_id uuid` FK (`:125`) | **TYPE/TRANSFORM** and tenant assignment. |
| `endpointSlug`, `stepId`, `promptOverride` (`:107-109`) | `endpoint_slug`, `step_id`, `prompt_override` (`:126-128`) | **MATCH** by rename; `_default` default is preserved. |
| `createdAt`, `updatedAt` (`:110-111`) | `created_at`, `updated_at` (`:135-136`) | **TYPE/TRANSFORM** for timestamp/timezone. |
| No old field | `tenant_id uuid NOT NULL`, `is_active boolean` (`:123, :134`) | **NEW**: assign the common legacy tenant; old storage has no `isActive` field and target rows default active. |

### 5. `ProfileEndpoint` → `profile_bindings` + `profile_names` (+ active pointer)

Declarations: legacy `lib/db/schema.ts:122-137`; rework base `0004_profile_bindings.sql:14-28`, policy `0026_profile_policy.sql:35-79`, active pointer `0027_profile_active_pointer.sql:32-41`, name registry `0028_profile_name.sql:22-34`.

| Legacy column | Rework destination | Status and mapping note |
|---|---|---|
| `id` (`schema.ts:123`) | `profile_id uuid` on revision/binding and name rows (`0004:15,25`; `0028:23`) | **TYPE/TRANSFORM**: text UUID → UUID; target identity is `(profile_id, revision)`, not old row ID alone. |
| `apiKeyId` (`:124`) | `api_key_id uuid` (`0004:18`, `0028:25`) | **TYPE/TRANSFORM** plus tenant FK. |
| `endpointSlug` (`:125`) | `business_id`, `business_version`, `action` (`0004:19-21`; name identity `0028:26-28`) | **TRANSFORM**: no `endpoint_slug` target column in `profile_bindings`; requires explicit slug→business/action mapping. |
| `enabled` (`:126`) | `enabled boolean` (`0026:35-36`) | **MATCH**. |
| `parameters` (`:127`) | `parameters jsonb` (`0026:38-45`) | **TYPE/TRANSFORM**: parse JSON text; contract shape is not SQL-checked. |
| `connectionsOverride` (`:128`) | `connections_override jsonb` (`0026:73-79`) | **TYPE/TRANSFORM**: parse/normalize legacy `ConnectionStep[]` or bare slug arrays. |
| `jobPriority` (`:129`) | `job_priority text` (`0026:47-52`) | **MATCH/TRANSFORM**: validate LOW/MEDIUM/HIGH union. |
| `fileUrlAuthConfig` (`:130`) | `file_url_auth_cipher text` (`0026:62-71`) | **TRANSFORM**: old may be legacy encrypted `iv:tag:ciphertext` or plaintext JSON; not safely a generic JSONB cast. |
| `allowedFileExtensions` (`:131`) | `allowed_file_extensions text` (`0026:54-60`) | **MATCH** as CSV text. The migration explicitly says it is CSV, not JSON. |
| `rateLimitPerMin`, `maxConcurrent` (`:134-135`) | No matching columns in migrations `0001..0037` or Connector `001..009` | **MISSING**; not listed among plan §6 additions. |
| `createdAt`, `updatedAt` (`:136-137`) | `created_at` (`0004:24`); no `updated_at` on immutable `profile_bindings` or `profile_names` (`0028:30`) | **PARTIAL**: source update timestamp has no direct target. |
| No old field | `revision`, `connector_bindings`, `profile_active_revisions`, `profile_name` (`0004:16,22-25`; `0027:32-41`; `0028:29`) | **NEW/DERIVED**: revision and active pointer require a policy; legacy endpoint slug is not automatically a human profile name. |

### 6. `AppSetting` → split destinations

Declarations: legacy `lib/db/schema.ts:146-150`; workflow loader key convention `lib/workflow-builder/loader.ts:2-12`; rework `admin_crypto_config` (`0020_admin_crypto_config.sql:5-14`) and `legacy_workflow_schemas` (`0037_legacy_workflow_schema_catalog.sql:4-21`).

| Legacy column | Rework destination | Status and mapping note |
|---|---|---|
| `id` (`schema.ts:147`) | No equivalent ID | **MISSING/IGNORED**; target rows use tenant/key or tenant/slug/revision identity. |
| `key` (`:148`) | `wb_schema:<slug>` splits to `legacy_workflow_schemas.slug` (`loader.ts:3,10`; `0037:6`) | **TRANSFORM**; other setting keys are not a uniform table map. |
| `value` (`:149`) | Workflow JSON becomes `schema_ref jsonb` (`0037:9`) after parse/digest; selected crypto policy becomes reference columns in `admin_crypto_config:8-10`; other values remain deployment settings | **TRANSFORM/SPLIT**; no generic key/value table exists in these migrations. |
| `updatedAt` (`:150`) | `legacy_workflow_schemas.created_at` (`0037:11-12`) only at import time | **PARTIAL**: no `updated_at` field on target schema catalog; source timestamp can choose the winner but is not preserved as a target column. |

### 7. `FileCache` → `artifacts` + `artifact_blobs`

Declarations: legacy `lib/db/schema.ts:156-165`; rework `artifacts` `0001_platform_v1.sql:129-143`, blob store `0003_artifacts_grants.sql:8-13`, file name `0014_artifact_declared_filename.sql:4-5`, storage evolution `0013:3-17`.

| Legacy column | Rework destination | Status and mapping note |
|---|---|---|
| `id` (`schema.ts:157`) | `artifacts.id uuid` (`0001:130`) | **TYPE/TRANSFORM**: validate text UUID before cast. |
| `md5Hash` (`:158`) | `artifacts.sha256` (`0001:140`) | **TRANSFORM**: MD5 cannot be copied as SHA-256; rehash bytes and compare to source availability. |
| `s3Key` (`:159`) | `artifacts.storage_key` (`0001:141`) and/or `artifact_blobs.storage_key` (`0003:9`) | **PARTIAL/TRANSFORM**: old key identifies external S3 content; `artifact_blobs.bytes` is the rework local blob store. Storage backend/version must be selected. |
| `fileName`, `mimeType`, `size` (`:160-162`) | `file_name` (`0014:5`), `mime_type`, `size_bytes` (`0001:135-136`) | **MATCH/TYPE**: `size` integer widens to bigint. |
| `refCount` (`:163`) | No direct column | **MISSING/DERIVED** from surviving references; do not copy as an authoritative target count without defining ownership. |
| `createdAt` (`:164`) | `created_at` (`0001:142`) | **TYPE/TRANSFORM** for timestamp/timezone. |
| `lastAccessedAt` (`:165`) | No direct column | **MISSING** in inspected artifact schema. |
| No old field | Tenant, purpose, token, state, expiry and multipart ledger (`0001:131-143`; `0015:70+`) | **NEW** artifact lifecycle/security metadata. |

### 8. `User` → `admin_local_users`

Declarations: legacy `lib/db/schema.ts:174-184`; authentication uses bcrypt `lib/auth.ts:4,34-37`; rework `admin_local_users` `0023_admin_local_users.sql:4-20`.

| Legacy column | Rework destination | Status and mapping note |
|---|---|---|
| `id` (`schema.ts:175`) | `id uuid` (`0023:5`) | **TYPE/TRANSFORM**: validate text UUID before cast. |
| `username` (`:176`) | `username_normalized` (`0023:7-9`) | **TRANSFORM**: normalize lowercase and validate allowed syntax; collisions after normalization must be reported. |
| `password` (`:177`) | `password_hash` with hard scrypt format CHECK (`0023:10-11`) | **TYPE/TRANSFORM**: legacy bcrypt compare is in `lib/auth.ts:34-37`; bcrypt cannot satisfy scrypt CHECK. Plan decision is verify legacy hash at first login then rehash; user never logging in requires reset per plan `:120-125`. |
| `role` (`:178`) | `role text` (`0023:12`) | **PARTIAL**: same storage type; validate/map role vocabulary. |
| `provider`, `providerSub`, `email`, `displayName` (`:179-182`) | No matching columns in `admin_local_users` migrations | **MISSING** in this local-user table; OIDC identity continuity is not provided by this row shape. |
| `createdAt`, `updatedAt` (`:183-184`) | `created_at`, `updated_at` (`0023:15-16`) | **TYPE/TRANSFORM** for timestamp/timezone. |
| No old field | `tenant_id uuid NOT NULL`, enable/lock/version (`0023:6,13-17`) | **NEW** tenant and local-auth state. |

### 9. `UserProfileAssignment` → `user_profile_assignments`

Declarations: legacy `lib/db/schema.ts:190-195`; rework `orchestrator/services/orchestrator/migrations/0026_profile_policy.sql:161-170`.

| Legacy column | Rework destination | Status and mapping note |
|---|---|---|
| `id` (`schema.ts:191`) | No ID column; target primary key is `(user_id, api_key_id)` (`0026:161-165`) | **MISSING/IGNORED**; uniqueness tuple replaces row identity. |
| `userId`, `apiKeyId` (`:192-193`) | `user_id uuid`, `api_key_id uuid` FKs (`0026:162-163`) | **TYPE/TRANSFORM**: validate text UUIDs and ensure both rows use the same tenant. |
| `createdAt` (`:194`) | `granted_at timestamptz` (`0026:164`) | **TYPE/TRANSFORM**; timestamp renamed. |
| No old field | Explicit `tenant_id` | **MISSING**: this table has no tenant column or composite same-tenant FK; tenant is only inferable through the referenced user/key. This does not satisfy a literal “every table has tenant_id NOT NULL” rule. |

## Six mismatch checks

1. **Tenant — confirmed for legacy, qualified for rework.** The legacy schema has no tenant column in any of its nine tables. Core `api_keys.tenant_id` and `operations.tenant_id` are UUID NOT NULL FKs (`0001:16,38`), and the plan decides one `legacy-default` tenant (`plan:111-114`). However, the dispatch acceptance “every rework table has `tenant_id NOT NULL`” is false: `business_versions` (`0001:24-34`), `tasks`, `task_dependencies`, `step_checkpoints`, and `outbox` (`0001:70-127`) have no direct tenant column; `admin_audit_events.tenant_id` is nullable for global events (`0010:25-27`); `admin_crypto_config.tenant_id` is text (`0020:5-7`); `budget_reservations.tenant_id` is text (`0022:3-5`); Connector uses text tenant IDs (`connector 001:24-27`, `008:14-21`); `user_profile_assignments` has no tenant column (`0026:161-165`). Some runtime rows inherit scope via FK, but that differs from the acceptance wording and from a universal UUID FK claim.
2. **ID text vs UUID — confirmed for core IDs, not universal.** Legacy primary IDs are Drizzle `text` with `crypto.randomUUID()` defaults (e.g. `schema.ts:11,54,73,104,123,157,175,191`). Core rework IDs are UUID (e.g. `0001:15,37`, `0023:5`, `0004:15`). Any backfill needs parse validation before cast. Connector `connector_id`, invocation IDs and secret IDs remain TEXT (`connector 001:2,13,25`), so “rework IDs are all UUID” is overbroad; `ExternalApiConnection.id`→`connector_id` is text-to-text.
3. **Password bcrypt vs scrypt — confirmed.** Legacy password field is plain text storage (`schema.ts:177`); actual credential verifier imports bcryptjs (`lib/auth.ts:4`) and calls `bcrypt.compare` (`:34-37`). Rework requires the explicit scrypt encoding (`0023:10-11`). Direct copy fails the CHECK. The plan’s first-login rehash decision is necessary; it does not preserve access for never-login users without a reset (`plan:120-125`).
4. **Cost float vs decimal — confirmed.** Legacy operation cost and API-key limits/usage are `doublePrecision` (`schema.ts:33,60-61`). Rework parity columns use `numeric(20,6)` USD (`0024:61,82-83`). Budget reservations separately use integer micro-USD (`0022:19`); the units must not be conflated. `0024:21-23` also says not to coalesce successful-operation NULL cost into zero.
5. **JSON text vs JSONB — confirmed with field-level exceptions.** Legacy text columns include operation `pipelineJson`, `filesJson`, `extractedData`, `stepsResultJson`, `usageBreakdown` (`schema.ts:20,23,27-28,34`); connection `staticFormFields`/`extraHeaders` (`:86-87`); profile `parameters`/`connectionsOverride` (`:127-128`); and AppSetting workflow JSON (`loader.ts:2-3,10`). Rework uses JSONB for the operation/profile/config/schema equivalents (`0024:39-40,50,62`; `0026:45,79`; Connector `001:5`; `0037:9`). Parse and fail visibly on malformed JSON. The plan’s §4.5 list needs qualification: `allowedFileExtensions` is CSV text by `0026:54-60`, not JSON; `fileUrlAuthConfig` can be the legacy `iv:tag:ciphertext` form or plaintext JSON (`0026:62-71`), not a blind JSON cast.
6. **Workflow schema KV vs catalog — confirmed.** Legacy `AppSetting` is text key/value (`schema.ts:146-150`); loader uses `wb_schema:<slug>` (`lib/workflow-builder/loader.ts:2-12`). Rework catalog has `(tenant_id, slug, revision)`, digest CHECK, JSONB `schema_ref`, active/retired status, and one-active index (`0037:4-20`). Plan decision `revision=1`, latest source `updatedAt` wins is at `plan:138-142`; target schema catalog has no `updated_at`, so source timestamp is only a selection input unless separately preserved.

## Rework tables with no complete legacy row source

Plan §3.3 lists `tenants`, `business_versions`, `submission_keys`, `tasks`, `task_dependencies`, `step_checkpoints`, `outbox`, the new artifact lifecycle, `invocation_grants`, `usage_events`, `budget_reservations`, `admin_audit_events`, `admin_idempotency`, `webhook_deliveries`, and `human_waits` (`plan:102-105`). Migration scan confirms their table creation in `0001:7,24,58,70,94,102,114,129`, `0002:2`, `0003:17`, `0005:9`, `0007:9`, `0010:25`, `0012:17`, and `0022:3`.

The scan found additional new structures not called out in §3.3: `artifact_multipart_parts` (`0015:70`), `connector_invocations` and `connector_usage_outbox` (`connector 001:24,44`). They have no corresponding legacy tables. `profile_active_revisions` (`0027:32`) is derived from the old profile set rather than a one-to-one source table. `submission_keys` and `webhook_deliveries` do have partial old column inputs (`idempotencyKey`, `webhookUrl`/`webhookSentAt`) but not enough source data for complete target rows without explicit policies.

## A1 before A2

**Decision: A1 read/compare view first; A2 backfill/cutover only afterward**, matching plan §5 and D1 (`plan:150-158,225`). A1 exit conditions in the plan are source/target row counts equal and zero parse failures (`plan:152-155`). The legacy app continues using quoted PascalCase tables such as `"Operation"`; a lower-case alias view does not rename or rewrite that table (`plan:84-86`). A1 views must be read-only and must not use write triggers.

This is a static feasibility conclusion, not a live DB confirmation. Creating a view still changes the database catalog. Run A1 only under a separate authorized rehearsal/lease. Do not first apply baseline migrations that create lower-case tables such as `operations` (`0001:36`), or the proposed same-schema view name will collide; use the old DB before those migrations or a separate schema/alias. A2 remains later: its own approved window, old app stopped, rollback plan, and backfill report are explicit plan conditions (`plan:154-161`). This receipt does not authorize either stage.

## Plan and documentation discrepancies to carry forward

- Dispatch AC says every rework table has `tenant_id NOT NULL`; migration evidence disproves that literal claim (see mismatch 1). The plan’s narrower “every core table” statement (`plan:111-114`) also needs to distinguish direct tenant columns from inherited scope and platform-global tables. No plan edit was made.
- `ProfileEndpoint.rateLimitPerMin` and `maxConcurrent` exist in legacy `schema.ts:134-135`, but no matching migration field was found in `0001..0037` or Connector `001..009`; plan §6 does not list them. `ProfileEndpoint.updatedAt` also has no direct target timestamp in the immutable profile tables. Add these to a future explicit disposition, not by silent omission.
- Plan §3.2 says `UserProfileAssignment` is “1-1 + tenant” (`plan:100`), but actual `0026:161-165` has no tenant column and no composite same-tenant FK.
- Plan §6 proposes `operations.webhook_url` (`plan:177`), while `0007:7` already adds `operations.callback_url`; clarify whether the names/semantics are identical before adding a duplicate. Old `webhookSentAt` is only partially represented by delivery rows.
- Plan §3.3 labels `submission_keys` and `webhook_deliveries` as having no legacy source, while the legacy Operation has related columns. They are not complete row sources, but should be described as partial-source cases rather than no related source value.
- Plan §4.5 treats `allowedFileExtensions` as JSON, contradicted by the profile migration’s CSV explanation (`0026:54-60`); `fileUrlAuthConfig` is conditionally encrypted text (`0026:62-71`).
- The continuity premise is explicitly unsettled across artifacts: `0024:26-30` says the rework is a fresh separate deployment with no data/credential import; `docs/14-reference-compatibility.md:137` treats authorized export/import and continuity as a separate program; the LDBA plan §10 calls reversing the no-migration assumption a scope change requiring explicit user confirmation before any migration is written/run. No confirmation or DB action is inferred here. `docs/04-data-state.md:3` also says fan-out/HITL/artifact lifecycle are not yet materialized while migrations define those tables (`0001:70-143`, `0005:9`, `0003:8`); this appears stale relative to the scanned migration set.

## Boundaries

Static read-only mapping only. No DB, build, or test was run. No source/test/migration/docs/plan file was changed. No commit, git add, or push was performed. LDBA-00 records the A1-before-A2 recommendation and schema gaps; it does not mark a gate or authorize a real-database migration.

