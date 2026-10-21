# PREP-PC-02 — Storage migration and conversion-gate design (PC-02)

| Field | Value |
|---|---|
| Packet | PREP-PC-02 (pre-analysis for **PC-02 Storage migration and conversion gate**) |
| Role | DeepSeek Worker 3 — Database & Storage Specialist |
| Master plan | [`du-rework/tasks/PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md`](../../tasks/PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md) §Work packages PC-02, §Settled data and authorization model |
| File lease (READ-ONLY) | `orchestrator/services/orchestrator/migrations/`, `…/src/modules/profiles/`, `…/src/modules/identity/` |
| Source files modified | **None.** This packet is read-only; the only file written is this report. |
| Proposed artifact | `orchestrator/services/orchestrator/migrations/0070_profile_control_plane_storage.sql` |
| Status | Design validated against a disposable PostgreSQL 16.11 instance; not applied to any project database. |

## 0. TL;DR

**Vietnamese**

1. Prefix tiếp theo là **`0070`** (66 file hiện có, file cao nhất `0069_required_data.sql`; các số `0053/0058/0062` chưa từng được commit nên là khoảng trống lịch sử, không phải file bị xoá). Runner chỉ yêu cầu prefix 4 chữ số **duy nhất** và sắp xếp theo tên, không yêu cầu liên tục.
2. Đề xuất **một file migration duy nhất** gồm 8 khối: `api_keys.key_mode` + backfill phân loại, unique index `(id, tenant_id)`, 3 cột authority trên `profile_groups`, bảng `profile_group_api_keys`, nới `api_key_id` + cột `created_by`, `request_defaults`, thay thế unique index của `profile_names`, index tra cứu.
3. **Phát hiện chặn (blocker) có bằng chứng**: nếu `DROP INDEX profile_names_identity` mà không tạo lại cùng tên, runner sẽ báo *object drift* cho migration `0028` và **`migrate`/`migrate:status`/`migrate:verify` + bước verify lúc khởi động đều fail**. Thiết kế dưới đây tạo lại index **đúng tên cũ** với định nghĩa mới — đã kiểm chứng `missing_declared_objects = 0`.
4. Backfill `key_mode` là **tất định và toàn phần**: mọi key đều rơi vào `LEGACY_STANDALONE` (có bất kỳ dấu vết profile/group nào, kể cả tombstone REVOKED) hoặc `UNMANAGED_LEGACY` (không có dấu vết nào). Không key nào thành `GROUP_MANAGED` trong migration; không key nào bị đoán.
5. Có **16 truy vấn inventory chạy trước migration** và **9 truy vấn xác minh sau migration**, tất cả đã chạy thật trên PostgreSQL 16.
6. Có **4 hệ quả bắt buộc cho PC-03/PC-04** (mục 5): mọi đường issue/rotate phải set `key_mode`; grant/revoke tăng `access_version` (publish/rollback thì không); append nhóm phải set `created_by` và **không được quên `request_defaults`** (DEFAULT `'{}'` sẽ âm thầm xoá default cũ); reader phải fail-closed khi `key_mode` NULL.

**English**

- Next free prefix is **`0070`**; one migration file, additive, checksum-managed, no down migration.
- **Validated blocker:** the runner's declared-object drift guard (`migrations.ts:480-524`) refuses to start if an object declared by an applied migration disappears. Dropping `profile_names_identity` (declared by `0028`) therefore breaks `migrate`, `status`, `verify` and the default startup gate. The design recreates that index under its original name with the new partial predicate; a full-chain run then reports **0 missing declared objects**.
- Key-mode classification is deterministic and total, never guesses, and never produces `GROUP_MANAGED`.
- Delivered: full draft DDL (validated), 16 pre-migration inventory queries, 9 post-migration verification queries, optional hardening, test plan, open questions.

## 1. Evidence boundary

What was inspected and how:

| Level | Method |
|---|---|
| Source (read) | `migrations/` (all 66 files), `src/db/migrations.ts`, `src/modules/profiles/*`, `src/modules/identity/api-keys.ts`, `src/app/bootstrap/create-app.ts`, `src/http/routes/api-key-auth.ts`, `apps`/contracts referenced by the plan |
| Git history (read) | Every migration filename ever committed on any branch: 66 distinct files, none of `0053/0058/0062` |
| SQL validation (scratch) | Disposable `postgres:16-alpine` container outside the project: full chain `0001…0069` + draft `0070` applied, re-run for idempotency, plus a *legacy-data-then-migrate* upgrade path |
| Behaviour tests | 16 constraint assertions (valid rows accepted, invalid rows rejected), classification on 6 crafted keys incl. tombstone-only / empty-group-owner / never-associated, ambiguity and shared-key detectors with positive cases, 4 hardening guards |
| Migration runner | Not executed here (no `schema_migrations` ledger in a hand-built schema). Its behaviour was read from source and its declared-object extractor was **re-implemented and run** against the live scratch schema to prove the drift claim (section 2.1) |

Not verified (must not be inferred from this report): production row counts, index build duration on real data, behaviour of a live ledger, actual PC-03/PC-04/PC-05 code (does not exist yet), and any deployment/rollout claim.

## 2. Repository facts the design depends on

### 2.1 Migration runner contract (`src/db/migrations.ts`)

| Fact | Consequence for PC-02 |
|---|---|
| Filename filter `^\d{4}_.*\.sql$`, sorted by name, **duplicate sequences rejected** (`:66-91`) | Sequences must be unique and monotonic; gaps are legal. |
| Checksum = SHA-256 over SQL after CRLF→LF (`:62-64`) | Any later edit of the shipped file is drift. Freeze before deploy. |
| Each pending file runs in **its own transaction** with its ledger row (`:357-368`) | Schema + backfill for one concern must live in **one file** (see D-01). |
| Advisory lock around plan + apply (`:286`) | Concurrent service starts cannot double-apply. |
| Declared-object drift guard (`:480-524`): scans line-leading `CREATE [UNIQUE] TABLE/INDEX [CONCURRENTLY] [IF NOT EXISTS] <name>`, then requires `information_schema.tables` **or** `pg_indexes` to still contain each name | **A migration may not remove an object an earlier migration declared.** See 2.2. |
| Startup: `migrate()` when `autoMigrate`, else `verifyMigrations()` (`create-app.ts:492-496`); `DU_MIGRATION_ENABLED=false` bypasses | The drift guard is on the boot path of every image. |

### 2.2 Validated blocker: replacing `profile_names_identity`

`0028_profile_name.sql:33` declares `profile_names_identity` as a line-leading `CREATE UNIQUE INDEX`. A naive replacement in `0070`:

```sql
DROP INDEX profile_names_identity;   -- 0028's declared object disappears
CREATE UNIQUE INDEX profile_names_legacy_identity …;
```

was applied to a scratch database and the runner's extractor re-run. Result:

```
MISSING: profile_names_identity  <- declared by 0028_profile_name.sql
missing_count=1
```

