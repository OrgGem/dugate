# CONV-08 independent split receipt — admin shell render tests

## Outcome

The P6-01..07 nested suites are split into seven independently runnable test files. The refactor preserved **140 test cases and 505 `expect` calls** exactly (AST count before and after); there are no skipped/only guards in these suites to lose. Each file is below 2,000 physical lines. Typecheck passes, but the requested focused-test exit-0 acceptance is **not met**: the independent runs aggregate to **138 passed / 2 failed**, both in the preserved P6-01 shell suite, described below. No renderer/production file was edited and no gate was changed.

## Files and literal counts

| Pane / file | Before: cases / expects | After: cases / expects | Lines after |
|---|---:|---:|---:|
| P6-01 `services/orchestrator/tests/admin-shell-render.test.ts` | 23 / 75 | 23 / 75 | 288 |
| P6-02 `services/orchestrator/tests/admin-business-render.test.ts` | 16 / 52 | 16 / 52 | 246 |
| P6-03 `services/orchestrator/tests/admin-profile-render.test.ts` | 24 / 89 | 24 / 89 | 575 |
| P6-04 `services/orchestrator/tests/admin-connector-render.test.ts` | 16 / 59 | 16 / 59 | 352 |
| P6-05 `services/orchestrator/tests/admin-api-key-render.test.ts` | 19 / 58 | 19 / 58 | 359 |
| P6-06 `services/orchestrator/tests/admin-operation-render.test.ts` | 28 / 105 | 28 / 105 | 583 |
| P6-07 `services/orchestrator/tests/admin-overview-render.test.ts` | 14 / 67 | 14 / 67 | 419 |
| **Total** | **140 / 505** | **140 / 505** | — |

The pane-local fixtures were already declared inside their respective nested suites; no fixture builder was genuinely shared, so no `tests/helpers/` file was added. Imports were narrowed to symbols referenced by each extracted pane. Escaping, role, unauthorized, fetch-failure, and other assertions remain in their pane blocks; no assertion or expectation was rewritten. Guard scan (`it.skip`, `describe.skip`, `test.skip`, `.only`, `DU_LIVE_INFRA`) returned `SKIP_GUARD_SCAN=NO_MATCHES` before and after.

## Independent focused runs

Commands ran one at a time from `D:\Git\dugate\du-rework\services\orchestrator`:

| Command | Result | Exit code |
|---|---:|---:|
| `npx jest --runInBand --runTestsByPath tests/admin-shell-render.test.ts` | 1 suite; 21 passed, 2 failed (23 total) | 1 |
| `npx jest --runInBand --runTestsByPath tests/admin-business-render.test.ts` | 1 suite; 16/16 passed | 0 |
| `npx jest --runInBand --runTestsByPath tests/admin-profile-render.test.ts` | 1 suite; 24/24 passed | 0 |
| `npx jest --runInBand --runTestsByPath tests/admin-connector-render.test.ts` | 1 suite; 16/16 passed | 0 |
| `npx jest --runInBand --runTestsByPath tests/admin-api-key-render.test.ts` | 1 suite; 19/19 passed | 0 |
| `npx jest --runInBand --runTestsByPath tests/admin-operation-render.test.ts` | 1 suite; 28/28 passed | 0 |
| `npx jest --runInBand --runTestsByPath tests/admin-overview-render.test.ts` | 1 suite; 14/14 passed | 0 |

The two P6-01 failures are:

1. `renderShell — four screen states › renders an empty screen state with the message` (`admin-shell-render.test.ts:119`): the test uses `role: 'operator'` with `section: 'profiles'`; rendered state is denied, so it does not contain `no profiles yet`.
2. `renderShell — role-filtered nav › shows operator-accessible nav items for an operator` (`admin-shell-render.test.ts:189`): the test expects `/admin/profiles` and `/admin/connectors` links, but the rendered operator navigation omits them.

The P6-01 test block and its assertions were extracted without edits. These failures were not repaired or hidden because the task requires preserving role/unauthorized assertions and limits changes to a test-only split. The other six pane files pass independently, demonstrating there is no Jest-order dependency among them.

Typecheck ran from `D:\Git\dugate\du-rework`:

```text
pnpm --filter @du/orchestrator exec tsc --noEmit
Exit code: 0
Diagnostics: none
```

## Scope notes

Only `admin-shell-render.test.ts` was reduced to P6-01 and the six pane test files above were added. No shared helper was necessary. No production/renderers, CONV-10 test, gate, or commit was touched by this task. At final status inspection, unrelated worktree changes were visible in Admin `*-section-data.ts` files and `admin-operations-list-pagination.test.ts`; they were left untouched.
