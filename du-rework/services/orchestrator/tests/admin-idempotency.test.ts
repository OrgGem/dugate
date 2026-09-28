import {
  auditedMutation,
  createAuditService,
} from '../src/modules/audit/audit';
import { Db } from '../src/db/db';
import { HttpError } from '../src/http/errors';
import {
  canonicalPayloadHash,
  executeIdempotent,
  purgeIdempotencyMarkers,
  readIdempotencyKey,
} from '../src/modules/idempotency/idempotency';

/**
 * R2-A priority-5 (review.md cycle 6/6 MEDIUM, retried mutating POST was
 * not idempotent-proof): admin POSTs accept an Idempotency-Key /
 * Client-Token and a response-loss retry must return the stored response
 * WITHOUT a second profile revision, audit row, or marker.
 *
 * OFFLINE matrix — zero DB/Redis. The fake Db models the marker table with
 * a PRIMARY KEY that throws the real pg 23505 shape, and its tx journal
 * makes rollback observable: a lost race must show mutation + audit +
 * marker ALL discarded, then the winner replayed.
 */

interface MarkerRow {
  key: string;
  route: string;
  payload_hash: string;
  response_code: number;
  response_body: unknown;
}

function conflictErr(): Error & { code: string; constraint: string } {
  const e = new Error(
    'duplicate key value violates unique constraint "admin_idempotency_pkey"'
  ) as Error & { code: string; constraint: string };
  e.code = '23505';
  e.constraint = 'admin_idempotency_pkey';
  return e;
}

interface Committed { sql: string; params: unknown[] }

let hiddenFirstRead: { key: string; readDone: boolean } | undefined;

function makeWorld(race?: { key: string }) {
  const markers = new Map<string, MarkerRow>();
  hiddenFirstRead = race ? { key: race.key, readDone: false } : undefined;
  const committed: Committed[] = [];
  let staged: Committed[] = [];
  const stagedApplies: (() => void)[] = [];
  const attempted: Committed[] = [];

  const stage = (sql: string, params: unknown[], apply?: () => void) => {
    attempted.push({ sql, params });
    staged.push({ sql, params });
    stagedApplies.push(apply ?? (() => undefined));
  };

  const client = {
    query: async (text: string, params: unknown[] = []) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (sql.includes('INSERT INTO admin_idempotency')) {
        const key = String(params[0]);
        if (markers.has(key)) throw conflictErr(); // PK enforced at write time
        const row: MarkerRow = {
          key,
          route: String(params[1]),
          payload_hash: String(params[2]),
          response_code: Number(params[3]),
          response_body: JSON.parse(String(params[4])),
        };
        stage(sql, params, () => markers.set(key, row));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO') || sql.includes('UPDATE ') || sql.includes('DELETE FROM')) {
        stage(sql, params);
        const rows = /RETURNING\s+id/i.test(sql) ? [{ id: 'audit-row-1' }] : [];
        return { rows, rowCount: Math.max(rows.length, 1) };
      }
      stage(sql, params);
      return { rows: [], rowCount: 0 };
    },
  };

  const db = {
    pool: undefined,
    query: async (text: string, params: unknown[] = []) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      attempted.push({ sql, params });
      if (sql.includes('FROM admin_idempotency') && sql.startsWith('SELECT')) {
        const key = String(params[0]);
        if (hiddenFirstRead && hiddenFirstRead.key === key && !hiddenFirstRead.readDone) {
          hiddenFirstRead.readDone = true;
          return { rows: [], rowCount: 0 }; // pretend: not committed yet
        }
        const row = markers.get(key);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('DELETE FROM admin_idempotency')) {
        const n = markers.size;
        markers.clear();
        committed.push({ sql, params });
        return { rows: Array.from({ length: n }, (_, i) => ({ key: String(i) })), rowCount: n };
      }
      return { rows: [], rowCount: 0 };
    },
    tx: async (fn: (c: unknown) => Promise<unknown>) => {
      staged = [];
      const appliesSnapshot: (() => void)[] = [];
      const origPush = stagedApplies.push.bind(stagedApplies);
      // record how many applies belong to THIS tx
      const before = committed.length + 0;
      let txCount = 0;
      const wrappedClient = {
        query: async (text: string, params: unknown[] = []) => {
          txCount += 1;
          const res = await client.query(text, params);
          return res;
        },
      };
      try {
        const result = await fn(wrappedClient);
        // commit: apply staged effects in order
        const pending = staged.splice(0);
        const pendingApplies = stagedApplies.splice(0, stagedApplies.length);
        for (const a of pendingApplies) a();
        committed.push(...pending);
        void before;
        return result;
      } catch (err) {
        staged = [];
        stagedApplies.splice(0, stagedApplies.length); // ROLLBACK: nothing applied
        void origPush;
        throw err;
      }
    },
    close: async () => undefined,
  } as unknown as Db;

  const audit = createAuditService(db);
  return { db, audit, markers, committed, attempted };
}