`recordedMigrationsMissingObjects` would then abort with *"refusing to skip recorded migrations against an incomplete schema"*, blocking `migrate`, `status`, `verify` and the startup gate. There is **no allowlist** in the runner and `src/db/migrations.ts` is outside the PC-02 lease, so the migration must accommodate the guard:

> **Rule adopted:** the replacement index keeps the object name `profile_names_identity`; only its definition (add `WHERE group_id IS NULL`) changes. A `COMMENT ON INDEX` records the scope change.

After the fix the same check reports `declared=228 missing=0` (section 12, E-07/E-08).

### 2.3 Current highest sequence and next prefix

| Check | Result |
|---|---|
| Files in `migrations/` | 66 `*.sql` |
| Highest | `0069_required_data.sql` |
| Gaps | `0053`, `0058`, `0062` — never committed on any branch (`git log --all`) |
| Contiguity required by runner | No — uniqueness + sort only |
| **Next free prefix** | **`0070`** |
| Recommended name | `0070_profile_control_plane_storage.sql` |

The ledger (`schema_migrations`) records only *applied* files, so it cannot reserve a sequence; the directory plus the "never committed" check above is the strongest available evidence.

### 2.4 Storage touched by PC-02, as it stands today

| Relation | Declared in | Relevant current state |
|---|---|---|
| `api_keys` | `0001:14-21`, `0024:80`, `0054:9-11` | PK `(id)` only; `hash UNIQUE`, `prefix`, `status`, `name`, `version`, `updated_at`. **No `(id, tenant_id)` uniqueness.** |
| `profile_groups` | `0067:5-14` | `active_revision` CAS pointer; `UNIQUE (tenant_id, name)`; `UNIQUE (group_id, tenant_id)` (the composite-FK target we need). |
| `profile_group_revisions` | `0067:16-27` | `api_key_id uuid **NOT NULL** REFERENCES api_keys(id)`; composite tenant FK to `profile_groups`. |
| `profile_group_members` | `0067:38-62` | pins `(profile_id, binding_revision)`; child must exist in `profile_names (profile_id, group_id)`. |
| `profile_bindings` | `0004:14-26`, `0026`, `0033`, `0036`, `0041`, `0044` | `api_key_id uuid **NOT NULL**`; policy columns; `endpoint_slug`; PK `(profile_id, revision)`. |
| `profile_names` | `0028:22-34`, `0067:67-85` | `api_key_id uuid **NOT NULL**`; `group_id` nullable; `CREATE UNIQUE INDEX profile_names_identity (tenant_id, api_key_id, business_id, business_version, action, profile_name)` — **all rows**; `UNIQUE (profile_id, group_id)`. |
| `profile_api_keys` | `0039:24-50` | membership set with `ACTIVE|REVOKED` tombstones; the only current authorization edge between keys and profiles. |
| `profile_active_revisions` | `0027:32-41` | pointer table; read path refuses to fall back to `MAX(revision)`. |
| `admin_idempotency` | `0012:17-28` | generic admin POST replay store; reusable for grant mutations (see D-12). |

## 3. Design decisions

Each decision lists the rejected alternative, so a reviewer can reverse one without re-deriving the rest.

**D-01 — One migration file, not "schema file + backfill file".**
`key_mode` must be populated in the same transaction that exposes the column. The runner commits each file separately, so two files leave a window where PC-04 readers (which fail closed) see `NULL` for every key — a total authentication outage if the second file fails or the deploy stops between them. Rejected: `0070` schema + `0071` classification.

**D-02 — `api_keys.key_mode` is nullable with **no default** and a closed-value CHECK.**
The plan says a missing/unknown value is an authorization error. A `DEFAULT 'UNMANAGED_LEGACY'` would convert a forgotten writer into a privilege decision (an unmanaged key bypasses profile authorization). Rejected: `NOT NULL DEFAULT 'UNMANAGED_LEGACY'`; rejected: backfilling only "used" keys.

**D-03 — Classification is total and evidence-only.** A key is `LEGACY_STANDALONE` iff **any** of these exist: a `profile_api_keys` row in **any** state (active or REVOKED tombstone), a `profile_bindings` row it authored, a `profile_names` row naming it, or a `profile_group_revisions` row naming it. Otherwise `UNMANAGED_LEGACY`. This matches the plan's "any historical membership cannot become unmanaged", keeps tombstone-only keys standalone, and keeps the **empty-group owning key** (zero memberships today — see `profile-groups.ts:321-339`) out of the unmanaged class. Rejected: "zero ACTIVE memberships ⇒ unmanaged" (explicitly forbidden by the plan and falsified by the empty-group case).

**D-04 — `auth_mode` defaults to `'API_KEY'` with a single-value CHECK.** The enum is closed on purpose; adding a mode later is a new migration rather than an unconstrained text column.

**D-05 — `auth_authority` defaults to `'CHILD_PROJECTION'`.** Deploying `0070` must not change any group's authority. Only the gated PC-03 conversion writes `'GROUP_GRANT'`. Rejected: defaulting new rows to `GROUP_GRANT` in the schema (a migration cannot know which groups are v2).

**D-06 — `access_version bigint NOT NULL DEFAULT 1 CHECK (> 0)`.** `bigint` matches `business_catalog.activation_revision` (`0068:7`). Non-decreasing enforcement is offered as optional hardening H-1 because a silent decrement would break `If-Match` CAS without any error.

**D-07 — Grant ledger primary key is `api_key_id`.**
"Each managed key ID is permanently associated with at most one group, unique across active and revoked rows" is exactly a key column PK. A `(group_id, api_key_id)` PK plus a separate `UNIQUE (api_key_id)` expresses the same rule with one redundant index. Consequence: re-granting the same key to the same group is an `UPDATE` of the tombstone row; grant history is carried by `admin_audit_events`, not by an in-table event log (out of scope, see D-12).

**D-08 — `api_keys (id, tenant_id)` uniqueness, created as a unique **index**.**
`0001` gives `api_keys` only `PRIMARY KEY (id)`, so the ledger's `(api_key_id, tenant_id)` composite FK has no target. A non-partial unique index is a legal FK target in PostgreSQL (validated: the FK was created successfully) and `CREATE UNIQUE INDEX IF NOT EXISTS` is re-runnable, unlike `ADD CONSTRAINT`. The redundant index costs one small index write per key insert.

**D-09 — Nullable author id **plus** mandatory attribution.**
`api_key_id` becomes optional historical metadata on all three relations (`profile_bindings`, `profile_names`, `profile_group_revisions`), because v2 group writes have no key. The Admin actor is recorded separately in the repository's existing shape (`created_by` + `created_by_issuer` + `created_by_sub`, exactly as `0060:19-21`). A CHECK keeps every revision attributable: `api_key_id IS NOT NULL OR created_by IS NOT NULL`. Existing rows satisfy it because the column was `NOT NULL` until this file. Rejected: reusing `api_key_id` to store a synthetic actor id (breaks tenant FKs and the "never a credential" rule).

