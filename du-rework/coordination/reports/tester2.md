# Tester-2 Test Receipt - Cycle 102

Date: 2026-09-25

## Scope and database protection

Ran only the requested contract/pipeline/isolation suites and the closest existing egress suites for `pinned-fetch`. No PostgreSQL or Redis connection was opened; no tests wrote to `operations`, `tasks`, or `webhooks`. Document suites use generated fixtures and in-memory task contexts. OIDC and Vault suites use in-process HTTP mocks bound to loopback with in-memory state. Egress tests use loopback listeners and injected DNS resolution.

## Results

| Area | Command / suites | Result |
|---|---|---|
| Document-Kit format identity | `pnpm --filter @du/document-kit test -- --runTestsByPath tests/r1-e-format-identity.test.ts` | PASS - 1 suite, 14 tests |
| Document-Core metadata and propagation | `pnpm --filter @du/document-core test -- --runTestsByPath tests/r1-e-sdk-metadata-adapter.test.ts tests/r1-e-trusted-format-propagation.test.ts` | PASS - 2 suites, 7 tests |
| Egress pinned-fetch boundaries | `pnpm --filter @du/egress exec jest --runInBand tests/egress-boundaries.boundary.test.ts tests/egress-ssrf-deny-matrix.boundary.test.ts` | PASS - 2 suites, 25 tests |
| Mock OIDC and Mock Vault | `pnpm --filter @du/orchestrator test -- --runTestsByPath tests/mock-oidc-idp.test.ts tests/mock-vault-harness-offline.functional.test.ts` | PASS - 2 suites, 22 tests |

Total: 7 suites, 68 tests passed.

## Note

The requested `pinned-fetch.test.ts` file is not present in the repository. The two existing `@du/egress` boundary suites above exercise `createPinnedFetch` directly, including resolver pinning, deny-before-connect, timeout, abort, and SSRF deny-matrix behavior.

## Tester-2 Test Receipt - Batch 2

Date: 2026-09-25

### Database protection

Ran only the three requested offline/isolated suites. The Admin OIDC flow uses in-memory session/challenge stores and an IdP mock over loopback HTTP. Runtime lease fencing injects a fake `Db`; unexpected pool queries throw immediately. The egress SSRF matrix uses an injected resolver and verifies denied destinations never reach the socket. No DB window was opened and there were no connections to `:5433` or `:6380`.

### Results

| Suite | Command | Result |
|---|---|---|
| Admin shell OIDC flow + runtime lease fencing | `pnpm --filter @du/orchestrator test -- --runTestsByPath tests/admin-shell-oidc-flow-integration.test.ts tests/runtime-lease-fencing-offline.test.ts` | PASS - 2 suites, 39 tests |
| Egress SSRF deny matrix | `pnpm --filter @du/egress exec jest --runInBand tests/egress-ssrf-deny-matrix.boundary.test.ts` | PASS - 1 suite, 15 tests |

Batch total: 3 suites, 54 tests passed.

## Tester-2 Test Receipt - Batch 3

Date: 2026-09-25

### Database protection

Ran the requested contract, observability, and egress redirect-matrix suites. The first two use package-local unit fixtures; redirect cases use loopback listeners and injected DNS answers, and prove denied redirect targets are never followed. No DB window was opened, no connection was made to PostgreSQL `:5433` or Redis `:6380`, and there were zero database writes.

### Results

| Suite | Command | Result |
|---|---|---|
| Contracts | `pnpm --filter @du/contracts test` | PASS - 9 suites, 160 tests |
| Observability | `pnpm --filter @du/observability test` | PASS - 1 suite, 22 tests |
| Egress SSRF redirect matrix | `pnpm --filter @du/egress exec jest --runInBand tests/egress-ssrf-redirect-matrix.boundary.test.ts` | PASS - 1 suite, 9 tests |

Batch total: 11 suites, 191 tests passed. No commit or push was performed.

## Tester-2 Test Receipt - Batch 4

Date: 2026-09-25

### Database protection

Ran the complete `@du/worker-sdk` Jest suite. Tests use SDK-level fakes and in-memory fixtures; the network-boundary suite uses loopback listeners only. No DB window was opened, no connection was made to PostgreSQL `:5433` or Redis `:6380`, and there were zero database writes.

### Result

- Command: `pnpm --filter @du/worker-sdk test`
- PASS - 10 suites, 147 tests passed.
- No commit or push was performed.

## Tester-2 Test Receipt - Batch 5

Date: 2026-09-25

### Database protection

