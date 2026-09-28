-- P2-07 artifacts + invocation grants (already referenced by server.ts slice).
-- Adds a blob store (local file in OUTPUT_DIR) plus grant token columns; artifacts
-- table from 0001 already exists. Adds invocation_grants ledger and operation
-- cancel/deadline columns.

-- Local blob store rooted at $DU_OUTPUT_DIR (default ./outputs). The storage_key
-- is a path-relative fragment; we persist it so access can resolve the file.
CREATE TABLE IF NOT EXISTS artifact_blobs (
  storage_key   text PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  bytes         bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Issued Connector invocation grants (P2-07). The signed token is returned to the
-- worker; the row lets the platform idempotently re-issue and audit.
CREATE TABLE IF NOT EXISTS invocation_grants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id        uuid NOT NULL REFERENCES tasks(id),
  step_key       text NOT NULL,
  operation_id   uuid NOT NULL REFERENCES operations(id),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  business_id    text NOT NULL,
  connector_id   text NOT NULL,
  connector_revision integer NOT NULL,
  binding_slot   text NOT NULL,
  invocation_id  text NOT NULL,
  input_hash     text NOT NULL,
  grant_token    text NOT NULL,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, step_key, invocation_id)
);
CREATE INDEX IF NOT EXISTS invocation_grants_task ON invocation_grants (task_id, step_key);

-- Operation cancel requested flag (P2-06). cancel sweeper flips task/operation state.
ALTER TABLE operations ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false;
