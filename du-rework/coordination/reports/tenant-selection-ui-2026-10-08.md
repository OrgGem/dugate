# Tenant selection UI — implementation receipt

**Task:** User-assigned tenant selection UI and Admin BFF roster read  
**Date:** 2026-10-08 02:10 ICT (2026-10-07 19:10 UTC)  
**Status:** Implemented; focused offline test and typechecks pass. No commit or push.

## Changes

- `orchestrator/services/orchestrator/src/app/admin/bff/handle.ts:73,97,384,412` — mounted `GET /admin/api/tenants`; requires both `role === 'admin'` and `principal.kind === 'platform'`, uses `runtime.adminToken`, relays the upstream page, forwards only `limit` and `cursor`, and drops `tenantId` and `sort`.
- `orchestrator/services/orchestrator/tests/tenant-list-bff-offline.test.ts:91,126,141` — offline BFF test for anonymous/viewer/operator denial, platform bearer, page relay, pagination forwarding, and query filtering.
- `orchestrator/apps/admin-web/src/lib/api/types.ts:38,45`; `lib/api/client.ts:60,253`; `lib/api/index.ts:66` — added `TenantRow`, `TenantPage`, exported types, and paginated `listTenants(query?)`.
- `orchestrator/apps/admin-web/src/components/ui/tenant-select.tsx:32,54,135,138`; `components/ui/index.ts:5` — shared tenant picker loads all roster pages, displays names, returns IDs, shows non-`ACTIVE` state, and reports All as `null` when enabled. UUIDs are never used as visible labels.
- `features/secrets/secrets-screen.tsx:315` — optional All tenants scope; non-admin scope remains session-controlled.
- `features/api-keys/api-keys-screen.tsx:198` — required tenant selection for key issuance, with no All option; non-admin scope remains session-controlled.
- `features/security/security-screen.tsx:110` — optional All tenants crypto-config scope; non-admin scope remains session-controlled.
- `features/connectors/connectors-screen.tsx:801` — revision result maps its tenant ID to a disabled name picker for platform admins; no raw tenant UUID is shown.
- `features/operations/operations-screen.tsx:37,52,154` — added an optional All tenants filter for admins, sent as the existing BFF `tenant` filter; other roles retain session scope.
- `features/usage/usage-screen.tsx` — TODO: usage will adopt `TenantSelect` after its owning agent finishes.

The working tree already had unrelated changes when work began, including `docs/21-openapi.json` and `features/usage/usage-screen.tsx`; neither was edited for this task.

## Fail-first and verification

All commands below ran from `du-rework/orchestrator/services/orchestrator` unless a different cwd is shown. Node was v22.16.0; the workspace declares Node >=24.21.0, so pnpm emitted engine warnings during the contracts build.

1. Before the route implementation:
   `pnpm exec jest --runInBand --config jest.unit.config.cjs tests/tenant-list-bff-offline.test.ts` — **exit 1**, 2 failed. The new route returned 404 (expected 401 for anonymous and 200 for platform admin). Raw output: `coordination/reports/raw/tenant-selection-ui-2026-10-08-red.txt`.
2. After tightening the test to cover pagination:
   same Jest command — **exit 1**, 1 failed. It exposed that the route dropped `limit`/`cursor`; raw output: `coordination/reports/raw/tenant-selection-ui-2026-10-08-query-red.txt`.
3. After the allowlist fix:
   same Jest command — **exit 0**, 1 suite passed, 2 tests passed. Raw output: `coordination/reports/raw/tenant-selection-ui-2026-10-08-green.txt`.
4. `pnpm --filter @du/contracts build` from `du-rework/orchestrator` — **exit 0**. This refreshed ignored local declarations for tenant-list contract exports.
5. `pnpm exec tsc --noEmit -p tsconfig.json` from `du-rework/orchestrator/apps/admin-web` — **exit 0**.
6. `pnpm exec tsc --noEmit -p tsconfig.json` from `du-rework/orchestrator/services/orchestrator` after the contracts build — **exit 0**. Before that build, service typecheck exited 1 because the local compiled `@du/contracts` declarations did not yet expose the tenant-list symbols present in source.

No OpenAPI JSON was hand-edited. Usage remains assigned to its existing owner.
