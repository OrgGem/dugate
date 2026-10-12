-- UI13-COMPOSE: durable, host-scoped desired state, previews and jobs.
-- The host runner publishes only validated, redacted catalog/observation DTOs.

CREATE TABLE IF NOT EXISTS compose_host_snapshots (
  host_id text PRIMARY KEY,
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  sampled_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS compose_target_state (
  host_id text NOT NULL,
  project_id text NOT NULL,
  target_revision bigint NOT NULL DEFAULT 0 CHECK (target_revision >= 0),
  desired_release_id text,
  active_job_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (host_id, project_id)
);

CREATE TABLE IF NOT EXISTS compose_project_snapshots (
  host_id text NOT NULL REFERENCES compose_host_snapshots(host_id) ON DELETE CASCADE,
  project_id text NOT NULL,
  display_name text NOT NULL,
  catalog_revision text NOT NULL CHECK (catalog_revision ~ '^[a-f0-9]{64}$'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  sampled_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  observed_digest text NOT NULL CHECK (observed_digest ~ '^[a-f0-9]{64}$'),
  services jsonb NOT NULL,
  releases jsonb NOT NULL,
  observed_services jsonb NOT NULL,
  PRIMARY KEY (host_id, project_id)
);

CREATE TABLE IF NOT EXISTS compose_previews (
  preview_id uuid PRIMARY KEY,
  host_id text NOT NULL,
  project_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('apply_release', 'rollback_release', 'restart_service')),
  release_id text,
  service_id text,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  actor_label text NOT NULL CHECK (length(actor_label) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  observed_digest text NOT NULL CHECK (observed_digest ~ '^[a-f0-9]{64}$'),
  expected_target_revision bigint NOT NULL CHECK (expected_target_revision >= 0),
  target_services jsonb NOT NULL,
  target_release_digest text CHECK (target_release_digest IS NULL OR target_release_digest ~ '^[a-f0-9]{64}$'),
  impact jsonb NOT NULL,
  warnings jsonb NOT NULL,
  consumed_at timestamptz,
  CHECK ((action IN ('apply_release', 'rollback_release') AND release_id IS NOT NULL AND service_id IS NULL)
      OR (action = 'restart_service' AND release_id IS NULL AND service_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS compose_previews_target_idx
  ON compose_previews(host_id, project_id, created_at DESC, preview_id DESC);

CREATE TABLE IF NOT EXISTS compose_jobs (
  job_id uuid PRIMARY KEY,
  preview_id uuid NOT NULL REFERENCES compose_previews(preview_id),
  host_id text NOT NULL,
  project_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('apply_release', 'rollback_release', 'restart_service')),
  release_id text,
  service_id text,
  target_release_digest text CHECK (target_release_digest IS NULL OR target_release_digest ~ '^[a-f0-9]{64}$'),
  target_services jsonb NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  actor_label text NOT NULL CHECK (length(actor_label) BETWEEN 1 AND 128),
  idempotency_scope text NOT NULL,
  idempotency_key_hash text NOT NULL CHECK (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('QUEUED', 'CLAIMED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL', 'UNKNOWN', 'RECONCILED')),
  state_version integer NOT NULL DEFAULT 1 CHECK (state_version > 0),
  expected_target_revision bigint NOT NULL CHECK (expected_target_revision >= 0),
  target_revision bigint NOT NULL CHECK (target_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  claim_expires_at timestamptz,
  execution_token_hash text CHECK (execution_token_hash IS NULL OR execution_token_hash ~ '^[a-f0-9]{64}$'),
  observed_before_digest text NOT NULL CHECK (observed_before_digest ~ '^[a-f0-9]{64}$'),
  start_expected_observed_digest text NOT NULL CHECK (start_expected_observed_digest ~ '^[a-f0-9]{64}$'),
  observed_before jsonb NOT NULL,
  observed_after jsonb,
  observed_after_digest text CHECK (observed_after_digest IS NULL OR observed_after_digest ~ '^[a-f0-9]{64}$'),
  per_service_outcomes jsonb NOT NULL DEFAULT '[]'::jsonb,
  completion_report_hash text CHECK (completion_report_hash IS NULL OR completion_report_hash ~ '^[a-f0-9]{64}$'),
  completion_ack jsonb,
  reconcile_report_hash text CHECK (reconcile_report_hash IS NULL OR reconcile_report_hash ~ '^[a-f0-9]{64}$'),
  reconcile_ack jsonb,
  uncertain_reason text CHECK (uncertain_reason IS NULL OR uncertain_reason IN ('CLAIM_EXPIRED', 'START_ACK_LOST', 'RUNNER_LOST', 'REPORT_LOST', 'EXECUTOR_TIMEOUT', 'EXECUTION_UNCERTAIN')),
  UNIQUE (idempotency_scope, idempotency_key_hash),
  CHECK ((action IN ('apply_release', 'rollback_release') AND release_id IS NOT NULL AND service_id IS NULL)
      OR (action = 'restart_service' AND release_id IS NULL AND service_id IS NOT NULL)),
  CHECK ((state = 'UNKNOWN') = (uncertain_reason IS NOT NULL) OR state = 'RECONCILED')
);
CREATE INDEX IF NOT EXISTS compose_jobs_target_history_idx
  ON compose_jobs(host_id, project_id, created_at DESC, job_id DESC);
CREATE INDEX IF NOT EXISTS compose_jobs_claim_idx
  ON compose_jobs(host_id, created_at ASC, job_id ASC) WHERE state = 'QUEUED';
CREATE INDEX IF NOT EXISTS compose_jobs_expired_claim_idx
  ON compose_jobs(host_id, claim_expires_at) WHERE state IN ('CLAIMED', 'RUNNING');

