import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createApp, type App } from '../src/server';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const RUNTIME_TOKEN = 'w39c-runtime-' + randomUUID();
const ADMIN_TOKEN = 'w39c-admin-' + randomUUID();
const RAW_API_KEY = 'du_w39c_' + randomUUID().replace(/-/g, '');
const TENANT_ID = '11111111-2222-4333-8444-555555555555';
const BIZ = 'w39c-biz';

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function assertTestDatabase(): void {
  const dbName = new URL(DATABASE_URL).pathname.split('/').pop() ?? '.';
  if (!/test/i.test(dbName)) {
    throw new Error(`refusing test cleanup: DATABASE_URL database "${dbName}" is not a test database`);
  }
}

async function http(
  base: string,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

let app: App;
let baseUrl: string;
let stub: Server;
let stubBase: string;
let stubMode: 'healthy' | 'unhealthy' | 'secret-leak';
let stubSeenHeaders: Record<string, string | string[] | undefined>[] = [];

function stubHandler(req: IncomingMessage, res: ServerResponse): void {
  stubSeenHeaders.push({ ...req.headers });
  if (req.url === '/health/ready') {
    if (stubMode === 'healthy') {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (stubMode === 'secret-leak') {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'db password=hunter2 leaked upstream', token: 'sk-live-SECRET-XYZ' }));
      return;
    }
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false }));
    return;
  }
  res.statusCode = 404;
  res.end('{}');
}

async function seedOperation(label: string): Promise<{ operationId: string; taskId: string }> {
  const op = await app.db.query<{ id: string }>(
    `INSERT INTO operations (tenant_id, business_id, business_version, action, correlation_id, input_ref)
     VALUES ($1,$2,'1.0.0','extract',$3,'{}'::jsonb) RETURNING id`,
    [TENANT_ID, BIZ, `w39c-${label}-${randomUUID()}`]
  );
  const operationId = op.rows[0]!.id;
  const task = await app.db.query<{ id: string }>(
    `INSERT INTO tasks (operation_id, task_key, kind) VALUES ($1,$2,'root') RETURNING id`,
    [operationId, `w39c-task-${randomUUID()}`]
  );
  return { operationId, taskId: task.rows[0]!.id };
}

async function seedUsageEvent(
  target: { operationId: string; taskId: string },
  opts: {
    inputTokens?: number;
    outputTokens?: number;
    pages?: number;
    costMicrousd?: number;
    measurement?: 'measured' | 'estimated';
    provider?: string;
    model?: string;
    receivedAt?: string;
  } = {}
): Promise<string> {
  const eventId = `w39c-${randomUUID()}`;
  const payload: Record<string, unknown> = {
    eventId,
    invocationId: `inv-${randomUUID()}`,
    operationId: target.operationId,
    taskId: target.taskId,
    units: {
      inputTokens: opts.inputTokens ?? 10,
      outputTokens: opts.outputTokens ?? 5,
      ...(opts.pages !== undefined ? { pages: opts.pages } : {}),
    },
    costMicrousd: opts.costMicrousd ?? 7,
    currency: 'USD',
    measurement: opts.measurement ?? 'measured',
    occurredAt: new Date().toISOString(),
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
  };
  await app.db.query(
    `INSERT INTO usage_events (event_id, operation_id, task_id, payload, received_at)
     VALUES ($1,$2,$3,$4::jsonb,$5)`,
    [eventId, target.operationId, target.taskId, JSON.stringify(payload), opts.receivedAt ?? new Date().toISOString()]
  );
  return eventId;
}

