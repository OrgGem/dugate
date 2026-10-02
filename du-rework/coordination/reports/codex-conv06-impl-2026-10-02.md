# CONV-06 implementation receipt

Date: 2026-10-02

## Implementation

- Added the pure worker-SDK primitive in `packages/worker-sdk/src/bounded-fanout.ts` and exported its types and functions from `packages/worker-sdk/src/index.ts`. It provides generic child identity/outcome types, `resolveFanoutConcurrency(requested, hardLimit)`, and the in-process ordered queue-index executor `runBoundedFanout`; it contains no business imports, persistence, networking, scheduling, or stage policy.
- Added `packages/worker-sdk/tests/bounded-fanout.test.ts` for normalization/capping, concurrency and output ordering, sibling survival after a child error, error-code/message fallbacks, empty input, and an unscheduled sparse slot.
- Replaced the duplicated executor and error conversion in `businesses/document-core/src/pipelines/workflows/disbursement/fanout.ts` and `businesses/lc-checker/src/fanout.ts` with SDK delegates. Each business retains its local hard cap (`MAX_FANOUT_CONCURRENCY` = 8), `resolveConcurrency` wrapper, child types, and surrounding workflow/stage behavior. No durable `spawnAndWait`, runtime scheduling, stage/failure policy, OCR/visual path, or cross-business imports were changed.
- Updated the two existing fan-out tests, `businesses/document-core/tests/p9-01-disbursement.test.ts` and `businesses/lc-checker/tests/lc-checker.test.ts`, to exercise the public SDK resolver alongside the business wrapper.
- Result objects preserve input ordering, `payload`/`error` remain optional, per-child failures do not cancel siblings, and absent error codes use `CHILD_FAILED` with the thrown message/string. The defensive unscheduled-slot result is materialized with `Array.from`; unlike `Array.prototype.map`, it visits sparse holes, so the documented `CHILD_NOT_SCHEDULED` fallback is actually returned for a missing slot.

## Test and typecheck evidence

All commands below ran from `du-rework` unless a working directory is stated. Exit codes are literal.

| Package / check | Before | After |
|---|---|---|
| Worker SDK focused | No shared primitive suite existed. | `pnpm --filter @du/worker-sdk test -- tests/bounded-fanout.test.ts` — exit 0; `Test Suites: 1 passed, 1 total`; `Tests: 5 passed, 5 total`. |
| Document-core focused | `pnpm --filter @du/document-core exec jest --runInBand --runTestsByPath tests/p9-01-disbursement.test.ts` — exit 0; `1` suite and `45/45` tests passed. | Same command — exit 0; `Test Suites: 1 passed, 1 total`; `Tests: 45 passed, 45 total`. |
| LC-checker focused | `node ..\document-core\node_modules\jest\bin\jest.js --runInBand --runTestsByPath tests\lc-checker.test.ts` from `businesses/lc-checker` — exit 0; `1` suite and `35/35` tests passed. | Same Jest command with `NODE_PATH` set to `..\document-core\node_modules` — exit 0; `Test Suites: 1 passed, 1 total`; `Tests: 35 passed, 35 total`. |
| Worker SDK full | `pnpm --filter @du/worker-sdk test` — exit 0; `Test Suites: 23 passed, 23 total`; `Tests: 645 passed, 645 total`. | `pnpm --filter @du/worker-sdk test` — exit 0; `Test Suites: 24 passed, 24 total`; `Tests: 650 passed, 650 total`. |
| Document-core full | `pnpm --filter @du/document-core test` — exit 0; `Test Suites: 58 passed, 58 total`; `Tests: 924 passed, 1 skipped, 925 total`. | `pnpm --filter @du/document-core test` — isolated rerun exit 0; `Test Suites: 58 passed, 58 total`; `Tests: 924 passed, 1 skipped, 925 total`. |
| LC-checker full | `node ..\document-core\node_modules\jest\bin\jest.js --runInBand` from `businesses/lc-checker` — exit 0; `Test Suites: 6 passed, 6 total`; `Tests: 118 passed, 118 total`. | Same command with `NODE_PATH` set to `..\document-core\node_modules` — exit 0; `Test Suites: 6 passed, 6 total`; `Tests: 118 passed, 118 total`. |
| Worker SDK typecheck | `pnpm --filter @du/worker-sdk exec tsc --noEmit -p tsconfig.json` — exit 0. | Same command — exit 0. |
| Document-core typecheck | `pnpm --filter @du/document-core exec tsc --noEmit -p tsconfig.json` — exit 0. | Same command — exit 0. |
| LC-checker typecheck | `node ..\document-core\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json` from `businesses/lc-checker` — exit 0. | Same command — exit 0. |

`pnpm --filter @du/worker-sdk build` also completed with exit 0 so the package distribution reflects its new public export. The LC-checker workspace has no local `node_modules` executable links, so its Jest and TypeScript checks used the installed document-core tool binaries directly; both full and focused checks passed.

The first post-change document-core full-suite attempt ran concurrently with the longer worker-SDK suite and had one existing 5-second parser-budget test time out (`tests/parser-budgets.test.ts:760`): 57 suites passed, 1 failed; 923 passed, 1 skipped, 1 failed. After the worker-SDK run ended, the same full document-core command ran alone and passed with the totals above. No test files were changed to mask that timeout.

## Scope

Changes are limited to the shared SDK primitive/export/test and the two business adapters/tests listed above. No `packages/contracts`, server, runtime scheduling, or durable spawn path was modified. No gate was ticked and no commit was made.
