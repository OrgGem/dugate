-- W-R2-A priority-5 (review.md cycle 6/6 MEDIUM "retried mutating POST is
-- not idempotent proof"; FULL-REWORK-REVIEW-FOLLOWUP 2026-09-24 line 95):
-- idempotency markers for admin mutating POSTs. A client retry after a lost
-- socket/response must NOT create a second profile revision or a second
-- audit row. The FIRST request persists its full response here in the SAME
-- transaction as the mutation and the audit row (auditedMutation `after`
-- hook + src/modules/idempotency/idempotency.ts), so a replay reads the
-- stored response back verbatim and writes nothing.
--
-- The key is an opaque, high-entropy client token (`Idempotency-Key` or
-- `Client-Token` header) — request metadata, not credential material. It is
-- never logged and never echoed back. payload_hash covers the canonicalized
-- JSON of the request body (raw apiKey included in the hash only), so a
-- reused key with different content is a 409, never a silent overwrite.
-- Additive, forward-compatible CREATE IF NOT EXISTS (0010 precedent).

CREATE TABLE IF NOT EXISTS admin_idempotency (
  key           text PRIMARY KEY,
  route         text NOT NULL,
  payload_hash  text NOT NULL,
  response_code integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Ops retention scans (see purgeIdempotencyMarkers in the module).
CREATE INDEX IF NOT EXISTS admin_idempotency_created
  ON admin_idempotency (created_at);
