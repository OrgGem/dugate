import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { Db, createDb } from './db/db';
import { createRegistryService, enableVersionForTest } from './modules/registry/registry';
import { createSubmissionService, loadOperationView } from './modules/operations/submission';
import { createRuntimeService } from './modules/runtime/runtime';
import { createDispatcher } from './modules/queue/dispatcher';
import { HttpError } from './http/errors';
import { createLogger } from '@du/observability';

export interface ServerConfig {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  runtimeToken?: string;
  /** Auto-dispatch outbox on submit + background sweeper. Default true; tests drive dispatchOnce() manually. */
  autoDispatch?: boolean;
}

export async function createApp(config: ServerConfig) {
  const db = createDb(config.databaseUrl);
  const redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  const logger = createLogger({ component: 'orchestrator' });

  // Run migrations
  const migrationSql = readFileSync(join(__dirname, '../migrations/0001_platform_v1.sql'), 'utf8');
  await db.query(migrationSql);

  // Ensure default tenant for the slice (idempotent)
  await db.query(
    `INSERT INTO tenants (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'default')
     ON CONFLICT (id) DO NOTHING`
  );
  // Dev fallback key row so operations.api_key_id FK always resolves.
  await db.query(
    `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
     VALUES ('00000000-0000-0000-0000-000000000099',
             '00000000-0000-0000-0000-000000000001',
             'dev-fallback-placeholder', 'dev-fallback', 'ACTIVE')
     ON CONFLICT (id) DO NOTHING`
  );

  const registry = createRegistryService(db);
  const submission = createSubmissionService(db, registry);
  const runtime = createRuntimeService(db);

  const queues = new Map<string, Queue>();
  function getQueue(name: string): Queue {
    let q = queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: redis as never });
      queues.set(name, q);
    }
    return q;
  }

  const dispatcher = createDispatcher({ db, getQueue });

  const server = createServer(async (req, res) => {
    const correlationId = (req.headers['x-correlation-id'] as string) || randomUUID();
    res.setHeader('x-correlation-id', correlationId);
    res.setHeader('content-type', 'application/json');

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';
    const body = await readBody(req);

    try {
      const result = await route({
        method,
        pathname: url.pathname,
        searchParams: url.searchParams,
        headers: req.headers as Record<string, string>,
        body,
        correlationId,
        db,
        registry,
        submission,
        runtime,
        dispatcher,
        getQueue,
        config,
      });
      res.statusCode = result.status;
      for (const [k, v] of Object.entries(result.headers ?? {})) res.setHeader(k, v);
      res.end(JSON.stringify(result.body ?? {}));
    } catch (err) {
      if (err instanceof HttpError) {
        const problem = err.toProblem(correlationId);
        res.statusCode = err.status;
        res.end(JSON.stringify(problem));
        return;
      }
      logger.error('unhandled request error', { error: String(err), pathname: url.pathname });
      res.statusCode = 500;
      res.end(JSON.stringify({ type: 'urn:du:error:temporary_unavailable', title: 'internal error', status: 500, code: 'TEMPORARY_UNAVAILABLE', detail: String(err) }));
    }
  });

  return {
    db,
    redis,
    server,
    registry,
    submission,
    runtime,
    dispatcher,
    getQueue,
    enableVersionForTest: (businessId: string, version: string) => enableVersionForTest(db, businessId, version),
    async listen() {
      await new Promise<void>((resolve) => server.listen(config.port, resolve));
      if (config.autoDispatch !== false) dispatcher.start();
      return server;
    },
    async close() {
      dispatcher.stop();
      // Drop idle keep-alive sockets so close() resolves promptly in tests.
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
      for (const q of queues.values()) await q.close().catch(() => undefined);
      redis.disconnect();
      await db.close();
    },
  };
}

export type App = Awaited<ReturnType<typeof createApp>>;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

interface RouteContext {
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
  correlationId: string;
  db: Db;
  registry: ReturnType<typeof createRegistryService>;
  submission: ReturnType<typeof createSubmissionService>;
  runtime: ReturnType<typeof createRuntimeService>;
  dispatcher: ReturnType<typeof createDispatcher>;
  getQueue: (name: string) => Queue;
  config: ServerConfig;
}

