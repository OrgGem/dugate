# MED-1 verifyMigrations object drift fix

RESUME POINT: FINISHED — RED, post-change results, and limits are recorded below.

Scope: du-rework only. Changes recorded: `orchestrator/services/orchestrator/src/db/migrations.ts` and the new offline test `orchestrator/services/orchestrator/tests/med1-verify-migrations-object-drift.test.ts`; this receipt records the work. No live infrastructure.

## RED

cwd: `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`

Command: `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/med1-verify-migrations-object-drift.test.ts`

Exit code: `1`

Literal failure:

```text
Received promise resolved instead of rejected
Resolved to value: undefined
Test Suites: 1 failed, 1 total
Tests:       1 failed, 0 passed, 1 total
```

Test ID: `MED-1: verifyMigrations checks recorded migration objects › rejects a fully-applied ledger when a table from migration 0001 is missing`. The fake ledger contained every migration row while its catalog marked `tenants` missing.

## Fix and verification

`verifyMigrations()` now calls `recordedMigrationsMissingObjects(db, files, done)` after its existing ledger, filename, orphan-row, and missing-migration checks. That helper uses the existing `schemaObjectExists()` catalog probe; no second object parser or SQL query was added. Source references: `src/db/migrations.ts:127` (`schemaObjectExists`), `:154-169` (shared drift helper), `:191` (`migrate()` call), and `:307-318` (`verifyMigrations()` call and drift error).

On drift, `verifyMigrations()` now throws the new error prefix `schema verification failed: recorded migrations have missing table/index objects:` and lists the migration filename and missing object. The prior error behavior for missing tracking table, malformed/inconsistent ledger, filename mismatch, orphan rows, and missing migration files remains ahead of the new probe and passed the collateral suites below.

The new test fake returns a complete applied ledger, reports every catalog object present except `tenants`, records object probes, rejects unexpected SQL, and throws on `tx`. Verification now issues one read-only catalog `SELECT` per declared TABLE/INDEX object in each recorded migration, reusing the same helper as `migrate()`; it issues no write or transaction. The drift case also adds the new verification error described above.

### GREEN and collateral commands

All commands ran from `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`.

1. `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/med1-verify-migrations-object-drift.test.ts` — exit `0`; literal `Test Suites: 1 passed, 1 total` and `Tests: 1 passed, 1 total`.
2. `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/med1-migration-ledger-object-drift.test.ts` — exit `0`; literal `Test Suites: 1 passed, 1 total` and `Tests: 12 passed, 12 total`.
3. `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/migrations-ledger-guard.test.ts tests/migration-verify-trap-fix.test.ts` — exit `0`; literal `Test Suites: 2 passed, 2 total` and `Tests: 25 passed, 25 total`.
4. `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` — exit `0`; output size `0` bytes.

The only failing test result was the intentional fail-first RED recorded above. No live PostgreSQL/Redis test was run.

## Files edited

- `orchestrator/services/orchestrator/src/db/migrations.ts`
- `orchestrator/services/orchestrator/tests/med1-verify-migrations-object-drift.test.ts` (new)
- `coordination/reports/fix-med1-verify-migrations-half2-2026-10-08.md`

No gate status was changed. No commit, stage, or push was performed.
