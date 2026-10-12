-- ORV14 durable maintenance, immutable storage generations and admission control.

CREATE SEQUENCE IF NOT EXISTS runtime_control_revision_seq AS bigint;

CREATE TABLE IF NOT EXISTS runtime_control_scopes (
  scope_kind text NOT NULL CHECK (scope_kind IN ('platform', 'tenant', 'business')),
  scope_id text NOT NULL,
  desired_state text NOT NULL CHECK (desired_state IN ('OPEN', 'PAUSED', 'DRAINING')),
  revision bigint NOT NULL,
  reason text NOT NULL,
  actor text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_kind, scope_id)
);

INSERT INTO runtime_control_scopes (scope_kind, scope_id, desired_state, revision, reason, actor)
VALUES ('platform', 'all', 'OPEN', nextval('runtime_control_revision_seq'), 'initial control state', 'system')
ON CONFLICT (scope_kind, scope_id) DO NOTHING;

ALTER TABLE worker_instances
  ADD COLUMN IF NOT EXISTS control_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS control_state text NOT NULL DEFAULT 'OPEN'
    CHECK (control_state IN ('OPEN', 'PAUSED', 'DRAINING')),
  ADD COLUMN IF NOT EXISTS desired_control_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS desired_control_state text NOT NULL DEFAULT 'OPEN'
    CHECK (desired_control_state IN ('OPEN', 'PAUSED', 'DRAINING')),
  ADD COLUMN IF NOT EXISTS image_digest text,
  ADD COLUMN IF NOT EXISTS deployment_revision text,
  ADD COLUMN IF NOT EXISTS active_task_count integer CHECK (active_task_count IS NULL OR active_task_count >= 0),
  ADD COLUMN IF NOT EXISTS active_task_observed_at timestamptz;

CREATE INDEX IF NOT EXISTS worker_instances_control_observation_idx
  ON worker_instances (business_id, control_revision, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS worker_instances_desired_control_idx
  ON worker_instances (business_id, desired_control_state, desired_control_revision);

-- Preserve exact scope acknowledgements separately from the worker's
-- aggregate control state. A tenant pause must not turn the whole shared
-- business worker into DRAINING, and a business pause must not masquerade as
-- a platform acknowledgement.
CREATE TABLE IF NOT EXISTS worker_control_scope_acks (
  business_id text NOT NULL,
  instance_id text NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('platform', 'tenant', 'business')),
  scope_id text NOT NULL,
  control_revision bigint NOT NULL,
  control_state text NOT NULL CHECK (control_state IN ('OPEN', 'PAUSED', 'DRAINING')),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (business_id, instance_id, scope_kind, scope_id),
  FOREIGN KEY (business_id, instance_id) REFERENCES worker_instances(business_id, instance_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS worker_control_scope_acks_observed_idx
  ON worker_control_scope_acks (scope_kind, scope_id, control_revision, observed_at DESC);

CREATE TABLE IF NOT EXISTS storage_generations (
  generation_id uuid PRIMARY KEY,
  revision bigint NOT NULL UNIQUE,
  backend text NOT NULL CHECK (backend IN ('postgres', 's3')),
  endpoint text NOT NULL,
  bucket text NOT NULL DEFAULT '',
  region text NOT NULL,
  force_path_style boolean NOT NULL DEFAULT false,
  credential_version_ref text,
  credential_owner_tenant_id uuid,
  url_ttl_seconds integer,
  state text NOT NULL CHECK (state IN ('STAGED', 'ACTIVE', 'RETIRED', 'FAILED')),
  tested_at timestamptz,
  test_result jsonb,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CHECK (url_ttl_seconds IS NULL OR url_ttl_seconds BETWEEN 1 AND 86400),
  CHECK ((backend = 's3' AND length(bucket) > 0 AND credential_version_ref ~ '^[A-Za-z0-9._:/-]+@[1-9][0-9]*$' AND credential_owner_tenant_id IS NOT NULL)
      OR (backend = 'postgres' AND bucket = '' AND credential_version_ref IS NULL AND credential_owner_tenant_id IS NULL))
);

ALTER TABLE storage_generations
  ADD COLUMN IF NOT EXISTS credential_owner_tenant_id uuid;

ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS storage_generation_id uuid REFERENCES storage_generations(generation_id);

CREATE TABLE IF NOT EXISTS storage_generation_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active_generation_id uuid NOT NULL REFERENCES storage_generations(generation_id),
  revision bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage_generation_tests (
  test_id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  request_hash text NOT NULL,
  generation_id uuid NOT NULL REFERENCES storage_generations(generation_id),
  state text NOT NULL CHECK (state IN ('RUNNING', 'PASSED', 'FAILED', 'UNKNOWN')),
  probe_object_key text NOT NULL,
  probe_sidecar_key text NOT NULL,
  object_sha256 text,
  object_size_bytes integer,
  sidecar_sha256 text,
  sidecar_size_bytes integer,
  object_version_id text,
  sidecar_version_id text,
  result jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS storage_generation_tests_resume_idx
  ON storage_generation_tests (state, started_at);

CREATE TABLE IF NOT EXISTS maintenance_previews (
  preview_id uuid PRIMARY KEY,
  kind text NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('platform', 'tenant', 'business')),
  scope_id text NOT NULL,
  request jsonb NOT NULL,
  expected_version text NOT NULL,
  retention_revision bigint,
  retention_snapshot jsonb,
  candidates jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  created_by text NOT NULL,
  state text NOT NULL DEFAULT 'PREVIEWED' CHECK (state IN ('PREVIEWED', 'CONSUMED', 'EXPIRED')),
  job_id uuid
);

CREATE INDEX IF NOT EXISTS maintenance_previews_expiry_idx
  ON maintenance_previews (state, expires_at);

CREATE TABLE IF NOT EXISTS maintenance_jobs (
  job_id uuid PRIMARY KEY,
  preview_id uuid NOT NULL UNIQUE REFERENCES maintenance_previews(preview_id),
  idempotency_key text NOT NULL UNIQUE,
  request_hash text NOT NULL,
  kind text NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('platform', 'tenant', 'business')),
  scope_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'UNKNOWN')),
  reason text NOT NULL,
  actor text NOT NULL,
  total_items integer NOT NULL DEFAULT 0,
  completed_items integer NOT NULL DEFAULT 0,
  applied_items integer NOT NULL DEFAULT 0,
  skipped_items integer NOT NULL DEFAULT 0,
  failed_items integer NOT NULL DEFAULT 0,
  unknown_items integer NOT NULL DEFAULT 0,
  cursor integer NOT NULL DEFAULT 0,
  last_error_code text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS maintenance_jobs_resume_idx
  ON maintenance_jobs (state, created_at);