**D-10 — `request_defaults jsonb NOT NULL DEFAULT '{}'` with `jsonb_typeof(...) = 'object'`.**
`'{}'` (not `NULL`) makes existing and v1 revisions read as "no defaults declared", which is the plan's required v1 semantics. The object CHECK prevents a malformed row from crashing the resolver with a 503; `parameters` has no such CHECK, but it is also never `NOT NULL`-validated in code, so this is a deliberate small divergence. **No backfill** is needed or wanted.

**D-11 — Name uniqueness is replaced, but the 0028 object name is preserved.** See 2.2. New definitions:

- `profile_names_identity` → `UNIQUE (tenant_id, api_key_id, business_id, business_version, action, profile_name) WHERE group_id IS NULL` (standalone rows keep exactly the 0028 tuple).
- `profile_names_group_identity` → `UNIQUE (tenant_id, group_id, profile_name) WHERE group_id IS NOT NULL` (grouped children are scoped by group; this is the predicate `profile-groups.ts:486-491` uses).

Rationale for the group-scoped key: for a group child the author key becomes historical and is often `NULL`; NULLs are distinct in a unique index, so the old all-row index silently stops deduplicating exactly the rows v2 creates.

**D-12 — Deliberately not added.**
No grant-history/event table (audit ledger covers it); no grant idempotency table (`admin_idempotency` already provides replay with route + payload hash, `0012`); no workflow columns on `profile_groups` (PC-01/PC-06 own that decision); no per-tenant partitioning; no `key_mode` default; no down migration.

## 4. Draft migration — `0070_profile_control_plane_storage.sql`

Validated end-to-end. Section order is load-bearing (see comment block).

```sql
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
```

## 5. Object contract after `0070`

### 5.1 Columns

| Relation | Column | Type | Null | Default | Notes |
|---|---|---|---|---|---|
| `api_keys` | `key_mode` | `text` | YES | — | one of `GROUP_MANAGED`, `LEGACY_STANDALONE`, `UNMANAGED_LEGACY`; `NULL` = deny |
| `profile_groups` | `auth_mode` | `text` | NO | `'API_KEY'` | closed enum today |
| `profile_groups` | `auth_authority` | `text` | NO | `'CHILD_PROJECTION'` | `CHILD_PROJECTION` / `GROUP_GRANT` |
| `profile_groups` | `access_version` | `bigint` | NO | `1` | `> 0`, grant CAS counter |
| `profile_group_api_keys` | `api_key_id` | `uuid` | NO | — | PK; permanent single-group association |
| | `group_id` | `uuid` | NO | — | composite-tenant FK to `profile_groups` |
| | `tenant_id` | `uuid` | NO | — | FK to `tenants`, part of both composite FKs |
| | `state` | `text` | NO | `'ACTIVE'` | `ACTIVE` / `REVOKED` |
| | `granted_at` / `granted_by` (+ `_issuer`,`_sub`) | `timestamptz` / `text` | NO / NO | `now()` / — | actor is the Admin principal |
| | `revoked_at` / `revoked_by` (+ `_issuer`,`_sub`) | `timestamptz` / `text` | YES | — | filled together when revoked |
| `profile_bindings` | `api_key_id` | `uuid` | **YES** (was NO) | — | historical author |
| `profile_bindings` | `created_by`, `created_by_issuer`, `created_by_sub` | `text` | YES | — | Admin actor |
| `profile_bindings` | `request_defaults` | `jsonb` | NO | `'{}'` | must be a JSON object |
| `profile_names` | `api_key_id` | `uuid` | **YES** (was NO) | — | historical/registry author |
| `profile_group_revisions` | `api_key_id` | `uuid` | **YES** (was NO) | — | historical author |
| `profile_group_revisions` | `created_by`, `created_by_issuer`, `created_by_sub` | `text` | YES | — | Admin actor |

### 5.2 Indexes

| Index | Definition | Why |
|---|---|---|
| `api_keys_id_tenant_unique` | `UNIQUE (id, tenant_id)` | FK target for the tenant-safe grant FK (D-08) |
| `profile_group_api_keys_pkey` | `UNIQUE (api_key_id)` | one group per key, tombstones included |
| `profile_group_api_keys_group_active` | `(group_id, api_key_id) WHERE state='ACTIVE'` | group grant listing / admission |
| `profile_names_identity` (replaced) | `UNIQUE (tenant_id, api_key_id, business_id, business_version, action, profile_name) WHERE group_id IS NULL` | standalone name identity, 0028 tuple |
| `profile_names_group_identity` | `UNIQUE (tenant_id, group_id, profile_name) WHERE group_id IS NOT NULL` | grouped-child identity |
| `profile_group_revisions_author` | `(api_key_id) WHERE api_key_id IS NOT NULL` | key → group revisions (lifecycle, audit) |

Net index cost: 4 new, 1 rewritten in place. Unchanged: `profile_bindings_key_action`, `profile_bindings_legacy_selector`, `profile_names_group_id`, `profile_api_keys_key_lookup`, `profile_group_members_child`, `profile_group_revisions_history`.

## 6. Obligations this schema imposes on PC-03 / PC-04 / PC-05

These are not implementation instructions — they are contract obligations the DDL cannot enforce and that a reviewer should check in the later packets.

| # | Obligation | Why the schema cannot enforce it |
|---|---|---|
| O-1 | **Every** API-key creation path sets `key_mode` explicitly: `identity/api-keys.ts:202` (issue), `:279` (rotate), `admin-actions/dispatcher.ts:883` (`apikey.issue`), `:1212` (`apikey.rotate`), `app/bootstrap/create-app.ts:520` (dev fallback row). | `NULL` is a legal stored value and is defined as "deny". A forgotten writer produces a hard-to-diagnose 401, not a constraint error. |
| O-2 | Grant and revoke increment `profile_groups.access_version` in the same transaction; **config publish and rollback must not**. | The column only has a positivity CHECK (optional H-1 adds monotonicity). |
| O-3 | Group appends write `created_by` (+ issuer/sub) and **never** an arbitrary active key as author; group children must stop rewriting `profile_names.api_key_id` (`profile-groups.ts:518`, `:557`, `:842`). | The attribution CHECK only requires *some* attribution. |
| O-4 | Every child-revision copy path must carry `request_defaults` forward. `profiles.ts:809-836` lists columns explicitly and `carryForwardPolicy` copies the policy family only — a path that forgets the column silently gets `'{}'` from the DEFAULT and **drops configured defaults**. | A `DEFAULT` cannot distinguish "not configured" from "configured and not copied". |
| O-5 | Readers treat `NULL`/unknown `key_mode` as an authorization error, never as a mode. No fallback from grant → child membership. | Same as O-1. |
| O-6 | Grant inserts acquire `KEY SHARE` row locks on the referenced `profile_groups` and `api_keys` rows. The writer must already hold the plan's lock order (group roots sorted, then key rows sorted) so the FK's own lock acquisition never creates a key→group edge. | Foreign-key locks are implicit and invisible in the writer's SQL. |
| O-7 | The dev fallback row (`create-app.ts:520`, hash `dev-fallback-placeholder`) has no footprint, so `0070` classifies it `UNMANAGED_LEGACY`. It can never authenticate (its hash is not a SHA-256 of any raw key), but it is visible to key-admin listings. Decide: leave as a documented non-credential, or block it from the rotate path in PC-04. | Classification cannot know it is a fixture. |
| O-8 | Grant/revoke idempotency must use a `route` string that embeds the group id (e.g. `POST /api/v2/admin/profile-groups/{groupId}/keys`) because `admin_idempotency.key` is a **global** primary key and a mismatched route yields `409 IDEMPOTENCY_CONFLICT` (`idempotency.ts:103-111`). | The table has no tenant/group scoping. |

