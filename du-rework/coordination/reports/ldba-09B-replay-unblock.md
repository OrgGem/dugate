# LDBA-09B Replay Unblock Receipt

Date: 2026-10-09

## Changes

- `ldba-03-production-adapter.cjs` now compares canonical decimal values across numbers, BigInts, and numeric strings; JSON text against parsed objects/arrays; and `Date`/ISO/UTC timestamp values at millisecond precision. Buffer and Uint8Array byte normalization remains `{ bytes: hex }`.
- Added `JSONB_COLUMNS` handling in the production adapter. Top-level JavaScript arrays bound to JSONB columns are serialized with `JSON.stringify` before insert. This preserves JSON arrays: node-postgres otherwise prepares an empty JavaScript array as `{}`, which PostgreSQL stores as an empty JSON object. The harness replay exposed this on `profile_bindings.connections_override`.
- Adapter regression coverage in `tests/ldba-03-production-adapter.test.cjs:230-284` covers number/string and BigInt/string equivalence, decimal scale, JSON text/object in both directions, Date versus UTC text, JSONB-array parameter encoding, and nonnumeric mismatch behavior.
- Updated `scripts/ldba-09-harness.cjs` to require 38 orchestrator migrations, 9 connector migrations, migration ledgers 38/9, and 34 public base tables after migrations.
- Existing artifact tenant enrichment remains before `rowMatches` in validation and apply paths.

## Offline verification

Command: `node --test tests/ldba-03-runner-skip.test.cjs tests/ldba-03-backfill-offline.test.cjs`

Literal summary: `ℹ tests 36`, `ℹ pass 36`, `ℹ fail 0`. Exit code: `0`.

Command: `node --test tests/ldba-03-production-adapter.test.cjs`

Literal summary: `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0`. Exit code: `0`.

The in-container runner-skip suite also reported `ℹ tests 16`, `ℹ pass 16`, `ℹ fail 0` during the successful rehearsal.

## Final disposable PG16 rehearsal

Command: `node scripts/ldba-09-harness.cjs`

Host process exit code: `0`.

Migration check literal: `MIGRATIONS orchestrator=38 connector=9 target_tables=34 schema_migrations=38 connector_schema_migrations=9`.

| Round | Literal result | Evidence |
|---|---|---|
| 1. Preflight | `RUNNER ldba-09-skip-fixture-adapter.cjs --preflight policy=report exit=0 status=PREFLIGHT_READY` | 22 source rows read, 0 failed, 10 controlled skips, 21 destination rows planned. Marker: `FIXTURE_PREFLIGHT_READY`. |
| 2. First execute | `RUNNER ldba-09-skip-fixture-adapter.cjs --execute policy=report exit=0 status=APPLIED` | 22 source rows read, 12 written, 10 skipped, 0 failed; 20 destination rows written. Marker: `FIXTURE_APPLIED_FIRST`. |
| 3. Replay | `RUNNER ldba-09-skip-fixture-adapter.cjs --execute policy=report exit=0 status=APPLIED` | Every reported preflight entry returned `identical`; no row failures. Marker: `FIXTURE_APPLIED_REPLAY_ALL_IDENTICAL`. |
| 4. Fail policy | `RUNNER ldba-09-skip-fixture-adapter.cjs --preflight policy=fail exit=1 status=BLOCKED_SKIPPED_ROWS` | Expected fail-closed result for the 10 controlled source skips; no writes. Marker: `FIXTURE_FAIL_POLICY_BLOCKED`. |
| 5. LDBA-08 regression | `RUNNER ldba-03-production-adapter.cjs --preflight policy=default exit=1 status=BLOCKED_TRANSFORM` | Expected context-policy failures: 3 `ExternalApiConnection`, 2 `ProfileEndpoint`, 1 `AppSetting`, and 2 `FileCache`. Marker: `LDBA08_REGRESSION_EXPECTED_CONTEXT_FAILURES`. |

Final target row counts were: `api_keys=2`, `connector_revisions=2`, `secret_versions=2`, `profile_bindings=2`, `profile_active_revisions=2`, `profile_names=2`, `operations=2`, `connector_prompt_overrides=1`, `artifacts=2`, `artifact_blobs=2`, `admin_local_users=0`, `user_profile_assignments=0`, `legacy_workflow_schemas=1`.

Harness completion literals: `HARNESS_PASS disposable_pg16=1 network=none tmpfs=1 published_ports=0`, `IN_CONTAINER_EXIT=0`, `CONTAINER_REMOVED du-ldba09-pg16-1791511702599-21252`.

## Correction history

The initial LDBA-09B harness attempts stopped at the stale 37-migration assertion. LDBA-09C updated the migration count and table-count assertion; the rehearsal then measured 34 tables. The first replay after those count changes identified the JSONB array binding issue described above. The adapter fix resolved it, and the final rehearsal completed all five rounds. Earlier failed attempt results are superseded by the final successful run above.

No live or legacy database was accessed, `.env.live` was not read, and no DB window is claimed. The harness used disposable PostgreSQL 16 with `--network none`, tmpfs storage, and no published ports; the container was removed. Changes were limited to the adapter, its leased test, the LDBA-09 harness, and this receipt. No commit, stage, push, or gate tick was performed.
