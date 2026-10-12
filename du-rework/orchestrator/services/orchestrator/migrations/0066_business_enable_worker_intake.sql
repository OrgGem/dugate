-- WOC-09/10: separate logical business availability from its default version,
-- and expose a measured worker intake counter. Existing roots stay available
-- for compatibility; registration creates new roots disabled until an admin
-- explicitly enables them.

ALTER TABLE business_catalog
  ADD COLUMN IF NOT EXISTS enabled boolean;

-- Migration 0043 seeded roots only for versions present at that time.
-- Pre-WOC registrations could add versions without a catalog root, so restore
-- only roots backed by known versions using the same unassigned ownership
-- semantics. ON CONFLICT never overwrites ownership or lifecycle state.
INSERT INTO business_catalog (business_id, created_at, updated_at)
SELECT business_id, min(created_at), max(updated_at)
  FROM business_versions
 GROUP BY business_id
ON CONFLICT (business_id) DO NOTHING;

-- All catalog roots that predate this migration preserve their current serving
-- behavior.
UPDATE business_catalog
   SET enabled = true
 WHERE enabled IS NULL;

ALTER TABLE business_catalog
  ALTER COLUMN enabled SET DEFAULT false,
  ALTER COLUMN enabled SET NOT NULL;

-- Persist the digest when a worker sends the additive v1 field. Older workers
-- may leave this NULL; claim compatibility then relies on the registered
-- server-side version digest. Any explicit heartbeat digest is checked against
-- that immutable registration before it is stored or used for a claim.
ALTER TABLE worker_instances
  ADD COLUMN IF NOT EXISTS manifest_digest text,
  ADD COLUMN IF NOT EXISTS accepted_task_count bigint NOT NULL DEFAULT 0
    CHECK (accepted_task_count >= 0),
  ADD COLUMN IF NOT EXISTS accepted_task_count_since timestamptz NOT NULL DEFAULT now();
