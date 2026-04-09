-- Migration: add_session_id_chaining
-- Thêm 2 trường để hỗ trợ Session ID Chaining giữa các pipeline step.
-- Cả 2 đều nullable → backward compatible 100%.

ALTER TABLE "ExternalApiConnection"
  ADD COLUMN IF NOT EXISTS "sessionIdResponsePath" TEXT,
  ADD COLUMN IF NOT EXISTS "sessionIdFieldName"    TEXT;
