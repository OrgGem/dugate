-- Append-only Connector usage. No task-state predicate: late charges remain valid.
CREATE TABLE IF NOT EXISTS usage_events (
  event_id text PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES operations(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_operation ON usage_events (operation_id);
