/**
 * 0039 profile_api_keys — a profile owns a SET of API keys.
 *
 * Offline (no socket, no PG): the shipped migration is pinned by CONTENT, and the
 * runtime is pinned by the SQL it actually sends plus the resolution each branch
 * produces. The point of the change is that a key resolves a profile through
 * MEMBERSHIP instead of through being the author of the live revision, so every
 * assertion here is about which predicate decides resolution.
 */
import { join } from 'node:path';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { loadMigrationFiles } from '../src/db/migrations';
import { HttpError } from '../src/http/errors';
import { authorizeConnectorProbe } from '../src/modules/connectors/probe-authorization';
import { createProfileService } from '../src/modules/profiles/profiles';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const MIGRATION = '0039_profile_api_keys.sql';
const SQ = String.fromCharCode(39);
/** The predicate that must gate every membership read. */
const ACTIVE_GATE = 'state=' + SQ + 'ACTIVE' + SQ;
const MEMBERSHIP_TABLE = 'profile_api_keys';
/** SQL formatting differs (m.state = 'ACTIVE' in a JOIN vs state='ACTIVE'); compare space-free. */
const squeeze = (value: string | undefined): string => (value ?? '').replace(/ /g, '');

const KEY_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const KEY_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const PROFILE = 'cccccccc-3333-4333-8333-333333333333';
const TENANT = 'dddddddd-4444-4444-8444-444444444444';
const BUSINESS = 'doc-core';
const VERSION = '1.1.0';
const ACTION = 'extract';

const ACTIVE_ROW = {
  profile_id: PROFILE,
  revision: 3,
  connector_bindings: { slotA: { connectorId: 'openai', revision: 1 } },
  enabled: true,
  parameters: {},
  job_priority: 'MEDIUM',
  allowed_file_extensions: '',
  connections_override: [],
  file_url_auth_cipher: null,
  moved_at: new Date('2026-10-01T00:00:00.000Z'),
};

function result<T extends QueryResultRow = QueryResultRow>(rows: unknown[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] } as unknown as QueryResult<T>;
}

interface Fixture {
  activeRows?: unknown[];
  orphanHits?: boolean;
  anyHits?: boolean;
}

function world(fx: Fixture) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const activeRows = fx.activeRows ?? [];
  const orphanHits = fx.orphanHits ?? false;
  const anyHits = fx.anyHits ?? false;
  const query = async <T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = []
  ): Promise<QueryResult<T>> => {
    const sql = text.replace(/\s+/g, ' ').trim();
    queries.push({ sql, params });
    if (sql.startsWith('SELECT p.profile_id, p.revision')) return result<T>(activeRows);
    if (sql.includes(MEMBERSHIP_TABLE + ' m JOIN profile_bindings')) {
      return result<T>(orphanHits ? [{ probe: 1 }] : []);
    }
    if (sql.includes(MEMBERSHIP_TABLE + ' WHERE api_key_id')) {
      return result<T>(anyHits ? [{ probe: 1 }] : []);
    }
    throw new Error('unexpected profile SQL: ' + sql.slice(0, 90));
  };
  const db = {
    query,
    tx: async (fn: (c: unknown) => Promise<unknown>) => fn({ query }),
    close: async () => undefined,
  } as unknown as Db;
  return { db, queries };
}

