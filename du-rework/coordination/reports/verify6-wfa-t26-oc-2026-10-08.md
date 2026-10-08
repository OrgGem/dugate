# VERIFY-6 / VERIFY-2AGENT — WFA-T26 lease-recovery (independent verifier #2)

- **Task**: VERIFY-2AGENT — independently re-run WFA-T26 tests; do not trust the
  lane report.
- **Worker**: oc_3 (OpenCode) — independent verifier #2
- **Date**: 2026-10-08
- **Mode**: READ-ONLY — no source/test edits, no commit/push/git add, no
  `docs/21-openapi.json` edit, no legacy root, no VERIFIED/ACCEPTED tick.
- **Workspace**: `D:\Git\dugate\du-rework`
- **Node 24**: `C:\Users\Gem\AppData\Local\Temp\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe` — `v24.21.0`

## Revisions under test (working tree, untouched by this lane)

| File | SHA256 | State |
|---|---|---|
| `tests/workflow-api/http-worker.integration.test.ts` | `B52AA97056BE49C62C033837B4D0C0CFE669651CB9C47FC43CE4170CFF5BFE5A` | untracked `??`, mtime `02:58:51` |
| `orchestrator/packages/worker-sdk/tests/wfa-t26-lease-loss-abort.test.ts` | `AB7B43701334F9D8EA1CFEC0B59FA0FDA83316852F67B605FBF40C2DC2789932` | untracked `??`, mtime `07:41:10` |

## Command table (literal exit codes)

| # | Command (cwd) | Exit | Result |
|---|---|---|---|
| 1 | `<node24> node_modules/jest/bin/jest.js --runInBand --config jest.config.cjs --silent --runTestsByPath tests/wfa-t26-lease-loss-abort.test.ts` (`orchestrator/packages/worker-sdk`) | **0** | **Test Suites: 1 passed, 1 total / Tests: 7 passed, 7 total** — as expected |
| 2a | `<node24> tests/workflow-api/run-jest.cjs wfa-t26-verify-oc-node24-2026-10-08.log tests/workflow-api/http-worker.integration.test.ts -t "recovers an expired lease without repeating the completed provider stage"` (`du-rework`) | **0** | **1 passed / 14 skipped / 15 total** — ⚠️ NOT the expected red |
| 2b | same command, confirmation run | **1** | **1 failed / 14 skipped / 15 total** — expected known-red signature reproduced |

No retry-to-green was performed: exactly one prescribed run plus one confirmation
run; the divergent results are reported as-is.

## Command 1 — unit (verbatim)

```
Test Suites: 1 passed, 1 total
Tests:       7 passed, 7 total
exit: 0
```

## Command 2 — E2E, run 2a (07:56, verbatim, GREEN)

```
PASS tests/workflow-api/http-worker.integration.test.ts (8.169 s)
  WFA real schema HTTP → PostgreSQL outbox → Redis worker → legacy poll/result
    √ recovers an expired lease without repeating the completed provider stage (WFA-T26) (6224 ms)
Test Suites: 1 passed, 1 total
Tests:       14 skipped, 1 passed, 15 total
exit: 0
```

Worker-log signature counts (run 2a): `handler failed`=2, `lease lost during
heartbeat`=1, `fail report fenced`=1, `LEGACY_WORKFLOW_CONNECTOR_FAILED`=2 — the
scenario's intermediate failures appeared but the test still **passed**.

## Command 2 — E2E, run 2b (07:58, verbatim, RED — expected signature)

```
FAIL tests/workflow-api/http-worker.integration.test.ts (7.998 s)
Test Suites: 1 failed, 1 total
Tests:       1 failed, 14 skipped, 15 total
exit: 1
```

Failure block (verbatim):

```
  ● WFA real schema HTTP → PostgreSQL outbox → Redis worker → legacy poll/result › recovers an expired lease without repeating the completed provider stage (WFA-T26)

    lease-recovered schema workflow failed with LEGACY_WORKFLOW_CONNECTOR_FAILED; provider calls=["generate_disbursement_report"]; taskRows=[{"task_key":"root","state":"FAILED","attempt":3,"lease_epoch":4,"error_code":"LEGACY_WORKFLOW_CONNECTOR_FAILED"}]; worker frames (messages redacted):
    schema-workflow task=root LegacyWorkflowRuntimeError

      at executeConnectorNode (businesses/document-core/src/pipelines/workflows/schema/legacy-schema-runtime.ts:803:21)
      at businesses/document-core/src/pipelines/workflows/schema/legacy-schema-runtime.ts:294:24
      at Object.run (orchestrator/packages/worker-sdk/src/task-context.ts:401:24)
      at executeLegacyWorkflow (businesses/document-core/src/pipelines/workflows/schema/legacy-schema-runtime.ts:292:26)
      at worker_1.documentCoreHandlers.<computed> (tests/workflow-api/http-worker.integration.test.ts:634:16)
      at orchestrator/packages/worker-sdk/src/worker.ts:386:48
```

This matches the packet's expected known-red diagnostic verbatim
(`attempt: 3, lease_epoch: 4`, `legacy-schema-runtime.ts:803/804`). Worker-log
signature counts (run 2b): `handler failed`=3, `lease-lost`=1,
`fail-report-fenced`=1, `LEGACY_WORKFLOW_CONNECTOR_FAILED`=6.

## Conclusion — stated plainly

- **Unit: GREEN** — 7/7, exit 0. Consistent with the lane's claim.
- **E2E: NOT STABLE — GREEN once, RED once.** The known-red conclusion of the
  lane **reproduced only on run 2/2**; run 1/2 passed (exit 0) with the same
  command, same revision, same Node 24, ~2 minutes apart. This is flaky /
  state-dependent behavior at the current revision: neither a single green run
  can clear it nor a single red run can prove the defect deterministic.
- **Infrastructure was present** — the real PostgreSQL outbox → Redis worker
  stack executed both runs (~8s each); this is not a "NOT RUN — thiếu hạ tầng"
  case.
- No cause was inferred, nothing was fixed, no test/source file was touched, no
  retry-to-green was attempted. The lane's red finding must remain open; the
  green run must not be used to close it.

## Evidence inventory (`coordination/reports/raw/wfa-t26-verify-oc-2026-10-08/`)

| File | Content |
|---|---|
| `META.txt` | cwd / node version / verbatim commands / timestamps / exit codes / hashes |
| `cmd1-unit-worker-sdk.log` | unit run — 7/7, exit 0 |
| `cmd2-e2e-run-jest.log` | E2E run 1 — 1 passed, exit 0 (GREEN) |
| `cmd2-run-jest-receipt-run1.log` | copy of `tests/workflow-api/logs/wfa-t26-verify-oc-node24-2026-10-08.log` (run 1) |
| `cmd2b-e2e-confirmation.log` | E2E run 2 — 1 failed, exit 1 (RED, expected signature) |
| `cmd2-run-jest-receipt-run2.log` | copy of the repo log after run 2 |

Note: the repo log file `tests/workflow-api/logs/wfa-t26-verify-oc-node24-2026-10-08.log`
is written by the prescribed `run-jest.cjs` and is gitignored
(`du-rework/.gitignore:15 *.log`). No commit/push/add was performed.
