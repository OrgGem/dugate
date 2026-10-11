# Receipt BIZ-03 — Business Catalog migration specification

Date: 2026-10-11
Scope: architecture and migration specification only; no migration or product code was changed.
Status: proposed for review, not implemented or independently verified.

## Recommendation

Create migration 0043 as an additive tenant-ownership root for logical businesses. Use business_id as the primary key, owner_tenant_id as a nullable foreign key to tenants(id) with ON DELETE RESTRICT, lifecycle_revision as a positive monotonic counter, and server-managed timestamps. Seed one unassigned catalog row for every existing business_versions.business_id. Never derive ownership from an arbitrary profile, workflow, operation, or first caller.

Keep unresolved and cross-tenant-conflict businesses unassigned until an authoritative owner mapping is approved. Tenant APIs must hide unassigned rows. Preserve the platform-global legacy path for inspection during rollout.

## Repository facts that constrain migration 0043

- 0042_worker_instances.sql is the latest migration currently present, so 0043_business_catalog.sql is the next sequence without renumbering prior files.
- tenants.id is uuid and the tenant table is created in migration 0001_platform_v1.sql.
- business_versions currently has primary key (business_id, version), no tenant_id, and immutable version manifests. Its timestamps include created_at and updated_at.
- Tenant references exist in operations, profile_bindings, profile_names, invocation_grants, and legacy_workflow_schemas. Workflow business_id is nullable and was added by migration 0040.
- Migration runner src/db/migrations.ts loads four-digit migration prefixes, rejects duplicate sequences, and executes each migration SQL plus its schema_migrations row in one database transaction. The runner documents that down migrations are not implemented and schema changes must remain forward-compatible.

Evidence reviewed:

- orchestrator/services/orchestrator/migrations/0001_platform_v1.sql
- orchestrator/services/orchestrator/migrations/0004_profile_bindings.sql
- orchestrator/services/orchestrator/migrations/0003_artifacts_grants.sql
- orchestrator/services/orchestrator/migrations/0028_profile_name.sql
- orchestrator/services/orchestrator/migrations/0037_legacy_workflow_schema_catalog.sql
- orchestrator/services/orchestrator/migrations/0040_workflow_business_profile_bindings.sql
- orchestrator/services/orchestrator/migrations/0041_profile_binding_allowed_origins.sql
- orchestrator/services/orchestrator/migrations/0042_worker_instances.sql
- orchestrator/services/orchestrator/src/db/migrations.ts:1-15, 177-214
- coordination/reports/docs-business-services-architecture-contract-2026-10-11.md

## Proposed business_catalog schema

| Column | Type | Nullability and rule |
| --- | --- | --- |
| business_id | text | Primary key; same logical identifier used by business_versions |
| owner_tenant_id | uuid | Nullable for unresolved legacy ownership; foreign key to tenants(id), ON DELETE RESTRICT |
| lifecycle_revision | bigint | NOT NULL, default 1, CHECK greater than zero |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

Use a single owner per business in this wave. The primary key prevents duplicate catalog roots. The tenant foreign key prevents assigning an owner that is not present. RESTRICT prevents tenant deletion from silently erasing or nulling business ownership. Ownership transfer requires a separate authorized and audited workflow.

The owner column stays nullable only while a legacy business is unassigned or a reconciliation conflict remains unresolved. New tenant-owned registration must supply ownership from trusted server-side authorization. A request body cannot choose owner_tenant_id.

### Proposed migration SQL shape

The following is a design sketch for 0043_business_catalog.sql, not an applied migration:

```sql
-- The migration runner already wraps this file and the ledger insert in one transaction.
CREATE TABLE IF NOT EXISTS business_catalog (
  business_id text PRIMARY KEY,
  owner_tenant_id uuid NULL,
  lifecycle_revision bigint NOT NULL DEFAULT 1 CHECK (lifecycle_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_catalog_owner_tenant_fk
    FOREIGN KEY (owner_tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS business_catalog_owner_business_idx
  ON business_catalog (owner_tenant_id, business_id);

INSERT INTO business_catalog (business_id, created_at, updated_at)
SELECT business_id, min(created_at), max(updated_at)
FROM business_versions
GROUP BY business_id
ON CONFLICT (business_id) DO NOTHING;
```

Keep the migration transactional: do not use CREATE INDEX CONCURRENTLY or add manual BEGIN and COMMIT statements. The insert creates an unassigned root and preserves the earliest version creation time plus latest version update time. ON CONFLICT DO NOTHING is important because a reviewed owner row must never be overwritten by a backfill.

### Relationship to business_versions

The architecture contract calls for business_versions to reference the catalog root after existing data is reconciled. Migration 0043 should create and seed the parent table, but should not yet add a foreign key from business_versions. The currently deployed registration path writes versions without creating an ownership row, and a code rollback to that writer would fail once a child foreign key is enforced.

After all active registration writers create the catalog root before inserting a version, run a catch-up reconciliation and add the child foreign key in a follow-up migration. Before that constraint is added, tenant-facing reads and writes must require an existing owned catalog row and fail closed if the join is absent. Do not treat absence of a child constraint as permission to serve global rows.

If deployment policy requires the child foreign key in 0043, the alternative is a database insert bridge that creates a null-owner catalog row before every legacy business_versions insert. That bridge keeps old registration writes working but can create new unassigned businesses during rollback. It needs explicit monitoring and reconciliation and is less clean than staging the foreign key after the writer upgrade.

