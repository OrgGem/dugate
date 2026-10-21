import type { QueryResult, QueryResultRow } from 'pg';
import { businessQueueName } from '@du/contracts';
import type { Db } from '../src/db/db';
import { HttpError } from '../src/http/errors';
import { createSubmissionService } from '../src/modules/operations/submission';
import { createProfileService } from '../src/modules/profiles/profiles';
import type { RegistryService } from '../src/modules/registry/registry';
import { createDispatcher } from '../src/modules/queue/dispatcher';
import { createRuntimeService } from '../src/modules/runtime/runtime';
import { authorizeWorkerClaim } from '../src/modules/runtime/worker-identity';
import { route, type RouteContext } from '../src/server';

const TASK_ID = '71000000-0000-4000-8000-000000000001';
const OPERATION_ID = '72000000-0000-4000-8000-000000000001';
const TENANT_ID = '73000000-0000-4000-8000-000000000001';
const API_KEY_ID = '74000000-0000-4000-8000-000000000001';

function result<T extends QueryResultRow>(rows: QueryResultRow[], command = 'SELECT'): QueryResult<T> {
  return {
    command,
    rowCount: rows.length,
    oid: 0,
    rows: rows as T[],
    fields: [],
  };
}

const WORKER_CONFIG = {
  runtimeToken: 'platform-runtime-token',
  adminToken: 'platform-admin-token',
  usageToken: 'connector-usage-token',
  workerIdentityTokensByBusiness: {
    'business-a': 'worker-a-registration-token',
    'business-b': 'worker-b-registration-token',
  },
};

