import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';
import { createDb, type Db } from '../src/db/db';
import { migrate, migrationStatus, verifyMigrations, type MigrationStatus } from '../src/db/migrations';

/**
 * PC-02 live migration suite (WINDOW-GATED: DU_LIVE_INFRA=1).
 *
 * Proves, against a real PostgreSQL, that `0070_profile_control_plane_storage.sql`
 *
 *   1. applies through the REAL runner (`src/db/migrations.ts`) on top of a
 *      database that is already at 0069 and already holds profile/group data —
 *      i.e. the actual upgrade path, never a fresh-schema shortcut;
 *   2. leaves the runner's declared-object drift check green
 *      (`verifyMigrations` resolves => 0 missing declared objects), including
 *      `profile_names_identity`, which 0028 declared and 0070 re-scopes;
 *   3. is idempotent (second `migrate` applies nothing);
 *   4. classifies every pre-existing key deterministically from evidence;
 *   5. keeps every new constraint honest (16 accept/reject assertions);
 *   6. executes the 16 pre-migration inventory queries and the 9 post-migration
 *      verification queries shipped in
 *      coordination/reports/prep-pc02-migrations-spec.md.
 *
 * The database is a scratch database this suite creates and drops; the
 * configured DATABASE_URL database is never modified beyond that.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';

const DB_NAME = new URL(DATABASE_URL).pathname.split('/').pop() ?? 'du_orchestrator_test';
const BASE_URL = DATABASE_URL.replace(/\/[^/]+$/, '');
const ADMIN_URL = `${BASE_URL}/postgres`;
const SCRATCH_DB = 'du_pc02_migration_test';
const SCRATCH_URL = `${BASE_URL}/${SCRATCH_DB}`;
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const NEW_MIGRATION = '0070_profile_control_plane_storage.sql';

const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn(
    'profile-control-plane-migration.test.ts: SKIPPED - set DU_LIVE_INFRA=1 with a test PostgreSQL to run.',
  );
}

function assertTestDatabase(): void {
  if (!/test/i.test(DB_NAME)) {
    throw new Error(
      `refusing migration test: DATABASE_URL database "${DB_NAME}" does not look like a test database`,
    );
  }
}

const TENANT_A = '00000000-0000-0000-0000-0000000000a1';
const TENANT_B = '00000000-0000-0000-0000-0000000000a2';

const KEY = {
  standalone: '00000000-0000-0000-0000-00000000000a',
  tombstoneOnly: '00000000-0000-0000-0000-00000000000b',
  neverAssociated: '00000000-0000-0000-0000-00000000000c',
  emptyGroupOwner: '00000000-0000-0000-0000-00000000000d',
  groupChildMember: '00000000-0000-0000-0000-00000000000e',
  otherTenantOwner: '00000000-0000-0000-0000-00000000000f',
} as const;

const PROFILE = {
  standalone: '00000000-0000-0000-0000-0000000000b1',
  groupChild: '00000000-0000-0000-0000-0000000000b2',
} as const;

const GROUP = {
  empty: '00000000-0000-0000-0000-0000000000c1',
  withChild: '00000000-0000-0000-0000-0000000000c2',
  otherTenant: '00000000-0000-0000-0000-0000000000d1',
  spare: '00000000-0000-0000-0000-0000000000c3',
} as const;

/**
 * Legacy-shaped fixture: only columns that exist at 0069. No key_mode, no
 * request_defaults, no created_by — exactly what a pre-PC-02 deployment holds.
 */
