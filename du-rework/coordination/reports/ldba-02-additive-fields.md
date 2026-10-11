# LDBA-02 — Independent additive-field consumer scan

Date: 2026-10-09
Status: scan complete; no gate tick

## Scope and method

I independently reviewed all eight former candidates in plan §6.1. I searched the orchestrator source, admin-web source, connector source, and both allowed migration trees. These searches are read-only. No migration, source, test, or plan was changed. No database, build, or test was run. No database window is claimed.

The five search roots used for every command below were:

- `du-rework/orchestrator/services/orchestrator/src`
- `du-rework/orchestrator/apps/admin-web/src`
- `du-rework/orchestrator/services/connector/src`
- `du-rework/orchestrator/services/orchestrator/migrations`
- `du-rework/orchestrator/services/connector/src/db/migrations`

Each command below ran with `rg -n -i -e PATTERN` followed by those five roots in that order. Counts are matching output lines. `rg` exit 1 means no matching lines; exit 0 means at least one matching line.

Source paths in the findings are relative to `du-rework/orchestrator/services/orchestrator/src` unless a migration path is given.

1. Command: `rg -n -i -e 'ApiKey\.role|apiKey\.role|api_keys\.role|api_key_role|apiKeyRole' du-rework/orchestrator/services/orchestrator/src du-rework/orchestrator/apps/admin-web/src du-rework/orchestrator/services/connector/src du-rework/orchestrator/services/orchestrator/migrations du-rework/orchestrator/services/connector/src/db/migrations`. Exit 1; 0 hits.
2. Command: `rg -n -i -e 'ApiKey\.note|apiKey\.note|api_keys\.note|api_key_note|apiKeyNote' du-rework/orchestrator/services/orchestrator/src du-rework/orchestrator/apps/admin-web/src du-rework/orchestrator/services/connector/src du-rework/orchestrator/services/orchestrator/migrations du-rework/orchestrator/services/connector/src/db/migrations`. Exit 1; 0 hits.
3. Command: `rg -n -i -e 'Operation\.filesJson|operation\.filesJson|filesJson|files_json' du-rework/orchestrator/services/orchestrator/src du-rework/orchestrator/apps/admin-web/src du-rework/orchestrator/services/connector/src du-rework/orchestrator/services/orchestrator/migrations du-rework/orchestrator/services/connector/src/db/migrations`. Exit 1; 0 hits.
4. Command: `rg -n -i -e 'Operation\.createdByUserId|operation\.createdByUserId|createdByUserId|created_by_user_id' du-rework/orchestrator/services/orchestrator/src du-rework/orchestrator/apps/admin-web/src du-rework/orchestrator/services/connector/src du-rework/orchestrator/services/orchestrator/migrations du-rework/orchestrator/services/connector/src/db/migrations`. Exit 0; 3 hits.
5. Command: `rg -n -i -e 'Operation\.filesDeleted|operation\.filesDeleted|filesDeleted|files_deleted' du-rework/orchestrator/services/orchestrator/src du-rework/orchestrator/apps/admin-web/src du-rework/orchestrator/services/connector/src du-rework/orchestrator/services/orchestrator/migrations du-rework/orchestrator/services/connector/src/db/migrations`. Exit 1; 0 hits.
6. Command: `rg -n -i -e 'Operation\.done|operation\.done|operations\.done|\.done\b|done\s*:' du-rework/orchestrator/services/orchestrator/src du-rework/orchestrator/apps/admin-web/src du-rework/orchestrator/services/connector/src du-rework/orchestrator/services/orchestrator/migrations du-rework/orchestrator/services/connector/src/db/migrations`. Exit 0; 23 hits.
7. Command: `rg -n -i -e 'Operation\.webhookUrl|operation\.webhookUrl|webhookUrl|webhook_url' du-rework/orchestrator/services/orchestrator/src du-rework/orchestrator/apps/admin-web/src du-rework/orchestrator/services/connector/src du-rework/orchestrator/services/orchestrator/migrations du-rework/orchestrator/services/connector/src/db/migrations`. Exit 0; 13 hits.
8. Command: `rg -n -i -e 'Operation\.webhookSentAt|operation\.webhookSentAt|webhookSentAt|webhook_sent_at' du-rework/orchestrator/services/orchestrator/src du-rework/orchestrator/apps/admin-web/src du-rework/orchestrator/services/connector/src du-rework/orchestrator/services/orchestrator/migrations du-rework/orchestrator/services/connector/src/db/migrations`. Exit 1; 0 hits.

