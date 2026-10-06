# GATE-COVERAGE-817 — 2026-10-05

Task `task_acf922970856`, dispatch `ctx_1eda299bbc1d`. Scope was limited to `metadata-auth-counter.ts` and counter tests; no migration, wrapper, reader, A2 flip, commit, or task tick was changed.

## Change

The gate now reports attempted/successful slot queries, slots read and scanned, expected and observed tenant IDs, missing/unexpected tenants, visible rows, empty slots with possible explanations, and calls made to the real crypto reader. Slot queries include NULL-valued rows so tenant visibility is measured independently of whether a metadata value exists. PASS now requires all eight slots to be scanned and an exact match against a non-empty expected tenant list supplied by an independent full-visibility census; missing or unexpected tenants, absent/empty census, unattributed rows, and auth blockers all prevent PASS. A slot query error still propagates as an error, which is fail-closed.

## PostgreSQL 16 RLS reproduction

Used a new disposable PostgreSQL container, `dugate-gate-coverage-817-pg16`, bound only to `127.0.0.1:55417`; `SHOW server_version` returned `16.11`. The fixture’s independent superuser census returned tenants A and B. A non-superuser `gate_cov_817_reader` role had RLS policies that exposed tenant A through operations and its joined rows while hiding tenant B. Before the restricted run, all 11 non-null metadata values visible for A were sealed with the deterministic local test key provider and verified by the production metadata reader.

The test asserted that all 8/8 slot queries succeeded, all 8/8 slots were read and scanned, one tenant was observed, tenant B was missing, and all 11 visible values authenticated with `blockers=0`. Despite those clean auth counts, `coverage.complete` was false and the gate returned `FAIL` with the RLS/policy-filtering explanation. This isolates tenant coverage as the failure cause: the previous auth-only predicate would have returned PASS for these same visible rows. Empty slots were also reported; a unit case verifies that a visible row with a NULL value is reported as empty and does not erase a missing-tenant blocker.

The disposable PostgreSQL container was removed after the run. No project database was used or changed.

## Verification

Working directory for package commands: `D:\Git\dugate\du-rework\services\orchestrator`.

| Command | Result |
|---|---|
| `$env:GATE_AUTH_PG_URL='postgresql://postgres:gatecov817-local@127.0.0.1:55417/gatecov817'; pnpm exec jest --runInBand tests/gate-authenticate-808.test.ts tests/gate-authenticate-808-pg16.test.ts` | Exit 0; 2 suites passed, 10 tests passed. Includes the live PostgreSQL 16 RLS reproduction. |
| `pnpm exec jest --config jest.vfy-817-temp.config.cjs --runInBand tests/bypass-fix-810.test.ts` (temporary config removed afterward; `ts-jest` diagnostics disabled only for this run) | Exit 0; 1 suite passed, 13 tests passed, including BA-05’s no-census fail-closed assertion. |
| `pnpm exec tsc --noEmit --strict --target ES2022 --module commonjs --moduleResolution node --esModuleInterop --skipLibCheck src/modules/encryption/metadata-auth-counter.ts` | Exit 0. Counter and its imported dependency graph typecheck. |
| `pnpm exec tsc --noEmit -p tsconfig.json` | Exit 1, unrelated out-of-lease error: `src/modules/runtime/runtime.ts(478,38): TS2554 Expected 1 arguments, but got 2.` Wrapper/reader files were left unchanged as required. |

## Offline-provable and live-only

Offline-provable here: PostgreSQL 16.11 row-level security can hide a seeded tenant while every slot query succeeds; the independent census comparison detects the gap and blocks PASS. Unit tests cover absent census, empty slots, missing tenant IDs, and explicit query/authentication counts. The metadata key provider in the PG fixture is deterministic and local, so this does not validate production Vault credentials or the project database’s actual RLS policies.

Still live-only: run the gate against the target database using a role with full, independently verified tenant-census visibility and the intended production metadata key provider. Without privileges that can see the complete expected tenant set, the caller cannot establish coverage; the API therefore fails closed when the census is omitted or empty. No live project database check was run in this task.