The unfiltered Connector suite includes a live `p8-03-convergence.test.ts` case that connects to PostgreSQL `:5433` and inserts rows into `operations`, `tasks`, and `usage_events`. To preserve the requested zero-DB-write boundary, that single case was excluded with Jest's negative `testNamePattern`. `CONNECTOR_INTEGRATION=0` was set to disable the two conditional durable integration suites. The remaining package tests use offline fixtures, fakes, or loopback-only listeners. No DB window was opened, no connection was made to PostgreSQL `:5433` or Redis `:6380`, and there were zero database writes.

### Result

- Safe command: `$env:CONNECTOR_INTEGRATION='0'; pnpm --filter @du/connector test -- --testNamePattern='^(?!.*live usage_events projection aggregates provider tokens and costs with zero double-billing on duplicate events).*$'`
- PASS - 14 suites passed, 2 suites skipped; 163 tests passed, 8 tests skipped (171 total).
- The requested unfiltered `pnpm --filter @du/connector test` was not run because it would execute the DB-writing test identified above.
- No commit or push was performed.

## Tester-2 Test Receipt - Batch 6

Date: 2026-09-25

### Database protection

The `@du/document-kit` suite uses local parser/converter tests and generated fixtures. Package test/source inspection found no PostgreSQL or Redis access paths. No DB window was opened, no connection was made to PostgreSQL `:5433` or Redis `:6380`, and there were zero database writes.

### Result

- Command: `pnpm --filter @du/document-kit test`
- PASS - 10 suites, 130 tests passed.
- No commit or push was performed.

## Tester-2 Test Receipt - Batch 7

Date: 2026-09-25

### Database protection

The unfiltered Document-Core suite includes `multi-container-e2e.integration.test.ts` (live PostgreSQL/Redis) and a `p8-03-provider-convergence.test.ts` case that writes to `operations`, `tasks`, and `usage_events`. `bullmq-smoke.test.ts` also probes Redis `:6380` by default. To preserve the zero-DB boundary, the multi-container suite was excluded, the live usage projection case was excluded by test name, and `REDIS_SMOKE=0` disabled the smoke-test probe. No DB window was opened, no connection was made to PostgreSQL `:5433` or Redis `:6380`, and there were zero database writes.

### Result

- Safe command: `$env:REDIS_SMOKE='0'; pnpm --filter @du/document-core test -- --testPathIgnorePatterns='multi-container-e2e.integration.test.ts' --testNamePattern='^(?!.*live usage_events projection query aggregates provider tokens and costs matching UsageSchema).*$'`
- Jest result: 37 suites passed, 3 failed (40 total); 474 tests passed, 13 failed, 3 skipped (490 total). Exit code: 1.
- Observed failures: `provider-backed-variant.test.ts` had an unhandled fail-report route after an artifact upload `SyntaxError`; `sdk-consumer.test.ts` had artifact-upload `TRANSPORT_FAILURE` and unhandled fail-report routes; `build-dependency-order.test.ts` reports `@du/connector` depends on `@du/egress` omitted from the build sequence.
- The unfiltered `pnpm --filter @du/document-core test` was not run because it would contact and write to the shared DB/Redis services.
- No commit or push was performed.

### First retest after Codex-New Document-Core fixes

- Safe command: `$env:REDIS_SMOKE='0'; pnpm --filter @du/document-core test -- --testPathIgnorePatterns='multi-container-e2e.integration.test.ts' --testNamePattern='^(?!.*live usage_events projection query aggregates provider tokens and costs matching UsageSchema).*$'`
- Jest result: 39 suites passed, 1 failed (40 total); 479 tests passed, 8 failed, 3 skipped (490 total). Exit code: 1.
- The previously reported `provider-backed-variant.test.ts` and `build-dependency-order.test.ts` failures are resolved. The remaining 8 failures are in `sdk-consumer.test.ts`: six cases fail with artifact upload `TRANSPORT_FAILURE` / `SyntaxError`, and two cases encounter `AmbiguousReportError` because the fake runtime lacks `POST /tasks/:id/fail`.
- `multi-container-e2e.integration.test.ts` and the live usage projection test remained excluded; `REDIS_SMOKE=0` kept the Redis smoke probe disabled. No DB window was opened, no connection was made to PostgreSQL `:5433` or Redis `:6380`, and there were zero database writes. No commit or push was performed.

### Re-run after `sdk-consumer.test.ts` update

