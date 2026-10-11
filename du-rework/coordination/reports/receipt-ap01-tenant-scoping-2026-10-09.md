# AP-01 tenant scoping smoke receipt

Date: 2026-10-09  
Plan: `coordination/PLAN-UI-BUSINESS-WORKFLOW-2026-10-08.md` (AP-01 approved)  
Scope: Admin Web Profiles and Businesses screens only, plus this required receipt.

## Changes

- `orchestrator/apps/admin-web/src/features/profiles/profiles-screen.tsx:25,89,146-159,562-579` adds `TenantSelect` bound to the shared tenant context. The API-key list already accepts `tenantId`, so changing the tenant clears stale keys and the loaded profile draft, then reloads API keys for the selected tenant. Profile detail/test BFF calls have no tenant query contract, so no unsupported tenant query is sent.
- `orchestrator/apps/admin-web/src/features/businesses/businesses-screen.tsx:15-16,32,137-144` adds a `TenantSelect` to the header, bound to shared tenant context. The business registry and version routes are platform-scoped; their strict list query contract accepts `limit`, `cursor`, and `sort`, and business rows have no tenant field. The control is labeled as tenant context and its description states this limitation. No unsupported tenant query is sent.
- Existing uncommitted edits were already present in both leased screen files before this task. They were preserved; this receipt records only the AP-01 additions above.

## Verification

| Command | Working directory | Exit code | Result |
|---|---|---:|---|
| `node ../../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | `du-rework/orchestrator/apps/admin-web` | 1 | Could not start: `Cannot find module 'D:\Git\dugate\du-rework\node_modules\typescript\bin\tsc'`. |
| `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | `du-rework/orchestrator/apps/admin-web` | 0 | Typecheck passed; no diagnostics. |

No test suite or browser session was run. No backend, generated OpenAPI file, or other product file was changed. No gate was ticked. No commit, staging, or push was performed.
