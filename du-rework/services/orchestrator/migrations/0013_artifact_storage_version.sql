-- DATA-01/DATA-02: keep backend selection and immutable generation identity
-- beside artifact metadata. Existing rows stay on the PostgreSQL fallback.
ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS storage_backend text NOT NULL DEFAULT 'postgres';

ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS storage_version_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'artifacts_storage_backend_check'
      AND conrelid = 'artifacts'::regclass
  ) THEN
    ALTER TABLE artifacts
      ADD CONSTRAINT artifacts_storage_backend_check
      CHECK (storage_backend IN ('postgres', 's3'));
  END IF;
END $$;
