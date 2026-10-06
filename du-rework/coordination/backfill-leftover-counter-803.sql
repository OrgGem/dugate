-- BACKFILL-LEFTOVER-COUNTER (P730 / REVIEW-803) — COUNT ONLY.
--
-- Purpose: count LEGACY ROWS THAT ARE NOT YET SEALED, before any
-- allowPlaintext flip and before the A2 window flip. An attacker does not
-- need to break the crypto; they only need to find rows that were never
-- backfilled. This file answers that question with counts.
--
-- HARD RULES for this file:
--   * SELECT / COUNT ONLY. No INSERT, UPDATE, DELETE, TRUNCATE, ALTER, DROP,
--     CREATE, GRANT, or any statement that writes.
--   * Never SELECT the column VALUE. Only aggregate predicates over it.
--   * Never print an envelope, a ciphertext, or a plaintext ref.
--
-- Sealed predicate (jsonb) — mirrors isSealed() in metadata-crypto.ts.
-- Every comparison is COALESCE-guarded so the predicate is NEVER NULL.
-- Without that, `NOT (predicate)` is NULL for a row missing the `version`
-- key, and such a row silently VANISHES from the leftover count — the
-- counter would UNDERCOUNT, which is the dangerous direction for a
-- pre-flip gate. (Found and fixed during the disposable run.)
--
-- CAVEAT THAT APPLIES TO EVERY PREDICATE HERE: it is a SHAPE test, not a
-- decryption. An envelope whose AAD or tag is broken still satisfies the shape
-- predicate and is counted as sealed. 'sealed' below means LOOKS sealed, not
-- OPENS. A small sample that actually opens each envelope is a separate check.
--
-- Sealed predicate (text) — the envelope is JSON.stringify of the
-- SealedMetadata object, so it carries the literal member names.
--
-- Run order: 0 (coverage) -> 1..8 (per slot) -> 9 (outbox, other class)
--            -> 10 (flip gate).

BEGIN;
SET LOCAL statement_timeout = '120s';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL transaction_read_only = on;   -- THIS transaction read-only (proved in section 0a)

-- 0a. READ-ONLY PROOF. The previous version set default_transaction_read_only,
--     which only applies to FUTURE transactions in the session, so the running
--     transaction stayed writable. Measured on PG16: transaction_read_only = off.
--     transaction_read_only makes THIS transaction read-only; this reads the
--     setting back so the run PROVES it rather than asserting it.
SELECT current_setting('transaction_read_only') AS transaction_read_only,
       CASE WHEN current_setting('transaction_read_only') = 'on'
            THEN 'READ-ONLY PROVEN'
            ELSE 'NOT READ-ONLY - DO NOT TRUST THIS RUN' END AS read_only_proof;

-- 0b. Coverage invariant: every METADATA_SLOTS entry appears exactly once.
WITH registered(slot) AS (
  VALUES
    ('operations.input_ref'),('tasks.payload_ref'),('human_waits.response_ref'),
    ('step_checkpoints.output_ref'),('step_checkpoints.session_ref'),
    ('operations.prompt_overrides_ref'),('tasks.result_ref'),('operations.result_ref')
)
SELECT r.slot AS registered_slot, 'covered' AS coverage
  FROM registered r ORDER BY r.slot;

-- 1. operations.input_ref (jsonb)
SELECT 'operations.input_ref' AS slot, count(*) AS total_rows,
       count(input_ref) AS non_null,
       count(*) FILTER (WHERE input_ref IS NOT NULL AND (
         jsonb_typeof(input_ref)='object'
         AND COALESCE(input_ref->>'version','')='1'
         AND COALESCE(input_ref->>'algorithm','')='aes-256-gcm'
         AND COALESCE(jsonb_typeof(input_ref->'dek'),'')='object'
         AND COALESCE(jsonb_typeof(input_ref->'nonce'),'')='string'
         AND COALESCE(jsonb_typeof(input_ref->'tag'),'')='string'
         AND COALESCE(jsonb_typeof(input_ref->'ciphertext'),'')='string'
       )) AS sealed,
       count(*) FILTER (WHERE input_ref IS NOT NULL AND NOT (
         jsonb_typeof(input_ref)='object'
         AND COALESCE(input_ref->>'version','')='1'
         AND COALESCE(input_ref->>'algorithm','')='aes-256-gcm'
         AND COALESCE(jsonb_typeof(input_ref->'dek'),'')='object'
         AND COALESCE(jsonb_typeof(input_ref->'nonce'),'')='string'
         AND COALESCE(jsonb_typeof(input_ref->'tag'),'')='string'
         AND COALESCE(jsonb_typeof(input_ref->'ciphertext'),'')='string'
       )) AS leftover_plaintext,
       count(*) FILTER (WHERE input_ref = '{}'::jsonb) AS empty_object
  FROM operations;

