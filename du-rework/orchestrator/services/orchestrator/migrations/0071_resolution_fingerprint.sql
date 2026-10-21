-- PC-05 (PROFILE-CONTROL-PLANE): replayable resolution fingerprint.
--
-- `POST /api/v2/profile-groups/:groupId/operations` must be replayable after
-- the configuration drifts. The client presents the fingerprint a preview
-- returned; on an exact retry the server has to compare it with the value the
-- FIRST accepted request carried — recomputing it from current rows is exactly
-- what drift makes impossible.
--
-- `submission_keys` is the correct home rather than `operations`:
--   * the replay window is the idempotency TTL, which is the lifetime of this
--     row (`expires_at`), not the operation's permanent lifetime;
--   * a replay is decided by the same (tenant, api_key, route, key) lookup
--     that already reads this table, so the comparison needs no second read;
--   * `operations` is the hot, wide table and `input_ref`/policy snapshots are
--     already sealed — a plaintext digest column there would be a new surface
--     for no benefit.
--
-- Nullable on purpose: every v1 row (and every v2 row accepted before PC-05)
-- has no fingerprint, and a NULL must never be treated as "matches". v1
-- submissions do not carry a fingerprint and keep their byte-identical replay
-- rule (request hash only).
--
-- Additive and re-runnable, matching the runner contract
-- (`src/db/migrations.ts`: one transaction per file, checksummed ledger row,
-- no down migrations).
ALTER TABLE submission_keys
  ADD COLUMN IF NOT EXISTS resolution_fingerprint text
    CONSTRAINT submission_keys_resolution_fingerprint_shape
    CHECK (resolution_fingerprint IS NULL OR resolution_fingerprint ~ '^sha256:[0-9a-f]{64}$');

COMMENT ON COLUMN submission_keys.resolution_fingerprint IS
  'PC-05: the exact resolutionFingerprint the first accepted v2 request carried. NULL for v1 rows; never coalesced into a match.';
