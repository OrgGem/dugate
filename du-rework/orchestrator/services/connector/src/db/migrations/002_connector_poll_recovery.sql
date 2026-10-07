ALTER TABLE connector_invocations
  ADD COLUMN IF NOT EXISTS poll_lease_token TEXT,
  ADD COLUMN IF NOT EXISTS poll_lease_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS connector_invocations_expired_poll_lease_idx
  ON connector_invocations (poll_lease_expires_at)
  WHERE state = 'IN_FLIGHT' AND poll_lease_token IS NOT NULL;
