-- Persist the producer epoch that finalized each READY artifact so retries
-- after a lost response can be matched to the original finalize request.
ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS finalized_lease_epoch integer;
