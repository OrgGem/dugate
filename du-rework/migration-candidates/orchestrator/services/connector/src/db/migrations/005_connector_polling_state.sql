ALTER TABLE connector_invocations
  DROP CONSTRAINT IF EXISTS connector_invocations_state_check;

ALTER TABLE connector_invocations
  ADD CONSTRAINT connector_invocations_state_check
  CHECK (state IN ('IN_FLIGHT', 'PENDING', 'POLLING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED'));

UPDATE connector_invocations
  SET state = 'POLLING'
  WHERE state = 'IN_FLIGHT'
    AND poll_lease_token IS NOT NULL;

DROP INDEX IF EXISTS connector_invocations_expired_poll_lease_idx;

CREATE INDEX connector_invocations_expired_poll_lease_idx
  ON connector_invocations (poll_lease_expires_at)
  WHERE state = 'POLLING' AND poll_lease_token IS NOT NULL;
