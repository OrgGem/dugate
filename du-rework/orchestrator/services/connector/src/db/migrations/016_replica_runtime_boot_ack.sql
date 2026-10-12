-- Tie a runtime-control observation to the exact live Connector process.
-- Existing acknowledgements lack boot provenance, so force a fresh observation
-- from the process that registers after this migration.
ALTER TABLE connector_replica_runtime_controls
  ADD COLUMN IF NOT EXISTS process_boot_id UUID,
  ADD COLUMN IF NOT EXISTS acknowledged_boot_id UUID;

UPDATE connector_replica_runtime_controls
   SET acknowledged_at='-infinity', acknowledged_boot_id=NULL
 WHERE process_boot_id IS NULL;

COMMENT ON COLUMN connector_replica_runtime_controls.process_boot_id IS
  'Current process boot UUID; updated at registration and used to fence stale observers.';
COMMENT ON COLUMN connector_replica_runtime_controls.acknowledged_boot_id IS
  'Process boot UUID that persisted acknowledged_at for the current control revision.';
