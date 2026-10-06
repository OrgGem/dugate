-- P745-PRODUCER-IMPL (step 1, marker-only) — prompt-revision pin.
--
-- T-PROM-02 pins the per-step prompt-override bucket AT SUBMIT so the worker
-- never reads the live `connector_prompt_overrides` table. This column stores
-- the NON-SECRET revision markers only:
--
--   [{ "connectionId": <uuid text>, "stepId": <text>, "revision": "sha256:<hex64>" }]
--
-- where `revision = sha256(connectionId | stepId | promptOverride content)`.
-- The prompt CONTENT itself stays in `connector_prompt_overrides`; carrying it
-- here is the phase-2 decision (Δ-1, sealed carrier) and deliberately NOT part
-- of this migration — a digest cannot leak a prompt.
--
-- Additive and nullable, matching the runner's contract: NULL means "no pin"
-- (legacy-mode operation, or a submit that ran before this migration / before
-- the promptOverrides service was composed). Consumers map NULL to `{}` — the
-- historical zero-value wire shape. There is no backfill: a pre-migration
-- operation genuinely had no pinned bucket.
ALTER TABLE operations
  ADD COLUMN IF NOT EXISTS prompt_revisions_pin jsonb NULL;
