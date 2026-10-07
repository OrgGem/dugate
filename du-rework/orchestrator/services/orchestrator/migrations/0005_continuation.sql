-- Typed continuation: human waits (RUN-06) + parent/child fan-out (RUN-05).
-- Docs 04 data-state, 07 internal-api. A wait is opened by the lease holder
-- (POST tasks/:id/wait-input) and answered by the tenant (POST
-- operations/:id/resume); exactly one OPEN wait per task. Child tasks reuse
-- the tasks/task_dependencies rows from 0001; join state rides on task state
-- (WAITING_CHILDREN) with the join summary merged into the parent payload_ref
-- on completion, so no extra join table is needed.

CREATE TABLE IF NOT EXISTS human_waits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id  uuid NOT NULL REFERENCES operations(id),
  task_id       uuid NOT NULL REFERENCES tasks(id),
  wait_key      text NOT NULL,
  wait_id       text NOT NULL UNIQUE,
  input_schema  jsonb NOT NULL,
  ui_schema     jsonb,
  context_ref   text,
  status        text NOT NULL DEFAULT 'OPEN',   -- OPEN|ANSWERED|EXPIRED|CANCELLED
  response_ref  jsonb,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, wait_key)
);
-- V1 allows a single open human wait per task (docs 06).
CREATE UNIQUE INDEX IF NOT EXISTS human_waits_open_task
  ON human_waits (task_id) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS human_waits_operation
  ON human_waits (operation_id) WHERE status = 'OPEN';