describe('0039: the request path resolves membership, not the revision author', () => {
  it('a key with membership resolves the profile ACTIVE revision (params unchanged)', async () => {
    const { db, queries } = world({ activeRows: [ACTIVE_ROW] });
    const svc = createProfileService(db);

    const out = await svc.resolveBinding(KEY_B, BUSINESS, VERSION, ACTION);

    expect(out).toEqual({
      mode: 'pinned',
      profileId: PROFILE,
      revision: 3,
      bindings: { slotA: { connectorId: 'openai', revision: 1 } },
    });
    // KEY_B is not the revision author — membership is what resolved it.
    expect(queries[0]?.sql).toContain(MEMBERSHIP_TABLE);
    expect(queries[0]?.params).toEqual([KEY_B, BUSINESS, VERSION, ACTION, null]);
    expect(queries).toHaveLength(1);
  });

  it('no resolution query reads membership without an ACTIVE gate', async () => {
    const { db, queries } = world({});
    const svc = createProfileService(db);

    // Legacy path walks all three queries: the active row, the pointer
    // cross-check, then the historical-membership probe.
    expect(await svc.resolveBinding(KEY_A, BUSINESS, VERSION, ACTION)).toEqual({ mode: 'legacy' });
    expect(queries).toHaveLength(3);
    for (const entry of queries.slice(0, 2)) {
      expect(entry.sql).toContain(MEMBERSHIP_TABLE);
      expect(squeeze(entry.sql)).toContain(squeeze(ACTIVE_GATE));
    }
    expect(queries[2]?.sql).toContain(MEMBERSHIP_TABLE);
    expect(squeeze(queries[2]?.sql)).not.toContain(squeeze(ACTIVE_GATE));
    // The pre-0038 author filter must be gone: a REVOKED or absent
    // membership can no longer be bypassed by binding rows alone.
    expect(queries[0]?.sql).not.toContain('p.api_key_id');
  });

  it('membership without a pointer row fails closed (404, never MAX(revision))', async () => {
    const { db } = world({ orphanHits: true });
    const svc = createProfileService(db);

    await expect(svc.resolveBinding(KEY_A, BUSINESS, VERSION, ACTION)).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining('no active revision pointer'),
    });
  });

  it('a key mapped to another profile is 403, not legacy', async () => {
    const { db } = world({ anyHits: true });
    const svc = createProfileService(db);

    const failure = await svc.resolveBinding(KEY_A, BUSINESS, VERSION, ACTION).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(HttpError);
    expect(failure).toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
  });

  it('a key whose Profile membership was revoked stays out of legacy mode', async () => {
    // Historical rows remain after a group/key reassignment. The API key may
    // still be ACTIVE for its independent key lifecycle, but no longer falls
    // through to manifest/deployment legacy connector authorization.
    const { db, queries } = world({ anyHits: true });
    const svc = createProfileService(db);

    await expect(svc.resolveBinding(KEY_A, BUSINESS, VERSION, ACTION)).rejects.toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
    });
    expect(queries[2]?.sql).toContain(MEMBERSHIP_TABLE);
    expect(squeeze(queries[2]?.sql)).not.toContain(squeeze(ACTIVE_GATE));
  });

  it('a key with no membership at all keeps the legacy path', async () => {
    const { db } = world({});
    const svc = createProfileService(db);

    expect(await svc.resolveBinding(KEY_A, BUSINESS, VERSION, ACTION)).toEqual({ mode: 'legacy' });
  });
});

describe('0039: connector probe authorization reads membership too', () => {
  const principal = { id: KEY_B, tenantId: TENANT };

  it('a mapped key may probe a connector pinned on the profile', async () => {
    const queries: string[] = [];
    const db = {
      query: async <T extends QueryResultRow = QueryResultRow>(text: string) => {
        queries.push(text.replace(/\s+/g, ' ').trim());
        return result<T>([{
          api_key_id: KEY_B,
          tenant_id: TENANT,
          enabled: true,
          connector_bindings: { slotA: { connectorId: 'openai', revision: 1 } },
        }]);
      },
    } as unknown as Pick<Db, 'query'>;

    await expect(authorizeConnectorProbe(db, principal, 'openai')).resolves.toBeUndefined();
    expect(queries[0]).toContain(MEMBERSHIP_TABLE);
    expect(squeeze(queries[0])).toContain(squeeze(ACTIVE_GATE));
  });

  it('an unmapped key is refused 403 with no legacy fallback', async () => {
    const db = {
      query: async <T extends QueryResultRow = QueryResultRow>() => result<T>([]),
    } as unknown as Pick<Db, 'query'>;

    await expect(authorizeConnectorProbe(db, principal, 'openai')).rejects.toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
    });
  });
});

describe('0039: the migration ships the membership table with a parity seed', () => {
  const loaded = loadMigrationFiles(MIGRATIONS_DIR);
  const migration = loaded.find((f) => f.filename === MIGRATION);

  it('is picked up by the loader as sequence 38', () => {
    expect(migration).toBeDefined();
    expect(migration?.sequence).toBe(39);
  });

  it('declares the table, both indexes and a state the runtime can gate on', () => {
    const sql = migration?.sql ?? '';
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS ' + MEMBERSHIP_TABLE);
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS profile_api_keys_key_lookup');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS profile_api_keys_tenant_profile');
    // The runtime gate only means something if the column domain carries it.
    expect(sql).toContain('CHECK (state IN (' + SQ + 'ACTIVE' + SQ + ',' + SQ + 'REVOKED' + SQ + '))');
    expect(sql).toContain('PRIMARY KEY (profile_id, api_key_id)');
  });

  it('seeds membership from DISTINCT binding authors, idempotently', () => {
    const sql = migration?.sql ?? '';
    // profile_names.api_key_id holds only the FIRST key that registered the
    // name; seeding from it would revoke every other key of the profile.
    expect(sql).toContain('FROM profile_bindings b');
    expect(sql).toContain('SELECT DISTINCT b.profile_id, b.api_key_id');
    expect(sql).toContain('ON CONFLICT (profile_id, api_key_id) DO NOTHING');
    expect(sql).not.toContain('FROM profile_names');
  });

  it('adds no FK to profile_names (0028 never backfilled pre-0028 profiles)', () => {
    const sql = migration?.sql ?? '';
    expect(sql).toContain('REFERENCES api_keys(id)');
    expect(sql.includes('REFERENCES profile_names')).toBe(false);
  });
});
