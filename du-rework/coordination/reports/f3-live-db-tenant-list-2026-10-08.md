# F-3 live PostgreSQL tenant-list verification — 2026-10-08

Test lease: orchestrator/services/orchestrator/tests/f3-tenant-list-live-db.test.ts

DB window CLAIMED at 2026-10-08 02:59:17 UTC
DB window RELEASED at 2026-10-08 03:03:38 UTC

Scope: du-rework only. The only test file created for this task is orchestrator/services/orchestrator/tests/f3-tenant-list-live-db.test.ts. No product source or existing test files were edited.

The database environment variables DATABASE_URL and REDIS_URL were unset before the run. The test used guarded sandbox defaults: postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test and redis://127.0.0.1:6380. It then generated an isolated PostgreSQL schema and dedicated Redis DB index for each run. DU_LIVE_INFRA=1 was set for the live runs. Teardown closed the app, dropped only the generated schema, and quit the Redis probe.

## Resume point

The focused live test passed against the real PostgreSQL and Redis services. The final pass includes an explicit PING assertion against the isolated Redis DB. The DB window is released.

## Commands and results

Cwd for all commands: D:\Git\dugate\du-rework\orchestrator\services\orchestrator.

- Command: node --version
  Exit code: 0
  Literal output: v22.16.0

- First live run, before adding the explicit Redis PING assertion:
  Command: $env:DU_LIVE_INFRA = '1'; node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/f3-tenant-list-live-db.test.ts
  Exit code: 0
  Literal line: Tests: 2 passed, 2 total

- Final live run, including the explicit Redis PING assertion:
  Command: $env:DU_LIVE_INFRA = '1'; node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/f3-tenant-list-live-db.test.ts
  Exit code: 0
  Literal lines: Test Suites: 1 passed, 1 total; Tests: 2 passed, 2 total

The tests compare direct listTenantPage results with a same-schema SQL snapshot and the real internal GET /api/v1/admin/tenants route. They cover platform forward/backward pagination, tenant-operator single-row scope, and reuse of a foreign boundary cursor under tenant scope. The final run explicitly verifies Redis responds PONG through the isolated Redis URL. No assertion failed.

- Typecheck command: node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
  Exit code: 0; no diagnostics (the shell printed TSC_EXIT=0). tsconfig.json includes src/**/*.ts; Jest also compiled and executed the new test file.

## Bugs / deviations

No product bug was observed in the tested path. The prior f3-tenants-route-live.test.ts and the verify-dsh2/F-3 receipts were read only; the existing test was not edited. This task adds a separate focused live test. No test red occurred.

## Gate status

No VERIFIED or ACCEPTED status has been set. Section/gate ownership remains with the coordinator and user. No commit, git add, or push was performed.