async function scopedCleanup(): Promise<void> {
  assertTestDatabase();
  const ops = await app.db.query<{ id: string }>('SELECT id FROM operations WHERE business_id=$1', [BIZ]);
  const opIds = ops.rows.map((r) => r.id);
  if (opIds.length > 0) {
    await app.db.query('DELETE FROM usage_events WHERE operation_id = ANY($1)', [opIds]);
    const tasks = await app.db.query<{ id: string }>('SELECT id FROM tasks WHERE operation_id = ANY($1)', [opIds]);
    const taskIds = tasks.rows.map((r) => r.id);
    if (taskIds.length > 0) {
      await app.db.query('DELETE FROM invocation_grants WHERE task_id = ANY($1)', [taskIds]);
      await app.db.query('DELETE FROM step_checkpoints WHERE task_id = ANY($1)', [taskIds]);
      await app.db.query('DELETE FROM outbox WHERE aggregate_id = ANY($1)', [taskIds]);
      await app.db.query('DELETE FROM tasks WHERE id = ANY($1)', [taskIds]);
    }
    await app.db.query('DELETE FROM submission_keys WHERE operation_id = ANY($1)', [opIds]);
    await app.db.query('DELETE FROM webhook_deliveries WHERE operation_id = ANY($1)', [opIds]);
    await app.db.query('DELETE FROM operations WHERE id = ANY($1)', [opIds]);
  }
}

// WINDOW GUARD (cycle 104, fleet standard after admin-error-boundary §52): this
// suite boots the REAL app (PG :5433 / Redis :6380). Without DU_LIVE_INFRA=1
// everything below is skipped — no createApp, no listen, no connection.
const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn('usage-summary.test.ts: SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.');
}

