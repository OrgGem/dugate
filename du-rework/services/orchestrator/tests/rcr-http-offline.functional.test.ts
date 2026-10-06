import net from 'node:net';
import { join } from 'node:path';
import type { QueryResult, QueryResultRow } from 'pg';
import { canonicalRequestHash } from '@du/contracts';
import { createApp, type App } from '../src/server';
import { createSubmissionService } from '../src/modules/operations/submission';
import type { Db } from '../src/db/db';
import type { ProfileService } from '../src/modules/profiles/profiles';
import type { RegistryService } from '../src/modules/registry/registry';
import { loadMigrationFiles } from '../src/db/migrations';

/**
 * RCR-HTTP regression pins (review orchestrator-app-core-review-2026-10-05):
 *
 *  - RCR-01: the listener's whole callback is inside ONE failure boundary and
 *    the request URL parses against a configured base — `Host: [` and a
 *    malformed request-target produce controlled 4xx responses, the process
 *    never sees an unhandled rejection, and the NEXT request still runs.
 *  - RCR-03: the idempotency replay lookup runs BEFORE admission — a disabled
 *    business version or a changed profile cannot turn a same-key replay of an
 *    ACCEPTED operation into 404; a different body is still 409; the tenant
 *    fence still scopes the lookup.
 *
 * (RCR-06 is pinned end-to-end by the flipped `rv01-loopback-http-offline`
 * download test + the mount-level raw-bytes test.)
 */

const TENANT = '7f000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '7f000000-0000-4000-8000-0000000000ff';
const KEY = '7f000000-0000-4000-8000-000000000002';
const KEY_ROW_TENANT = TENANT;
const IDEM_KEY = 'rcr-idem-key-0001';
const SUBMISSION = { input: { text: 'inline' } };

/* ---------------- Part 1: real listener (RCR-01) ---------------- */

jest.mock('pg', () => {
  const state = { schemaLedger: [] as unknown[] };
  function answer(sql: string): { rows: unknown[]; rowCount: number } {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/information_schema\.tables/i.test(text)) return { rows: [{ exists: true }], rowCount: 1 };
    if (/SELECT count\(\*\)::int/i.test(text)) return { rows: [{ count: state.schemaLedger.length }], rowCount: 1 }
    if (/FROM schema_migrations/i.test(text)) {
      return { rows: state.schemaLedger, rowCount: state.schemaLedger.length };
    }
    return { rows: [], rowCount: 0 };
  }
  class ScriptedPool {
    async query(sql: string) {
      return answer(sql);
    }
    async connect() {
      return { query: (sql: string) => Promise.resolve(answer(sql)), release: () => undefined };
    }
    async end() {
      return undefined;
    }
  }
  return { __esModule: true, Pool: ScriptedPool, __duState: state };
});

function rawRequest(port: number, payload: string): Promise<{ head: string; status: number }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(payload));
    let buf = '';
    const done = (): void => {
      const head = buf.split('\r\n')[0] ?? '';
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0);
      resolve({ head, status });
    };
    socket.setTimeout(4_000, () => {
      socket.destroy();
      if (buf.length > 0) done();
      else reject(new Error('raw request timed out with no response'));
    });
    socket.on('data', (d) => {
      buf += d.toString('latin1');
    });
    socket.on('end', done);
    socket.on('error', (err) => {
      if (buf.length > 0) done();
      else reject(err);
    });
  });
}

