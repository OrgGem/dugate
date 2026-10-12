-- ORV14: durable, encrypted idempotency journal for Secret Catalog →
-- Connector credential imports. A pending import is replayed with the exact
-- sealed payload and Connector idempotency key; it is never re-resolved from
-- the mutable Catalog head.
CREATE TABLE IF NOT EXISTS connector_secret_imports (
  import_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  connector_id text NOT NULL CHECK (length(connector_id) BETWEEN 1 AND 128),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  source_secret_id uuid NOT NULL,
  source_revision integer NOT NULL CHECK (source_revision >= 1),
  source_key_version text NOT NULL CHECK (length(source_key_version) BETWEEN 1 AND 64),
  state text NOT NULL CHECK (state IN ('PENDING','COMPLETED')),
  resolved_payload jsonb NOT NULL,
  result jsonb,
  lease_token uuid,
  lease_until timestamptz,
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 256),
  created_by_issuer text,
  created_by_sub text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, connector_id, idempotency_key),
  FOREIGN KEY (source_secret_id, source_revision)
    REFERENCES secret_catalog_revisions(secret_id, revision) ON DELETE RESTRICT,
  CHECK ((state='PENDING' AND result IS NULL)
      OR (state='COMPLETED' AND result IS NOT NULL AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK ((lease_token IS NULL AND lease_until IS NULL)
      OR (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS connector_secret_imports_pending_idx
  ON connector_secret_imports (lease_until)
  WHERE state='PENDING';

CREATE OR REPLACE FUNCTION reject_connector_secret_import_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state='COMPLETED' THEN
    RAISE EXCEPTION 'completed connector secret imports are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.import_id<>OLD.import_id OR NEW.tenant_id<>OLD.tenant_id
     OR NEW.connector_id<>OLD.connector_id OR NEW.idempotency_key<>OLD.idempotency_key
     OR NEW.request_hash<>OLD.request_hash OR NEW.source_secret_id<>OLD.source_secret_id
     OR NEW.source_revision<>OLD.source_revision OR NEW.source_key_version<>OLD.source_key_version
     OR NEW.resolved_payload<>OLD.resolved_payload OR NEW.created_by<>OLD.created_by
     OR NEW.created_by_issuer IS DISTINCT FROM OLD.created_by_issuer
     OR NEW.created_by_sub IS DISTINCT FROM OLD.created_by_sub OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'connector secret import identity and sealed payload are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.state='COMPLETED' AND NEW.result IS NULL THEN
    RAISE EXCEPTION 'completed connector secret imports require a result' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS connector_secret_imports_immutable ON connector_secret_imports;
CREATE TRIGGER connector_secret_imports_immutable
  BEFORE UPDATE ON connector_secret_imports
  FOR EACH ROW EXECUTE FUNCTION reject_connector_secret_import_mutation();

CREATE OR REPLACE FUNCTION reject_connector_secret_import_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'connector secret import journal is append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS connector_secret_imports_no_delete ON connector_secret_imports;
CREATE TRIGGER connector_secret_imports_no_delete
  BEFORE DELETE ON connector_secret_imports
  FOR EACH ROW EXECUTE FUNCTION reject_connector_secret_import_delete();
