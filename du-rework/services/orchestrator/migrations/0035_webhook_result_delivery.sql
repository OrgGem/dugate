-- CB-02 (PROFILE-CALLBACK-20261006): result-bearing webhook delivery.
--
-- `operations.callback_policy` is the admission-time pin (CB-01
-- `ProfileCallbackPolicySnapshot`, or a bare `ProfileCallbackPolicy`); absent =
-- legacy notification-only behavior, byte-identical to P2-08.
--
-- `webhook_deliveries.mode` records which envelope the frozen payload holds so
-- the dispatcher, Portal and audits can tell the two modes apart.
-- `webhook_deliveries.callback_policy` is the SAME pinned policy copied at
-- terminal scheduling, so delivery never re-reads a live profile revision and a
-- later publish/rollback cannot retarget an already-scheduled callback. It
-- carries secret REFERENCES only (never values) and no raw storage URLs.

ALTER TABLE operations ADD COLUMN IF NOT EXISTS callback_policy jsonb;

ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'notification_only';

ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS callback_policy jsonb;
