-- OR10-01: exact source credential origins are pinned to the immutable
-- profile revision that owns the credential cipher.
ALTER TABLE profile_bindings
  ADD COLUMN IF NOT EXISTS allowed_origins jsonb NOT NULL DEFAULT '[]'::jsonb;
