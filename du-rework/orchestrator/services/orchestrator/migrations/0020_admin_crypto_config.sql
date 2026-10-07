-- ENC-08 persistence (W-ENC-08-PERSISTENCE / Delta 98).
-- Keep only per-tenant policy references here; Vault keys and recipient key bytes are
-- owned by their providers. The tenant primary key makes save retries idempotent.

CREATE TABLE IF NOT EXISTS admin_crypto_config (
  tenant_id text PRIMARY KEY
    CHECK (tenant_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  storage_key_ref text,
  delivery_encryption boolean NOT NULL DEFAULT false,
  pinned_recipient_key_version integer
    CHECK (pinned_recipient_key_version IS NULL OR pinned_recipient_key_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