liveDescribe('WINDOW-GATED live suite (DU_LIVE_INFRA=1)', () => {
beforeAll(async () => {
  stubMode = 'healthy';
  stub = createServer(stubHandler);
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  stubBase = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;

  app = await createApp({
    port: 0,
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    runtimeToken: RUNTIME_TOKEN,
    adminToken: ADMIN_TOKEN,
    autoDispatch: false,
    autoMigrate: true,
    connectorBaseUrls: {
      'stub-conn': stubBase,
      'dead-conn': 'http://127.0.0.1:1',
    },
  });
  await app.db.query(`INSERT INTO tenants (id, name) VALUES ($1,'w39c-suite') ON CONFLICT (id) DO NOTHING`, [TENANT_ID]);
  await app.db.query(
    `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
     VALUES ($1,$2,$3,'w39c','ACTIVE') ON CONFLICT (hash) DO UPDATE SET status='ACTIVE'`,
    [randomUUID(), TENANT_ID, hashKey(RAW_API_KEY)]
  );
  const server = await app.listen();
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await scopedCleanup();
}, 120_000);

afterEach(async () => {
  await scopedCleanup();
}, 30_000);

afterAll(async () => {
  await scopedCleanup().catch(() => undefined);
  // W42-C5-D(2): opt out of the 30s production grace drain (see
  // blob-wire-binary.test.ts) — drain() counts RUNNING rows server-wide, so
  // another lane's in-flight row would hold close() past the hook timeout.
  await app?.close({ timeoutMs: 0, pollIntervalMs: 10 });
  await new Promise<void>((resolve) => stub.close(() => resolve()));
}, 30_000);

function keyHeaders(): Record<string, string> {
  return { 'x-api-key': RAW_API_KEY };
}

const WINDOW_FROM = '2000-01-01T00:00:00.000Z';
const WINDOW_TO = '2100-01-01T00:00:00.000Z';

describe('W39-C: usage summary projection (real DB)', () => {
  test('aggregates by provider+model with correct totals and mixed measurement', async () => {
    const opA = await seedOperation('agg-a');
    const opB = await seedOperation('agg-b');
    await seedUsageEvent(opA, { provider: 'acme', model: 'x-1', inputTokens: 10, outputTokens: 5, costMicrousd: 7 });
    await seedUsageEvent(opA, {
      provider: 'acme', model: 'x-1', inputTokens: 20, outputTokens: 1, costMicrousd: 3, measurement: 'estimated',
    });
    await seedUsageEvent(opB, { provider: 'other', model: 'y-2', inputTokens: 4, outputTokens: 4, costMicrousd: 2, pages: 3 });

    const res = await http(baseUrl, `/api/v1/usage/summary?from=${WINDOW_FROM}&to=${WINDOW_TO}`, {
      headers: keyHeaders(),
    });
    expect(res.status).toBe(200);
    const rows = res.body.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    const acme = rows.find((r) => r.provider === 'acme')!;
    expect(acme).toMatchObject({ model: 'x-1', operations: 1, inputTokens: 30, outputTokens: 6, costMicrousd: 10, measurement: 'mixed' });
    const other = rows.find((r) => r.provider === 'other')!;
    expect(other).toMatchObject({ model: 'y-2', operations: 1, inputTokens: 4, outputTokens: 4, pages: 3, costMicrousd: 2, measurement: 'measured' });
    expect(res.body.totals).toMatchObject({ operations: 2, inputTokens: 34, outputTokens: 10, pages: 3, costMicrousd: 12 });
  });

  test('rows without provider/model collapse into the unattributed bucket', async () => {
    const op = await seedOperation('unattributed');
    await seedUsageEvent(op, { inputTokens: 1, outputTokens: 1, costMicrousd: 1 });
    const res = await http(baseUrl, `/api/v1/usage/summary?from=${WINDOW_FROM}&to=${WINDOW_TO}`, {
      headers: keyHeaders(),
    });
    expect(res.status).toBe(200);
    const rows = res.body.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: '(unattributed)', model: '(unattributed)', operations: 1 });
  });

  test('tenant isolation: another tenant rows are excluded', async () => {
    const otherTenant = randomUUID();
    await app.db.query(`INSERT INTO tenants (id, name) VALUES ($1,'w39c-other') ON CONFLICT (id) DO NOTHING`, [otherTenant]);
    const op = await app.db.query<{ id: string }>(
      `INSERT INTO operations (tenant_id, business_id, business_version, action, correlation_id, input_ref)
       VALUES ($1,$2,'1.0.0','extract',$3,'{}'::jsonb) RETURNING id`,
      [otherTenant, BIZ, `w39c-foreign-${randomUUID()}`]
    );
    const opId = op.rows[0]!.id;
    const task = await app.db.query<{ id: string }>(
      `INSERT INTO tasks (operation_id, task_key, kind) VALUES ($1,$2,'root') RETURNING id`,
      [opId, `w39c-foreign-task-${randomUUID()}`]
    );
    await app.db.query(
      `INSERT INTO usage_events (event_id, operation_id, task_id, payload, received_at)
       VALUES ($1,$2,$3,$4::jsonb,now())`,
      [`w39c-foreign-${randomUUID()}`, opId, task.rows[0]!.id, JSON.stringify({
        eventId: 'x', invocationId: 'y', operationId: opId, units: { inputTokens: 999, outputTokens: 999 },
        costMicrousd: 999, currency: 'USD', measurement: 'measured', occurredAt: new Date().toISOString(),
        provider: 'foreign', model: 'z-9',
      })]
    );
    const own = await seedOperation('own-tenant');
    await seedUsageEvent(own, { provider: 'own', model: 'o-1', inputTokens: 2, outputTokens: 2, costMicrousd: 2 });

    const res = await http(baseUrl, `/api/v1/usage/summary?from=${WINDOW_FROM}&to=${WINDOW_TO}`, {
      headers: keyHeaders(),
    });
    expect(res.status).toBe(200);
    const rows = res.body.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe('own');
    expect(res.body.totals).toMatchObject({ inputTokens: 2 });
  });

  test('window filtering: rows outside [from,to) are excluded', async () => {
    const op = await seedOperation('window');
    await seedUsageEvent(op, { provider: 'in', model: 'w-1', inputTokens: 8, outputTokens: 8, costMicrousd: 8, receivedAt: '2026-06-01T00:00:00.000Z' });
    await seedUsageEvent(op, { provider: 'out', model: 'w-1', inputTokens: 100, outputTokens: 100, costMicrousd: 100, receivedAt: '1990-01-01T00:00:00.000Z' });

    const res = await http(
      baseUrl,
      '/api/v1/usage/summary?from=2026-01-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z',
      { headers: keyHeaders() }
    );
    expect(res.status).toBe(200);
    const rows = res.body.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'in', inputTokens: 8 });
  });

  test('invalid window and missing params fail closed with 422', async () => {
    const missing = await http(baseUrl, '/api/v1/usage/summary', { headers: keyHeaders() });
    expect(missing.status).toBe(422);
    const inverted = await http(
      baseUrl, `/api/v1/usage/summary?from=${WINDOW_TO}&to=${WINDOW_FROM}`, { headers: keyHeaders() }
    );
    expect(inverted.status).toBe(422);
    const unauth = await http(baseUrl, `/api/v1/usage/summary?from=${WINDOW_FROM}&to=${WINDOW_TO}`);
    expect(unauth.status).toBe(401);
  });
});

