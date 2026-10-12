-- COST-02 / COST-04 immutable price and budget revision heads, plus atomic
-- per-invocation reservation groups. Existing budget_reservations remains a
-- compatible legacy surface; rich invocation admission uses the composite
-- tables below so overlapping scope caps are reserved in one transaction.

CREATE TABLE IF NOT EXISTS cost_budget_heads (
  tenant_id uuid NOT NULL,
  budget_id uuid NOT NULL,
  head_revision integer NOT NULL CHECK (head_revision >= 1),
  active_revision integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, budget_id),
  CHECK (active_revision IS NULL OR (active_revision >= 1 AND active_revision <= head_revision))
);

CREATE TABLE IF NOT EXISTS cost_budget_revisions (
  tenant_id uuid NOT NULL,
  budget_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  state text NOT NULL CHECK (state IN ('DRAFT','REVIEW','PUBLISHED','SUPERSEDED','RETIRED')),
  config jsonb NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[a-f0-9]{64}$'),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 128),
  reviewer_reason text,
  source_revision integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  PRIMARY KEY (tenant_id, budget_id, revision),
  FOREIGN KEY (tenant_id, budget_id) REFERENCES cost_budget_heads(tenant_id, budget_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (state NOT IN ('PUBLISHED','SUPERSEDED','RETIRED') OR published_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS cost_budget_revisions_tenant_created
  ON cost_budget_revisions (tenant_id, budget_id, revision DESC);

CREATE TABLE IF NOT EXISTS cost_price_heads (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  head_revision integer NOT NULL CHECK (head_revision >= 1),
  active_revision integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (active_revision IS NULL OR (active_revision >= 1 AND active_revision <= head_revision))
);

CREATE TABLE IF NOT EXISTS cost_price_revisions (
  revision integer PRIMARY KEY CHECK (revision >= 1),
  state text NOT NULL CHECK (state IN ('DRAFT','REVIEW','PUBLISHED','SUPERSEDED','RETIRED')),
  tiers jsonb NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[a-f0-9]{64}$'),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 128),
  reviewer_reason text,
  source_revision integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CHECK (state NOT IN ('PUBLISHED','SUPERSEDED','RETIRED') OR published_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS cost_reservation_groups (
  reservation_group_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  operation_id uuid NOT NULL REFERENCES operations(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  invocation_id text NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 1),
  -- The logical group is the authoritative held basis, including calls that
  -- began before any budget matched and therefore have no child hold rows.
  scope_snapshot jsonb NOT NULL,
  reserved_tokens bigint NOT NULL CHECK (reserved_tokens >= 0),
  reserved_cost_micro_usd bigint NOT NULL CHECK (reserved_cost_micro_usd >= 0),
  reservation_bounded boolean NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  decision text NOT NULL CHECK (decision IN ('ADMITTED','BLOCKED')),
  state text NOT NULL CHECK (state IN ('RESERVED','RUNNING','UNKNOWN','RELEASED','BLOCKED','PENDING','SETTLED')),
  confidence text NOT NULL CHECK (confidence IN ('upper-bound','best-effort')),
  hard_cap_enabled boolean NOT NULL,
  price_revision integer,
  pricing_tier jsonb,
  selected_at timestamptz NOT NULL,
  evaluations jsonb NOT NULL,
  frozen_response jsonb NOT NULL,
  usage_event_id text,
  state_reason text CHECK (state_reason IS NULL OR state_reason ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id, task_id, invocation_id, attempt),
  UNIQUE (usage_event_id),
  CHECK ((state = 'BLOCKED') = (decision = 'BLOCKED')),
  CHECK (state <> 'SETTLED' OR usage_event_id IS NOT NULL),
  CHECK (state NOT IN ('SETTLED','PENDING') OR usage_event_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS cost_budget_holds (
  reservation_group_id uuid NOT NULL REFERENCES cost_reservation_groups(reservation_group_id),
  tenant_id uuid NOT NULL,
  budget_id uuid NOT NULL,
  budget_revision integer NOT NULL CHECK (budget_revision >= 1),
  scope_key text NOT NULL,
  quota_scope jsonb NOT NULL,
  budget_config jsonb NOT NULL,
  period text NOT NULL CHECK (period IN ('daily','monthly')),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL CHECK (window_end > window_start),
  reserved_tokens bigint NOT NULL CHECK (reserved_tokens >= 0),
  reserved_cost_micro_usd bigint NOT NULL CHECK (reserved_cost_micro_usd >= 0),
  state text NOT NULL CHECK (state IN ('RESERVED','RUNNING','UNKNOWN','RELEASED','PENDING','SETTLED','BLOCKED')),
  usage_event_id text,
  PRIMARY KEY (reservation_group_id, budget_id),
  CHECK (reserved_tokens > 0 OR reserved_cost_micro_usd > 0 OR state IN ('RELEASED','BLOCKED'))
);

-- Upgrade-safe backfill for deployments that created the earlier draft of
-- this migration. The group remains authoritative even when no child holds
-- were needed; child amounts are only a recovery source for existing rows.
ALTER TABLE cost_reservation_groups
  ADD COLUMN IF NOT EXISTS scope_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS reserved_tokens bigint,
  ADD COLUMN IF NOT EXISTS reserved_cost_micro_usd bigint,
  ADD COLUMN IF NOT EXISTS reservation_bounded boolean;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cost_budget_holds h
    GROUP BY h.reservation_group_id
    HAVING min(h.reserved_tokens) <> max(h.reserved_tokens)
        OR min(h.reserved_cost_micro_usd) <> max(h.reserved_cost_micro_usd)
  ) THEN
    RAISE EXCEPTION 'cost reservation group child holds disagree on their logical amount';
  END IF;
END $$;

UPDATE cost_reservation_groups g
   SET scope_snapshot = COALESCE(g.scope_snapshot, jsonb_build_object(
         'tenantId',o.tenant_id::text,
         'apiKeyId',o.api_key_id::text,
         'profileId',o.profile_id::text,
         'profileRevision',o.profile_revision,
         'businessId',o.business_id,
         'businessVersion',o.business_version,
         'action',o.action,
         'attempt',g.attempt)),
       reserved_tokens = COALESCE(g.reserved_tokens, (
         SELECT max(h.reserved_tokens) FROM cost_budget_holds h WHERE h.reservation_group_id=g.reservation_group_id), 0),
       reserved_cost_micro_usd = COALESCE(g.reserved_cost_micro_usd, (
         SELECT max(h.reserved_cost_micro_usd) FROM cost_budget_holds h WHERE h.reservation_group_id=g.reservation_group_id), 0),
       reservation_bounded = COALESCE(g.reservation_bounded, g.confidence='upper-bound')
  FROM operations o
 WHERE g.operation_id=o.id
   AND (g.scope_snapshot IS NULL OR g.reserved_tokens IS NULL
     OR g.reserved_cost_micro_usd IS NULL OR g.reservation_bounded IS NULL);

ALTER TABLE cost_reservation_groups
  ALTER COLUMN scope_snapshot SET NOT NULL,
  ALTER COLUMN reserved_tokens SET NOT NULL,
  ALTER COLUMN reserved_cost_micro_usd SET NOT NULL,
  ALTER COLUMN reservation_bounded SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='cost_reservation_groups_reserved_tokens_nonnegative') THEN
    ALTER TABLE cost_reservation_groups ADD CONSTRAINT cost_reservation_groups_reserved_tokens_nonnegative CHECK (reserved_tokens >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='cost_reservation_groups_reserved_cost_nonnegative') THEN
    ALTER TABLE cost_reservation_groups ADD CONSTRAINT cost_reservation_groups_reserved_cost_nonnegative CHECK (reserved_cost_micro_usd >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS cost_budget_holds_scope_window_active
  ON cost_budget_holds (scope_key, window_start, window_end, reservation_group_id)
  WHERE state IN ('RESERVED','RUNNING','UNKNOWN','PENDING');

CREATE TABLE IF NOT EXISTS cost_control_commands (
  scope_key text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 256),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 256),
  request_hash text NOT NULL CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_key,idempotency_key)
);

CREATE INDEX IF NOT EXISTS cost_control_commands_created
  ON cost_control_commands (created_at);

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS cost_reservation_group_id uuid REFERENCES cost_reservation_groups(reservation_group_id);

CREATE UNIQUE INDEX IF NOT EXISTS usage_events_cost_group_settled_unique
  ON usage_events (cost_reservation_group_id)
  WHERE cost_reservation_group_id IS NOT NULL AND payload->>'costStatus' IN ('measured','estimated');

DROP INDEX IF EXISTS usage_events_cost_group_unique;

DO $$
BEGIN
  ALTER TABLE cost_reservation_groups
    ADD CONSTRAINT cost_reservation_groups_usage_event_fk
    FOREIGN KEY (usage_event_id) REFERENCES usage_events(event_id)
    DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;
