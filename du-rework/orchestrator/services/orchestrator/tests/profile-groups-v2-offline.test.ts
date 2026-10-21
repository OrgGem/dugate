/**
 * PC-03 — group service rules (OFFLINE).
 *
 * Covers the V2-R / V2-W / V2-B / V2-G / V2-X matrix from
 * `coordination/reports/prep-pc03-service-spec.md` §10.1–§10.5 for the cases
 * that are decided by guards, pure helpers and statement *shape* — plus the
 * proof ordering of the conversion gate.
 *
 * SQL-heavy semantics (CAS races, grant ledger constraints, concurrency) live
 * in `profile-groups-v2-pg.test.ts`, which needs a real PostgreSQL.
 */
import {
  ProfileGroupV2SaveSchema,
  type ProfileGroupV2Save,
} from '@du/contracts';
import {
  assertLegacyGroupWriteAllowed,
  convertGroupToGrantAuthority,
  getProfileGroup,
  readGroupAuthority,
  revokeAllGroupGrantsForApiKey,
  saveProfileGroup,
  rollbackProfileGroup,
  type ProfileGroupActor,
} from '../src/modules/profiles/profile-groups';
import {
  createProfileService,
  normalizeStoredRequestDefaults,
} from '../src/modules/profiles/profiles';
import { HttpError } from '../src/http/errors';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const GROUP_ID = '5d5dc4ac-2db0-4d5a-950f-008537e51f2d';
const OTHER_GROUP_ID = '6e6e6e6e-6e6e-4e6e-8e6e-6e6e6e6e6e6e';
const KEY_ID = '33333333-3333-4333-8333-333333333333';
const API_KEY_HASH = 'a'.repeat(64);
const MANIFEST_DIGEST = `sha256:${'b'.repeat(64)}`;

const ACTOR: ProfileGroupActor = { actor: 'admin', role: 'platform' };

interface Rule {
  match: RegExp;
  rows?: unknown[];
  rowCount?: number;
}

interface Recorded {
  sql: string;
  params?: unknown[];
}

/**
 * A scripted `Db`. Unmatched statements answer an empty result set, which is
 * the "nothing exists" baseline every guard must handle without crashing.
 */
function scriptedDb(rules: Rule[]): { db: any; log: Recorded[] } {
  const log: Recorded[] = [];
  const run = async (sql: string, params?: unknown[]) => {
    log.push({ sql, params });
    for (const rule of rules) {
      if (rule.match.test(sql)) {
        return {
          rows: rule.rows ?? [],
          rowCount: rule.rowCount ?? (rule.rows ? rule.rows.length : 0),
        };
      }
    }
    return { rows: [], rowCount: 0 };
  };
  const db = {
    query: run,
    tx: async (work: (client: { query: typeof run }) => Promise<unknown>) => work({ query: run }),
  };
  return { db, log };
}

/** INSERT / UPDATE / DELETE statements, i.e. everything that mutates state. */
function writes(log: Recorded[]): string[] {
  return log
    .map((entry) => entry.sql)
    .filter((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql));
}

async function expectHttpError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<HttpError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    const httpError = err as HttpError;
    expect({ status: httpError.status, code: httpError.code }).toEqual({ status, code });
    return httpError;
  }
  throw new Error(`expected HttpError ${status} ${code}, but the call resolved`);
}

function groupRootRow(authority: 'CHILD_PROJECTION' | 'GROUP_GRANT', accessVersion = 1): Record<string, unknown> {
  return {
    group_id: GROUP_ID,
    tenant_id: TENANT_ID,
    root_name: 'prod group',
    active_revision: 1,
    auth_authority: authority,
    access_version: accessVersion,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    revision: 1,
    name: 'prod group',
    api_key_id: authority === 'GROUP_GRANT' ? null : KEY_ID,
    revision_created_at: '2026-10-01T00:00:00.000Z',
  };
}

