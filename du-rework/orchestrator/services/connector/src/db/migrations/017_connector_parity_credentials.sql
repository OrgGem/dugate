-- Typed Connector credential bytes are AES-GCM ciphertext and are bound to
-- the exact tenant, connector, draft revision, opaque ref, and version by AAD.
-- The row is committed atomically with its write-ahead draft intent.
CREATE TABLE IF NOT EXISTS connector_parity_credentials (
  tenant_id UUID NOT NULL,
  connector_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  credential_ref UUID NOT NULL,
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) >= 28),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connector_id, revision, credential_ref, credential_version),
  FOREIGN KEY (tenant_id, connector_id, revision)
    REFERENCES connector_parity_draft_intents (tenant_id, connector_id, revision)
);
