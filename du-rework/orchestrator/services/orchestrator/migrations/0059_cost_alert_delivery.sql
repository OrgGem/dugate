-- ORV14 COST-04 alert routing and durable owner inbox delivery. Budget policy remains
-- immutable in cost_budget_revisions; owner/channel changes are versioned in a
-- separate exact-revision binding. The only delivery target is the first-party
-- owner-scoped Admin inbox; no caller can supply a URL or credential.

CREATE TABLE IF NOT EXISTS cost_alert_channels (
  channel_id text NOT NULL
    CHECK (channel_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$'),
  channel_revision integer NOT NULL CHECK (channel_revision >= 1),
  kind text NOT NULL CHECK (kind = 'in-app'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  destination_label text NOT NULL CHECK (length(destination_label) BETWEEN 1 AND 120),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id,channel_revision)
);

INSERT INTO cost_alert_channels(channel_id,channel_revision,kind,display_name,destination_label,enabled)
VALUES ('tenant-admin-inbox-v1',1,'in-app','Tenant Admin inbox','Owner-scoped Admin inbox',true)
ON CONFLICT (channel_id,channel_revision) DO NOTHING;

CREATE OR REPLACE FUNCTION reject_cost_alert_channel_revision_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'cost alert channel revisions are immutable; add a new revision instead';
END;
$$;
DROP TRIGGER IF EXISTS cost_alert_channels_immutable ON cost_alert_channels;
CREATE TRIGGER cost_alert_channels_immutable
  BEFORE UPDATE OR DELETE ON cost_alert_channels
  FOR EACH ROW EXECUTE FUNCTION reject_cost_alert_channel_revision_change();

-- Composite references below make the tenant part of every saved identity
-- binding. The UUID primary key remains the identity service's public key.
CREATE UNIQUE INDEX IF NOT EXISTS admin_local_users_tenant_id_id
  ON admin_local_users(tenant_id,id);

CREATE TABLE IF NOT EXISTS cost_budget_alert_bindings (
  tenant_id uuid NOT NULL,
  budget_id uuid NOT NULL,
  budget_revision integer NOT NULL CHECK (budget_revision >= 1),
  binding_revision integer NOT NULL CHECK (binding_revision >= 1),
  owner_user_id uuid NOT NULL REFERENCES admin_local_users(id) ON DELETE RESTRICT,
  owner_display_name text NOT NULL CHECK (length(owner_display_name) BETWEEN 1 AND 128),
  channel_refs jsonb NOT NULL CHECK (jsonb_typeof(channel_refs) = 'array' AND jsonb_array_length(channel_refs) BETWEEN 1 AND 20),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 128),
  actor_role text NOT NULL CHECK (length(actor_role) BETWEEN 1 AND 64),
  actor_issuer text,
  actor_sub text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,budget_id,budget_revision),
  FOREIGN KEY (tenant_id,budget_id,budget_revision)
    REFERENCES cost_budget_revisions(tenant_id,budget_id,revision) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,owner_user_id)
    REFERENCES admin_local_users(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS cost_budget_alert_binding_history (
  tenant_id uuid NOT NULL,
  budget_id uuid NOT NULL,
  budget_revision integer NOT NULL CHECK (budget_revision >= 1),
  binding_revision integer NOT NULL CHECK (binding_revision >= 1),
  owner_user_id uuid NOT NULL REFERENCES admin_local_users(id) ON DELETE RESTRICT,
  owner_display_name text NOT NULL CHECK (length(owner_display_name) BETWEEN 1 AND 128),
  channel_refs jsonb NOT NULL CHECK (jsonb_typeof(channel_refs) = 'array' AND jsonb_array_length(channel_refs) BETWEEN 1 AND 20),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 128),
  actor_role text NOT NULL CHECK (length(actor_role) BETWEEN 1 AND 64),
  actor_issuer text,
  actor_sub text,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,budget_id,budget_revision,binding_revision),
  FOREIGN KEY (tenant_id,budget_id,budget_revision)
    REFERENCES cost_budget_revisions(tenant_id,budget_id,revision) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,owner_user_id)
    REFERENCES admin_local_users(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS cost_alert_binding_commands (
  scope_key text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 256),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 256),
  request_hash text NOT NULL CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_key,idempotency_key)
);

