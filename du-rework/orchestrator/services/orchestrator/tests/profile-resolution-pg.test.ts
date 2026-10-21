import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createDb, type Db } from '../src/db/db';
import { createProfileService } from '../src/modules/profiles/profiles';
import { createRegistryService } from '../src/modules/registry/registry';
import { migrate, verifyMigrations } from '../src/db/migrations';
import {
  createSubmissionService,
  resolveGroupAdmission,
  type ProfileResolutionV2Request,
} from '../src/modules/operations/submission';

/**
 * PC-05 live suite (WINDOW-GATED: DU_LIVE_INFRA=1).
 *
 * Proves the root-grant resolver and the v2 admission against a real
 * PostgreSQL built by the real migration chain:
 *
 *   - a GROUP_MANAGED key resolves through its root grant with NO child
 *     membership;
 *   - it never falls back to child membership, and a revoked grant denies;
 *   - an ambiguous v1 selector denies instead of choosing;
 *   - preview/submit round-trip, fingerprint storage, exact replay after
 *     drift, stale-fingerprint 409 BEFORE any durable write, and the
 *     requestDefaults/locked-parameter rules.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const DB_NAME = new URL(DATABASE_URL).pathname.split('/').pop() ?? 'du_orchestrator_test';
const BASE_URL = DATABASE_URL.replace(/\/[^/]+$/, '');
const ADMIN_URL = `${BASE_URL}/postgres`;
const SCRATCH_DB = 'du_pc05_resolution_test';
const SCRATCH_URL = `${BASE_URL}/${SCRATCH_DB}`;
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn('profile-resolution-pg.test.ts: SKIPPED - set DU_LIVE_INFRA=1 with a test PostgreSQL to run.');
}

const TENANT = '00000000-0000-0000-0000-0000000000a1';
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000a2';
const GROUP = '00000000-0000-0000-0000-0000000000c1';
const GROUP_WITH_CHILD = '00000000-0000-0000-0000-0000000000c2';
const KEY_GROUP = '00000000-0000-0000-0000-00000000000a';
const KEY_GROUP_NO_GRANT = '00000000-0000-0000-0000-00000000000b';
const KEY_GROUP_REVOKED = '00000000-0000-0000-0000-00000000000c';
const KEY_GROUP_LOCKED = '00000000-0000-0000-0000-00000000000d';
const KEY_LEGACY = '00000000-0000-0000-0000-00000000000e';
const CHILD = '00000000-0000-0000-0000-0000000000b1';
const CHILD_LOCKED = '00000000-0000-0000-0000-0000000000b2';
const BUSINESS = 'pc05-core';
const BUSINESS_VERSION = '1.0.0';
const DIGEST = `sha256:${'5'.repeat(64)}`;

const MANIFEST = {
  contractVersion: '1',
  businessId: BUSINESS,
  version: BUSINESS_VERSION,
  displayName: 'PC05 Core',
  description: '',
  imageDigest: DIGEST,
  runtime: { wireVersion: '1', handlerKinds: ['extract'] },
  capabilities: { cancel: true, resume: true, parallel: false },
  actions: [{
    name: 'extract',
    displayName: 'Extract',
    description: '',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', default: 'standard' },
        flavor: { type: 'string' },
        maxTokens: { type: 'number' },
      },
      additionalProperties: true,
    },
    outputSchema: { type: 'object' },
    profileSchema: { type: 'object', properties: { maxTokens: { type: 'number' } } },
    connectorSlots: [],
    artifactPolicy: { minFiles: 0, maxFiles: 4 },
    capabilities: { cancel: true, resume: true },
    defaultLimits: {},
    parameterResolution: {
      version: 2,
      fields: { mode: 'requestDefaults', maxTokens: 'requestDefaults' },
      applyTopLevelDefaults: true,
    },
  }],
};

interface SuiteState {
  db?: Db;
  admin?: Pool;
  submission?: ReturnType<typeof createSubmissionService>;
}

const state: SuiteState = {};

const FIXTURE_SQL = `
INSERT INTO tenants (id, name) VALUES
  ('${TENANT}', 'pc05-tenant'),
  ('${OTHER_TENANT}', 'pc05-other-tenant')
ON CONFLICT DO NOTHING;

INSERT INTO api_keys (id, tenant_id, hash, prefix, status, key_mode, name) VALUES
  ('${KEY_GROUP}',           '${TENANT}', 'pc05-hash-a', 'du_a', 'ACTIVE', 'GROUP_MANAGED',   'grouped key'),
  ('${KEY_GROUP_NO_GRANT}',  '${TENANT}', 'pc05-hash-b', 'du_b', 'ACTIVE', 'GROUP_MANAGED',   'grouped key without grant'),
  ('${KEY_GROUP_REVOKED}',   '${TENANT}', 'pc05-hash-c', 'du_c', 'ACTIVE', 'GROUP_MANAGED',   'grouped key revoked'),
  ('${KEY_GROUP_LOCKED}',    '${TENANT}', 'pc05-hash-d', 'du_d', 'ACTIVE', 'GROUP_MANAGED',   'grouped key locked'),
  ('${KEY_LEGACY}',          '${TENANT}', 'pc05-hash-e', 'du_e', 'ACTIVE', 'LEGACY_STANDALONE', 'legacy key')
ON CONFLICT DO NOTHING;

INSERT INTO business_catalog (business_id, enabled, activation_revision, submissions_paused)
VALUES ('${BUSINESS}', true, 1, false)
ON CONFLICT (business_id) DO UPDATE SET enabled=true;

INSERT INTO business_versions (business_id, version, contract_version, manifest, digest, status, queue, is_active)
VALUES ('${BUSINESS}', '${BUSINESS_VERSION}', '1', $json$ ${JSON.stringify(MANIFEST)} $json$::jsonb, '${DIGEST}', 'ENABLED',
        'du-business-${BUSINESS}-${BUSINESS_VERSION}', true)
ON CONFLICT (business_id, version) DO UPDATE SET is_active=true, status='ENABLED';

INSERT INTO profile_groups (group_id, tenant_id, name, active_revision, auth_authority, access_version) VALUES
  ('${GROUP}',            '${TENANT}', 'pc05-group', 0, 'GROUP_GRANT', 1),
  ('${GROUP_WITH_CHILD}', '${TENANT}', 'pc05-group-child', 0, 'CHILD_PROJECTION', 1)
ON CONFLICT DO NOTHING;

INSERT INTO profile_group_revisions (group_id, revision, tenant_id, name, api_key_id, created_by) VALUES
  ('${GROUP}', 1, '${TENANT}', 'pc05-group', NULL, 'admin'),
  ('${GROUP_WITH_CHILD}', 1, '${TENANT}', 'pc05-group-child', NULL, 'admin')
ON CONFLICT DO NOTHING;

UPDATE profile_groups SET active_revision = 1 WHERE group_id IN ('${GROUP}', '${GROUP_WITH_CHILD}');

INSERT INTO profile_group_api_keys (api_key_id, group_id, tenant_id, state, granted_by, revoked_at, revoked_by) VALUES
  ('${KEY_GROUP}', '${GROUP}', '${TENANT}', 'ACTIVE', 'admin', NULL, NULL),
  ('${KEY_GROUP_REVOKED}', '${GROUP}', '${TENANT}', 'REVOKED', 'admin', now(), 'admin'),
  ('${KEY_GROUP_LOCKED}', '${GROUP}', '${TENANT}', 'ACTIVE', 'admin', NULL, NULL)
ON CONFLICT DO NOTHING;

INSERT INTO profile_bindings
  (profile_id, revision, tenant_id, api_key_id, business_id, business_version, action, enabled,
   parameters, request_defaults, endpoint_slug, created_by)
VALUES
  ('${CHILD}', 1, '${TENANT}', NULL, '${BUSINESS}', '${BUSINESS_VERSION}', 'extract', true,
   '{}'::jsonb, '{"mode":{"value":"strict"},"maxTokens":{"value":128}}'::jsonb, 'extract:invoice', 'admin'),
  ('${CHILD_LOCKED}', 1, '${TENANT}', NULL, '${BUSINESS}', '${BUSINESS_VERSION}', 'extract', true,
   '{}'::jsonb, '{"maxTokens":{"value":64,"isLocked":true}}'::jsonb, NULL, 'admin')
ON CONFLICT DO NOTHING;

INSERT INTO profile_names (profile_id, tenant_id, api_key_id, business_id, business_version, action, profile_name, group_id)
VALUES
  ('${CHILD}', '${TENANT}', NULL, '${BUSINESS}', '${BUSINESS_VERSION}', 'extract', 'pc05-child', '${GROUP}'),
  ('${CHILD_LOCKED}', '${TENANT}', NULL, '${BUSINESS}', '${BUSINESS_VERSION}', 'extract', 'pc05-child-locked', '${GROUP}')
ON CONFLICT DO NOTHING;

INSERT INTO profile_group_members
  (group_id, group_revision, business_id, business_version, manifest_digest, function_kind, function_id,
   action, endpoint_slug, profile_id, binding_revision)
VALUES
  ('${GROUP}', 1, '${BUSINESS}', '${BUSINESS_VERSION}', '${DIGEST}', 'endpoint', 'extract.invoice',
   'extract', 'extract:invoice', '${CHILD}', 1),
  -- Same endpoint selector, different function id: a v1 request that carries
  -- only the selector matches BOTH, which is the ambiguity the plan denies.
  ('${GROUP}', 1, '${BUSINESS}', '${BUSINESS_VERSION}', '${DIGEST}', 'endpoint', 'extract.receipt',
   'extract', 'extract:invoice', '${CHILD_LOCKED}', 1)
ON CONFLICT DO NOTHING;

-- The no-grant key DOES hold an ACTIVE child membership: the fallback trap.
INSERT INTO profile_api_keys (profile_id, api_key_id, tenant_id, state)
VALUES ('${CHILD}', '${KEY_GROUP_NO_GRANT}', '${TENANT}', 'ACTIVE')
ON CONFLICT DO NOTHING;

-- The group-with-child projection still owns its child through profile_names.
INSERT INTO profile_names (profile_id, tenant_id, api_key_id, business_id, business_version, action, profile_name, group_id)
VALUES ('00000000-0000-0000-0000-0000000000b9', '${TENANT}', '${KEY_LEGACY}', '${BUSINESS}', '${BUSINESS_VERSION}', 'extract', 'pc05-legacy', NULL)
ON CONFLICT DO NOTHING;
`;

async function waitFor(pool: Pool): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('test PostgreSQL did not become ready');
}

function selector(overrides: Partial<ProfileResolutionV2Request['selector']> = {}) {
  return {
    businessId: BUSINESS,
    businessVersion: BUSINESS_VERSION,
    action: 'extract',
    functionId: 'extract.invoice',
    endpointSlug: 'extract:invoice',
    ...overrides,
  };
}

function v2Request(overrides: Partial<ProfileResolutionV2Request> = {}): ProfileResolutionV2Request {
  return {
    tenantId: TENANT,
    apiKeyId: KEY_GROUP,
    groupId: GROUP,
    selector: selector(),
    submission: { input: { mode: 'client', flavor: 'vanilla' } },
    ...overrides,
  };
}

liveDescribe('PC-05 resolution and v2 admission (real runner, real PostgreSQL)', () => {
  beforeAll(async () => {
    state.admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
    await waitFor(state.admin);
    const client = await state.admin.connect();
    try {
      await client.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
        [SCRATCH_DB],
      );
      await client.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
      await client.query(`CREATE DATABASE "${SCRATCH_DB}"`);
    } finally {
      client.release();
    }
    state.db = createDb(SCRATCH_URL);
    await migrate(state.db, MIGRATIONS_DIR);
    await state.db.tx(async (tx) => {
      await tx.query(FIXTURE_SQL);
    });
    const db = state.db;
    state.submission = createSubmissionService(
      db,
      createRegistryService(db),
      createProfileService(db, { cryptoEnv: {} }),
      { storageBackend: 'postgres' },
    );
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
            'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
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
  }, 60_000);

  describe('migration 0071 (fingerprint storage)', () => {
    test('the ledger records 0071 and the drift guard stays green', async () => {
      // verifyMigrations runs the declared-object drift guard: it resolving
      // proves every object any recorded migration created still exists.
      await expect(verifyMigrations(state.db!, MIGRATIONS_DIR)).resolves.toBeUndefined();
      const ledger = await state.db!.query<{ checksum: string; checksum_provenance: string }>(
        'SELECT checksum, checksum_provenance FROM schema_migrations WHERE sequence=71',
      );
      expect(ledger.rows).toHaveLength(1);
      expect(ledger.rows[0]!.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(ledger.rows[0]!.checksum_provenance).toBe('migration');
    });

    test('submission_keys.resolution_fingerprint is nullable text with a shape check', async () => {
      const column = await state.db!.query<{ data_type: string; is_nullable: string }>(
        `SELECT data_type, is_nullable FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name='submission_keys' AND column_name='resolution_fingerprint'`,
      );
      expect(column.rows[0]).toMatchObject({ data_type: 'text', is_nullable: 'YES' });
      await expect(state.db!.query(
        `INSERT INTO submission_keys (tenant_id, api_key_id, route_action, key, request_hash, operation_id, expires_at, resolution_fingerprint)
         VALUES ($1, $2, 'pc05-shape', 'k1', 'h', gen_random_uuid(), now() + interval '1 hour', 'not-a-digest')`,
        [TENANT, KEY_LEGACY],
      )).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('root-grant resolution', () => {
    test('a GROUP_MANAGED key resolves through its grant with no child membership', async () => {
      const resolved = await resolveGroupAdmission(state.db as never, {}, {
        apiKeyId: KEY_GROUP,
        tenantId: TENANT,
        selector: { ...selector(), groupId: GROUP },
        action: MANIFEST.actions[0] as never,
        clientInput: {},
        declaredKeys: ['mode', 'flavor', 'maxTokens'],
      });
      expect(resolved).not.toBeNull();
      expect(resolved!.groupPin).toMatchObject({
        groupId: GROUP,
        childProfileId: CHILD,
        childRevision: 1,
        accessVersion: 1,
      });
      expect(resolved!.profile.mode).toBe('pinned');
    });

    test('a grouped key with NO grant denies even when it holds an ACTIVE child membership', async () => {
      await expect(resolveGroupAdmission(state.db as never, {}, {
        apiKeyId: KEY_GROUP_NO_GRANT,
        tenantId: TENANT,
        selector: { ...selector(), groupId: GROUP },
        action: MANIFEST.actions[0] as never,
        clientInput: {},
        declaredKeys: [],
      })).rejects.toMatchObject({ status: 403, code: 'PROFILE_GROUP_UNAUTHORIZED' });
    });

    test('a revoked grant denies', async () => {
      await expect(resolveGroupAdmission(state.db as never, {}, {
        apiKeyId: KEY_GROUP_REVOKED,
        tenantId: TENANT,
        selector: { ...selector(), groupId: GROUP },
        action: MANIFEST.actions[0] as never,
        clientInput: {},
        declaredKeys: [],
      })).rejects.toMatchObject({ status: 403, code: 'PROFILE_GROUP_UNAUTHORIZED' });
    });

    test('an ambiguous v1 selector denies instead of choosing', async () => {
      await expect(resolveGroupAdmission(state.db as never, {}, {
        apiKeyId: KEY_GROUP,
        tenantId: TENANT,
        selector: { businessId: BUSINESS, businessVersion: BUSINESS_VERSION, action: 'extract', endpointSlug: 'extract:invoice' },
        action: MANIFEST.actions[0] as never,
        clientInput: {},
        declaredKeys: [],
      })).rejects.toMatchObject({ status: 403, code: 'PROFILE_GROUP_UNAUTHORIZED' });
    });

    test('a legacy key falls through to the standalone resolver (null group pin)', async () => {
      const resolved = await resolveGroupAdmission(state.db as never, {}, {
        apiKeyId: KEY_LEGACY,
        tenantId: TENANT,
        selector: { ...selector(), groupId: GROUP },
        action: MANIFEST.actions[0] as never,
        clientInput: {},
        declaredKeys: [],
      });
      expect(resolved).toBeNull();
    });

    test('a key from another tenant denies', async () => {
      await expect(resolveGroupAdmission(state.db as never, {}, {
        apiKeyId: KEY_GROUP,
        tenantId: OTHER_TENANT,
        selector: { ...selector(), groupId: GROUP },
        action: MANIFEST.actions[0] as never,
        clientInput: {},
        declaredKeys: [],
      })).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('v2 preview and submit', () => {
    test('preview returns refs, a fingerprint and the applied request defaults', async () => {
      const preview = await state.submission!.previewProfileV2(v2Request({ submission: { input: { flavor: 'x' } } }));
      expect(preview.refs.groupId).toBe(GROUP);
      expect(preview.refs.childProfileId).toBe(CHILD);
      expect(preview.resolutionFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(preview.effective.parameters).toMatchObject({ flavor: 'x', mode: 'strict' });
      expect(preview.effective.appliedRequestDefaults).toContain('mode');
    });

    test('a supplied locked request default is refused', async () => {
      await expect(state.submission!.previewProfileV2(v2Request({
        apiKeyId: KEY_GROUP_LOCKED,
        selector: selector({ functionId: 'extract.receipt' }),
        submission: { input: { maxTokens: 64 } },
      }))).rejects.toMatchObject({ status: 400, code: 'PROFILE_LOCKED_FIELD' });
    });

    test('submit persists the fingerprint and replay returns the original operation', async () => {
      const preview = await state.submission!.previewProfileV2(v2Request());
      const first = await state.submission!.submitProfileV2(v2Request({
        resolutionFingerprint: preview.resolutionFingerprint,
        idempotencyKey: 'pc05-submit-1',
      }));
      expect(first.replayed).toBe(false);

      const stored = await state.db!.query<{ resolution_fingerprint: string | null }>(
        `SELECT resolution_fingerprint FROM submission_keys
          WHERE tenant_id=$1 AND api_key_id=$2 AND key=$3`,
        [TENANT, KEY_GROUP, 'pc05-submit-1'],
      );
      expect(stored.rows[0]!.resolution_fingerprint).toBe(preview.resolutionFingerprint);

      const replay = await state.submission!.submitProfileV2(v2Request({
        resolutionFingerprint: preview.resolutionFingerprint,
        idempotencyKey: 'pc05-submit-1',
      }));
      expect(replay.replayed).toBe(true);
      expect(replay.operation.id).toBe(first.operation.id);
    });

    test('an exact replay still returns the pinned operation after the access version drifts', async () => {
      const preview = await state.submission!.previewProfileV2(v2Request());
      const first = await state.submission!.submitProfileV2(v2Request({
        resolutionFingerprint: preview.resolutionFingerprint,
        idempotencyKey: 'pc05-drift',
      }));
      await state.db!.query('UPDATE profile_groups SET access_version = access_version + 1 WHERE group_id=$1', [GROUP]);

      const replay = await state.submission!.submitProfileV2(v2Request({
        resolutionFingerprint: preview.resolutionFingerprint,
        idempotencyKey: 'pc05-drift',
      }));
      expect(replay.replayed).toBe(true);
      expect(replay.operation.id).toBe(first.operation.id);
    });

    test('a stale fingerprint on a new submission is a 409 with zero durable rows', async () => {
      const before = await state.db!.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM operations WHERE business_id=$1',
        [BUSINESS],
      );
      const preview = await state.submission!.previewProfileV2(v2Request());
      await state.db!.query('UPDATE profile_groups SET access_version = access_version + 1 WHERE group_id=$1', [GROUP]);
      await expect(state.submission!.submitProfileV2(v2Request({
        resolutionFingerprint: preview.resolutionFingerprint,
        idempotencyKey: 'pc05-stale',
      }))).rejects.toMatchObject({ status: 409, code: 'PROFILE_CHANGED' });
      const after = await state.db!.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM operations WHERE business_id=$1',
        [BUSINESS],
      );
      expect(Number(after.rows[0]!.n)).toBe(Number(before.rows[0]!.n));
    });

    test('the same idempotency key with a different fingerprint conflicts', async () => {
      const preview = await state.submission!.previewProfileV2(v2Request());
      await state.submission!.submitProfileV2(v2Request({
        resolutionFingerprint: preview.resolutionFingerprint,
        idempotencyKey: 'pc05-conflict',
      }));
      await expect(state.submission!.submitProfileV2(v2Request({
        resolutionFingerprint: `sha256:${'9'.repeat(64)}`,
        idempotencyKey: 'pc05-conflict',
      }))).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    });
  });
});
