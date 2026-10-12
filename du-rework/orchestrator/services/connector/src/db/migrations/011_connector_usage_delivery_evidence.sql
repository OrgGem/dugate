-- Real delivery retry evidence for tenant-fenced Connector signal snapshots.
ALTER TABLE connector_usage_outbox
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE connector_usage_outbox
  ADD COLUMN IF NOT EXISTS failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0);
ALTER TABLE connector_usage_outbox
  ADD COLUMN IF NOT EXISTS last_failure_code text;

CREATE INDEX IF NOT EXISTS connector_usage_outbox_tenant_created
  ON connector_usage_outbox (created_at, event_id);
