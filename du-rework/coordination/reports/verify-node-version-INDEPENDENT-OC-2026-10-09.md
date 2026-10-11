# Independent Node-version verification — OC

Status: PARTIAL — Node 22.16.0 was verified; requested Node 24.21.0 runs were unavailable.
Date: 2026-10-09
Scope: `du-rework` only. All test commands used offline Jest config. No PostgreSQL, Redis, or DB window was used/claimed.
No source/test/config/docs edits were made by this verifier. Only this receipt and the requested raw logs were written. No gate tick, commit, add, or push.

Raw evidence: `coordination/reports/raw/verify-node-version-2026-10-09/OC/`.
Command cwd: `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`.

## Node discovery

- Shell PATH resolves `node` to `C:\nvm4w\nodejs\node.exe`; `node -v` is `v22.16.0`.
- NVM list reports only `22.16.0` installed.
- A second executable was found at `C:\Users\Gem\AppData\Local\hermes\node\node.exe`; its version is `v22.23.2`. It was not used because command 2 requires the current PATH Node.
- No Node `v24.21.0` or other `v24.21.x` was found in PATH, NVM's installed versions, or the searched Node installation roots. No substitute was run.
- Discovery transcript and exit codes: `00-node-discovery.txt`.

## Command results

### Command 1 — public-upload on Node 24.21.0, two requested runs

Requested invocation:

```text
<node-v24.21.0 path> node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/public-upload-encryption-gateway.test.ts
```

Run 1: NOT RUN — executable unavailable; exit code N/A because Jest was not launched.
Run 2: NOT RUN — executable unavailable; exit code N/A because Jest was not launched.
`node -v` could not be recorded for these runs because no Node 24.21.x executable path was found. Evidence: `00-node-discovery.txt`, `01-pubupl-node24-not-found.txt`.

### Command 2 — public-upload on Node currently in PATH

Before the single Jest invocation, `node -v` printed `v22.16.0` (exit code 0); executable path: `C:\nvm4w\nodejs\node.exe`.

Command:

```text
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/public-upload-encryption-gateway.test.ts
```

REAL_EXIT: 0. Literal summary:

```text
Test Suites: 1 passed, 1 total
Tests:       12 passed, 12 total
```

The raw combined-stream capture is `02-pubupl-node-path.txt`; PowerShell decorated the first native output line as `node : Test Suites...`. The unaltered Jest summary text is transcribed in `02-pubupl-summary.txt`. The suite was run once only.

### Command 3 — adjacent regression suites on Node 24.21.0

Requested invocation:

```text
<node-v24.21.0 path> node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/rv01-loopback-http-offline.test.ts tests/admin-shell-session-lifecycle.test.ts
```

NOT RUN — no Node 24.21.x executable was found; exit code N/A because Jest was not launched. No Node 22 substitute was used. Evidence: `00-node-discovery.txt`, `03-regression-node24-not-found.txt`.

### Command 4 — backend typecheck

Command:

```text
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

Used shell PATH Node `v22.16.0`. REAL_EXIT: 0. TypeScript diagnostic error lines: 0. Captured output is only `REAL_EXIT=0` in `04-tsc.txt`.

### Command 5 — package engine pins

Read with `rg -n -A 6 '"engines"' package.json ../../../package.json` (exit code 0). Literal lines:

```text
../../../package.json:17:  "engines": {
../../../package.json-18-    "node": ">=24.21.0 <25",
../../../package.json-19-    "pnpm": ">=9.0.0"
package.json:45:  "engines": {
package.json-46-    "node": ">=24.21.0 <25"
```

Both the `du-rework` root and `services/orchestrator` pin Node `>=24.21.0 <25`. Full command output: `05-engines.txt`.

### Command 6 — working tree and revision

`git status --porcelain` exited 0; the full dirty status is in `06-git-status-final.txt`. HEAD from `git log -1 --format=%H` (exit code 0):

```text
72e225ae5465e5a648c34bf31fbabbd182763233
```

Raw revision output: `06-git-head-final.txt`.

## RED / skipped accounting and conclusion

RED: **KHÔNG CÓ** among the test processes actually executed. The public-upload suite is green on PATH Node `v22.16.0` (12/12, exit 0). The Node `v24.21.0` result is **unverified**, not green and not red, because that runtime is unavailable here. Therefore this evidence confirms the other lane's Node 22.16.0 half and neither confirms nor refutes its Node 24.21.0 failure claim; the results are not reconciled.

`tests/migrations.test.ts` is listed in `jest.unit.config.cjs:18` under the live suites ignored by `jest.unit.config.cjs`. It was skipped by this offline config and is not counted as passing.

No code was changed to make a suite green. No PostgreSQL/Redis access or DB-window claim was made. No gate was ticked; no commit/add/push was performed.