CREATE TABLE IF NOT EXISTS cost_budget_alerts (
  alert_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  budget_id uuid NOT NULL,
  budget_revision integer NOT NULL CHECK (budget_revision >= 1),
  alert_kind text NOT NULL CHECK (alert_kind IN ('threshold','limit','trust_gap')),
  source text NOT NULL CHECK (source IN ('preflight','settlement')),
  source_event_key text NOT NULL CHECK (length(source_event_key) BETWEEN 1 AND 512),
  quota_scope jsonb NOT NULL CHECK (jsonb_typeof(quota_scope) = 'object'),
  quota_scope_key text NOT NULL CHECK (length(quota_scope_key) BETWEEN 1 AND 512),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL CHECK (window_end > window_start),
  reservation_group_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  task_id uuid NOT NULL,
  invocation_id text NOT NULL CHECK (length(invocation_id) BETWEEN 1 AND 128),
  attempt integer NOT NULL CHECK (attempt >= 1),
  usage_event_id text,
  evaluation jsonb NOT NULL CHECK (jsonb_typeof(evaluation) = 'object'),
  trust jsonb NOT NULL CHECK (jsonb_typeof(trust) = 'object'),
  routing_state text NOT NULL CHECK (routing_state IN ('ROUTED','UNROUTED')),
  binding_revision integer CHECK (binding_revision IS NULL OR binding_revision >= 1),
  owner_user_id uuid REFERENCES admin_local_users(id) ON DELETE RESTRICT,
  owner_display_name text,
  channel_refs jsonb NOT NULL CHECK (jsonb_typeof(channel_refs) = 'array' AND jsonb_array_length(channel_refs) <= 20),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,budget_id,budget_revision)
    REFERENCES cost_budget_revisions(tenant_id,budget_id,revision) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,owner_user_id)
    REFERENCES admin_local_users(tenant_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,budget_id,budget_revision,source_event_key,alert_kind),
  UNIQUE (tenant_id,budget_id,budget_revision,window_start,window_end,alert_kind),
  CHECK ((owner_user_id IS NULL) = (owner_display_name IS NULL)),
  CHECK ((routing_state = 'ROUTED' AND owner_user_id IS NOT NULL AND binding_revision IS NOT NULL AND jsonb_array_length(channel_refs) > 0)
      OR (routing_state = 'UNROUTED'))
);

CREATE INDEX IF NOT EXISTS cost_budget_alerts_tenant_created
  ON cost_budget_alerts (tenant_id,created_at DESC,alert_id DESC);
CREATE INDEX IF NOT EXISTS cost_budget_alerts_budget_created
  ON cost_budget_alerts (tenant_id,budget_id,created_at DESC,alert_id DESC);

CREATE TABLE IF NOT EXISTS cost_alert_deliveries (
  delivery_id uuid PRIMARY KEY,
  alert_id uuid NOT NULL REFERENCES cost_budget_alerts(alert_id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL,
  channel_id text NOT NULL,
  channel_revision integer NOT NULL CHECK (channel_revision >= 1),
  channel_name text NOT NULL CHECK (length(channel_name) BETWEEN 1 AND 120),
  recipient_user_id uuid NOT NULL,
  recipient_display_name text NOT NULL CHECK (length(recipient_display_name) BETWEEN 1 AND 128),
  state text NOT NULL CHECK (state IN ('PENDING','CLAIMED','DELIVERED','RETRY','EXHAUSTED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts = 8),
  next_attempt_at timestamptz,
  claimed_by text,
  claim_token uuid,
  claim_expires_at timestamptz,
  delivered_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (alert_id,channel_id,channel_revision),
  FOREIGN KEY (channel_id,channel_revision)
    REFERENCES cost_alert_channels(channel_id,channel_revision) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,recipient_user_id)
    REFERENCES admin_local_users(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((state = 'CLAIMED') = (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL AND claimed_by IS NOT NULL)),
  CHECK ((state = 'DELIVERED') = (delivered_at IS NOT NULL)),
  CHECK (state NOT IN ('PENDING','RETRY') OR next_attempt_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS cost_alert_deliveries_due
  ON cost_alert_deliveries (next_attempt_at,created_at,delivery_id)
  WHERE state IN ('PENDING','RETRY');
CREATE INDEX IF NOT EXISTS cost_alert_deliveries_tenant_created
  ON cost_alert_deliveries (tenant_id,created_at DESC,delivery_id DESC);

CREATE TABLE IF NOT EXISTS cost_alert_delivery_attempts (
  delivery_id uuid NOT NULL REFERENCES cost_alert_deliveries(delivery_id) ON DELETE RESTRICT,
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 8),
  claim_token uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('CLAIMED','DELIVERED','RETRY','EXHAUSTED','UNKNOWN')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  PRIMARY KEY (delivery_id,attempt),
  CHECK ((state = 'CLAIMED') = (finished_at IS NULL))
);

-- Durable first-party notification receiver. The recipient is copied from
-- the immutable budget binding when the alert is created; later owner changes
-- cannot silently redirect an existing delivery.
CREATE TABLE IF NOT EXISTS cost_alert_inbox (
  delivery_id uuid PRIMARY KEY REFERENCES cost_alert_deliveries(delivery_id) ON DELETE RESTRICT,
  alert_id uuid NOT NULL REFERENCES cost_budget_alerts(alert_id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL,
  recipient_user_id uuid NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  delivered_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  FOREIGN KEY (tenant_id,recipient_user_id)
    REFERENCES admin_local_users(tenant_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS cost_alert_inbox_owner_created
  ON cost_alert_inbox (tenant_id,recipient_user_id,delivered_at DESC,delivery_id DESC);
