-- CR-12 (FIX-CR-12): artifact grant fencing columns.
-- Forward-compatible ADD COLUMNs only; no existing column touched.
-- The token bearer is now method-scoped (upload|download) with a checked
-- expiry; the blob route enforces both, so a read grant cannot PUT and an
-- expired token 404s instead of serving bytes.

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS token_expires_at timestamptz;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS token_mode text;
