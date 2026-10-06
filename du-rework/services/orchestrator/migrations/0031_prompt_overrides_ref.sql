-- P745-CARRIER-IMPL-A (Δ-PC-1) — sealed prompt-content carrier.
--
-- Adjudication 1a: the prompt CONTENT bucket is pinned in its own column,
-- sealed with the ENC-META seam under a NEW slot `operations.prompt_overrides_ref`
-- (AAD-bound to tenant + slot + operationId, like operations.input_ref), so the
-- row never holds a plaintext prompt. Adjudication 1c: a deployment without
-- metadata encryption writes NULL here (markers in `prompt_revisions_pin` are
-- still written) — content never falls back to plaintext.
--
-- The column is written in the SAME submit transaction as the markers, from the
-- same single admission-time bucket read. Additive and nullable with no
-- backfill: pre-0031 operations have no carrier, and the claim maps NULL to
-- `pinned.promptOverrides = null` (old operations stay immutable).
ALTER TABLE operations
  ADD COLUMN IF NOT EXISTS prompt_overrides_ref jsonb NULL;
