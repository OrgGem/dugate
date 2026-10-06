ALTER TABLE connector_invocations
  ADD COLUMN IF NOT EXISTS provider_poll_attempts INTEGER NOT NULL DEFAULT 0;
