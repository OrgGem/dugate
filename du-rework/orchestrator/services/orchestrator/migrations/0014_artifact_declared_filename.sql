-- Preserve the source-declared filename alongside the artifact's stored MIME.
-- Existing rows remain valid with NULL because their original upload name was
-- not persisted by older worker versions.
ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS file_name text;
