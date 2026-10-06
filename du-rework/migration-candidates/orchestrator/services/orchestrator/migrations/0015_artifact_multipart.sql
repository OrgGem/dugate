-- DATA-02 (tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md): server-side multipart
-- upload lifecycle metadata. Forward-compatible ADD COLUMNs and one ledger
-- table only -- no existing column or row is touched, and every single-PUT
-- artifact keeps all new columns NULL.
--
-- Bytes never enter PostgreSQL on this path: the columns below hold lifecycle
-- metadata only, so the DATA-01 invariant (no new artifact_blobs writes) is
-- unchanged. The provider upload id stays server-side and is never returned on
-- the wire; clients receive a derived opaque uploadHandle instead.

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS upload_token uuid;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS multipart_upload_id text;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS part_size_bytes integer;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS part_count integer;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS multipart_expires_at timestamptz;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS abort_reason text;

-- init replay key: retrying a lost response with the same (task, token) must
-- resolve to the same artifact row instead of creating a second upload.
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_task_upload_token
  ON artifacts (task_id, upload_token)
  WHERE upload_token IS NOT NULL;

-- Orphan sweep reads expired STAGING sessions; ABORTED rows that still carry a
-- provider upload id are the ones whose storage purge did not finish.
CREATE INDEX IF NOT EXISTS artifacts_multipart_expiry
  ON artifacts (multipart_expires_at)
  WHERE part_count IS NOT NULL AND state IN ('STAGING', 'ABORTED');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'artifacts_multipart_geometry_check'
      AND conrelid = 'artifacts'::regclass
  ) THEN
    -- multipart_upload_id is deliberately outside the constraint: the purge step
    -- clears it once storage has released the upload, while part_count keeps
    -- identifying the row as belonging to the multipart branch.
    ALTER TABLE artifacts
      ADD CONSTRAINT artifacts_multipart_geometry_check
      CHECK (
        part_count IS NULL
        OR (
          part_count BETWEEN 1 AND 10000
          AND part_size_bytes >= 5242880
          AND multipart_expires_at IS NOT NULL
        )
      );
-- multipart_upload_id is deliberately left out of the constraint: the purge
-- step clears it once storage has released the upload, while part_count keeps
-- identifying the row as belonging to the multipart branch.
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'artifacts_abort_reason_check'
      AND conrelid = 'artifacts'::regclass
  ) THEN
    ALTER TABLE artifacts
      ADD CONSTRAINT artifacts_abort_reason_check
      CHECK (abort_reason IS NULL OR abort_reason IN ('cancelled', 'superseded', 'failed', 'expired'));
  END IF;
END $$;

-- Server-side grant ledger: one row per part the server agreed to accept,
-- recording the size it fixed and the hash it bound into the presigned PUT.
-- complete cross-checks storage's own part list against this ledger, so a
-- client cannot complete with a set it was never granted.
CREATE TABLE IF NOT EXISTS artifact_multipart_parts (
  artifact_id     uuid    NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  part_number     integer NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  declared_sha256 text    NOT NULL CHECK (declared_sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes      bigint  NOT NULL CHECK (size_bytes > 0),
  PRIMARY KEY (artifact_id, part_number)
);
