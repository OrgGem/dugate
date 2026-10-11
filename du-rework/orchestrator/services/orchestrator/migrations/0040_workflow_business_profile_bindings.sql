-- AWEB-14: optionally associate workflow revisions with a registered business
-- and let profiles select the exact workflow revision they use. NULL ownership
-- preserves the behavior of workflow rows created before this migration.
ALTER TABLE legacy_workflow_schemas
  ADD COLUMN IF NOT EXISTS business_id text NULL;
ALTER TABLE legacy_workflow_schemas
  ADD COLUMN IF NOT EXISTS business_version text NULL;

CREATE INDEX IF NOT EXISTS legacy_workflow_schemas_business_lookup
  ON legacy_workflow_schemas (tenant_id, business_id, business_version, slug, revision DESC);

CREATE TABLE IF NOT EXISTS profile_workflow_bindings (
  profile_id        uuid NOT NULL,
  workflow_slug     text NOT NULL CHECK (workflow_slug ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  workflow_revision integer NOT NULL CHECK (workflow_revision > 0),
  enabled           boolean NOT NULL DEFAULT true,
  config            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, workflow_slug)
);
