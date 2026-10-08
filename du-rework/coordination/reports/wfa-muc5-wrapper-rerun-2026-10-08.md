# WFA MUC 5 — wrapper rerun (3× full suite through `run-jest.cjs`) — 2026-10-08

- **Task**: verify the WFA test harness (`tests/workflow-api/run-jest.cjs`) after the
  maxBuffer fix — run the full suite 3× through the wrapper on Node 24.
- **Worker**: oc_3 (OpenCode)
- **Mode**: READ-ONLY — no source/test/product edits, no commit/push, no
  `docs/21-openapi.json` edit.
- **Workspace**: `D:\Git\dugate\du-rework`
- **Node 24**: `%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe` — `v24.21.0`

## Wrapper under test

`tests/workflow-api/run-jest.cjs` — SHA256
`65692ECC1CFCF71689E4F4D7DB1F83F056CB8C2D4C6BDE63877D76139DA02D53`, mtime
`2026-10-08T08:33:50`. Fix confirmed by read-only inspection: `maxBuffer: 64 * 1024 * 1024`
(lines 20-25) and a `spawnError:` line surfaced when `run.error` exists (lines 36-39).

## Command (each run, verbatim)

```
<node24> tests/workflow-api/run-jest.cjs wfa-muc5-wrapper-run<N>-2026-10-08.log tests/workflow-api/http-worker.integration.test.ts
```

cwd: `D:\Git\dugate\du-rework` — inner command (from the receipt):
`node node_modules/.pnpm/node_modules/jest/bin/jest.js --config tests/workflow-api/jest.config.cjs --runInBand tests/workflow-api/http-worker.integration.test.ts`

| Run | Start → End (local) | Exit | Literal result |
|---|---|---|---|
| 1 | 08:34:33 → 08:35:05 | **0** | `PASS … (17.65 s)` / `Test Suites: 1 passed, 1 total` / **`Tests: 15 passed, 15 total`** |
| 2 | 08:35:30 → 08:36:03 | **1** | `FAIL … (18.055 s)` / `Test Suites: 1 failed, 1 total` / **`Tests: 1 failed, 14 passed, 15 total`** |
| 3 | 08:36:03 → 08:36:35 | **1** | `FAIL … (17.346 s)` / `Test Suites: 1 failed, 1 total` / **`Tests: 1 failed, 14 passed, 15 total`** |

## Harness verdict — PASS (the maxBuffer issue is fixed)

- All 3 receipts are complete and were captured without truncation; **no
  `spawnError:` line appears in any run**; the `Tests:` summary is present in all 3.
- Exit codes correctly reflect the actual jest results (0 for the green run,
  1 for the two genuinely red runs) — **no false exit 1**.
- Receipt sizes: run1 967,180 / run2 968,737 / run3 968,753 bytes (UTF-8); the raw
  `*>` redirects are 1.95 MB each (UTF-16LE). No output loss.
- Per the task's own criterion ("exit 1 without a `Tests:` line = harness still
  broken"): that condition did **not** occur, so no direct-capture bypass was
  needed.

## Acceptance verdict — FAIL: the suite is not stable (1/3 green, 2/3 red)

Runs 2 and 3 are **genuine test failures**, not harness artifacts. Failing test in
both:

```
  ● WFA real schema HTTP → PostgreSQL outbox → Redis worker → legacy poll/result › cancels an operation while a provider stage is in flight and aborts that stage (WFA-T27)

    expect(received).toBe(expected) // Object.is equality

    Expected: "CANCELLED"
    Received: "FAILED"

      at Object.<anonymous> (tests/workflow-api/http-worker.integration.test.ts:1245:30)
```

- **WFA-T26 passed in all 3 full-suite runs** (`√ … (WFA-T26)` — 6106 / 6111 / 6095 ms),
  so the lease-recovery fix holds in these runs.
- The flake has moved to **WFA-T27** (`cancels an operation while a provider stage
  is in flight and aborts that stage`): green in run 1, red in runs 2 and 3 with
  `Expected "CANCELLED" / Received "FAILED"`.
- The coordinator's claim of 3 consecutive 15/15 direct runs was **not reproduced
  through the wrapper in this verification** (1 green, 2 red). Per the task rules,
  this is reported exactly, without interpretation or retry-to-green: 3 runs were
  performed as prescribed; the red results are real and remain open.
- Both runs also printed `Jest did not exit one second after the test run has
  completed` — recorded as observed; no inference.

## Evidence inventory (`coordination/reports/raw/wfa-muc5-wrapper-rerun-2026-10-08/`)

| File | Content |
|---|---|
| `META.txt` | wrapper hash/mtime, verbatim commands, timestamps, exit codes, failure assertion |
| `wrapper-run1.log` | raw stdout of wrapper run 1 — 15/15, exit 0 |
| `wrapper-run2.log` | raw stdout of wrapper run 2 — 1 failed (WFA-T27), exit 1 |
| `wrapper-run3.log` | raw stdout of wrapper run 3 — 1 failed (WFA-T27), exit 1 |
| `repo-wrapper-log-run{1,2,3}.log` | copies of `tests/workflow-api/logs/wfa-muc5-wrapper-run<N>-2026-10-08.log` |

The repo log files are written by the prescribed wrapper and are gitignored
(`du-rework/.gitignore:15 *.log`). No commit/push/add was performed.
