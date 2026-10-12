-- ORV14-HA-06: backup has a separate effect barrier from normal replica drain.
-- The singleton row is the transaction mutex shared by admission, provider,
-- poll and usage permits. Expired owners are intentionally never reclaimed as
-- proof of completion.
CREATE TABLE IF NOT EXISTS connector_backup_effect_gate (
  singleton_id smallint PRIMARY KEY CHECK (singleton_id = 1),
  fence_id uuid,
  fence_revision bigint NOT NULL DEFAULT 0 CHECK (fence_revision >= 0),
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','HELD','UNKNOWN')),
  backup_id text,
  maintenance_job_id uuid,
  maintenance_item_id text,
  maintenance_execution_fence bigint CHECK (maintenance_execution_fence IS NULL OR maintenance_execution_fence > 0),
  owner_runtime_identity text,
  owner_boot_id uuid,
  execution_token_sha256 text CHECK (execution_token_sha256 IS NULL OR execution_token_sha256 ~ '^[a-f0-9]{64}$'),
  last_fence_id uuid,
  last_execution_token_sha256 text CHECK (last_execution_token_sha256 IS NULL OR last_execution_token_sha256 ~ '^[a-f0-9]{64}$'),
  last_owner_runtime_identity text,
  last_owner_boot_id uuid,
  last_maintenance_job_id uuid,
  last_maintenance_item_id text,
  last_maintenance_execution_fence bigint,
  requested_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'OPEN') = (fence_id IS NULL)),
  CHECK ((state = 'OPEN') = (execution_token_sha256 IS NULL))
);
INSERT INTO connector_backup_effect_gate (singleton_id) VALUES (1) ON CONFLICT (singleton_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS connector_backup_effect_acknowledgements (
  fence_id uuid NOT NULL,
  fence_revision bigint NOT NULL CHECK (fence_revision > 0),
  replica_id text NOT NULL,
  runtime_identity text NOT NULL,
  boot_id uuid NOT NULL,
  acknowledged_at timestamptz NOT NULL,
  PRIMARY KEY (fence_id, replica_id, boot_id)
);
CREATE INDEX IF NOT EXISTS connector_backup_effect_ack_revision
  ON connector_backup_effect_acknowledgements (fence_id, fence_revision, acknowledged_at);

CREATE TABLE IF NOT EXISTS connector_backup_effect_permits (
  effect_id uuid PRIMARY KEY,
  domain text NOT NULL CHECK (domain IN ('provider','poll','usage','artifact','dispatch','admission','config')),
  operation_id text,
  invocation_id text,
  event_id text,
  owner_replica_id text NOT NULL,
  owner_runtime_identity text NOT NULL,
  owner_boot_id uuid NOT NULL,
  owner_token uuid NOT NULL,
  fence_revision bigint NOT NULL CHECK (fence_revision >= 0),
  state text NOT NULL CHECK (state IN ('PREPARED','ACTIVE','SETTLING','COMPLETED','CANCELLED','UNKNOWN')),
  reason_code text,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  settled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(invocation_id,event_id) <= 1)
);
CREATE INDEX IF NOT EXISTS connector_backup_effect_open_owner
  ON connector_backup_effect_permits (owner_replica_id, owner_boot_id, domain, state)
  WHERE state IN ('PREPARED','ACTIVE','SETTLING','UNKNOWN');
CREATE INDEX IF NOT EXISTS connector_backup_effect_open_fence
  ON connector_backup_effect_permits (fence_revision, state)
  WHERE state IN ('PREPARED','ACTIVE','SETTLING','UNKNOWN');
CREATE UNIQUE INDEX IF NOT EXISTS connector_backup_effect_live_token
  ON connector_backup_effect_permits (owner_token)
  WHERE state IN ('PREPARED','ACTIVE','SETTLING','UNKNOWN');

ALTER TABLE connector_invocations
  ADD COLUMN IF NOT EXISTS provider_effect_id uuid,
  ADD COLUMN IF NOT EXISTS poll_effect_id uuid;

-- A delivery claim is durable across the network send and settlement. Expired
-- leases stay claimed; another replica cannot interpret expiry as a lost send.
ALTER TABLE connector_usage_outbox
  ADD COLUMN IF NOT EXISTS delivery_owner_replica_id text,
  ADD COLUMN IF NOT EXISTS delivery_owner_runtime_identity text,
  ADD COLUMN IF NOT EXISTS delivery_owner_boot_id uuid,
  ADD COLUMN IF NOT EXISTS delivery_claim_token uuid,
  ADD COLUMN IF NOT EXISTS delivery_lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_effect_id uuid,
  ADD COLUMN IF NOT EXISTS delivery_state text NOT NULL DEFAULT 'READY'
    CHECK (delivery_state IN ('READY','CLAIMED','SENDING','UNKNOWN','DELIVERED')),
  ADD COLUMN IF NOT EXISTS delivery_updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS connector_usage_outbox_claimable
  ON connector_usage_outbox (next_attempt_at, created_at)
  WHERE delivered_at IS NULL AND delivery_claim_token IS NULL AND delivery_state = 'READY';
CREATE INDEX IF NOT EXISTS connector_usage_outbox_uncertain
  ON connector_usage_outbox (delivery_owner_replica_id, delivery_state)
  WHERE delivered_at IS NULL AND delivery_state IN ('CLAIMED','SENDING','UNKNOWN');

-- The tenant-scoped metadata catalog uses a stable HMAC key for opaque
-- pagination cursors. The key is created lazily by the repository only while
-- the backup configuration gate is OPEN; cursor contents never include secrets.
CREATE TABLE IF NOT EXISTS connector_tenant_catalog_cursor_key (
  singleton_id smallint PRIMARY KEY CHECK (singleton_id = 1),
  key_bytes bytea NOT NULL CHECK (octet_length(key_bytes) = 32),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The exact draft intent points at its cross-process config-effect permit.
-- A pending credential write can therefore remain PREPARED/ACTIVE/UNKNOWN
-- across request retries and cannot be hidden by an HTTP handler restart.
ALTER TABLE connector_parity_draft_intents
  ADD COLUMN IF NOT EXISTS backup_effect_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='connector_parity_draft_backup_effect_fk') THEN
    ALTER TABLE connector_parity_draft_intents
      ADD CONSTRAINT connector_parity_draft_backup_effect_fk
      FOREIGN KEY (backup_effect_id) REFERENCES connector_backup_effect_permits(effect_id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS connector_parity_draft_backup_effect
  ON connector_parity_draft_intents (backup_effect_id)
  WHERE backup_effect_id IS NOT NULL;