const LEGACY_FIXTURE_SQL = `
INSERT INTO tenants (id, name) VALUES
  ('${TENANT_A}', 'pc02-tenant-a'),
  ('${TENANT_B}', 'pc02-tenant-b');

INSERT INTO api_keys (id, tenant_id, hash, prefix, status, name, key_mode) VALUES ('${KEY.standalone}',      '${TENANT_A}', 'pc02-hash-a', 'du_a', 'ACTIVE', 'k1 standalone active member', 'LEGACY_STANDALONE'),
  ('${KEY.tombstoneOnly}',   '${TENANT_A}', 'pc02-hash-b', 'du_b', 'ACTIVE', 'k2 tombstone only'),
  ('${KEY.neverAssociated}', '${TENANT_A}', 'pc02-hash-c', 'du_c', 'ACTIVE', 'k3 never associated'),
  ('${KEY.emptyGroupOwner}', '${TENANT_A}', 'pc02-hash-d', 'du_d', 'ACTIVE', 'k4 empty group owner'),
  ('${KEY.groupChildMember}', '${TENANT_A}', 'pc02-hash-e', 'du_e', 'ACTIVE', 'k5 group child member'),
  ('${KEY.otherTenantOwner}', '${TENANT_B}', 'pc02-hash-f', 'du_f', 'ACTIVE', 'k6 other tenant group owner');

-- Standalone profile: key k1 authored the revision and holds an ACTIVE membership.
INSERT INTO profile_bindings (profile_id, revision, tenant_id, api_key_id, business_id, business_version, action)
VALUES ('${PROFILE.standalone}', 1, '${TENANT_A}', '${KEY.standalone}', 'document-core', '1.0.0', 'extract');
INSERT INTO profile_names (profile_id, tenant_id, api_key_id, business_id, business_version, action, profile_name)
VALUES ('${PROFILE.standalone}', '${TENANT_A}', '${KEY.standalone}', 'document-core', '1.0.0', 'extract', 'standalone-one');
INSERT INTO profile_active_revisions (profile_id, revision) VALUES ('${PROFILE.standalone}', 1);
INSERT INTO profile_api_keys (profile_id, api_key_id, tenant_id, state)
VALUES ('${PROFILE.standalone}', '${KEY.standalone}', '${TENANT_A}', 'ACTIVE');

-- k2's only historical membership is a REVOKED tombstone: still standalone.
INSERT INTO profile_api_keys (profile_id, api_key_id, tenant_id, state, revoked_at)
VALUES ('${PROFILE.standalone}', '${KEY.tombstoneOnly}', '${TENANT_A}', 'REVOKED', now());

-- Empty group: no child members at all, only the revision's author key (k4).
INSERT INTO profile_groups (group_id, tenant_id, name, active_revision) VALUES
  ('${GROUP.empty}', '${TENANT_A}', 'pc02-empty-group', 0);
INSERT INTO profile_group_revisions (group_id, revision, tenant_id, name, api_key_id) VALUES
  ('${GROUP.empty}', 1, '${TENANT_A}', 'pc02-empty-group', '${KEY.emptyGroupOwner}');
UPDATE profile_groups SET active_revision = 1 WHERE group_id = '${GROUP.empty}';

-- Group with one child profile; k5 is a member of the child.
INSERT INTO profile_groups (group_id, tenant_id, name, active_revision) VALUES
  ('${GROUP.withChild}', '${TENANT_A}', 'pc02-child-group', 0);
INSERT INTO profile_group_revisions (group_id, revision, tenant_id, name, api_key_id) VALUES
  ('${GROUP.withChild}', 1, '${TENANT_A}', 'pc02-child-group', '${KEY.groupChildMember}');
INSERT INTO profile_bindings (profile_id, revision, tenant_id, api_key_id, business_id, business_version, action)
VALUES ('${PROFILE.groupChild}', 1, '${TENANT_A}', '${KEY.groupChildMember}', 'document-core', '1.0.0', 'analyze');
INSERT INTO profile_names (profile_id, tenant_id, api_key_id, business_id, business_version, action, profile_name, group_id)
VALUES ('${PROFILE.groupChild}', '${TENANT_A}', '${KEY.groupChildMember}', 'document-core', '1.0.0', 'analyze',
        '__du_group_c2_child', '${GROUP.withChild}');
INSERT INTO profile_active_revisions (profile_id, revision) VALUES ('${PROFILE.groupChild}', 1);
INSERT INTO profile_api_keys (profile_id, api_key_id, tenant_id, state)
VALUES ('${PROFILE.groupChild}', '${KEY.groupChildMember}', '${TENANT_A}', 'ACTIVE');
INSERT INTO profile_group_members
  (group_id, group_revision, business_id, business_version, manifest_digest, function_kind, function_id,
   action, endpoint_slug, profile_id, binding_revision)
VALUES ('${GROUP.withChild}', 1, 'document-core', '1.0.0', 'pc02-digest-1', 'endpoint', 'analyze.classify',
        'analyze', 'analyze:classify', '${PROFILE.groupChild}', 1);
UPDATE profile_groups SET active_revision = 1 WHERE group_id = '${GROUP.withChild}';

-- A group in the other tenant, owned by k6.
INSERT INTO profile_groups (group_id, tenant_id, name, active_revision) VALUES
  ('${GROUP.otherTenant}', '${TENANT_B}', 'pc02-tenant-b-group', 0);
INSERT INTO profile_group_revisions (group_id, revision, tenant_id, name, api_key_id) VALUES
  ('${GROUP.otherTenant}', 1, '${TENANT_B}', 'pc02-tenant-b-group', '${KEY.otherTenantOwner}');
UPDATE profile_groups SET active_revision = 1 WHERE group_id = '${GROUP.otherTenant}';
`;

interface QueryCase {
  id: string;
  sql: string;
}

