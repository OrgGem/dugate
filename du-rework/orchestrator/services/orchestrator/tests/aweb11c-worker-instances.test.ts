import { HeartbeatAckSchema } from '@du/contracts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../src/db/db';
import { handleAdminRoutes } from '../src/http/routes/admin';
import { handleRuntimeRoutes } from '../src/http/routes/runtime';
import type { RouteContext } from '../src/http/route-context';
import { listWorkerInstances, parseWorkerInstanceListQuery } from '../src/modules/admin-read/worker-instances';
import {
  createWorkerInstanceRetentionScheduler,
  recordWorkerHeartbeat,
  retireWorkerInstance,
  sweepExpiredWorkerInstances,
  WORKER_INSTANCE_RETENTION_BATCH_SIZE,
  WORKER_INSTANCE_RETENTION_MS,
} from '../src/modules/runtime/worker-instances';

const ADMIN_TOKEN = 'aweb11c-platform-admin-token';
const WORKER_TOKEN = 'aweb11c-business-worker-token';
const BUSINESS_ID = 'document-core';
const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const MANIFEST_DIGEST = `sha256:${'a'.repeat(64)}`;

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
    active_task_count: 3,
    active_task_observed_at: new Date(NOW - 8_000),
    durable_leases: 1,
    total_count: 5,
    accepted_task_count: 17,
    accepted_task_count_since: new Date('2026-10-10T00:00:00.000Z'),
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
      reportedActiveTasks: 3,
      reportedObservedAt: '2026-10-10T11:59:52.000Z',
      durableLeases: 1,
      acceptedTaskCount: 17,
      acceptedTaskCountSince: '2026-10-10T00:00:00.000Z',
      acceptedTaskCountScope: 'business-instance-lifetime',
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
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("t.lease_expires_at>statement_timestamp()"), expect.any(Array));
    expect(result.total).toBe(5);
  });

  test('returns an empty actual inventory rather than synthesizing a row for a business', async () => {
    const db = { query: jest.fn(async () => queryResult([])) } as unknown as Db;
    await expect(listWorkerInstances(db, { businessId: BUSINESS_ID, limit: 100 }, NOW)).resolves.toEqual({
      items: [],
      total: 0,
      sampledAt: '2026-10-10T12:00:00.000Z',
      truncated: false,
    });
  });
});