## Per-column results

| Proposed legacy column | Raw search hits and file:line | Rework column, consumer, replacement, and verdict |
|---|---|---|
| `api_keys.role` | 0 hits for the exact property and column spellings above. | `0001_platform_v1.sql:14-21` defines `api_keys` with id, tenant_id, hash, prefix, status, created_at; no role. Migration additions are updated_at in `0021_admin_list_sort_timestamps.sql:8-11` and name/spending_limit/total_used in `0024_legacy_parity_columns.sql:80-83`; neither adds role. Current admin auth uses the platform bearer in `http/routes/admin.ts:50-65`. The separate `session.role` is local admin/operator session state in `modules/auth/session-store.ts:310,323-325`, not API-key role. Verdict: no consumer of a proposed `api_keys.role` storage column; no additive DDL. |
| `api_keys.note` | 0 hits for the exact property and column spellings above. | The same `api_keys` definition at `0001_platform_v1.sql:14-21` has no note. The API-key list selects explicit id, tenant_id, prefix, status, created_at, updated_at at `modules/admin-read/api-key-list.ts:107-123`; creation inserts tenant_id, hash, prefix at `modules/admin-actions/dispatcher.ts:693-697`. Verdict: no consumer of a proposed `api_keys.note` storage column; no additive DDL. |
| `operations.files_json` | 0 hits for `filesJson` and `files_json` in the searched code and migrations. | The replacement storage model is `artifacts.storage_key` at `0001_platform_v1.sql:129-143` and `artifact_blobs.storage_key` plus bytes at `0003_artifacts_grants.sql:8-13`. Artifact code reads and writes those keys, for example `modules/artifacts/artifacts.ts:159,169,194,393,401,1033,1190`. Verdict: no `operations.files_json` consumer; artifact metadata and blob storage are the existing replacement. |
| `operations.created_by_user_id` | 3 hits: `compat/legacy-input-decoders.ts:151,177-178`. | These are forbidden identity-field names, not reads or writes of an operations column. The body guard checks the field list at `compat/legacy-input-decoders.ts:139-154,403-410`; the header guard checks the header list at lines 157-180,365-371. No target column is defined in the migrations. Verdict: no accepted database consumer; the rework rejects caller-supplied per-user identity. The loss of per-user operation scoping is an explicit behavior consequence in plan §6.2, lines 250-254. |
| `operations.files_deleted` | 0 hits for `filesDeleted` and `files_deleted`. | `operations.deleted_at` is added by `0024_legacy_parity_columns.sql:32-35`. The adapter writes it in `compat/legacy-host-adapter.ts:396-403` and filters it for visibility at lines 409-411 and 608-612. Verdict: no `files_deleted` consumer; soft deletion is represented by `deleted_at`. |
| `operations.done` | 23 broad `done` matches: `src/db/migrations.ts:157,281`; `compat/legacy-operations.ts:56,151`; `compat/legacy-operation-serializers.ts:11,17,135`; `modules/operations/ingestion-storage-s3.ts:299,339`; `compat/legacy-http-mount.ts:270,587,788`; `compat/legacy-host-adapter.ts:474`; `compat/legacy-envelope.ts:32,118,122,140,189,193,201`; `compat/legacy-action-router.ts:286`; `modules/encryption/crypto-storage-facade.ts:454,480`. | The raw count includes iterator `.done`, comments, and compatibility shapes. The relevant compatibility projection derives `done` from `isTerminalState(rawState)` at `compat/legacy-host-adapter.ts:470-475,591-592`; the envelope serializes that derived value at `compat/legacy-envelope.ts:116-122,185-201`. The database column is `operations.state text` at `0001_platform_v1.sql:36-53`; the migration does not declare a PostgreSQL enum or state CHECK. Verdict: no consumer of a stored `operations.done` column; the legacy-facing boolean is derived from state. The plan wording enum should mean the application state vocabulary, not a PostgreSQL enum type. |
| `operations.webhook_url` | 13 hits: `compat/legacy-input-decoders.ts:126,307,310`; `compat/legacy-wire-decoders.ts:191,193,213-214,264,427-430,432`. | This is a real compatibility input alias, but it is not a consumer of a separate `operations.webhook_url` column. The decoder maps it to `submission.callback` at `compat/legacy-input-decoders.ts:307-330`; the adapter forwards callback at `compat/legacy-host-adapter.ts:104-109`; submission stores it in `callback_url` at `modules/operations/submission.ts:572-594`. That column exists at `0007_webhook_deliveries.sql:6-7` and the webhook scheduler reads it at `modules/webhooks/webhooks.ts:132-150,194-200`. Verdict: one wire-level consumer, zero consumers requiring the proposed extra column. Existing ADR L3 still owns the semantic parity question; this scan does not resolve or broaden it. |
| `operations.webhook_sent_at` | 0 hits for `webhookSentAt` and `webhook_sent_at`. | The delivery model records per-delivery `delivered_at` in `0007_webhook_deliveries.sql:9-25`; the dispatcher updates it at `modules/webhooks/webhooks.ts:817`. This is delivery-row state, not a matching operations column. Verdict: no consumer of a proposed `operations.webhook_sent_at` column; do not add it based on this scan. |

