# LDBA-09 runner reconciliation receipt

Date: 2026-10-09
Scope: du-rework only
Status: BLOCKED at first disposable PG16 fixture preflight

## Changes in lease

- Updated `orchestrator/services/orchestrator/scripts/ldba-03-backfill.cjs` with exported `RowSkip` and the exact four-table `SKIP_POLICIES` allowlist. Adapter-declared skips are accepted only for the matching source row and allowlisted table/code pair; rejected codes become `UNAPPROVED_SKIP`. `CONTEXT_POLICY_REQUIRED` remains a transform failure.
- Added skip report entries with source key, field, code, and reason, plus per-table and global skip counts. A non-enumerable source-key registry tracks skipped connectors and users for dependent overrides and assignments.
- Added runner skips for invalid override connection/API-key UUIDs, skipped connector references, invalid assignment user/API-key UUIDs, and assignments referencing skipped users.
- Added pending-rehash identity handling for `{ pending: true, reason }` and backwards compatibility for `PASSWORD_RESET_REQUIRED`. Neither path writes an identity row or creates a password hash. Username and role validation run before identity preparation.
- Corrected workflow winner ordering and duplicate diagnostics to read `AppSetting.row.key`.
- Added `LDBA_SKIP_POLICY=report|fail`; invalid values return CLI exit 2, while `fail` returns `BLOCKED_SKIPPED_ROWS` when controlled skips exist.
- Added offline tests, the test-only fixture adapter, and the disposable-container harness in the remaining leased files.

## Offline validation

Command: `node --test tests/ldba-03-runner-skip.test.cjs tests/ldba-03-backfill-offline.test.cjs`

Literal summary: tests 34, pass 34, fail 0, exit 0.

Command: `node --test tests/ldba-03-runner-skip.test.cjs`

Literal summary: tests 14, pass 14, fail 0, exit 0.

Syntax checks for the runner, new test, fixture adapter, and harness: exit 0.
Hygiene: all four files contain zero ASCII double-quote characters and zero trailing-whitespace lines.

## Disposable rehearsal

Command: `node scripts/ldba-09-harness.cjs`

The harness used `postgres:16-alpine` with `--network none`, a tmpfs data directory, and no published ports. Node 24.21.0 and the payload ran inside that container. It was removed after failure. No production, legacy, or shared database was contacted.

The in-container W2 offline test passed: tests 14, pass 14, fail 0, exit 0.

Migration evidence before the runner preflight:

- Orchestrator: 37 files applied; `schema_migrations` count 37.
- Connector: 9 files applied; `connector_schema_migrations` count 9.
- Target base tables: 33.
- Tenant `legacy-default` was inserted by name only; the generated UUID resolved at runtime as `ffde5cd7-ab81-4086-afcd-14b6d82219c6`.
- Synthetic source rows: Operation 2; ApiKey 2; ExternalApiConnection 3; ExternalApiOverride 3; ProfileEndpoint 2; AppSetting 3; FileCache 2; User 3; UserProfileAssignment 2; total 22.

First fixture preflight literal:

`RUNNER ldba-09-skip-fixture-adapter.cjs --preflight policy=report exit=1 status=BLOCKED_TARGET_CONFLICT`

The report read 22 source rows, counted 10 skipped rows, and recorded 2 failures. Both failures were `ExternalApiConnection` rows, source keys `30000000-0000-4000-8000-000000000001` and `legacy-connector-text`, code `TARGET_23502`. The adapter intentionally redacts the rejected target column from the report. Read-only schema inspection identifies the fixture defect: `connector_revisions.adapter` is `TEXT NOT NULL` in connector migration `001_connector.sql:1-9`, while the fixture adapter revision omits `adapter`.

Per the stop condition in the dispatch spec, no fixture execute, idempotent replay, fail-policy run, or LDBA-08 regression preflight was attempted after this failure. Harness literal: `IN_CONTAINER_EXIT=1`; cleanup literal: `CONTAINER_REMOVED du-ldba09-pg16-1791504602113-28228`.

## Open items for coordinator

- The fixture preflight is blocked by the omitted `adapter` field described above. The dispatch says to stop when L1 does not reach `PREFLIGHT_READY`; no retry was made.
- The requested AppSetting fixture says two different keys must have the same workflow slug. The current parser derives the slug directly from the suffix of `row.key`, so different keys necessarily produce different slugs. This rehearsal used duplicate rows with the same key to exercise the diagnostic output; it cannot prove a different-key tiebreak. The source key uniqueness concern is also recorded in the LDBA-08 receipt.
- The requested three User rows must all skip pending rehash, while one of two assignments must reference a user written by the same run. Those conditions cannot both hold without adding a ready identity with a scrypt hash. No credential or hash was fabricated. The fixture keeps all three users pending and represents the second assignment with a non-UUID source user id, so both assignment rows take controlled skip paths.
- Static review found the harness expected skip list has the two override outcomes attached to the wrong override source keys: the fixture maps override 2 to the skipped UUID connector and override 3 to the text connector. The preflight stopped before this assertion ran. This remains for coordinator disposition with the fixture contract issues.
- A1 remains open. All rehearsal timestamps were explicit synthetic UTC values and do not establish timezone behavior for a real legacy source.

## Boundary

Only the five leased files were written. No source, test, config, migration, plan, or document outside the lease was changed. No DB window is claimed. No commit, git add, push, or gate tick was performed.
