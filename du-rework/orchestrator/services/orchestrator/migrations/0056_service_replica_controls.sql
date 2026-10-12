-- ORV14 service-owned Orchestrator readiness, drain control and in-flight
-- work accounting. Rows are intentionally retained across process boots:
-- unclosed request/dispatch records remain visible and block unsafe rollout.

CREATE TABLE IF NOT EXISTS orchestrator_service_runtimes (
  service_runtime_id text PRIMARY KEY,
  runtime_identity text NOT NULL,
  replica_id text NOT NULL,
  slot text NOT NULL CHECK (slot IN ('blue', 'green')),
  revision text NOT NULL,
  image_digest text NOT NULL CHECK (image_digest ~ '^.+@sha256:[a-fA-F0-9]{64}$'),
  boot_id uuid NOT NULL,
  desired_control_revision bigint NOT NULL,
  desired_control_state text NOT NULL CHECK (desired_control_state IN ('OPEN', 'PAUSED', 'DRAINING')),
  desired_reason text NOT NULL,
  desired_requested_at timestamptz NOT NULL DEFAULT now(),
  control_revision bigint NOT NULL DEFAULT 0,
  control_state text NOT NULL CHECK (control_state IN ('OPEN', 'PAUSED', 'DRAINING')),
  control_ack_boot_id uuid,
  control_acknowledged_at timestamptz,
  readiness_state text NOT NULL CHECK (readiness_state IN ('READY', 'DEGRADED', 'DRAINING', 'OFFLINE', 'UNKNOWN')),
  database_state text NOT NULL CHECK (database_state IN ('HEALTHY', 'UNAVAILABLE', 'UNKNOWN')),
  redis_state text NOT NULL CHECK (redis_state IN ('HEALTHY', 'UNAVAILABLE', 'UNKNOWN')),
  observed_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (runtime_identity, replica_id)
);

CREATE INDEX IF NOT EXISTS orchestrator_service_runtime_freshness_idx
  ON orchestrator_service_runtimes (last_seen_at DESC, readiness_state);

CREATE TABLE IF NOT EXISTS orchestrator_service_runtime_requests (
  request_id uuid PRIMARY KEY,
  service_runtime_id text NOT NULL REFERENCES orchestrator_service_runtimes(service_runtime_id),
  boot_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  completion_reason text CHECK (completion_reason IS NULL OR completion_reason IN ('finish', 'close'))
);

CREATE INDEX IF NOT EXISTS orchestrator_service_runtime_requests_active_idx
  ON orchestrator_service_runtime_requests (service_runtime_id, started_at)
  WHERE completed_at IS NULL;

CREATE TABLE IF NOT EXISTS orchestrator_service_runtime_dispatch_permits (
  permit_id uuid PRIMARY KEY,
  service_runtime_id text NOT NULL REFERENCES orchestrator_service_runtimes(service_runtime_id),
  boot_id uuid NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);

CREATE INDEX IF NOT EXISTS orchestrator_service_runtime_dispatch_active_idx
  ON orchestrator_service_runtime_dispatch_permits (service_runtime_id, acquired_at)
  WHERE released_at IS NULL;