/** The 16 pre-migration inventory queries from the PREP-PC-02 report (section 7). */
const PRE_MIGRATION_QUERIES: readonly QueryCase[] = [
  {
    id: 'INV-01',
    sql: `SELECT coalesce(max(sequence), 0) AS max_applied_sequence,
                 count(*) AS applied_files,
                 max(filename) AS newest_applied
            FROM schema_migrations`,
  },
  {
    id: 'INV-02',
    sql: `SELECT 'tenants' AS relation, count(*) FROM tenants
          UNION ALL SELECT 'api_keys', count(*) FROM api_keys
          UNION ALL SELECT 'profile_bindings', count(*) FROM profile_bindings
          UNION ALL SELECT 'profile_names', count(*) FROM profile_names
          UNION ALL SELECT 'profile_api_keys(ACTIVE)', count(*) FROM profile_api_keys WHERE state='ACTIVE'
          UNION ALL SELECT 'profile_api_keys(REVOKED)', count(*) FROM profile_api_keys WHERE state='REVOKED'
          UNION ALL SELECT 'profile_groups', count(*) FROM profile_groups
          UNION ALL SELECT 'profile_group_revisions', count(*) FROM profile_group_revisions
          UNION ALL SELECT 'profile_group_members', count(*) FROM profile_group_members
          UNION ALL SELECT 'operations', count(*) FROM operations
          ORDER BY relation`,
  },
  {
    id: 'INV-03',
    sql: `SELECT r.group_id, r.revision, r.tenant_id, r.name, r.api_key_id,
                 k.status AS key_status, k.tenant_id AS key_tenant_id,
                 (r.revision = g.active_revision) AS is_active_revision,
                 (k.id IS NULL OR k.status <> 'ACTIVE' OR k.tenant_id <> r.tenant_id) AS needs_review
            FROM profile_group_revisions r
            JOIN profile_groups g ON g.group_id = r.group_id
            LEFT JOIN api_keys k ON k.id = r.api_key_id
           ORDER BY r.group_id, r.revision`,
  },
  {
    id: 'INV-04',
    sql: `WITH members AS (
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
           ORDER BY g.tenant_id, g.group_id`,
  },
  {
    id: 'INV-05',
    sql: `SELECT g.group_id, g.tenant_id, g.name, g.active_revision, r.api_key_id AS revision_key_id,
                 k.status AS key_status
            FROM profile_groups g
            JOIN profile_group_revisions r ON r.group_id = g.group_id AND r.revision = g.active_revision
            LEFT JOIN api_keys k ON k.id = r.api_key_id
           WHERE NOT EXISTS (SELECT 1 FROM profile_group_members m
                              WHERE m.group_id = g.group_id AND m.group_revision = g.active_revision)
           ORDER BY g.tenant_id, g.group_id`,
  },
  {
    id: 'INV-06',
    sql: `SELECT m.group_id, m.group_revision, m.profile_id, m.binding_revision,
                 a.revision AS active_binding_revision
            FROM profile_group_members m
            JOIN profile_groups g ON g.group_id = m.group_id AND g.active_revision = m.group_revision
            LEFT JOIN profile_active_revisions a ON a.profile_id = m.profile_id
           WHERE a.revision IS DISTINCT FROM m.binding_revision`,
  },
  {
    id: 'INV-07',
    sql: `WITH refs AS (
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
           ORDER BY api_key_id`,
  },
  {
    id: 'INV-08',
    sql: `WITH active_binding AS (
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
           ORDER BY api_key_id`,
  },
  {
    id: 'INV-09',
    sql: `WITH footprint AS (
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
           ORDER BY proposed_key_mode, tenant_id, id`,
  },
  {
    id: 'INV-10',
    sql: `WITH footprint AS (
            SELECT k.id,
                   EXISTS (SELECT 1 FROM profile_api_keys m        WHERE m.api_key_id = k.id)
                OR EXISTS (SELECT 1 FROM profile_bindings b        WHERE b.api_key_id = k.id)
                OR EXISTS (SELECT 1 FROM profile_names n           WHERE n.api_key_id = k.id)
                OR EXISTS (SELECT 1 FROM profile_group_revisions r WHERE r.api_key_id = k.id) AS has_footprint
              FROM api_keys k
          )
          SELECT CASE WHEN has_footprint THEN 'LEGACY_STANDALONE' ELSE 'UNMANAGED_LEGACY' END AS proposed_key_mode,
                 count(*) AS keys
            FROM footprint GROUP BY 1 ORDER BY 1`,
  },
  {
    id: 'INV-11',
    sql: `WITH footprint AS (
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
           ORDER BY tenant_id, id`,
  },
  {
    id: 'INV-12',
    sql: `SELECT k.id, k.tenant_id, k.prefix, k.status, k.created_at,
                 (SELECT count(*) FROM operations o WHERE o.api_key_id = k.id) AS operations,
                 (SELECT max(o.created_at) FROM operations o WHERE o.api_key_id = k.id) AS last_operation_at
            FROM api_keys k
           WHERE NOT EXISTS (SELECT 1 FROM profile_api_keys m        WHERE m.api_key_id = k.id)
             AND NOT EXISTS (SELECT 1 FROM profile_bindings b        WHERE b.api_key_id = k.id)
             AND NOT EXISTS (SELECT 1 FROM profile_names n           WHERE n.api_key_id = k.id)
             AND NOT EXISTS (SELECT 1 FROM profile_group_revisions r WHERE r.api_key_id = k.id)
           ORDER BY k.tenant_id, k.created_at, k.id`,
  },
  {
    id: 'INV-13',
    sql: `SELECT 'grouped' AS scope, tenant_id::text AS tenant_id, group_id::text AS group_id, profile_name, count(*) AS rows
            FROM profile_names
           WHERE group_id IS NOT NULL
           GROUP BY tenant_id, group_id, profile_name
          HAVING count(*) > 1
          UNION ALL
          SELECT 'standalone', tenant_id::text, NULL::text, profile_name, count(*)
            FROM profile_names
           WHERE group_id IS NULL
           GROUP BY tenant_id, api_key_id, business_id, business_version, action, profile_name
          HAVING count(*) > 1`,
  },
  {
    id: 'INV-14',
    sql: `SELECT 'profile_bindings' AS relation, count(*) AS rows
            FROM profile_bindings b JOIN api_keys k ON k.id = b.api_key_id
           WHERE k.tenant_id <> b.tenant_id
          UNION ALL
          SELECT 'profile_names', count(*)
            FROM profile_names n JOIN api_keys k ON k.id = n.api_key_id
           WHERE k.tenant_id <> n.tenant_id
          UNION ALL
          SELECT 'profile_group_revisions', count(*)
            FROM profile_group_revisions r JOIN api_keys k ON k.id = r.api_key_id
           WHERE k.tenant_id <> r.tenant_id`,
  },
  {
    id: 'INV-15a',
    sql: `SELECT state, count(*) AS operations,
                 count(*) FILTER (WHERE profile_id IS NOT NULL) AS profile_pinned
            FROM operations GROUP BY state ORDER BY state`,
  },
  {
    id: 'INV-15b',
    sql: `SELECT count(*) AS in_flight_profile_pinned_operations
            FROM operations
           WHERE profile_id IS NOT NULL
             AND state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT')`,
  },
  {
    id: 'INV-16',
    sql: `SELECT count(*) AS rows_without_owner FROM profile_names WHERE api_key_id IS NULL`,
  },
];

