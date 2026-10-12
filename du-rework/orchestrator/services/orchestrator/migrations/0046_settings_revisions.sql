-- Immutable settings proposals; effective values remain in their existing consumers.
CREATE TABLE IF NOT EXISTS settings_streams (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
 api_key_id uuid NOT NULL REFERENCES api_keys(id), endpoint_slug text NOT NULL,
 active_revision integer, last_revision integer NOT NULL DEFAULT 0,
 UNIQUE(tenant_id,api_key_id,endpoint_slug)
);
CREATE TABLE IF NOT EXISTS settings_revisions (
 stream_id uuid NOT NULL REFERENCES settings_streams(id), revision integer NOT NULL,
 state text NOT NULL CHECK(state IN ('DRAFT','VALIDATED','APPLIED')),
 base_active_revision integer, base_profile_revision integer NOT NULL,
 payload_ref jsonb NOT NULL, content_digest text NOT NULL,
 validation jsonb, applied_fingerprint text, applied_profile_revision integer,
 restores_revision integer, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 applied_at timestamptz, PRIMARY KEY(stream_id,revision)
);
