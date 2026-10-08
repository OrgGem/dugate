# VERIFY-2AGENT — WFA-T26 lease-recovery

Independent read-only test verification, 2026-10-08. This verification did not edit any test or product source; no commit, push, git add, plan update, or VERIFIED/ACCEPTED tick was made. The worktree already contained modified WFA-T26 worker-sdk source files and untracked WFA-T26 test files at verification time; those lane files were left untouched.

Node used for both commands: `C:\Users\Gem\AppData\Local\Temp\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe` (`v24.21.0`). The WFA PostgreSQL and Redis containers were running when checked, so the E2E command was run rather than marked NOT RUN.

| # | CWD | Command | UTC start | Exit / result |
|---|---|---|---|---|
| 1 | `D:\Git\dugate\du-rework\orchestrator\packages\worker-sdk` | `& "C:\Users\Gem\AppData\Local\Temp\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe" node_modules/jest/bin/jest.js --runInBand --config jest.config.cjs --silent --runTestsByPath tests/wfa-t26-lease-loss-abort.test.ts` | `2026-10-08T00:53:38.8175927+00:00` | **0** — 1 suite passed; 7 passed, 7 total. |
| 2 | `D:\Git\dugate\du-rework` | `& "C:\Users\Gem\AppData\Local\Temp\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe" tests/workflow-api/run-jest.cjs wfa-t26-verify-codex-node24-2026-10-08.log tests/workflow-api/http-worker.integration.test.ts -t "recovers an expired lease without repeating the completed provider stage"` | `2026-10-08T00:54:00.4256797+00:00` | **0** — 1 suite passed; 1 passed, 14 skipped, 15 total. This is **green**, different from the expected known red. No retry was made. |

## Lệnh 1 literal result

```text
Test Suites: 1 passed, 1 total
Tests:       7 passed, 7 total
Snapshots:   0 total
exit_code: 0
```

## Lệnh 2 literal result and diagnostic

The selected E2E test passed:

```text
PASS tests/workflow-api/http-worker.integration.test.ts (8.079 s)
    √ recovers an expired lease without repeating the completed provider stage (WFA-T26) (6128 ms)
Test Suites: 1 passed, 1 total
Tests:       14 skipped, 1 passed, 15 total
exit: 0
```

This does not match the expected `1 failed / 14 skipped / exit 1` result. The raw log does **not** contain the expected diagnostic text `lease-recovered schema workflow failed with LEGACY_WORKFLOW_CONNECTOR_FAILED`, nor `provider calls=` or `taskRows=` output. It does contain these worker log entries during the passing test:

```text
{"businessId":"document-core","businessVersion":"1.1.0","errorCode":"LEGACY_WORKFLOW_CONNECTOR_FAILED","retryable":true,"retryAfterMs":5000,"errorName":"LegacyWorkflowRuntimeError","timestamp":"2026-10-08T00:54:03.621Z","level":"error","service":"worker:document-core","version":"unknown","environment":"test","correlationId":"d925a6c3-f3bc-4091-b6e2-7c5c9132ff32","operationId":"716016af-d1ef-4836-b7fd-680890e7f5da","taskId":"23266d50-167e-4127-a344-e2672369fd28","invocationId":null,"message":"handler failed"}
{"businessId":"document-core","businessVersion":"1.1.0","timestamp":"2026-10-08T00:54:04.161Z","level":"warn","service":"worker:document-core","version":"unknown","environment":"test","correlationId":"d925a6c3-f3bc-4091-b6e2-7c5c9132ff32","operationId":"716016af-d1ef-4836-b7fd-680890e7f5da","taskId":"23266d50-167e-4127-a344-e2672369fd28","invocationId":null,"message":"lease lost during heartbeat; aborting context"}
{"businessId":"document-core","businessVersion":"1.1.0","errorCode":"LEGACY_WORKFLOW_CONNECTOR_FAILED","retryable":false,"errorName":"LegacyWorkflowRuntimeError","timestamp":"2026-10-08T00:54:04.168Z","level":"error","service":"worker:document-core","version":"unknown","environment":"test","correlationId":"d925a6c3-f3bc-4091-b6e2-7c5c9132ff32","operationId":"716016af-d1ef-4836-b7fd-680890e7f5da","taskId":"23266d50-167e-4127-a344-e2672369fd28","invocationId":null,"message":"handler failed"}
{"businessId":"document-core","businessVersion":"1.1.0","code":"LEASE_LOST","timestamp":"2026-10-08T00:54:04.181Z","level":"warn","service":"worker:document-core","version":"unknown","environment":"test","correlationId":"d925a6c3-f3bc-4091-b6e2-7c5c9132ff32","operationId":"716016af-d1ef-4836-b7fd-680890e7f5da","taskId":"23266d50-167e-4127-a344-e2672369fd28","invocationId":null,"message":"fail report fenced"}
```

The observed conclusion is: **unit green; E2E green in this verification**, despite the expected red and despite the runtime error entries above. This receipt reports the run as observed without interpreting those entries as a Jest failure.

## Raw evidence

Raw logs are under `coordination/reports/raw/wfa-t26-verify-codex-2026-10-08/`:

- `01-worker-sdk-unit.log` — command metadata, timestamps, Node version, captured output, and exit code.
- `02-workflow-api-e2e.log` — command metadata and captured runner output.
- `02-runner-generated.log` — byte-for-byte copy of the runner's own log, which includes its cwd, Node version, Jest command, complete Jest output, and exit code.

The runner-generated log and its raw copy have matching SHA-256 `C4DE833CCA4D6FF062EF903E2EAA8547434C5C13ADBB8B1AED893492DAB54DAC`.

The runner also wrote `tests/workflow-api/logs/wfa-t26-verify-codex-node24-2026-10-08.log` as specified by its first argument. No second E2E attempt was made.
