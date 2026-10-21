/**
 * PC-R01 regression — explicit key mode controls the admission fallback.
 *
 * The defect: a `LEGACY_STANDALONE` key with **no membership rows at all**
 * (issued with `profileIds: []`, or rotated from a key whose memberships were
 * all tombstoned) reached `selectActiveRow`, matched nothing, and fell through
 * to `mode: 'legacy'` — full unmanaged access to every action.
 *
 * Both lifecycle entry points are exercised through the real services
 * (`createApiKeyLifecycleService.issue` / `.rotate`), and the denial is asserted
 * at three layers:
 *
 *   1. the resolver (`resolveEffectiveProfile` / `resolveBinding`),
 *   2. the front admission (`resolveAdmission`),
 *   3. the submission write path (`submit`) — proving that a denied request
 *      never creates an `operations`, `tasks`, `outbox` or `submission_keys` row.
 *
 * Offline: a stateful in-memory fake implements only the SQL these paths read,
 * and records every mutation so "zero durable rows" is a real assertion rather
 * than an inference.
 */
import type { PoolClient } from 'pg';
import type { Db } from '../src/db/db';
import { createApiKeyLifecycleService, type ApiKeyActor } from '../src/modules/identity/api-keys';
import { createProfileService } from '../src/modules/profiles/profiles';
import { createSubmissionService, resolveAdmission } from '../src/modules/operations/submission';
import { createRegistryService } from '../src/modules/registry/registry';
import { HttpError } from '../src/http/errors';

const TENANT = '11111111-1111-4111-8111-111111111111';
const BUSINESS = 'pc-r01-core';
const VERSION = '1.0.0';
const ACTION = 'ingest';
const ACTOR: ApiKeyActor = { actor: 'pc-r01', role: 'ADMIN', correlationId: 'pc-r01-correlation' };

/* ------------------------------------------------------------------ */
/* Stateful fake                                                       */
/* ------------------------------------------------------------------ */

interface KeyRow {
  id: string;
  tenant_id: string;
  hash: string;
  prefix: string;
  name: string | null;
  status: string;
  version: number;
  key_mode: string | null;
}

interface MembershipRow {
  profile_id: string;
  api_key_id: string;
  tenant_id: string;
  state: string;
}

interface BindingRow {
  profile_id: string;
  revision: number;
  tenant_id: string;
  business_id: string;
  business_version: string;
  action: string;
  endpoint_slug: string | null;
  enabled: boolean;
}

interface NameRow {
  profile_id: string;
  tenant_id: string;
  api_key_id: string | null;
  business_id: string;
  business_version: string;
  action: string;
  profile_name: string;
  group_id: string | null;
}

class FakeDb {
  keys: KeyRow[] = [];
  memberships: MembershipRow[] = [];
  bindings: BindingRow[] = [];
  names: NameRow[] = [];
  pointers = new Map<string, number>();
  markers = new Map<string, { operation: string; request_hash: string; api_key_id: string }>();
  /** Every statement the services issued, normalized. */
  statements: string[] = [];

  /** Durable writes outside the key lifecycle — the "zero rows" assertion target. */
  writes(): string[] {
    return this.statements.filter((sql) => /^INSERT INTO (operations|tasks|outbox|submission_keys)\b/i.test(sql));
  }

  seedKey(input: Partial<KeyRow> & { id: string; key_mode: string | null }): KeyRow {
    const row: KeyRow = {
      tenant_id: TENANT,
      hash: `hash-${input.id}`,
      prefix: 'du_r',
      name: null,
      status: 'ACTIVE',
      version: 1,
      ...input,
    };
    this.keys.push(row);
    return row;
  }

