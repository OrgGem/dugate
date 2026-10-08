# F-1 — scope the tenant-list cursor boundary subquery

- Date: 2026-10-08 (Asia/Bangkok, UTC+7)
- Scope: `du-rework/` only
- No commit or push. `docs/21-openapi.json` was not touched.
- Raw command/result transcript: `coordination/reports/raw/f1-cursor-scope-fix-2026-10-08.txt`

## Change

`listTenantPage` now stores the scope bind once and reuses it in both the outer row filter and
the cursor boundary subquery (`orchestrator/services/orchestrator/src/modules/admin-read/tenant-list.ts:123-133`).
When a tenant-scoped operator replays a cursor for an outside tenant, the subquery returns no
row, the scalar boundary is NULL, and the page is empty. The cursor's tenant name no longer
controls the scoped page ordering.

The existing offline test `tenant-list cursor codec and SQL fence (offline) › reuses a cursor
under a new scope while fencing rows and count to that scope` now covers both cases: scope B
with a foreign cursor that would previously place B after the boundary, and scope B with foreign
tenant C whose name sorts after B. It asserts the page is empty and the SQL subquery includes the
scope bind (`orchestrator/services/orchestrator/tests/tenant-list-cursor-codec-offline.test.ts:115-149`).
The second case is the requested B-before-C scenario. This extends the existing test, keeping the
two tenant-list suites at 9 tests total.

## Test-first and verification results

| Phase | Command (cwd: `orchestrator/services/orchestrator`) | Exit | Result |
|---|---|---:|---|
| RED before source fix | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --runTestsByPath tests/tenant-list-cursor-codec-offline.test.ts -t "reuses a cursor under a new scope"` | 1 | SQL lacked `AND id = $1` in the boundary subquery; page itself was empty. 1 failed, 5 skipped. |
| Intermediate assertion update | same focused command | 1 | An earlier assertion expected `[TENANT_B]` for a foreign cursor; after the fix the correct fail-closed result was `[]`. Updated that old expectation and asserted the scoped subquery. |
| Focused GREEN | same focused command | 0 | 1 passed, 5 skipped. |
| Full tenant-list suites | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --silent --runTestsByPath tests/tenant-list-cursor-codec-offline.test.ts tests/tenant-list-bff-offline.test.ts` | 0 | 2 suites; 9 passed, 0 failed. |
| Backend typecheck | `pnpm run typecheck` | 0 | `tsc --noEmit -p tsconfig.json` passed. |

Typecheck emitted an engine warning: this package requests Node `>=24.21.0 <25`, while the
available runner is Node `v22.16.0` with pnpm `10.18.3`. The command still exited 0 with no
TypeScript errors. Both test failures above are recorded; the first is the expected fail-first
red, and the second exposed the old test expectation that needed updating.
