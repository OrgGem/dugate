-- COST-01 financial corrections/refunds are separate append-only accounting
-- records. The immutable usage event remains the original measurement and
-- initial charge; current money is the root's latest gross target less the
-- sum of accepted refund deltas.

CREATE TABLE IF NOT EXISTS usage_financial_adjustment_heads (
  root_event_id text PRIMARY KEY REFERENCES usage_events(event_id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  adjustment_revision bigint NOT NULL DEFAULT 0 CHECK (adjustment_revision >= 0),
  head_adjustment_event_id uuid,
  initial_charge_microusd bigint NOT NULL CHECK (initial_charge_microusd >= 0),
  gross_charge_microusd bigint NOT NULL CHECK (gross_charge_microusd >= 0),
  refunded_microusd bigint NOT NULL DEFAULT 0 CHECK (refunded_microusd >= 0),
  net_charge_microusd bigint NOT NULL CHECK (net_charge_microusd >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (net_charge_microusd = gross_charge_microusd - refunded_microusd),
  CHECK ((adjustment_revision = 0) = (head_adjustment_event_id IS NULL)),
  CHECK (initial_charge_microusd <= 9007199254740991),
  CHECK (gross_charge_microusd <= 9007199254740991),
  CHECK (refunded_microusd <= 9007199254740991),
  CHECK (net_charge_microusd <= 9007199254740991)
);

CREATE TABLE IF NOT EXISTS usage_financial_adjustments (
  adjustment_event_id uuid PRIMARY KEY,
  root_event_id text NOT NULL REFERENCES usage_events(event_id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  adjustment_revision bigint NOT NULL CHECK (adjustment_revision >= 1),
  previous_adjustment_event_id uuid REFERENCES usage_financial_adjustments(adjustment_event_id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('correction','refund')),
  target_charge_microusd bigint,
  refund_microusd bigint,
  initial_charge_microusd bigint NOT NULL CHECK (initial_charge_microusd >= 0),
  gross_charge_microusd bigint NOT NULL CHECK (gross_charge_microusd >= 0),
  refunded_microusd bigint NOT NULL CHECK (refunded_microusd >= 0),
  net_charge_microusd bigint NOT NULL CHECK (net_charge_microusd >= 0),
  effective_at timestamptz NOT NULL,
  quota_window_pins jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(quota_window_pins)='array'),
  original_attribution jsonb NOT NULL CHECK (jsonb_typeof(original_attribution)='object'),
  price_snapshot_digest text NOT NULL CHECK (price_snapshot_digest ~ '^sha256:[a-f0-9]{64}$'),
  provenance_digest text NOT NULL CHECK (provenance_digest ~ '^sha256:[a-f0-9]{64}$'),
  evidence_artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  evidence_storage_generation_id uuid NOT NULL REFERENCES storage_generations(generation_id) ON DELETE RESTRICT,
  evidence_size_bytes bigint NOT NULL CHECK (evidence_size_bytes BETWEEN 1 AND 9007199254740991),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  evidence_object_version_id text NOT NULL CHECK (length(evidence_object_version_id) BETWEEN 1 AND 512),
  evidence_sidecar_size_bytes bigint NOT NULL CHECK (evidence_sidecar_size_bytes BETWEEN 1 AND 9007199254740991),
  evidence_sidecar_version_id text NOT NULL CHECK (length(evidence_sidecar_version_id) BETWEEN 1 AND 512),
  evidence_sidecar_sha256 text NOT NULL CHECK (evidence_sidecar_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  authority text NOT NULL DEFAULT 'platform-admin-approved' CHECK (authority='platform-admin-approved'),
  actor_principal_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('local-user','oidc-admin')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (root_event_id, adjustment_revision),
  CHECK ((kind='correction' AND target_charge_microusd IS NOT NULL AND refund_microusd IS NULL)
      OR (kind='refund' AND target_charge_microusd IS NULL AND refund_microusd IS NOT NULL AND refund_microusd > 0)),
  CHECK (target_charge_microusd IS NULL OR target_charge_microusd BETWEEN 0 AND 9007199254740991),
  CHECK (refund_microusd IS NULL OR refund_microusd BETWEEN 1 AND 9007199254740991),
  CHECK (initial_charge_microusd <= 9007199254740991),
  CHECK (gross_charge_microusd <= 9007199254740991),
  CHECK (refunded_microusd <= 9007199254740991),
  CHECK (net_charge_microusd <= 9007199254740991),
  CHECK (net_charge_microusd = gross_charge_microusd - refunded_microusd)
);

DO $$ BEGIN
  ALTER TABLE usage_financial_adjustment_heads
    ADD CONSTRAINT usage_financial_adjustment_heads_event_fk
    FOREIGN KEY (head_adjustment_event_id) REFERENCES usage_financial_adjustments(adjustment_event_id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS usage_financial_adjustment_commands (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_fingerprint text NOT NULL CHECK (actor_fingerprint ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 256),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, actor_fingerprint, idempotency_key),
  CHECK ((result IS NULL) = (completed_at IS NULL))
);

CREATE INDEX IF NOT EXISTS usage_financial_adjustments_tenant_root_revision
  ON usage_financial_adjustments (tenant_id, root_event_id, adjustment_revision DESC);
CREATE INDEX IF NOT EXISTS usage_financial_adjustments_evidence
  ON usage_financial_adjustments (evidence_artifact_id, recorded_at DESC);

CREATE OR REPLACE FUNCTION reject_usage_financial_adjustment_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'financial adjustment ledger is append-only' USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS usage_financial_adjustments_immutable ON usage_financial_adjustments;
CREATE TRIGGER usage_financial_adjustments_immutable
  BEFORE UPDATE OR DELETE ON usage_financial_adjustments
  FOR EACH ROW EXECUTE FUNCTION reject_usage_financial_adjustment_mutation();
