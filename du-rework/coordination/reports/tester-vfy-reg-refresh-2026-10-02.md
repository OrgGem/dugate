# VFY-REG offline refresh — current working tree

Date: 2026-10-02. Read-only regression verification; no source or test files were changed, no gate was ticked, and no commit was made. This receipt records the current working tree, not a release artifact.

## Build and isolation

- Repository root / command CWD: `D:\Git\dugate\du-rework`
- `git rev-parse HEAD`: `f2be0def52368aca0b7cf2d24af406de718154bc`
- `DU_LIVE_INFRA`: unset for every run.
- `DATABASE_URL`: set only in each test process to `postgresql://offline:offline@127.0.0.1:15433/du_vfyreg_offline_test` (isolated endpoint; no service provisioned).
- `REDIS_URL`: set only in each test process to `redis://127.0.0.1:16380/13` (isolated endpoint; no service provisioned).
- The shared PostgreSQL `:5433` and Redis `:6380` endpoints were not used.

## Full-suite runs

### Document Core

- Command: `pnpm --filter @du/document-core test`
- CWD: `D:\Git\dugate\du-rework`
- Exit code: **1**
- Jest resolved the package script to `jest --runInBand` in `D:\Git\dugate\du-rework\businesses\document-core`.
- Literal summary:

```text
Test Suites: 1 failed, 57 passed, 58 total
Tests:       2 failed, 1 skipped, 922 passed, 925 total
Snapshots:   0 total
Time:        88.816 s
Ran all test suites.
```

- Red test names, verbatim:
  - `tests/parser-budgets.test.ts` — `Action-Level Document Parser Budgets & Completion Fencing (Wave 17-18, W18-A) › 1. ParserBudgetHelper Unit & Bounds Enforcement › enforces exact byte boundary: rejects (limit + 1) and accepts exact limit` — exceeded Jest's 5,000 ms test timeout.
  - `tests/parser-budgets.test.ts` — `Action-Level Document Parser Budgets & Completion Fencing (Wave 17-18, W18-A) › 4. Multi-Artifact Cumulative Wait & Compare Both Sides › Extract action: cumulative wait bounds multiple artifacts under task deadline` — exceeded Jest's 5,000 ms test timeout.
- Comparison with the requested current benchmark `924 passed + 1 skipped / 925`: total is 925, but this run had 922 passed, 2 failed, and 1 skipped. The two timeouts are not reported as passes or attributed to infrastructure without evidence.

### Worker SDK

- Command: `pnpm --filter @du/worker-sdk test`
- CWD: `D:\Git\dugate\du-rework`
- Exit code: **0**
- Jest resolved the package script to `jest --runInBand` in `D:\Git\dugate\du-rework\packages\worker-sdk`.
- Literal summary:

```text
Test Suites: 25 passed, 25 total
Tests:       669 passed, 669 total
Snapshots:   0 total
Time:        151.762 s
Ran all test suites.
```

- Comparison with the requested benchmark `650/650`: current run passed 669/669 (19 more tests than that benchmark).

## Targeted cancellation / AbortSignal / metadata-adapter runs

These existing producer/consumer suites were located by searching for `DU_LIVE_INFRA`, `readWithMetadata`, `AbortSignal`, and abort assertions; no test was created or changed.

| Command | CWD | Exit | Result |
|---|---|---:|---|
| `pnpm --filter @du/document-core test -- tests/r1-e-sdk-metadata-adapter.test.ts tests/read-stream-acquisition.test.ts tests/cancellation-fencing.test.ts tests/ingest-wire.test.ts` | `D:\Git\dugate\du-rework` | 0 | 4 suites passed; 50 tests passed |
| `pnpm --filter @du/worker-sdk test -- tests/artifact-read-metadata.test.ts` | `D:\Git\dugate\du-rework` | 0 | 1 suite passed; 37 tests passed |

The document-core selection covers SDK metadata-adapter forwarding, parser/read-stream acquisition and timeout abort, cancellation fencing, and ingest wire propagation. The Worker SDK selection covers metadata reads, caller abort propagation to grant/download requests, and read failures. These focused results passed; they do not override the full document-core red tests.

## Comparison with prior VFY-REG receipt

The prior receipt, `coordination/reports/tester-vfy-reg-offline-2026-10-02.md`, recorded Worker SDK 645/645 and document-core 904 passed / 2 failed / 906 total (54 passing and 2 failing suites). Its document-core red findings were an unavailable isolated Redis smoke path and a PostgreSQL projection query against a closed isolated endpoint. On this refresh, Worker SDK is 669/669; document-core has grown to 925 total, and its two observed reds are instead the `parser-budgets.test.ts` 5-second timeouts listed above. No PostgreSQL/Redis connection failure appeared in this current run.

With `DU_LIVE_INFRA` unset, `tests/p8-03-provider-convergence.test.ts:12-13` selects `test.skip` for its live test; the skipped case at line 331 is `live usage_events projection query aggregates provider tokens and costs matching UsageSchema`. Therefore this run does not provide live PostgreSQL projection coverage or any live DB/Redis verification. The isolated endpoints were intentionally closed and no shared service was contacted.

## Verdict

**VFY-REG offline refresh: BLOCKED.** Worker SDK and all selected cancellation/AbortSignal metadata-adapter tests pass, and the prior infrastructure-specific document-core failures did not recur. The current document-core full suite still exits 1 because of the two parser-budget timeouts; the live projection test is skipped while `DU_LIVE_INFRA` is unset. No failure was fixed, suppressed, or excluded, and VFY-REG remains unticked.