CREATE TABLE IF NOT EXISTS maintenance_backup_bundles (
  backup_id uuid PRIMARY KEY,
  target_name text NOT NULL,
  scope jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('CREATING', 'READY', 'FAILED', 'UNKNOWN')),
  bundle_ref text,
  bundle_sha256 text,
  byte_size bigint,
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (bundle_sha256 IS NULL OR bundle_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (byte_size IS NULL OR byte_size >= 0)
);

CREATE INDEX IF NOT EXISTS maintenance_backup_bundles_scope_idx
  ON maintenance_backup_bundles (target_name, created_at DESC);

CREATE TABLE IF NOT EXISTS maintenance_job_items (
  job_id uuid NOT NULL REFERENCES maintenance_jobs(job_id) ON DELETE CASCADE,
  item_id text NOT NULL,
  item_type text NOT NULL CHECK (item_type IN ('artifact', 'task', 'delivery', 'backup', 'restore-target', 'replica')),
  ordinal integer NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'APPLIED', 'SKIPPED', 'FAILED', 'UNKNOWN')),
  code text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, item_id)
);

CREATE INDEX IF NOT EXISTS maintenance_job_items_pending_idx
  ON maintenance_job_items (job_id, ordinal) WHERE status = 'PENDING';

ALTER TABLE maintenance_job_items
  ADD COLUMN IF NOT EXISTS claim_until timestamptz,
  ADD COLUMN IF NOT EXISTS owner_runtime_identity text,
  ADD COLUMN IF NOT EXISTS execution_fence bigint NOT NULL DEFAULT 0;