const GROUP_ROOT_QUERY = /FROM profile_groups g[\s\S]*JOIN profile_group_revisions r/;
const GROUP_EXISTS_QUERY = /^SELECT group_id FROM profile_groups WHERE group_id=/;
const LOCK_ROOT_QUERY = /^SELECT group_id, tenant_id, name, active_revision, auth_authority, access_version/;

function v2Save(overrides: Record<string, unknown> = {}): ProfileGroupV2Save {
  return ProfileGroupV2SaveSchema.parse({
    name: 'prod group',
    tenantId: TENANT_ID,
    authMode: 'API_KEY',
    expectedRevision: 0,
    businesses: [{
      businessId: 'document-core',
      businessVersion: '1.1.0',
      manifestDigest: MANIFEST_DIGEST,
      functions: [{
        kind: 'endpoint',
        functionId: 'ingest:parse',
        action: 'ingest',
        endpointSlug: 'ingest:parse',
        policy: { parameters: { mode: { value: 'parse', isLocked: true } } },
        requestDefaults: { quality: { value: 'high' } },
      }],
    }],
    ...overrides,
  });
}

const noopProfiles = createProfileService(undefined as never, {});

describe('PC-03 / V2-R read projection helpers', () => {
  it('coerces a v1 revision without the column to an empty default set', () => {
    expect(normalizeStoredRequestDefaults(undefined)).toEqual({});
    expect(normalizeStoredRequestDefaults(null)).toEqual({});
    expect(normalizeStoredRequestDefaults({})).toEqual({});
  });

  it('accepts a stored object and a stored JSON string, preserving falsy values', () => {
    expect(normalizeStoredRequestDefaults({ a: { value: false }, b: { value: 0 }, c: { value: '' } }))
      .toEqual({ a: { value: false }, b: { value: 0 }, c: { value: '' } });
    expect(normalizeStoredRequestDefaults('{"a":{"value":1,"isLocked":true}}'))
      .toEqual({ a: { value: 1, isLocked: true } });
  });

  it('drops a malformed stored value instead of failing a read the writer accepted', () => {
    expect(normalizeStoredRequestDefaults('{not json')).toEqual({});
    expect(normalizeStoredRequestDefaults(['nope'])).toEqual({});
  });
});

