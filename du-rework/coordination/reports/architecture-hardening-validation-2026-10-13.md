# Architecture hardening validation — 2026-10-13

**Status: final local integrated validation passed.** The compatibility and terminal-CAS repairs are included in the final offline Orchestrator run, the ordered build, and the refreshed isolated startup smoke. The Admin Web unit suite also passed. Seventeen live-gated Orchestrator suites remain skipped; this report does not establish Docker image provenance, deployment readiness, or production E2E behavior.

## Evidence boundaries and safety

Build and test receipts below describe source/package behavior. The final startup smoke used the host development runners and prebuilt `dist` artifacts; it does not establish Docker image provenance, deployment readiness, or production E2E behavior. The smoke submitted no tasks and made no provider calls.

Offline test processes used live-infrastructure guards and unreachable local DB/Redis sentinels where applicable. The startup smoke used fresh `postgres:16` and `redis:7-alpine` containers with random disposable credentials, no host data volumes, and loopback-only published ports. Mock Vault ran in the harness process. The harness redacted secret-shaped values from its log; a scan found zero matches for the test database URL/password or bearer tokens.

## Builds

| Scope | Result | Evidence |
|---|---|---|
| Orchestrator workspace | All 9 ordered stages passed: contracts, observability, egress, document-kit, worker SDK, Connector client, Connector, Orchestrator, Admin Web. Connector migration SQL copy also passed. | `node scripts/build.cjs` from `du-rework/orchestrator/`; `%TEMP%\du-hardening-final-ordered-build-20261013-172537.log` (17:25) |
| Contracts | Own-CWD TypeScript build passed after adding the canonical encryption purpose. | `pnpm run build`; `%TEMP%\du-hardening-contracts-build-final-20261013-170804.log` |
| Document Core | `pnpm test` rebuilt local contracts, observability, egress, document-kit, worker SDK, and Document Core; build and tests passed. | `%TEMP%\du-hardening-document-core-final-20261013-170640.log` |
| LC Checker | Own-CWD build and tests passed. | `pnpm test`; `%TEMP%\du-hardening-lc-checker-final-20261013-170718.log` |
| Example Review | Own-CWD build and tests passed. | `pnpm test`; `%TEMP%\du-hardening-example-review-final-20261013-170718.log` |
| Independent worker sample | `npm test` ran TypeScript build and offline tests; both passed. | `%TEMP%\du-hardening-final-independent-sample-test-20261013.log` |

Earlier Admin Web builds emitted advisory warnings for browser externalization of Node crypto and a JavaScript chunk above 500 kB; the final ordered Admin Web stage passed. The 17:25 ordered build followed the terminal-CAS runtime repair and includes the final Orchestrator source. Subsequent compatibility repairs changed tests only, so this build is the artifact snapshot used by the refreshed startup smoke.

## Offline tests

| Scope | Result | Evidence |
|---|---|---|
| Contracts | 32 suites / 578 tests passed after the canonical purpose addition. | `%TEMP%\du-hardening-contracts-final-20261013-170553.log` |
| Observability / Egress / Document Kit | 3/48, 3/35, and 10/130 suites/tests passed. | `%TEMP%\du-hardening-offline-20261013-145502\observability-tests.log`, `egress-tests.log`, `document-kit-tests.log` |
| Connector client | 5 suites / 39 tests passed; 1 suite / 1 test skipped. | `%TEMP%\du-hardening-offline-20261013-145502\connector-client-tests.log` |
| Connector service | 53 suites / 520 tests passed; 1 test skipped. | `%TEMP%\du-hardening-offline-20261013-145502\connector-service-offline-tests-rerun.log` |
| Orchestrator offline full run | 374/391 suites passed, 0 failed, 17 skipped; 6,002/6,149 tests passed, 0 failed, 147 skipped. Jest used `--forceExit` after results because open handles remained. | `%TEMP%\du-hardening-orchestrator-final-20261013-172729.log`, `%TEMP%\du-hardening-orchestrator-final-20261013-172729.json` |
| PM-M02 ingress guard focused rerun | 1 suite passed; 5 tests passed and 6 live-gated tests skipped. Jest used `--forceExit`. | `%TEMP%\du-hardening-pm-m02-focused-20261013-165701.log` |
| Worker SDK | 38 suites / 775 tests passed; 1 suite skipped, 2 tests skipped, 1 todo. Jest used `--forceExit` after results because the suite retained open handles. | `%TEMP%\du-hardening-worker-sdk-full-20261013-153447.log` |
| Admin Web | 38 suites / 169 tests passed; 0 failed, skipped, or todo across 32 recursively collected test files. | `%TEMP%\du-hardening-admin-web-node-tests-20261013-173304.log` |
| Document Core | 53 suites / 801 tests passed after E’s vendor sync; `pnpm test` rebuilt the package. | `%TEMP%\du-hardening-document-core-final-20261013-170640.log` |
| LC Checker / Example Review | 7/122 and 13/123 suites/tests passed after E’s vendor sync; each `pnpm test` rebuilt its package. | `%TEMP%\du-hardening-lc-checker-final-20261013-170718.log`, `%TEMP%\du-hardening-example-review-final-20261013-170718.log` |
| Independent worker sample | 13 tests passed, 0 failed on the final post-sync run. | `%TEMP%\du-hardening-final-independent-sample-test-20261013.log` |

