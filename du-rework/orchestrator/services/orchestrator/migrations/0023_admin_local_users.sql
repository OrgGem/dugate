-- LOCAL-01 primitive: tenant-scoped local admin identities.
-- Password hashes are versioned self-describing scrypt encodings; plaintext
-- passwords are never represented in this table.
CREATE TABLE IF NOT EXISTS admin_local_users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  username_normalized text NOT NULL
    CHECK (username_normalized = lower(username_normalized))
    CHECK (username_normalized ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  password_hash       text NOT NULL
    CHECK (password_hash ~ E'^scrypt\\$32768\\$8\\$1\\$[A-Za-z0-9_-]{22}\\$[A-Za-z0-9_-]{43}$'),
  role                text NOT NULL,
  is_enabled          boolean NOT NULL DEFAULT true,
  is_locked           boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT admin_local_users_tenant_username_unique
    UNIQUE (tenant_id, username_normalized)
);

CREATE INDEX IF NOT EXISTS admin_local_users_tenant_created_idx
  ON admin_local_users (tenant_id, created_at DESC, id DESC);
