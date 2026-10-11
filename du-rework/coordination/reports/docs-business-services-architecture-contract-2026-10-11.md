# Business Services Wave — Architecture and API Contract

Date: 2026-10-11
Status: Proposed contract for architecture review. This report specifies the next wave; it does not claim implementation, verification, or acceptance.

## Executive assessment

The current business registry can page global business-version records, and it can enable, activate, or drain a version. It does not yet have a tenant ownership root. The business-version table is keyed by business ID and version, while tenant scope exists on profile bindings, workflows, and operations. Therefore adding a tenant query parameter to the current global catalog would not create tenant isolation.

Recommended direction: add an explicit business ownership record, then expose three tenant-scoped APIs: a keyset-paginated catalog, a read-only version impact preview, and a guarded lifecycle mutation endpoint. Every endpoint must authorize the effective tenant and prove business ownership in the same database path used to read or mutate the business.

## Current implementation and gaps

- The shared business list contract currently accepts limit, cursor, and sort. Shared page limits are 1 through 200, and the current shared sort vocabulary covers createdAt and updatedAt in ascending or descending order. The current default is createdAt:desc.
- The current business list query groups business_versions globally and its count query counts all distinct business IDs. The version list filters by business ID only.
- GET /api/v1/admin/businesses and GET /api/v1/admin/businesses/{businessId}/versions use platform admin authentication. Existing PUT enable, activate, and deactivate routes also use platform admin authentication.
- business_versions has a global primary key of business_id and version and no tenant_id. operations and profile_bindings carry tenant_id. Migration 0040 associates workflow revisions with business_id and business_version while retaining workflow tenant_id.
- Existing activation serializes version changes, requires the target version to be ENABLED, and switches the active pointer for new submissions. Existing operation pins continue to route in-flight work. Drain clears the active pointer; it does not cancel queued or running work.
- The business action dispatcher currently records a null tenant on business lifecycle audit rows because the global business-version record has no tenant owner.

Evidence reviewed:

- orchestrator/packages/contracts/src/public-api.ts:328-357, 481-491
- orchestrator/services/orchestrator/src/modules/admin-read/business-list.ts:23-101
- orchestrator/services/orchestrator/src/http/routes/admin.ts:89-177, 384-408, 516-547
- orchestrator/services/orchestrator/src/modules/admin-actions/dispatcher.ts:131-133, 491-540
- orchestrator/services/orchestrator/src/modules/registry/registry.ts:117-177
- orchestrator/services/orchestrator/src/modules/admin-actions/rbac.ts:18-108
- orchestrator/services/orchestrator/migrations/0001_platform_v1.sql:24-34
- orchestrator/services/orchestrator/migrations/0004_profile_bindings.sql:14-28
- orchestrator/services/orchestrator/migrations/0040_workflow_business_profile_bindings.sql:1-21
- coordination/reports/receipt-aweb-14-workflow-business-2026-10-10.md

## Tenant ownership model and authorization invariants

### Proposed ownership record

Add a business ownership root, provisionally named business_catalog, with one row per logical business:

| Field | Contract |
| --- | --- |
| business_id | Primary key matching business_versions.business_id |
| owner_tenant_id | Tenant foreign key; nullable only during migration reconciliation |
| lifecycle_revision | Monotonically increasing revision for ownership and lifecycle mutations |
| created_at, updated_at | Server-managed timestamps |

business_versions remains the immutable version catalog and references this root after existing data is reconciled. Keep the initial ownership model to one tenant per business. Do not infer ownership from the tenant in a request, the first caller to list a business, or an arbitrary profile binding. Existing businesses without authoritative ownership remain unassigned: platform administrators may inspect them through the legacy global surface, while tenant-scoped endpoints return the same not-found result as an unknown business.

If shared businesses are needed later, add an explicit tenant grant relation with its own authorization and revocation rules. Do not treat global visibility as shared ownership. Ownership transfer must be a separate platform-authorized, audited workflow; tenant users cannot claim or transfer a business by supplying ownerTenantId.

### Request scoping

1. Resolve the principal from trusted bearer or server-side session data. Never trust tenantId, role, or owner fields from a request body.
2. Derive effectiveTenantId from the authenticated tenant operator or from an explicit tenant context selected by a platform administrator. A platform request to a tenant endpoint must name one tenant; it must not silently become an all-tenant request.
3. For tenant operators, reject a different path tenant with 403. For a business that is missing, unassigned, or owned by another tenant, return the same 404 response to avoid confirming business existence.
4. Apply owner_tenant_id = effectiveTenantId before keyset paging, counting, loading versions, computing impact, or mutating state. Do not page a global result and filter it in the BFF or browser.
5. Recheck ownership inside the transaction for every lifecycle mutation. The authorization decision must happen before idempotency replay is returned.
6. Populate the tenant on lifecycle audit events from the ownership row. Never derive the audit tenant from a caller-supplied body field.
7. Profile and workflow binding reads and writes must verify that the binding tenant equals the effective tenant and that the selected business is owned by that tenant. Existing operations remain scoped by their own tenant_id and immutable business/version pin.