describe('W39-C: connector test proxy (CON-03)', () => {
  const probeProfileId = randomUUID();

  beforeAll(async () => {
    const key = await app.db.query<{ id: string }>('SELECT id FROM api_keys WHERE hash=$1', [hashKey(RAW_API_KEY)]);
    await app.db.query(
      `INSERT INTO profile_bindings
         (profile_id, revision, tenant_id, api_key_id, business_id, business_version, action, connector_bindings, enabled)
       VALUES ($1,1,$2,$3,$4,'1.0.0','extract',$5::jsonb,true)`,
      [probeProfileId, TENANT_ID, key.rows[0]!.id, BIZ, JSON.stringify({
        readinessStub: { connectorId: 'stub-conn', revision: 1 },
        readinessDead: { connectorId: 'dead-conn', revision: 1 },
      })],
    );
    await app.db.query('INSERT INTO profile_active_revisions (profile_id, revision) VALUES ($1,1)', [probeProfileId]);
  });

  afterAll(async () => {
    await app.db.query('DELETE FROM profile_active_revisions WHERE profile_id=$1', [probeProfileId]);
    await app.db.query('DELETE FROM profile_bindings WHERE profile_id=$1', [probeProfileId]);
  });

  test('healthy connector returns ok:true and sends no caller/internal headers', async () => {
    stubMode = 'healthy';
    stubSeenHeaders = [];
    const res = await http(baseUrl, '/api/v1/connectors/stub-conn/test', {
      headers: { ...keyHeaders(), authorization: 'Bearer caller-secret', 'x-internal-token': 'nope' },
    });
    expect(res.status).toBe(200);
    expect(res.body.connectorId).toBe('stub-conn');
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.latencyMs).toBe('number');
    expect(stubSeenHeaders).toHaveLength(1);
    expect(stubSeenHeaders[0]!.authorization).toBeUndefined();
    expect(stubSeenHeaders[0]!['x-internal-token']).toBeUndefined();
    expect(stubSeenHeaders[0]!['x-api-key']).toBeUndefined();
  });

  test('unhealthy upstream surfaces sanitized 502 with no upstream body echo', async () => {
    stubMode = 'secret-leak';
    const res = await http(baseUrl, '/api/v1/connectors/stub-conn/test', { headers: keyHeaders() });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('CONNECTOR_UNHEALTHY');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('sk-live-SECRET-XYZ');
  });

  test('unreachable connector surfaces sanitized 502 with no address leak', async () => {
    const res = await http(baseUrl, '/api/v1/connectors/dead-conn/test', { headers: keyHeaders() });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('CONNECTOR_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toContain('127.0.0.1:1');
  });

  test('unbound connector id fails closed with 403; missing key with 401, without probing', async () => {
    stubSeenHeaders = [];
    const unknown = await http(baseUrl, '/api/v1/connectors/nope/test', { headers: keyHeaders() });
    expect(unknown.status).toBe(403);
    const unauth = await http(baseUrl, '/api/v1/connectors/stub-conn/test');
    expect(unauth.status).toBe(401);
    expect(stubSeenHeaders).toHaveLength(0);
  });

  test('a configured connector without a published binding is denied before outbound HTTP', async () => {
    await app.db.query('DELETE FROM profile_active_revisions WHERE profile_id=$1', [probeProfileId]);
    stubSeenHeaders = [];
    try {
      const denied = await http(baseUrl, '/api/v1/connectors/stub-conn/test', { headers: keyHeaders() });
      expect(denied.status).toBe(403);
      expect(stubSeenHeaders).toHaveLength(0);
    } finally {
      await app.db.query('INSERT INTO profile_active_revisions (profile_id, revision) VALUES ($1,1)', [probeProfileId]);
    }
  });
});
});