function routeContext(options: {
  method?: string;
  pathname?: string;
  authorization?: string;
  body?: unknown;
  taskBusinessId?: string;
  artifactBusinessId?: string;
} = {}): RouteContext {
  const query = jest.fn(async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) => {
      if (/FROM business_catalog WHERE business_id=\$1/i.test(sql)) {
        return result<T>([{
          enabled: true,
          activation_revision: 1,
          submissions_paused: false,
          pre_drain_version: null,
        }]);
      }
      if (/SELECT version,status,is_active FROM business_versions/i.test(sql)) {
        return result<T>([{
          version: String(params[1] ?? '1.0.0'),
          status: 'ENABLED',
          is_active: true,
        }]);
      }
      if (/FROM tasks t JOIN operations o ON o\.id=t\.operation_id WHERE t\.id=\$1/i.test(sql)) {
        return result<T>([{ business_id: options.taskBusinessId ?? 'business-a' }]);
      }
      if (/FROM artifacts a JOIN operations o ON o\.id=a\.operation_id WHERE a\.id=\$1/i.test(sql)) {
        return result<T>([{ business_id: options.artifactBusinessId ?? 'business-a' }]);
      }
      if (/FROM artifacts a LEFT JOIN operations o ON o\.id=a\.operation_id/i.test(sql)) {
        return result<T>([{
          token: 'artifact-grant',
          tenant_id: TENANT_ID,
          token_mode: 'download',
          token_expires_at: new Date(Date.now() + 60_000).toISOString(),
          business_id: options.artifactBusinessId ?? 'business-a',
        }]);
      }
      if (/FROM maintenance_backup_effect_gate/i.test(sql)) {
        return result<T>([{ state: 'OPEN', fence_revision: 1 }]);
      }
      if (/INSERT INTO runtime_control_scopes/i.test(sql)) return result<T>([], 'INSERT');
      if (/SELECT scope_kind,scope_id,desired_state,revision/i.test(sql)) {
        return result<T>([
          { scope_kind: 'platform', scope_id: 'all', desired_state: 'OPEN', revision: 1 },
          { scope_kind: 'business', scope_id: 'business-a', desired_state: 'OPEN', revision: 1 },
        ]);
      }
      if (/FROM operations o WHERE o\.tenant_id::text=r\.scope_id/i.test(sql)) return result<T>([]);
      if (/FROM worker_instances WHERE business_id=\$1 AND instance_id=\$2 FOR UPDATE/i.test(sql)) return result<T>([]);
      if (/INSERT INTO worker_control_scope_acks/i.test(sql)) return result<T>([], 'INSERT');
      if (/INSERT INTO worker_instances/i.test(sql)) {
        return result<T>([{
          state: 'ONLINE', last_seen_at: new Date(), control_revision: 1, control_state: 'OPEN',
        }], 'INSERT');
      }
      throw new Error(`unexpected route-test SQL: ${sql}`);
  });
  const db = {
    query,
    tx: async <T>(work: (client: never) => Promise<T>) => work({ query } as never),
  };
  const runtime = {
    claimTask: jest.fn(async () => ({ taskId: TASK_ID, leaseEpoch: 1, executionSnapshot: {} })),
    heartbeatTask: jest.fn(async () => ({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), cancelRequested: false })),
    completeTask: jest.fn(async () => ({ taskId: TASK_ID, state: 'SUCCEEDED', operationState: 'SUCCEEDED', replayed: false })),
    saveStep: jest.fn(async () => ({ replayed: false })),
    reportProgress: jest.fn(async () => undefined),
    failTask: jest.fn(async () => ({})),
    spawnChildren: jest.fn(async () => ({})),
    getChildren: jest.fn(async () => ({ children: [] })),
    waitInput: jest.fn(async () => ({})),
    workspaceReferenceStatus: jest.fn(async () => ({ referenced: false, activeHolders: 0 })),
  };
  const registry = { registerVersion: jest.fn(async () => ({ created: true, version: '1.0.0' })) };
  const artifacts = {
    requestUpload: jest.fn(async () => ({})),
    finalize: jest.fn(async () => ({})),
    requestAccess: jest.fn(async () => ({})),
    getBlob: jest.fn(async () => Buffer.alloc(0)),
  };
  return {
    method: options.method ?? 'GET',
    pathname: options.pathname ?? '/api/runtime/v1/tasks/task-a/children',
    searchParams: new URLSearchParams(),
    headers: { authorization: options.authorization ?? 'Bearer worker-a-registration-token', 'x-api-key': 'client-key' },
    body: options.body ?? {},
    rawBody: Buffer.alloc(0),
    correlationId: 'br12-worker-scope-offline',
    host: 'localhost',
    db,
    redis: {} as never,
    registry,
    profiles: {} as never,
    audit: {} as never,
    submission: {} as never,
    runtime,
    usage: { getUsageSummary: jest.fn(), ingest: jest.fn() } as never,
    artifacts,
    grants: null,
    connectors: {} as never,
    lifecycle: {} as never,
    dispatcher: {} as never,
    getQueue: jest.fn() as never,
    queueIntegrity: () => undefined,
    credentialWorkflow: undefined,
    config: WORKER_CONFIG,
  } as unknown as RouteContext;
}

async function expectWorkerForbidden(ctx: RouteContext): Promise<void> {
  await expect(route(ctx)).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
}