## 7. Dry-run inventory (run **before** applying `0070`)

Rules for the operator:

- Run on a **read replica or restored snapshot**; none of these statements writes.
- `INV-01` needs a database provisioned by the runner (it reads `schema_migrations`).
- Run the whole set **once immediately before the deploy** and store the output as the conversion evidence. The classification happens inside the migration, so this set *predicts* it; any authoring between the dry-run and the deploy invalidates the prediction (see §10).

**Pass criteria summary**

| ID | Question | Pass |
|---|---|---|
| INV-01 | Is the ledger where we expect? | newest applied `0069`, no pending |
| INV-02 | What is the population? | recorded, informational |
| INV-03 | Is every group revision's author key ACTIVE and in-tenant? | `needs_review = false` for all |
| INV-04 | Does every non-empty group resolve to exactly one key? | 0 rows |
| INV-05 | Which groups have no children? | reviewed individually |
| INV-06 | Do child pins match the active pointers? | 0 rows |
| INV-07 | Is any key shared across groups? | 0 rows |
| INV-08 | Is any key bound to two profiles on one selector? | 0 rows (conservative) |
| INV-09/10 | What will `key_mode` be? | matches the approved conversion report |
| INV-11 | Any zero-active-membership key that still has a footprint? | reviewed individually, never unmanaged |
| INV-12 | Which keys become `UNMANAGED_LEGACY`? | each has no profile/group footprint |
| INV-13 | Would the new unique indexes fail? | 0 rows |
| INV-14 | Any cross-tenant historical author? | 0 rows |
| INV-15 | What is in flight? | recorded; drives deploy window |
| INV-16 | Any registry row with no owner? | 0 |

