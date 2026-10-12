-- Durable per-replica drain/resume fence used by the isolated host runner.
-- A command is acknowledged only after its control revision is persisted. The
-- invocation claim transaction locks this row before inserting new work.
CREATE TABLE IF NOT EXISTS connector_replica_runtime_controls (
  replica_id TEXT PRIMARY KEY CHECK (replica_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  slot TEXT NOT NULL CHECK (slot IN ('blue','green')),
  runtime_identity TEXT NOT NULL CHECK (runtime_identity ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  revision TEXT NOT NULL CHECK (length(revision) BETWEEN 1 AND 128),
  image_digest TEXT NOT NULL CHECK (image_digest ~ '^.+@sha256:[a-f0-9]{64}$'),
  control_revision BIGINT NOT NULL CHECK (control_revision >= 1),
  control_state TEXT NOT NULL CHECK (control_state IN ('OPEN','DRAINING')),
  requested_at TIMESTAMPTZ NOT NULL,
  acknowledged_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (slot, replica_id)
);

-- The owner is assigned from the Connector process's boot-pinned replica ID,
-- never from invocation input. Legacy rows remain NULL and are counted as
-- unresolved by every replica until they reach a terminal state.
ALTER TABLE connector_invocations
  ADD COLUMN IF NOT EXISTS owner_replica_id TEXT;

CREATE INDEX IF NOT EXISTS connector_invocations_replica_unresolved
  ON connector_invocations (owner_replica_id, state)
  WHERE state IN ('IN_FLIGHT','PENDING','POLLING','UNKNOWN');
