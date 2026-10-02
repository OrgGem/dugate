# VFY-REG offline verification — document-core + Worker SDK

Date: 2026-10-02. This is a read-only verification receipt. No source or test
files were edited by this run; the working tree was already dirty at preflight.
`VFY-REG` remains unticked.

## Isolation and execution notes

The test configuration includes a live PostgreSQL projection test and a
BullMQ/Redis smoke test. Docker Desktop could not start, and preflight found no
listeners on the usual `:5433` / `:6380` endpoints. To avoid shared/dev services,
the document-core Jest runs used these isolated, initially unbound endpoints:

- `DATABASE_URL=postgresql://du:du-test-only@127.0.0.1:15433/du_vfyreg_offline_test`
- `REDIS_SMOKE=1`
- `REDIS_URL=redis://127.0.0.1:16380/13`

Preflight found no listener on `:15433` or `:16380`; no DB or Redis service was
available to provision in this environment. No request was sent to the shared
`:5433` or `:6380` endpoints. The isolated-infrastructure failures below are
reported, not hidden or repaired.

## Full-suite results

### `packages/worker-sdk`

- Command: `npx jest --runInBand`
- CWD: `D:\Git\dugate\du-rework\packages\worker-sdk`
- Exit code: **0**
- Jest summary:

```text
Test Suites: 23 passed, 23 total
Tests:       645 passed, 645 total
Snapshots:   0 total
Time:        143.788 s, estimated 148 s
Ran all test suites.
```

- Skipped: 0.

### `businesses/document-core`

Required command attempted first with the isolated environment above:

- Command: `npx jest --runInBand`
- CWD: `D:\Git\dugate\du-rework\businesses\document-core`
- Jest summary: 2 failed / 54 passed suites; 2 failed / 904 passed tests (906
  total). Jest printed that it did not exit one second after completion because
  of open handles; the still-running process was interrupted with Ctrl+C and
  the shell returned exit code **1**.

The full suite was then repeated to obtain a terminating process exit:

- Command: `npx jest --runInBand --forceExit`
- CWD: `D:\Git\dugate\du-rework\businesses\document-core`
- Exit code: **1**
- Jest summary:

```text
Test Suites: 2 failed, 54 passed, 56 total
Tests:       2 failed, 904 passed, 906 total
Snapshots:   0 total
Time:        32.905 s, estimated 73 s
Ran all test suites.
Force exiting Jest: Have you considered using `--detectOpenHandles` to detect async operations that kept running after all tests finished?
```

- Skipped: 0.
- The known baseline suites `all-variants-e2e`, `corpus-regression`, and
  `manifest.test.ts` were not red in this run.

## Red tests (not modified)

| Classification | Test (file:line) | Observed failure |
|---|---|---|
| **Known pre-existing baseline** per VFY-REG spec | `bullmq-smoke.test.ts:68` — `proves queue consumption, claim, step execution, completion and drain against Redis 6380` | First attempt: Jest test timeout after 30,000 ms. Forced-exit rerun: `AmbiguousReportError: ambiguous runtime report: PUT /workers/smoke-worker-0c0adf40/heartbeat`, caused by `fetch failed` / `connect ETIMEDOUT 127.0.0.1:51167` (the test's ephemeral local fake-runtime port). The isolated Redis service was unavailable; no shared Redis was used. |
| **Newly observed in this run; isolated-infrastructure blocker, not established as a code regression** | `p8-03-provider-convergence.test.ts:339` — `live usage_events projection query aggregates provider tokens and costs matching UsageSchema` | `connect ECONNREFUSED 127.0.0.1:15433`; the per-run isolated PostgreSQL endpoint had no server. The endpoint was deliberately not changed to shared/dev PostgreSQL. |

No test failure was fixed, suppressed, or excluded.

## Typechecks

All commands ran from the package CWD shown and emitted no diagnostics:

| Command | CWD | Exit code |
|---|---|---:|
| `npx tsc --noEmit -p tsconfig.json` | `D:\Git\dugate\du-rework\packages\worker-sdk` | 0 |
| `npx tsc --noEmit -p tsconfig.json` | `D:\Git\dugate\du-rework\businesses\document-core` | 0 |
| `npx tsc --noEmit -p tsconfig.test.json` | `D:\Git\dugate\du-rework\businesses\document-core` | 0 |

## Build/source identity

Repository HEAD at verification: `adec19ebb164104faedffc64a3457ea50debad10`.
The workspace is dirty, so HEAD alone does not identify the tested working tree.
Short SHA-256 working-tree input fingerprints (sorted relative paths and bytes
for each package's `src/`, `tests/`, `package.json`, Jest config, and TypeScript
configs; excludes `dist/` and `node_modules/`):

- document-core: `fb4c0c019273a025` (104 files)
- worker-sdk: `861a95064d317508` (40 files)

These are package input fingerprints, not a claim that a release artifact was
built or that all transitive dependency artifacts are represented.

## Verdict and outstanding live conditions

**Offline VFY-REG result: FAIL / BLOCKED**, because document-core's complete
suite exits 1 with the two red tests above; Worker SDK's complete suite and all
requested typechecks pass. A dedicated PostgreSQL + Redis namespace/service is
still required to distinguish infrastructure-dependent results from code
behavior. Live VFY-REG also still requires an authorized CLAIM/RELEASE DB
window and the release build digest; neither was opened or claimed here. No
gate was ticked.
