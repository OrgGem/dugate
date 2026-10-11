# Receipt SEC-OR-20261011-01

## Implementation

- Opaque-session claims now retain the server-side tenant id for route authorization; legacy role cookies still have no tenant scope.
- Legacy operations and overview reads use the configured platform bearer only for platform admins. Tenant operators require a configured tenant bearer and trusted JSON API base, and the session tenant overrides any tenant query value.
- Viewers, unscoped legacy operator sessions, and tenant operators without a mapped tenant credential receive 403 before a section fetcher runs. Platform admin reads retain their existing scope.
- Added offline regression coverage for operations list and detail, overview tenant override, fail-closed access, and platform admin behavior. Updated older viewer expectations to match the new authorization boundary.

## Verification

- Focused test command: `pnpm --dir orchestrator/services/orchestrator test -- tests/sec-or-01-legacy-read-scope-offline.test.ts tests/admin-shell-platform-mount.test.ts tests/admin-shell-server.test.ts tests/admin-shell-oidc-mount.test.ts tests/admin-shell-session-lifecycle.test.ts tests/oidc-claim-shape-contract-offline.test.ts`
- Result: PASS, 6 suites, 162 tests.
- Typecheck: `pnpm --dir orchestrator/services/orchestrator typecheck` — PASS, exit 0.
- Confirmed this receipt contains zero ASCII double quotes.

## Scope

- Task changes: legacy auth and section dispatch, shell session/config types, and related offline tests.
- No files were staged, committed, or pushed. Existing unrelated working-tree changes were left untouched.
