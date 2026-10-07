-- VAULT-05 / SEC-03: every revision has an explicit credential source.
-- Existing rows retain their credential_ref through an explicit legacy-db
-- discriminator. Vault sources contain only ref coordinates and a pinned
-- version; no secret or Vault token is stored here.
-- Re-running converges and is safe if a previous migration attempt added the
-- column before it reached the schema migration ledger.

ALTER TABLE connector_revisions
  ADD COLUMN IF NOT EXISTS credential_source JSONB;

UPDATE connector_revisions
   SET credential_source = jsonb_build_object('kind', 'legacy-db', 'credentialRef', credential_ref)
 WHERE credential_source IS NULL;

ALTER TABLE connector_revisions
  ALTER COLUMN credential_source SET NOT NULL;
