# Independent verification: WFA section 8 MED-1

RESUME POINT: INDEPENDENT REVIEW COMPLETE — all requested offline runs recorded; a verify-only boot residual remains.

Scope: du-rework only. Canonical product source and tests were not edited. The requested regression mutation was applied as an in-memory read overlay in a separate Jest process; the process ended before the normal green rerun. No live PostgreSQL/DB window was used or claimed. No gate was marked.

Node: C:\nvm4w\nodejs\node.exe, v22.16.0.
Test cwd for package commands: D:\Git\dugate\du-rework\orchestrator\services\orchestrator.

## Command results

| Command | Exit | Literal Tests / result |
|---|---:|---|
| node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json | 0 | Typecheck; no output |
| node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/med1-migration-ledger-object-drift.test.ts | 0 | Test Suites: 1 passed, 1 total; Tests:       10 passed, 10 total |
| node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/migration-0032-rollback.test.ts tests/migrations-ledger-guard.test.ts tests/migration-verify-trap-fix.test.ts tests/rfx10-seed-gate.test.ts tests/webhook-error-boundaries.boundary.test.ts | 0 | Test Suites: 5 passed, 5 total; Tests:       69 passed, 69 total |
| Initial in-memory mutation harness attempt: C:\nvm4w\nodejs\node.exe D:\Git\dugate\du-rework\coordination\reports\raw\verify-section8-med1-independent-legA-2026-10-08\med1-in-memory-mutation-probe.cjs --runInBand --no-cache --config jest.unit.config.cjs tests/med1-migration-ledger-object-drift.test.ts | 1 | Test Suites: 1 failed, 1 total; Tests:       0 total. Harness did not collect tests because its first selector matched an ambiguous marker. Not a product/test assertion result. |
| Corrected in-memory mutation harness attempt: C:\nvm4w\nodejs\node.exe D:\Git\dugate\du-rework\coordination\reports\raw\verify-section8-med1-independent-legA-2026-10-08\med1-in-memory-mutation-probe.cjs --runInBand --no-cache --config jest.unit.config.cjs tests/med1-migration-ledger-object-drift.test.ts | 1 | Test Suites: 1 failed, 1 total; Tests:       0 total. Harness did not collect tests because Jest reread an already-mutated transform input. Not a product/test assertion result. |
| Corrected in-memory mutation probe: C:\nvm4w\nodejs\node.exe D:\Git\dugate\du-rework\coordination\reports\raw\verify-section8-med1-independent-legA-2026-10-08\med1-in-memory-mutation-probe.cjs --runInBand --no-cache --config jest.unit.config.cjs tests/med1-migration-ledger-object-drift.test.ts | 1 | Test Suites: 1 failed, 1 total; Tests:       5 failed, 5 passed, 10 total. Mutation marker confirms the drift-check block was removed in memory. |
| Normal-source rerun after mutation process: node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/med1-migration-ledger-object-drift.test.ts | 0 | Test Suites: 1 passed, 1 total; Tests:       10 passed, 10 total |

All package commands used cwd D:\Git\dugate\du-rework\orchestrator\services\orchestrator. The mutation command used this cwd as well; its exact helper invocation and raw output are in the raw log. The first two mutation harness setup failures are preserved and not counted as the required mutation red.

The five-suite collateral run also emitted Jest's post-run open-handle warning; Jest still exited 0 with 69/69 tests. Full warning is preserved in raw/03-collateral.stderr.log.

## Mutation red (literal)

From the successful in-memory mutant run:

- Received promise resolved instead of rejected
- Resolved to value: {"applied": []}
- In the pending-migration case: Resolved to value: {"applied": ["0037_legacy_workflow_schema_catalog.sql"]}
- Test summary: Tests:       5 failed, 5 passed, 10 total
- Exit code: 1

The normal-source rerun after the mutant process completed green: Tests:       10 passed, 10 total; exit 0. Canonical source/tests remained unedited throughout, so no file restore was needed.

## Hash checkpoints

| Checkpoint | SHA-256 of orchestrator/services/orchestrator/src/db/migrations.ts |
|---|---|
| Before first run | D618ADABC3FB66BF14473C9F9C6D2A871CBD185D1A2CDC33F7ADAB2C1BDFF0F6 |
| After typecheck | D618ADABC3FB66BF14473C9F9C6D2A871CBD185D1A2CDC33F7ADAB2C1BDFF0F6 |
| After focused suite | D618ADABC3FB66BF14473C9F9C6D2A871CBD185D1A2CDC33F7ADAB2C1BDFF0F6 |
| After five collateral suites | D618ADABC3FB66BF14473C9F9C6D2A871CBD185D1A2CDC33F7ADAB2C1BDFF0F6 |
| After mutation harness attempts and successful mutant run | D618ADABC3FB66BF14473C9F9C6D2A871CBD185D1A2CDC33F7ADAB2C1BDFF0F6 |
| After final normal-source rerun / final checkpoint at 2026-10-08 03:21:14.038 UTC | D618ADABC3FB66BF14473C9F9C6D2A871CBD185D1A2CDC33F7ADAB2C1BDFF0F6 |

No source hash change was detected.

## Review verdicts

- a — PASS. migrations.ts:191-204 checks drift and throws before the pending loop at :208.
- b — PARTIAL. The guard aborts before pending migration DDL and ledger INSERTs, as checked by med1 test :159-170. It does not precede every DDL statement: migrate() calls ensureTrackingTable at migrations.ts:183, which sends CREATE TABLE IF NOT EXISTS schema_migrations at :69-76. The fake handles that statement at test :56 without adding it to db.ddl, so its empty-ddl assertion excludes this setup DDL.
- c — PASS in implementation. migrations.ts:114-119 strips -- comments and matches CREATE TABLE and CREATE INDEX separately. Migration 0019_operations_deadline_coalesce_index.sql contains index-only DDL at :65-79; the test pins extracted names at med1 test :223-228, and its exhaustive object-drop test is at :190-203. Coverage nuance about the duplicated local extractor and comment-strip assertion is in raw/08-code-review.log.
- d — LOAD-BEARING. The in-memory mutant caused 5 assertions to fail; restoring normal execution by ending that process led to 10/10 green.

## Residual: verifyMigrations

My code reading: verifyMigrations at migrations.ts:230-306 checks the ledger and migration-file set but does not validate the database objects those files declare. create-app.ts:277-280 calls migrate() only when autoMigrate is true and calls verifyMigrations() otherwise. So verify-only startup can still pass after a recorded table/index has been dropped. The narrow migrate() behavior is fixed; the broader boot-readiness MED-1 finding is not completely closed unless the accepted operational contract requires migrate before every applicable boot and explicitly accepts the verify-only residual.

No gate was marked.