-- A restore writes only an explicitly isolated pair of databases and a new
-- storage generation. The unique target key prevents a retry from replaying
-- partially completed external effects after a crash or lost owner lease.
CREATE TABLE IF NOT EXISTS maintenance_restore_attempts (
  backup_id uuid NOT NULL,
  target_generation_id uuid NOT NULL,
  job_id uuid NOT NULL,
  item_id text NOT NULL,
  owner_runtime_identity text NOT NULL,
  execution_fence bigint NOT NULL CHECK (execution_fence > 0),
  state text NOT NULL CHECK (state IN ('RUNNING','UNKNOWN','SUCCEEDED')),
  result jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (backup_id,target_generation_id),
  UNIQUE (job_id,item_id,execution_fence),
  FOREIGN KEY (job_id,item_id) REFERENCES maintenance_job_items(job_id,item_id) ON DELETE CASCADE,
  CHECK ((state='SUCCEEDED') = (result IS NOT NULL)),
  CHECK ((state='SUCCEEDED') = (completed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS maintenance_restore_attempts_state_idx
  ON maintenance_restore_attempts (state,updated_at);

CREATE TABLE IF NOT EXISTS queue_action_jobs (
  job_id uuid PRIMARY KEY,
  preview_id uuid NOT NULL UNIQUE REFERENCES maintenance_previews(preview_id),
  idempotency_key text NOT NULL UNIQUE,
  request_hash text NOT NULL,
  action text NOT NULL CHECK (action IN ('pause', 'drain', 'resume', 'retry')),
  queue_name text NOT NULL,
  scope jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'UNKNOWN')),
  control_revision bigint NOT NULL,
  active_leases integer NOT NULL DEFAULT 0,
  fresh_workers integer NOT NULL DEFAULT 0,
  expected_acks integer NOT NULL DEFAULT 0,
  observed_acks integer NOT NULL DEFAULT 0,
  eligible_deliveries integer NOT NULL DEFAULT 0,
  skipped_deliveries integer NOT NULL DEFAULT 0,
  unknown_deliveries integer NOT NULL DEFAULT 0,
  reason text NOT NULL,
  actor text NOT NULL,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS queue_action_jobs_resume_idx
  ON queue_action_jobs (state, created_at);

CREATE TABLE IF NOT EXISTS replica_rollout_previews (
  preview_id uuid PRIMARY KEY,
  service text NOT NULL CHECK (service IN ('orchestrator', 'connector', 'worker')),
  desired_revision text NOT NULL,
  scope jsonb NOT NULL,
  strategy text NOT NULL CHECK (strategy IN ('two_slot', 'per_replica')),
  expected_version text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_by text NOT NULL,
  candidate_runtime_identity text,
  created_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'PREVIEWED' CHECK (state IN ('PREVIEWED', 'CONSUMED', 'EXPIRED'))
);

CREATE TABLE IF NOT EXISTS replica_rollout_jobs (
  job_id uuid PRIMARY KEY,
  preview_id uuid NOT NULL UNIQUE REFERENCES replica_rollout_previews(preview_id),
  idempotency_key text NOT NULL UNIQUE,
  request_hash text NOT NULL,
  service text NOT NULL CHECK (service IN ('orchestrator', 'connector', 'worker')),
  desired_revision text NOT NULL,
  phase text NOT NULL DEFAULT 'PREPARE' CHECK (phase IN ('PREPARE', 'CUTOVER', 'DONE')),
  candidate_runtime_identity text,
  owner_runtime_identity text,
  execution_fence bigint NOT NULL DEFAULT 0,
  state text NOT NULL CHECK (state IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'UNKNOWN')),
  old_ingress_target text,
  active_ingress_target text,
  rollback_state text NOT NULL DEFAULT 'NOT_REQUIRED'
    CHECK (rollback_state IN ('NOT_REQUIRED', 'PENDING', 'APPLIED', 'FAILED', 'UNKNOWN')),
  reason text NOT NULL,
  actor text NOT NULL,
  last_error_code text,
  version integer NOT NULL DEFAULT 1,
  claim_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

ALTER TABLE replica_rollout_previews
  ADD COLUMN IF NOT EXISTS candidate_runtime_identity text;
ALTER TABLE replica_rollout_jobs
  ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'PREPARE',
  ADD COLUMN IF NOT EXISTS candidate_runtime_identity text,
  ADD COLUMN IF NOT EXISTS owner_runtime_identity text,
  ADD COLUMN IF NOT EXISTS execution_fence bigint NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE replica_rollout_jobs ADD CONSTRAINT replica_rollout_jobs_phase_check
    CHECK (phase IN ('PREPARE', 'CUTOVER', 'DONE'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS replica_rollout_jobs_resume_idx
  ON replica_rollout_jobs (state, created_at);

CREATE TABLE IF NOT EXISTS replica_rollout_rollback_previews (
  preview_id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES replica_rollout_jobs(job_id),
  expected_version text NOT NULL,
  request jsonb NOT NULL,
  idempotency_key text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'PREVIEWED' CHECK (state IN ('PREVIEWED', 'CONSUMED', 'EXPIRED'))
);

ALTER TABLE replica_rollout_rollback_previews
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS replica_rollout_rollback_idempotency_idx
  ON replica_rollout_rollback_previews (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS replica_rollout_job_items (
  job_id uuid NOT NULL REFERENCES replica_rollout_jobs(job_id) ON DELETE CASCADE,
  replica_id text NOT NULL,
  slot text,
  desired_revision text NOT NULL,
  observed_revision text,
  state text NOT NULL CHECK (state IN ('PENDING', 'STARTING', 'READY', 'DRAINING', 'STOPPED', 'FAILED', 'UNKNOWN')),
  active_work integer,
  acknowledged_at timestamptz,
  code text,
  ordinal integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  owner_runtime_identity text,
  execution_fence bigint NOT NULL DEFAULT 0,
  claim_until timestamptz,
  PRIMARY KEY (job_id, replica_id)
);

ALTER TABLE replica_rollout_job_items
  ADD COLUMN IF NOT EXISTS owner_runtime_identity text,
  ADD COLUMN IF NOT EXISTS execution_fence bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claim_until timestamptz;