## Legacy data reconciliation

### Phase 1 — Read-only census before migration

Produce an inventory keyed by business_id from business_versions and all tenant-bearing references:

- profile_bindings.tenant_id
- profile_names.tenant_id
- invocation_grants.tenant_id
- legacy_workflow_schemas.tenant_id where business_id is not null
- operations.tenant_id

For each business, record the distinct tenant IDs referenced by these rows, row counts by source, whether a business version exists, and whether references span multiple tenants. Do not include raw operation payloads, credentials, or workflow schema payloads in the report.

Reference tenants are evidence for review, not authoritative ownership. Even a single observed tenant is only a candidate unless a trusted business ownership source confirms it. Multiple observed tenants are an explicit conflict with the initial one-owner model.

### Phase 2 — Seed catalog roots without assigning owners

Migration 0043 inserts every current business_versions.business_id with owner_tenant_id null. It does not delete, rewrite, or reassign any profile, operation, workflow, or grant row. Version history and active pointers remain unchanged.

Registration can race with migration backfill while the old writer remains active. After the new dual-write registration path is deployed, run a catch-up insert for business_versions rows with no catalog root. Keep tenant catalog and lifecycle endpoints disabled until this catch-up finishes and the owner map is reviewed.

### Phase 3 — Apply reviewed owner mapping

Prepare a deployment-specific mapping of business_id to tenant UUID from an authoritative business ownership source. Validate that every tenant exists, every business has a version row, and each proposed assignment has a named approval and evidence reference. Apply only exact approved pairs. Do not embed environment-specific tenant ownership in the generic SQL migration.

Classify businesses into these groups:

- One reviewed owner and no conflicting tenant references: assign that owner after approval.
- No authoritative owner source: leave owner_tenant_id null and platform-only.
- References from more than one tenant: leave unassigned until product policy chooses a migration or explicit sharing model. Do not pick the most frequent tenant.
- Tenant references with no corresponding business_versions row: report as orphan references and resolve separately; do not create a fake business version.
- Business versions with no tenant references: leave unassigned unless another authoritative source supplies ownership.

Before enforcing ownership in profile or workflow binding writers, report every existing binding whose tenant differs from the approved owner. Preserve those rows during reconciliation. Resolve them through an explicit business-sharing grant design, a reviewed business reassignment, or an operational migration plan; do not silently delete or re-home them.

### Phase 4 — Enforce and validate

Once registration writers dual-write catalog root and versions, run the catch-up query again and verify no business_versions row lacks a catalog root. Verify all non-null owners join to tenants.id. Verify owner assignments against the approved mapping and review all cross-tenant references.

Then add and validate a restrictive foreign key from business_versions.business_id to business_catalog.business_id in a later migration, after confirming the supported rollback floor includes the dual-write writer. New binding, workflow selection, preview, and lifecycle paths must join through owner_tenant_id and the authenticated effective tenant.

## Rollback and recovery

- The migration runner has no down-migration mechanism. Do not describe 0043 as having an automatic SQL rollback.
- If 0043 fails, its DDL, seed insert, and schema_migrations ledger insert roll back together because the runner applies them in one transaction.
- If the application release must be rolled back after 0043 succeeds, leave business_catalog and its data in place. The pre-migration application can ignore the additive table. Since 0043 does not yet add the child foreign key, its old version registration write continues to work; new version rows may lack catalog roots until the dual-write release returns and catch-up reconciliation is rerun.
- Do not drop owner assignments, the table, or its tenant foreign key as part of routine application rollback. Do not edit schema_migrations to pretend an applied migration was reversed.
- Correct an applied schema defect with a forward migration, proposed sequence 0044 or later. A physical schema teardown is appropriate only for an isolated disposable database before ownership assignments or dependent code exist, using a separately reviewed recovery procedure.
- Before adding the later business_versions foreign key, either guarantee that rollback cannot return to a writer that omits business_catalog, or provide and review a compatibility bridge. This is a release-order prerequisite, not an assumption.

## Acceptance checks for the migration owner

- Migration file is named 0043_business_catalog.sql and uses a unique four-digit sequence.
- business_catalog has one row per logical business, primary key business_id, positive lifecycle_revision, timestamps, and owner_tenant_id foreign key to tenants(id) with ON DELETE RESTRICT.
- Backfill creates unassigned rows for every distinct existing business_versions.business_id and does not assign tenants or alter version rows.
- Re-running the seed statement does not overwrite an existing owner assignment.
- Preflight and post-migration censuses cover profile_bindings, profile_names, invocation_grants, legacy_workflow_schemas, operations, and business_versions.
- Multi-tenant and unresolved business references remain unassigned and are excluded from tenant-facing endpoints.
- No tenant endpoint is enabled until catch-up rows, owner mapping, foreign-key integrity, and cross-tenant conflicts have been reviewed.
- Follow-up business_versions foreign key is added only after every supported writer and rollback target respects the catalog root.
- Application rollback retains the additive schema and ownership data; recovery uses a forward fix rather than ledger edits or an unreviewed DROP.

## Scope and verification

This report is a migration design and reconciliation plan only. No SQL migration, source code, database state, tests, build, or gate state was changed or run.