  seedProfile(input: {
    profileId: string;
    keyId: string | null;
    groupId: string | null;
    state?: string;
  }): void {
    this.bindings.push({
      profile_id: input.profileId,
      revision: 1,
      tenant_id: TENANT,
      business_id: BUSINESS,
      business_version: VERSION,
      action: ACTION,
      endpoint_slug: null,
      enabled: true,
    });
    this.pointers.set(input.profileId, 1);
    this.names.push({
      profile_id: input.profileId,
      tenant_id: TENANT,
      api_key_id: input.keyId,
      business_id: BUSINESS,
      business_version: VERSION,
      action: ACTION,
      profile_name: `pc-r01-${input.profileId}`,
      group_id: input.groupId,
    });
    if (input.keyId !== null) {
      this.memberships.push({
        profile_id: input.profileId,
        api_key_id: input.keyId,
        tenant_id: TENANT,
        state: input.state ?? 'ACTIVE',
      });
    }
  }

  private keyById(id: string): KeyRow | undefined {
    return this.keys.find((row) => row.id === id);
  }

  activeMemberships(apiKeyId: string): MembershipRow[] {
    return this.memberships.filter((row) => row.api_key_id === apiKeyId && row.state === 'ACTIVE');
  }

  private handle(sql: string, params: unknown[]): { rows: unknown[]; rowCount: number } {
    const p = params;
    this.statements.push(sql);

    // --- key lifecycle plumbing ---
    if (sql.startsWith('SELECT pg_advisory_xact_lock') || sql.startsWith('INSERT INTO admin_audit_events')) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM admin_api_key_mutations')) {
      const marker = this.markers.get(String(p[1]));
      return marker ? { rows: [marker], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes('INSERT INTO admin_api_key_mutations')) {
      this.markers.set(String(p[1]), {
        operation: String(p[2]),
        request_hash: String(p[3]),
        api_key_id: String(p[4]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('SELECT profile_id FROM profile_names WHERE tenant_id=$1 AND profile_id=ANY')) {
      const wanted = (p[1] as string[]) ?? [];
      const found = this.names.filter((row) => row.tenant_id === p[0] && wanted.includes(row.profile_id));
      return { rows: found.map((row) => ({ profile_id: row.profile_id })), rowCount: found.length };
    }
    if (sql.startsWith('INSERT INTO api_keys')) {
      // The mode is a literal on `issue` and $6 on `rotate`.
      const keyMode = sql.includes("'LEGACY_STANDALONE'") ? 'LEGACY_STANDALONE' : (p[5] as string | null);
      const row: KeyRow = {
        id: String(p[0]),
        tenant_id: String(p[1]),
        hash: String(p[2]),
        prefix: String(p[3]),
        name: (p[4] as string | null) ?? null,
        status: 'ACTIVE',
        version: 1,
        key_mode: keyMode ?? null,
      };
      this.keys.push(row);
      return { rows: [this.wireRow(row)], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO profile_api_keys') && sql.includes('unnest')) {
      const profileIds = (p[0] as string[]) ?? [];
      for (const profileId of profileIds) {
        this.memberships.push({
          profile_id: profileId,
          api_key_id: String(p[1]),
          tenant_id: String(p[2]),
          state: 'ACTIVE',
        });
      }
      return { rows: [], rowCount: profileIds.length };
    }
    if (sql.startsWith('SELECT id, name, key_mode FROM api_keys')) {
      const row = this.keyById(String(p[1]));
      return row ? { rows: [{ id: row.id, name: row.name, key_mode: row.key_mode }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('SELECT id,tenant_id,prefix,name,status,created_at,updated_at,version')) {
      const row = this.keyById(String(p[1]));
      return row ? { rows: [this.wireRow(row)], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('SELECT profile_id FROM profile_api_keys') && sql.includes("state='ACTIVE'")) {
      const rows = this.activeMemberships(String(p[1])).map((row) => ({ profile_id: row.profile_id }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('UPDATE profile_api_keys SET state=')) {
      for (const row of this.memberships) {
        if (row.tenant_id === p[0] && row.api_key_id === p[1] && row.state === 'ACTIVE') row.state = 'REVOKED';
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE api_keys SET status=')) {
      const row = this.keyById(String(p[1]));
      if (!row || row.status !== 'ACTIVE' || row.version !== Number(p[2])) return { rows: [], rowCount: 0 };
      row.status = 'REVOKED';
      row.version += 1;
      return { rows: [this.wireRow(row)], rowCount: 1 };
    }
    if (sql.includes('FROM admin_local_user_api_key_grants')) {
      return { rows: [], rowCount: 0 };
    }

    // --- admission ---
    if (sql.startsWith('SELECT id, tenant_id, status, key_mode FROM api_keys WHERE id=$1')) {
      const row = this.keyById(String(p[0]));
      return row
        ? { rows: [{ id: row.id, tenant_id: row.tenant_id, status: row.status, key_mode: row.key_mode }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM profile_group_api_keys g')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('SELECT p.profile_id, p.revision')) {
      const apiKeyId = String(p[0]);
      const candidates = this.bindings.filter((binding) => {
        if (binding.business_id !== p[1] || binding.business_version !== p[2] || binding.action !== p[3]) return false;
        if (binding.endpoint_slug !== null && binding.endpoint_slug !== p[4]) return false;
        const membership = this.memberships.some(
          (row) => row.profile_id === binding.profile_id && row.api_key_id === apiKeyId
            && row.tenant_id === binding.tenant_id && row.state === 'ACTIVE',
        );
        return membership;
      });
      const rows = candidates.map((binding) => ({
        profile_id: binding.profile_id,
        revision: binding.revision,
        connector_bindings: {},
        enabled: binding.enabled,
        parameters: {},
        job_priority: 'MEDIUM',
        allowed_file_extensions: '',
        connections_override: [],
        file_url_auth_cipher: null,
        request_redaction: [],
        callback_policy: null,
        allowed_origins: [],
        profile_name: this.names.find((row) => row.profile_id === binding.profile_id)?.profile_name ?? null,
        moved_at: new Date('2026-10-01T00:00:00.000Z'),
      }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('SELECT 1 FROM profile_api_keys m')) {
      const apiKeyId = String(p[0]);
      const hit = this.bindings.some((binding) =>
        this.memberships.some((row) => row.profile_id === binding.profile_id && row.api_key_id === apiKeyId
          && row.tenant_id === binding.tenant_id && row.state === 'ACTIVE'));
      return { rows: hit ? [{}] : [], rowCount: hit ? 1 : 0 };
    }
    if (sql.startsWith('SELECT key_mode FROM api_keys WHERE id=$1')) {
      const row = this.keyById(String(p[0]));
      return row ? { rows: [{ key_mode: row.key_mode }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('SELECT 1 FROM profile_api_keys WHERE api_key_id=$1 LIMIT 1')) {
      const hit = this.memberships.some((row) => row.api_key_id === String(p[0]));
      return { rows: hit ? [{}] : [], rowCount: hit ? 1 : 0 };
    }

    // --- business readiness (for the submit path) ---
    if (sql.startsWith('SELECT enabled,activation_revision,submissions_paused,pre_drain_version FROM business_catalog')) {
      return {
        rows: [{ enabled: true, activation_revision: 1, submissions_paused: false, pre_drain_version: null }],
        rowCount: 1,
      };
    }
    if (sql.includes('FROM business_versions')) {
      // The admission seam parses the manifest and reads the digest/queue, so
      // this row has to be a real (minimal) registered version.
      return {
        rows: [{
          version: VERSION,
          digest: `sha256:${'a'.repeat(64)}`,
          queue: `du-business-${BUSINESS}`,
          status: 'ENABLED',
          is_active: true,
          manifest: {
            contractVersion: '1',
            businessId: BUSINESS,
            version: VERSION,
            displayName: 'PC-R01 fixture',
            description: '',
            imageDigest: `sha256:${'b'.repeat(64)}`,
            runtime: { wireVersion: '1', handlerKinds: [ACTION, 'root'] },
            capabilities: { cancel: true, resume: true, parallel: false },
            actions: [{
              name: ACTION,
              displayName: 'Ingest',
              description: '',
              inputSchema: { type: 'object', properties: {}, additionalProperties: true },
              outputSchema: { type: 'object' },
              profileSchema: { type: 'object', properties: {} },
              connectorSlots: [],
              artifactPolicy: { minFiles: 0, maxFiles: 4 },
              capabilities: { cancel: true, resume: true },
              defaultLimits: {},
            }],
          },
        }],
        rowCount: 1,
      };
    }

    // Anything else is a read we did not model; an empty result lets the
    // service reach its own decision instead of failing on the fake.
    return { rows: [], rowCount: 0 };
  }

  private wireRow(row: KeyRow): Record<string, unknown> {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      prefix: row.prefix,
      name: row.name,
      status: row.status,
      created_at: new Date('2026-10-01T00:00:00.000Z'),
      updated_at: new Date('2026-10-01T00:00:00.000Z'),
      version: row.version,
      protected: false,
      key_mode: row.key_mode,
    };
  }

  asDb(): Db {
    const query = async (text: string, params: unknown[] = []) => this.handle(text, params);
    return {
      query,
      tx: async (work: (client: PoolClient) => Promise<unknown>) =>
        work({ query } as unknown as PoolClient),
    } as unknown as Db;
  }
}

function lifecycle(fake: FakeDb) {
  return createApiKeyLifecycleService({
    db: fake.asDb(),
    audit: {
      record: async () => undefined,
    } as never,
  });
}

function profiles(fake: FakeDb) {
  return createProfileService(fake.asDb(), { cryptoEnv: {} });
}

function submission(fake: FakeDb) {
  const db = fake.asDb();
  return createSubmissionService(
    db,
    createRegistryService(db),
    createProfileService(db, { cryptoEnv: {} }),
    { storageBackend: 'postgres' },
  );
}

function admissionInput(apiKeyId: string) {
  return {
    apiKeyId,
    tenantId: TENANT,
    selector: {
      businessId: BUSINESS,
      businessVersion: VERSION,
      action: ACTION,
    },
    action: { inputSchema: { type: 'object' }, profileSchema: { type: 'object' } },
    clientInput: {},
    declaredKeys: [] as string[],
  };
}

async function expectDenied(promise: Promise<unknown>, status: number): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(status);
    return error as HttpError;
  }
  throw new Error(`expected an HttpError ${status}, but the call resolved`);
}

/* ------------------------------------------------------------------ */
/* A. Lifecycle entry points produce unassigned standalone keys       */
/* ------------------------------------------------------------------ */

describe('PC-R01 / lifecycle entry points', () => {
  it('issues a LEGACY_STANDALONE key with an empty profile list', async () => {
    const fake = new FakeDb();
    const issued = await lifecycle(fake).issue(
      { tenantId: TENANT, note: 'unassigned', profileIds: [], idempotencyKey: 'pc-r01-issue-1' },
      ACTOR,
    );
    expect(issued.secretAvailable).toBe(true);
    const row = fake.keys.find((key) => key.id === issued.key.id)!;
    expect(row.key_mode).toBe('LEGACY_STANDALONE');
    expect(fake.activeMemberships(row.id)).toEqual([]);
  });

  it('rotates a standalone key whose memberships are all tombstoned, preserving the mode', async () => {
    const fake = new FakeDb();
    const old = fake.seedKey({ id: 'key-tombstoned', key_mode: 'LEGACY_STANDALONE' });
    fake.seedProfile({ profileId: 'profile-tombstoned', keyId: old.id, groupId: null, state: 'REVOKED' });

    const rotated = await lifecycle(fake).rotate(
      { tenantId: TENANT, keyId: old.id, expectedVersion: 1, idempotencyKey: 'pc-r01-rotate-1' },
      ACTOR,
    );

    const next = fake.keys.find((key) => key.id === rotated.key.id)!;
    expect(next.key_mode).toBe('LEGACY_STANDALONE');
    // Nothing is inherited from a tombstone set…
    expect(fake.activeMemberships(next.id)).toEqual([]);
    // …and the old key is revoked, not reused.
    expect(fake.keys.find((key) => key.id === old.id)!.status).toBe('REVOKED');
  });

  it('rotation keeps an explicitly UNMANAGED_LEGACY key unmanaged', async () => {
    const fake = new FakeDb();
    const old = fake.seedKey({ id: 'key-unmanaged', key_mode: 'UNMANAGED_LEGACY' });
    const rotated = await lifecycle(fake).rotate(
      { tenantId: TENANT, keyId: old.id, expectedVersion: 1, idempotencyKey: 'pc-r01-rotate-2' },
      ACTOR,
    );
    const next = fake.keys.find((key) => key.id === rotated.key.id)!;
    expect(next.key_mode).toBe('UNMANAGED_LEGACY');
    expect(fake.activeMemberships(next.id)).toEqual([]);
  });

  it('rotation refuses a key whose mode is not declared instead of inferring one', async () => {
    const fake = new FakeDb();
    const old = fake.seedKey({ id: 'key-null-mode', key_mode: null });
    await expect(lifecycle(fake).rotate(
      { tenantId: TENANT, keyId: old.id, expectedVersion: 1, idempotencyKey: 'pc-r01-rotate-3' },
      ACTOR,
    )).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    // No replacement key was minted.
    expect(fake.keys.filter((key) => key.id !== 'key-null-mode')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* B. The defect: unassigned standalone keys must be denied           */
/* ------------------------------------------------------------------ */

describe('PC-R01 / the fallback is closed', () => {
  it('denies an issued-with-empty-profiles key at the resolver', async () => {
    const fake = new FakeDb();
    const issued = await lifecycle(fake).issue(
      { tenantId: TENANT, profileIds: [], idempotencyKey: 'pc-r01-deny-1' },
      ACTOR,
    );
    const error = await expectDenied(
      profiles(fake).resolveEffectiveProfile(issued.key.id, BUSINESS, VERSION, ACTION),
      403,
    );
    expect(error.message).toMatch(/not authorized/i);
  });

  it('denies a tombstone-only rotated key at the resolver', async () => {
    const fake = new FakeDb();
    const old = fake.seedKey({ id: 'key-rot-src', key_mode: 'LEGACY_STANDALONE' });
    fake.seedProfile({ profileId: 'profile-rot-src', keyId: old.id, groupId: null, state: 'REVOKED' });
    const rotated = await lifecycle(fake).rotate(
      { tenantId: TENANT, keyId: old.id, expectedVersion: 1, idempotencyKey: 'pc-r01-deny-2' },
      ACTOR,
    );
    await expectDenied(
      profiles(fake).resolveEffectiveProfile(rotated.key.id, BUSINESS, VERSION, ACTION),
      403,
    );
  });

  it('denies discovery (resolveBinding) for the same keys', async () => {
    const fake = new FakeDb();
    const issued = await lifecycle(fake).issue(
      { tenantId: TENANT, profileIds: [], idempotencyKey: 'pc-r01-deny-3' },
      ACTOR,
    );
    await expectDenied(profiles(fake).resolveBinding(issued.key.id, BUSINESS, VERSION, ACTION), 403);
  });

  it('denies the front admission and writes no durable rows', async () => {
    const fake = new FakeDb();
    const issued = await lifecycle(fake).issue(
      { tenantId: TENANT, profileIds: [], idempotencyKey: 'pc-r01-deny-4' },
      ACTOR,
    );
    const before = fake.statements.length;
    await expectDenied(
      resolveAdmission(fake.asDb() as never, profiles(fake), {}, admissionInput(issued.key.id)),
      403,
    );
    // Nothing was written on the way to the refusal.
    expect(fake.statements.slice(before).filter((sql) => /^INSERT INTO/i.test(sql))).toEqual([]);
    expect(fake.writes()).toEqual([]);
  });

  it('denies submission and creates no operation, task, outbox or submission_key row', async () => {
    const fake = new FakeDb();
    const issued = await lifecycle(fake).issue(
      { tenantId: TENANT, profileIds: [], idempotencyKey: 'pc-r01-deny-5' },
      ACTOR,
    );
    await expectDenied(
      submission(fake).submit({
        tenantId: TENANT,
        apiKeyId: issued.key.id,
        businessId: BUSINESS,
        action: ACTION,
        submission: { input: { note: 'denied' } },
      }),
      403,
    );
    expect(fake.writes()).toEqual([]);
  });

  it('denies a NULL-mode key instead of defaulting it to unmanaged', async () => {
    const fake = new FakeDb();
    fake.seedKey({ id: 'key-null-admission', key_mode: null });
    await expectDenied(
      profiles(fake).resolveEffectiveProfile('key-null-admission', BUSINESS, VERSION, ACTION),
      403,
    );
  });
});

/* ------------------------------------------------------------------ */
/* C. UNMANAGED_LEGACY keeps only its intended behaviour              */
/* ------------------------------------------------------------------ */

describe('PC-R01 / the one permitted unmanaged path', () => {
  it('allows an explicitly UNMANAGED_LEGACY key with no membership history', async () => {
    const fake = new FakeDb();
    fake.seedKey({ id: 'key-unmanaged-ok', key_mode: 'UNMANAGED_LEGACY' });
    await expect(
      profiles(fake).resolveEffectiveProfile('key-unmanaged-ok', BUSINESS, VERSION, ACTION),
    ).resolves.toMatchObject({ mode: 'legacy' });

    const resolved = await resolveAdmission(
      fake.asDb() as never, profiles(fake), {}, admissionInput('key-unmanaged-ok'),
    );
    expect(resolved.profile.mode).toBe('legacy');
    expect(resolved.groupPin).toBeNull();
  });

  it('denies an UNMANAGED_LEGACY key that contradicts its own mode with membership rows', async () => {
    const fake = new FakeDb();
    fake.seedKey({ id: 'key-unmanaged-contradiction', key_mode: 'UNMANAGED_LEGACY' });
    // A membership exists, so the key is not unmanaged whatever the column says.
    fake.seedProfile({ profileId: 'profile-contradiction', keyId: 'key-unmanaged-contradiction', groupId: null, state: 'REVOKED' });
    await expectDenied(
      profiles(fake).resolveEffectiveProfile('key-unmanaged-contradiction', BUSINESS, VERSION, ACTION),
      403,
    );
  });
});

/* ------------------------------------------------------------------ */
/* D. Scoped behaviour is preserved                                   */
/* ------------------------------------------------------------------ */

describe('PC-R01 / scoped behaviour is unchanged', () => {
  it('an assigned standalone key still resolves its pinned profile', async () => {
    const fake = new FakeDb();
    const key = fake.seedKey({ id: 'key-assigned', key_mode: 'LEGACY_STANDALONE' });
    fake.seedProfile({ profileId: 'profile-assigned', keyId: key.id, groupId: null });
    const resolved = await profiles(fake).resolveEffectiveProfile(key.id, BUSINESS, VERSION, ACTION);
    expect(resolved).toMatchObject({ mode: 'pinned', profileId: 'profile-assigned', revision: 1 });
  });

  it('a GROUP_MANAGED key never borrows child-membership authority', async () => {
    const fake = new FakeDb();
    const key = fake.seedKey({ id: 'key-group', key_mode: 'GROUP_MANAGED' });
    // Stale pre-cutover membership: the resolver must ignore it entirely.
    fake.seedProfile({ profileId: 'profile-group-child', keyId: key.id, groupId: 'group-1' });
    await expectDenied(
      profiles(fake).resolveEffectiveProfile(key.id, BUSINESS, VERSION, ACTION),
      403,
    );
    // The front admission routes it to the root-grant resolver, which denies
    // because no grant exists — never to the child projection.
    const error = await expectDenied(
      resolveAdmission(fake.asDb() as never, profiles(fake), {}, admissionInput(key.id)),
      403,
    );
    expect(error.code).toBe('PROFILE_GROUP_UNAUTHORIZED');
  });

  it('a revoked membership keeps denying (no regression on the tombstone rule)', async () => {
    const fake = new FakeDb();
    const key = fake.seedKey({ id: 'key-revoked-membership', key_mode: 'LEGACY_STANDALONE' });
    fake.seedProfile({ profileId: 'profile-revoked', keyId: key.id, groupId: null, state: 'REVOKED' });
    await expectDenied(
      profiles(fake).resolveEffectiveProfile(key.id, BUSINESS, VERSION, ACTION),
      403,
    );
  });
});