-- 2. tasks.payload_ref (jsonb)
SELECT 'tasks.payload_ref' AS slot, count(*) AS total_rows,
       count(payload_ref) AS non_null,
       count(*) FILTER (WHERE payload_ref IS NOT NULL AND (
         jsonb_typeof(payload_ref)='object' AND COALESCE(payload_ref->>'version','')='1'
         AND COALESCE(payload_ref->>'algorithm','')='aes-256-gcm'
         AND COALESCE(jsonb_typeof(payload_ref->'dek'),'')='object'
         AND COALESCE(jsonb_typeof(payload_ref->'nonce'),'')='string'
         AND COALESCE(jsonb_typeof(payload_ref->'tag'),'')='string'
         AND COALESCE(jsonb_typeof(payload_ref->'ciphertext'),'')='string'
       )) AS sealed,
       count(*) FILTER (WHERE payload_ref IS NOT NULL AND NOT (
         jsonb_typeof(payload_ref)='object' AND COALESCE(payload_ref->>'version','')='1'
         AND COALESCE(payload_ref->>'algorithm','')='aes-256-gcm'
         AND COALESCE(jsonb_typeof(payload_ref->'dek'),'')='object'
         AND COALESCE(jsonb_typeof(payload_ref->'nonce'),'')='string'
         AND COALESCE(jsonb_typeof(payload_ref->'tag'),'')='string'
         AND COALESCE(jsonb_typeof(payload_ref->'ciphertext'),'')='string'
       )) AS leftover_plaintext,
       count(*) FILTER (WHERE payload_ref = '{}'::jsonb) AS empty_object
  FROM tasks;

-- 3. human_waits.response_ref (jsonb)
SELECT 'human_waits.response_ref' AS slot, count(*) AS total_rows,
       count(response_ref) AS non_null,
       count(*) FILTER (WHERE response_ref IS NOT NULL AND (
         jsonb_typeof(response_ref)='object' AND COALESCE(response_ref->>'version','')='1'
         AND COALESCE(response_ref->>'algorithm','')='aes-256-gcm'
         AND COALESCE(jsonb_typeof(response_ref->'dek'),'')='object'
         AND COALESCE(jsonb_typeof(response_ref->'nonce'),'')='string'
         AND COALESCE(jsonb_typeof(response_ref->'tag'),'')='string'
         AND COALESCE(jsonb_typeof(response_ref->'ciphertext'),'')='string'
       )) AS sealed,
       count(*) FILTER (WHERE response_ref IS NOT NULL AND NOT (
         jsonb_typeof(response_ref)='object' AND COALESCE(response_ref->>'version','')='1'
         AND COALESCE(response_ref->>'algorithm','')='aes-256-gcm'
         AND COALESCE(jsonb_typeof(response_ref->'dek'),'')='object'
         AND COALESCE(jsonb_typeof(response_ref->'nonce'),'')='string'
         AND COALESCE(jsonb_typeof(response_ref->'tag'),'')='string'
         AND COALESCE(jsonb_typeof(response_ref->'ciphertext'),'')='string'
       )) AS leftover_plaintext
  FROM human_waits;