- Safe command: `$env:REDIS_SMOKE='0'; pnpm --filter @du/document-core test -- --testPathIgnorePatterns='multi-container-e2e.integration.test.ts' --testNamePattern='^(?!.*live usage_events projection query aggregates provider tokens and costs matching UsageSchema).*$'`
- PASS - 40 suites passed; 487 tests passed, 3 skipped (490 total); exit code 0.
- This run includes the updated `sdk-consumer.test.ts`; its prior 8 failures are resolved.
- `multi-container-e2e.integration.test.ts` and the live usage projection test remained excluded, and `REDIS_SMOKE=0` disabled the Redis smoke probe. No DB window was opened, no connection was made to PostgreSQL `:5433` or Redis `:6380`, and there were zero database writes. No commit or push was performed.

## Tester-2 Test Receipt - Batch 8

Date: 2026-09-25

### Database protection

The unfiltered `@du/example-review` test command includes three `*.integration.test.ts` suites that start the Orchestrator and use PostgreSQL `:5433` / Redis `:6380`. To keep this batch isolated, ran the package's `test:unit` command, which excludes those integration suites. No DB window was opened, no connection was made to PostgreSQL `:5433` or Redis `:6380`, and there were zero database writes.

### Result

- Safe command: `pnpm --filter @du/example-review test:unit`
- Jest result: 5 suites passed, 8 failed to compile (13 unit suites total); 64 executed tests passed.
- The 8 compilation failures report TS2739: test artifact facades in `tests/test-helper.ts` and `tests/task-context-consumer.test.ts` omit `readWithMetadata`, `readStream`, and `writeStream` required by `ArtifactFacade`.
- The unfiltered `pnpm --filter @du/example-review test` was not run because its integration suites require the shared DB/Redis services.
- No commit or push was performed.

### Retest after Qwen-2 ArtifactFacade fixture update

- Command: `pnpm --filter @du/example-review test:unit`
- PASS - 13 suites, 119 tests passed.
- The updated fixtures now implement `readWithMetadata`, `readStream`, and `writeStream`; no TS2739 errors remain.
- Integration suites remained excluded; no DB window or PostgreSQL/Redis connection was used, and there were zero DB writes. No commit or push was performed.

## Tester-2 Full Workspace Safe-Mode Verification

Date: 2026-09-25

### Isolation boundary

Ran the requested standalone package suites, with Document-Core in safe mode and Example-Review unit-only. Document-Core excluded `multi-container-e2e.integration.test.ts` and the live usage projection test, and used `REDIS_SMOKE=0`. Example-Review used `test:unit`, which excludes integration suites. No DB window was opened, no connection was made to PostgreSQL `:5433` or Redis `:6380`, and there were zero database writes.

### Results

| Package | Safe command | Result |
|---|---|---|
| Contracts | `pnpm --filter @du/contracts test` | PASS - 9 suites, 160 tests |
| Observability | `pnpm --filter @du/observability test` | PASS - 1 suite, 22 tests |
| Egress | `pnpm --filter @du/egress test` | PASS on rerun - 3 suites, 34 tests |
| Document-Kit | `pnpm --filter @du/document-kit test` | PASS - 10 suites, 130 tests |
| Worker-SDK | `pnpm --filter @du/worker-sdk test` | PASS - 10 suites, 147 tests |
| Connector-Client | `pnpm --filter @du/connector-client test` | PASS - 4 suites, 31 passed, 1 skipped test |
| Document-Core safe mode | `$env:REDIS_SMOKE='0'; pnpm --filter @du/document-core test -- --testPathIgnorePatterns='multi-container-e2e.integration.test.ts' --testNamePattern='^(?!.*live usage_events projection query aggregates provider tokens and costs matching UsageSchema).*$'` | PASS - 40 suites, 487 passed, 3 skipped |
| Example-Review unit | `pnpm --filter @du/example-review test:unit` | PASS - 13 suites, 119 tests |

Final totals across the requested package runs: **90 suites passed, 1 suite skipped; 1,130 tests passed, 4 tests skipped, 0 failures** (1,134 test cases total). The first full Egress run had a transient failure for the ULA IPv6 redirect case (`Error` instead of `DestinationDeniedError`); the focused redirect matrix rerun passed 9/9, then the full Egress package rerun passed 34/34.

The requested `1,300+` passing-test threshold was **not reached**: the listed packages produced 1,130 passing tests, 170 short of 1,300. No additional package suites were counted toward this total. No commit or push was performed.

## DATA-00 Multipart Contracts Offline Verification

Date: 2026-09-25

### Results

