# CONV-10 — Admin operations pagination test split

## Scope and changes

- Split the former 2,031-line `services/orchestrator/tests/admin-operations-list-pagination.test.ts` into query (415 lines, 6 describes), view (637, 5), SQL (602, 6), and sort (318, 1) suites; each is below 2,000 lines.
- Added `services/orchestrator/tests/helpers/operations-page-fixture.ts` (150 lines). Its fake DB still records each `{ sql, params }`; the SQL tests continue asserting captured SQL and bound parameter values via `pageQuery`/`countQuery`.
- Preserved 18 describes and all 103 expanded Jest tests. Coverage remains in the query/view/SQL/sort files for full and partial pages, forward/backward navigation, NULL deadline and tie-break paging, tenant/injection fences, and bad cursors. Each split file was run independently.
- No production source, CONV-08 helper, gate, or commit was changed.

## Commands and results

Working directory for all commands: `D:\Git\dugate\du-rework`.

| Run | Command | Result | Exit |
|---|---|---:|---:|
| Before split | `pnpm --filter @du/orchestrator test -- tests/admin-operations-list-pagination.test.ts` | 1 suite; 102 passed, 1 failed (103 total) | 1 |
| Query, independent | `pnpm --filter @du/orchestrator test -- tests/admin-operations-query.test.ts` | 1 suite; 26 passed | 0 |
| View, independent | `pnpm --filter @du/orchestrator test -- tests/admin-operations-view.test.ts` | 1 suite; 25 passed | 0 |
| SQL, independent | `pnpm --filter @du/orchestrator test -- tests/admin-operations-sql.test.ts` | 1 suite; 40 passed, 1 failed (41 total) | 1 |
| Sort, independent | `pnpm --filter @du/orchestrator test -- tests/admin-operations-sort.test.ts` | 1 suite; 11 passed | 0 |
| Focused aggregate | `pnpm --filter @du/orchestrator test -- tests/admin-operations-query.test.ts tests/admin-operations-view.test.ts tests/admin-operations-sql.test.ts tests/admin-operations-sort.test.ts` | 4 suites; 3 passed, 1 failed; 102 passed, 1 failed (103 total) | 1 |
| Typecheck | `pnpm --filter @du/orchestrator exec tsc --noEmit -p tsconfig.json` | passed | 0 |

## Baseline red retained

The same tenant-fence assertion failed before and after the split: `the x-api-key path is fenced by the key, not by the tenant param`. Before split it was at line 1616; after split it is in `services/orchestrator/tests/admin-operations-sql.test.ts:483`. Expected a rejected route result with status 403; actual result resolved with status 200 and `{ next_page_token: null, operations: [] }`. The assertion and its fixture were preserved; this task does not modify production or weaken the assertion. Therefore the all-green focused-suite acceptance is not met; there is no new red relative to the recorded pre-split baseline.
