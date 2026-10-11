# Receipt BIZ-08 — migration 0043

Date: 2026-10-11
Status: implementation and offline SQL smoke completed.

## Change

Added orchestrator/services/orchestrator/migrations/0043_business_catalog.sql.

The migration creates business_catalog with business_id as the primary key, nullable owner_tenant_id referencing tenants(id) with ON DELETE RESTRICT, lifecycle_revision defaulting to 1 with a positive-value check, and created_at plus updated_at timestamps. It adds an owner lookup index and seeds one unassigned catalog row per distinct business_versions.business_id. Seed timestamps preserve the earliest version creation and latest version update. The seed uses ON CONFLICT DO NOTHING so an existing owner is not overwritten.

The migration does not add a foreign key from business_versions. Per BIZ-03, defer that constraint until all supported registration writers create catalog roots and the rollback floor is compatible.

## Verification

Applied the migration SQL to an isolated disposable PostgreSQL 17 container with networking disabled and minimal tenants and business_versions prerequisite tables. The SQL completed successfully. Smoke assertions passed for logical business deduplication, null ownership, lifecycle_revision default, and preserved timestamp range.

The database was temporary and removed after the check. No repository migration runner, application tests, or build were run.

## Scope

No git add, commit, or push was performed. The migration and this receipt contain zero ASCII double quotes.