const REVISION_RESULT = { profileId: 'prof-1', revision: 2, tenantId: 'ten-1', apiKeyId: 'key-1' };

function routeShapedWork(world: ReturnType<typeof makeWorld>, key: string | undefined, route: string, payloadHash: string, counters: { runs: number }) {
  return executeIdempotent(
    world.db,
    { key, route, payloadHash },
    async (withMarker) => {
      counters.runs += 1;
      const result = await auditedMutation(
        world.db,
        world.audit,
        async (client) => {
          await client.query(
            'INSERT INTO profile_bindings (profile_id, revision) VALUES ($1,$2)',
            [REVISION_RESULT.profileId, REVISION_RESULT.revision]
          );
          return REVISION_RESULT;
        },
        () => ({
          tenantId: REVISION_RESULT.tenantId,
          actor: 'admin',
          action: 'profile_binding.bind',
          resource: `apikey:${REVISION_RESULT.apiKeyId}`,
          severity: 'info' as const,
        }),
        key ? (client, r) => withMarker(client, { status: 201, body: r }) : undefined
      );
      return { status: 201, body: result };
    }
  );
}

describe('R2-A canonicalPayloadHash', () => {
  it('is stable across key order (recursively)', () => {
    const a = canonicalPayloadHash({ b: 1, a: { y: 2, x: [3, { n: null }] } });
    const b = canonicalPayloadHash({ a: { x: [3, { n: null }], y: 2 }, b: 1 });
    expect(a).toBe(b);
  });
  it('differs when any value differs (raw apiKey included)', () => {
    expect(canonicalPayloadHash({ apiKey: 'k1' })).not.toBe(canonicalPayloadHash({ apiKey: 'k2' }));
  });
  it('undefined body hashes as empty object', () => {
    expect(canonicalPayloadHash(undefined)).toBe(canonicalPayloadHash({}));
  });
});

describe('R2-A readIdempotencyKey', () => {
  it('absent / empty => undefined (legacy path)', () => {
    expect(readIdempotencyKey({})).toBeUndefined();
    expect(readIdempotencyKey({ 'idempotency-key': '' })).toBeUndefined();
  });
  it('accepts Idempotency-Key and the Client-Token alias', () => {
    expect(readIdempotencyKey({ 'idempotency-key': 'abcdefgh' })).toBe('abcdefgh');
    expect(readIdempotencyKey({ 'client-token': 'tok-00000001' })).toBe('tok-00000001');
    expect(readIdempotencyKey({ 'idempotency-key': 'primary-key!', 'client-token': 'secondary' })).toBe('primary-key!');
  });
  it('malformed keys fail closed with 422 (never silently ignored)', () => {
    for (const bad of ['short', 'has space', 'x'.repeat(201)]) {
      let err: HttpError | undefined;
      try {
        readIdempotencyKey({ 'idempotency-key': bad });
      } catch (e) {
        err = e as HttpError;
      }
      expect(err).toBeInstanceOf(HttpError);
      expect(err!.status).toBe(422);
      expect(err!.code).toBe('INVALID_SCHEMA');
    }
  });
});