```sql
\pset pager off

-- INV-01 Migration ledger state (runner-provisioned database only).
SELECT coalesce(max(sequence), 0) AS max_applied_sequence,
       count(*) AS applied_files,
       max(filename) AS newest_applied
  FROM schema_migrations;

-- INV-02 Baseline population.
SELECT 'tenants' AS relation, count(*) FROM tenants
UNION ALL SELECT 'api_keys', count(*) FROM api_keys
UNION ALL SELECT 'profile_bindings', count(*) FROM profile_bindings
UNION ALL SELECT 'profile_names', count(*) FROM profile_names
UNION ALL SELECT 'profile_api_keys(ACTIVE)', count(*) FROM profile_api_keys WHERE state='ACTIVE'
UNION ALL SELECT 'profile_api_keys(REVOKED)', count(*) FROM profile_api_keys WHERE state='REVOKED'
UNION ALL SELECT 'profile_groups', count(*) FROM profile_groups
UNION ALL SELECT 'profile_group_revisions', count(*) FROM profile_group_revisions
UNION ALL SELECT 'profile_group_members', count(*) FROM profile_group_members
UNION ALL SELECT 'operations', count(*) FROM operations
ORDER BY relation;

-- INV-03 Every group revision and its author key. Any needs_review row blocks conversion.
SELECT r.group_id, r.revision, r.tenant_id, r.name, r.api_key_id,
       k.status AS key_status, k.tenant_id AS key_tenant_id,
       (r.revision = g.active_revision) AS is_active_revision,
       (k.id IS NULL OR k.status <> 'ACTIVE' OR k.tenant_id <> r.tenant_id) AS needs_review
  FROM profile_group_revisions r
  JOIN profile_groups g ON g.group_id = r.group_id
  LEFT JOIN api_keys k ON k.id = r.api_key_id
 ORDER BY r.group_id, r.revision;

-- INV-04 Groups whose current key is ambiguous or absent. Mirrors
-- resolveCurrentGroupKey (profile-groups.ts:321-366). Empty groups are INV-05.
WITH members AS (
  SELECT g.group_id, m.profile_id
    FROM profile_groups g
    JOIN profile_group_members m
      ON m.group_id = g.group_id AND m.group_revision = g.active_revision
), populated AS (SELECT DISTINCT group_id FROM members), candidates AS (
  SELECT g.group_id, k.id AS api_key_id
    FROM profile_groups g
    JOIN api_keys k ON k.tenant_id = g.tenant_id AND k.status = 'ACTIVE'
   WHERE NOT EXISTS (
           SELECT 1 FROM members x
            WHERE x.group_id = g.group_id
              AND NOT EXISTS (
                    SELECT 1 FROM profile_api_keys pm
                     WHERE pm.profile_id = x.profile_id
                       AND pm.api_key_id = k.id
                       AND pm.tenant_id = g.tenant_id
                       AND pm.state = 'ACTIVE'))
)
SELECT g.group_id, g.tenant_id, g.name, g.active_revision,
       count(c.api_key_id) AS candidate_keys,
       coalesce(array_agg(c.api_key_id ORDER BY c.api_key_id)
                FILTER (WHERE c.api_key_id IS NOT NULL), '{}') AS candidates
  FROM profile_groups g
  JOIN populated p ON p.group_id = g.group_id
  LEFT JOIN candidates c ON c.group_id = g.group_id
 GROUP BY g.group_id, g.tenant_id, g.name, g.active_revision
HAVING count(c.api_key_id) <> 1
 ORDER BY g.tenant_id, g.group_id;

-- INV-05 Empty groups: no child members in the active revision. Their only
-- authority today is the revision's api_key_id, which may be revoked.
SELECT g.group_id, g.tenant_id, g.name, g.active_revision, r.api_key_id AS revision_key_id,
       k.status AS key_status
  FROM profile_groups g
  JOIN profile_group_revisions r ON r.group_id = g.group_id AND r.revision = g.active_revision
  LEFT JOIN api_keys k ON k.id = r.api_key_id
 WHERE NOT EXISTS (SELECT 1 FROM profile_group_members m
                    WHERE m.group_id = g.group_id AND m.group_revision = g.active_revision)
 ORDER BY g.tenant_id, g.group_id;

-- INV-06 Child pointer drift (member pin vs profile_active_revisions).
SELECT m.group_id, m.group_revision, m.profile_id, m.binding_revision,
       a.revision AS active_binding_revision
  FROM profile_group_members m
  JOIN profile_groups g ON g.group_id = m.group_id AND g.active_revision = m.group_revision
  LEFT JOIN profile_active_revisions a ON a.profile_id = m.profile_id
 WHERE a.revision IS DISTINCT FROM m.binding_revision;

-- INV-07 Shared keys across groups (conversion blockers; the plan requires an
-- explicit replacement key and client migration before such a group converts).
WITH refs AS (
  SELECT r.api_key_id, r.group_id, 'revision_author'::text AS via
    FROM profile_group_revisions r
   WHERE r.api_key_id IS NOT NULL
  UNION
  SELECT pm.api_key_id, n.group_id, 'child_membership'::text
    FROM profile_api_keys pm
    JOIN profile_names n ON n.profile_id = pm.profile_id
   WHERE pm.state = 'ACTIVE' AND n.group_id IS NOT NULL
)
SELECT api_key_id, count(DISTINCT group_id) AS group_count,
       array_agg(DISTINCT group_id ORDER BY group_id) AS group_ids
  FROM refs
 GROUP BY api_key_id
HAVING count(DISTINCT group_id) > 1
 ORDER BY api_key_id;

-- INV-08 One key bound to several active profiles on the same selector.
-- Conservative: it ignores endpoint_slug overlap, so it can only over-report.
WITH active_binding AS (
  SELECT pm.api_key_id, b.profile_id, b.business_id, b.business_version, b.action
    FROM profile_api_keys pm
    JOIN profile_active_revisions a ON a.profile_id = pm.profile_id
    JOIN profile_bindings b ON b.profile_id = a.profile_id AND b.revision = a.revision
   WHERE pm.state = 'ACTIVE'
)
SELECT api_key_id, business_id, business_version, action,
       count(DISTINCT profile_id) AS profiles,
       array_agg(DISTINCT profile_id ORDER BY profile_id) AS profile_ids
  FROM active_binding
 GROUP BY api_key_id, business_id, business_version, action
HAVING count(DISTINCT profile_id) > 1
 ORDER BY api_key_id;

-- INV-09 Shadow key classification: exact dry-run of the 0070 backfill.
WITH footprint AS (
  SELECT k.id, k.tenant_id, k.prefix, k.status,
         EXISTS (SELECT 1 FROM profile_api_keys m        WHERE m.api_key_id = k.id) AS has_membership,
         EXISTS (SELECT 1 FROM profile_bindings b        WHERE b.api_key_id = k.id) AS has_binding_author,
         EXISTS (SELECT 1 FROM profile_names n           WHERE n.api_key_id = k.id) AS has_name_author,
         EXISTS (SELECT 1 FROM profile_group_revisions r WHERE r.api_key_id = k.id) AS has_group_revision_author
    FROM api_keys k
)
SELECT id, tenant_id, prefix, status,
       has_membership, has_binding_author, has_name_author, has_group_revision_author,
       CASE WHEN has_membership OR has_binding_author OR has_name_author OR has_group_revision_author
            THEN 'LEGACY_STANDALONE' ELSE 'UNMANAGED_LEGACY' END AS proposed_key_mode
  FROM footprint
 ORDER BY proposed_key_mode, tenant_id, id;

-- INV-10 Shadow classification summary (this is the number to approve).
WITH footprint AS (
  SELECT k.id,
         EXISTS (SELECT 1 FROM profile_api_keys m        WHERE m.api_key_id = k.id)
      OR EXISTS (SELECT 1 FROM profile_bindings b        WHERE b.api_key_id = k.id)
      OR EXISTS (SELECT 1 FROM profile_names n           WHERE n.api_key_id = k.id)
      OR EXISTS (SELECT 1 FROM profile_group_revisions r WHERE r.api_key_id = k.id) AS has_footprint
    FROM api_keys k
)
SELECT CASE WHEN has_footprint THEN 'LEGACY_STANDALONE' ELSE 'UNMANAGED_LEGACY' END AS proposed_key_mode,
       count(*) AS keys
  FROM footprint GROUP BY 1 ORDER BY 1;

-- INV-11 Trap rows: no ACTIVE membership but some footprint. These must never
-- become unmanaged; review each one before approving the migration.
WITH footprint AS (
  SELECT k.id, k.tenant_id, k.prefix, k.status,
         EXISTS (SELECT 1 FROM profile_api_keys m WHERE m.api_key_id = k.id AND m.state = 'ACTIVE') AS has_active_membership,
         EXISTS (SELECT 1 FROM profile_api_keys m WHERE m.api_key_id = k.id AND m.state = 'REVOKED') AS has_tombstone,
         EXISTS (SELECT 1 FROM profile_bindings b        WHERE b.api_key_id = k.id) AS has_binding_author,
         EXISTS (SELECT 1 FROM profile_names n           WHERE n.api_key_id = k.id) AS has_name_author,
         EXISTS (SELECT 1 FROM profile_group_revisions r WHERE r.api_key_id = k.id) AS has_group_revision_author
    FROM api_keys k
)
SELECT id, tenant_id, prefix, status, has_tombstone, has_binding_author, has_name_author, has_group_revision_author
  FROM footprint
 WHERE NOT has_active_membership
   AND (has_tombstone OR has_binding_author OR has_name_author OR has_group_revision_author)
 ORDER BY tenant_id, id;

-- INV-12 Keys that will become UNMANAGED_LEGACY, with usage evidence.
SELECT k.id, k.tenant_id, k.prefix, k.status, k.created_at,
       (SELECT count(*) FROM operations o WHERE o.api_key_id = k.id) AS operations,
       (SELECT max(o.created_at) FROM operations o WHERE o.api_key_id = k.id) AS last_operation_at
  FROM api_keys k
 WHERE NOT EXISTS (SELECT 1 FROM profile_api_keys m        WHERE m.api_key_id = k.id)
   AND NOT EXISTS (SELECT 1 FROM profile_bindings b        WHERE b.api_key_id = k.id)
   AND NOT EXISTS (SELECT 1 FROM profile_names n           WHERE n.api_key_id = k.id)
   AND NOT EXISTS (SELECT 1 FROM profile_group_revisions r WHERE r.api_key_id = k.id)
 ORDER BY k.tenant_id, k.created_at, k.id;

-- INV-13 Name collisions that would make the new unique indexes fail.
SELECT 'grouped' AS scope, tenant_id::text AS tenant_id, group_id::text AS group_id, profile_name, count(*) AS rows
  FROM profile_names
 WHERE group_id IS NOT NULL
 GROUP BY tenant_id, group_id, profile_name
HAVING count(*) > 1
UNION ALL
SELECT 'standalone', tenant_id::text, NULL::text, profile_name, count(*)
  FROM profile_names
 WHERE group_id IS NULL
 GROUP BY tenant_id, api_key_id, business_id, business_version, action, profile_name
HAVING count(*) > 1;

-- INV-14 Author keys outside the row tenant (blocks optional hardening H-3).
SELECT 'profile_bindings' AS relation, count(*) AS rows
  FROM profile_bindings b JOIN api_keys k ON k.id = b.api_key_id
 WHERE k.tenant_id <> b.tenant_id
UNION ALL
SELECT 'profile_names', count(*)
  FROM profile_names n JOIN api_keys k ON k.id = n.api_key_id
 WHERE k.tenant_id <> n.tenant_id
UNION ALL
SELECT 'profile_group_revisions', count(*)
  FROM profile_group_revisions r JOIN api_keys k ON k.id = r.api_key_id
 WHERE k.tenant_id <> r.tenant_id;

-- INV-15 In-flight surface (deploy window evidence).
SELECT state, count(*) AS operations,
       count(*) FILTER (WHERE profile_id IS NOT NULL) AS profile_pinned
  FROM operations GROUP BY state ORDER BY state;

SELECT count(*) AS in_flight_profile_pinned_operations
  FROM operations
 WHERE profile_id IS NOT NULL
   AND state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT');

-- INV-16 Registry rows with no owner (must be 0 for the new CHECK).
SELECT count(*) AS rows_without_owner FROM profile_names WHERE api_key_id IS NULL;
```