-- 4. step_checkpoints.output_ref (TEXT)
SELECT 'step_checkpoints.output_ref' AS slot, count(*) AS total_rows,
       count(output_ref) AS non_null,
       count(*) FILTER (WHERE output_ref IS NOT NULL AND
         output_ref LIKE '%"version":1%'
         AND output_ref LIKE '%"algorithm":"aes-256-gcm"%'
         AND output_ref LIKE '%"ciphertext"%'
       ) AS sealed,
       count(*) FILTER (WHERE output_ref IS NOT NULL AND NOT (
         output_ref LIKE '%"version":1%'
         AND output_ref LIKE '%"algorithm":"aes-256-gcm"%'
         AND output_ref LIKE '%"ciphertext"%'
       )) AS leftover_plaintext
  FROM step_checkpoints;

-- 5. step_checkpoints.session_ref (jsonb)
SELECT 'step_checkpoints.session_ref' AS slot, count(*) AS total_rows,
       count(session_ref) AS non_null,
       count(*) FILTER (WHERE session_ref IS NOT NULL AND (
         jsonb_typeof(session_ref)='object' AND COALESCE(session_ref->>'version','')='1'
         AND COALESCE(session_ref->>'algorithm','')='aes-256-gcm'
         AND COALESCE(jsonb_typeof(session_ref->'dek'),'')='object'
         AND COALESCE(jsonb_typeof(session_ref->'nonce'),'')='string'
         AND COALESCE(jsonb_typeof(session_ref->'tag'),'')='string'
         AND COALESCE(jsonb_typeof(session_ref->'ciphertext'),'')='string'
       )) AS sealed,
       count(*) FILTER (WHERE session_ref IS NOT NULL AND NOT (
         jsonb_typeof(session_ref)='object' AND COALESCE(session_ref->>'version','')='1'
         AND COALESCE(session_ref->>'algorithm','')='aes-256-gcm'
         AND COALESCE(jsonb_typeof(session_ref->'dek'),'')='object'
         AND COALESCE(jsonb_typeof(session_ref->'nonce'),'')='string'
         AND COALESCE(jsonb_typeof(session_ref->'tag'),'')='string'
         AND COALESCE(jsonb_typeof(session_ref->'ciphertext'),'')='string'
       )) AS leftover_plaintext
  FROM step_checkpoints;

-- 6. operations.prompt_overrides_ref (jsonb)
SELECT 'operations.prompt_overrides_ref' AS slot, count(*) AS total_rows,
       count(prompt_overrides_ref) AS non_null,
       count(*) FILTER (WHERE prompt_overrides_ref IS NOT NULL AND (
         jsonb_typeof(prompt_overrides_ref)='object'
         AND COALESCE(prompt_overrides_ref->>'version','')='1'
         AND COALESCE(prompt_overrides_ref->>'algorithm','')='aes-256-gcm'
         AND COALESCE(jsonb_typeof(prompt_overrides_ref->'dek'),'')='object'
         AND COALESCE(jsonb_typeof(prompt_overrides_ref->'nonce'),'')='string'
         AND COALESCE(jsonb_typeof(prompt_overrides_ref->'tag'),'')='string'
         AND COALESCE(jsonb_typeof(prompt_overrides_ref->'ciphertext'),'')='string'
       )) AS sealed,
       count(*) FILTER (WHERE prompt_overrides_ref IS NOT NULL AND NOT (
         jsonb_typeof(prompt_overrides_ref)='object'
         AND COALESCE(prompt_overrides_ref->>'version','')='1'
         AND COALESCE(prompt_overrides_ref->>'algorithm','')='aes-256-gcm'
         AND COALESCE(jsonb_typeof(prompt_overrides_ref->'dek'),'')='object'
         AND COALESCE(jsonb_typeof(prompt_overrides_ref->'nonce'),'')='string'
         AND COALESCE(jsonb_typeof(prompt_overrides_ref->'tag'),'')='string'
         AND COALESCE(jsonb_typeof(prompt_overrides_ref->'ciphertext'),'')='string'
       )) AS leftover_plaintext
  FROM operations;

-- 7. tasks.result_ref (TEXT)
SELECT 'tasks.result_ref' AS slot, count(*) AS total_rows,
       count(result_ref) AS non_null,
       count(*) FILTER (WHERE result_ref IS NOT NULL AND
         result_ref LIKE '%"version":1%' AND result_ref LIKE '%"algorithm":"aes-256-gcm"%'
         AND result_ref LIKE '%"ciphertext"%'
       ) AS sealed,
       count(*) FILTER (WHERE result_ref IS NOT NULL AND NOT (
         result_ref LIKE '%"version":1%' AND result_ref LIKE '%"algorithm":"aes-256-gcm"%'
         AND result_ref LIKE '%"ciphertext"%'
       )) AS leftover_plaintext
  FROM tasks;