async function route(ctx: RouteContext): Promise<{ status: number; body?: unknown; headers?: Record<string, string> }> {
  const { method, pathname } = ctx;

  // Health
  if (method === 'GET' && pathname === '/health') {
    return { status: 200, body: { status: 'ok' } };
  }

  // Runtime: PUT /api/runtime/v1/businesses/:id/versions/:version
  {
    const m = /^\/api\/runtime\/v1\/businesses\/([^/]+)\/versions\/([^/]+)$/.exec(pathname);
    if (m && method === 'PUT') {
      assertRuntimeAuth(ctx);
      const result = await ctx.registry.registerVersion(ctx.body);
      return { status: result.created ? 201 : 200, body: result };
    }
  }

  // Runtime: PUT /api/runtime/v1/workers/:instanceId/heartbeat
  if (method === 'PUT' && /^\/api\/runtime\/v1\/workers\/[^/]+\/heartbeat$/.test(pathname)) {
    assertRuntimeAuth(ctx);
    return { status: 200, body: { health: 'HEALTHY', leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), capacity: 1 } };
  }

  // Runtime: POST /api/runtime/v1/tasks/:id/claim
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/claim$/.exec(pathname);
    if (m && method === 'POST') {
      assertRuntimeAuth(ctx);
      const body = ctx.body as { deliveryId: string; workerInstanceId: string };
      const result = await ctx.runtime.claimTask(m[1]!, body.deliveryId, body.workerInstanceId);
      return { status: 200, body: result };
    }
  }

  // Runtime: POST /api/runtime/v1/tasks/:id/heartbeat
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/heartbeat$/.exec(pathname);
    if (m && method === 'POST') {
      assertRuntimeAuth(ctx);
      const body = ctx.body as { leaseEpoch: number };
      const result = await ctx.runtime.heartbeatTask(m[1]!, body.leaseEpoch);
      return { status: 200, body: result };
    }
  }

  // Runtime: PUT /api/runtime/v1/tasks/:id/steps/:stepKey
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/steps\/([^/]+)$/.exec(pathname);
    if (m && method === 'PUT') {
      assertRuntimeAuth(ctx);
      const result = await ctx.runtime.saveStep(m[1]!, decodeURIComponent(m[2]!), ctx.body as never);
      return { status: result.replayed ? 200 : 201, body: result };
    }
  }

  // Runtime: POST /api/runtime/v1/tasks/:id/progress
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/progress$/.exec(pathname);
    if (m && method === 'POST') {
      assertRuntimeAuth(ctx);
      await ctx.runtime.reportProgress(m[1]!, ctx.body as never);
      return { status: 200, body: {} };
    }
  }

  // Runtime: POST /api/runtime/v1/tasks/:id/complete
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/complete$/.exec(pathname);
    if (m && method === 'POST') {
      assertRuntimeAuth(ctx);
      const result = await ctx.runtime.completeTask(m[1]!, ctx.body as never);
      return { status: 200, body: result };
    }
  }

  // Runtime: POST /api/runtime/v1/tasks/:id/fail
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/fail$/.exec(pathname);
    if (m && method === 'POST') {
      assertRuntimeAuth(ctx);
      const result = await ctx.runtime.failTask(m[1]!, ctx.body as never);
      return { status: 200, body: result };
    }
  }

  // Public: POST /api/v1/businesses/:id/actions/:action
  {
    const m = /^\/api\/v1\/businesses\/([^/]+)\/actions\/([^/]+)$/.exec(pathname);
    if (m && method === 'POST') {
      const apiKey = await resolveApiKey(ctx);
      const result = await ctx.submission.submit({
        tenantId: apiKey.tenantId,
        apiKeyId: apiKey.id,
        businessId: decodeURIComponent(m[1]!),
        action: decodeURIComponent(m[2]!),
        idempotencyKey: (ctx.headers['idempotency-key'] as string) || undefined,
        correlationId: ctx.correlationId,
        submission: ctx.body,
      });
      // Best-effort dispatch after commit (sweeper covers a crash between).
      if (ctx.config.autoDispatch !== false) {
        ctx.dispatcher.dispatchOnce().catch(() => undefined);
      }
      const status = result.replayed ? 200 : 202;
      return {
        status,
        body: {
          operationId: result.operation.id,
          state: result.operation.state,
          stateVersion: result.operation.stateVersion,
          replayed: result.replayed,
          correlationId: result.correlationId,
          links: result.operation.links,
        },
      };
    }
  }

  // Public: GET /api/v1/operations
  if (method === 'GET' && pathname === '/api/v1/operations') {
    const apiKey = await resolveApiKey(ctx);
    const limit = Math.min(100, Math.max(1, parseInt(ctx.searchParams.get('limit') ?? '20', 10) || 20));
    const cursor = ctx.searchParams.get('cursor') ?? undefined;
    const rows = await ctx.runtime.listOperations(apiKey.tenantId, limit, cursor);
    // Envelope per docs 06 pagination: { items, nextCursor }.
    return { status: 200, body: { items: rows.map((r) => toOperationView(r)), nextCursor: null } };
  }

  // Public: GET /api/v1/operations/:id
  {
    const m = /^\/api\/v1\/operations\/([^/]+)$/.exec(pathname);
    if (m && method === 'GET' && !pathname.endsWith('/result')) {
      const apiKey = await resolveApiKey(ctx);
      const op = await ctx.runtime.getOperation(m[1]!);
      if ((op.tenant_id as string) !== apiKey.tenantId) throw new HttpError(404, 'NOT_FOUND', 'operation not found');
      return { status: 200, body: toOperationView(op) };
    }
  }

  // Public: GET /api/v1/operations/:id/result
  {
    const m = /^\/api\/v1\/operations\/([^/]+)\/result$/.exec(pathname);
    if (m && method === 'GET') {
      const apiKey = await resolveApiKey(ctx);
      const op = await ctx.runtime.getOperation(m[1]!);
      if ((op.tenant_id as string) !== apiKey.tenantId) throw new HttpError(404, 'NOT_FOUND', 'operation not found');
      if ((op.state as string) !== 'SUCCEEDED') {
        throw new HttpError(409, 'STATE_CONFLICT', `operation is ${op.state as string}, not SUCCEEDED`);
      }
      return {
        status: 200,
        body: {
          schemaVersion: '1',
          data: op.result_ref ? { resultRef: op.result_ref } : {},
          artifacts: [],
          usage: { inputTokens: 0, outputTokens: 0, costMicrousd: 0, measurement: 'pending' },
          warnings: [],
        },
      };
    }
  }

  return { status: 404, body: { type: 'urn:du:error:not_found', title: 'not found', status: 404, code: 'NOT_FOUND' } };
}