## 8. Post-migration verification (run **after** applying `0070`)

```sql
\pset pager off

-- VER-01 Columns exposed by 0070.
SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = current_schema()
   AND ((table_name = 'api_keys'                 AND column_name = 'key_mode')
     OR (table_name = 'profile_groups'           AND column_name IN ('auth_mode','auth_authority','access_version'))
     OR (table_name = 'profile_bindings'         AND column_name IN ('api_key_id','request_defaults','created_by','created_by_issuer','created_by_sub'))
     OR (table_name = 'profile_names'            AND column_name = 'api_key_id')
     OR (table_name = 'profile_group_revisions'  AND column_name IN ('api_key_id','created_by','created_by_issuer','created_by_sub'))
     OR table_name = 'profile_group_api_keys')
 ORDER BY table_name, column_name;

-- VER-02 Constraints on the touched relations.
SELECT conrelid::regclass AS relation, conname, contype,
       CASE conname
         WHEN 'api_keys_key_mode_check'                       THEN 'key mode enum'
         WHEN 'profile_groups_auth_mode_check'                THEN 'auth mode enum'
         WHEN 'profile_groups_auth_authority_check'           THEN 'authority enum'
         WHEN 'profile_group_api_keys_group_tenant_fk'        THEN 'composite tenant FK'
         WHEN 'profile_group_api_keys_key_tenant_fk'          THEN 'composite tenant FK'
         WHEN 'profile_group_api_keys_revocation_shape'       THEN 'tombstone shape'
         WHEN 'profile_bindings_attribution_shape'            THEN 'attribution'
         WHEN 'profile_group_revisions_attribution_shape'     THEN 'attribution'
         WHEN 'profile_names_owner_shape'                     THEN 'ownership'
         ELSE ''
       END AS expected_role
  FROM pg_constraint
 WHERE connamespace = current_schema()::regnamespace
   AND conrelid IN ('api_keys'::regclass, 'profile_groups'::regclass, 'profile_bindings'::regclass,
                    'profile_names'::regclass, 'profile_group_revisions'::regclass,
                    'profile_group_api_keys'::regclass)
 ORDER BY conrelid::regclass::text, conname;

-- VER-03 Indexes on the touched relations.
SELECT tablename, indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = current_schema()
   AND tablename IN ('api_keys','profile_bindings','profile_names','profile_group_revisions','profile_group_api_keys')
 ORDER BY tablename, indexname;

-- VER-04 Key-mode distribution. Any <NULL> row means a writer ran before/at
-- this deploy and produced an unclassified key: stop and classify it.
SELECT coalesce(key_mode, '<NULL>') AS key_mode, count(*) AS keys
  FROM api_keys GROUP BY 1 ORDER BY 1;

-- VER-05 Authority distribution. On the first deploy everything must be
-- CHILD_PROJECTION; anything else means an out-of-band conversion writer ran.
SELECT auth_mode, auth_authority, count(*) AS groups,
       min(access_version) AS min_access_version, max(access_version) AS max_access_version
  FROM profile_groups GROUP BY 1,2 ORDER BY 1,2;

-- VER-06 Grant ledger state (empty on first deploy).
SELECT count(*) AS rows,
       count(*) FILTER (WHERE state = 'ACTIVE')  AS active_grants,
       count(*) FILTER (WHERE state = 'REVOKED') AS tombstones
  FROM profile_group_api_keys;

-- VER-07 Attribution coverage (must be all zeros).
SELECT 'profile_bindings' AS relation, count(*) AS unattributed
  FROM profile_bindings        WHERE api_key_id IS NULL AND created_by IS NULL
UNION ALL
SELECT 'profile_group_revisions', count(*)
  FROM profile_group_revisions WHERE api_key_id IS NULL AND created_by IS NULL
UNION ALL
SELECT 'profile_names', count(*)
  FROM profile_names           WHERE api_key_id IS NULL AND group_id IS NULL;

-- VER-08 NOT NULL relaxation applied (expect YES for all three).
SELECT table_name, column_name, is_nullable
  FROM information_schema.columns
 WHERE table_schema = current_schema() AND column_name = 'api_key_id'
   AND table_name IN ('profile_bindings','profile_names','profile_group_revisions')
 ORDER BY table_name;

-- VER-09 Declared-object drift spot check. The 0028 object must still exist
-- under its original name, and every object declared by 0070 must be present,
-- otherwise migrate/status/verify and the startup gate will refuse to run.
SELECT to_regclass('profile_names_identity') IS NOT NULL AS legacy_identity_object_present;

SELECT count(*) AS missing_declared_objects
  FROM (SELECT unnest(ARRAY[
          'profile_names_identity',
          'profile_names_group_identity',
          'profile_group_api_keys',
          'profile_group_api_keys_group_active',
          'api_keys_id_tenant_unique',
          'profile_group_revisions_author'
        ]) AS n) x
 WHERE to_regclass(x.n) IS NULL;
```

Expected on a validated deployment: VER-04 has no `<NULL>` row, VER-05 is a single `API_KEY | CHILD_PROJECTION` row with `access_version = 1`, VER-06 is `0/0/0`, VER-07 is all zeros, VER-08 is all `YES`, VER-09 is `t` and `0`.

## 9. Optional hardening (validated, separable)

None of this is required to satisfy PC-02. Each item is a self-contained statement block; H-1 and H-2 are cheap and close real silent-failure modes, H-3 changes FK topology and must be gated on `INV-14 = 0`.

