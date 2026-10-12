-- ORV14-HOST: a distinct durable snapshot barrier. Snapshot writers lock the
-- singleton FOR SHARE as their first transaction lock; backup activation takes
-- FOR UPDATE and keeps the gate HELD until all protected captures are complete.
CREATE TABLE IF NOT EXISTS maintenance_backup_effect_gate (
  singleton_id SMALLINT PRIMARY KEY CHECK (singleton_id = 1),
  state TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','HELD','UNKNOWN')),
  fence_id UUID,
  fence_revision BIGINT NOT NULL DEFAULT 0 CHECK (fence_revision >= 0),
  backup_id UUID,
  maintenance_job_id UUID,
  owner_item_id TEXT,
  owner_runtime_identity TEXT,
  owner_boot_id UUID,
  owner_execution_fence BIGINT,
  execution_token_sha256 TEXT CHECK (execution_token_sha256 IS NULL OR execution_token_sha256 ~ '^[a-f0-9]{64}$'),
  last_fence_id UUID,
  last_execution_token_sha256 TEXT CHECK (last_execution_token_sha256 IS NULL OR last_execution_token_sha256 ~ '^[a-f0-9]{64}$'),
  last_owner_runtime_identity TEXT,
  last_owner_boot_id UUID,
  last_maintenance_job_id UUID,
  last_owner_item_id TEXT,
  last_owner_execution_fence BIGINT,
  prior_control_states JSONB,
  requested_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((state = 'OPEN') = (fence_id IS NULL)),
  CHECK ((state = 'OPEN') = (execution_token_sha256 IS NULL)),
  CHECK ((state = 'OPEN') = (owner_item_id IS NULL)),
  CHECK ((state = 'OPEN') = (owner_execution_fence IS NULL)),
  CHECK ((state = 'OPEN') = (maintenance_job_id IS NULL)),
  CHECK ((state = 'OPEN') = (owner_runtime_identity IS NULL)),
  CHECK ((state = 'OPEN') = (owner_boot_id IS NULL))
);
INSERT INTO maintenance_backup_effect_gate (singleton_id) VALUES (1)
  ON CONFLICT (singleton_id) DO NOTHING;

