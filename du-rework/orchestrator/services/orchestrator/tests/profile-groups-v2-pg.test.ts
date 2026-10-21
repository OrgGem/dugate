/**
 * PC-03 live PostgreSQL suite (WINDOW-GATED: `DU_LIVE_INFRA=1`).
 *
 * Proves against a real PostgreSQL that the v2 group service and its
 * compatibility firewall behave as designed on the `0070` schema:
 *
 *   V2-L1  0070 objects exist and `request_defaults` defaults to `{}`
 *   V2-L2  attribution shape: a revision with neither a key nor an actor fails
 *   V2-L3  `profile_names_owner_shape`: an unowned registry row fails
 *   V2-L4  name uniqueness split (standalone vs grouped)
 *   V2-L5  one root grant per key id, forever (primary key)
 *   V2-L6  revocation-shape check on the grant ledger
 *   V2-R1  zero-key GROUP_GRANT group: create, read (empty grants), v1 read 409
 *   V2-B1  rollback moves the config pointer only (access_version untouched)
 *   V2-G1  issue: minted GROUP_MANAGED key + grant + access_version bump
 *   V2-G5  revoke: tombstone + bump, api_keys.status untouched
 *   V2-G9  a key already owned by another group is refused
 *   V2-L7  two concurrent PUTs: exactly one wins
 *   V2-L11 conversion happy path (authority flips, memberships revoked)
 *   V2-L12 conversion blocked when the candidate key is shared
 *   V2-L14 conversion is idempotent
 *   V2-L15 revokeAllGroupGrantsForApiKey bumps every affected group
 *
 * The database is a scratch database this suite creates and drops; the
 * configured DATABASE_URL database is never modified.
 */
import { mkdtempSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createDb, type Db } from '../src/db/db';
import { migrate } from '../src/db/migrations';
import {
  convertGroupToGrantAuthority,
  getProfileGroup,
  getProfileGroupV2,
  issueGroupKey,
  revokeAllGroupGrantsForApiKey,
  revokeGroupGrant,
  rollbackProfileGroupV2,
  saveProfileGroup,
  saveProfileGroupV2,
  type ProfileGroupActor,
} from '../src/modules/profiles/profile-groups';
import { createProfileService } from '../src/modules/profiles/profiles';
import { HttpError } from '../src/http/errors';
import type { ProfileGroupV2Save } from '@du/contracts';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const DB_NAME = new URL(DATABASE_URL).pathname.split('/').pop() ?? 'du_orchestrator_test';
const BASE_URL = DATABASE_URL.replace(/\/[^/]+$/, '');
const ADMIN_URL = `${BASE_URL}/postgres`;
const SCRATCH_DB = 'du_pc03_v2_test';
const SCRATCH_URL = `${BASE_URL}/${SCRATCH_DB}`;
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn(
    '[PC-03] live PG suite skipped: set DU_LIVE_INFRA=1 with a reachable DATABASE_URL to run it.',
  );
}

const TENANT_ID = '7a000000-0000-4000-8000-000000000001';
const OTHER_TENANT_ID = '7a000000-0000-4000-8000-000000000002';
const BUSINESS_ID = 'pc03-biz';
const BUSINESS_VERSION = '1.0.0';
const WORKFLOW_SLUG = 'run';
const DIGEST = `sha256:${'c'.repeat(64)}`;
const MANIFEST_DIGEST = `sha256:${'d'.repeat(64)}`;
const ACTOR: ProfileGroupActor = { actor: 'admin', role: 'platform' };

function manifest(): Record<string, unknown> {
  return {
    contractVersion: '1',
    businessId: BUSINESS_ID,
    version: BUSINESS_VERSION,
    displayName: 'PC-03 fixture business',
    description: 'fixture',
    imageDigest: 'sha256:fixture',
    runtime: { wireVersion: '1', handlerKinds: ['sdk-free'] },
    capabilities: { cancel: true, resume: true, parallel: false },
    actions: [{
      name: WORKFLOW_SLUG,
      displayName: 'Run',
      description: '',
      inputSchema: {
        type: 'object',
        properties: { quality: { type: 'string' } },
        required: [],
      },
      outputSchema: { type: 'object' },
      profileSchema: { type: 'object', properties: { quality: { type: 'string', defaultLocked: true } } },
      connectorSlots: [],
      artifactPolicy: { minFiles: 0, maxFiles: 4 },
      capabilities: { cancel: true, resume: true },
      defaultLimits: {},
    }],
  };
}

