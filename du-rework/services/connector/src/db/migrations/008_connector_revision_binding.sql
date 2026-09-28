-- W-VAULT01-BIND-1R (VAULT-01): trusted (tenant_id, connector_id, account_id) binding
-- for connector credential revisions. Fixes the review finding that revision
-- storage keyed revisions by connector_id alone, so neither the row nor any
-- constraint stated which tenant/account owns a pinned credential source.
--
-- Legacy compatibility: every existing row is normalized to an explicit UNBOUND
-- binding (tenant_id = '') by the column default, so backfill can
-- never be read as a tenant claim. Legacy rows keep working through the
-- unbound-selector path in the repository: they keep the shared pre-binding
-- (provider-account) semantics until VAULT-06 migrates them, and can never be
-- written as a bound row. No down migration — same discipline as 005..007.
-- Re-running converges (each guarded ALTER/CREATE is idempotent or replaceable).

ALTER TABLE connector_revisions
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT '';

ALTER TABLE connector_revisions
  ADD COLUMN IF NOT EXISTS account_id TEXT;

ALTER TABLE connector_revisions
  ALTER COLUMN tenant_id SET NOT NULL;

-- Revisions are numbered within a trusted tenant chain by the repository.
-- The legacy key (connector_id, revision) would collide when two tenants use
-- the same connector id and each starts at revision 1.
ALTER TABLE connector_revisions
  DROP CONSTRAINT IF EXISTS connector_revisions_pkey;
ALTER TABLE connector_revisions
  ADD CONSTRAINT connector_revisions_pkey PRIMARY KEY (connector_id, tenant_id, revision);

