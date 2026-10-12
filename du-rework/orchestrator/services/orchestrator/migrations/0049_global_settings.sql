-- ORV14 global settings. Tenant AI/prompt revisions are immutable and encrypted
-- in payload_ref; platform retention has a non-secret, bounded JSON policy.
CREATE TABLE IF NOT EXISTS global_settings_tenant_heads (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stream text NOT NULL CHECK (stream IN ('ai','prompts')),
  active_revision integer NULL CHECK (active_revision IS NULL OR active_revision >= 0),
  draft_revision integer NULL CHECK (draft_revision IS NULL OR draft_revision >= 0),
  next_revision integer NOT NULL DEFAULT 0 CHECK (next_revision >= 0),
  PRIMARY KEY (tenant_id, stream)
);

CREATE TABLE IF NOT EXISTS global_settings_tenant_revisions (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stream text NOT NULL CHECK (stream IN ('ai','prompts')),
  revision integer NOT NULL CHECK (revision > 0),
  state text NOT NULL CHECK (state IN ('DRAFT','TESTED','PUBLISHED','SUPERSEDED')),
  payload_ref jsonb NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[a-f0-9]{64}$'),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 128),
  source_revision integer NULL CHECK (source_revision IS NULL OR source_revision > 0),
  tested_at timestamptz NULL,
  published_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, stream, revision),
  CHECK (stream = 'ai' OR tested_at IS NULL)
);
CREATE INDEX IF NOT EXISTS global_settings_tenant_revisions_history_idx
  ON global_settings_tenant_revisions (tenant_id, stream, revision DESC);

CREATE TABLE IF NOT EXISTS global_settings_idempotency (
  scope_key text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 256),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 256),
  request_hash text NOT NULL CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope_key, idempotency_key)
);

CREATE TABLE IF NOT EXISTS global_settings_retention_head (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active_revision integer NOT NULL DEFAULT 0 CHECK (active_revision >= 0),
  draft_revision integer NULL CHECK (draft_revision IS NULL OR draft_revision > 0),
  next_revision integer NOT NULL DEFAULT 0 CHECK (next_revision >= 0)
);
INSERT INTO global_settings_retention_head(singleton,active_revision,draft_revision,next_revision)
VALUES(true,0,NULL,0) ON CONFLICT(singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS global_settings_retention_revisions (
  revision integer PRIMARY KEY CHECK (revision >= 0),
  state text NOT NULL CHECK (state IN ('DRAFT','TESTED','PUBLISHED','SUPERSEDED')),
  settings jsonb NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^sha256:[a-f0-9]{64}$'),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 128),
  source_revision integer NULL CHECK (source_revision IS NULL OR source_revision >= 0),
  published_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO global_settings_retention_revisions(revision,state,settings,digest,actor,published_at)
VALUES(0,'PUBLISHED','{"cacheTtlHours":168,"outputRetentionDays":0,"cleanupIntervalSeconds":3600}'::jsonb,
       'sha256:3654c99701317b3774f5fa8ded005ec4dfdc3441c106364c02af574bb66fb470','system:bootstrap',clock_timestamp())
ON CONFLICT(revision) DO NOTHING;

-- Admission snapshots use AAD slot operations.tenant_defaults_ref. The two
-- non-secret connection fields are grant-time fallback pins for declared
-- provider slots; credentials remain Connector/Vault-owned.
ALTER TABLE operations ADD COLUMN IF NOT EXISTS tenant_defaults_ref jsonb NULL;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS tenant_defaults_digest text NULL;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS tenant_defaults_ai_revision integer NULL;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS tenant_defaults_prompt_revision integer NULL;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS tenant_default_connector_id text NULL;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS tenant_default_connector_revision integer NULL;
-- Store only the sealed JSON envelope; grant verification opens it with the
-- operations.connector_recipe_pins_ref AAD slot and compares it with the
-- encrypted task schema pin. Never persist workflow overrides as plaintext.
ALTER TABLE operations ADD COLUMN IF NOT EXISTS connector_recipe_pins_ref jsonb NULL;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS workflow_schema_slug text NULL;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS workflow_schema_revision integer NULL;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS workflow_schema_digest text NULL;
ALTER TABLE operations ADD CONSTRAINT operations_tenant_defaults_digest_check
  CHECK (tenant_defaults_digest IS NULL OR tenant_defaults_digest ~ '^sha256:[a-f0-9]{64}$');
ALTER TABLE operations ADD CONSTRAINT operations_tenant_defaults_revision_pair_check
  CHECK ((tenant_default_connector_id IS NULL) = (tenant_default_connector_revision IS NULL));
ALTER TABLE operations ADD CONSTRAINT operations_workflow_schema_pin_check
  CHECK ((workflow_schema_slug IS NULL AND workflow_schema_revision IS NULL AND workflow_schema_digest IS NULL)
      OR (workflow_schema_slug IS NOT NULL AND workflow_schema_revision > 0 AND workflow_schema_digest ~ '^sha256:[a-f0-9]{64}$'));