describe('RCR-01: listener failure boundary (real createApp listener)', () => {
  let app: App;
  let port: number;
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown): void => {
    unhandled.push(err);
  };

  beforeAll(async () => {
    (jest.requireMock('pg') as { __duState: { schemaLedger: unknown[] } }).__duState.schemaLedger = loadMigrationFiles(
      join(__dirname, '..', 'migrations'),
    ).map((file) => ({ sequence: file.sequence, filename: file.filename }));
    process.on('unhandledRejection', onUnhandled);
    app = await createApp({
      port: 0,
      databaseUrl: 'postgresql://du:du@127.0.0.1:1/du_offline_rcr1',
      redisUrl: 'redis://127.0.0.1:1',
      adminToken: 'rcr-admin',
      autoDispatch: false,
      autoMigrate: false,
    });
    await new Promise<void>((resolve) => app.server.listen(0, resolve));
    port = (app.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    await app.close({ timeoutMs: 0, pollIntervalMs: 10 }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', onUnhandled);
  });

  it('Host: [ gets a controlled response, not a crashed process, and the next request still runs', async () => {
    const hostile = await rawRequest(port, 'GET /api/v1/nope HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n');
    expect(hostile.status).toBeGreaterThanOrEqual(400);
    expect(hostile.status).toBeLessThan(500);

    const next = await rawRequest(port, 'GET /api/v1/nope HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    expect(next.status).toBeGreaterThanOrEqual(400);
    expect(unhandled).toEqual([]);
  });

  it('a malformed request-target answers a controlled 400 problem and the listener survives', async () => {
    const malformed = await rawRequest(port, 'GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    expect(malformed.status).toBe(400);
    const next = await rawRequest(port, 'GET /api/v1/nope HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    expect(next.status).toBeGreaterThanOrEqual(400);
    expect(unhandled).toEqual([]);
  });
});

/* ---------------- Part 2: replay before admission (RCR-03) ---------------- */

function result<T extends QueryResultRow>(rows: QueryResultRow[]): QueryResult<T> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, rows: rows as T[], fields: [] };
}

type ReplayState = { keyRow: Record<string, unknown> | null; versionQueries: number };

function makeReplayWorld(state: ReplayState) {
  const db = {
    query: async <T extends QueryResultRow = QueryResultRow>(statement: string, params: unknown[] = []) => {
      if (/FROM submission_keys/i.test(statement)) {
        return state.keyRow && state.keyRow['tenant_id'] === params[0] && state.keyRow['key'] === params[3]
          ? result<T>([state.keyRow])
          : result<T>([]);
      }
      if (/FROM business_versions/i.test(statement)) {
        state.versionQueries += 1;
        return result<T>([]); // version disabled / unknown → admission 404
      }
      if (/FROM operations/i.test(statement)) {
        return result<T>([
          {
            id: String(state.keyRow?.['operation_id'] ?? 'op-1'),
            tenant_id: TENANT,
            business_id: 'demo',
            business_version: '1.0.0',
            action: 'ingest',
            state: 'ACCEPTED',
            state_version: 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            deadline_at: null,
          },
        ]);
      }
      return result<T>([]);
    },
    tx: async <T>(fn: (client: unknown) => Promise<T>) => fn({ query: async () => result([]) }),
    close: async () => undefined,
  } as unknown as Db;
  return db;
}

function replayCtx(tenantId = TENANT) {
  return {
    tenantId,
    apiKeyId: KEY,
    businessId: 'demo',
    action: 'ingest',
    idempotencyKey: IDEM_KEY,
    submission: SUBMISSION,
  };
}

function replayService(db: Db) {
  const profiles = {
    resolveBinding: async () => ({ mode: 'legacy' as const }),
    resolveEffectiveProfile: jest.fn(async () => {
      throw new Error('profile resolution must not run on a replay path');
    }),
  } as unknown as ProfileService;
  return { service: createSubmissionService(db, {} as RegistryService, profiles), profiles };
}

describe('RCR-03: replay lookup runs before admission policy', () => {
  const matchingHash = canonicalRequestHash({
    input: SUBMISSION.input,
    artifacts: undefined,
    output: undefined,
    callback: undefined,
    sourceUrl: undefined,
  });

  it('a disabled version does NOT break a same-key replay of an accepted operation', async () => {
    const state: ReplayState = {
      keyRow: {
        tenant_id: TENANT,
        api_key_id: KEY,
        route_action: 'demo:ingest',
        key: IDEM_KEY,
        request_hash: matchingHash,
        operation_id: 'op-1',
      },
      versionQueries: 0,
    };
    const { service, profiles } = replayService(makeReplayWorld(state));
    const res = await service.submit(replayCtx());
    expect(res.replayed).toBe(true);
    expect(res.operation.id).toBe('op-1');
    // Nothing downstream of the lookup ran: no business_versions read, no
    // profile resolution, no artifact/input validation.
    expect(state.versionQueries).toBe(0);
    expect((profiles.resolveEffectiveProfile as jest.Mock)).not.toHaveBeenCalled();
  });

  it('same key with a DIFFERENT body is still 409, decided before admission', async () => {
    const state: ReplayState = {
      keyRow: {
        tenant_id: TENANT,
        api_key_id: KEY,
        route_action: 'demo:ingest',
        key: IDEM_KEY,
        request_hash: matchingHash,
        operation_id: 'op-1',
      },
      versionQueries: 0,
    };
    const { service } = replayService(makeReplayWorld(state));
    const other = { ...replayCtx(), submission: { input: { text: 'DIFFERENT' } } };
    await expect(service.submit(other)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      status: 409,
    });
    expect(state.versionQueries).toBe(0);
  });

  it('the tenant fence still scopes the lookup: a foreign tenant never replays another tenant\'s operation', async () => {
    const state: ReplayState = {
      keyRow: {
        tenant_id: KEY_ROW_TENANT,
        api_key_id: KEY,
        route_action: 'demo:ingest',
        key: IDEM_KEY,
        request_hash: matchingHash,
        operation_id: 'op-1',
      },
      versionQueries: 0,
    };
    const { service } = replayService(makeReplayWorld(state));
    // Same key string, foreign tenant: the scoped lookup misses and the
    // request falls through to admission (which 404s on the disabled version)
    // — never a cross-tenant replay.
    await expect(service.submit(replayCtx(OTHER_TENANT))).rejects.toMatchObject({ status: 404 });
    expect(state.versionQueries).toBe(1);
  });
});
