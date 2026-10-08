-- WFA-03: immutable, tenant-scoped legacy Workflow Builder schema revisions.
-- schema_ref always contains a sealed metadata envelope (purpose
-- legacy_workflow_schemas.schema_ref); provisioning refuses plaintext writes.
CREATE TABLE IF NOT EXISTS legacy_workflow_schemas (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  revision integer NOT NULL CHECK (revision > 0),
  digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  schema_ref jsonb NOT NULL CHECK (jsonb_typeof(schema_ref) = 'object'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, slug, revision)
);

CREATE UNIQUE INDEX IF NOT EXISTS legacy_workflow_schemas_one_active
  ON legacy_workflow_schemas (tenant_id, slug)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS legacy_workflow_schemas_revision_lookup
  ON legacy_workflow_schemas (tenant_id, slug, revision DESC);
