-- COST-01: preserve the raw encrypted object proof separately from the
-- logical plaintext file digest/size already recorded in migration 0064.
-- Existing immutable rows remain explicitly unverified (NULL); do not guess
-- values or rewrite their financial history. New commands must fill both.
ALTER TABLE usage_financial_adjustments
  ADD COLUMN IF NOT EXISTS evidence_object_size_bytes bigint,
  ADD COLUMN IF NOT EXISTS evidence_object_sha256 text;

DO $$ BEGIN
  ALTER TABLE usage_financial_adjustments
    ADD CONSTRAINT usage_financial_adjustments_object_pin_pair
    CHECK (
      (evidence_object_size_bytes IS NULL) = (evidence_object_sha256 IS NULL)
      AND (evidence_object_size_bytes IS NULL OR evidence_object_size_bytes BETWEEN 1 AND 9007199254740991)
      AND (evidence_object_sha256 IS NULL OR evidence_object_sha256 ~ '^sha256:[a-f0-9]{64}$')
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