-- Every artifact or generation effect has a durable owner and stable replay
-- key. Capability identifiers are stored only as hashes; raw object locators
-- never enter this table or an Admin DTO.
CREATE TABLE IF NOT EXISTS maintenance_backup_artifact_effects (
  effect_id UUID PRIMARY KEY,
  effect_key_sha256 TEXT NOT NULL UNIQUE CHECK (effect_key_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  category TEXT NOT NULL CHECK (category IN (
    'grant-issue','ingestion-write','encrypted-upload','multipart-part',
    'multipart-complete','multipart-abort','metadata-mutation','artifact-delete',
    'generation-activation','storage-generation-test','cleanup'
  )),
  tenant_id UUID,
  artifact_id UUID,
  storage_generation_id UUID NOT NULL,
  object_key_sha256 TEXT CHECK (object_key_sha256 IS NULL OR object_key_sha256 ~ '^[a-f0-9]{64}$'),
  capability_kind TEXT CHECK (capability_kind IS NULL OR capability_kind IN ('presigned-put','multipart','internal')),
  capability_id_sha256 TEXT CHECK (capability_id_sha256 IS NULL OR capability_id_sha256 ~ '^[a-f0-9]{64}$'),
  capability_expires_at TIMESTAMPTZ,
  capability_state TEXT NOT NULL DEFAULT 'NOT_ISSUED' CHECK (capability_state IN ('NOT_ISSUED','OPEN','CLOSED')),
  owner_runtime_identity TEXT NOT NULL,
  owner_boot_id UUID NOT NULL,
  fence_revision BIGINT NOT NULL CHECK (fence_revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('PREPARED','ACTIVE','SETTLING','COMPLETED','CANCELLED','UNKNOWN')),
  object_version_id TEXT,
  object_sha256 TEXT CHECK (object_sha256 IS NULL OR object_sha256 ~ '^[a-f0-9]{64}$'),
  object_byte_size BIGINT CHECK (object_byte_size IS NULL OR object_byte_size >= 0),
  sidecar_version_id TEXT,
  sidecar_sha256 TEXT CHECK (sidecar_sha256 IS NULL OR sidecar_sha256 ~ '^[a-f0-9]{64}$'),
  sidecar_byte_size BIGINT CHECK (sidecar_byte_size IS NULL OR sidecar_byte_size >= 0),
  metadata_row_sha256 TEXT CHECK (metadata_row_sha256 IS NULL OR metadata_row_sha256 ~ '^[a-f0-9]{64}$'),
  reason_code TEXT,
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS maintenance_backup_artifact_effects_open
  ON maintenance_backup_artifact_effects (owner_runtime_identity, owner_boot_id, category, state)
  WHERE state IN ('PREPARED','ACTIVE','SETTLING','UNKNOWN');
CREATE INDEX IF NOT EXISTS maintenance_backup_artifact_effects_generation
  ON maintenance_backup_artifact_effects (storage_generation_id, state, capability_expires_at)
  WHERE state IN ('PREPARED','ACTIVE','SETTLING','UNKNOWN');

-- A direct upload capability can remain valid after its database grant is
-- complete. Snapshot evidence is per-backup and binds the capability to the
-- exact immutable artifact versions actually included, or records that an
-- incomplete artifact was excluded. It never asserts that expiry means idle.
CREATE TABLE IF NOT EXISTS maintenance_backup_capability_snapshots (
  backup_id UUID NOT NULL,
  effect_id UUID NOT NULL REFERENCES maintenance_backup_artifact_effects(effect_id),
  disposition TEXT NOT NULL CHECK (disposition IN ('INCLUDED_EXACT_VERSION','EXCLUDED_INCOMPLETE')),
  artifact_state TEXT NOT NULL,
  storage_generation_id UUID,
  storage_version_id TEXT,
  manifest_version_id TEXT,
  proof_sha256 TEXT NOT NULL CHECK (proof_sha256 ~ '^[a-f0-9]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (backup_id,effect_id),
  CHECK (disposition<>'INCLUDED_EXACT_VERSION' OR (storage_generation_id IS NOT NULL AND storage_version_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS maintenance_backup_capability_snapshots_effect
  ON maintenance_backup_capability_snapshots (effect_id,backup_id);

-- A remote Connector fence command is durably staged before HTTP is sent. If
-- the response is lost, the same command/revision can be replayed without
-- guessing whether the remote HOLD or RELEASE took effect.
CREATE TABLE IF NOT EXISTS maintenance_backup_connector_fences (
  fence_id UUID NOT NULL,
  backup_id UUID NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('blue','green')),
  service_id TEXT NOT NULL,
  replica_id TEXT NOT NULL,
  runtime_identity TEXT NOT NULL,
  runtime_revision TEXT NOT NULL,
  image_digest TEXT NOT NULL CHECK (image_digest ~ '^.+@sha256:[a-f0-9]{64}$'),
  expected_fence_revision BIGINT NOT NULL CHECK (expected_fence_revision >= 0),
  fence_revision BIGINT NOT NULL CHECK (fence_revision > 0),
  maintenance_job_id UUID NOT NULL,
  maintenance_item_id TEXT NOT NULL,
  maintenance_execution_fence BIGINT NOT NULL CHECK (maintenance_execution_fence > 0),
  owner_runtime_identity TEXT NOT NULL,
  owner_boot_id UUID NOT NULL,
  execution_token_sha256 TEXT NOT NULL CHECK (execution_token_sha256 ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('PREPARED','HELD','RELEASED','UNKNOWN')),
  remote_boot_id UUID,
  acknowledged_at TIMESTAMPTZ,
  observed_at TIMESTAMPTZ,
  work_observed_at TIMESTAMPTZ,
  work_counts JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (fence_id,replica_id),
  UNIQUE (fence_id,slot)
);
CREATE INDEX IF NOT EXISTS maintenance_backup_connector_fences_state
  ON maintenance_backup_connector_fences (backup_id,state,updated_at);

-- Every maintenance side effect is bound to the exact process boot and claim.
-- Raw execution tokens are never persisted; stale/restarted executors cannot
-- acquire or release a backup fence with only a reused job identity.
ALTER TABLE maintenance_job_items
  ADD COLUMN IF NOT EXISTS owner_boot_id UUID,
  ADD COLUMN IF NOT EXISTS backup_execution_token_sha256 TEXT
    CHECK (backup_execution_token_sha256 IS NULL OR backup_execution_token_sha256 ~ '^[a-f0-9]{64}$');
CREATE INDEX IF NOT EXISTS maintenance_job_items_owner_claim_idx
  ON maintenance_job_items (job_id,item_id,owner_runtime_identity,owner_boot_id,execution_fence)
  WHERE status='RUNNING';

ALTER TABLE maintenance_restore_attempts
  ADD COLUMN IF NOT EXISTS owner_boot_id UUID,
  ADD COLUMN IF NOT EXISTS execution_token_sha256 TEXT
    CHECK (execution_token_sha256 IS NULL OR execution_token_sha256 ~ '^[a-f0-9]{64}$');

-- A worker must echo the exact backup-fence revision before its heartbeat is
-- counted as an acknowledgement. Missing/stale heartbeats remain unknown.
ALTER TABLE worker_instances
  ADD COLUMN IF NOT EXISTS backup_effect_fence_revision BIGINT,
  ADD COLUMN IF NOT EXISTS backup_effect_fence_observed_at TIMESTAMPTZ;

