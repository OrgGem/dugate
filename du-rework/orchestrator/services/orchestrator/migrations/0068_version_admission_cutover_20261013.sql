-- Group A runtime admission hardening. A business catalog row is the shared
-- transaction mutex for version activation, operation admission and new task
-- claims. Existing `business_versions.is_active` remains the single active
-- pointer and its partial unique index remains authoritative.

ALTER TABLE business_catalog
  ADD COLUMN IF NOT EXISTS activation_revision bigint NOT NULL DEFAULT 1
    CHECK (activation_revision > 0),
  ADD COLUMN IF NOT EXISTS submissions_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pre_drain_version text;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS admission_parked_reason text,
  ADD COLUMN IF NOT EXISTS admission_parked_at timestamptz;

ALTER TABLE outbox
  ADD COLUMN IF NOT EXISTS parked_reason text,
  ADD COLUMN IF NOT EXISTS parked_at timestamptz,
  ADD COLUMN IF NOT EXISTS claim_token text;

CREATE INDEX IF NOT EXISTS tasks_admission_parked_idx
  ON tasks (updated_at, id)
  WHERE admission_parked_reason IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_queue_integrity_cursor_idx
  ON tasks (created_at, id)
  WHERE state IN ('READY','QUEUED','RETRY_PENDING')
    AND admission_parked_reason IS NULL;

CREATE INDEX IF NOT EXISTS outbox_parked_dispatch_idx
  ON outbox (due_at, created_at, id)
  WHERE dispatched_at IS NULL AND parked_reason IS NOT NULL;

-- Keep an auditable revision trail next to the normal admin audit event. The
-- event table records the durable routing transition even if UI projections
-- are unavailable during a rollout.
CREATE TABLE IF NOT EXISTS business_version_activation_events (
  business_id text NOT NULL,
  activation_revision bigint NOT NULL CHECK (activation_revision > 0),
  expected_activation_revision bigint NOT NULL CHECK (expected_activation_revision > 0),
  action text NOT NULL CHECK (action IN (
    'ACTIVATED', 'DEACTIVATED', 'PRE_DRAIN_STARTED', 'PRE_DRAIN_CANCELLED',
    'BUSINESS_ENABLED', 'BUSINESS_DISABLED', 'VERSION_ENABLED'
  )),
  previous_version text,
  active_version text,
  affected_version text,
  actor text NOT NULL DEFAULT 'admin',
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (business_id, activation_revision)
);

-- Fair bounded queue-integrity scans across orchestrator replicas. The cursor
-- advances by (created_at,id), then wraps when it reaches the end.
CREATE TABLE IF NOT EXISTS queue_integrity_sweep_cursor (
  cursor_name text PRIMARY KEY,
  last_created_at timestamptz,
  last_task_id uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK ((last_created_at IS NULL) = (last_task_id IS NULL))
);

INSERT INTO queue_integrity_sweep_cursor (cursor_name)
VALUES ('runtime')
ON CONFLICT (cursor_name) DO NOTHING;
