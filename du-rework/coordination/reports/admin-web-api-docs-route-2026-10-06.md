# ADMIN-WEB api-docs route — receipt (qwen_1, 2026-10-06)

Lease: services/orchestrator/src/app/admin/shell-server.ts only.

## Change

Added `api-docs` to ADMIN_WEB_ROUTE_NAMES (shell-server.ts:335-346), between
`profiles` and `api-keys` (alphabetical), with a comment explaining why.

Why this is the whole fix: ADMIN_WEB_ROUTE_NAMES is the allow-list of
recognised SPA route names. parseAdminWebRoutes (shell-server.ts:421-441) builds
`known` from it and DROPS any DU_ADMIN_WEB_ROUTES token that is not in the set,
logging "DU_ADMIN_WEB_ROUTES ignored unknown route names". So before this
change an operator who set DU_ADMIN_WEB_ROUTES=api-docs (or included it) had
the token silently discarded and /admin/web/api-docs answered the generic 404
document. After the change the token is honoured and the route is served.

The session gate is untouched: the allow-list only decides WHICH routes are
served; the existing session/CSRF/RBAC checks still run for every request.

## Verification — real numbers

| check | result |
|---|---|
| npx tsc --noEmit -p tsconfig.json | no output, exit 0 |
| tests/admin-shell-server.test.ts | PASS — 56 passed, 56 total, exit 0 |
| tests/admin-error-boundary-offline.test.ts | PASS |
| tests/adm-base-03-safe-error-offline.functional.test.ts | PASS |
| tests/admin-operations-sort-http-offline.test.ts | PASS |
| combined related suites | 3 passed, 98 passed, exit 0 |

Total related tests run: 154 passed, 0 failed, exit 0.

## Notes

- No test asserted the exact contents of ADMIN_WEB_ROUTE_NAMES, so no snapshot
  needed updating; the 56-test shell-server suite covers the allow-list parsing
  (unknown names dropped, empty list = everything gated) and still passes.
- admin-shell-session-lifecycle.test.ts remains the one pre-existing red suite
  (needs a live window); it is unrelated to this change.
- No commit, no tick.
