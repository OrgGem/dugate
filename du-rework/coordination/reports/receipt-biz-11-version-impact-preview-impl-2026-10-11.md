# Receipt BIZ-11 — business version impact preview

Date: 2026-10-11
Status: route implemented; targeted offline tests pass.

## Implementation

Added GET /api/v1/admin/businesses/{businessId}/versions/{version}/impact-preview with a closed action query for activate or deactivate.

The route resolves the principal before data access. Tenant operators are scoped from their credential and receive 403 for a foreign tenant selection. Platform requests must supply one tenantId. Missing, unassigned, foreign-owned, or unknown versions return the same tenant-facing 404.

Preview reads run in a repeatable-read, read-only transaction. Target ownership is checked through business_catalog.owner_tenant_id. Profile binding, profile workflow binding, and worker instance queries each retain the tenant/business/version ownership fence. The response lists profile revisions, active profile workflow selections, and worker instances without API key or connector secret fields. Each category is capped at 100 items, returns its total and truncation state, and the top-level complete flag is false if any category is truncated.

The response reports lifecycle status, active version, lifecycle revision, eligibility, no-op versus change, and VERSION_NOT_ENABLED blockers. Preview does not mutate lifecycle state.

Changed implementation files:

- orchestrator/services/orchestrator/src/http/routes/admin.ts
- orchestrator/services/orchestrator/src/modules/admin-read/business-impact-preview.ts
- orchestrator/services/orchestrator/tests/biz-11-version-impact-preview.test.ts

## Verification

- npm test -- tests/biz-11-version-impact-preview.test.ts --runInBand: PASS, 1 suite and 6 tests.
- npm run typecheck: FAIL due to three unresolved exports imported by the existing src/modules/admin-read/tenant-business-catalog.ts file. The missing exports are TENANT_BUSINESS_CATALOG_CURSOR_MAX_LEN, TENANT_BUSINESS_CATALOG_QUERY_PARAMS, and TenantBusinessCatalogQuerySchema from @du/contracts. That file is outside this task change.
- No live database migration, build, git add, commit, or push was run.

The referenced BIZ-06 proposal receipt was not present at implementation time; DISPATCH-LIVE marked BIZ-06 as RUNNING. This implementation follows the explicit BIZ-11 request and the tenant ownership fence in the BIZ-03 architecture contract. Independent conformance to the missing BIZ-06 proposal remains unverified.

## Scope

Receipt and changed implementation files contain zero ASCII double quotes.
