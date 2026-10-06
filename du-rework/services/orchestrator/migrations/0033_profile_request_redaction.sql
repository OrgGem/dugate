-- Admin request visibility only: execution payloads remain unchanged.
ALTER TABLE profile_bindings
  ADD COLUMN IF NOT EXISTS request_redaction jsonb NOT NULL DEFAULT '[]'::jsonb;