describe('BR-12 offline business isolation', () => {
  it('rejects a forged claim businessId that differs from the authenticated worker token', () => {
    const config = {
      runtimeToken: 'platform-runtime-token',
      workerIdentityTokensByBusiness: {
        'business-a': 'worker-a-registration-token',
        'business-b': 'worker-b-registration-token',
      },
    };
    const claimTask = jest.fn();

    let denied: unknown;
    try {
      const authenticatedBusinessId = authorizeWorkerClaim(
        config,
        'Bearer worker-a-registration-token',
        'business-b'
      );
      claimTask(TASK_ID, authenticatedBusinessId);
    } catch (error) {
      denied = error;
    }

    expect(denied).toBeInstanceOf(HttpError);
    expect(denied).toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(claimTask).not.toHaveBeenCalled();
    expect(authorizeWorkerClaim(config, 'Bearer worker-b-registration-token', 'business-b')).toBe('business-b');
    expect(() => authorizeWorkerClaim(config, 'Bearer platform-runtime-token', 'business-a')).toThrow(HttpError);
  });

  it('routes a business-B task only to B queue, leaving a business-A worker with no claimable delivery', async () => {
    const outboxRow = {
      id: 'outbox-b-1',
      aggregate_id: TASK_ID,
      type: 'task.dispatch',
      delivery_id: 'delivery-b-1',
      payload: {
        contractVersion: '1',
        deliveryId: 'delivery-b-1',
        taskId: TASK_ID,
        operationId: OPERATION_ID,
        businessId: 'business-b',
        businessVersion: '1.0.0',
        action: 'extract',
        kind: 'root',
        correlationId: 'br12-business-b-001',
      },
      attempts: 0,
    };
    const capturedQueries: string[] = [];
    const published: Array<{ queueName: string; data: unknown }> = [];
    const txClient = {
        query: async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> => {
        capturedQueries.push(sql);
        if (/SELECT ob\.id,ob\.aggregate_id,ob\.delivery_id,ob\.type,ob\.payload,ob\.attempts/i.test(sql)) {
          return result<T>([{
            ...outboxRow,
            claim_token: params[1],
            business_id: params[2],
            business_version: params[3],
            tenant_id: params[4],
            queue_name: params[5],
          }]);
        }
        if (/INSERT INTO runtime_control_scopes/i.test(sql)) return result<T>([], 'INSERT');
        if (/SELECT scope_kind,scope_id,desired_state,revision/i.test(sql)) {
          return result<T>([
            { scope_kind: 'platform', scope_id: 'all', desired_state: 'OPEN', revision: 1 },
            { scope_kind: 'tenant', scope_id: TENANT_ID, desired_state: 'OPEN', revision: 1 },
            { scope_kind: 'business', scope_id: 'business-b', desired_state: 'OPEN', revision: 1 },
          ]);
        }
        if (/SELECT o\.tenant_id, o\.business_id, o\.business_version, bv\.queue/i.test(sql)) {
          return result<T>([{ business_id: 'business-b', business_version: '1.0.0', queue: null }]);
        }
        if (/FROM business_catalog WHERE business_id=\$1/i.test(sql)) {
          return result<T>([{
            enabled: true,
            activation_revision: 1,
            submissions_paused: false,
            pre_drain_version: null,
          }]);
        }
        if (/SELECT version,status,is_active FROM business_versions/i.test(sql)) {
          return result<T>([{ version: String(params[1] ?? '1.0.0'), status: 'ENABLED', is_active: true }]);
        }
        if (/UPDATE outbox SET claim_token=/i.test(sql)) return result<T>([], 'UPDATE');
        if (/UPDATE outbox SET dispatched_at/i.test(sql)) return result<T>([{ id: outboxRow.id }], 'UPDATE');
        throw new Error(`unexpected dispatcher SQL: ${sql}`);
      },
    };
    const db = {
      query: async <T extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<T>> => {
        if (/SELECT t\.id AS task_id,o\.business_id,o\.business_version/i.test(sql)) return result<T>([]);
        if (/SELECT ob\.id,ob\.aggregate_id,ob\.delivery_id,ob\.type,ob\.payload/i.test(sql)) {
          return result<T>([{
            ...outboxRow,
            business_id: 'business-b',
            business_version: '1.0.0',
            tenant_id: TENANT_ID,
            queue_name: businessQueueName('business-b', '1.0.0'),
          }]);
        }
        throw new Error(`unexpected dispatcher read SQL: ${sql}`);
      },
      tx: async <T>(fn: (client: never) => Promise<T>): Promise<T> => fn(txClient as never),
      close: async () => undefined,
    } as unknown as Db;
    const dispatcher = createDispatcher({
      db,
      getQueue: (queueName) => ({
        add: async (_name: string, data: unknown) => {
          published.push({ queueName, data });
          return {};
        },
      } as never),
    });

    await expect(dispatcher.dispatchOnce()).resolves.toBe(1);

    const queueA = businessQueueName('business-a', '1.0.0');
    const queueB = businessQueueName('business-b', '1.0.0');
    expect(published).toHaveLength(1);
    expect(published[0]?.queueName).toBe(queueB);
    expect(published[0]?.queueName).not.toBe(queueA);
    expect(published[0]?.data).toMatchObject({ businessId: 'business-b', taskId: TASK_ID });

    // The production worker subscribes to its manifest-derived queue. Model
    // that subscription boundary without constructing BullMQ or Redis.
    const workerAClaims: unknown[] = [];
    for (const delivery of published.filter((item) => item.queueName === queueA)) {
      workerAClaims.push(delivery.data);
    }
    expect(workerAClaims).toEqual([]);
    expect(capturedQueries.some((sql) => /FROM business_catalog WHERE business_id=\$1/i.test(sql))).toBe(true);
  });

  it('rejects a business-A worker claiming business-B before lease mutation or snapshot disclosure', async () => {
    const taskRow = {
      id: TASK_ID,
      operation_id: OPERATION_ID,
      tenant_id: TENANT_ID,
      business_id: 'business-b',
      business_version: '1.0.0',
      action: 'extract',
      input_ref: { text: 'synthetic input' },
      deadline_at: null,
      manifest_digest: 'sha256:business-b',
      profile_id: null,
      profile_revision: null,
      connector_bindings: {},
      state: 'READY',
      last_delivery_id: null,
      lease_expires_at: null,
      leased_by: null,
      lease_epoch: 0,
      attempt: 0,
      task_key: 'root',
      kind: 'root',
      payload_ref: {},
    };
    const claimQueries: Array<{ sql: string; params: unknown[] }> = [];
    const txClient = {
      query: async <T extends QueryResultRow = QueryResultRow>(
        sql: string,
        params: unknown[] = []
      ): Promise<QueryResult<T>> => {
        claimQueries.push({ sql, params });
        if (/SELECT o\.business_id,o\.business_version FROM tasks t/i.test(sql)) {
          return result<T>([{ business_id: 'business-b', business_version: '1.0.0' }]);
        }
        if (/FROM business_catalog WHERE business_id=\$1/i.test(sql)) {
          return result<T>([{
            enabled: true,
            activation_revision: 1,
            submissions_paused: false,
            pre_drain_version: null,
          }]);
        }
        if (/SELECT version,status,is_active FROM business_versions/i.test(sql)) {
          return result<T>([{ version: '1.0.0', status: 'ENABLED', is_active: true }]);
        }
        if (/SELECT t\.\*, o\.tenant_id, o\.business_id, o\.business_version/i.test(sql)) {
          return result<T>([taskRow]);
        }
        if (/SELECT state FROM operations WHERE id=\$1/i.test(sql)) {
          return result<T>([{ state: 'ACCEPTED' }]);
        }
        if (/SELECT step_key as "stepKey"/i.test(sql)) return result<T>([]);
        if (/UPDATE tasks SET lease_epoch/i.test(sql) || /UPDATE operations SET state='RUNNING'/i.test(sql)) {
          return result<T>([], 'UPDATE');
        }
        throw new Error(`unexpected claim SQL: ${sql}`);
      },
    };
    const db = {
      query: async () => { throw new Error('claim must use its supplied transaction client'); },
      tx: async <T>(fn: (client: never) => Promise<T>): Promise<T> => fn(txClient as never),
      close: async () => undefined,
    } as unknown as Db;
    const runtime = createRuntimeService(db);

    let denied: unknown;
    try {
      await runtime.claimTask(TASK_ID, 'delivery-b-2', 'worker-from-business-a', 'business-a');
    } catch (error) {
      denied = error;
    }

    expect(denied).toBeInstanceOf(HttpError);
    expect(denied).toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(denied).not.toHaveProperty('executionSnapshot');
    expect(claimQueries.find(({ sql }) => /SELECT t\.\*, o\.tenant_id/i.test(sql))?.params).toEqual([TASK_ID]);
    expect(claimQueries).toHaveLength(4);
    expect(claimQueries[0]?.sql).toMatch(/SELECT o\.business_id,o\.business_version FROM tasks/i);
    expect(claimQueries[1]?.sql).toMatch(/FROM business_catalog WHERE business_id=\$1 FOR SHARE/i);
    expect(claimQueries[2]?.sql).toMatch(/SELECT version,status,is_active FROM business_versions/i);
    expect(claimQueries[3]?.sql).toMatch(/SELECT t\.\*, o\.tenant_id/i);
    expect(claimQueries.some(({ sql }) => /UPDATE (tasks|operations)/i.test(sql))).toBe(false);
  });

  it('rejects cross-business binding use before creating an operation, task, or outbox row', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const tx = jest.fn(async () => {
      throw new Error('unauthorized cross-business submit must fail before opening a transaction');
    });
    const db = {
      query: async <T extends QueryResultRow = QueryResultRow>(
        sql: string,
        params: unknown[] = []
      ): Promise<QueryResult<T>> => {
        queries.push({ sql, params });
        if (/FROM business_catalog WHERE business_id=\$1/i.test(sql)) {
          return result<T>([{
            enabled: true,
            activation_revision: 1,
            submissions_paused: false,
            pre_drain_version: null,
          }]);
        }
        if (/SELECT version,status,is_active FROM business_versions/i.test(sql)) {
          return result<T>([{
            version: '1.0.0',
            status: 'ENABLED',
            is_active: true,
            // BR12-FIX: the action fixture must carry inputSchema — the
            // manifest contract REQUIRES it (ActionManifestSchema, validated
            // before registration) and the admission seam reads it
            // (declaredParameterKeys at submission.ts:255). Without it the
            // seam TypeErrors before the cross-business denial under test.
            manifest: { actions: [{ name: 'extract', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] },
            digest: 'sha256:test',
            queue: 'du-business-business-b-1.0.0',
          }]);
        }
        if (/FROM business_versions/i.test(sql)) {
          return result<T>([{
            version: '1.0.0',
            manifest: { actions: [{ name: 'extract', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] },
            digest: 'sha256:test',
            queue: 'du-business-business-b-1.0.0',
            status: 'ENABLED',
          }]);
        }
        if (/SELECT p\.profile_id, p\.revision, p\.connector_bindings/i.test(sql)) {
          // No active-row hit for (key, business-b, version, action): the
          // key's bindings exist for a FOREIGN business only.
          return result<T>([]);
        }
        if (/SELECT 1 FROM profile_api_keys m/i.test(sql)) {
          // BR12-FIX: selectActiveRow's pointer-cross-check step — no row for
          // business-b either (so this is 'not-authorized', not 'pointer-missing').
          return result<T>([]);
        }
        // PC-04/PC-05: the admission seam reads the explicit key mode before it
        // decides between the group-grant and legacy standalone resolvers.
        if (/FROM api_keys WHERE id=\$1/i.test(sql)) {
          return result<T>([{ id: API_KEY_ID, tenant_id: TENANT_ID, status: 'ACTIVE', key_mode: 'LEGACY_STANDALONE' }]);
        }
        throw new Error(`unexpected profile/submission SQL: ${sql}`);
      },
      tx,
      close: async () => undefined,
    } as unknown as Db;
    const profiles = createProfileService(db);
    const submission = createSubmissionService(db, {} as RegistryService, profiles);

    let denied: unknown;
    try {
      await submission.submit({
        tenantId: TENANT_ID,
        apiKeyId: API_KEY_ID,
        businessId: 'business-b',
        action: 'extract',
        correlationId: 'br12-cross-business-001',
        submission: { input: { text: 'synthetic input' } },
      });
    } catch (error) {
      denied = error;
    }

    expect(denied).toBeInstanceOf(HttpError);
    expect(denied).toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(queries.find(({ sql }) => /SELECT p\.profile_id/i.test(sql))?.params)
      .toEqual([API_KEY_ID, 'business-b', '1.0.0', 'extract', null]);
    // selectActiveRow's pointer cross-check (business-b has no bindings)…
    expect(queries.find(({ sql }) => /SELECT 1 FROM profile_api_keys m/i.test(sql))?.params)
      .toEqual([API_KEY_ID, 'business-b', '1.0.0', 'extract', null]);
    // …and PC-R01 denies right there: a LEGACY_STANDALONE key never falls back to
    // the any-binding heuristic (that probe belongs to UNMANAGED_LEGACY keys with
    // no membership at all), so the FOREIGN business-a binding the key does hold
    // is never consulted for entitlement.
    expect(queries.some(({ sql }) => /SELECT 1 FROM profile_api_keys WHERE api_key_id/i.test(sql))).toBe(false);
    expect(tx).not.toHaveBeenCalled();
    expect(queries.some(({ sql }) => /INSERT INTO (operations|tasks|outbox)/i.test(sql))).toBe(false);
  });

  it.each([
    ['admin API', 'GET', '/api/v1/admin/actions'],
    ['public operations API', 'GET', '/api/v1/operations'],
    ['public usage API', 'GET', '/api/v1/usage'],
  ])('rejects a worker bearer at the %s before touching public/admin services', async (_name, method, pathname) => {
    const ctx = routeContext({ method, pathname });

    await expectWorkerForbidden(ctx);

    expect(ctx.db.query).not.toHaveBeenCalled();
    expect((ctx.usage as unknown as { getUsageSummary: jest.Mock }).getUsageSummary).not.toHaveBeenCalled();
  });

  it('rejects worker identity from Connector usage ingestion even though it is under the runtime URL prefix', async () => {
    const ctx = routeContext({
      method: 'POST',
      pathname: '/api/runtime/v1/usage-events',
      body: { units: 1 },
    });

    await expectWorkerForbidden(ctx);

    expect((ctx.usage as unknown as { ingest: jest.Mock }).ingest).not.toHaveBeenCalled();
  });

  it('allows scoped worker self-registration only for matching URL/body business coordinates', async () => {
    const manifest = {
      contractVersion: '1',
      businessId: 'business-a',
      version: '1.0.0',
      displayName: 'Business A',
      imageDigest: 'sha256:' + 'a'.repeat(64),
      runtime: { wireVersion: '1', handlerKinds: ['root'] },
      capabilities: { cancel: true, resume: true, parallel: true },
      actions: [{
        name: 'extract', displayName: 'Extract', inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
        profileSchema: { type: 'object' }, artifactPolicy: { minFiles: 0, maxFiles: 1 },
        capabilities: { cancel: true, resume: true }, defaultLimits: {},
      }],
    };
    const workerContext = routeContext({
      method: 'PUT',
      pathname: '/api/runtime/v1/businesses/business-a/versions/1.0.0',
      body: manifest,
    });

    await expect(route(workerContext)).resolves.toMatchObject({ status: 201 });
    expect(workerContext.registry.registerVersion).toHaveBeenCalledWith(expect.objectContaining({
      businessId: manifest.businessId,
      version: manifest.version,
      actions: [expect.objectContaining({ name: 'extract', connectorSlots: [] })],
    }));

    const wrongBusiness = routeContext({
      method: 'PUT',
      pathname: '/api/runtime/v1/businesses/business-b/versions/1.0.0',
      body: manifest,
    });
    await expect(route(wrongBusiness)).rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(wrongBusiness.registry.registerVersion).not.toHaveBeenCalled();

    const wrongWorker = routeContext({
      method: 'PUT',
      pathname: '/api/runtime/v1/businesses/business-b/versions/1.0.0',
      authorization: 'Bearer worker-a-registration-token',
      body: { ...manifest, businessId: 'business-b' },
    });
    await expect(route(wrongWorker)).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(wrongWorker.registry.registerVersion).not.toHaveBeenCalled();

    const malformed = routeContext({
      method: 'PUT',
      pathname: '/api/runtime/v1/businesses/business-a/versions/1.0.0',
      body: { businessId: 'business-a', version: '1.0.0' },
    });
    await expect(route(malformed)).rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(malformed.registry.registerVersion).not.toHaveBeenCalled();

    const unauthorized = routeContext({
      method: 'PUT',
      pathname: '/api/runtime/v1/businesses/business-a/versions/1.0.0',
      authorization: 'Bearer not-a-runtime-token',
      body: manifest,
    });
    await expect(route(unauthorized)).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(unauthorized.registry.registerVersion).not.toHaveBeenCalled();

    const platformContext = routeContext({
      method: 'PUT',
      pathname: '/api/runtime/v1/businesses/business-a/versions/1.0.0',
      authorization: 'Bearer platform-runtime-token',
      body: manifest,
    });
    await expect(route(platformContext)).resolves.toMatchObject({ status: 201 });
    expect(platformContext.registry.registerVersion).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['claim', 'POST', `/api/runtime/v1/tasks/${TASK_ID}/claim`, { deliveryId: 'delivery-b', workerInstanceId: 'worker-a-1', businessId: 'business-a' }],
    ['heartbeat', 'POST', `/api/runtime/v1/tasks/${TASK_ID}/heartbeat`, { leaseEpoch: 1 }],
    ['complete', 'POST', `/api/runtime/v1/tasks/${TASK_ID}/complete`, { leaseEpoch: 1, resultRef: 'synthetic', resultHash: 'unused' }],
    ['child read', 'GET', `/api/runtime/v1/tasks/${TASK_ID}/children`, {}],
  ])('blocks business-A worker from %s on a business-B task before runtime mutation or data return', async (_name, method, pathname, body) => {
    const ctx = routeContext({ method, pathname, body, taskBusinessId: 'business-b' });

    await expectWorkerForbidden(ctx);

    expect(ctx.db.query).toHaveBeenCalledTimes(1);
    expect(ctx.runtime.claimTask).not.toHaveBeenCalled();
    expect(ctx.runtime.heartbeatTask).not.toHaveBeenCalled();
    expect(ctx.runtime.completeTask).not.toHaveBeenCalled();
    expect(ctx.runtime.getChildren).not.toHaveBeenCalled();
  });

  it('scopes the remaining task runtime routes and artifact grants to the worker business', async () => {
    const taskRoutes: Array<{ method: string; pathname: string; body: unknown }> = [
      { method: 'PUT', pathname: `/api/runtime/v1/tasks/${TASK_ID}/steps/step-1`, body: {} },
      { method: 'POST', pathname: `/api/runtime/v1/tasks/${TASK_ID}/progress`, body: {} },
      { method: 'POST', pathname: `/api/runtime/v1/tasks/${TASK_ID}/fail`, body: {} },
      { method: 'POST', pathname: `/api/runtime/v1/tasks/${TASK_ID}/children`, body: {} },
      { method: 'POST', pathname: `/api/runtime/v1/tasks/${TASK_ID}/wait-input`, body: {} },
      { method: 'POST', pathname: `/api/runtime/v1/tasks/${TASK_ID}/artifacts`, body: { leaseEpoch: 1 } },
    ];

    for (const request of taskRoutes) {
      const ctx = routeContext({ ...request, taskBusinessId: 'business-b' });
      await expectWorkerForbidden(ctx);
      expect(ctx.db.query).toHaveBeenCalledTimes(1);
      expect(ctx.runtime.saveStep).not.toHaveBeenCalled();
      expect(ctx.runtime.reportProgress).not.toHaveBeenCalled();
      expect(ctx.runtime.failTask).not.toHaveBeenCalled();
      expect(ctx.runtime.spawnChildren).not.toHaveBeenCalled();
      expect(ctx.runtime.waitInput).not.toHaveBeenCalled();
      expect(ctx.artifacts.requestUpload).not.toHaveBeenCalled();
    }
  });

  it('rejects cross-business artifact operations and mismatched body task IDs before grant mutation', async () => {
    const foreignArtifact = routeContext({
      method: 'POST',
      pathname: '/api/runtime/v1/artifacts/artifact-b/finalize',
      artifactBusinessId: 'business-b',
      body: { taskId: TASK_ID },
    });
    await expectWorkerForbidden(foreignArtifact);
    expect(foreignArtifact.artifacts.finalize).not.toHaveBeenCalled();

    const foreignTask = routeContext({
      method: 'POST',
      pathname: '/api/runtime/v1/artifacts/artifact-a/access',
      artifactBusinessId: 'business-a',
      taskBusinessId: 'business-b',
      body: { taskId: TASK_ID },
    });
    await expectWorkerForbidden(foreignTask);
    expect(foreignTask.artifacts.requestAccess).not.toHaveBeenCalled();

    const foreignBlob = routeContext({
      method: 'GET',
      pathname: '/api/runtime/v1/artifacts/blob/storage-key-b',
      artifactBusinessId: 'business-b',
    });
    await expectWorkerForbidden(foreignBlob);
    expect(foreignBlob.artifacts.getBlob).not.toHaveBeenCalled();
  });

  it('allows the authenticated worker to claim, heartbeat, complete, and read children for its own business task', async () => {
    const claim = routeContext({
      method: 'POST',
      pathname: `/api/runtime/v1/tasks/${TASK_ID}/claim`,
      body: { deliveryId: 'delivery-a', workerInstanceId: 'worker-a-1', businessId: 'business-a' },
    });
    await expect(route(claim)).resolves.toMatchObject({ status: 200 });
    expect(claim.runtime.claimTask).toHaveBeenCalledWith(TASK_ID, 'delivery-a', 'worker-a-1', 'business-a');

    const heartbeat = routeContext({
      method: 'POST',
      pathname: `/api/runtime/v1/tasks/${TASK_ID}/heartbeat`,
      body: { leaseEpoch: 1 },
    });
    await expect(route(heartbeat)).resolves.toMatchObject({ status: 200 });
    expect(heartbeat.runtime.heartbeatTask).toHaveBeenCalledWith(TASK_ID, 1, 'business-a');

    const complete = routeContext({
      method: 'POST',
      pathname: `/api/runtime/v1/tasks/${TASK_ID}/complete`,
      body: { leaseEpoch: 1, resultRef: 'synthetic', resultHash: 'unused' },
    });
    await expect(route(complete)).resolves.toMatchObject({ status: 200 });
    expect(complete.runtime.completeTask).toHaveBeenCalledWith(
      TASK_ID,
      { leaseEpoch: 1, resultRef: 'synthetic', resultHash: 'unused' },
      'business-a'
    );

    const children = routeContext({ method: 'GET', pathname: `/api/runtime/v1/tasks/${TASK_ID}/children` });
    await expect(route(children)).resolves.toMatchObject({ status: 200, body: { children: [] } });
    expect(children.runtime.getChildren).toHaveBeenCalledWith(TASK_ID);
  });

  it('binds worker-instance heartbeat identity to the token business', async () => {
    const forgedHeartbeat = routeContext({
      method: 'PUT',
      pathname: '/api/runtime/v1/workers/worker-a-1/heartbeat',
      body: { businessId: 'business-b' },
    });
    await expectWorkerForbidden(forgedHeartbeat);

    const ownHeartbeat = routeContext({
      method: 'PUT',
      pathname: '/api/runtime/v1/workers/worker-a-1/heartbeat',
      body: {
        businessId: 'business-a',
        businessVersion: '1.0.0',
        imageDigest: 'sha256:test',
        capacity: 1,
      },
    });
    await expect(route(ownHeartbeat)).resolves.toMatchObject({ status: 200, body: { health: 'HEALTHY' } });
    const heartbeatWrite = (ownHeartbeat.db.query as jest.Mock).mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO worker_instances'));
    expect(heartbeatWrite?.[1]).toEqual([
      'business-a', 'worker-a-1', '1.0.0', 1, 'ONLINE', 1, 'OPEN', 'sha256:test', null, null, null, null,
    ]);
  });

  it('limits workspace reference lookup to the authenticated worker business', async () => {
    const ctx = routeContext({
      method: 'GET',
      pathname: '/api/runtime/v1/workspace-reference',
    });
    ctx.searchParams.set('workspacePath', 'C:\\worker\\workspace');
    ctx.searchParams.set('tenantId', TENANT_ID);

    await expect(route(ctx)).resolves.toMatchObject({ status: 200, body: { referenced: false } });
    expect(ctx.runtime.workspaceReferenceStatus).toHaveBeenCalledWith(TENANT_ID, 'business-a');
  });
});
