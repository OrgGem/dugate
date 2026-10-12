-- Append-only, sanitized evidence for the one-time legacy continuity rehearsal.
-- This table stores hashes, counts and bounded status evidence only. It must
-- never contain source settings, credential material, prompt text or blobs.
CREATE TABLE IF NOT EXISTS legacy_continuity_evidence (
  evidence_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_version text NOT NULL,
  evidence_kind text NOT NULL CHECK (evidence_kind IN (
    'inventory', 'reconciliation', 'backup', 'restore', 'runtime_probe', 'cutover_probe'
  )),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  target_sha256 text CHECK (target_sha256 IS NULL OR target_sha256 ~ '^[a-f0-9]{64}$'),
  counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capabilities) = 'object'),
  holds jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(holds) = 'array'),
  receipt jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(receipt) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, source_version, evidence_kind, evidence_sha256),
  FOREIGN KEY (tenant_id, source_version)
    REFERENCES legacy_migration_runs(tenant_id, source_version)
);

CREATE INDEX IF NOT EXISTS legacy_continuity_evidence_latest_idx
  ON legacy_continuity_evidence (tenant_id, source_version, recorded_at DESC);

CREATE OR REPLACE FUNCTION reject_legacy_continuity_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'legacy continuity evidence is append-only';
END;
$$;

DROP TRIGGER IF EXISTS legacy_continuity_evidence_immutable ON legacy_continuity_evidence;
CREATE TRIGGER legacy_continuity_evidence_immutable
  BEFORE UPDATE OR DELETE ON legacy_continuity_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_legacy_continuity_evidence_mutation();