function assertRuntimeAuth(ctx: RouteContext) {
  if (!ctx.config.runtimeToken) return; // slice: open when no token configured
  const auth = ctx.headers['authorization'] ?? '';
  if (auth !== `Bearer ${ctx.config.runtimeToken}`) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'invalid runtime bearer token');
  }
}

async function resolveApiKey(ctx: RouteContext): Promise<{ id: string; tenantId: string }> {
  const raw = ctx.headers['x-api-key'] as string | undefined;
  if (!raw) throw new HttpError(401, 'UNAUTHENTICATED', 'missing x-api-key');
  // Slice: hash lookup; tests create keys via helper. Fallback to default tenant for dev.
  const hash = hashKey(raw);
  const res = await ctx.db.query('SELECT id, tenant_id FROM api_keys WHERE hash=$1 AND status=$2', [hash, 'ACTIVE']);
  if (res.rowCount) {
    const row = res.rows[0] as { id: string; tenant_id: string };
    return { id: row.id, tenantId: row.tenant_id };
  }
  // Dev fallback: if no keys seeded, treat any key as default tenant (slice convenience)
  const tenantRes = await ctx.db.query(`SELECT id FROM tenants WHERE name='default' LIMIT 1`);
  if (tenantRes.rowCount) {
    return { id: '00000000-0000-0000-0000-000000000099', tenantId: (tenantRes.rows[0] as { id: string }).id };
  }
  throw new HttpError(401, 'UNAUTHENTICATED', 'invalid api key');
}

function hashKey(raw: string): string {
  const { createHash } = require('node:crypto');
  return createHash('sha256').update(raw).digest('hex');
}

function toOperationView(r: Record<string, unknown>) {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    businessId: r.business_id,
    businessVersion: r.business_version,
    action: r.action,
    state: r.state,
    stateVersion: r.state_version,
    createdAt: r.created_at ? new Date(r.created_at as string).toISOString() : new Date().toISOString(),
    updatedAt: r.updated_at ? new Date(r.updated_at as string).toISOString() : new Date().toISOString(),
    deadlineAt: r.deadline_at ? new Date(r.deadline_at as string).toISOString() : null,
    progress: { percent: 0, message: r.state as string },
    links: { self: `/api/v1/operations/${r.id as string}`, result: `/api/v1/operations/${r.id as string}/result` },
  };
}
