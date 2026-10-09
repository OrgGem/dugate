-- SC-01 / SC-03: durable Secret Catalog storage.
-- Managed values are encrypted before persistence (AES-256-GCM); plaintext is NEVER stored.
-- Vault references link to external trusted Vault paths with optional version pinning.

CREATE TABLE IF NOT EXISTS secret_catalog (
  secret_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,127}$'),
  purpose text NOT NULL CHECK (purpose IN (
    'connector.credential',
    'connector.provider_header',
    'profile.callback_header',
    'profile.callback_oauth2_client_secret',
    'oidc.client_secret',
    'source.auth',
    'generic'
  )),
  services text[] NOT NULL,
  provider_kind text NOT NULL CHECK (provider_kind IN ('managed_value', 'vault_reference')),
  provider_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'DISABLED', 'REVOKED')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  encrypted_value jsonb,
  rotated_at timestamptz,
  rotation_interval_days integer,
  disabled_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS secret_catalog_tenant_created_idx
  ON secret_catalog (tenant_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS secret_catalog_tenant_name_idx
  ON secret_catalog (tenant_id, name)
  WHERE state != 'REVOKED';
