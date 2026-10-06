-- P2-08 webhook delivery (docs 04 WebhookDelivery, docs 06 Webhook).
-- At-least-once signed callbacks scheduled transactionally with the terminal
-- operation transition; a separate dispatcher POSTs with HMAC-SHA256 and
-- retry tracking. Delivery failures never change the operation outcome.

-- Callback destination pinned at submit (docs 06 Submission.callback).
ALTER TABLE operations ADD COLUMN IF NOT EXISTS callback_url text;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id  uuid NOT NULL REFERENCES operations(id),
  tenant_id     uuid NOT NULL,
  event_type    text NOT NULL,             -- operation.succeeded|failed|cancelled|timed-out
  terminal_state text NOT NULL,            -- SUCCEEDED|FAILED|CANCELLED|TIMED_OUT
  state_version integer NOT NULL,          -- terminal revision (dedup scope)
  destination_url text NOT NULL,
  payload       jsonb NOT NULL,            -- WebhookPayload (docs 06)
  status        text NOT NULL DEFAULT 'PENDING',   -- PENDING|DELIVERED|FAILED
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 5,
  next_at       timestamptz NOT NULL DEFAULT now(),
  last_error    text,
  delivered_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- At-most-one delivery row per terminal revision + destination (docs 04).
CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_terminal_dedup
  ON webhook_deliveries (operation_id, state_version, destination_url);
-- Pending-delivery scan for the dispatcher.
CREATE INDEX IF NOT EXISTS webhook_deliveries_pending
  ON webhook_deliveries (next_at) WHERE status = 'PENDING';