## Replacement-mechanism checks

1. `filesDeleted` → `operations.deleted_at`: migration `0024_legacy_parity_columns.sql:32-35` adds the timestamp; `legacy-host-adapter.ts:396-403` sets it, and reads hide rows where it is non-null at `legacy-host-adapter.ts:608-612`.
2. `done` → terminal-state projection: `0001_platform_v1.sql:43` stores state as text. `legacy-host-adapter.ts:474,591-592` derives the legacy boolean from the state predicate. This is an application state set, not a PostgreSQL enum declaration.
3. `filesJson` → artifact records: `0001_platform_v1.sql:129-143` defines artifact metadata and `storage_key`; `0003_artifacts_grants.sql:8-13` defines `artifact_blobs` with `storage_key` and bytes. Artifact persistence uses those fields in `modules/artifacts/artifacts.ts:159,169,393,401,1033`.

## Decision and known behavior consequences

The independent scan confirms **no additive database column is needed**: 0/8 proposed storage columns have a direct read/write consumer. There is one wire-level exception to a literal zero-reference claim: `webhook_url` is accepted as a compatibility input and mapped to existing `callback_url`. `done` is also emitted as a derived compatibility value, and `createdByUserId` is rejected. None of those paths requires the proposed storage column.

Plan §6.2, lines 250-254, records two behavior consequences that remain product decisions before cutover:

- Legacy per-user operation scoping is lost. The legacy route filtered by `createdByUserId`; rework does not store or filter by that identity. If the user requires it, plan §6.2 calls for a separate `LEGACY-OP-SCOPE` packet.
- Legacy key-level admin is lost. Rework uses platform bearer authentication and has no `api_keys.role`; if the user requires it, plan §6.2 calls for a separate `API-KEY-ROLE` packet.

Plan §6.3, line 258, says these 20 `operations` columns are already present in migration 0024: `deleted_at`, `pipeline_json`, `steps_result_json`, `current_step`, `progress_percent`, `progress_message`, `endpoint_slug`, `output_format`, `output_content`, `extracted_data`, `output_file_path`, `declared_filename`, `total_input_tokens`, `total_output_tokens`, `pages_processed`, `model_used`, `total_cost_usd`, `usage_breakdown`, `error_message`, `failed_at_step`.

## Open items for coordinator

1. Confirm that the plan headline 0/8 consumers means no consumer of a proposed persisted column. The `webhook_url` compatibility input is read and mapped to `callback_url`; this does not justify another column, but it is a real wire-level consumer.
2. If plan §6.1 uses enum to mean a PostgreSQL enum, correct that description: `0001_platform_v1.sql:43` declares `operations.state text`, and the migration scan found no state enum or CHECK. The `done` replacement is the application terminal-state projection.

## Boundary

This receipt is read-only evidence except for this receipt file. No source, test, migration, or plan changed. No DB, build, or test was run. No commit, staging, push, or gate status changed.
