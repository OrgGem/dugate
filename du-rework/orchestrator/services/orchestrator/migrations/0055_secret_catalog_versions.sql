-- Immutable, exact-version snapshots for retained storage generations and
-- continuity imports. The current catalog row remains the management head.
ALTER TABLE secret_catalog
  ADD COLUMN IF NOT EXISTS encryption_key_version text;

ALTER TABLE secret_catalog
  DROP CONSTRAINT IF EXISTS secret_catalog_purpose_check;
ALTER TABLE secret_catalog
  ADD CONSTRAINT secret_catalog_purpose_check CHECK (purpose IN (
    'connector.credential',
    'connector.provider_header',
    'profile.callback_header',
    'profile.callback_oauth2_client_secret',
    'oidc.client_secret',
    'source.auth',
    'storage.credential',
    'maintenance.backup_encryption',
    'generic'
  ));

CREATE TABLE IF NOT EXISTS secret_catalog_revisions (
  secret_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  name text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN (
    'connector.credential',
    'connector.provider_header',
    'profile.callback_header',
    'profile.callback_oauth2_client_secret',
    'oidc.client_secret',
    'source.auth',
    'storage.credential',
    'maintenance.backup_encryption',
    'generic'
  )),
  services text[] NOT NULL,
  provider_kind text NOT NULL CHECK (provider_kind IN ('managed_value', 'vault_reference')),
  provider_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL CHECK (state IN ('ACTIVE', 'DISABLED', 'REVOKED')),
  encrypted_value jsonb,
  encryption_key_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (secret_id, revision),
  FOREIGN KEY (secret_id) REFERENCES secret_catalog(secret_id) ON DELETE RESTRICT,
  CHECK ((provider_kind = 'managed_value' AND encrypted_value IS NOT NULL)
      OR (provider_kind = 'vault_reference' AND encrypted_value IS NULL))
);

CREATE INDEX IF NOT EXISTS secret_catalog_revisions_tenant_purpose_idx
  ON secret_catalog_revisions (tenant_id, purpose, secret_id, revision DESC);

-- Existing ciphertext did not record its key version. Preserve it under an
-- explicit sentinel that the runtime will only resolve if an operator maps
-- that exact version to a retained key. Never silently guess ENCRYPTION_KEY.
UPDATE secret_catalog
   SET encryption_key_version = 'legacy-unversioned'
 WHERE provider_kind = 'managed_value' AND encrypted_value IS NOT NULL
   AND encryption_key_version IS NULL;

INSERT INTO secret_catalog_revisions (
  secret_id, tenant_id, revision, name, purpose, services, provider_kind,
  provider_config, state, encrypted_value, encryption_key_version, created_at
)
SELECT secret_id, tenant_id, revision, name, purpose, services, provider_kind,
       provider_config,
       CASE WHEN state = 'DISABLED' THEN 'ACTIVE' ELSE state END,
       encrypted_value, encryption_key_version, created_at
  FROM secret_catalog
 WHERE revision >= 1
ON CONFLICT (secret_id, revision) DO NOTHING;

-- Exact version rows are historical evidence and may only be appended. The
-- FK is RESTRICT above so deleting a current catalog head cannot cascade away
-- bytes still pinned by a retained storage generation or continuity record.
CREATE OR REPLACE FUNCTION reject_secret_catalog_revision_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'secret_catalog_revisions is append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS secret_catalog_revisions_append_only ON secret_catalog_revisions;
CREATE TRIGGER secret_catalog_revisions_append_only
  BEFORE UPDATE OR DELETE ON secret_catalog_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_secret_catalog_revision_mutation();

CREATE TABLE IF NOT EXISTS secret_catalog_imports (
  tenant_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 256),
  request_hmac text NOT NULL CHECK (request_hmac ~ '^[a-f0-9]{64}$'),
  key_version text NOT NULL,
  source_system text NOT NULL CHECK (source_system ~ '^[a-z][a-z0-9._-]{0,63}$'),
  source_record_ref text NOT NULL CHECK (length(source_record_ref) BETWEEN 1 AND 256),
  secret_id uuid NOT NULL,
  revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key),
  FOREIGN KEY (secret_id, revision) REFERENCES secret_catalog_revisions(secret_id, revision) ON DELETE RESTRICT
);