/** The 9 post-migration verification queries from the PREP-PC-02 report (section 8). */
const POST_MIGRATION_QUERIES: readonly QueryCase[] = [
  {
    id: 'VER-01',
    sql: `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
            FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND ((table_name = 'api_keys'                 AND column_name = 'key_mode')
               OR (table_name = 'profile_groups'           AND column_name IN ('auth_mode','auth_authority','access_version'))
               OR (table_name = 'profile_bindings'         AND column_name IN ('api_key_id','request_defaults','created_by','created_by_issuer','created_by_sub'))
               OR (table_name = 'profile_names'            AND column_name = 'api_key_id')
               OR (table_name = 'profile_group_revisions'  AND column_name IN ('api_key_id','created_by','created_by_issuer','created_by_sub'))
               OR table_name = 'profile_group_api_keys')
           ORDER BY table_name, column_name`,
  },
  {
    id: 'VER-02',
    sql: `SELECT conrelid::regclass AS relation, conname, contype,
                 CASE conname
                   WHEN 'api_keys_key_mode_check'                   THEN 'key mode enum'
                   WHEN 'profile_groups_auth_mode_check'            THEN 'auth mode enum'
                   WHEN 'profile_groups_auth_authority_check'       THEN 'authority enum'
                   WHEN 'profile_group_api_keys_group_tenant_fk'    THEN 'composite tenant FK'
                   WHEN 'profile_group_api_keys_key_tenant_fk'      THEN 'composite tenant FK'
                   WHEN 'profile_group_api_keys_revocation_shape'   THEN 'tombstone shape'
                   WHEN 'profile_bindings_attribution_shape'        THEN 'attribution'
                   WHEN 'profile_group_revisions_attribution_shape' THEN 'attribution'
                   WHEN 'profile_names_owner_shape'                 THEN 'ownership'
                   ELSE ''
                 END AS expected_role
            FROM pg_constraint
           WHERE connamespace = current_schema()::regnamespace
             AND conrelid IN ('api_keys'::regclass, 'profile_groups'::regclass, 'profile_bindings'::regclass,
                              'profile_names'::regclass, 'profile_group_revisions'::regclass,
                              'profile_group_api_keys'::regclass)
           ORDER BY conrelid::regclass::text, conname`,
  },
  {
    id: 'VER-03',
    sql: `SELECT tablename, indexname, indexdef
            FROM pg_indexes
           WHERE schemaname = current_schema()
             AND tablename IN ('api_keys','profile_bindings','profile_names','profile_group_revisions','profile_group_api_keys')
           ORDER BY tablename, indexname`,
  },
  {
    id: 'VER-04',
    sql: `SELECT coalesce(key_mode, '<NULL>') AS key_mode, count(*) AS keys
            FROM api_keys GROUP BY 1 ORDER BY 1`,
  },
  {
    id: 'VER-05',
    sql: `SELECT auth_mode, auth_authority, count(*) AS groups,
                 min(access_version) AS min_access_version, max(access_version) AS max_access_version
            FROM profile_groups GROUP BY 1,2 ORDER BY 1,2`,
  },
  {
    id: 'VER-06',
    sql: `SELECT count(*) AS rows,
                 count(*) FILTER (WHERE state = 'ACTIVE')  AS active_grants,
                 count(*) FILTER (WHERE state = 'REVOKED') AS tombstones
            FROM profile_group_api_keys`,
  },
  {
    id: 'VER-07',
    sql: `SELECT 'profile_bindings' AS relation, count(*) AS unattributed
            FROM profile_bindings        WHERE api_key_id IS NULL AND created_by IS NULL
          UNION ALL
          SELECT 'profile_group_revisions', count(*)
            FROM profile_group_revisions WHERE api_key_id IS NULL AND created_by IS NULL
          UNION ALL
          SELECT 'profile_names', count(*)
            FROM profile_names           WHERE api_key_id IS NULL AND group_id IS NULL`,
  },
  {
    id: 'VER-08',
    sql: `SELECT table_name, column_name, is_nullable
            FROM information_schema.columns
           WHERE table_schema = current_schema() AND column_name = 'api_key_id'
             AND table_name IN ('profile_bindings','profile_names','profile_group_revisions')
           ORDER BY table_name`,
  },
  {
    id: 'VER-09',
    sql: `SELECT count(*) AS missing_declared_objects
            FROM (SELECT unnest(ARRAY[
                    'profile_names_identity',
                    'profile_names_group_identity',
                    'profile_group_api_keys',
                    'profile_group_api_keys_group_active',
                    'api_keys_id_tenant_unique',
                    'profile_group_revisions_author'
                  ]) AS n) x
           WHERE to_regclass(x.n) IS NULL`,
  },
];

/** 16 constraint assertions: every row is accepted or rejected for a reason. */
interface ConstraintCase {
  id: string;
  sql: string;
  /** undefined => must succeed; otherwise the expected SQLSTATE. */
  code?: string;
}

