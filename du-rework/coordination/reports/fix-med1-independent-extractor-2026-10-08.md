# MED-1 migration drift test extractor blind-spot fix

Scope: du-rework only. The test changes are limited to `orchestrator/services/orchestrator/tests/med1-migration-ledger-object-drift.test.ts`; this file is the receipt. No product source, other test, migration SQL, or OpenAPI file was edited.

## (a) Fail-first RED

cwd: `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`

Command: `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/med1-migration-ledger-object-drift.test.ts`

Exit code: `1`

Test ID: `MED-1 blind-spot reproduction › sees the shipped CREATE EXTENSION object outside the TABLE/INDEX scan`

Literal output:

```text
Expected value: "pgcrypto"
Received array: []
Test Suites: 1 failed, 1 total
Tests:       1 failed, 10 passed, 11 total
```

The new assertion found `CREATE EXTENSION IF NOT EXISTS pgcrypto` in migration `0001_platform_v1.sql`, while the pre-fix TABLE/INDEX extractor returned an empty array for that declaration.

## (b) Test design selected

Selected approach **(b), a migration DDL meta-test**. The test now tokenizes command-leading SQL words independently of the runtime parser, scans every shipped migration, and requires every observed `CREATE` or `ALTER` family to have an explicit entry in `DDL_COVERAGE_POLICY`. An unclassified family such as `CREATE SEQUENCE`, `CREATE VIEW`, `CREATE TYPE`, or `ALTER SEQUENCE` fails the meta-test until its coverage policy is addressed. The fixture's `declaredObjects` is now derived from this independent scanner and filters only TABLE/INDEX names for the existing runtime-shaped scenarios.

This keeps the existing ten test cases and their assertions unchanged while making non-TABLE/INDEX DDL visible. The policy explicitly labels DDL that the current runtime does not probe as inventory-only; it does not claim those objects are checked by `migrate()`.

Relevant code: `tests/med1-migration-ledger-object-drift.test.ts:33` (`DDL_COVERAGE_POLICY`), `:108` (`scanMigrationDdl`), and `:156` (`declaredObjects`).

## (c) Post-change GREEN

cwd: `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`

Command: `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/med1-migration-ledger-object-drift.test.ts`

Exit code: `0`

Literal summary:

```text
Test Suites: 1 passed, 1 total
Tests:       12 passed, 12 total
```

The two added test IDs are at `tests/med1-migration-ledger-object-drift.test.ts:354-359` (sample `CREATE EXTENSION`) and `:361-369` (all shipped command families have coverage policy).

## (d) Blind-spot sample

The final scanner reports `CREATE EXTENSION` with object name `pgcrypto` from migration 0001, and the meta-test compares every observed command family against the explicit policy map. Thus the sample mechanism is no longer absent from the test's inventory. The policy marks extension, function, trigger, ALTER-column, and ALTER-constraint families as inventory-only. MED-1 runtime existence checks still cover TABLE/INDEX only; this test does not claim runtime detection for extensions, columns, constraints, functions, or triggers.

## (e) Migration regression suites

cwd: `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`

Command: `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/med1-migration-ledger-object-drift.test.ts tests/migrations-ledger-guard.test.ts tests/migrations.test.ts tests/migration-verify-trap-fix.test.ts`

Exit code: `0`

Literal summary:

```text
Test Suites: 3 passed, 3 total
Tests:       37 passed, 37 total
```

The requested offline-config command excludes `migrations.test.ts`: `jest.unit.config.cjs` lists it among its live suites. Supplemental command: `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --runTestsByPath tests/migrations.test.ts`; exit code `1`, literal `No tests found, exiting with code 1`. This exclusion did not execute a failing test. Running the file with the regular Jest config, without enabling live infrastructure, returned exit `0`:

Command: `node node_modules/jest/bin/jest.js --runInBand --config jest.config.cjs --runTestsByPath tests/migrations.test.ts`

```text
migrations.test.ts: SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.
Test Suites: 1 skipped, 0 of 1 total
Tests:       10 skipped, 10 total
```

No live PostgreSQL/Redis test was run.

## (f) Typecheck

cwd: `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`

Command: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`

Exit code: `0`; output size: `0` bytes.

## (g) Files edited

- `orchestrator/services/orchestrator/tests/med1-migration-ledger-object-drift.test.ts`
- `coordination/reports/fix-med1-independent-extractor-2026-10-08.md`

No gate status was changed. No commit, stage, or push was performed.
