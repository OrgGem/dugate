import { HeartbeatAckSchema } from '@du/contracts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../src/db/db';
import { handleAdminRoutes } from '../src/http/routes/admin';
import { handleRuntimeRoutes } from '../src/http/routes/runtime';
import type { RouteContext } from '../src/http/route-context';
import { listWorkerInstances, parseWorkerInstanceListQuery } from '../src/modules/admin-read/worker-instances';
import { recordWorkerHeartbeat } from '../src/modules/runtime/worker-instances';

const ADMIN_TOKEN = 'aweb11c-platform-admin-token';
const WORKER_TOKEN = 'aweb11c-business-worker-token';
const BUSINESS_ID = 'document-core';
const NOW = Date.parse('2026-10-10T12:00:00.000Z');

function queryResult(rows: unknown[]) {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

function workerRow(overrides: Record<string, unknown> = {}) {
  return {
    business_id: BUSINESS_ID,
    instance_id: 'worker-1',
    business_version: '3.2.1',
    state: 'ONLINE',
    capacity: 8,
    active_leases: 2,
    last_seen_at: new Date(NOW - 10_000),
    observed_at: new Date(NOW - 9_000),
    ...overrides,
  };
}

describe('AWEB-11C worker instance read model', () => {
  test('migration creates the approved additive worker inventory schema and indexes', () => {
    const sql = readFileSync(join(__dirname, '../migrations/0042_worker_instances.sql'), 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS worker_instances');
    expect(sql).toContain('PRIMARY KEY (business_id, instance_id)');
    expect(sql).toContain("CHECK (state IN ('ONLINE','DRAINING','OFFLINE'))");
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS worker_instances_business');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS worker_instances_last_seen');
    expect(sql).not.toContain('ALTER TABLE');
  });

  test('parses a bounded business filter and rejects unsupported, repeated, or invalid input', () => {
    expect(parseWorkerInstanceListQuery(new URLSearchParams('businessId=document-core&limit=25')))
      .toEqual({ businessId: BUSINESS_ID, limit: 25 });
    expect(parseWorkerInstanceListQuery(new URLSearchParams())).toEqual({ businessId: null, limit: 100 });
    expect(() => parseWorkerInstanceListQuery(new URLSearchParams('businessId=a&businessId=b')))
      .toThrow(/businessId must not be repeated/);
    expect(() => parseWorkerInstanceListQuery(new URLSearchParams('tenantId=foreign')))
      .toThrow(/unsupported worker query parameter/);
    expect(() => parseWorkerInstanceListQuery(new URLSearchParams('limit=501')))
      .toThrow(/between 1 and 500/);
    expect(() => parseWorkerInstanceListQuery(new URLSearchParams('businessId=bad%00id')))
      .toThrow(/printable characters/);
  });

  test('lists only stored instances, filters by business with bound parameters, and derives health from last heartbeat', async () => {
    const rows = [
      workerRow(),
      workerRow({ instance_id: 'worker-draining', state: 'DRAINING' }),
      workerRow({ instance_id: 'worker-slow', last_seen_at: new Date(NOW - 61_000) }),
      workerRow({ instance_id: 'worker-stale', last_seen_at: new Date(NOW - 301_000) }),
      workerRow({ instance_id: 'worker-no-capacity', capacity: 0 }),
    ];
    const db = { query: jest.fn(async () => queryResult(rows)) } as unknown as Db;

    const result = await listWorkerInstances(
      db,
      parseWorkerInstanceListQuery(new URLSearchParams('businessId=document-core&limit=4')),
      NOW,
    );

    expect(result.sampledAt).toBe('2026-10-10T12:00:00.000Z');
    expect(result.truncated).toBe(true);
    expect(result.items).toHaveLength(4);
    expect(result.items.map((item) => item.health)).toEqual(['HEALTHY', 'DEGRADED', 'DEGRADED', 'OFFLINE']);
    expect(result.items[3]?.state).toBe('OFFLINE');
    expect(result.items[0]).toMatchObject({
      businessId: BUSINESS_ID,
      instanceId: 'worker-1',
      businessVersion: '3.2.1',
      capacity: 8,
      activeLeases: 2,
      lastSeenAt: '2026-10-10T11:59:50.000Z',
    });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE business_id = $1'),
      [BUSINESS_ID, 5],
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY last_seen_at DESC, business_id ASC, instance_id ASC'),
      expect.any(Array),
    );
  });

  test('returns an empty actual inventory rather than synthesizing a row for a business', async () => {
    const db = { query: jest.fn(async () => queryResult([])) } as unknown as Db;
    await expect(listWorkerInstances(db, { businessId: BUSINESS_ID, limit: 100 }, NOW)).resolves.toEqual({
      items: [],
      sampledAt: '2026-10-10T12:00:00.000Z',
      truncated: false,
    });
  });
});

