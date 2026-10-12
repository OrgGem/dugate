-- Provenance for one-time immutable imports. All hashes cover canonical UTF-8
-- JSON; no secret/plaintext source rows or blob bytes are retained in this ledger.
CREATE TABLE IF NOT EXISTS legacy_migration_runs (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_version text NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^[a-f0-9]{64}$'),
  source_counts jsonb NOT NULL,
  destination_counts jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_version)
);

-- Resumable reconciliation journal; effective writes still go ONLY through the
-- authenticated audited Settings revision API. No prompt/secret payloads here.
CREATE TABLE IF NOT EXISTS legacy_configuration_reconciliations (
  tenant_id uuid NOT NULL,
  source_version text NOT NULL,
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  baseline_inventory_sha256 text NOT NULL CHECK (baseline_inventory_sha256 ~ '^[a-f0-9]{64}$'),
  progress jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_version, manifest_sha256),
  FOREIGN KEY (tenant_id, source_version) REFERENCES legacy_migration_runs(tenant_id, source_version)
);

CREATE TABLE IF NOT EXISTS legacy_migration_inventory_reports (
  tenant_id uuid NOT NULL,
  source_version text NOT NULL,
  inventory_sha256 text NOT NULL CHECK (inventory_sha256 ~ '^[a-f0-9]{64}$'),
  report jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,source_version,inventory_sha256),
  FOREIGN KEY (tenant_id,source_version) REFERENCES legacy_migration_runs(tenant_id,source_version)
);
