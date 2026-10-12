-- ORV14 typed Connector recipe revisions. These rows are separate from the
-- legacy config revision chain: a typed recipe has a tenant UUID owner and may
-- have no credential at all. Recipes are envelope-encrypted by the app before
-- they reach JSONB. The credential source stores only a pinned Vault pointer.

-- Connector IDs are globally unique handles, but their recipes are tenant
-- owned. Keep this small ownership row even before the first recipe is
-- staged, so a signed tenant claim can fence Catalog imports before a secret
-- is submitted to Connector.
CREATE TABLE IF NOT EXISTS connector_parity_chains (
  connector_id TEXT PRIMARY KEY CHECK (connector_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  tenant_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connector_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS connector_parity_revisions (
  tenant_id UUID NOT NULL,
  connector_id TEXT NOT NULL CHECK (connector_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('PENDING','ACTIVE','RETIRED')),
  recipe_envelope JSONB NOT NULL CHECK (jsonb_typeof(recipe_envelope) = 'object'),
  credential_ref TEXT,
  credential_version INTEGER CHECK (credential_version IS NULL OR credential_version > 0),
  credential_source JSONB CHECK (credential_source IS NULL OR jsonb_typeof(credential_source) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connector_id, revision),
  CHECK ((credential_ref IS NULL) = (credential_version IS NULL)),
  CHECK ((credential_ref IS NULL) = (credential_source IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS connector_parity_one_active_revision
  ON connector_parity_revisions (tenant_id, connector_id) WHERE state = 'ACTIVE';

DO $$
BEGIN
  IF EXISTS (
    SELECT connector_id FROM connector_parity_revisions
    GROUP BY connector_id HAVING count(DISTINCT tenant_id) > 1
  ) THEN
    RAISE EXCEPTION 'typed Connector recipe chain is already owned by multiple tenants';
  END IF;
  INSERT INTO connector_parity_chains (connector_id, tenant_id)
    SELECT connector_id, min(tenant_id::text)::uuid
    FROM connector_parity_revisions
    GROUP BY connector_id
    ON CONFLICT (connector_id) DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'connector_parity_revisions_chain_owner_fk'
  ) THEN
    ALTER TABLE connector_parity_revisions
      ADD CONSTRAINT connector_parity_revisions_chain_owner_fk
      FOREIGN KEY (connector_id, tenant_id)
      REFERENCES connector_parity_chains (connector_id, tenant_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS connector_parity_claim_intents (
  tenant_id UUID NOT NULL,
  connector_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  expected_head_revision INTEGER NOT NULL CHECK (expected_head_revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connector_id, idempotency_key),
  FOREIGN KEY (connector_id, tenant_id)
    REFERENCES connector_parity_chains (connector_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS connector_parity_draft_intents (
  tenant_id UUID NOT NULL,
  connector_id TEXT NOT NULL CHECK (connector_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('PENDING','COMPLETED')),
  operation TEXT NOT NULL CHECK (operation IN ('DRAFT','ROLLBACK')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  expected_head_revision INTEGER NOT NULL CHECK (expected_head_revision >= 0),
  source_revision INTEGER CHECK (source_revision IS NULL OR source_revision > 0),
  recipe_envelope JSONB NOT NULL CHECK (jsonb_typeof(recipe_envelope) = 'object'),
  credential_ref TEXT,
  credential_version INTEGER CHECK (credential_version IS NULL OR credential_version > 0),
  credential_source JSONB CHECK (credential_source IS NULL OR jsonb_typeof(credential_source) = 'object'),
  credential_import_source JSONB CHECK (credential_import_source IS NULL OR jsonb_typeof(credential_import_source) = 'object'),
  vault_expected_version INTEGER CHECK (vault_expected_version IS NULL OR vault_expected_version >= 0),
  vault_target_version INTEGER CHECK (vault_target_version IS NULL OR vault_target_version > 0),
  vault_secret_sha256 TEXT CHECK (vault_secret_sha256 IS NULL OR vault_secret_sha256 ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connector_id, idempotency_key),
  UNIQUE (tenant_id, connector_id, revision),
  CHECK ((vault_expected_version IS NULL) = (vault_target_version IS NULL)),
  CHECK ((vault_target_version IS NULL) = (vault_secret_sha256 IS NULL)),
  CHECK (state <> 'COMPLETED' OR vault_target_version IS NULL OR credential_version = vault_target_version)
);

-- One unresolved Vault write per logical Connector chain. A lost response is
-- reconciled against its planned exact KV2 version before this fence is cleared.
CREATE UNIQUE INDEX IF NOT EXISTS connector_parity_one_pending_intent
  ON connector_parity_draft_intents (tenant_id, connector_id) WHERE state = 'PENDING';

CREATE INDEX IF NOT EXISTS connector_parity_revision_lookup
  ON connector_parity_revisions (tenant_id, connector_id, revision DESC);