describe('AWEB-11C persisted runtime worker heartbeat', () => {
  test('upserts authenticated instance data and safely joins text scope IDs to UUID tenants', async () => {
    const lastSeenAt = new Date('2026-10-10T11:59:59.000Z');
    const query = jest.fn(async (sql: string, _params: unknown[] = []) => {
      if (sql.includes('SELECT scope_kind,scope_id,desired_state,revision')) {
        return queryResult([
          { scope_kind: 'platform', scope_id: 'all', desired_state: 'OPEN', revision: 3 },
          { scope_kind: 'business', scope_id: BUSINESS_ID, desired_state: 'OPEN', revision: 4 },
        ]);
      }
      if (sql.includes('SELECT r.scope_id,r.revision,r.desired_state')) return queryResult([]);
      if (sql.includes('SELECT desired_control_revision,desired_control_state')) return queryResult([]);
      if (sql.includes('WITH lease_count')) return queryResult([{
        state: 'ONLINE', last_seen_at: lastSeenAt, control_revision: 4, control_state: 'OPEN',
      }]);
      return queryResult([]);
    });
    const db = { tx: jest.fn(async (work: (client: never) => Promise<unknown>) => work({ query } as never)) } as unknown as Db;
    const heartbeat = {
      businessId: BUSINESS_ID,
      businessVersion: '3.2.1',
      imageDigest: 'sha256:abc123',
      capacity: 8,
    };

    const result = await recordWorkerHeartbeat(db, 'worker-1', heartbeat);

    expect(result).toEqual({ state: 'ONLINE', lastSeenAt: lastSeenAt.toISOString(), controlRevision: 4, controlState: 'OPEN' });
    const write = query.mock.calls.find(([sql]) => sql.includes('WITH lease_count'));
    expect(write).toBeDefined();
    const [sql, params] = write!;
    expect(sql).toContain('INSERT INTO worker_instances');
    expect(sql).toContain('ON CONFLICT (business_id, instance_id) DO UPDATE');
    expect(sql).toContain("t.state = 'RUNNING'");
    expect(sql).toContain('t.lease_expires_at > statement_timestamp()');
    expect(sql).toContain('o.business_id = $1');
    expect(params).toEqual([BUSINESS_ID, 'worker-1', '3.2.1', 8, 'ONLINE', 4, 'OPEN', 'sha256:abc123', null, null]);
    const tenantScopeQuery = query.mock.calls.find(([statement]) => statement.includes('SELECT r.scope_id,r.revision,r.desired_state'))?.[0];
    expect(tenantScopeQuery).toContain('o.tenant_id::text=r.scope_id');
    expect(tenantScopeQuery).not.toContain('r.scope_id::uuid');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO worker_control_scope_acks'), expect.any(Array));
  });

  test('runtime route enforces the token business and rejects invalid heartbeat payloads', async () => {
    const lastSeenAt = new Date();
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('SELECT scope_kind,scope_id,desired_state,revision')) {
        return queryResult([
          { scope_kind: 'platform', scope_id: 'all', desired_state: 'OPEN', revision: 3 },
          { scope_kind: 'business', scope_id: BUSINESS_ID, desired_state: 'OPEN', revision: 4 },
        ]);
      }
      if (sql.includes('SELECT r.scope_id,r.revision,r.desired_state')) return queryResult([]);
      if (sql.includes('SELECT desired_control_revision,desired_control_state')) return queryResult([]);
      if (sql.includes('WITH lease_count')) return queryResult([{
        state: 'ONLINE', last_seen_at: lastSeenAt, control_revision: 4, control_state: 'OPEN',
      }]);
      return queryResult([]);
    });
    const tx = jest.fn(async (work: (client: never) => Promise<unknown>) => work({ query } as never));
    const heartbeatBody = {
      businessId: BUSINESS_ID,
      businessVersion: '3.2.1',
      imageDigest: 'sha256:abc123',
      capacity: 8,
    };
    const base = {
      method: 'PUT',
      pathname: '/api/runtime/v1/workers/worker-1/heartbeat',
      searchParams: new URLSearchParams(),
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
      body: heartbeatBody,
      db: { query, tx },
      config: { workerIdentityTokensByBusiness: { [BUSINESS_ID]: WORKER_TOKEN } },
    } as unknown as RouteContext;

    const response = await handleRuntimeRoutes(base);
    expect(response?.status).toBe(200);
    expect(HeartbeatAckSchema.safeParse(response?.body).success).toBe(true);
    expect(response?.body).toMatchObject({ health: 'HEALTHY', capacity: 8 });
    expect(tx).toHaveBeenCalledTimes(1);

    const mismatched = {
      ...base,
      body: { ...heartbeatBody, businessId: 'another-business' },
      db: { query: jest.fn(async () => queryResult([])) },
    } as unknown as RouteContext;
    await expect(handleRuntimeRoutes(mismatched)).rejects.toMatchObject({ status: 403 });
    expect(mismatched.db.query).not.toHaveBeenCalled();

    const invalid = {
      ...base,
      body: { ...heartbeatBody, capacity: -1 },
      db: { query: jest.fn(async () => queryResult([])) },
    } as unknown as RouteContext;
    await expect(handleRuntimeRoutes(invalid)).rejects.toMatchObject({ status: 422 });
    expect(invalid.db.query).not.toHaveBeenCalled();
  });
});

describe('AWEB-11C admin worker inventory endpoint', () => {
  test('requires the platform admin bearer and returns the real scoped read model', async () => {
    const heartbeatObservedAt = new Date();
    const query = jest.fn(async () => queryResult([workerRow({
      last_seen_at: heartbeatObservedAt,
      observed_at: heartbeatObservedAt,
    })]));
    const makeContext = (authorization: string): RouteContext => ({
      method: 'GET',
      pathname: '/api/v1/admin/worker-instances',
      searchParams: new URLSearchParams('businessId=document-core&limit=10'),
      headers: { authorization },
      db: { query } as unknown as Db,
      config: { adminToken: ADMIN_TOKEN },
    } as unknown as RouteContext);

    await expect(handleAdminRoutes(makeContext('Bearer wrong-token'))).rejects.toMatchObject({ status: 401 });
    expect(query).not.toHaveBeenCalled();

    const response = await handleAdminRoutes(makeContext(`Bearer ${ADMIN_TOKEN}`));
    expect(response).toMatchObject({
      status: 200,
      body: {
        items: [{ businessId: BUSINESS_ID, instanceId: 'worker-1', health: 'HEALTHY' }],
        sampledAt: expect.any(String),
        truncated: false,
      },
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM worker_instances'), [BUSINESS_ID, 11]);
  });
});