describe('PC-03 / V2-X v1 compatibility firewall', () => {
  it('refuses a GROUP_GRANT group with 409 PROFILE_GROUP_V2_REQUIRED', async () => {
    const { db } = scriptedDb([{
      match: /^SELECT group_id, tenant_id, auth_authority, access_version, active_revision/,
      rows: [{ group_id: GROUP_ID, tenant_id: TENANT_ID, auth_authority: 'GROUP_GRANT', access_version: 4, active_revision: 2 }],
    }]);
    await expectHttpError(
      assertLegacyGroupWriteAllowed(db, { groupId: GROUP_ID }),
      409,
      'PROFILE_GROUP_V2_REQUIRED',
    );
  });

  it('allows a CHILD_PROJECTION group (the unconverted cohort is unaffected)', async () => {
    const { db } = scriptedDb([{
      match: /^SELECT group_id, tenant_id, auth_authority, access_version, active_revision/,
      rows: [{ group_id: GROUP_ID, tenant_id: TENANT_ID, auth_authority: 'CHILD_PROJECTION', access_version: 1, active_revision: 1 }],
    }]);
    await expect(assertLegacyGroupWriteAllowed(db, { groupId: GROUP_ID })).resolves.toBeUndefined();
  });

  it('resolves authority by profile id for the child path', async () => {
    const { db } = scriptedDb([{
      match: /^SELECT n\.group_id, g\.auth_authority/,
      rows: [{ group_id: GROUP_ID, auth_authority: 'GROUP_GRANT' }],
    }]);
    await expectHttpError(
      assertLegacyGroupWriteAllowed(db, { profileId: '44444444-4444-4444-8444-444444444444' }),
      409,
      'PROFILE_GROUP_V2_REQUIRED',
    );
  });

  it('reads the authority pair PC-05 needs and nothing else', async () => {
    const { db } = scriptedDb([{
      match: /^SELECT group_id, tenant_id, auth_authority, access_version, active_revision/,
      rows: [{ group_id: GROUP_ID, tenant_id: TENANT_ID, auth_authority: 'GROUP_GRANT', access_version: 9, active_revision: 3 }],
    }]);
    await expect(readGroupAuthority(db, GROUP_ID, TENANT_ID)).resolves.toEqual({
      groupId: GROUP_ID,
      tenantId: TENANT_ID,
      authority: 'GROUP_GRANT',
      accessVersion: 9,
      activeRevision: 3,
    });
  });

  it('v1 save refuses a converted group before any write', async () => {
    const log: Recorded[] = [];
    const client = { query: async (sql: string, params?: unknown[]) => {
      log.push({ sql, params });
      if (GROUP_ROOT_QUERY.test(sql)) return { rows: [groupRootRow('GROUP_GRANT')], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    } };
    await expectHttpError(
      saveProfileGroup(client as never, noopProfiles, undefined, {
        name: 'prod group',
        tenantId: TENANT_ID,
        apiKey: { apiKeyId: KEY_ID },
        expectedRevision: 1,
        businesses: [{
          businessId: 'invoice-checker',
          businessVersion: '1.0.0',
          manifestDigest: MANIFEST_DIGEST,
          functions: [{ kind: 'workflow', functionId: 'extract', action: 'extract', policy: {} }],
        }],
      } as never, GROUP_ID),
      409,
      'PROFILE_GROUP_V2_REQUIRED',
    );
    expect(writes(log)).toEqual([]);
  });

  it('v1 rollback refuses a converted group', async () => {
    const { log } = scriptedDb([{ match: GROUP_ROOT_QUERY, rows: [groupRootRow('GROUP_GRANT')] }]);
    const client = { query: async (sql: string, params?: unknown[]) => {
      log.push({ sql, params });
      if (GROUP_ROOT_QUERY.test(sql)) return { rows: [groupRootRow('GROUP_GRANT')], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    } };
    await expectHttpError(
      rollbackProfileGroup(client as never, noopProfiles, undefined, GROUP_ID, { expectedRevision: 1, targetRevision: 1 }),
      409,
      'PROFILE_GROUP_V2_REQUIRED',
    );
    expect(writes(log)).toEqual([]);
  });

  it('v1 read of a converted group with zero grants answers 409, not a guessed key', async () => {
    const client = { query: async (sql: string) => {
      if (GROUP_EXISTS_QUERY.test(sql)) return { rows: [{ group_id: GROUP_ID }], rowCount: 1 };
      if (GROUP_ROOT_QUERY.test(sql)) return { rows: [groupRootRow('GROUP_GRANT')], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    } };
    const db = { query: client.query, tx: async (work: (c: unknown) => Promise<unknown>) => work(client) };
    await expectHttpError(getProfileGroup(db as never, GROUP_ID), 409, 'PROFILE_GROUP_V2_REQUIRED');
  });

  it('v1 read of a converted group with two grants answers 409 with the same message', async () => {
    const twoGrants = [
      { id: KEY_ID, tenant_id: TENANT_ID, hash: API_KEY_HASH, prefix: 'du_a', status: 'ACTIVE' },
      { id: '99999999-9999-4999-8999-999999999999', tenant_id: TENANT_ID, hash: API_KEY_HASH, prefix: 'du_b', status: 'ACTIVE' },
    ];
    const client = { query: async (sql: string) => {
      if (GROUP_EXISTS_QUERY.test(sql)) return { rows: [{ group_id: GROUP_ID }], rowCount: 1 };
      if (GROUP_ROOT_QUERY.test(sql)) return { rows: [groupRootRow('GROUP_GRANT')], rowCount: 1 };
      if (/FROM profile_group_api_keys g/.test(sql)) return { rows: twoGrants, rowCount: 2 };
      return { rows: [], rowCount: 0 };
    } };
    const db = { query: client.query, tx: async (work: (c: unknown) => Promise<unknown>) => work(client) };
    const zero = await (async () => {
      try {
        await getProfileGroup(db as never, GROUP_ID);
        return null;
      } catch (err) {
        return err as HttpError;
      }
    })();
    expect(zero).toBeInstanceOf(HttpError);
    expect((zero as HttpError).code).toBe('PROFILE_GROUP_V2_REQUIRED');
  });
});

describe('PC-03 / V2-X v1 profile-command firewall (profile.upsert/publish/rollback)', () => {
  const PROFILE_NAME = '__du_group_5d5dc4ac_abc';
  const KEY_ROW = { id: KEY_ID, tenant_id: TENANT_ID, hash: API_KEY_HASH, prefix: 'du_a', status: 'ACTIVE' };

  /**
   * The guard resolves the registry identity ACROSS BOTH SCOPES before any
   * key-scoped work, so a converted child is refused instead of silently
   * forking a standalone profile (`ensureProfileId` never runs).
   */
  function convertedChildClient(): { client: any; log: Recorded[] } {
    const log: Recorded[] = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        log.push({ sql, params });
        if (/FROM api_keys WHERE hash=\$1 AND status=\$2/.test(sql)) return { rows: [KEY_ROW], rowCount: 1 };
        if (/FROM profile_names n[\s\S]*LEFT JOIN profile_groups g/.test(sql)) {
          return { rows: [{ group_id: GROUP_ID, auth_authority: 'GROUP_GRANT' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    return { client, log };
  }

  const command = {
    businessId: 'document-core',
    businessVersion: '1.1.0',
    action: 'ingest',
    profileName: PROFILE_NAME,
    apiKey: { kind: 'hash' as const, hash: API_KEY_HASH },
  };

  it('profile.upsert refuses the converted child and never creates a shadow profile', async () => {
    const { client, log } = convertedChildClient();
    const { runProfileUpsert } = await import('../src/modules/admin-actions/profile-actions');
    await expectHttpError(
      runProfileUpsert(client as never, { db: {} as never, profiles: noopProfiles }, command as never, () => undefined),
      409,
      'PROFILE_GROUP_V2_REQUIRED',
    );
    expect(log.some((entry) => /^INSERT INTO profile_names/i.test(entry.sql))).toBe(false);
  });

  it('profile.publish refuses the converted child instead of answering 404', async () => {
    const { client } = convertedChildClient();
    const { runProfilePublish } = await import('../src/modules/admin-actions/profile-actions');
    await expectHttpError(
      runProfilePublish(
        client as never,
        { db: {} as never, profiles: noopProfiles },
        { ...command, expectedRevision: 1 } as never,
        () => undefined,
      ),
      409,
      'PROFILE_GROUP_V2_REQUIRED',
    );
  });

  it('profile.rollback refuses the converted child instead of answering 404', async () => {
    const { client } = convertedChildClient();
    const { runProfileRollback } = await import('../src/modules/admin-actions/profile-actions');
    await expectHttpError(
      runProfileRollback(
        client as never,
        { db: {} as never, profiles: noopProfiles },
        { ...command, targetRevision: 1 } as never,
        () => undefined,
      ),
      409,
      'PROFILE_GROUP_V2_REQUIRED',
    );
  });
});

describe('PC-03 / V2-W v2 save guards', () => {
  it('a v2 body carrying the v1 apiKey selector never parses', () => {
    const parsed = ProfileGroupV2SaveSchema.safeParse({
      ...v2Save(),
      apiKey: { apiKeyId: KEY_ID },
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a group that is still CHILD_PROJECTION — no auto-conversion (D-1)', async () => {
    const { log } = scriptedDb([{ match: GROUP_ROOT_QUERY, rows: [groupRootRow('CHILD_PROJECTION')] }]);
    const client = { query: async (sql: string, params?: unknown[]) => {
      log.push({ sql, params });
      if (GROUP_ROOT_QUERY.test(sql)) return { rows: [groupRootRow('CHILD_PROJECTION')], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    } };
    await expectHttpError(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      (require('../src/modules/profiles/profile-groups') as typeof import('../src/modules/profiles/profile-groups'))
        .saveProfileGroupV2(client as never, noopProfiles, undefined, v2Save(), GROUP_ID, ACTOR),
      409,
      'PROFILE_GROUP_V2_REQUIRED',
    );
    expect(writes(log)).toEqual([]);
  });

  it('refuses a stale expectedRevision with REVISION_CONFLICT and no writes', async () => {
    const { log } = scriptedDb([]);
    const client = { query: async (sql: string, params?: unknown[]) => {
      log.push({ sql, params });
      if (GROUP_ROOT_QUERY.test(sql)) return { rows: [groupRootRow('GROUP_GRANT')], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    } };
    await expectHttpError(
      (require('../src/modules/profiles/profile-groups') as typeof import('../src/modules/profiles/profile-groups'))
        .saveProfileGroupV2(client as never, noopProfiles, undefined, v2Save({ expectedRevision: 99 }), GROUP_ID, ACTOR),
      409,
      'REVISION_CONFLICT',
    );
    expect(writes(log)).toEqual([]);
  });

  it('refuses a write with no Admin actor', async () => {
    await expectHttpError(
      (require('../src/modules/profiles/profile-groups') as typeof import('../src/modules/profiles/profile-groups'))
        .saveProfileGroupV2({ query: async () => ({ rows: [], rowCount: 0 }) } as never, noopProfiles, undefined, v2Save(), null, { actor: '   ', role: 'platform' }),
      401,
      'UNAUTHENTICATED',
    );
  });
});

describe('PC-03 / V2-W author modes (appendRevision)', () => {
  const client = { query: async () => { throw new Error('no query expected before validation'); } };
  const db = { query: client.query, tx: async (work: (c: unknown) => Promise<unknown>) => work(client) };

  it('rejects a group append that also carries an api key author', async () => {
    const profiles = createProfileService(db as never, {});
    await expectHttpError(
      profiles.createGroupChildRevision({
        apiKeyHash: API_KEY_HASH,
        businessId: 'document-core',
        businessVersion: '1.1.0',
        action: 'ingest',
        connectorBindings: {},
      }, GROUP_ID, client as never, ACTOR),
      422,
      'INVALID_SCHEMA',
    );
  });

  it('rejects a group append with no Admin actor', async () => {
    const profiles = createProfileService(db as never, {});
    await expectHttpError(
      profiles.createGroupChildRevision({
        businessId: 'document-core',
        businessVersion: '1.1.0',
        action: 'ingest',
        connectorBindings: {},
      }, GROUP_ID, client as never),
      422,
      'INVALID_SCHEMA',
    );
  });

  it('rejects a standalone append that carries no api key author', async () => {
    const profiles = createProfileService(db as never, {});
    await expectHttpError(
      profiles.createRevision({
        businessId: 'document-core',
        businessVersion: '1.1.0',
        action: 'ingest',
        connectorBindings: {},
      }),
      422,
      'INVALID_SCHEMA',
    );
  });
});

describe('PC-03 / V2-G grant seams', () => {
  it('global revoke is a no-op when the key holds no grant', async () => {
    const { log } = scriptedDb([]);
    const client = { query: async (sql: string, params?: unknown[]) => {
      log.push({ sql, params });
      return { rows: [], rowCount: 0 };
    } };
    await expect(revokeAllGroupGrantsForApiKey(client as never, KEY_ID, TENANT_ID, ACTOR))
      .resolves.toEqual({ revoked: 0, groupIds: [] });
    expect(writes(log)).toEqual([]);
  });

  it('global revoke locks every affected root in sorted order, then tombstones and bumps', async () => {
    const { log } = scriptedDb([]);
    const client = { query: async (sql: string, params?: unknown[]) => {
      log.push({ sql, params });
      if (/^SELECT group_id FROM profile_group_api_keys/.test(sql)) {
        return { rows: [{ group_id: OTHER_GROUP_ID }, { group_id: GROUP_ID }], rowCount: 2 };
      }
      if (/^UPDATE profile_group_api_keys/.test(sql)) return { rows: [], rowCount: 2 };
      return { rows: [], rowCount: 0 };
    } };
    const result = await revokeAllGroupGrantsForApiKey(client as never, KEY_ID, TENANT_ID, ACTOR);
    expect(result.revoked).toBe(2);
    expect(result.groupIds).toEqual([OTHER_GROUP_ID, GROUP_ID]);

    const lockIndexes = log
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => /SELECT group_id FROM profile_groups WHERE group_id=\$1 FOR UPDATE/.test(entry.sql))
      .map(({ index }) => index);
    expect(lockIndexes).toHaveLength(2);
    // Both roots are locked BEFORE the tombstone UPDATE.
    const updateIndex = log.findIndex((entry) => /^UPDATE profile_group_api_keys/.test(entry.sql));
    expect(lockIndexes.every((index) => index < updateIndex)).toBe(true);
    // Sorted order, not discovery order.
    expect(lockIndexes.map((index) => log[index]!.params?.[0])).toEqual([OTHER_GROUP_ID, GROUP_ID]);
    // Never touches api_keys.status: the key stays live for every other surface.
    expect(writes(log).some((sql) => /^UPDATE api_keys\b/i.test(sql))).toBe(false);
  });
});

describe('PC-03 / conversion proof ordering', () => {
  async function convertWith(rules: Rule[]) {
    const log: Recorded[] = [];
    const client = { query: async (sql: string, params?: unknown[]) => {
      log.push({ sql, params });
      for (const rule of rules) {
        if (rule.match.test(sql)) return { rows: rule.rows ?? [], rowCount: rule.rowCount ?? (rule.rows ? rule.rows.length : 0) };
      }
      return { rows: [], rowCount: 0 };
    } };
    return { client, log, promise: convertGroupToGrantAuthority(client as never, GROUP_ID, ACTOR) };
  }

  const rootChildProjection = (): Rule => ({
    match: LOCK_ROOT_QUERY,
    rows: [{
      group_id: GROUP_ID,
      tenant_id: TENANT_ID,
      name: 'prod group',
      active_revision: 1,
      auth_authority: 'CHILD_PROJECTION',
      access_version: 1,
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: '2026-10-01T00:00:00.000Z',
    }],
  });

  it('blocks on P1 when no single candidate key covers every child', async () => {
    const { log, promise } = await convertWith([rootChildProjection(), {
      match: GROUP_ROOT_QUERY,
      rows: [groupRootRow('CHILD_PROJECTION')],
    }]);
    const error = await expectHttpError(promise, 409, 'STATE_CONFLICT');
    expect(error.extra?.errors).toEqual([{ pointer: '/check', message: 'P1_CANDIDATE_KEY' }]);
    expect(writes(log)).toEqual([]);
  });

  it('is idempotent for an already-converted group (no second bump)', async () => {
    const { log, promise } = await convertWith([
      { match: LOCK_ROOT_QUERY, rows: [{
        group_id: GROUP_ID,
        tenant_id: TENANT_ID,
        name: 'prod group',
        active_revision: 2,
        auth_authority: 'GROUP_GRANT',
        access_version: 5,
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
      }] },
      { match: /^SELECT api_key_id FROM profile_group_api_keys/, rows: [{ api_key_id: KEY_ID }] },
    ]);
    const report = await promise;
    expect(report).toMatchObject({
      authority: 'GROUP_GRANT',
      accessVersion: 5,
      grantedKeyId: KEY_ID,
      alreadyConverted: true,
      revokedChildMemberships: 0,
    });
    expect(writes(log)).toEqual([]);
  });
});
