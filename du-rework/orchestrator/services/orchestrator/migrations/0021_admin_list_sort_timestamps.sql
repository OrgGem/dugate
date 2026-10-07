-- ADM-UX-02 sortable admin resources. Preserve original creation time as the
-- initial update time, then maintain updated_at on mutable resource changes.
ALTER TABLE business_versions ADD COLUMN IF NOT EXISTS updated_at timestamptz;
UPDATE business_versions SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE business_versions ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE business_versions ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS updated_at timestamptz;
UPDATE api_keys SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE api_keys ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE api_keys ALTER COLUMN updated_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS business_versions_created_keyset_idx
  ON business_versions (created_at DESC, business_id DESC, version DESC);
CREATE INDEX IF NOT EXISTS business_versions_updated_keyset_idx
  ON business_versions (updated_at DESC, business_id DESC, version DESC);
CREATE INDEX IF NOT EXISTS business_versions_business_created_keyset_idx
  ON business_versions (business_id, created_at DESC, version DESC);
CREATE INDEX IF NOT EXISTS business_versions_business_updated_keyset_idx
  ON business_versions (business_id, updated_at DESC, version DESC);

CREATE INDEX IF NOT EXISTS api_keys_tenant_created_keyset_idx
  ON api_keys (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS api_keys_tenant_updated_keyset_idx
  ON api_keys (tenant_id, updated_at DESC, id DESC);
