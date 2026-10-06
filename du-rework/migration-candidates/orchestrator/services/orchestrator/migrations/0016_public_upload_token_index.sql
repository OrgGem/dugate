-- DATA-02 public branch (packet W-DATA02-PUB-1): replay key for CLIENT uploads.
-- The 0015 replay index is keyed by (task_id, upload_token); public upload rows
-- carry no task, and PostgreSQL unique indexes treat NULL keys as distinct, so
-- the runtime index silently admits duplicate tokens for task-less rows. This
-- partial index enforces replay uniqueness for the public branch only; the two
-- branches keep disjoint uniqueness domains ((task,token) vs (tenant,token)).
-- Metadata only — bytes never enter PostgreSQL on this path (DATA-01 invariant).

CREATE UNIQUE INDEX IF NOT EXISTS artifacts_public_upload_token
  ON artifacts (tenant_id, upload_token)
  WHERE task_id IS NULL AND upload_token IS NOT NULL;
