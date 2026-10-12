-- Monotonic source version for authenticated administrative recovery reads.
-- The trigger covers every future state/progress update without relying on
-- callers to remember to increment a version column.
ALTER TABLE connector_invocations
  ADD COLUMN IF NOT EXISTS state_version BIGINT NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION connector_bump_invocation_state_version()
RETURNS TRIGGER AS $$
BEGIN
  NEW.state_version := OLD.state_version + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS connector_invocations_bump_state_version ON connector_invocations;
CREATE TRIGGER connector_invocations_bump_state_version
  BEFORE UPDATE ON connector_invocations
  FOR EACH ROW EXECUTE FUNCTION connector_bump_invocation_state_version();
