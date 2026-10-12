-- Exact idempotent acknowledgements for tenant-scoped typed recipe retirement.
-- The recipe and credential pins remain in connector_parity_revisions; this
-- table records only the CAS request identity and terminal reply.
CREATE TABLE IF NOT EXISTS connector_parity_retire_intents (
  tenant_id UUID NOT NULL,
  connector_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  reason TEXT NOT NULL CHECK (reason IN ('OPERATOR_RETIRE','LEGACY_DISABLED_IMPORT','PROFILE_UNBOUND')),
  retired BOOLEAN NOT NULL,
  current_revision INTEGER CHECK (current_revision IS NULL OR current_revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connector_id, idempotency_key),
  FOREIGN KEY (connector_id, tenant_id)
    REFERENCES connector_parity_chains (connector_id, tenant_id)
);