-- 8. operations.result_ref (TEXT)
SELECT 'operations.result_ref' AS slot, count(*) AS total_rows,
       count(result_ref) AS non_null,
       count(*) FILTER (WHERE result_ref IS NOT NULL AND
         result_ref LIKE '%"version":1%' AND result_ref LIKE '%"algorithm":"aes-256-gcm"%'
         AND result_ref LIKE '%"ciphertext"%'
       ) AS sealed,
       count(*) FILTER (WHERE result_ref IS NOT NULL AND NOT (
         result_ref LIKE '%"version":1%' AND result_ref LIKE '%"algorithm":"aes-256-gcm"%'
         AND result_ref LIKE '%"ciphertext"%'
       )) AS leftover_plaintext
  FROM operations;

-- 9. DIFFERENT CLASS — report, do not gate on it.
--    outbox.payload is a BusinessJobV1 job envelope (contractVersion / deliveryId /
--    taskId / operationId ...), NOT a metadata envelope, so it is not sealed by the
--    metadata seam. It is classified with the SAME shape predicate as the
--    metadata slots purely so the coverage is explicit.
--
--    CAVEAT: the predicate is a SHAPE test, not a decryption. An envelope whose
--    AAD or tag is broken still satisfies the shape predicate and is counted as
--    sealed. 'sealed' here means LOOKS sealed, not OPENS.
SELECT 'outbox.payload (NOT a metadata slot)' AS slot, count(*) AS total_rows,
       count(*) FILTER (WHERE payload IS NOT NULL AND payload ? 'contractVersion') AS job_envelope_rows,
       count(*) FILTER (WHERE payload IS NOT NULL AND NOT (payload ? 'contractVersion')) AS other_rows,
       count(*) FILTER (WHERE payload IS NOT NULL AND (
         jsonb_typeof(payload)='object' AND COALESCE(payload->>'version','')='1'
         AND COALESCE(payload->>'algorithm','')='aes-256-gcm'
         AND COALESCE(jsonb_typeof(payload->'dek'),'')='object'
         AND COALESCE(jsonb_typeof(payload->'nonce'),'')='string'
         AND COALESCE(jsonb_typeof(payload->'tag'),'')='string'
         AND COALESCE(jsonb_typeof(payload->'ciphertext'),'')='string'
       )) AS shape_sealed,
       count(*) FILTER (WHERE payload IS NOT NULL AND NOT (
         jsonb_typeof(payload)='object' AND COALESCE(payload->>'version','')='1'
         AND COALESCE(payload->>'algorithm','')='aes-256-gcm'
         AND COALESCE(jsonb_typeof(payload->'dek'),'')='object'
         AND COALESCE(jsonb_typeof(payload->'nonce'),'')='string'
         AND COALESCE(jsonb_typeof(payload->'tag'),'')='string'
         AND COALESCE(jsonb_typeof(payload->'ciphertext'),'')='string'
       )) AS plaintext
  FROM outbox;

