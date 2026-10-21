# Receipt — FOLLOWUP-CODEX-W0-CATALOG (tenant scope through catalog chain)

| Field | Value |
| :--- | :--- |
| Finding | Wave3-F4 follow-up — the catalog producer accepted `{ tenantId }`, but no caller passed it |
| Dispatch | [`FOLLOWUP-CODEX-W0-CATALOG-dispatch.txt`](../dispatch-specs/FOLLOWUP-CODEX-W0-CATALOG-dispatch.txt) |
| Worker | DeepSeek Worker 0 — `deepseek-v4.1-flash` |
| Status | **COMPLETE (source + offline tests).** Tenant scope flows route → BFF → client → editor; the catalog pins workflow revisions for the selected tenant. |
| Evidence level | Source, typecheck and offline/loopback test level. Browser spec stubs updated and typechecked; browser suite not re-executed in this packet. |
| Date | 2026-10-21 (host clock at run time) |

## 1. Changes

### 1.1 Service route — `src/http/routes/admin-profile-groups-v2.ts`
- The catalog accepts an optional `tenantId` beside `businessId`/`businessVersion`; unknown keys are still 422 and each key may appear only once.
- An empty `tenantId` is 422. A supplied value goes through
  `authorizeAuditTenantRead(principal, tenantId)`; the catalog stays platform-scoped
  (`requirePlatform`), so the tenant selects revision scope, not access.
- The authorized value is passed as `{ tenantId }` to `getBusinessFunctionCatalog`.

### 1.2 BFF — `src/app/admin/bff/profile-groups-v2.ts`
- Catalog query allow-list is now `businessId`, `businessVersion`, `tenantId`.
- Empty `tenantId` is 422 before any upstream call; a supplied value is forwarded
  verbatim on the upstream catalog URL. Platform-Admin gate, body relay and response
  handling are unchanged.

### 1.3 Client — `apps/admin-web/src/lib/api/client.ts`
- `getBusinessFunctionCatalog(businessId, businessVersion, tenantId?)`.
- The method now targets `/profile-groups/v2/catalog` (the route that understands
  tenant scope) and appends `tenantId` only when supplied. The v1 selector path
  returns the same catalog contract, so the v2 path is a drop-in for existing readers.

### 1.4 Editor — `apps/admin-web/src/features/profiles/profile-group-editor.tsx`
- `loadMemberCatalog` passes the component's current `tenantId` into the catalog read
  and includes it in the callback dependencies, so a tenant switch reloads with the
  correct revision scope.

### 1.5 Tests — `tests/aweb10-bff-profile-groups-v2.test.ts`
- New case: catalog forwards `tenantId` verbatim (own tenant and a foreign tenant for
  a platform Admin), rejects empty and repeated scopes with 422 before any upstream
  call, and still refuses a tenant session with `ADMIN_CREDENTIAL_REQUIRED`.

### 1.6 Out-of-lease fallout (reported explicitly)
- `apps/admin-web/tests/profile-group-api-client.test.mjs`: expected client URL
  updated to the v2 catalog path (one line).
- `tests/browser/admin-web/profile-groups-v2.spec.ts`: the two catalog route stubs now
  match `/admin/api/profile-groups/v2/catalog**`.
Both are test-only consequences of the client path move; no application source outside
the lease was changed.

## 2. Verification (literal)

| Command | Result |
| :--- | :--- |
| `pnpm --filter @du/admin-web exec tsc --noEmit` | `ADMINWEB_TSC=0` |
| `pnpm --filter @du/orchestrator exec tsc --noEmit` | `SERVICE_TSC=0` |
| `jest tests/aweb10-bff-profile-groups-v2.test.ts tests/aweb10-profile-group-v2-state.test.ts` | 2 suites, 49/49 passed, exit 0 (fresh re-run 2026-10-21) |
| `node --experimental-strip-types --test orchestrator/apps/admin-web/tests/profile-group-api-client.test.mjs` | 1/1 passed, exit 0 |
| `tsc -p ../../../tests/browser/tsconfig.json --noEmit` | `BROWSER_TSC=0` |

## 3. Boundary

The browser suite was not re-executed in this packet; its catalog stubs and the spec
compile cleanly. The Pin now applies to newly selected workflow actions; existing
bindings keep their stored revision through the draft state (previous packet).
