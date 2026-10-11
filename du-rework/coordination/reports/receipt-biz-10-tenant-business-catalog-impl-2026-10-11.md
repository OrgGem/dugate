# Receipt BIZ-10 — Tenant business catalog route

- **Recorded:** 2026-10-11
- **Status:** Implemented; owner verification passed. Independent verification and acceptance remain pending.
- **Endpoint:** `GET /api/v1/admin/tenants/{tenantId}/businesses`

## Implementation

- Added the tenant business catalog query and response contracts while keeping the legacy global business list contract separate.
- Added tenant-scoped SQL reads over `business_catalog`, with owner filtering applied before keyset paging and to the total count. Version summary fields are projected through bounded lateral reads; manifests and configuration are not returned.
- Added limit, closed sort, bounded normalized prefix query, and timestamp plus business ID keyset pagination. HMAC cursors bind the API version, tenant, normalized query, sort, timestamp, business ID, and page direction.
- The route authenticates the principal, canonicalizes and validates the path UUID, fences tenant operators to their own tenant, and checks tenant existence on every page. It returns the shared page fields plus `generatedAt`.
- Migration 0043 has no approved display-name column, so `displayName` uses `businessId` as the documented fallback and prefix search currently matches the business ID.
- Extended the BIZ-02 offline conformance suite for tenant authorization, page/count SQL fencing, output projection, forward and backward traversal, cursor scope and integrity rejection, query validation, and empty tenant pages.

## Verification

- **PASS — 12/12 tests, exit 0.** The suite includes the existing global route cases and the tenant catalog cases.
- **PASS — orchestrator typecheck, exit 0.**
- **PASS — contracts package build, exit 0.**
- Commands:
  - `pnpm --dir orchestrator/packages/contracts build`
  - `pnpm --dir orchestrator/services/orchestrator test --runTestsByPath tests/business-catalog-contract-conformance.test.ts`
  - `pnpm --dir orchestrator/services/orchestrator typecheck`
- Tests use a recording fake database. No live database or external service was used.

## Scope and disposition

- The legacy `GET /api/v1/admin/businesses` route remains platform-only and unchanged by this task.
- No gate was ticked. No git add, commit, or push was run.
