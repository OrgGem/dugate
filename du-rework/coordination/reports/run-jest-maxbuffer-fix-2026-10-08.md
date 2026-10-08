# Harness fix — run-jest.cjs maxBuffer truncation

- Date: 2026-10-08 (Asia/Saigon, UTC+7)
- Worker: OpenCode 4 (`oc_4`). Scope: **only** `tests/workflow-api/run-jest.cjs` + this receipt. No product source, no other test file, no `docs/21-openapi.json`, no commit, no push.
- Environment: cwd `D:\Git\dugate\du-rework`; Node **v24.21.0** (`%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe`); harness services PostgreSQL `127.0.0.1:55498` (`du-wfa-20261007-55498-pg`) and Redis `127.0.0.1:56398` (`du-wfa-20261007-56398-redis`).

## Diagnosis

`spawnSync` used Node's default `maxBuffer` (~1 MiB). The full WFA suite emits more than that (ajv/stack traces), so the child was killed mid-run: `run.status === null` → `exitCode = 1`, `stdout`/`stderr` truncated, and the receipt ended with `stderr:`/`exit: 1` and **no `Test Suites:` / `Tests:` summary** — indistinguishable from a test failure.

## Fix (literal diff, `tests/workflow-api/run-jest.cjs`)

```diff
 const run = spawnSync(process.execPath, jestArgs, {
   cwd: process.cwd(),
   encoding: 'utf8',
   env: process.env,
+  // The full WFA suite can emit >1 MiB of output (ajv/stack traces). Node's
+  // default maxBuffer (~1 MiB) kills the child and truncates the receipt
+  // without a 'Tests:' summary, which looks like a test failure. 64 MiB
+  // keeps the receipt complete for the current and near-future suites.
+  maxBuffer: 64 * 1024 * 1024,
 });
 const exitCode = run.status ?? 1;
 const receipt = [
   ...
   'stderr:',
   run.stderr ?? '',
+  // A spawn-level error (e.g. an overrun buffer or a failed exec) is a
+  // harness failure, not a test failure; surface it instead of silently
+  // reporting exit 1 with no summary.
+  ...(run.error ? [`spawnError: ${run.error.message}`] : []),
   `exit: ${exitCode}`,
 ].join('\n');
```

The conditional `spawnError:` line keeps the receipt format unchanged for normal runs while making future harness-level failures explicit.

## Fail-first (pre-fix, my own run — truncation reproduced)

```
cwd: D:\Git\dugate\du-rework
command: node tests/workflow-api/run-jest.cjs wfa-harness-prefix-full-2026-10-08.log   (full workflow-api dir)
```

- **EXIT 1** — harness log size **1,056,265 bytes**, ended mid ajv stack (`…iterateKeyw` then `exit: 1`).
- `Test Suites:` present? **No.** `Tests:` present? **No.**
- Raw: `coordination/reports/raw/wfa-harness-maxbuffer-prefix-2026-10-08.txt`; harness log `tests/workflow-api/logs/wfa-harness-prefix-full-2026-10-08.log`.

## Post-fix verification (through the wrapper only)

### A — acceptance run: http-worker file

```
cwd: D:\Git\dugate\du-rework
command: node tests/workflow-api/run-jest.cjs wfa-muc5-maxbuffer-fix-node24-2026-10-08.log tests/workflow-api/http-worker.integration.test.ts
```

- **EXIT 0**; harness log size **967,165 bytes**; no `spawnError`.
- `Test Suites: 1 passed, 1 total` / `Tests: 15 passed, 15 total` — required acceptance lines present.
- Raw: `coordination/reports/raw/wfa-harness-maxbuffer-postfix-worker-2026-10-08.txt`; harness log `tests/workflow-api/logs/wfa-muc5-maxbuffer-fix-node24-2026-10-08.log`.

### B — buffer exercise: full workflow-api dir (>1 MiB output)

```
cwd: D:\Git\dugate\du-rework
command: node tests/workflow-api/run-jest.cjs wfa-harness-postfix-full-2026-10-08.log   (full workflow-api dir)
```

- **EXIT 0**; harness log size **1,338,169 bytes** — past the old ~1 MiB kill point and **complete**; no `spawnError`.
- `Test Suites: 10 passed, 10 total` / `Tests: 49 passed, 49 total`.
- Raw: `coordination/reports/raw/wfa-harness-maxbuffer-postfix-full-2026-10-08.txt`; harness log `tests/workflow-api/logs/wfa-harness-postfix-full-2026-10-08.log`.

## Before/after comparison

| Run (wrapper) | Exit | Log size | `Test Suites:` | `Tests:` |
|---|---:|---:|---|---|
| Pre-fix, full dir | 1 (harness kill) | 1,056,265 B (truncated) | absent | absent |
| Post-fix, http-worker file | 0 | 967,165 B | `1 passed, 1 total` | `15 passed, 15 total` |
| Post-fix, full dir | 0 | 1,338,169 B (complete) | `10 passed, 10 total` | `49 passed, 49 total` |

## Compliance

- Only `tests/workflow-api/run-jest.cjs` was modified (the file is untracked in git, `??`); this receipt + raw/harness logs are the only other artifacts. No commit, no push, no product source, no `docs/21-openapi.json`.
- No test was skipped, edited or reclassified; the 15/15 and 49/49 results are the real Jest summaries emitted by the fixed wrapper.

## Evidence files

- `coordination/reports/raw/wfa-harness-maxbuffer-prefix-2026-10-08.txt` (pre-fix, exit 1, truncated)
- `coordination/reports/raw/wfa-harness-maxbuffer-postfix-worker-2026-10-08.txt` (post-fix acceptance, exit 0)
- `coordination/reports/raw/wfa-harness-maxbuffer-postfix-full-2026-10-08.txt` (post-fix full dir, exit 0, 1.34 MB)
- `tests/workflow-api/logs/wfa-harness-prefix-full-2026-10-08.log`, `tests/workflow-api/logs/wfa-muc5-maxbuffer-fix-node24-2026-10-08.log`, `tests/workflow-api/logs/wfa-harness-postfix-full-2026-10-08.log`
