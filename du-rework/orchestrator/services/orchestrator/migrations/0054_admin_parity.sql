-- ORV14 Identity, user grants, API-key lifecycle, and bounded Connector tests.
-- This is additive: existing keys, identities, Connector revisions and
-- operation pins retain their current IDs and history.

ALTER TABLE admin_local_users
  ADD COLUMN IF NOT EXISTS assignment_version integer NOT NULL DEFAULT 1
    CHECK (assignment_version > 0);

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS admin_local_user_profile_grants (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES admin_local_users(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, profile_id)
);
CREATE INDEX IF NOT EXISTS admin_local_user_profile_grants_profile_idx
  ON admin_local_user_profile_grants (tenant_id, profile_id, user_id);

CREATE TABLE IF NOT EXISTS admin_local_user_api_key_grants (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES admin_local_users(id) ON DELETE CASCADE,
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, api_key_id)
);
CREATE INDEX IF NOT EXISTS admin_local_user_api_key_grants_key_idx
  ON admin_local_user_api_key_grants (tenant_id, api_key_id, user_id);

-- Idempotency records intentionally store no key material. If the first
-- response is lost, the replay identifies the already-created key and asks
-- the operator to rotate it; it cannot recover the copy-once secret.
CREATE TABLE IF NOT EXISTS admin_api_key_mutations (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  idempotency_hash text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('issue','rotate')),
  request_hash text NOT NULL,
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_hash)
);

-- Durable evidence for the one intentional provider invocation performed by
-- an Admin test. Synthetic operation/task IDs are real rows so quota and usage
-- ledgers retain their normal foreign-key and tenant scope.
CREATE TABLE IF NOT EXISTS admin_connector_test_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE RESTRICT,
  profile_id uuid NOT NULL,
  business_id text NOT NULL,
  business_version text NOT NULL,
  endpoint_slug text NOT NULL,
  connector_id text NOT NULL,
  connector_revision integer NOT NULL CHECK (connector_revision > 0),
  operation_id uuid NOT NULL UNIQUE REFERENCES operations(id) ON DELETE RESTRICT,
  task_id uuid NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
  invocation_id uuid NOT NULL UNIQUE,
  budget_reservation_group_id uuid,
  idempotency_hash text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('PREPARED','RUNNING','SUCCEEDED','FAILED','BLOCKED','UNKNOWN')),
  state_version integer NOT NULL DEFAULT 1 CHECK (state_version > 0),
  result jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_hash)
);
CREATE INDEX IF NOT EXISTS admin_connector_test_runs_tenant_created_idx
  ON admin_connector_test_runs (tenant_id, created_at DESC, id DESC);

