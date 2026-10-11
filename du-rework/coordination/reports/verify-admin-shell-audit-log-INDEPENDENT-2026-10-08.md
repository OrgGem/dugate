# Independent verification — admin-shell audit log metadata allowlist

RESUME POINT: INDEPENDENT REVIEW COMPLETE — all requested offline commands passed.

Scope: du-rework only. Only this receipt was written. No source/test changes, commit/add/push, gate tick, or docs/21-openapi.json edit. Offline tests only; no DB window is claimed.

Node: C:\nvm4w\nodejs\node.exe, v22.16.0.

## Commands

### Run 1

- cwd: D:\Git\dugate\du-rework\orchestrator\services\orchestrator
- exact command: node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/admin-shell-session-lifecycle.test.ts
- exit code: 0
- literal Test Suites line: Test Suites: 1 passed, 1 total
- literal Tests line: Tests:       51 passed, 51 total

### Run 2

- cwd: D:\Git\dugate\du-rework\orchestrator\packages\observability
- exact command: node node_modules/jest/bin/jest.js --runInBand --config jest.config.cjs
- exit code: 0
- literal Test Suites line: Test Suites: 3 passed, 3 total
- literal Tests line: Tests:       44 passed, 44 total

### Run 3

- cwd: D:\Git\dugate\du-rework\orchestrator\services\orchestrator
- exact command: node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
- exit code: 0
- stdout bytes: 0
- stderr bytes: 0

## Review a/b/c

- a — No test failed. Run 1 passed 51/51; Run 2 passed 44/44. No failing test name/line or expected/received values apply.
- b — Yes. tests/admin-shell-session-lifecycle.test.ts:821 still contains expect(record.event).toEqual({ ... }); the expected fields remain kind, reason, method, pathname at :822-825. The sentinel exclusion assertion remains at :827.
- c — Yes. orchestrator/packages/observability/src/log-metadata.ts:25 defines EVENT_FIELDS as new Set(['kind', 'reason', 'method', 'pathname', 'action']). eventLogRecord applies that allowlist at :29-35; event metadata is projected at :51-56.

## RED findings

None. Both Jest runs passed with their full expected counts; typecheck exited 0 with zero output. No DB window was used or claimed.
