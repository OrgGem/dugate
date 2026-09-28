-- COST-04 durable admission holds. Reserve and reconcile transactions use the
-- same normalized scope/window key and a PostgreSQL transaction advisory lock.
CREATE TABLE IF NOT EXISTS budget_reservations (
  reservation_id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  scope_key text NOT NULL,
  quota_scope jsonb NOT NULL,
  budget_config jsonb NOT NULL,
  period text NOT NULL CHECK (period IN ('daily', 'monthly')),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  operation_id uuid NOT NULL REFERENCES operations(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  invocation_id text NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 1),
  reserved_tokens bigint NOT NULL CHECK (reserved_tokens >= 0),
  reserved_cost_micro_usd bigint NOT NULL CHECK (reserved_cost_micro_usd >= 0),
  confidence text NOT NULL CHECK (confidence IN ('upper-bound', 'best-effort')),
  status text NOT NULL CHECK (status IN ('RESERVED', 'RUNNING', 'UNKNOWN', 'RECONCILED', 'RELEASED', 'BLOCKED')),
  hard_cap_enabled boolean NOT NULL,
  admission_evaluation jsonb NOT NULL,
  usage_event_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_end > window_start),
  CHECK (reserved_tokens > 0 OR reserved_cost_micro_usd > 0),
  CHECK ((status = 'RECONCILED') = (usage_event_id IS NOT NULL)),
  UNIQUE (scope_key, idempotency_key)
);

CREATE INDEX IF NOT EXISTS budget_reservations_scope_window_active
  ON budget_reservations (scope_key, window_start, window_end, created_at)
  WHERE status IN ('RESERVED', 'RUNNING', 'UNKNOWN');

-- Bind the actual event to the hold that made the provider call admissible.
-- This preserves the original budget window when usage delivery arrives late.
ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS budget_reservation_id uuid REFERENCES budget_reservations(reservation_id);

CREATE UNIQUE INDEX IF NOT EXISTS usage_events_budget_reservation_unique
  ON usage_events (budget_reservation_id)
  WHERE budget_reservation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS budget_reservations_usage_event_unique
  ON budget_reservations (usage_event_id)
  WHERE usage_event_id IS NOT NULL;

DO $$
BEGIN
  ALTER TABLE budget_reservations
    ADD CONSTRAINT budget_reservations_usage_event_fk
    FOREIGN KEY (usage_event_id) REFERENCES usage_events(event_id);
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

CREATE INDEX IF NOT EXISTS usage_events_budget_window_link
  ON usage_events (budget_reservation_id, received_at)
  WHERE budget_reservation_id IS NOT NULL;
