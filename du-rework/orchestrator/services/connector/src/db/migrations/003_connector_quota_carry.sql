ALTER TABLE connector_invocations
  ADD COLUMN IF NOT EXISTS quota_lease_key TEXT,
  ADD COLUMN IF NOT EXISTS quota_lease_id TEXT,
  ADD COLUMN IF NOT EXISTS quota_lease_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS connector_invocations_quota_lease_expiry_idx
  ON connector_invocations (quota_lease_expires_at)
  WHERE quota_lease_id IS NOT NULL;
