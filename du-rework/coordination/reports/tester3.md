# Tester-3 Offline Package Receipt

Date: 2026-09-25 (Asia/Bangkok)  
Working directory: `D:\Git\dugate\du-rework`

## Boundary

All checks below ran offline. Tester-3 did not connect to or open PostgreSQL `:5433` or Redis `:6380`; no DB writes were issued. The reviewed package scripts/tests have no DB or Redis setup. The PostgreSQL-looking strings in observability tests are redaction fixtures, not connection attempts.

## Results

| Package | Command | ExitCode | Result |
|---|---|---:|---|
| `@du/contracts` | `pnpm --filter @du/contracts test:typecheck` | 0 | `tsc --noEmit -p tsconfig.json` passed. |
| `@du/observability` | `pnpm --filter @du/observability test` | 0 | 1 suite, 22 tests passed. |
| `@du/egress` | `pnpm --filter @du/egress test:unit` | 0 | 3 suites, 34 tests passed. |

The requested `test:typecheck` and `test:unit` scripts were initially absent from the contracts and egress package manifests. Added aliases to their existing checks (`tsc --noEmit -p tsconfig.json` and `jest --runInBand`, respectively), then reran the exact requested commands. The final receipts above are from those actual script executions.

No live test, DB/Redis connection, migration, commit, or push was performed.

## @du/example-review offline unit receipt

Date: 2026-09-25 (Asia/Bangkok)  
Working directory: `D:\Git\dugate\du-rework`

- Command: `pnpm --filter @du/example-review test:unit`
- ExitCode: `0`
- Jest result: **13 suites passed, 123 tests passed**, 0 failed; 7.832 seconds.
- The package script runs `jest --testPathIgnorePatterns=integration --runInBand`; the three integration suites that contain the DB/Redis setup are excluded. Static preflight found no DB/Redis connection setup in the included unit-test files. The `5433`/`6380` references are confined to excluded integration fixtures/target guards or inert test data.
- No PostgreSQL `:5433` or Redis `:6380` connection/port was opened; zero DB writes.

The requested expected count was 119 tests; the current suite reported 123 tests, all passing. This receipt preserves Jest's actual count.

## @du/worker-sdk offline regression receipt

Date: 2026-09-25 (Asia/Bangkok)  
Working directory: `D:\Git\dugate\du-rework`

### Final verification

| Command | ExitCode | Result |
|---|---:|---|
| `pnpm --filter @du/worker-sdk lint` | 0 | TypeScript `tsc --noEmit -p tsconfig.json` passed. |
| `pnpm --filter @du/worker-sdk build` | 0 | TypeScript build passed. |
| `pnpm --filter @du/worker-sdk test` | 0 | 11 suites passed; 150 tests passed, 0 failed. `artifact-stat.test.ts` passed. |

The first full test attempt returned ExitCode 1 with 10/11 suites and 148/150 tests passing. Two real-loopback boundary cases (`B3-lock-c sha mismatch deletes file` and `FIX-CR-08 caller-signal-aborts-body`) failed on transport/timing. A focused rerun of both cases passed (2 passed, 4 other cases skipped by name pattern), followed by the final full rerun above passing 11/11 and 150/150. No source or test files were changed during this verification.

### Boundary confirmation

Preflight confirmed the worker-sdk package test script runs Jest in band and the network-boundary harness binds only loopback port `0`. No PostgreSQL `:5433` or Redis `:6380` connection/port was opened; zero DB writes. The observed `5433` reference in a workspace-reference test is an injected `ECONNREFUSED` fixture string, not a connection attempt.

No live test, DB/Redis connection, migration, commit, or push was performed.

## @du/connector VAULT-01 offline isolation receipt

Date: 2026-09-25 (Asia/Bangkok)

- Typecheck command from `D:\Git\dugate\du-rework`: `pnpm --filter @du/connector typecheck` — **ExitCode 0** (`tsc --noEmit -p tsconfig.json`).
- Jest command from `D:\Git\dugate\du-rework\services\connector`: `npx jest tests/vault-account-isolation.test.ts --runInBand` — **ExitCode 0**; 1 suite passed, **7/7 tests passed**.
- The suite uses an in-memory invocation ledger/quota, a stubbed Vault `readSecret`, and a stub provider transport. Six mismatched tenant/connector/account paths fail before Vault read and provider dispatch; the matching account path reads the pinned reference and dispatches once.
- No PostgreSQL, Redis, or Vault connection/port was opened; zero DB writes.

## Step C � Worker-SDK & Document-Core offline acceptance

Date: 2026-09-25 (Asia/Bangkok)  
Working directory: `D:\Git\dugate\du-rework`

### Receipts

| Command | ExitCode | Result |
|---|---:|---|
| `pnpm --filter @du/worker-sdk lint` | 0 | TypeScript `tsc --noEmit -p tsconfig.json` passed. |
| `pnpm --filter @du/worker-sdk test` | 0 | **12/12 suites, 171/171 tests passed**; 0 failed. `network-boundaries.boundary.test.ts` passed in the full run, so no focused rerun was needed. |
| `pnpm --filter @du/document-core lint` | 0 | TypeScript `tsc --noEmit -p tsconfig.json` passed. |
| `pnpm --filter @du/document-core test:typecheck` | 0 | TypeScript `tsc --noEmit -p tsconfig.test.json` passed. |
| `npx jest tests/parser-budgets.test.ts --runInBand` (from `businesses/document-core`) | 0 | 1 suite, **48/48 tests passed**. |
| `npx jest tests/read-stream-acquisition.test.ts --runInBand` (from `businesses/document-core`) | 0 | 1 suite, **8/8 tests passed**. |

### P8-03 target and boundary

The requested `businesses/document-core/tests/p8-03-zero-data-loss.test.ts` is absent. Repository filename search found `businesses/document-core/tests/p8-03-provider-convergence.test.ts` and `services/connector/tests/p8-03-convergence.test.ts`. The document-core provider-convergence suite constructs `PgSqlClient`, defaults to a PostgreSQL URL on `127.0.0.1:5433`, and contains `INSERT INTO operations`, `tasks`, and `usage_events`; it was inspected but deliberately **not run** to honor the zero DB writes / no `:5433` connection boundary. The connector suite was outside the requested document-core target.

Static review of the executed worker-SDK and two document-core suites confirmed offline mock/in-memory or temporary-file behavior. The network-boundary test uses loopback ephemeral ports only. No DB window was opened, no PostgreSQL `:5433` or Redis `:6380` connection was made, and zero DB writes were issued.
