CREATE TABLE IF NOT EXISTS connector_revisions (
  connector_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  adapter TEXT NOT NULL,
  config JSONB NOT NULL,
  credential_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_id, revision)
);

CREATE TABLE IF NOT EXISTS secret_versions (
  id TEXT PRIMARY KEY,
  credential_ref TEXT NOT NULL,
  encrypted_value BYTEA NOT NULL,
  rotated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS secret_versions_active_idx
  ON secret_versions (credential_ref, rotated_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS connector_invocations (
  invocation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  request JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('IN_FLIGHT', 'PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED')),
  result JSONB,
  error_code TEXT,
  provider_request_id TEXT,
  next_poll_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS connector_invocations_state_idx
  ON connector_invocations (state, updated_at);

CREATE TABLE IF NOT EXISTS connector_usage_outbox (
  event_id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL REFERENCES connector_invocations(invocation_id),
  payload JSONB NOT NULL,
  delivered_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS connector_usage_outbox_due_idx
  ON connector_usage_outbox (next_attempt_at)
  WHERE delivered_at IS NULL;
