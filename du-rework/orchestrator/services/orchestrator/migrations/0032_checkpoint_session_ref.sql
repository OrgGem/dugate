-- Durable connector continuation reference for checkpoint resume.
ALTER TABLE step_checkpoints
  ADD COLUMN IF NOT EXISTS session_ref jsonb;