The first post-repair diagnostic run at 17:22 exposed 3 failing suites / 7 failing tests: stale WFA resume argument expectations, BR-08 test lock-query setup, and a stale Overview tenant-copy assertion. The follow-up changes corrected those test fixtures; the final full run above is post-repair. The Admin Web unit tests passed, but no screenshot or browser visual review was performed.
| Dev isolation / Connector composition | Document Core 3/3, LC Checker 1/1, Example Review 1/1, Connector composition 4/4 passed. | `%TEMP%\du-hardening-offline-20261013-145502\document-core-dev-isolation.log`, `lc-checker-dev-isolation.log`, `example-review-dev-isolation.log`, `Connector-composition-isolation.log` |

Backend owners reported overlapping focused repair batches green: B’s final 13 suites / 98 tests; C’s multipart 3 suites / 109 tests; A’s backup/gate 8 suites / 75 tests, plus an earlier runtime/URL pair of 144 tests, a 9-suite / 255-test batch, and final compatibility closure of 4 suites / 135 tests. A’s contract purpose/RV01 focused validation passed 10/10 and 58/58 tests. E verified the final contract-purpose vendor sync across all three workers and the template (48 contracts checks, 16 SDK checks, and provenance). These receipts overlap and are not additive.

C also reports that the final isolated-restore bootstrap helper change is stable and its focused owner suite passes; no test count was included in that handoff. The helper source is newer than the ordered build recorded above.

The initial broad Orchestrator offline run (`pnpm run test:unit`) ended with 87 failed suites, 17 skipped suites, and 286 passed suites; the test summary was 463 failed, 139 skipped, and 5,434 passed. It also reported TypeScript fixture errors, including `detail.tasks` inferred as `unknown`, and Jest open handles; the command returned `4294967295`. A 16:53 diagnostic used the unit config with live flags disabled, unreachable database and Redis sentinels, provider credential variables blanked, and `--runInBand --forceExit`. It found two failures, both repaired before the 17:02 full run: a missing canonical purpose for `connector_secret_imports.resolved_payload`, and an inconsistent normalized-path expectation in the PM-M02 test. The latter was corrected to allow the normalized public operations-list route while retaining explicit admin-route denial; the focused run passed 5 tests and skipped 6 live-gated tests.

The 17 skipped suites / 147 skipped tests in the 17:02 run were explicitly live-gated for PostgreSQL, Redis, S3, Vault, or private-schema migration; `gate-authenticate-808-pg16.test.ts` requires `GATE_AUTH_PG_URL`. No live service was contacted. The unit config also ignores its explicit live-suite patterns.

The 17:02 full run began after A’s then-current files were written (`legacy-host-adapter.ts` 16:56:51; `rv01-loopback-http-offline.test.ts` 16:57:02) and completed with all executed tests passing. Afterward, the compatibility audit added published resume-CAS cases to the RV01 suite at 17:06:47. The Orchestrator source entrypoint `legacy-http-mount.ts` still had its earlier 16:49:59 timestamp at the next inspection, so that run does not cover the new cases or A’s pending actual-runtime replay audit. A later focused mock-backed HTTP pass is not sufficient to resolve the runtime `resumeOperation` replay question. Treat the 17:02 result as a passing snapshot, not final acceptance. Original evidence: `%TEMP%\du-hardening-offline-20261013-145502\orchestrator-service-offline-tests.log`; B’s focused scope: `%TEMP%\du-hardening-offline-20261013-145502\orchestrator-b-scope-focused-6.log`.

Test pass counts are behavioral test evidence. Type/build claims above come from the explicit build commands; no diagnostics were disabled to claim type safety.

## Isolated startup smoke

The final smoke used the 17:25 build. The harness started Orchestrator from its own CWD with `--skip-build --no-watch` and migrations enabled, then started each worker from its own CWD with `--inherited-env --skip-build --no-watch`. It authenticated to the local admin API using generated disposable credentials, registered and activated each worker version on a fresh database, and checked the persisted worker inventory.

| Check | Result |
|---|---|
| Orchestrator internal `/health` | HTTP 200 |
| Connector `/health/ready` | HTTP 200 |
| Orchestrator migration ledger | 65/65 migrations applied; read-only verification passed |
| Connector migration ledger | 16/16 migrations applied |
| `document-core@1.1.0` | Registered, active/admission-eligible, ONLINE/HEALTHY |
| `lc-checker@1.1.0` | Registered, active/admission-eligible, ONLINE/HEALTHY |
| `example-review@1.0.0` | Registered, active/admission-eligible, ONLINE/HEALTHY |

The final dedicated containers were `du-arch-verify-pg-20261013-1791887409251-6cac38` and `du-arch-verify-redis-20261013-1791887409251-6cac38`. The harness shut down its own service/worker process trees and removed its labeled containers. Post-run inspection confirmed both containers were absent and all six loopback ports (15551, 15613, 15777, 16888, 17773, 17774) were bind-free.

Sanitized final runtime evidence: `%TEMP%\du-hardening-startup-smoke-20261013-1791887409251-6cac38.json` and `.log`. The earlier 15:42 smoke remains in the audit history; this refresh used the final ordered build. Both runs used disposable local infrastructure only, submitted no workload, and made no provider calls.

## Verification limits

The final offline Orchestrator run skipped 17 suites / 147 tests gated on live PostgreSQL, Redis, S3, Vault, or private-schema migration infrastructure; `gate-authenticate-808-pg16.test.ts` requires `GATE_AUTH_PG_URL`, and the offline Jest config excludes its explicit live-suite patterns. No live services were contacted by the offline run.

No Docker image was built, no deployment or production E2E was performed, and no live provider or user database was contacted. The smoke verified startup, migrations, health, and worker registration only; it did not submit a task. No additional Orchestrator source/build/startup verification remains for this local snapshot.
