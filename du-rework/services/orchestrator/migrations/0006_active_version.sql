-- W28-C: explicit active-version pointer for business_versions.
-- Ensures exactly one ENABLED version per business is the active target for
-- new submissions (P7-06 drain/rollback). In-flight operations pinned to
-- older versions continue routing via their operation.business_version pin.

ALTER TABLE business_versions
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT false;

-- Seed: activate the most recently created ENABLED version per business so
-- existing submissions are not broken. Must run before the unique index so
-- a pre-existing double-ENABLED state does not crash the migration.
WITH latest_enabled AS (
  SELECT DISTINCT ON (business_id) business_id, version
  FROM business_versions
  WHERE status = 'ENABLED'
  ORDER BY business_id, created_at DESC
)
UPDATE business_versions bv SET is_active = true
FROM latest_enabled le
WHERE bv.business_id = le.business_id AND bv.version = le.version;

-- Only one version per business may be active (is_active = true).
CREATE UNIQUE INDEX IF NOT EXISTS business_versions_active_unique
  ON business_versions (business_id)
  WHERE is_active = true;
