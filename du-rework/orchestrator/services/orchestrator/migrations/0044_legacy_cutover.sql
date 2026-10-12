-- ORV11-DATA: preserve exact legacy profile selectors and historical metadata.
-- NULL selector is a generic rework profile. Legacy selectors remain verbatim.
ALTER TABLE profile_bindings ADD COLUMN IF NOT EXISTS endpoint_slug text;
CREATE INDEX IF NOT EXISTS profile_bindings_legacy_selector
  ON profile_bindings (tenant_id, business_id, action, endpoint_slug);
ALTER TABLE operations ADD COLUMN IF NOT EXISTS legacy_history jsonb;
-- History is not an executable callback/task envelope. The importer refuses
-- active/HITL rows; drain them before the immutable one-time snapshot.

-- Retention only, deliberately not an effective configuration store.
CREATE TABLE IF NOT EXISTS legacy_app_settings (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  key text NOT NULL,
  value text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

ALTER TABLE admin_local_users ADD COLUMN IF NOT EXISTS legacy_password_reset_required boolean NOT NULL DEFAULT false;
ALTER TABLE admin_local_users ADD COLUMN IF NOT EXISTS legacy_identity_metadata jsonb;
