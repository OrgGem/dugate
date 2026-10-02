# Post-commit offline regression baseline — 2026-10-02

## Scope and provenance

- Requested baseline commit: `6fb5294ab5ff961cc6c2b4b1c68ad46d367bcc96`.
- Each final suite ran in a detached worktree whose `HEAD` was exactly that SHA; command working directory: `D:\Git\dugate-baseline-6fb5294\du-rework`.
- This avoided the active worktree's concurrent, uncommitted `document-core` edits. No source or test files were changed, no gate was ticked, and no commit was made.
- No `npm install`, Docker, live database, Redis, S3, or Vault was used. The existing dependency installation was temporarily linked into the detached checkout; package source trees used for those dependency links were unchanged between the requested SHA and the active `HEAD`.

## Final suite results

| Package | Exact command | CWD | Suites passed / failed / skipped | Tests passed / failed / skipped | Exit code | Result |
|---|---|---|---|---|---:|---|
| `@du/contracts` | `pnpm --filter @du/contracts test` | `D:\Git\dugate-baseline-6fb5294\du-rework` | 23 / 0 / 0 | 464 / 0 / 0 | 0 | Green |
| `@du/worker-sdk` | `pnpm --filter @du/worker-sdk test` | `D:\Git\dugate-baseline-6fb5294\du-rework` | 23 / 0 / 0 | 645 / 0 / 0 | 0 | Green |
| `@du/document-core` | `$env:REDIS_SMOKE='0'; $env:DATABASE_URL='postgresql://du:du-test-only@127.0.0.1:1/du_orchestrator_test'; pnpm --filter @du/document-core test` | `D:\Git\dugate-baseline-6fb5294\du-rework` | 55 / 1 / 0 | 905 / 1 / 0 | 1 | One expected isolated-DB failure; no new product red observed |

Jest's final aggregate lines were:

- Contracts: `Test Suites: 23 passed, 23 total`; `Tests: 464 passed, 464 total`; `Time: 10.519 s`.
- Worker SDK: `Test Suites: 23 passed, 23 total`; `Tests: 645 passed, 645 total`; `Time: 157.593 s`.
- Document core: `Test Suites: 1 failed, 55 passed, 56 total`; `Tests: 1 failed, 905 passed, 906 total`; `Time: 35.976 s`.

## Baseline comparison

- **Contracts:** The expected reds at `packages/contracts/tests/vault-policies.test.ts:104` and `:179` did not reproduce on the committed tree. Jest reported `PASS tests/vault-policies.test.ts`; all 464 tests passed, exit code `0`. The assertions remain at those lines, but are green in this run.
- **Worker SDK:** Matches the stated baseline exactly: 645/645 passed, exit code `0`.
- **Document core:** The one failing test is `tests/p8-03-provider-convergence.test.ts`, `USE-01: ... live usage_events projection query ...`; literal error: `connect ECONNREFUSED 127.0.0.1:1`. `DATABASE_URL` deliberately targeted a closed local port rather than shared PostgreSQL `:5433`, so this is the expected offline infrastructure-dependent red, not a new source regression. No other tests failed.
- Redis smoke was explicitly disabled with `REDIS_SMOKE=0`. `tests/bullmq-smoke.test.ts` logged `Skipping Redis smoke test: Redis not reachable at 127.0.0.1:6380 (opt-in via REDIS_SMOKE=1)` and returned normally, so Jest counted it as passed, not skipped. The Jest skipped count was `0`; no Redis/live claim is made.
- The worker SDK's multipart/RSS tests ran as local tests and passed; their emitted RSS measurements are not evidence of a live S3, database, or infrastructure run.

## Execution note

The first document-core invocation in the detached checkout, before linking its ignored workspace dependency/build-output directories, exited `1`: `Test Suites: 3 failed, 53 passed, 56 total`; `Tests: 833 passed, 833 total`; `Time: 53.415 s`. `tests/bounded-input.test.ts` and `tests/ingest-wire.test.ts` failed to load with `TS2307` for `@du/contracts`; `tests/p8-03-provider-convergence.test.ts` failed to load with `TS2307` for `@du/connector`. These were detached-checkout setup errors, not test assertions. After connecting the existing dependencies (without installing packages or changing tracked files), the exact document-core command above was rerun and produced the final result recorded here.

## Verdict

`@du/contracts` and `@du/worker-sdk` are green at the requested commit. The named contracts reds are absent. Document core has one expected red caused by intentionally unavailable PostgreSQL; the Redis smoke case is short-circuited and counted as a pass. **No new red relative to the stated baseline was observed.** This is an offline baseline only, not live verification.