-- Extract the account coordinate from a vault-kv2 ref; NULL for every other
-- source kind (legacy-db and NULL sources stay account-agnostic).
CREATE OR REPLACE FUNCTION connector_revision_account_id(credential_source JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $fn$
  CASE WHEN credential_source ->> 'kind' = 'vault-kv2'
       THEN split_part(credential_source ->> 'path', '/', 7)
       ELSE NULL
  END
$fn$;

UPDATE connector_revisions
   SET account_id = connector_revision_account_id(credential_source)
 WHERE account_id IS DISTINCT FROM connector_revision_account_id(credential_source)
   AND connector_revision_account_id(credential_source) IS NOT NULL;

-- Chain guards. credential_ref is the lookup key used by secret_versions, so
-- a Vault-bound ref must be unique to one tenant/connector/account chain.
-- Pre-binding legacy rows may continue sharing an unbound ref; a ref can never
-- mix those rows with a tenant-bound Vault chain.
--   * two ACTIVE rows in one chain            -> 23514
--   * one chain bound by two tenants         -> 23514
--   * a tenant-bound chain using legacy-db   -> 23514 (binding must come from
--     a vault ref whose embedded tenant the grant check can police)
CREATE OR REPLACE FUNCTION connector_revision_chain_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_source       JSONB;
  v_chain_tenant TEXT;
  v_chain_connector TEXT;
  v_chain_account TEXT;
BEGIN
  -- A bound chain may not cross tenant, connector, account, or credential
  -- source. Two explicitly unbound legacy rows remain compatible with the
  -- pre-binding shared-secret model.
  SELECT other.tenant_id, other.connector_id, other.credential_source, other.account_id
    INTO v_chain_tenant, v_chain_connector, v_source, v_chain_account
    FROM connector_revisions other
   WHERE other.credential_ref = NEW.credential_ref
     AND ROW(other.connector_id, other.tenant_id, other.revision)
         <> ROW(NEW.connector_id, NEW.tenant_id, NEW.revision)
     AND (other.tenant_id <> NEW.tenant_id
          OR (NEW.tenant_id <> ''
              AND (other.connector_id <> NEW.connector_id
                   OR COALESCE(other.credential_source ->> 'kind', 'legacy-db') = 'legacy-db'
                   OR COALESCE(NEW.credential_source ->> 'kind', 'legacy-db') = 'legacy-db'
                   OR other.account_id IS DISTINCT FROM NEW.account_id)))
   ORDER BY other.revision
   LIMIT 1;
  IF FOUND THEN
    IF v_chain_tenant <> NEW.tenant_id THEN
      RAISE EXCEPTION 'connector revision chain is already bound to another tenant'
        USING ERRCODE = '23514';
    END IF;
    IF v_chain_connector <> NEW.connector_id THEN
      RAISE EXCEPTION 'credential_ref cannot be shared between tenant-bound connectors'
        USING ERRCODE = '23514';
    END IF;
    IF COALESCE(v_source ->> 'kind', 'legacy-db') = 'legacy-db'
       OR COALESCE(NEW.credential_source ->> 'kind', 'legacy-db') = 'legacy-db' THEN
      RAISE EXCEPTION 'tenant-bound connector revision chains must not use legacy-db credentials'
        USING ERRCODE = '23514';
    END IF;
    IF v_chain_account IS DISTINCT FROM NEW.account_id THEN
      RAISE EXCEPTION 'connector revision chain account binding cannot change'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- At most one ACTIVE per chain, checked across ALL chain rows.
  IF NEW.state = 'ACTIVE' THEN
    PERFORM 1
      FROM connector_revisions other
     WHERE other.connector_id = NEW.connector_id
       AND other.credential_ref = NEW.credential_ref
       AND other.state = 'ACTIVE'
       AND ROW(other.tenant_id, other.revision) <> ROW(NEW.tenant_id, NEW.revision);
    IF FOUND THEN
      RAISE EXCEPTION 'connector revision chain % (tenant %, ref %) already has an ACTIVE row',
                      NEW.connector_id, NEW.tenant_id, NEW.credential_ref
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS connector_revisions_chain_guard ON connector_revisions;
CREATE TRIGGER connector_revisions_chain_guard
  BEFORE INSERT OR UPDATE OF state, credential_ref, credential_source, tenant_id
  ON connector_revisions
  FOR EACH ROW
  EXECUTE FUNCTION connector_revision_chain_guard();

-- Row invariants (column shape + credential_source/column agreement).
ALTER TABLE connector_revisions
  DROP CONSTRAINT IF EXISTS connector_revisions_tenant_id_shape;
ALTER TABLE connector_revisions
  ADD CONSTRAINT connector_revisions_tenant_id_shape
  CHECK (tenant_id = '' OR tenant_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$');

ALTER TABLE connector_revisions
  DROP CONSTRAINT IF EXISTS connector_revisions_account_id_shape;
ALTER TABLE connector_revisions
  ADD CONSTRAINT connector_revisions_account_id_shape
  CHECK (account_id IS NULL OR account_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$');

ALTER TABLE connector_revisions
  DROP CONSTRAINT IF EXISTS connector_revisions_credential_source_shape;
ALTER TABLE connector_revisions
  ADD CONSTRAINT connector_revisions_credential_source_shape
  CHECK (credential_source IS NULL OR jsonb_typeof(credential_source) = 'object');

ALTER TABLE connector_revisions
  DROP CONSTRAINT IF EXISTS connector_revisions_credential_source_kind;
ALTER TABLE connector_revisions
  ADD CONSTRAINT connector_revisions_credential_source_kind
  CHECK (credential_source IS NULL
         OR credential_source ->> 'kind' IN ('legacy-db', 'vault-kv2'));

ALTER TABLE connector_revisions
  DROP CONSTRAINT IF EXISTS connector_revisions_account_matches_source;
ALTER TABLE connector_revisions
  ADD CONSTRAINT connector_revisions_account_matches_source
  CHECK (account_id IS NULL
         OR account_id = connector_revision_account_id(credential_source));

-- The vault ref must carry exactly this row's binding: same account and the
-- canonical 7-segment du/tenants/{tenant}/connectors/{connector}/accounts/{account}
-- path built from THIS row's tenant_id/connector_id/account_id.
ALTER TABLE connector_revisions
  DROP CONSTRAINT IF EXISTS connector_revisions_vault_path_matches_binding;
ALTER TABLE connector_revisions
  ADD CONSTRAINT connector_revisions_vault_path_matches_binding
  CHECK (jsonb_typeof(credential_source) <> 'object'
         OR credential_source ->> 'kind' <> 'vault-kv2'
         OR (
               account_id IS NOT NULL
           AND credential_source ->> 'account' = account_id
           AND split_part(credential_source ->> 'path', '/', 1) = 'du'
           AND split_part(credential_source ->> 'path', '/', 2) = 'tenants'
           AND split_part(credential_source ->> 'path', '/', 3) = tenant_id
           AND split_part(credential_source ->> 'path', '/', 4) = 'connectors'
           AND split_part(credential_source ->> 'path', '/', 5) = connector_id
           AND split_part(credential_source ->> 'path', '/', 6) = 'accounts'
           AND split_part(credential_source ->> 'path', '/', 7) = account_id
           AND split_part(credential_source ->> 'path', '/', 8) = ''
         ));

-- Tenant-bound rows may never carry legacy-db credentials: the binding is
-- only meaningful while the credential travels with a vault ref whose tenant
-- segment the DB can police.
ALTER TABLE connector_revisions
  DROP CONSTRAINT IF EXISTS connector_revisions_bound_source_is_vault;
ALTER TABLE connector_revisions
  ADD CONSTRAINT connector_revisions_bound_source_is_vault
  CHECK (tenant_id = ''
         OR COALESCE(credential_source ->> 'kind', 'legacy-db') = 'vault-kv2');
