# FUNCTEST-C — connector offline functional test receipt

**Date:** 2026-10-02  
**Scope:** `du-rework/services/connector/tests`, following `coordination/dispatch-specs/2026-10-02-0245-FUNCTEST-C-connector-offline.md`. No source or test files were modified. No PG, Redis, S3, live Vault, Docker, or external service infrastructure was started or used; local in-test loopback servers and mocks remained within the test processes.

Each executed suite was run individually from `du-rework/services/connector` using the literal command shown in its row. Every executed command exited `0`.

## Executed suites

| Suite | Passed | Failed | Skipped | Exit | Literal command |
|---|---:|---:|---:|---:|---|
| `canonical-hash-parity.test.ts` | 2 | 0 | 0 | 0 | `npx jest --runInBand tests/canonical-hash-parity.test.ts` |
| `connector.test.ts` | 21 | 0 | 0 | 0 | `npx jest --runInBand tests/connector.test.ts` |
| `composition.test.ts` | 4 | 0 | 0 | 0 | `npx jest --runInBand tests/composition.test.ts` |
| `runtime-foundations.test.ts` | 5 | 0 | 0 | 0 | `npx jest --runInBand tests/runtime-foundations.test.ts` |
| `service-auth.test.ts` | 7 | 0 | 0 | 0 | `npx jest --runInBand tests/service-auth.test.ts` |
| `secret-resolver.test.ts` | 23 | 0 | 0 | 0 | `npx jest --runInBand tests/secret-resolver.test.ts` |
| `vault-machine-policies-offline.test.ts` | 9 | 0 | 0 | 0 | `npx jest --runInBand tests/vault-machine-policies-offline.test.ts` |
| `vault-bootstrap-offline.test.ts` | 11 | 0 | 0 | 0 | `npx jest --runInBand tests/vault-bootstrap-offline.test.ts` |
| `revision-binding.schema.test.ts` | 9 | 0 | 0 | 0 | `npx jest --runInBand tests/revision-binding.schema.test.ts` |
| `revision-binding.db.test.ts` | 28 | 0 | 0 | 0 | `npx jest --runInBand tests/revision-binding.db.test.ts` |
| `vault-account-isolation.test.ts` | 13 | 0 | 0 | 0 | `npx jest --runInBand tests/vault-account-isolation.test.ts` |
| `token-renewal.test.ts` | 11 | 0 | 0 | 0 | `npx jest --runInBand tests/token-renewal.test.ts` |
| `reliability-security.test.ts` | 10 | 0 | 0 | 0 | `npx jest --runInBand tests/reliability-security.test.ts` |
| `security-lifecycle.test.ts` | 8 | 0 | 0 | 0 | `npx jest --runInBand tests/security-lifecycle.test.ts` |
| `r1-d-lifecycle-offline.test.ts` | 15 | 0 | 0 | 0 | `npx jest --runInBand tests/r1-d-lifecycle-offline.test.ts` |
| `r1-d-03-mock-provider-reconciliation.functional.test.ts` | 11 | 0 | 0 | 0 | `npx jest --runInBand tests/r1-d-03-mock-provider-reconciliation.functional.test.ts` |
| `webhook.test.ts` | 6 | 0 | 0 | 0 | `npx jest --runInBand tests/webhook.test.ts` |
| `invocation-access.test.ts` | 2 | 0 | 0 | 0 | `npx jest --runInBand tests/invocation-access.test.ts` |
| `gsec-redaction.boundary.test.ts` | 2 | 0 | 0 | 0 | `npx jest --runInBand tests/gsec-redaction.boundary.test.ts` |
| `mock-provider/provider.test.ts` | 1 | 0 | 0 | 0 | `npx jest --runInBand tests/mock-provider/provider.test.ts` |

Each invocation emitted the literal per-suite summary `Test Suites: 1 passed, 1 total`, `Tests: N passed, N total`, and `Snapshots: 0 total`, where `N` is the Passed value in the row.

## Skipped suites

| Suite | Status / reason |
|---|---|
| `network-boundaries.boundary.test.ts` | **SKIPPED by explicit spec exclusion**; not run. |
| `black-box-durable.test.ts` | **SKIPPED-live**; test defaults to PostgreSQL `:5433` and Redis `:6380`, and constructs the Postgres client (`tests/black-box-durable.test.ts:16-18,159`). |
| `durable-integration.test.ts` | **SKIPPED-live**; test constructs a PostgreSQL client and Redis client targeting `:5433` / `:6380` (`tests/durable-integration.test.ts:3-10`). |
| `p8-03-convergence.test.ts` | **SKIPPED-live**; despite its in-memory tests, a test creates a `PgSqlClient` using `DATABASE_URL` or the `:5433` test default (`tests/p8-03-convergence.test.ts:636-637`), so the suite was not run. |

`revision-binding.db.test.ts` was run because its test header states that it uses a fake DB and that live PostgreSQL is a separate gate; it does not open a database connection (`tests/revision-binding.db.test.ts:14-30`).

## Aggregate

| Result | Count |
|---|---:|
| Suites passed | 20 / 20 |
| Tests passed | 198 / 198 |
| Suites skipped | 4 / 24 |
| Failures | 0 |
| Shared / external infrastructure used | 0 |
| DB window claimed | No |

No failing test output was produced.
