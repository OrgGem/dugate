# Public upload encryption gateway test repair

**Status:** Fixed in the test fake; verification passed. No commit, staging, or push.

## Query assessment

The `UPDATE artifacts SET operation_id=$2 ...` is valid product behavior. During submission, a public/admission-time upload starts with `operation_id IS NULL`; after creating the operation, `submission.ts` attaches the same-tenant READY artifact to that operation within the same transaction. The SQL also requires `task_id IS NULL` and only updates still-unlinked rows, preventing reassignment. This association is needed by worker artifact access.

## Scope

Only the fake DB handler in `orchestrator/services/orchestrator/tests/public-upload-encryption-gateway.test.ts` will be changed. No product source, other lane test, OpenAPI file, or gate status will be changed. Offline only; no DB-window claim.

## Fail-first RED

From `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`:

```text
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/public-upload-encryption-gateway.test.ts
Exit code: 1
Test Suites: 1 failed, 1 total
Tests:       1 failed, 11 passed, 12 total
```

The sole failure is the scripted DB's missing handler for the valid artifact association update. The exact query and stack are recorded in the terminal run; the test expectation itself remains unchanged.

## Test-only change

In `orchestrator/services/orchestrator/tests/public-upload-encryption-gateway.test.ts:250-252,388-403`, the scripted DB now models the missing association update: it checks that the listed artifact exists, matches the tenant, is READY and still unlinked, records the operation association, and returns `rowCount: 1` with the updated artifact ID. The test's assertions and expected HTTP status/body were not changed.

## GREEN and typecheck

From `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`:

```text
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/public-upload-encryption-gateway.test.ts
Exit code: 0
Test Suites: 1 passed, 1 total
Tests:       12 passed, 12 total
```

```text
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
Exit code: 0
```

The TypeScript command has no Jest `Tests:` output line. No live DB or DB window was used or claimed. No gate was ticked.
