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
  const db = {
    query: jest.fn(async <T extends QueryResultRow = QueryResultRow>(sql: string) => {
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
      throw new Error(`unexpected route-test SQL: ${sql}`);
    }),
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
      query: async <T extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<T>> => {
        capturedQueries.push(sql);
        if (/SELECT id, aggregate_id, type, delivery_id, payload, attempts\s+FROM outbox/i.test(sql)) {
          return result<T>([outboxRow]);
        }
        if (/SELECT o\.business_id, o\.business_version, bv\.queue/i.test(sql)) {
          return result<T>([{ business_id: 'business-b', business_version: '1.0.0', queue: null }]);
        }
        if (/UPDATE outbox SET dispatched_at/i.test(sql)) return result<T>([], 'UPDATE');
        throw new Error(`unexpected dispatcher SQL: ${sql}`);
      },
    };
    const db = {
      query: async () => { throw new Error('dispatcher must use only its supplied transaction client'); },
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
    expect(capturedQueries).toHaveLength(3);
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
    expect(claimQueries.some(({ sql }) => /UPDATE (tasks|operations)/i.test(sql))).toBe(false);
    expect(claimQueries).toHaveLength(1);
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
        if (/FROM business_versions\s+WHERE business_id=\$1 AND is_active=true/i.test(sql)) {
          return result<T>([{
            version: '1.0.0',
            manifest: { actions: [{ name: 'extract' }] },
            digest: 'sha256:test',
            queue: 'du-business-business-b-1.0.0',
          }]);
        }
        if (/SELECT profile_id, revision, connector_bindings FROM profile_bindings/i.test(sql)) {
          return result<T>([]);
        }
        if (/SELECT 1 FROM profile_bindings WHERE api_key_id=\$1 LIMIT 1/i.test(sql)) {
          return result<T>([{ '?column?': 1 }]);
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
    expect(queries[1]?.params).toEqual([API_KEY_ID, 'business-b', '1.0.0', 'extract']);
    expect(queries[2]?.params).toEqual([API_KEY_ID]);
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

  it('keeps business version registration platform-only while allowing the platform runtime bearer', async () => {
    const workerContext = routeContext({
      method: 'PUT',
      pathname: '/api/runtime/v1/businesses/business-b/versions/1.0.0',
      body: { businessId: 'business-b', version: '1.0.0' },
    });

    await expectWorkerForbidden(workerContext);
    expect(workerContext.registry.registerVersion).not.toHaveBeenCalled();

    const platformContext = routeContext({
      method: 'PUT',
      pathname: '/api/runtime/v1/businesses/business-b/versions/1.0.0',
      authorization: 'Bearer platform-runtime-token',
      body: { businessId: 'business-b', version: '1.0.0' },
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
      body: { businessId: 'business-a' },
    });
    await expect(route(ownHeartbeat)).resolves.toMatchObject({ status: 200, body: { health: 'HEALTHY' } });
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
