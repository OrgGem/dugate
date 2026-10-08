# VERIFY leg #2 (OC/oc_2) — WFA-T26 & WFA-T27 independent verification — 2026-10-08

**Status: DONE — all commands exit 0. RED: none.**

- **Task:** second independent verification leg for WFA-T26 (expired-lease recovery without repeating a
  completed provider stage) and WFA-T27 (cancel ack/abort of an in-flight provider stage). Read-only.
- **Constraints:** no source/test edits, no commit/add/push, no `docs/21-openapi.json` edits, no gate ticks,
  WFA plan untouched, legacy root + nocobase untouched. No retry-to-green was needed.
- **Reference (leg #1):** `coordination/reports/verify-t26-t27-independent-codex-2026-10-08.md` — T26 focused
  exit 0 / T27 focused exit 0; that leg never reached the two unit suites (dsh-TUI died on provider quota).
- **Node:** `%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe` → **v24.21.0** (verified with `--version`).
- **Runner note:** packet wrote `& tests/workflow-api/run-jest.cjs …`; executed as
  `& <node24> tests/workflow-api/run-jest.cjs …` because the runner must be started by the Node 24 binary
  it re-spawns for Jest (`process.execPath`). No other deviation.

## 1. Commands + literal results

| # | Command (cwd) | Exit | Literal `Tests:` line |
|---|---|---|---|
| A1 | `& <node24> tests/workflow-api/run-jest.cjs verify2-t26-focused-NODE24.log tests/workflow-api/http-worker.integration.test.ts -t "recovers an expired lease without repeating the completed provider stage"` (`D:\Git\dugate\du-rework`) | **0** | `Tests:       14 skipped, 1 passed, 15 total` |
| A2 | `& <node24> tests/workflow-api/run-jest.cjs verify2-t27-focused-NODE24.log tests/workflow-api/http-worker.integration.test.ts -t WFA-T27` (`D:\Git\dugate\du-rework`) | **0** | `Tests:       14 skipped, 1 passed, 15 total` |
| A3 | `& <node24> tests/workflow-api/run-jest.cjs verify2-full-NODE24.log tests/workflow-api/http-worker.integration.test.ts` (`D:\Git\dugate\du-rework`) | **0** | `Tests:       15 passed, 15 total` |
| B4 | `& <node24> node_modules/jest/bin/jest.js --runInBand --config jest.config.cjs tests/wfa-t26-lease-loss-abort.test.ts` (`D:\Git\dugate\du-rework\orchestrator\packages\worker-sdk`) | **0** | `Tests:       7 passed, 7 total` |
| B5 | `& <node24> node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --runTestsByPath tests/wfa-t27-cancel-ack.test.ts` (`D:\Git\dugate\du-rework\orchestrator\services\orchestrator`) | **0** | `Tests:       3 passed, 3 total` |

Focused matches are the intended tests (literal `√` lines):
- A1: `√ recovers an expired lease without repeating the completed provider stage (WFA-T26) (6226 ms)`
- A2: `√ cancels an operation while a provider stage is in flight and aborts that stage (WFA-T27) (1453 ms)`

A3 full suite — 15/15, all literal names:
`pinned input node terminal projection`; `one-file doc-compare async failure`; `two-file named doc-compare
(WFA-T03)`; `file_parse/connector/archive_compress/archive_extract (WFA-T15/T18/T19/T22)`; `file_url_download
+ callback fences (WFA-T15/T19)`; **`expired-lease recovery (WFA-T26)`**; **`cancel in-flight provider stage
(WFA-T27)`**; `named disbursement (WFA-T01)`; `named lc-checker (WFA-T02)`; `HITL state/resume parity`;
`two ordered parallel checkpoints`; `sequential human checkpoints`; `admin credential cannot bypass API-key
auth`; `refuse file-bearing upload without artifact encryption`; `cancel a paused workflow`.

Non-failure warnings (recorded literally, exit still 0): A2 and A3 print
`Jest did not exit one second after the test run has completed.` (async handles — same as prior worker runs;
not a FAIL, not retried).

## 2. Confounder checkpoints (before first run / after last run)

| File | SHA-256 before | SHA-256 after | Expected |
|---|---|---|---|
| `orchestrator/services/orchestrator/src/modules/runtime/runtime.ts` | `c735d18e7ce73eff5b27ebd12eff97764dd41ecdba3fa7abbb315851468b3c86` | `c735d18e7ce73eff5b27ebd12eff97764dd41ecdba3fa7abbb315851468b3c86` | **MATCH c735d18e…c86 — identical; no BLOCKER** |
| `orchestrator/packages/worker-sdk/src/connector-invoker.ts` | `cc8aca7e54d4b8a00c4625822107d41f2d4564289a4321c04b8f12334b7bc221` | `cc8aca7e54d4b8a00c4625822107d41f2d4564289a4321c04b8f12334b7bc221` | unchanged |
| `orchestrator/packages/worker-sdk/src/task-context.ts` | `f56c6a3a75e71a212abbc364878b18652abf551aafaccf3074fb5e23698601e3` | `f56c6a3a75e71a212abbc364878b18652abf551aafaccf3074fb5e23698601e3` | unchanged |
| `orchestrator/packages/worker-sdk/dist/connector-invoker.js` | `c6886882fbc04aa616d9739eea28998f38861b78f16f08e6849eccb5c8e1e5f2` | `c6886882fbc04aa616d9739eea28998f38861b78f16f08e6849eccb5c8e1e5f2` | contains `if (signal?.reason === 'cancel')` at **:153** (before+after) |
| `orchestrator/packages/worker-sdk/dist/task-context.js` | `91275a8985a5064cd231204be58c2257b80f28b1e9936af3907d6ea77289338f` | `91275a8985a5064cd231204be58c2257b80f28b1e9936af3907d6ea77289338f` | contains `abort(reason)` at **:224** (before+after) |

The `git status` entries for these paths are the implementation lanes' pre-existing modifications; this
leg made no edits (verified by identical before/after hashes).

## 3. RED section

**none** — no test failed, no command left non-zero, no hash deviated, no string check failed.

## 4. Notes for the coordinator

- This leg independently reproduces leg #1's focused results (T26 exit 0, T27 exit 0) and additionally:
  the **full worker suite once (15/15, exit 0)** and the **two unit suites leg #1 never reached** (B4 7/7,
  B5 3/3). The T26/T27 focused runs inside the full suite also passed.
- T26 evidence level: worker restart/lease-recovery E2E through the real outbox/Redis worker + unit suite
  asserting no repeated provider invocation; T27: real in-flight cancel → connector abort ack + unit suite.
- Raw logs: `coordination/reports/raw/verify-t26-t27-independent-oc2-2026-10-08/`
  (5 command logs + 5 exit files + 16-file `SHA256SUMS.txt`). The canonical `verify2-*.log` copies there
  are this leg's **current** runs (09:36–09:38); three `attempt1-verify2-*.log` files are preserved from an
  earlier interrupted attempt of the same task at 09:18–09:20 — their literal results are identical
  (T26 focused `14 skipped, 1 passed`; T27 focused `14 skipped, 1 passed`; full `15 passed` — all exit 0),
  kept as history, not counted twice. Runner-managed copies also exist at `tests/workflow-api/logs/verify2-*.log`.
- No VERIFIED/ACCEPTED claim is made; gate decision stays with the coordinator.