- `pnpm --filter @du/contracts lint` — PASS, exit code 0.
- `pnpm --filter @du/contracts build` — PASS, exit code 0.
- `pnpm --filter @du/contracts test` — PASS, 10 suites and 191 tests passed (191/191), exit code 0. This includes the new `tests/multipart-contract.test.ts` suite.

### Isolation

The contracts lint, build, and test commands ran locally within `@du/contracts`. No DB window was opened, no connection was made to PostgreSQL `:5433` or Redis `:6380`, and there were zero DB writes. No commit or push was performed.

## Document-Core Step A Offline Acceptance

Date: 2026-09-25

### Results

- `pnpm --filter @du/document-core lint` - PASS, exit code 0.
- `pnpm --filter @du/document-core build` - PASS, exit code 0.
- Offline test command: `$env:REDIS_SMOKE='0'; pnpm --filter @du/document-core test -- --testPathIgnorePatterns='bullmq-smoke.test.ts|multi-container-e2e.integration.test.ts' --testNamePattern='^(?!.*live usage_events projection query aggregates provider tokens and costs matching UsageSchema).*$'`
- PASS - 39 suites passed; 486 tests passed, 3 skipped (489 total); exit code 0.

### Isolation

The test run excluded `bullmq-smoke.test.ts` and `multi-container-e2e.integration.test.ts`; the live usage projection test was also excluded because it writes to the database. No DB window was opened, no connection was made to PostgreSQL `:5433` or Redis `:6380`, and there were zero DB writes. No commit or push was performed.

## Document-Core Step B Read-Streaming Offline Acceptance

Date: 2026-09-25

### Results

- `pnpm --filter @du/document-core lint` - PASS, exit code 0.
- `pnpm --filter @du/document-core build` - PASS, exit code 0.
- Offline test command: `$env:REDIS_SMOKE='0'; pnpm --filter @du/document-core test -- --testPathIgnorePatterns='bullmq-smoke.test.ts|multi-container-e2e.integration.test.ts' --testNamePattern='^(?!.*live usage_events projection query aggregates provider tokens and costs matching UsageSchema).*$'`
- PASS - 40 suites passed; 494 tests passed, 3 skipped (497 total); exit code 0.
- The run includes `tests/read-stream-acquisition.test.ts`. Jest output reported 40 suites / 497 test cases, rather than the anticipated 39 suites / 492 tests.

### Isolation

The test run excluded `bullmq-smoke.test.ts` and `multi-container-e2e.integration.test.ts`; the live usage projection test was also excluded because it writes to the database. No DB window was opened, no connection was made to PostgreSQL `:5433` or Redis `:6380`, and there were zero DB writes. No commit or push was performed.

## S3 Multipart Storage Offline Acceptance

Date: 2026-09-25

- Command: `pnpm --filter @du/orchestrator test:unit -- tests/s3-multipart-upload.test.ts tests/s3-storage-facade.test.ts`
- PASS - 2 suites passed, 16 tests passed, exit code 0.
- This was an isolated unit-test run. No DB window was opened, no PostgreSQL `:5433` or Redis `:6380` connection was made, and there were zero DB writes.

## DATA-02 S3 Multipart Offline Verification

Date: 2026-09-25

### Typecheck

- `pnpm --filter @du/orchestrator lint` - PASS, exit code 0 (`tsc --noEmit -p tsconfig.json`).

### New offline multipart suites

- Command: `pnpm --filter @du/orchestrator test:unit -- tests/multipart-service-offline.test.ts tests/multipart-routes-offline.test.ts tests/s3-multipart-storage-offline.test.ts`
- PASS - 3 suites, 63 tests passed, 0 failed/skipped, exit code 0.

### Targeted regression

- Command: `pnpm --filter @du/orchestrator test:unit -- tests/multipart-service-offline.test.ts tests/multipart-routes-offline.test.ts tests/s3-multipart-storage-offline.test.ts tests/s3-multipart-upload.test.ts tests/s3-storage-facade.test.ts tests/artifacts-fencing.test.ts tests/artifact-storage-service.test.ts tests/artifact-submit-guards.test.ts tests/artifact-read-authorization.test.ts tests/artifact-integrity-scanner.test.ts tests/br12-isolation-offline.test.ts`
- PASS - 11 suites, 137 tests passed, 0 failed/skipped, exit code 0.
- The 11-suite regression includes the three new suites above; these results overlap and must not be added together.

### Isolation boundary

Both test commands used `jest.unit.config.cjs` and offline fixtures. No DB window was opened, no connection was made to PostgreSQL `:5433` or Redis `:6380`, and there were zero DB writes. No commit or push was performed.