### Concurrency fence

Use the ownership root row as the per-business serialization point. Profile-binding writes, workflow-binding writes, ownership changes, and lifecycle changes must lock or otherwise serialize against this row. Lifecycle updates lock the root and then all affected business_versions rows in deterministic version order. This prevents a new binding or ownership change from slipping between a preview and a lifecycle check. Increment lifecycle_revision for each accepted ownership or lifecycle mutation.

## API 1 — Business Catalog keyset pagination

### Backend route

GET /api/v1/admin/tenants/{tenantId}/businesses

Keep the existing global GET /api/v1/admin/businesses platform-only and unchanged during rollout. Do not add an optional tenantId query parameter to that global route and present it as a tenant fence.

### Query contract

| Parameter | Type and rule |
| --- | --- |
| limit | Integer 1 through 200; default 50 |
| cursor | Optional opaque cursor minted by this endpoint |
| sort | Closed shared sort enum: createdAt:asc, createdAt:desc, updatedAt:asc, updatedAt:desc; default createdAt:desc |
| q | Optional normalized prefix search over business ID and approved display name; bounded input length and escaped as data |

Order by the selected timestamp plus business_id as a unique tie-breaker. Apply the owner tenant predicate to both page and total count queries. Return one row per logical business, not one row per version.

The cursor is opaque and integrity-protected. Bind it to API version, effective tenant, normalized q, sort, timestamp, and business_id. Reject a cursor reused with another tenant, filter, or sort. A cursor is not an authorization token: authenticate and re-check ownership on every page request. Keyset traversal is weakly consistent across separate HTTP requests when a mutable sort field changes; return generatedAt and have the client refresh to see concurrent changes.

### Response contract

Use the existing page envelope: items, nextCursor, prevCursor, total, and limit. Each item contains only approved catalog fields:

- businessId
- displayName, or businessId as fallback if no approved name exists
- latestVersion and latestStatus
- activeVersion
- versionCount
- createdAt and updatedAt in canonical UTC

Do not return the full manifest, connector configuration, credentials, or unrelated tenant metadata. If a tenant label is included for operator context, derive it from the authorized route scope and do not use it as client authority.

The same-origin admin BFF should expose a tenant-scoped list route and derive the selected tenant from trusted session state. If a path tenant is accepted from the browser, the BFF must compare it with the authorized tenant before forwarding it.

### Failure behavior

- 401 for absent or invalid authentication.
- 403 for a tenant operator whose requested path tenant differs from the authenticated tenant.
- 400 for invalid query values or a malformed, expired, or scope-mismatched cursor.
- Empty page for a valid tenant with no owned businesses.

## API 2 — Version change impact preview

### Backend route

POST /api/v1/admin/tenants/{tenantId}/businesses/{businessId}/versions/{version}/impact-preview

### Request contract

Strict body with one action field. The first release supports enable, activate, and drain, matching current registry behavior. Reject unknown fields and unknown actions. The tenant and business identifiers come from the authorized path, not duplicated body fields.

### Response contract

Return a read-only preview containing:

- previewId: opaque, short-lived reference bound to principal scope, tenant, business, version, action, current lifecycle_revision, and impact fingerprint
- evaluatedAt and expiresAt
- tenantId, businessId, version, action, current status, current active version, and lifecycleRevision
- eligible: boolean
- blockers and warnings: stable reason codes with concise operator-safe summaries
- impact: aggregate counts for same-tenant profile bindings, same-tenant workflow bindings, and same-tenant queued or running operations where the underlying records support an exact tenant/business/version join
- impactComplete: boolean, plus unavailable reason codes when a related data source cannot be measured safely

Do not return profile IDs, workflow payloads, operation payloads, credentials, or manifest secrets. Do not claim an exact impact count when source rows cannot be proven to belong to the authorized tenant. If completeness is required by the selected action and a source is unavailable, fail closed with a typed unavailable response instead of reporting zero.

Preview has no side effects. It does not reserve a version, alter activation, cancel operations, or authorize a later mutation. It expires after a short server-configured interval, proposed default five minutes. The lifecycle endpoint reauthorizes and recalculates blockers under lock even when a valid previewId is supplied.

### Action semantics

| Action | Eligibility and effect |
| --- | --- |
| enable | Changes a registered disabled version to ENABLED. Does not make it active. |
| activate | Requires ENABLED. Atomically clears the prior active pointer and sets this version active for new submissions. Existing pinned operations continue unchanged. |
| drain | Clears this version active pointer so new submissions do not target it. Does not cancel, delete, or interrupt in-flight work. |

Do not label drain as cancellation or deletion in the UI. A terminal retire/archive action is outside this first contract because the current registry has no explicit terminal-state semantics.