const CONSTRAINT_CASES: readonly ConstraintCase[] = [
  {
    id: 'T1 cross-tenant grant rejected',
    sql: `INSERT INTO profile_group_api_keys (api_key_id, group_id, tenant_id, granted_by)
          VALUES ('${KEY.otherTenantOwner}', '${GROUP.empty}', '${TENANT_A}', 'admin')`,
    code: '23503',
  },
  {
    id: 'T5 valid grant accepted',
    sql: `INSERT INTO profile_group_api_keys (api_key_id, group_id, tenant_id, granted_by, granted_by_issuer, granted_by_sub)
          VALUES ('${KEY.groupChildMember}', '${GROUP.withChild}', '${TENANT_A}', 'admin', 'https://idp', 'sub-1')`,
  },
  {
    id: 'T2 second-group grant rejected',
    sql: `INSERT INTO profile_group_api_keys (api_key_id, group_id, tenant_id, granted_by)
          VALUES ('${KEY.groupChildMember}', '${GROUP.spare}', '${TENANT_A}', 'admin')`,
    code: '23505',
  },
  {
    id: 'T3 ACTIVE-with-revocation rejected',
    sql: `INSERT INTO profile_group_api_keys (api_key_id, group_id, tenant_id, granted_by, revoked_at, revoked_by)
          VALUES ('${KEY.standalone}', '${GROUP.withChild}', '${TENANT_A}', 'admin', now(), 'admin')`,
    code: '23514',
  },
  {
    id: 'T4 REVOKED-without-actor rejected',
    sql: `INSERT INTO profile_group_api_keys (api_key_id, group_id, tenant_id, granted_by, state, revoked_at)
          VALUES ('${KEY.tombstoneOnly}', '${GROUP.withChild}', '${TENANT_A}', 'admin', 'REVOKED', now())`,
    code: '23514',
  },
  {
    id: 'T6 unattributed revision rejected',
    sql: `INSERT INTO profile_bindings (profile_id, revision, tenant_id, business_id, business_version, action)
          VALUES ('00000000-0000-0000-0000-0000000000b3', 1, '${TENANT_A}', 'document-core', '1.0.0', 'generate')`,
    code: '23514',
  },
  {
    id: 'T7 actor-attributed keyless revision accepted',
    sql: `INSERT INTO profile_bindings (profile_id, revision, tenant_id, business_id, business_version, action, created_by, created_by_sub)
          VALUES ('00000000-0000-0000-0000-0000000000b3', 1, '${TENANT_A}', 'document-core', '1.0.0', 'generate', 'admin', 'sub-1')`,
  },
  {
    id: 'T8 orphan registry row rejected',
    sql: `INSERT INTO profile_names (profile_id, tenant_id, business_id, business_version, action, profile_name)
          VALUES ('00000000-0000-0000-0000-0000000000b4', '${TENANT_A}', 'document-core', '1.0.0', 'generate', 'orphan-name')`,
    code: '23514',
  },
  {
    id: 'T9 non-object request_defaults rejected',
    sql: `INSERT INTO profile_bindings (profile_id, revision, tenant_id, business_id, business_version, action, created_by, request_defaults)
          VALUES ('00000000-0000-0000-0000-0000000000b5', 1, '${TENANT_A}', 'document-core', '1.0.0', 'generate', 'admin', '[]'::jsonb)`,
    code: '23514',
  },
  {
    id: 'T10 duplicate standalone name rejected',
    sql: `INSERT INTO profile_names (profile_id, tenant_id, api_key_id, business_id, business_version, action, profile_name)
          VALUES ('00000000-0000-0000-0000-0000000000b6', '${TENANT_A}', '${KEY.standalone}', 'document-core', '1.0.0', 'extract', 'standalone-one')`,
    code: '23505',
  },
  {
    id: 'T11 duplicate in-group child name rejected',
    sql: `INSERT INTO profile_names (profile_id, tenant_id, business_id, business_version, action, profile_name, group_id)
          VALUES ('00000000-0000-0000-0000-0000000000b7', '${TENANT_A}', 'document-core', '1.0.0', 'analyze', '__du_group_c2_child', '${GROUP.withChild}')`,
    code: '23505',
  },
  {
    id: 'T12 same child name in another group accepted',
    sql: `INSERT INTO profile_names (profile_id, tenant_id, business_id, business_version, action, profile_name, group_id)
          VALUES ('00000000-0000-0000-0000-0000000000b8', '${TENANT_A}', 'document-core', '1.0.0', 'analyze', '__du_group_c2_child', '${GROUP.spare}')`,
  },
  {
    id: 'T13 unknown key_mode rejected',
    sql: `UPDATE api_keys SET key_mode = 'SUPERUSER' WHERE id = '${KEY.standalone}'`,
    code: '23514',
  },
  {
    id: 'T14 zero access_version rejected',
    sql: `UPDATE profile_groups SET access_version = 0 WHERE group_id = '${GROUP.withChild}'`,
    code: '23514',
  },
  {
    id: 'T15 actor-attributed keyless group revision accepted',
    sql: `INSERT INTO profile_group_revisions (group_id, revision, tenant_id, name, created_by)
          VALUES ('${GROUP.withChild}', 2, '${TENANT_A}', 'pc02-child-group', 'admin')`,
  },
  {
    id: 'T16 unattributed group revision rejected',
    sql: `INSERT INTO profile_group_revisions (group_id, revision, tenant_id, name)
          VALUES ('${GROUP.withChild}', 3, '${TENANT_A}', 'pc02-child-group')`,
    code: '23514',
  },
];