-- 10. THE FLIP GATE.
SELECT sum(leftover_plaintext) AS total_leftover_plaintext,
       sum(empty_object) AS total_empty_object,
       sum(leftover_plaintext) - sum(empty_object) AS actionable_leftover,
       CASE WHEN sum(leftover_plaintext) - sum(empty_object) = 0
            THEN 'GATE PASSES (full-table run, not a sample)'
            ELSE 'GATE FAILS - rows are still plaintext at rest' END AS flip_gate
  FROM (
    SELECT count(*) FILTER (WHERE input_ref IS NOT NULL AND NOT (jsonb_typeof(input_ref)='object' AND COALESCE(input_ref->>'version','')='1' AND COALESCE(input_ref->>'algorithm','')='aes-256-gcm' AND COALESCE(jsonb_typeof(input_ref->'dek'),'')='object' AND COALESCE(jsonb_typeof(input_ref->'nonce'),'')='string' AND COALESCE(jsonb_typeof(input_ref->'tag'),'')='string' AND COALESCE(jsonb_typeof(input_ref->'ciphertext'),'')='string')) AS leftover_plaintext, count(*) FILTER (WHERE input_ref = '{}'::jsonb) AS empty_object FROM operations
    UNION ALL SELECT count(*) FILTER (WHERE prompt_overrides_ref IS NOT NULL AND NOT (jsonb_typeof(prompt_overrides_ref)='object' AND COALESCE(prompt_overrides_ref->>'version','')='1' AND COALESCE(prompt_overrides_ref->>'algorithm','')='aes-256-gcm' AND COALESCE(jsonb_typeof(prompt_overrides_ref->'dek'),'')='object' AND COALESCE(jsonb_typeof(prompt_overrides_ref->'nonce'),'')='string' AND COALESCE(jsonb_typeof(prompt_overrides_ref->'tag'),'')='string' AND COALESCE(jsonb_typeof(prompt_overrides_ref->'ciphertext'),'')='string')), count(*) FILTER (WHERE prompt_overrides_ref = '{}'::jsonb) FROM operations
    UNION ALL SELECT count(*) FILTER (WHERE payload_ref IS NOT NULL AND NOT (jsonb_typeof(payload_ref)='object' AND COALESCE(payload_ref->>'version','')='1' AND COALESCE(payload_ref->>'algorithm','')='aes-256-gcm' AND COALESCE(jsonb_typeof(payload_ref->'dek'),'')='object' AND COALESCE(jsonb_typeof(payload_ref->'nonce'),'')='string' AND COALESCE(jsonb_typeof(payload_ref->'tag'),'')='string' AND COALESCE(jsonb_typeof(payload_ref->'ciphertext'),'')='string')), count(*) FILTER (WHERE payload_ref = '{}'::jsonb) FROM tasks
    UNION ALL SELECT count(*) FILTER (WHERE result_ref IS NOT NULL AND NOT (result_ref LIKE '%"version":1%' AND result_ref LIKE '%"algorithm":"aes-256-gcm"%' AND result_ref LIKE '%"ciphertext"%')), 0 FROM tasks
    UNION ALL SELECT count(*) FILTER (WHERE result_ref IS NOT NULL AND NOT (result_ref LIKE '%"version":1%' AND result_ref LIKE '%"algorithm":"aes-256-gcm"%' AND result_ref LIKE '%"ciphertext"%')), 0 FROM operations
    UNION ALL SELECT count(*) FILTER (WHERE response_ref IS NOT NULL AND NOT (jsonb_typeof(response_ref)='object' AND COALESCE(response_ref->>'version','')='1' AND COALESCE(response_ref->>'algorithm','')='aes-256-gcm' AND COALESCE(jsonb_typeof(response_ref->'dek'),'')='object' AND COALESCE(jsonb_typeof(response_ref->'nonce'),'')='string' AND COALESCE(jsonb_typeof(response_ref->'tag'),'')='string' AND COALESCE(jsonb_typeof(response_ref->'ciphertext'),'')='string')), 0 FROM human_waits
    UNION ALL SELECT count(*) FILTER (WHERE output_ref IS NOT NULL AND NOT (output_ref LIKE '%"version":1%' AND output_ref LIKE '%"algorithm":"aes-256-gcm"%' AND output_ref LIKE '%"ciphertext"%')), 0 FROM step_checkpoints
    UNION ALL SELECT count(*) FILTER (WHERE session_ref IS NOT NULL AND NOT (jsonb_typeof(session_ref)='object' AND COALESCE(session_ref->>'version','')='1' AND COALESCE(session_ref->>'algorithm','')='aes-256-gcm' AND COALESCE(jsonb_typeof(session_ref->'dek'),'')='object' AND COALESCE(jsonb_typeof(session_ref->'nonce'),'')='string' AND COALESCE(jsonb_typeof(session_ref->'tag'),'')='string' AND COALESCE(jsonb_typeof(session_ref->'ciphertext'),'')='string')), 0 FROM step_checkpoints
  ) AS leftovers;

COMMIT;