## API 3 — Lifecycle action controls

### Backend route

POST /api/v1/admin/tenants/{tenantId}/businesses/{businessId}/versions/{version}/lifecycle

### Request contract

| Element | Requirement |
| --- | --- |
| Authorization | Re-resolve principal and effective tenant; verify ownership before any replay lookup or mutation |
| Idempotency-Key | Required; scope the key by principal, effective tenant, canonical path, and canonical request body |
| If-Match | Required lifecycle_revision from the current preview; stale revisions return 409 |
| Body | Strict action and previewId fields, with optional closed reasonCode; no tenantId or ownerTenantId |

Before committing, validate preview ownership, expiry, action, target version, current lifecycle_revision, current impact fingerprint, and action blockers. Recompute live impacts while holding the business serialization fence. Return 409 if the preview is stale or an action is no longer eligible. Authorization must be checked before idempotency replay, and the idempotency payload hash must include principal and tenant scope.

Use one transaction for ownership verification, version state update, active-pointer update, lifecycle_revision increment, idempotency marker, and audit row. For activate, lock all versions for the business in deterministic order and preserve the one-active-version invariant. For drain, clear the active pointer only. For enable, update status only. Existing operations keep their immutable version pins.

### Response contract

Return businessId, version, action, resulting status, isActive, activeVersion, lifecycleRevision, updatedAt, replayed, and auditEventId. Include an ETag representing lifecycle_revision so clients can refresh or submit If-Match consistently. Do not return raw database rows.

### Authorization policy

The initial mutation policy should remain platform-admin only until a tenant-scoped business.manage capability is explicitly implemented and reviewed. If tenant operators are enabled later, the capability must be bound to their authenticated tenant and business ownership; a tenant path alone does not grant mutation rights. Preview visibility may use tenant read authorization, but every mutation independently checks its stronger capability.

### Error contract

- 401 UNAUTHENTICATED for missing or invalid authentication.
- 403 PERMISSION_DENIED for an authenticated caller lacking the action capability or selecting a foreign tenant.
- 404 NOT_FOUND for missing, unassigned, or foreign-owned businesses and versions.
- 409 STATE_CONFLICT for ineligible state, changed lifecycle revision, stale preview, changed impact fingerprint, or idempotency-key reuse with a different canonical request.
- 422 INVALID_REQUEST for malformed action, preview reference, reason code, or headers.
- 503 IMPACT_UNAVAILABLE when required impact data cannot be computed safely.

## Compatibility and rollout

1. Reconcile business ownership from authoritative records. Inventory cross-tenant references first. Do not auto-assign a business to the first observed tenant. Leave unresolved businesses unassigned and visible only to the platform-global surface.
2. Add the ownership root and lifecycle revision, establish the business_versions relation, and make profile/workflow binding writers enforce the ownership fence.
3. Ship the tenant catalog read path. Confirm page and count SQL both start from the authorized ownership relation.
4. Ship impact preview with explicit completeness reporting and stable blocker codes.
5. Ship the lifecycle endpoint, tenant-attributed audit, idempotency authorization ordering, and the business serialization fence. Route the UI only through this endpoint.
6. Keep existing platform-global list and direct lifecycle routes restricted to platform administrators during migration. They must not become a tenant-user bypass. Before retiring or aliasing them, ensure the alias requires explicit tenant scope, uses the same ownership check and transaction, and emits a tenant-attributed audit event.

## Acceptance checks for implementation and independent review

- Tenant A cannot list, count, page, preview, mutate, or replay a resource owned by Tenant B by changing a path, body, cursor, previewId, or idempotency key.
- A platform principal must name an explicit tenant for every tenant-scoped endpoint; the tenant catalog never becomes an implicit global list.
- Missing, unassigned, and foreign-owned business IDs have the same tenant-facing not-found behavior.
- Page results and totals are tenant-filtered in SQL before pagination. Cursor reuse with another tenant, q, or sort is rejected.
- Every profile and workflow binding mutation rejects a business owned by another tenant. Existing records are reconciled before ownership enforcement is enabled.
- Preview is side-effect free, tenant-scoped, contains no secret or raw operation payload, reports incomplete sources honestly, and expires.
- Preview cannot bypass current authorization or current-state checks. A lifecycle request rechecks ownership, revision, blockers, and impacts inside the transaction.
- Concurrent activation cannot leave zero or multiple active versions. A stale If-Match fails without a state or audit partial write.
- Replaying an idempotent request from a different principal or tenant cannot return another scope's response; authorization runs before replay.
- Lifecycle audit events contain the owner tenant, actor, action, resource, correlation ID, and idempotency key reference, in the same transaction as state changes.
- Drain is verified to preserve in-flight work and is described as stopping new submissions only.

## Scope and verification

This is an architecture analysis and draft contract only. No product code, tests, migrations, build, or gate state were changed or run. Implementation and independent verification should be assigned under exact path leases before this proposal is treated as accepted.
