-- CR-12/MM-02 (Edit 4): persist submission-declared artifact roles.
-- Forward-compatible ADD COLUMN only; no existing column touched.
-- SubmissionSchema.artifacts is [{artifactId, role}] with the role as a
-- top-level string (docs 06). The slice previously hashed it into the
-- idempotency request_hash but persisted only `input` into input_ref, so the
-- result route could never surface input roles. This column stores the
-- declared roles verbatim; input_ref keeps its shape (claim snapshots read
-- it as the resolved action input) and execution-produced artifacts stay
-- linked via artifacts.operation_id. Defaults to '[]' so pre-existing rows
-- and minimal test INSERTs keep working.

ALTER TABLE operations ADD COLUMN IF NOT EXISTS submit_artifacts jsonb NOT NULL DEFAULT '[]'::jsonb;
