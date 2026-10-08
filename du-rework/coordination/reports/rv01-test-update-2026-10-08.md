# RV01 stale expectations — test update

- Date: 2026-10-08 (Asia/Saigon, UTC+7)
- Worker: OpenCode 4 (`oc_4`)
- Lease: **only** `orchestrator/services/orchestrator/tests/rv01-loopback-http-offline.test.ts`. No product source (`src/**`), no other test file, no docs, no commit, no push.
- Basis: `coordination/reports/rv01-triage-2026-10-08.md` §5–§6 (stale expectations pin a pre-stand-in defect; product behavior is correct).

## 1. Fail-first (pre-fix)

```
cwd: D:\Git\dugate\du-rework\orchestrator\services\orchestrator
command: node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --silent tests/rv01-loopback-http-offline.test.ts
```

- Exit: **1** — `Test Suites: 1 failed, 1 total` / `Tests: 2 failed, 46 passed, 48 total`.
- Raw: `coordination/reports/raw/rv01-test-update-red-2026-10-08.txt`.

## 2. Change (exactly 2 expectation blocks, nothing else)

Per triage §6.1, against the stand-in preflight contract (`legacy-host-adapter.ts:126-150`; stand-ins are never persisted, `submit()` re-validates the real refs):

**Test A** — `named workflow uses shared submission with its legacy 202 envelope and ignores sync/idempotency` (`:1549`, updated block `:1556-1558`):

| Field (inside `workflowPreflights[0].input`) | Before | After |
|---|---|---|
| `artifactIds` | `[]` | `[expect.any(String)]` |
| `fileNames` | `[]` | `['invoice.pdf']` |
| `artifacts` | `[]` | `[{ artifactId: expect.any(String), role: 'files-1' }]` |

**Test B** — `runs workflow action/profile preflight before publishing uploaded bytes` (`:1620`, updated block `:1625-1630`): same three fields, role `'file'` (field `file`, not `files[]`).

Assertions deliberately kept byte-identical (not loosened):

- Test B: `res.status === 403` (`:1618`), `workflowPreflights` length 1 (`:1619`), **`db.artifacts` length 0 (`:1633`)**, **`submissions` length 0 (`:1634`)** — the core “preflight before publishing” guarantee still proven.
- Test A: all wire/bookkeeping assertions unchanged (`submissions[0]` snapshot and `idempotencyKey`; `workflowEncryptionReadinessChecks` 1→2; `workflowUploads`; second submit + `workflowPreflights` length 2) at `:1563-1574`.

Triage §6.2 optional “never persisted” hardening was **not** added: the task scope is exactly the two stale expectations, and adding assertions is outside it.

## 3. Green (post-fix)

```
cwd: D:\Git\dugate\du-rework\orchestrator\services\orchestrator
command: node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --silent tests/rv01-loopback-http-offline.test.ts
```

- Exit: **0** — `Test Suites: 1 passed, 1 total` / `Tests: 48 passed, 48 total`.
- Raw: `coordination/reports/raw/rv01-test-update-green-2026-10-08.txt`.
- **No other red test remains in the suite** (48/48), so the “report straight, do not fix beyond lease” branch did not trigger.

## 4. Typecheck

```
cwd: D:\Git\dugate\du-rework\orchestrator\services\orchestrator
command: node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

- Exit: **0** (clean).
- Raw: `coordination/reports/raw/rv01-test-update-typecheck-2026-10-08.txt`.
- The test file itself is type-checked during both jest runs: ts-jest transform with no `isolatedModules` and `tsconfig: '<rootDir>/tsconfig.json'` (`jest.config.cjs`).

## 5. Compliance

- Only the leased test file was edited in this task; `src/**`, other tests and `docs/21-openapi.json` were not touched (mtimes pre-date the task window).
- No commit, no push.
- Artifacts created: this receipt + the three raw logs above.
