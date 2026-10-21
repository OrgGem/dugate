-- PC-02 (PROFILE-CONTROL-PLANE): group-root authority, explicit key modes,
-- root-grant ledger, historical author metadata and request defaults.
--
-- Forward-only and additive, matching the runner contract
-- (`src/db/migrations.ts` applies one file per transaction and records one
-- SHA-256 ledger row; there are no down migrations). Statements are still
-- written to tolerate repeat execution (IF NOT EXISTS / duplicate_object
-- guarded ADD CONSTRAINT) exactly like 0026/0028/0065.
--
-- Ordering inside this file is load-bearing:
--   1. `api_keys.key_mode` is added and populated in the SAME transaction that
--      exposes it, because the PC-04 resolver fails closed on NULL/unknown.
--      Two separate files would open a window where every key denies.
--   2. `api_keys (id, tenant_id)` uniqueness must exist before the grant
--      ledger's `(api_key_id, tenant_id)` composite FK can be created.
--   3. `profile_groups` columns must exist before the ledger's
--      `(group_id, tenant_id)` composite FK can be created.

-- ---------------------------------------------------------------------------
-- 1. Explicit key mode (plan: "Settled data and authorization model", item 2)
-- ---------------------------------------------------------------------------
-- Deliberately nullable with NO default: a writer that forgets to declare a
-- mode must fail closed at authorization, not silently mint an
-- `UNMANAGED_LEGACY` key that skips profile authorization. A DEFAULT here
-- would convert a deployment mistake into a privilege decision.
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS key_mode text
    CONSTRAINT api_keys_key_mode_check
    CHECK (key_mode IS NULL OR key_mode IN ('GROUP_MANAGED', 'LEGACY_STANDALONE', 'UNMANAGED_LEGACY'));

COMMENT ON COLUMN api_keys.key_mode IS
  'Explicit key authority mode. NULL/unknown is an authorization error (never a fallback). GROUP_MANAGED is set only by the group-key/grant operations.';

-- Deterministic, evidence-only classification. No key can become
-- GROUP_MANAGED here because no grant row exists yet.
--
--   LEGACY_STANDALONE  <- the key has ANY historic profile/group footprint:
--                         a membership row in any state (ACTIVE or REVOKED
--                         tombstone), a revision it authored, a registry row
--                         naming it, or a group revision naming it.
--   UNMANAGED_LEGACY   <- the key has no footprint in any of those relations,
--                         i.e. it can only ever have been used by the legacy
--                         no-profile path.
--
-- "Zero ACTIVE memberships" is explicitly NOT the test: a key whose only rows
-- are REVOKED tombstones keeps LEGACY_STANDALONE semantics, and an empty
-- profile group's owning key has zero memberships but is still group-scoped.
UPDATE api_keys k
   SET key_mode = CASE
         WHEN EXISTS (SELECT 1 FROM profile_api_keys m        WHERE m.api_key_id = k.id)
           OR EXISTS (SELECT 1 FROM profile_bindings b        WHERE b.api_key_id = k.id)
           OR EXISTS (SELECT 1 FROM profile_names n           WHERE n.api_key_id = k.id)
           OR EXISTS (SELECT 1 FROM profile_group_revisions r WHERE r.api_key_id = k.id)
         THEN 'LEGACY_STANDALONE'
         ELSE 'UNMANAGED_LEGACY'
       END
 WHERE k.key_mode IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Tenant-safe FK target for api_keys
-- ---------------------------------------------------------------------------
-- 0001 makes `api_keys.id` the primary key and nothing else, so a composite
-- `(api_key_id, tenant_id)` FK has no target. A unique index (not only a
-- constraint) is a legal FK target in PostgreSQL and is re-runnable with
-- IF NOT EXISTS, so the index form is used here. The column order matches the
-- FK columns in section 4.
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_id_tenant_unique
  ON api_keys (id, tenant_id);

