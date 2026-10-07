-- Orchestrator platform schema v1 (vertical slice: submit → outbox → claim →
-- checkpoint → complete/result). Docs 04 data-state. UUID PKs, UTC timestamptz,
-- integer money (micro-USD). stateVersion/leaseEpoch CAS columns drive ordering.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  state         text NOT NULL DEFAULT 'ACTIVE',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  hash          text NOT NULL UNIQUE,          -- sha256 of raw key; raw never stored
  prefix        text NOT NULL,                 -- display prefix only
  status        text NOT NULL DEFAULT 'ACTIVE',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Registered business versions; manifest immutable after insert.
CREATE TABLE IF NOT EXISTS business_versions (
  business_id      text NOT NULL,
  version          text NOT NULL,
  contract_version text NOT NULL DEFAULT '1',
  manifest         jsonb NOT NULL,
  digest           text NOT NULL,
  status           text NOT NULL DEFAULT 'REGISTERED_DISABLED',
  queue            text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, version)
);

CREATE TABLE IF NOT EXISTS operations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  api_key_id       uuid REFERENCES api_keys(id),
  business_id      text NOT NULL,
  business_version text NOT NULL,
  action           text NOT NULL,
  state            text NOT NULL DEFAULT 'ACCEPTED',
  state_version    integer NOT NULL DEFAULT 1,
  root_task_id     uuid,
  deadline_at      timestamptz,
  input_ref        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- resolved input (slice: inline)
  result_ref       text,                                  -- artifact URI on success
  error_code       text,
  correlation_id   text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS operations_tenant_created ON operations (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS operations_state_updated ON operations (state, updated_at);

-- Idempotency: unique (tenant, key, route); different request_hash → 409.
CREATE TABLE IF NOT EXISTS submission_keys (
  tenant_id     uuid NOT NULL,
  api_key_id    uuid NOT NULL,
  route_action  text NOT NULL,
  key           text NOT NULL,
  request_hash  text NOT NULL,
  operation_id  uuid NOT NULL REFERENCES operations(id),
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, api_key_id, route_action, key)
);

CREATE TABLE IF NOT EXISTS tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id     uuid NOT NULL REFERENCES operations(id),
  parent_id        uuid REFERENCES tasks(id),
  task_key         text NOT NULL,
  kind             text NOT NULL,
  payload_ref      jsonb NOT NULL DEFAULT '{}'::jsonb,
  state            text NOT NULL DEFAULT 'READY',
  attempt          integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 3,
  lease_epoch      integer NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  leased_by        text,
  last_delivery_id text,                    -- idempotent claim replay per delivery
  due_at           timestamptz,
  result_ref       text,
  error_code       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id, task_key)
);
CREATE INDEX IF NOT EXISTS tasks_state_due ON tasks (state, due_at);

-- Parent/child fan-out; v1 join policy is all-success.
CREATE TABLE IF NOT EXISTS task_dependencies (
  parent_id    uuid NOT NULL REFERENCES tasks(id),
  child_id     uuid NOT NULL REFERENCES tasks(id),
  join_policy  text NOT NULL DEFAULT 'all-success',
  PRIMARY KEY (parent_id, child_id)
);

-- Generic checkpoints (RUN-04). Succeeded rows are immutable.
CREATE TABLE IF NOT EXISTS step_checkpoints (
  task_id     uuid NOT NULL REFERENCES tasks(id),
  step_key    text NOT NULL,
  generation  integer NOT NULL DEFAULT 1,
  input_hash  text NOT NULL,
  output_ref  text,
  status      text NOT NULL DEFAULT 'SUCCEEDED',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, step_key, generation)
);

-- Transactional outbox: dispatch state written with the business transaction.
CREATE TABLE IF NOT EXISTS outbox (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_id  uuid NOT NULL,             -- task id (slice)
  type          text NOT NULL,             -- 'task.dispatch' | 'task.continuation'
  delivery_id   text NOT NULL UNIQUE,      -- deterministic, stable across retries
  payload       jsonb NOT NULL,
  due_at        timestamptz NOT NULL DEFAULT now(),
  claim_until   timestamptz,
  dispatched_at timestamptz,
  attempts      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (due_at) WHERE dispatched_at IS NULL;

-- Artifact metadata (local-disk blob store in the slice; S3 per ADR-10 later).
CREATE TABLE IF NOT EXISTS artifacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  operation_id  uuid REFERENCES operations(id),
  task_id       uuid REFERENCES tasks(id),
  purpose       text NOT NULL DEFAULT 'output',   -- input|output|intermediate|session
  mime_type     text NOT NULL,
  size_bytes    bigint,
  sha256        text,
  state         text NOT NULL DEFAULT 'STAGING',  -- STAGING|READY|EXPIRED|DELETED
  token         text NOT NULL,                    -- bearer for blob PUT/GET (slice-local)
  storage_key   text NOT NULL,
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifacts_state ON artifacts (state) WHERE state = 'STAGING';