describe('AWEB-11C persisted runtime worker heartbeat', () => {
  test('upserts authenticated instance data and safely joins text scope IDs to UUID tenants', async () => {
    const lastSeenAt = new Date('2026-10-10T11:59:59.000Z');
    const query = jest.fn(async (sql: string, _params: unknown[] = []) => {
      if (sql.includes('SELECT enabled,activation_revision,submissions_paused,pre_drain_version')) {
        return queryResult([{
          enabled: true, activation_revision: 4, submissions_paused: false, pre_drain_version: null,
        }]);
      }
      if (sql.includes('SELECT version,status,is_active FROM business_versions')) {
        return queryResult([{ version: '3.2.1', status: 'ENABLED', is_active: true }]);
      }
      if (sql.includes('SELECT state,fence_revision FROM maintenance_backup_effect_gate')) {
        return queryResult([{ state: 'OPEN', fence_revision: 3 }]);
      }
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

    expect(result).toEqual({
      state: 'ONLINE', lastSeenAt: lastSeenAt.toISOString(), controlRevision: 4, controlState: 'OPEN',
      backupEffectFence: { state: 'OPEN', revision: 3, acknowledged: false },
      activeVersion: '3.2.1', activationRevision: 4, admissionEligible: true, admissionReason: 'ELIGIBLE',
    });
    const write = query.mock.calls.find(([sql]) => sql.includes('WITH lease_count'));
    expect(write).toBeDefined();
    const [sql, params] = write!;
    expect(sql).toContain('INSERT INTO worker_instances');
    expect(sql).toContain('ON CONFLICT (business_id, instance_id) DO UPDATE');
    expect(sql).toContain("t.state = 'RUNNING'");
    expect(sql).toContain('t.lease_expires_at > statement_timestamp()');
    expect(sql).toContain('o.business_id = $1');
    expect(params).toEqual([BUSINESS_ID, 'worker-1', '3.2.1', 8, 'ONLINE', 4, 'OPEN', 'sha256:abc123', null, null, null, null]);
    expect(sql).toContain('manifest_digest');
    const tenantScopeQuery = query.mock.calls.find(([statement]) => statement.includes('SELECT r.scope_id,r.revision,r.desired_state'))?.[0];
    expect(tenantScopeQuery).toContain('o.tenant_id::text=r.scope_id');
    expect(tenantScopeQuery).not.toContain('r.scope_id::uuid');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO worker_control_scope_acks'), expect.any(Array));
  });

  test('reports an inactive version as ineligible while preserving ONLINE heartbeat liveness', async () => {
    const lastSeenAt = new Date('2026-10-10T11:59:59.000Z');
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('SELECT state,fence_revision FROM maintenance_backup_effect_gate')) {
        return queryResult([{ state: 'OPEN', fence_revision: 3 }]);
      }
      if (sql.includes('SELECT enabled,activation_revision,submissions_paused,pre_drain_version')) {
        return queryResult([{ enabled: true, activation_revision: 9, submissions_paused: false, pre_drain_version: null }]);
      }
      if (sql.includes('SELECT version,status,is_active FROM business_versions')) {
        return queryResult([
          { version: '4.0.0', status: 'ENABLED', is_active: true },
          { version: '3.2.1', status: 'ENABLED', is_active: false },
        ]);
      }
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
    const db = { tx: async (work: (client: never) => Promise<unknown>) => work({ query } as never) } as unknown as Db;

    const result = await recordWorkerHeartbeat(db, 'worker-v1', {
      businessId: BUSINESS_ID,
      businessVersion: '3.2.1',
      imageDigest: 'sha256:abc123',
      capacity: 8,
    });

    expect(result).toMatchObject({
      state: 'ONLINE', activeVersion: '4.0.0', activationRevision: 9,
      admissionEligible: false, admissionReason: 'VERSION_NOT_ACTIVE',
    });
    expect(query.mock.calls.some(([sql]) => sql.includes('WITH lease_count'))).toBe(true);
  });

  test('runtime route enforces the token business and rejects invalid heartbeat payloads', async () => {
    const lastSeenAt = new Date();
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('SELECT enabled,activation_revision,submissions_paused,pre_drain_version')) {
        return queryResult([{
          enabled: true, activation_revision: 4, submissions_paused: false, pre_drain_version: null,
        }]);
      }
      if (sql.includes('SELECT version,status,is_active FROM business_versions')) {
        return queryResult([{ version: '3.2.1', status: 'ENABLED', is_active: true }]);
      }
      if (sql.includes('SELECT state,fence_revision FROM maintenance_backup_effect_gate')) {
        return queryResult([{ state: 'OPEN', fence_revision: 3 }]);
      }
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
    expect(response?.body).toMatchObject({
      health: 'HEALTHY', capacity: 8, activeVersion: '3.2.1', activationRevision: 4,
      admissionEligible: true, admissionReason: 'ELIGIBLE',
    });
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

describe('runtime worker retirement endpoint', () => {
  test('requires authenticated business identity and treats a missing row as idempotent success', async () => {
    const query = jest.fn(async () => queryResult([]));
    const tx = jest.fn(async (work: (client: never) => Promise<unknown>) => work({ query } as never));
    const body = {
      businessId: BUSINESS_ID,
      businessVersion: '3.2.1',
      manifestDigest: MANIFEST_DIGEST,
    };
    const base = {
      method: 'POST',
      pathname: '/api/runtime/v1/workers/worker-1/retire',
      searchParams: new URLSearchParams(),
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
      body,
      db: { query, tx },
      config: { workerIdentityTokensByBusiness: { [BUSINESS_ID]: WORKER_TOKEN } },
    } as unknown as RouteContext;

    const mismatch = { ...base, body: { ...body, businessId: 'another-business' } } as unknown as RouteContext;
    await expect(handleRuntimeRoutes(mismatch)).rejects.toMatchObject({ status: 403 });
    expect(tx).not.toHaveBeenCalled();

    await expect(handleRuntimeRoutes(base)).resolves.toEqual({ status: 200, body: { retired: true } });
    await expect(handleRuntimeRoutes(base)).resolves.toEqual({ status: 200, body: { retired: true } });
    expect(tx).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT business_version,manifest_digest'),
      [BUSINESS_ID, 'worker-1'],
    );
  });
});

describe('worker instance retirement and bounded retention', () => {
  test('retires only the exact business/version/digest when it has no RUNNING task owner', async () => {
    const query = jest.fn(async (sql: string, _params: unknown[] = []) => {
      if (sql.includes('SELECT business_version,manifest_digest')) {
        return queryResult([{ business_version: '3.2.1', manifest_digest: MANIFEST_DIGEST }]);
      }
      if (sql.includes('AS has_running_task')) {
        return queryResult([{ has_running_task: false, active_leases: 0 }]);
      }
      if (sql.includes('DELETE FROM worker_instances')) return { ...queryResult([]), rowCount: 1 };
      return queryResult([]);
    });
    const db = { tx: jest.fn(async (work: (client: never) => Promise<unknown>) => work({ query } as never)) } as unknown as Db;

    await expect(retireWorkerInstance(db, BUSINESS_ID, 'worker-v321', '3.2.1', MANIFEST_DIGEST))
      .resolves.toBe('REMOVED');
    expect(query).toHaveBeenNthCalledWith(1,
      expect.stringContaining('FOR UPDATE'), [BUSINESS_ID, 'worker-v321']);
    expect(query).toHaveBeenNthCalledWith(2,
      expect.stringContaining("running_task.state='RUNNING'"), [BUSINESS_ID, 'worker-v321']);
    const deletion = query.mock.calls.find(([sql]) => sql.includes('DELETE FROM worker_instances'));
    expect(deletion?.[0]).toContain('business_id=$1 AND instance_id=$2');
    expect(deletion?.[0]).toContain('business_version=$3');
    expect(deletion?.[0]).toContain('manifest_digest=$4');
    expect(deletion?.[1]).toEqual([BUSINESS_ID, 'worker-v321', '3.2.1', MANIFEST_DIGEST]);
    expect(query.mock.calls.some(([sql]) => /DELETE\s+FROM\s+(tasks|operations)/i.test(sql))).toBe(false);
  });

  test('keeps an OFFLINE row for every RUNNING task, including an expired lease', async () => {
    const query = jest.fn(async (sql: string, _params: unknown[] = []) => {
      if (sql.includes('SELECT business_version,manifest_digest')) {
        return queryResult([{ business_version: '3.2.1', manifest_digest: MANIFEST_DIGEST }]);
      }
      if (sql.includes('AS has_running_task')) {
        return queryResult([{ has_running_task: true, active_leases: 0 }]);
      }
      return queryResult([]);
    });
    const db = { tx: jest.fn(async (work: (client: never) => Promise<unknown>) => work({ query } as never)) } as unknown as Db;

    await expect(retireWorkerInstance(db, BUSINESS_ID, 'worker-v321', '3.2.1', MANIFEST_DIGEST))
      .resolves.toBe('RETAINED_FOR_RUNNING_TASK');
    const leaseCheck = query.mock.calls.find(([sql]) => sql.includes('AS has_running_task'))?.[0] ?? '';
    expect(leaseCheck).toContain("running_task.state='RUNNING'");
    expect(leaseCheck).not.toContain('running_task.lease_expires_at');
    const update = query.mock.calls.find(([sql]) => sql.includes('UPDATE worker_instances'));
    expect(update?.[0]).toContain("SET state='OFFLINE', capacity=0");
    expect(update?.[1]).toEqual([BUSINESS_ID, 'worker-v321', '3.2.1', MANIFEST_DIGEST, 0]);
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM worker_instances'))).toBe(false);
  });

  test('treats missing or different-version rows as idempotent stale generations', async () => {
    const query = jest.fn(async (sql: string, _params: unknown[] = []) => {
      if (sql.includes('SELECT business_version,manifest_digest')) {
        return queryResult([{ business_version: '3.2.2', manifest_digest: MANIFEST_DIGEST }]);
      }
      return queryResult([]);
    });
    const db = { tx: jest.fn(async (work: (client: never) => Promise<unknown>) => work({ query } as never)) } as unknown as Db;

    await expect(retireWorkerInstance(db, BUSINESS_ID, 'worker-reused', '3.2.1', MANIFEST_DIGEST))
      .resolves.toBe('STALE_IDENTITY');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE worker_instances') || sql.includes('DELETE FROM worker_instances')))
      .toBe(false);
  });

  test('locks a bounded non-RUNNING candidate set and rechecks task ownership before deleting', async () => {
    const cutoff = new Date(NOW - WORKER_INSTANCE_RETENTION_MS).toISOString();
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT business_id,instance_id')) {
        return queryResult([
          { business_id: BUSINESS_ID, instance_id: 'old-v1-a' },
          { business_id: BUSINESS_ID, instance_id: 'old-v1-b' },
          { business_id: 'other-business', instance_id: 'old-v2-a' },
        ]);
      }
      if (sql.includes('SELECT last_seen_at <= $3::timestamptz')) return queryResult([{ expired: true }]);
      if (sql.includes('SELECT EXISTS')) {
        return queryResult([{ has_running_task: params[1] === 'old-v1-b' }]);
      }
      if (sql.includes('DELETE FROM worker_instances')) return { ...queryResult([]), rowCount: 1 };
      return queryResult([]);
    });
    const db = { tx: jest.fn(async (work: (client: never) => Promise<unknown>) => work({ query } as never)) } as unknown as Db;

    await expect(sweepExpiredWorkerInstances(db, NOW, 3)).resolves.toEqual({
      scanned: 3,
      deleted: 2,
      protectedByRunningTask: 1,
    });
    const selection = query.mock.calls[0]?.[0] ?? '';
    expect(selection).toContain('LIMIT $2 FOR UPDATE SKIP LOCKED');
    expect(selection).toContain('NOT EXISTS');
    expect(selection).toContain("t.state='RUNNING'");
    expect(query.mock.calls[0]?.[1]).toEqual([cutoff, 3]);
    const ownershipReads = query.mock.calls.filter(([sql]) => sql.includes('SELECT EXISTS'));
    expect(ownershipReads.map((call) => call[1] ?? [])).toEqual([
      [BUSINESS_ID, 'old-v1-a'],
      [BUSINESS_ID, 'old-v1-b'],
      ['other-business', 'old-v2-a'],
    ]);
    const deletes = query.mock.calls.filter(([sql]) => sql.includes('DELETE FROM worker_instances'));
    expect(deletes).toHaveLength(2);
    expect(deletes.map((call) => (call[1] ?? []).slice(0, 2))).toEqual([
      [BUSINESS_ID, 'old-v1-a'],
      ['other-business', 'old-v2-a'],
    ]);
    expect(query.mock.calls.some(([sql]) => /DELETE\s+FROM\s+(tasks|operations)/i.test(sql))).toBe(false);
    await expect(sweepExpiredWorkerInstances(db, NOW, WORKER_INSTANCE_RETENTION_BATCH_SIZE + 1))
      .rejects.toThrow('worker instance retention limit');
  });

  test('does not starve later eligible rows behind an older batch of RUNNING owners', async () => {
    const query = jest.fn(async (sql: string, _params: unknown[] = []) => {
      if (sql.includes('SELECT business_id,instance_id')) {
        // PostgreSQL returns the later eligible rows because the bounded
        // candidate query excludes the >100 older RUNNING owners.
        return queryResult(Array.from({ length: WORKER_INSTANCE_RETENTION_BATCH_SIZE }, (_, index) => ({
          business_id: BUSINESS_ID,
          instance_id: `eligible-${index}`,
        })));
      }
      if (sql.includes('SELECT last_seen_at <= $3::timestamptz')) return queryResult([{ expired: true }]);
      if (sql.includes('SELECT EXISTS')) return queryResult([{ has_running_task: false }]);
      if (sql.includes('DELETE FROM worker_instances')) return { ...queryResult([]), rowCount: 1 };
      return queryResult([]);
    });
    const db = { tx: jest.fn(async (work: (client: never) => Promise<unknown>) => work({ query } as never)) } as unknown as Db;

    await expect(sweepExpiredWorkerInstances(db, NOW)).resolves.toMatchObject({
      scanned: WORKER_INSTANCE_RETENTION_BATCH_SIZE,
      deleted: WORKER_INSTANCE_RETENTION_BATCH_SIZE,
      protectedByRunningTask: 0,
    });
    expect(query.mock.calls[0]?.[0]).toContain('NOT EXISTS');
    expect(query.mock.calls[0]?.[0]).toContain('LIMIT $2 FOR UPDATE SKIP LOCKED');
    expect(query.mock.calls[0]?.[1]?.[1]).toBe(WORKER_INSTANCE_RETENTION_BATCH_SIZE);
  });

  test('retention scheduler gates autonomous work, single-flights, and awaits its active sweep on stop', async () => {
    jest.useFakeTimers();
    try {
      const client = { query: jest.fn(async () => queryResult([])) };
      let finishTransaction!: () => void;
      const gate = new Promise<void>((resolve) => { finishTransaction = resolve; });
      const tx = jest.fn(async (work: (client: never) => Promise<unknown>) => {
        await gate;
        return work(client as never);
      });
      const db = { tx } as unknown as Db;
      const disabled = createWorkerInstanceRetentionScheduler(db, { enabled: false, intervalMs: 10 });
      disabled.start();
      await jest.advanceTimersByTimeAsync(50);
      expect(tx).not.toHaveBeenCalled();
      await disabled.stop();

      const scheduler = createWorkerInstanceRetentionScheduler(db, { enabled: true, intervalMs: 10 });
      scheduler.start();
      expect(tx).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(50);
      expect(tx).toHaveBeenCalledTimes(1);
      let stopped = false;
      const close = scheduler.stop().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      finishTransaction();
      await close;
      expect(stopped).toBe(true);
      await jest.advanceTimersByTimeAsync(50);
      expect(tx).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
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