interface SuiteState {
  db?: Db;
  admin?: Pool;
  preDir: string;
  pre: Map<string, QueryResult<QueryResultRow>>;
  post: Map<string, QueryResult<QueryResultRow>>;
  appliedByRunner: string[];
  appliedOnRerun: string[];
  statusAfter?: MigrationStatus;
}

const state: SuiteState = {
  preDir: '',
  pre: new Map(),
  post: new Map(),
  appliedByRunner: [],
  appliedOnRerun: [],
};

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort();
}

/** A copy of the migration directory as it looked before PC-02 (0001..0069). */
function buildPreMigrationDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pc02-pre-'));
  for (const name of migrationFiles()) {
    if (name === NEW_MIGRATION) continue;
    copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
  }
  return dir;
}

async function runQueries(db: Db, cases: readonly QueryCase[]): Promise<Map<string, QueryResult<QueryResultRow>>> {
  const results = new Map<string, QueryResult<QueryResultRow>>();
  for (const item of cases) {
    try {
      results.set(item.id, await db.query(item.sql));
    } catch (error) {
      throw new Error(`${item.id} failed: ${(error as Error).message}`);
    }
  }
  return results;
}

liveDescribe('PC-02 0070 storage migration (real runner, real PostgreSQL)', () => {
  beforeAll(async () => {
    assertTestDatabase();
    state.admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
    const client = await state.admin.connect();
    try {
      await client.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [SCRATCH_DB],
      );
      await client.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
      await client.query(`CREATE DATABASE "${SCRATCH_DB}"`);
    } finally {
      client.release();
    }

    state.db = createDb(SCRATCH_URL);

    // 1. Bring the scratch database to 0069 through the real runner.
    state.preDir = buildPreMigrationDir();
    const first = await migrate(state.db, state.preDir);
    expect(first.applied).toHaveLength(66);

    // 2. Load legacy-shaped data (exactly what a pre-PC-02 deployment holds).
    await state.db.tx(async (client) => {
      await client.query(LEGACY_FIXTURE_SQL);
    });

    // 3. Run the 16 pre-migration inventory queries against the 0069 schema.
    state.pre = await runQueries(state.db, PRE_MIGRATION_QUERIES);

    // 4. Apply 0070 from the REAL shipped directory (not a copy).
    const upgrade = await migrate(state.db, MIGRATIONS_DIR);
    state.appliedByRunner = upgrade.applied;
    state.appliedOnRerun = (await migrate(state.db, MIGRATIONS_DIR)).applied;
    state.statusAfter = await migrationStatus(state.db, MIGRATIONS_DIR);

    // 5. Run the 9 post-migration verification queries.
    state.post = await runQueries(state.db, POST_MIGRATION_QUERIES);
  }, 300_000);

  afterAll(async () => {
    try {
      await state.db?.close();
    } catch {
      /* best effort */
    }
    try {
      if (state.admin) {
        const client = await state.admin.connect();
        try {
          await client.query(
            'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
            [SCRATCH_DB],
          );
          await client.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
        } finally {
          client.release();
        }
        await state.admin.end();
      }
    } catch {
      /* scratch database is non-critical */
    }
    if (state.preDir) rmSync(state.preDir, { recursive: true, force: true });
  }, 60_000);

  describe('runner: upgrade path and drift guard', () => {
    test('the upgrade applies exactly the new 0070 file', () => {
      expect(state.appliedByRunner).toEqual([NEW_MIGRATION]);
    });

    test('verifyMigrations passes: 0 missing declared objects (drift guard green)', async () => {
      // verifyMigrations runs recordedMigrationsMissingObjects, the same guard
      // that fails the startup schema gate. It resolves => every object any
      // recorded migration declared still exists, including 0028's
      // profile_names_identity that 0070 re-scopes.
      await expect(verifyMigrations(state.db!, MIGRATIONS_DIR)).resolves.toBeUndefined();
    });

    test('migrationStatus reports no pending files and no integrity problems', () => {
      const status = state.statusAfter!;
      expect(status.pending).toEqual([]);
      expect(status.integrityProblems).toEqual([]);
      expect(status.total).toBe(67);
      expect(status.applied).toBe(67);
    });

    test('a second migrate() applies nothing (idempotent)', () => {
      expect(state.appliedOnRerun).toEqual([]);
    });

    test('the ledger records 0070 with the current LF checksum', async () => {
      const ledger = await state.db!.query<{ filename: string; checksum: string; checksum_provenance: string }>(
        'SELECT filename, checksum, checksum_provenance FROM schema_migrations WHERE sequence = 70',
      );
      expect(ledger.rows).toHaveLength(1);
      expect(ledger.rows[0]!.filename).toBe(NEW_MIGRATION);
      expect(ledger.rows[0]!.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(ledger.rows[0]!.checksum_provenance).toBe('migration');
    });
  });

  describe('pre-migration inventory (16 queries against the 0069 schema)', () => {
    test('every inventory query executes', () => {
      expect([...state.pre.keys()]).toHaveLength(PRE_MIGRATION_QUERIES.length);
    });

    test('INV-01: ledger is at 0069 before the upgrade', () => {
      const row = state.pre.get('INV-01')!.rows[0]! as { max_applied_sequence: number; applied_files: string };
      expect(Number(row.max_applied_sequence)).toBe(69);
      expect(Number(row.applied_files)).toBe(66);
    });

    test('INV-03: every group revision author is ACTIVE and in-tenant (needs_review false)', () => {
      const rows = state.pre.get('INV-03')!.rows as Array<{ needs_review: boolean }>;
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.needs_review === false)).toBe(true);
    });

    test('INV-04: no non-empty group has an ambiguous or missing key', () => {
      expect(state.pre.get('INV-04')!.rows).toHaveLength(0);
    });

    test('INV-05: the two member-less groups are reported', () => {
      const ids = (state.pre.get('INV-05')!.rows as Array<{ group_id: string }>).map((row) => row.group_id);
      expect(new Set(ids)).toEqual(new Set([GROUP.empty, GROUP.otherTenant]));
    });

    test('INV-06/07/08: no pointer drift, no shared key, no duplicate selector', () => {
      expect(state.pre.get('INV-06')!.rows).toHaveLength(0);
      expect(state.pre.get('INV-07')!.rows).toHaveLength(0);
      expect(state.pre.get('INV-08')!.rows).toHaveLength(0);
    });

    test('INV-09: shadow classification matches the designed evidence rules', () => {
      const rows = state.pre.get('INV-09')!.rows as Array<{ prefix: string; proposed_key_mode: string }>;
      const modes = new Map(rows.map((row) => [row.prefix, row.proposed_key_mode]));
      expect(Object.fromEntries(modes)).toEqual({
        du_a: 'LEGACY_STANDALONE',
        du_b: 'LEGACY_STANDALONE',
        du_c: 'UNMANAGED_LEGACY',
        du_d: 'LEGACY_STANDALONE',
        du_e: 'LEGACY_STANDALONE',
        du_f: 'LEGACY_STANDALONE',
      });
    });

    test('INV-10: projected split is 5 standalone / 1 unmanaged', () => {
      const rows = state.pre.get('INV-10')!.rows as Array<{ proposed_key_mode: string; keys: string }>;
      const byMode = new Map(rows.map((row) => [row.proposed_key_mode, Number(row.keys)]));
      expect(byMode.get('LEGACY_STANDALONE')).toBe(5);
      expect(byMode.get('UNMANAGED_LEGACY')).toBe(1);
    });

    test('INV-11: the three zero-active-membership trap keys are surfaced, never unmanaged', () => {
      const prefixes = (state.pre.get('INV-11')!.rows as Array<{ prefix: string }>)
        .map((row) => row.prefix)
        .sort();
      expect(prefixes).toEqual(['du_b', 'du_d', 'du_f']);
    });

    test('INV-12: exactly the never-associated key has zero footprint', () => {
      const rows = state.pre.get('INV-12')!.rows as Array<{ prefix: string; operations: string }>;
      expect(rows.map((row) => row.prefix)).toEqual(['du_c']);
      expect(Number(rows[0]!.operations)).toBe(0);
    });

    test('INV-13/14/16: no name collisions, no cross-tenant authors, no ownerless registry row', () => {
      expect(state.pre.get('INV-13')!.rows).toHaveLength(0);
      const crossTenant = state.pre.get('INV-14')!.rows as Array<{ rows: string }>;
      expect(crossTenant).toHaveLength(3);
      expect(crossTenant.every((row) => Number(row.rows) === 0)).toBe(true);
      expect(Number((state.pre.get('INV-16')!.rows[0]! as { rows_without_owner: string }).rows_without_owner)).toBe(0);
    });

    test('INV-15: no operations pinned before the upgrade', () => {
      expect(state.pre.get('INV-15a')!.rows).toHaveLength(0);
      expect(Number((state.pre.get('INV-15b')!.rows[0]! as { in_flight_profile_pinned_operations: string })
        .in_flight_profile_pinned_operations)).toBe(0);
    });
  });

  describe('post-migration verification (9 queries after 0070)', () => {
    test('every verification query executes', () => {
      expect([...state.post.keys()]).toHaveLength(POST_MIGRATION_QUERIES.length);
    });

    test('VER-01: all new columns are exposed with the designed nullability', () => {
      const rows = state.post.get('VER-01')!.rows as Array<{ table_name: string; column_name: string; is_nullable: string }>;
      const key = (table: string, column: string) => rows.find((row) => row.table_name === table && row.column_name === column);
      expect(key('api_keys', 'key_mode')?.is_nullable).toBe('YES');
      expect(key('profile_groups', 'auth_mode')?.is_nullable).toBe('NO');
      expect(key('profile_groups', 'auth_authority')?.is_nullable).toBe('NO');
      expect(key('profile_groups', 'access_version')?.is_nullable).toBe('NO');
      expect(key('profile_bindings', 'request_defaults')?.is_nullable).toBe('NO');
      expect(key('profile_bindings', 'api_key_id')?.is_nullable).toBe('YES');
      expect(key('profile_bindings', 'created_by')?.is_nullable).toBe('YES');
      expect(key('profile_group_revisions', 'api_key_id')?.is_nullable).toBe('YES');
      expect(key('profile_names', 'api_key_id')?.is_nullable).toBe('YES');
      expect(rows.filter((row) => row.table_name === 'profile_group_api_keys').length).toBeGreaterThanOrEqual(10);
    });

    test('VER-02: both composite tenant FKs and the attribution/ownership checks exist', () => {
      const names = new Set((state.post.get('VER-02')!.rows as Array<{ conname: string }>).map((row) => row.conname));
      for (const required of [
        'api_keys_key_mode_check',
        'profile_groups_auth_mode_check',
        'profile_groups_auth_authority_check',
        'profile_group_api_keys_group_tenant_fk',
        'profile_group_api_keys_key_tenant_fk',
        'profile_group_api_keys_revocation_shape',
        'profile_bindings_attribution_shape',
        'profile_group_revisions_attribution_shape',
        'profile_names_owner_shape',
      ]) {
        expect(names).toContain(required);
      }
    });

    test('VER-03: profile_names_identity survives under its original name with the narrowed predicate', () => {
      const indexes = state.post.get('VER-03')!.rows as Array<{ tablename: string; indexname: string; indexdef: string }>;
      const identity = indexes.find((row) => row.indexname === 'profile_names_identity');
      expect(identity).toBeDefined();
      expect(identity!.indexdef).toContain('group_id IS NULL');
      const groupIdentity = indexes.find((row) => row.indexname === 'profile_names_group_identity');
      expect(groupIdentity!.indexdef).toContain('group_id IS NOT NULL');
      for (const required of [
        'api_keys_id_tenant_unique',
        'profile_group_api_keys_group_active',
        'profile_group_revisions_author',
      ]) {
        expect(indexes.some((row) => row.indexname === required)).toBe(true);
      }
    });

    test('VER-04: every pre-existing key is classified, none is NULL', () => {
      const rows = state.post.get('VER-04')!.rows as Array<{ key_mode: string; keys: string }>;
      const byMode = new Map(rows.map((row) => [row.key_mode, Number(row.keys)]));
      expect(byMode.has('<NULL>')).toBe(false);
      expect(byMode.get('LEGACY_STANDALONE')).toBe(5);
      expect(byMode.get('UNMANAGED_LEGACY')).toBe(1);
    });

    test('VER-05: authority did not silently change and access_version starts at 1', () => {
      const rows = state.post.get('VER-05')!.rows as Array<{
        auth_mode: string; auth_authority: string; groups: string;
        min_access_version: string; max_access_version: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.auth_mode).toBe('API_KEY');
      expect(rows[0]!.auth_authority).toBe('CHILD_PROJECTION');
      expect(Number(rows[0]!.groups)).toBe(3);
      expect(Number(rows[0]!.min_access_version)).toBe(1);
      expect(Number(rows[0]!.max_access_version)).toBe(1);
    });

    test('VER-06: the grant ledger is empty on first deploy', () => {
      const row = state.post.get('VER-06')!.rows[0]! as { rows: string; active_grants: string; tombstones: string };
      expect(Number(row.rows)).toBe(0);
      expect(Number(row.active_grants)).toBe(0);
      expect(Number(row.tombstones)).toBe(0);
    });

    test('VER-07: every revision keeps an author (key or Admin actor)', () => {
      const rows = state.post.get('VER-07')!.rows as Array<{ unattributed: string }>;
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => Number(row.unattributed) === 0)).toBe(true);
    });

    test('VER-08: the three author ids are nullable after the upgrade', () => {
      const rows = state.post.get('VER-08')!.rows as Array<{ is_nullable: string }>;
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.is_nullable === 'YES')).toBe(true);
    });

    test('VER-09: 0 missing declared objects', async () => {
      const row = state.post.get('VER-09')!.rows[0]! as { missing_declared_objects: string };
      expect(Number(row.missing_declared_objects)).toBe(0);
      const present = await state.db!.query<{ present: boolean }>(
        "SELECT to_regclass('profile_names_identity') IS NOT NULL AS present",
      );
      expect(present.rows[0]!.present).toBe(true);
    });
  });

  describe('constraint contract (accept/reject)', () => {
    test('spare group exists for the cross-group cases', async () => {
      await state.db!.tx(async (client) => {
        await client.query(
          `INSERT INTO profile_groups (group_id, tenant_id, name, active_revision) VALUES ($1, $2, 'pc02-spare-group', 0)`,
          [GROUP.spare, TENANT_A],
        );
        await client.query(
          `INSERT INTO profile_group_revisions (group_id, revision, tenant_id, name, created_by) VALUES ($1, 1, $2, 'pc02-spare-group', 'admin')`,
          [GROUP.spare, TENANT_A],
        );
        await client.query('UPDATE profile_groups SET active_revision = 1 WHERE group_id = $1', [GROUP.spare]);
      });
    });

    for (const item of CONSTRAINT_CASES) {
      test(item.id, async () => {
        if (item.code === undefined) {
          await expect(state.db!.query(item.sql)).resolves.toBeDefined();
          return;
        }
        await expect(state.db!.query(item.sql)).rejects.toMatchObject({ code: item.code });
      });
    }
  });

  // Negative control: proves the assertions above are meaningful. Without the
  // name-preserving replacement in 0070, dropping 0028's declared object makes
  // the runner refuse the schema, which is exactly why the migration re-creates
  // `profile_names_identity` under its original name instead of renaming it.
  describe('drift guard negative control', () => {
    test('verifyMigrations and migrationStatus fail when a declared object disappears', async () => {
      await state.db!.query('DROP INDEX profile_names_identity');

      await expect(verifyMigrations(state.db!, MIGRATIONS_DIR)).rejects.toThrow(/profile_names_identity/);
      const status = await migrationStatus(state.db!, MIGRATIONS_DIR);
      expect(status.integrityProblems.join(' ')).toMatch(/profile_names_identity/);

      // Restore the object so the scratch database is left consistent.
      await state.db!.query(
        `CREATE UNIQUE INDEX profile_names_identity
           ON profile_names (tenant_id, api_key_id, business_id, business_version, action, profile_name)
         WHERE group_id IS NULL`,
      );
      await expect(verifyMigrations(state.db!, MIGRATIONS_DIR)).resolves.toBeUndefined();
    });
  });
});
