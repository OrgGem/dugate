-- RFX-05: retain the immutable S3 sidecar generation alongside the ciphertext
-- generation. Existing artifacts remain NULL and keep the legacy key-only read.
ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS manifest_version_id text;