-- ---------------------------------------------------------------------------
-- 3. Group root authority (plan items 1 and 4)
-- ---------------------------------------------------------------------------
-- `auth_mode` is the authentication mechanism the root will accept. Only
-- 'API_KEY' is defined today; extending the enum is a new migration, not a
-- silent writer decision.
--
-- `auth_authority` is the authority SOURCE, and the default is the
-- non-granting one on purpose: every existing group starts as
-- CHILD_PROJECTION (exactly today's behavior) and only the gated PC-03
-- conversion moves a group to GROUP_GRANT. Nothing becomes GROUP_GRANT by
-- merely deploying this file.
--
-- `access_version` is the grant-ledger CAS counter. It starts at 1 for
-- existing rows so a client's first If-Match has a real value, and only
-- grant/revoke increments it; config publish/rollback must not.
ALTER TABLE profile_groups
  ADD COLUMN IF NOT EXISTS auth_mode text NOT NULL DEFAULT 'API_KEY'
    CONSTRAINT profile_groups_auth_mode_check
    CHECK (auth_mode IN ('API_KEY')),
  ADD COLUMN IF NOT EXISTS auth_authority text NOT NULL DEFAULT 'CHILD_PROJECTION'
    CONSTRAINT profile_groups_auth_authority_check
    CHECK (auth_authority IN ('CHILD_PROJECTION', 'GROUP_GRANT')),
  ADD COLUMN IF NOT EXISTS access_version bigint NOT NULL DEFAULT 1
    CONSTRAINT profile_groups_access_version_positive CHECK (access_version > 0);

COMMENT ON COLUMN profile_groups.auth_authority IS
  'CHILD_PROJECTION = legacy child-membership authority; GROUP_GRANT = root grant ledger authority. Cutover is one-way per group.';
COMMENT ON COLUMN profile_groups.access_version IS
  'Grant-ledger CAS counter. Incremented only by grant/revoke, never by config publish or rollback.';

-- ---------------------------------------------------------------------------
-- 4. Root grant ledger (plan item 3)
-- ---------------------------------------------------------------------------
-- One row per managed API key, permanently bound to at most one group: the
-- primary key is `api_key_id`, so "this key was granted to another group" is
-- impossible even after the old row is revoked. A (group_id, api_key_id) key
-- plus a separate unique index on api_key_id would express the same rule with
-- one redundant index, so the key column is the primary key.
--
-- Revoked rows stay as tombstones (`state='REVOKED'`, revoked_* filled). A
-- re-grant of the same key to the same group is an UPDATE of this row; the
-- previous revocation remains in `admin_audit_events`. Durable in-table grant
-- history is out of scope for PC-02.
CREATE TABLE IF NOT EXISTS profile_group_api_keys (
  api_key_id        uuid PRIMARY KEY,
  group_id          uuid NOT NULL,
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  state             text NOT NULL DEFAULT 'ACTIVE'
    CONSTRAINT profile_group_api_keys_state_check CHECK (state IN ('ACTIVE', 'REVOKED')),
  granted_at        timestamptz NOT NULL DEFAULT now(),
  granted_by        text NOT NULL
    CONSTRAINT profile_group_api_keys_granted_by_shape
    CHECK (length(btrim(granted_by)) BETWEEN 1 AND 256),
  granted_by_issuer text,
  granted_by_sub    text,
  revoked_at        timestamptz,
  revoked_by        text
    CONSTRAINT profile_group_api_keys_revoked_by_shape
    CHECK (revoked_by IS NULL OR length(btrim(revoked_by)) BETWEEN 1 AND 256),
  revoked_by_issuer text,
  revoked_by_sub    text,
  CONSTRAINT profile_group_api_keys_group_tenant_fk
    FOREIGN KEY (group_id, tenant_id)
    REFERENCES profile_groups (group_id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT profile_group_api_keys_key_tenant_fk
    FOREIGN KEY (api_key_id, tenant_id)
    REFERENCES api_keys (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT profile_group_api_keys_revocation_shape CHECK (
    (state = 'ACTIVE'
      AND revoked_at IS NULL AND revoked_by IS NULL
      AND revoked_by_issuer IS NULL AND revoked_by_sub IS NULL)
    OR (state = 'REVOKED' AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
  )
);

-- Admission reads a key's current grant; the primary key already serves it.
-- Listing a group's current grants is the other direction.
CREATE INDEX IF NOT EXISTS profile_group_api_keys_group_active
  ON profile_group_api_keys (group_id, api_key_id)
  WHERE state = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- 5. Historical author metadata and Admin actor attribution (plan item 4)
-- ---------------------------------------------------------------------------
-- `api_key_id` stops being an authorization input and becomes optional
-- history: a v2 group append has no API key at all. Nothing is rewritten, so
-- a legacy author id survives the cutover verbatim.
ALTER TABLE profile_bindings        ALTER COLUMN api_key_id DROP NOT NULL;
ALTER TABLE profile_names           ALTER COLUMN api_key_id DROP NOT NULL;
ALTER TABLE profile_group_revisions ALTER COLUMN api_key_id DROP NOT NULL;

-- The Admin actor that produced a revision, in the same shape 0060 uses for
-- `connector_secret_imports` (stable actor string + OIDC issuer/subject).
-- Never a credential, never a raw API key.
ALTER TABLE profile_bindings
  ADD COLUMN IF NOT EXISTS created_by text
    CONSTRAINT profile_bindings_created_by_shape
    CHECK (created_by IS NULL OR length(btrim(created_by)) BETWEEN 1 AND 256),
  ADD COLUMN IF NOT EXISTS created_by_issuer text,
  ADD COLUMN IF NOT EXISTS created_by_sub text;

ALTER TABLE profile_group_revisions
  ADD COLUMN IF NOT EXISTS created_by text
    CONSTRAINT profile_group_revisions_created_by_shape
    CHECK (created_by IS NULL OR length(btrim(created_by)) BETWEEN 1 AND 256),
  ADD COLUMN IF NOT EXISTS created_by_issuer text,
  ADD COLUMN IF NOT EXISTS created_by_sub text;

-- Every revision stays attributable even after the author key id becomes
-- optional: either the historical key or a recorded Admin actor. Existing
-- rows satisfy this because api_key_id was NOT NULL until this file.
DO $$ BEGIN
  ALTER TABLE profile_bindings
    ADD CONSTRAINT profile_bindings_attribution_shape
    CHECK (api_key_id IS NOT NULL OR created_by IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE profile_group_revisions
    ADD CONSTRAINT profile_group_revisions_attribution_shape
    CHECK (api_key_id IS NOT NULL OR created_by IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A registry row must be reachable through exactly one ownership path: a
-- legacy author key (standalone profile) or a group (grouped child). A row
-- with neither is unreachable by every resolver and only hides a bug.
DO $$ BEGIN
  ALTER TABLE profile_names
    ADD CONSTRAINT profile_names_owner_shape
    CHECK (api_key_id IS NOT NULL OR group_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Per-function request defaults (plan item 4)
-- ---------------------------------------------------------------------------
-- Existing and v1 revisions read as '{}' (a real "no defaults declared"
-- value, not NULL), so adding this column changes no current resolution.
ALTER TABLE profile_bindings
  ADD COLUMN IF NOT EXISTS request_defaults jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT profile_bindings_request_defaults_object
    CHECK (jsonb_typeof(request_defaults) = 'object');

COMMENT ON COLUMN profile_bindings.request_defaults IS
  'Per-field {value,isLocked?} records that fill absent request input under the manifest parameterResolution capability. Immutable with the revision.';

-- ---------------------------------------------------------------------------
-- 7. Name registry uniqueness (plan item 4)
-- ---------------------------------------------------------------------------
-- The 0028 index scoped a name by its authoring key for EVERY row. That is
-- wrong for group children (their author key becomes historical and may be
-- NULL, and NULL keys make a unique index treat every row as distinct), so it
-- is replaced by two scope-correct partial indexes:
--   * standalone names keep the exact 0028 tuple;
--   * grouped children are unique per tenant+group, which is the scope the
--     group editor and the child lookup actually use.
--
-- The replacement deliberately keeps the object NAME `profile_names_identity`.
-- `src/db/migrations.ts` (declaredSchemaObjects / recordedMigrationsMissingObjects)
-- treats every object a recorded migration declared as required forever, so
-- dropping the name without recreating it fails migrate/status/verify and the
-- startup schema gate for 0028.
DROP INDEX IF EXISTS profile_names_identity;

CREATE UNIQUE INDEX IF NOT EXISTS profile_names_identity
  ON profile_names (tenant_id, api_key_id, business_id, business_version, action, profile_name)
  WHERE group_id IS NULL;

COMMENT ON INDEX profile_names_identity IS
  'Legacy standalone name identity (tenant, author key, business, version, action, name). Scope narrowed to group_id IS NULL by 0070; 0028 created the same tuple without that predicate.';

CREATE UNIQUE INDEX IF NOT EXISTS profile_names_group_identity
  ON profile_names (tenant_id, group_id, profile_name)
  WHERE group_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 8. Lookup indexes
-- ---------------------------------------------------------------------------
-- Key lifecycle and audit: "which immutable group revisions did this key
-- author". Partial because the id becomes optional history.
CREATE INDEX IF NOT EXISTS profile_group_revisions_author
  ON profile_group_revisions (api_key_id)
  WHERE api_key_id IS NOT NULL;