**H-1 — monotone `access_version` and one-way authority cutover.**
Without this, a buggy writer can decrease `access_version` (silently breaking every `If-Match`) or reverse a converted group to `CHILD_PROJECTION` (silently re-opening the legacy writer path).

```sql
CREATE OR REPLACE FUNCTION profile_groups_authority_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.access_version < OLD.access_version THEN
    RAISE EXCEPTION 'profile_groups.access_version must not decrease (group %)', OLD.group_id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.auth_authority = 'GROUP_GRANT' AND NEW.auth_authority <> 'GROUP_GRANT' THEN
    RAISE EXCEPTION 'profile_groups.auth_authority cutover is one-way (group %)', OLD.group_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS profile_groups_authority_guard ON profile_groups;
CREATE TRIGGER profile_groups_authority_guard
  BEFORE UPDATE ON profile_groups
  FOR EACH ROW EXECUTE FUNCTION profile_groups_authority_guard();
```

**H-2 — grant rows are tombstones, never deleted.**

```sql
CREATE OR REPLACE FUNCTION profile_group_api_keys_no_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'profile_group_api_keys rows are tombstones; revoke instead of deleting'
    USING ERRCODE = '55000';
END $$;

DROP TRIGGER IF EXISTS profile_group_api_keys_no_delete ON profile_group_api_keys;
CREATE TRIGGER profile_group_api_keys_no_delete
  BEFORE DELETE ON profile_group_api_keys
  FOR EACH ROW EXECUTE FUNCTION profile_group_api_keys_no_delete();
```

**H-3 — tenant-safe historical author FKs (gate on `INV-14 = 0`).**
Requires `api_keys_id_tenant_unique` from `0070`.

```sql
ALTER TABLE profile_bindings DROP CONSTRAINT IF EXISTS profile_bindings_api_key_id_fkey;
DO $$ BEGIN
  ALTER TABLE profile_bindings ADD CONSTRAINT profile_bindings_key_tenant_fk
    FOREIGN KEY (api_key_id, tenant_id) REFERENCES api_keys (id, tenant_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE profile_names DROP CONSTRAINT IF EXISTS profile_names_api_key_id_fkey;
DO $$ BEGIN
  ALTER TABLE profile_names ADD CONSTRAINT profile_names_key_tenant_fk
    FOREIGN KEY (api_key_id, tenant_id) REFERENCES api_keys (id, tenant_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE profile_group_revisions DROP CONSTRAINT IF EXISTS profile_group_revisions_api_key_id_fkey;
DO $$ BEGIN
  ALTER TABLE profile_group_revisions ADD CONSTRAINT profile_group_revisions_key_tenant_fk
    FOREIGN KEY (api_key_id, tenant_id) REFERENCES api_keys (id, tenant_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
```

## 10. Test plan for PC-02

### 10.1 What the existing harness already covers once `0070` lands

`tests/migration-isolated.integration.cjs` builds a disposable database, runs the whole directory through the real runner, asserts `applied.length === <file count>`, re-runs (must apply 0), runs two concurrent `migrate()` calls, then calls `verifyMigrations`. Adding `0070` therefore automatically exercises: fresh apply, ledger checksum, idempotent re-run, concurrent start, **and the declared-object drift guard** — the exact check that catches the `profile_names_identity` mistake. No new harness is needed for that level.

### 10.2 Regression test to add with the migration (text-level, no DB)

Precedent: `tests/migration-artifact-sync.test.cjs` already asserts on migration file contents. Suggested `tests/profile-control-plane-migration.test.cjs` assertions, all from reading `0070` as text:

1. exactly one file matches `^0070_` and the max sequence in the directory is `0070` (guards against a parallel packet taking the slot);
2. the file contains **no** `DROP TABLE`, `TRUNCATE`, `DELETE FROM`, `ALTER COLUMN … SET NOT NULL`, or `DROP COLUMN`;
3. every object named by a line-leading `CREATE … TABLE/INDEX` in the file also exists in the file's own final definitions (i.e. no self-dropped object);
4. `profile_names_identity` is created (not renamed away) — a direct regression guard for §2.2;
5. `key_mode` is declared without `DEFAULT`, and the classification `UPDATE` is present exactly once;
6. the three `DROP NOT NULL` statements target exactly `profile_bindings`, `profile_names`, `profile_group_revisions`.

### 10.3 Data-level test to add (isolated PG harness, `migration-isolated` style)

On a database at `0069` with a fixture equivalent to the one used here (tenant A/B; a standalone key with an ACTIVE membership; a tombstone-only key; a never-associated key; an empty group owned by a key with no membership; a two-child group whose key is the member of every child):

1. apply `0070`, assert `key_mode` is `LEGACY_STANDALONE` for the first, tombstone-only, empty-group-owner and group-member keys and `UNMANAGED_LEGACY` only for the never-associated key;
2. assert every group is `CHILD_PROJECTION` / `access_version = 1` and the grant ledger is empty;
3. assert the 16 constraint outcomes in §12 (T1–T16) — at minimum: duplicate group grant rejected, cross-tenant grant rejected, keyless revision without `created_by` rejected, non-object `request_defaults` rejected, in-group duplicate child name rejected, same child name in another group accepted;
4. re-run `migrate` and assert 0 applied (idempotency) and `verifyMigrations` passes (drift guard green).

## 11. Rollout, lock impact, rollback

**Lock impact.** The runner wraps each file in one transaction, so `CREATE INDEX CONCURRENTLY` is unavailable by design (`0019:39-51` records the same decision and reasoning).

| Statement | Lock | Rewrite |
|---|---|---|
| `ADD COLUMN … DEFAULT` (PG11+) | `ACCESS EXCLUSIVE`, brief | no |
| `ALTER COLUMN … DROP NOT NULL` | `ACCESS EXCLUSIVE`, brief | no |
| classification `UPDATE api_keys` | row locks on `api_keys` | full rewrite of that small table |
| `CREATE UNIQUE INDEX` on `profile_names` | `SHARE` (blocks writes to that table only) | index build |
| `CREATE UNIQUE INDEX` on `api_keys` | `SHARE` | index build |
| `CREATE TABLE profile_group_api_keys` | none on existing tables | — |
| `DROP INDEX profile_names_identity` | `ACCESS EXCLUSIVE` on `profile_names`, brief | — |

`api_keys` and the profile tables are configuration-sized (tens to low thousands of rows), not the operational hot path (`operations` is). The blocking window is comparable to `0044`/`0067`. If a future deployment has very large profile tables, the index builds can be moved to a separate operator runbook, but they cannot move into this file.

**Deploy sequence (aligns with plan §Rollout steps 1-3).**

1. Freeze profile/group authoring (no `profile.upsert`, `apikey.issue/rotate`, group save) for the migration window; record `INV-01..INV-16` immediately before.
2. Apply `0070` (image startup gate or explicit `pnpm run migrate`).
3. Run `VER-01..VER-09`. Compare `VER-04` against the `INV-10` prediction. **Any difference means authoring happened during the window and the affected keys must be reviewed and classified explicitly before proceeding.**
4. Only then deploy the PC-04 reader/resolver that consumes `key_mode`; it must refuse `NULL`.
5. Conversion of each group to `GROUP_GRANT` remains a per-cohort PC-03 operation gated on the dry-run report, not part of this migration.

