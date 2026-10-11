-- BIZ-08: establish the logical business ownership root.
-- Existing business rows remain unassigned until an authoritative tenant map is reviewed.
CREATE TABLE IF NOT EXISTS business_catalog (
  business_id       text PRIMARY KEY,
  owner_tenant_id   uuid NULL,
  lifecycle_revision bigint NOT NULL DEFAULT 1 CHECK (lifecycle_revision > 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_catalog_owner_tenant_fk
    FOREIGN KEY (owner_tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS business_catalog_owner_business_idx
  ON business_catalog (owner_tenant_id, business_id);

-- Seed one unassigned root for every registered logical business. Preserve
-- registry timestamps and never overwrite a previously assigned owner.
INSERT INTO business_catalog (business_id, created_at, updated_at)
SELECT business_id, min(created_at), max(updated_at)
FROM business_versions
GROUP BY business_id
ON CONFLICT (business_id) DO NOTHING;