describe('R2-A executeIdempotent replay matrix', () => {
  const ROUTE = 'POST /api/v1/admin/profile-bindings';
  const HASH = canonicalPayloadHash({ apiKey: 'raw', businessId: 'b' });

  it('no key: work runs, replayed=false, legacy behavior preserved', async () => {
    const world = makeWorld();
    const counters = { runs: 0 };
    const first = await routeShapedWork(world, undefined, ROUTE, HASH, counters);
    const second = await routeShapedWork(world, undefined, ROUTE, HASH, counters);
    expect(counters.runs).toBe(2);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(false);
    expect(world.markers.size).toBe(0);
    // two full legacy mutations, exactly as pre-R2-A
    expect(world.committed.filter((c) => /profile_bindings/.test(c.sql))).toHaveLength(2);
    expect(world.committed.filter((c) => /admin_audit_events/.test(c.sql))).toHaveLength(2);
  });

  it('same key + same payload: retry returns stored response, writes NOTHING', async () => {
    const world = makeWorld();
    const counters = { runs: 0 };
    const key = 'retry-key-0001';
    const first = await routeShapedWork(world, key, ROUTE, HASH, counters);
    const committedAfterFirst = world.committed.length;
    const second = await routeShapedWork(world, key, ROUTE, HASH, counters);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(counters.runs).toBe(1); // work NEVER ran on the retry
    expect(world.committed.length).toBe(committedAfterFirst); // zero new statements
    // the one first attempt committed revision + audit + marker TOGETHER:
    const sqls = world.committed.map((c) => c.sql);
    expect(sqls.some((s) => /profile_bindings/.test(s))).toBe(true);
    expect(sqls.some((s) => /admin_audit_events/.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO admin_idempotency/.test(s))).toBe(true);
    expect(world.markers.get(key)!.response_code).toBe(201);
  });

  it('same key + different payload => 409 IDEMPOTENCY_CONFLICT', async () => {
    const world = makeWorld();
    const counters = { runs: 0 };
    await routeShapedWork(world, 'dupkey-00001', ROUTE, HASH, counters);
    await expect(
      routeShapedWork(world, 'dupkey-00001', ROUTE, canonicalPayloadHash({ apiKey: 'other' }), counters)
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect(counters.runs).toBe(1);
  });

  it('same key on a different route => 409', async () => {
    const world = makeWorld();
    const counters = { runs: 0 };
    await routeShapedWork(world, 'xroute-key1', ROUTE, HASH, counters);
    await expect(
      routeShapedWork(world, 'xroute-key1', 'POST /api/v1/admin/operations/sweep-deadlines', HASH, counters)
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('lost first-request race: mutation+audit+marker ALL roll back, winner replays', async () => {
    // Winner commits while our pre-read still saw the table as empty.
    const world = makeWorld({ key: 'racekey-0001' });
    world.markers.set('racekey-0001', {
      key: 'racekey-0001',
      route: ROUTE,
      payload_hash: HASH,
      response_code: 201,
      response_body: { profileId: 'prof-W', revision: 9, tenantId: 'ten-W', apiKeyId: 'key-W' },
    });
    const counters = { runs: 0 };
    const outcome = await routeShapedWork(world, 'racekey-0001', ROUTE, HASH, counters);
    expect(counters.runs).toBe(1); // our work DID run...
    expect(outcome.replayed).toBe(true); // ...but the CONFLICT makes the winner canonical
    expect(outcome.body).toEqual({ profileId: 'prof-W', revision: 9, tenantId: 'ten-W', apiKeyId: 'key-W' });
    // THE ATOMICITY PROOF: nothing from the loser reached the committed log.
    expect(world.committed).toHaveLength(0);
    // the loser DID attempt revision + audit (they were rolled back, not skipped):
    expect(world.attempted.some((c) => /profile_bindings/.test(c.sql))).toBe(true);
    expect(world.attempted.some((c) => /admin_audit_events/.test(c.sql))).toBe(true);
    expect(world.markers.get('racekey-0001')!.response_body).toHaveProperty('profileId', 'prof-W');
  });

  it('work failure without conflict: propagates, no marker persists', async () => {
    const world = makeWorld();
    await expect(
      executeIdempotent(world.db, { key: 'failkey-0001', route: ROUTE, payloadHash: HASH }, async () => {
        throw new Error('business rejection');
      })
    ).rejects.toThrow(/business rejection/);
    expect(world.markers.size).toBe(0);
  });

  it('misuse guard: keyed work that forgets its marker fails closed', async () => {
    const world = makeWorld();
    await expect(
      executeIdempotent(world.db, { key: 'nomark-00001', route: ROUTE, payloadHash: HASH }, async () => {
        return { status: 201, body: { ok: true } };
      })
    ).rejects.toThrow(/without persisting its marker/);
  });

  it('purgeIdempotencyMarkers clears the store and reports the count', async () => {
    const world = makeWorld();
    const counters = { runs: 0 };
    await routeShapedWork(world, 'purgekey-001', ROUTE, HASH, counters);
    expect(world.markers.size).toBe(1);
    const purged = await purgeIdempotencyMarkers(world.db, 0);
    expect(purged).toBe(1);
    expect(world.markers.size).toBe(0);
  });
});