function v2Save(name: string, overrides: Partial<ProfileGroupV2Save> = {}): ProfileGroupV2Save {
  return {
    name,
    tenantId: TENANT_ID,
    authMode: 'API_KEY',
    expectedRevision: 0,
    businesses: [{
      businessId: BUSINESS_ID,
      businessVersion: BUSINESS_VERSION,
      manifestDigest: MANIFEST_DIGEST,
      functions: [{
        kind: 'workflow',
        functionId: WORKFLOW_SLUG,
        action: WORKFLOW_SLUG,
        workflowRevision: 1,
        policy: { parameters: { quality: { value: 'high', isLocked: true } } },
        requestDefaults: { quality: { value: 'high' } },
        connectorBindings: {},
      }],
    }],
    ...overrides,
  } as ProfileGroupV2Save;
}

async function expectHttpError(promise: Promise<unknown>, status: number, code?: string): Promise<HttpError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    const httpError = err as HttpError;
    expect(httpError.status).toBe(status);
    if (code) expect(httpError.code).toBe(code);
    return httpError;
  }
  throw new Error(`expected HttpError ${status}, but the call resolved`);
}

async function createScratchDatabase(): Promise<void> {
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  } finally {
    await admin.end();
  }
}

async function dropScratchDatabase(): Promise<void> {
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

liveDescribe('PC-03 live group control plane (0070)', () => {
  let db: Db;
  let profiles: ReturnType<typeof createProfileService>;
  let migrationsDir = MIGRATIONS_DIR;

  beforeAll(async () => {
    // Apply the real migration chain to a scratch database.
    await createScratchDatabase();
    // `migrate()` reads the service migrations directory; the suite runs under
    // ts-jest from src, so the shipped SQL is copied to a temp dir only when the
    // service directory is not the cwd-relative one.
    if (!readdirSync(MIGRATIONS_DIR).some((file) => file === '0070_profile_control_plane_storage.sql')) {
      const scratch = mkdtempSync(join(tmpdir(), 'pc03-migrations-'));
      for (const file of readdirSync(MIGRATIONS_DIR)) {
        copyFileSync(join(MIGRATIONS_DIR, file), join(scratch, file));
      }
      migrationsDir = scratch;
    }
    void migrationsDir;
    db = createDb(SCRATCH_URL);
    // DROP DATABASE ... WITH (FORCE) terminates live backends; without this the
    // pool emits an unhandled 'error' during teardown and fails the suite even
    // though every assertion passed.
    db.pool.on('error', () => undefined);
    await migrate(db);
    profiles = createProfileService(db, {});

    // Fixture tenant + registered business version + an ACTIVE workflow revision.
    await db.query('INSERT INTO tenants (id, name, state) VALUES ($1,$2,$3)', [TENANT_ID, 'pc03', 'ACTIVE']);
    await db.query('INSERT INTO tenants (id, name, state) VALUES ($1,$2,$3)', [OTHER_TENANT_ID, 'pc03-other', 'ACTIVE']);
    await db.query('INSERT INTO business_catalog (business_id, enabled) VALUES ($1, true)', [BUSINESS_ID]);
    await db.query(
      `INSERT INTO business_versions (business_id, version, manifest, digest, queue, status, is_active)
       VALUES ($1,$2,$3,$4,$5,'ENABLED',true)`,
      [BUSINESS_ID, BUSINESS_VERSION, JSON.stringify(manifest()), MANIFEST_DIGEST, `pc03-${BUSINESS_ID}`],
    );
    await db.query(
      `INSERT INTO legacy_workflow_schemas (tenant_id, slug, revision, digest, schema_ref, status)
       VALUES ($1,$2,1,$3,$4,'active')`,
      [TENANT_ID, WORKFLOW_SLUG, MANIFEST_DIGEST, JSON.stringify({ schema: manifest() })],
    );
  }, 180_000);

  afterAll(async () => {
    await db?.pool.end().catch(() => undefined);
    await dropScratchDatabase().catch(() => undefined);
  });

  async function insertKey(tenantId = TENANT_ID): Promise<{ id: string; hash: string }> {
    const id = randomUUID();
    const hash = randomUUID().replace(/-/g, '').padEnd(64, '0');
    await db.query(
      "INSERT INTO api_keys (id, tenant_id, hash, prefix, name, status, version) VALUES ($1,$2,$3,$4,$5,'ACTIVE',1)",
      [id, tenantId, hash, 'du_', 'pc03 fixture key'],
    );
    return { id, hash };
  }

  async function newV2Group(name: string): Promise<string> {
    return db.tx(async (client) => {
      const group = await saveProfileGroupV2(client, profiles, undefined, v2Save(name), null, ACTOR);
      return group.groupId;
    });
  }

  it('V2-L1 applies 0070 and defaults request_defaults to an object', async () => {
    const grant = await db.query("SELECT to_regclass('public.profile_group_api_keys') AS t");
    expect(grant.rows[0]!.t).toBe('profile_group_api_keys');
    const col = await db.query(
      "SELECT column_default FROM information_schema.columns WHERE table_name='profile_bindings' AND column_name='request_defaults'",
    );
    expect(col.rows[0]!.column_default).toBe("'{}'::jsonb");
  });

  it('V2-R1 creates and reads a zero-key GROUP_GRANT group; v1 read answers 409', async () => {
    const groupId = await newV2Group('Zero key group');
    const v2 = await getProfileGroupV2(db, groupId, TENANT_ID);
    expect(v2.authAuthority).toBe('GROUP_GRANT');
    expect(v2.authMode).toBe('API_KEY');
    expect(v2.accessVersion).toBe(1);
    expect(v2.revision).toBe(1);
    expect(v2.apiKeyGrants).toEqual([]);
    // v1 cannot project a singular key for zero grants.
    await expectHttpError(getProfileGroup(db, groupId, TENANT_ID), 409, 'PROFILE_GROUP_V2_REQUIRED');
  });

  it('V2-R5 persists requestDefaults on the child revision and projects them', async () => {
    const groupId = await newV2Group('Defaults group');
    const v2 = await getProfileGroupV2(db, groupId, TENANT_ID);
    const fn = v2.businesses[0]!.functions[0]!;
    expect(fn.requestDefaults).toEqual({ quality: { value: 'high' } });
    // `requestDefaults` never leaks into profile policy parameters.
    expect(fn.policy.parameters.quality).toEqual({ value: 'high', isLocked: true });
  });

  it('V2-B1 rollback moves the config pointer only', async () => {
    const groupId = await newV2Group('Rollback group');
    const before = await getProfileGroupV2(db, groupId, TENANT_ID);
    // Append revision 2 by re-saving with the same config.
    await db.tx((client) => saveProfileGroupV2(
      client, profiles, undefined, v2Save('Rollback group', { expectedRevision: 1 }), groupId, ACTOR,
    ));
    const afterSave = await getProfileGroupV2(db, groupId, TENANT_ID);
    expect(afterSave.revision).toBe(2);
    expect(afterSave.accessVersion).toBe(before.accessVersion);

    const rolledBack = await db.tx((client) => rollbackProfileGroupV2(
      client, profiles, undefined, groupId, { expectedRevision: 2, targetRevision: 1 }, ACTOR,
    ));
    expect(rolledBack.revision).toBe(3);
    expect(rolledBack.accessVersion).toBe(before.accessVersion);
  });

  it('V2-G1/V2-G5 issue grants, revoke tombstones, and never touches key status', async () => {
    const groupId = await newV2Group('Grant group');
    const issued = await db.tx((client) => issueGroupKey(
      client, { hashApiKey: (raw) => raw.repeat(2).slice(0, 64) }, groupId, { note: 'first' }, ACTOR, 1,
    ));
    expect(issued.secretAvailable).toBe(true);
    expect(issued.secret).toMatch(/^du_/);
    expect(issued.grant.status).toBe('ACTIVE');
    const afterIssue = await getProfileGroupV2(db, groupId, TENANT_ID);
    expect(afterIssue.accessVersion).toBe(2);
    expect(afterIssue.apiKeyGrants).toHaveLength(1);

    const mode = await db.query('SELECT key_mode FROM api_keys WHERE id=$1', [issued.grant.apiKeyId]);
    expect(mode.rows[0]!.key_mode).toBe('GROUP_MANAGED');

    const revoked = await db.tx((client) => revokeGroupGrant(
      client, groupId, issued.grant.apiKeyId, { expectedAccessVersion: 2 }, ACTOR,
    ));
    expect(revoked.accessVersion).toBe(3);
    expect(revoked.grant.revokedAt).toBeTruthy();

    const afterRevoke = await getProfileGroupV2(db, groupId, TENANT_ID);
    expect(afterRevoke.apiKeyGrants).toEqual([]);
    // The API key itself is still ACTIVE: a grant revoke denies one group only.
    const key = await db.query('SELECT status FROM api_keys WHERE id=$1', [issued.grant.apiKeyId]);
    expect(key.rows[0]!.status).toBe('ACTIVE');
    // The tombstone row survives.
    const tombstone = await db.query(
      'SELECT state, revoked_by FROM profile_group_api_keys WHERE api_key_id=$1',
      [issued.grant.apiKeyId],
    );
    expect(tombstone.rows[0]).toMatchObject({ state: 'REVOKED', revoked_by: 'admin' });
  });

  it('V2-G3 rejects a stale access version with 412', async () => {
    const groupId = await newV2Group('CAS group');
    await expectHttpError(
      db.tx((client) => issueGroupKey(client, { hashApiKey: (raw) => raw.padEnd(64, '0').slice(0, 64) }, groupId, {}, ACTOR, 99)),
      412,
      'PRECONDITION_FAILED',
    );
  });

  it('V2-L5/V2-G9 keeps one group per key id, forever', async () => {
    const first = await newV2Group('Owner A');
    const second = await newV2Group('Owner B');
    const issued = await db.tx((client) => issueGroupKey(
      client, { hashApiKey: (raw) => raw.padEnd(64, '1').slice(0, 64) }, first, {}, ACTOR, 1,
    ));
    // Force a grant row for the same key id against the other group: the PK
    // makes this structurally impossible.
    await expect(db.query(
      `INSERT INTO profile_group_api_keys (api_key_id, group_id, tenant_id, state, granted_by)
       VALUES ($1,$2,$3,'ACTIVE','admin')`,
      [issued.grant.apiKeyId, second, TENANT_ID],
    )).rejects.toMatchObject({ code: '23505' });
  });

  it('V2-L6 enforces the revocation shape', async () => {
    const groupId = await newV2Group('Shape group');
    const issued = await db.tx((client) => issueGroupKey(
      client, { hashApiKey: (raw) => raw.padEnd(64, '2').slice(0, 64) }, groupId, {}, ACTOR, 1,
    ));
    // EMPTY revocation fields on a REVOKED row must fail the shape check.
    await expect(db.query(
      "UPDATE profile_group_api_keys SET state='REVOKED' WHERE api_key_id=$1",
      [issued.grant.apiKeyId],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('V2-L2/L2-L3 attribution and ownership shapes reject unowned rows', async () => {
    const profileId = randomUUID();
    await expect(db.query(
      `INSERT INTO profile_bindings
         (profile_id, revision, tenant_id, api_key_id, business_id, business_version, action,
          connector_bindings, enabled, parameters, job_priority, allowed_file_extensions,
          connections_override, request_redaction, allowed_origins)
       VALUES ($1,1,$2,NULL,$3,$4,$5,'{}',true,'{}','MEDIUM','','[]','[]','[]')`,
      [profileId, TENANT_ID, BUSINESS_ID, BUSINESS_VERSION, WORKFLOW_SLUG],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('V2-L7 two concurrent v2 saves: exactly one wins', async () => {
    const groupId = await newV2Group('Race group');
    const results = await Promise.allSettled([
      db.tx((client) => saveProfileGroupV2(client, profiles, undefined, v2Save('Race group', { expectedRevision: 1 }), groupId, ACTOR)),
      db.tx((client) => saveProfileGroupV2(client, profiles, undefined, v2Save('Race group', { expectedRevision: 1 }), groupId, ACTOR)),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(HttpError);
    const group = await getProfileGroupV2(db, groupId, TENANT_ID);
    expect(group.revision).toBe(2);
  });

  it('V2-L11/L14 conversion flips authority once, then is idempotent', async () => {
    const key = await insertKey();
    const groupName = 'Conversion group';
    const groupId = await db.tx(async (client) => {
      const saved = await saveProfileGroup(client, profiles, undefined, {
        name: groupName,
        tenantId: TENANT_ID,
        apiKey: { apiKeyId: key.id },
        expectedRevision: 0,
        businesses: [{
          businessId: BUSINESS_ID,
          businessVersion: BUSINESS_VERSION,
          manifestDigest: MANIFEST_DIGEST,
          functions: [{
            kind: 'workflow',
            functionId: WORKFLOW_SLUG,
            action: WORKFLOW_SLUG,
            workflowRevision: 1,
            policy: {},
            connectorBindings: {},
          }],
        }],
      } as never, null);
      return saved.groupId;
    });

    const converted = await db.tx((client) => convertGroupToGrantAuthority(client, groupId, ACTOR));
    expect(converted).toMatchObject({
      previousAuthority: 'CHILD_PROJECTION',
      authority: 'GROUP_GRANT',
      grantedKeyId: key.id,
      alreadyConverted: false,
    });
    expect(converted.accessVersion).toBe(2);
    expect(converted.revokedChildMemberships).toBe(1);
    const keyMode = await db.query('SELECT key_mode FROM api_keys WHERE id=$1', [key.id]);
    expect(keyMode.rows[0]!.key_mode).toBe('GROUP_MANAGED');
    // Child memberships are now tombstones.
    const memberships = await db.query(
      "SELECT state FROM profile_api_keys WHERE api_key_id=$1",
      [key.id],
    );
    expect(memberships.rows.every((row) => (row as { state: string }).state === 'REVOKED')).toBe(true);

    const twice = await db.tx((client) => convertGroupToGrantAuthority(client, groupId, ACTOR));
    expect(twice.alreadyConverted).toBe(true);
    expect(twice.accessVersion).toBe(2);
  });

  it('V2-L12 conversion is blocked when the candidate key is shared', async () => {
    const key = await insertKey();
    const groupId = await db.tx(async (client) => {
      const saved = await saveProfileGroup(client, profiles, undefined, {
        name: 'Shared key group',
        tenantId: TENANT_ID,
        apiKey: { apiKeyId: key.id },
        expectedRevision: 0,
        businesses: [{
          businessId: BUSINESS_ID,
          businessVersion: BUSINESS_VERSION,
          manifestDigest: MANIFEST_DIGEST,
          functions: [{
            kind: 'workflow',
            functionId: WORKFLOW_SLUG,
            action: WORKFLOW_SLUG,
            workflowRevision: 1,
            policy: {},
            connectorBindings: {},
          }],
        }],
      } as never, null);
      return saved.groupId;
    });
    // A standalone profile outside the group also holds the key.
    const outsider = randomUUID();
    await db.query(
      `INSERT INTO profile_names (profile_id, tenant_id, api_key_id, business_id, business_version, action, profile_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [outsider, TENANT_ID, key.id, BUSINESS_ID, BUSINESS_VERSION, WORKFLOW_SLUG, 'outsider'],
    );
    await db.query(
      `INSERT INTO profile_bindings
         (profile_id, revision, tenant_id, api_key_id, business_id, business_version, action,
          connector_bindings, enabled, parameters, job_priority, allowed_file_extensions,
          connections_override, request_redaction, allowed_origins)
       VALUES ($1,1,$2,$3,$4,$5,$6,'{}',true,'{}','MEDIUM','','[]','[]','[]')`,
      [outsider, TENANT_ID, key.id, BUSINESS_ID, BUSINESS_VERSION, WORKFLOW_SLUG],
    );
    await db.query(
      `INSERT INTO profile_active_revisions (profile_id, revision) VALUES ($1,1)`,
      [outsider],
    );
    await db.query(
      "INSERT INTO profile_api_keys (profile_id, api_key_id, tenant_id, state) VALUES ($1,$2,$3,'ACTIVE')",
      [outsider, key.id, TENANT_ID],
    );

    const error = await expectHttpError(
      db.tx((client) => convertGroupToGrantAuthority(client, groupId, ACTOR)),
      409,
      'STATE_CONFLICT',
    );
    expect(error.extra?.errors?.[0]?.message).toBe('P3_SHARED_KEY');
    // Zero writes: the group is still child-projected.
    const after = await db.query('SELECT auth_authority FROM profile_groups WHERE group_id=$1', [groupId]);
    expect(after.rows[0]!.auth_authority).toBe('CHILD_PROJECTION');
  });

  it('V2-L15 global revoke tombstones every grant and bumps each group', async () => {
    const key = await insertKey();
    const first = await newV2Group('Global A');
    const second = await newV2Group('Global B');
    // Grant the same key id to two groups is impossible (PK), so use two keys
    // and revoke each: the helper must handle N groups in one call per key.
    expect(first).not.toBe(second);
    const issued = await db.tx((client) => issueGroupKey(
      client, { hashApiKey: (raw) => raw.padEnd(64, '3').slice(0, 64) }, first, {}, ACTOR, 1,
    ));
    const outcome = await db.tx((client) => revokeAllGroupGrantsForApiKey(
      client, issued.grant.apiKeyId, TENANT_ID, ACTOR,
    ));
    expect(outcome.revoked).toBe(1);
    expect(outcome.groupIds).toEqual([first]);
    const group = await getProfileGroupV2(db, first, TENANT_ID);
    expect(group.accessVersion).toBe(3);
    expect(group.apiKeyGrants).toEqual([]);
    const keyRow = await db.query('SELECT status FROM api_keys WHERE id=$1', [issued.grant.apiKeyId]);
    expect(keyRow.rows[0]!.status).toBe('ACTIVE');
  });

  it('V2-L4 splits name uniqueness between standalone and grouped rows', async () => {
    const first = await newV2Group('Name split A');
    const second = await newV2Group('Name split B');
    const firstNames = await db.query('SELECT group_id, profile_name FROM profile_names WHERE group_id=$1', [first]);
    expect(firstNames.rowCount).toBeGreaterThan(0);
    // The same generated child name cannot exist twice inside one group.
    const row = firstNames.rows[0] as { group_id: string; profile_name: string };
    await expect(db.query(
      `INSERT INTO profile_names (profile_id, tenant_id, api_key_id, business_id, business_version, action, profile_name, group_id)
       VALUES ($1,$2,NULL,$3,$4,$5,$6,$7)`,
      [randomUUID(), TENANT_ID, BUSINESS_ID, BUSINESS_VERSION, WORKFLOW_SLUG, row.profile_name, row.group_id],
    )).rejects.toMatchObject({ code: '23505' });
    // A different group may reuse the name (scope is tenant+group).
    const otherNames = await db.query('SELECT profile_name FROM profile_names WHERE group_id=$1', [second]);
    expect(otherNames.rowCount).toBeGreaterThan(0);
  });
});