**Rollback.** There is no down migration and none should be added: a file that dropped objects created by `0070` would trip the same drift guard, and `0028`'s identity index cannot be restored to its old definition without re-blocking grouped children. The plan is explicit — rollback never reactivates grants. Practical position after `0070`:

- Before any v2 write: reverting the *image* is safe. The added columns are nullable/defaulted and the old code ignores them; `key_mode` being populated does not change old behaviour because no old reader reads it. `profile_names_identity`'s narrower predicate only *relaxes* the old constraint for grouped rows, and old code only writes standalone rows (which still satisfy it).
- After a v2 write exists for a cohort: forward-fix only, per plan §PC-09.

## 12. Evidence log (scratch PostgreSQL 16.11, no project database touched)

| ID | Check | Result |
|---|---|---|
| E-01 | All 66 existing migrations apply to an empty PG16 database in order | pass (`chain_fail=0`, 108 relations) |
| E-02 | `0070` applies after the full chain | pass (all statements) |
| E-03 | `0070` re-run | pass (exit 0; only benign `NOTICE … skipping`) |
| E-04 | Legacy data first, then `0070` (true upgrade path) | pass; classification `k1/k2/k4/k5/k6 = LEGACY_STANDALONE`, `k3 = UNMANAGED_LEGACY` |
| E-05 | Trap cases: tombstone-only key, empty-group owning key with zero memberships, never-associated key | classified standalone / standalone / unmanaged as designed |
| E-06 | 16 constraint assertions (T1–T16) | 16/16 as designed (see table below) |
| E-07 | Naive index replacement (drop + rename) | **FAILS the runner's drift model**: 1 declared object missing → migrate/status/verify would abort |
| E-08 | Name-preserving replacement | `declared=228 missing=0`; the runner's guard stays green |
| E-09 | `INV-01..INV-16` executed against a populated fixture | all valid SQL; detectors verified positively (ambiguous group reported 2 candidates; shared key reported groups `c2` + `c3`) |
| E-10 | `VER-01..VER-09` executed | all valid; observed values as expected (key split 5/1, authority all `CHILD_PROJECTION`, ledger empty, attribution zeros) |
| E-11 | H-1/H-2/H-3 applied and behaviour-tested | version decrease rejected, authority reversal rejected, increment accepted, tombstone delete rejected, cross-tenant author rejected |

Constraint assertions (E-06):

| Test | Expected | Observed |
|---|---|---|
| T1 grant with mismatched tenant | FK violation | rejected |
| T2 same key granted to a second group | unique violation | rejected |
| T3 `ACTIVE` row carrying revocation metadata | CHECK violation | rejected |
| T4 `REVOKED` row without `revoked_by` | CHECK violation | rejected |
| T5 valid grant | accepted | accepted |
| T6 revision with neither author nor `created_by` | CHECK violation | rejected |
| T7 keyless revision with `created_by` | accepted | accepted |
| T8 registry row with neither owner | CHECK violation | rejected |
| T9 `request_defaults = '[]'` | CHECK violation | rejected |
| T10 duplicate standalone name tuple | unique violation | rejected |
| T11 duplicate child name in the same group | unique violation | rejected |
| T12 same child name in a different group | accepted | accepted |
| T13 unknown `key_mode` | CHECK violation | rejected |
| T14 `access_version = 0` | CHECK violation | rejected |
| T15 keyless group revision with `created_by` | accepted | accepted |
| T16 group revision with neither author nor `created_by` | CHECK violation | rejected |

Scratch container and temporary SQL were removed after the run; the project database was never contacted.

## 13. Open questions for the coordinator

Each has a recommended default; none blocks the draft.

| # | Question | Recommendation |
|---|---|---|
| Q-1 | Is one migration file acceptable, or must schema and backfill be separate ledger entries? | **One file.** Splitting creates an authentication outage window (D-01). |
| Q-2 | Is the name-preserving index replacement acceptable, or should the coordinator relax the runner guard (outside this lease)? | **Name-preserving.** Changing `migrations.ts` is a separate packet with its own blast radius. |
| Q-3 | Should `key_mode` really have no default? | **No default.** A default turns a forgotten writer into a privilege decision (D-02). |
| Q-4 | Should the dev fallback key row (`dev-fallback-placeholder`) be excluded from rotation in PC-04? | Leave it `UNMANAGED_LEGACY` and document it; optionally refuse rotation for a key whose `hash` is the placeholder (O-7). |
| Q-5 | Are H-1/H-2/H-3 in scope for PC-02 or a follow-up migration? | H-1 and H-2 in the same file (cheap, prevent silent breakage); H-3 in a follow-up only after `INV-14 = 0` on production. |
| Q-6 | Does PC-01 name the group DTO field `authAuthority` (matching the column) or `authority`? | `authAuthority` / `authMode` / `accessVersion`, mirroring the columns, so PC-03 has no translation layer. |
| Q-7 | Should `profile_group_api_keys` expose revoked grants in v2 reads? | No — plan says "reads show empty grants after revoke"; tombstones are for uniqueness/audit. |

## 14. References

| Reference | Location |
|---|---|
| Runner, checksum, drift guard | `orchestrator/services/orchestrator/src/db/migrations.ts:17,62-91,286,336-374,480-524` |
| Startup gate | `orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts:488-496` |
| Migration docs | `orchestrator/docs/migrations.md` |
| Existing migration patterns | `0059`/`0060` (triggers), `0065` (guarded `ADD CONSTRAINT`), `0027`/`0039` (backfill precedent), `0019` (why not `CONCURRENTLY`) |
| Group storage | `migrations/0067_profile_groups.sql:5-85` |
| Group service (key resolution, snapshot insert) | `src/modules/profiles/profile-groups.ts:321-366,486-496,579-626` |
| Profile append (author key, policy carry-forward) | `src/modules/profiles/profiles.ts:717-846` |
| Resolution / membership reads | `src/modules/profiles/profiles.ts:414-473,1096-1133` |
| Key lifecycle | `src/modules/identity/api-keys.ts:179-345`; `src/modules/admin-actions/dispatcher.ts:839-1230` |
| Auth resolver (ACTIVE-only) | `src/http/routes/api-key-auth.ts:13-20` |
| Idempotency store | `src/modules/idempotency/idempotency.ts:94-166`; `migrations/0012_admin_idempotency.sql` |
| Migration harness | `orchestrator/tests/migration-isolated.integration.cjs`, `migration-artifact-sync.test.cjs` |
| Master plan | `du-rework/tasks/PLAN-PROFILE-CONTROL-PLANE-IMPLEMENTATION.md` §PC-02, §Settled data and authorization model |
