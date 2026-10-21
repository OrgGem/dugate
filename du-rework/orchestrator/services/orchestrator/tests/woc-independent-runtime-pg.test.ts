import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import { businessQueueName, jobIdForDelivery, type BusinessManifest } from '@du/contracts';
import { defineBusiness, startWorker } from '@du/worker-sdk';
import type { WorkerHandle } from '@du/worker-sdk';
import { createApp, type App } from '../src/server';
import {
  assertSafeIsolationConfig,
  createTestIsolationContext,
  generateSchemaSetupDdl,
  generateSchemaTeardownDdl,
  type TestIsolationContext,
} from '../../../../tests/isolation/namespace';

const LIVE = process.env.DU_LIVE_INFRA === '1' && process.env.VFY_WOC_LIVE === '1';
const liveDescribe: typeof describe = LIVE ? describe : describe.skip;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function makeManifest(businessId: string, version: string): BusinessManifest {
  return {
    contractVersion: '1',
    businessId,
    version,
    displayName: 'WOC independent runtime verification',
    description: 'Disposable service-level runtime verification fixture',
    imageDigest: `sha256:${'c'.repeat(64)}`,
    runtime: { wireVersion: '1', handlerKinds: ['root'] },
    capabilities: { cancel: true, resume: true, parallel: true },
    actions: [{
      name: 'extract',
      displayName: 'Extract',
      description: 'Verification action',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      profileSchema: { type: 'object' },
      connectorSlots: [],
      artifactPolicy: { minFiles: 0, maxFiles: 1 },
      capabilities: { cancel: true, resume: true },
      defaultLimits: { maxParallelTasks: 1 },
    }],
  };
}

liveDescribe('WOC independent real PostgreSQL + Redis runtime/worker invariants', () => {
  let isolation: TestIsolationContext | undefined;
  let appA: App | undefined;
  let appB: App | undefined;
  let appAUrl: string;
  let appBUrl: string;
  let appAInternalUrl: string;
  let appBInternalUrl: string;
  let businessId: string;
  let tenantId: string;
  let runtimeToken: string;
  let workerToken: string;
  let rawApiKey: string;
  let keyId: string;
  let manifestV1: BusinessManifest;
  let manifestV2: BusinessManifest;
  let workers: WorkerHandle[] = [];
  let queues: Queue[] = [];
  let v2HandlerInvocations = 0;
  let v2WorkerInstanceId: string | undefined;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    const redisUrl = process.env.REDIS_URL;
    if (!databaseUrl || !redisUrl || !process.env.TEST_RUN_ID || !process.env.TEST_REDIS_PORT) {
      throw new Error('live WOC runtime tests require DATABASE_URL, REDIS_URL, TEST_RUN_ID and TEST_REDIS_PORT');
    }
    isolation = createTestIsolationContext({
      runId: process.env.TEST_RUN_ID,
      redisDbIndex: 2,
      baseArtifactPath: join(tmpdir(), 'du-vfy-woc-runtime-artifacts'),
    });
    const isolatedDatabaseUrl = isolation.getDatabaseUrlWithSchema(databaseUrl);
    assertSafeIsolationConfig({ databaseUrl: isolatedDatabaseUrl, redisUrl, isolationCtx: isolation });
    const parsedDb = new URL(databaseUrl);
    const parsedRedis = new URL(redisUrl);
    if (parsedDb.hostname !== '127.0.0.1' || !parsedDb.pathname.endsWith('_test')) {
      throw new Error('WOC runtime tests require the explicitly owned loopback *_test PostgreSQL database');
    }
    if (parsedRedis.hostname !== '127.0.0.1' || parsedRedis.port !== process.env.TEST_REDIS_PORT || parsedRedis.pathname === '/0') {
      throw new Error('WOC runtime tests require the explicitly owned loopback disposable Redis database');
    }

    const adminPool = new Pool({ connectionString: databaseUrl });
    try {
      await adminPool.query(generateSchemaSetupDdl(isolation.dbSchema));
    } finally {
      await adminPool.end();
    }

    businessId = `woc-vfy-runtime-${randomUUID().slice(0, 8)}`;
    tenantId = isolation.tenantId;
    runtimeToken = `vfy-platform-runtime-${randomUUID()}`;
    workerToken = `vfy-shared-business-worker-${randomUUID()}`;
    rawApiKey = `du_vfy_runtime_${randomUUID().replaceAll('-', '')}`;
    keyId = randomUUID();
    manifestV1 = makeManifest(businessId, '1.0.0');
    manifestV2 = makeManifest(businessId, '2.0.0');

    const common = {
      port: 0,
      host: '127.0.0.1',
      internalPort: 0,
      internalHost: '127.0.0.1',
      databaseUrl: isolatedDatabaseUrl,
      redisUrl,
      runtimeToken,
      // The same existing business-scoped identity map is deliberately shared by
      // both versions and both replicas, matching current deployment mapping.
      workerIdentityTokensByBusiness: { [businessId]: workerToken },
      adminToken: `vfy-admin-${randomUUID()}`,
      invocationGrantSecret: `vfy-grant-${randomUUID()}`,
      autoDispatch: false,
      leaseRecoveryIntervalMs: 0,
      encryptionPolicy: {
        dataMode: 'synthetic' as const,
        metadataEncryption: false,
        publicUploadEncryption: false,
        metadataPlaintextReadMode: 'none' as const,
        profileCipherKeyPresent: false,
      },
    };
    appA = await createApp({ ...common, autoMigrate: true });
    appB = await createApp({ ...common, autoMigrate: false });
    const serverA = await appA.listen();
    const serverB = await appB.listen();
    appAUrl = `http://127.0.0.1:${(serverA.address() as { port: number }).port}`;
    appBUrl = `http://127.0.0.1:${(serverB.address() as { port: number }).port}`;
    appAInternalUrl = `http://127.0.0.1:${(appA.internalServer.address() as { port: number }).port}`;
    appBInternalUrl = `http://127.0.0.1:${(appB.internalServer.address() as { port: number }).port}`;

    await appA.db.query(
      `INSERT INTO tenants (id,name) VALUES ($1,'WOC independent runtime verifier') ON CONFLICT (id) DO NOTHING`,
      [tenantId],
    );
    const hash = createHash('sha256').update(rawApiKey).digest('hex');
    await appA.db.query(
      `INSERT INTO api_keys (id,tenant_id,hash,prefix,status, key_mode) VALUES ($1,$2,$3,'vfy_runtime','ACTIVE', 'LEGACY_STANDALONE')`,
      [keyId, tenantId, hash],
    );
  }, 60_000);

  afterAll(async () => {
    for (const worker of workers.splice(0).reverse()) await worker.stop(2_000).catch(() => undefined);
    for (const queue of queues.splice(0)) {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close().catch(() => undefined);
    }
    await appB?.close({ timeoutMs: 1_000, pollIntervalMs: 50 }).catch(() => undefined);
    await appA?.close({ timeoutMs: 1_000, pollIntervalMs: 50 }).catch(() => undefined);
    if (isolation && process.env.PRESERVE_TEST_SCHEMA !== 'true') {
      const databaseUrl = process.env.DATABASE_URL;
      if (databaseUrl) {
        const adminPool = new Pool({ connectionString: databaseUrl });
        try {
          await adminPool.query(generateSchemaTeardownDdl(isolation.dbSchema));
        } finally {
          await adminPool.end();
        }
      }
    }
    isolation?.cleanupArtifactDir();
  }, 45_000);

  async function submit(label: string): Promise<{ operationId: string; taskId: string }> {
    const response = await fetch(`${appAUrl}/api/v1/businesses/${businessId}/actions/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': rawApiKey },
      body: JSON.stringify({ input: { label } }),
    });
    const body = await response.json() as { operationId?: string; code?: string };
    expect(response.status).toBe(202);
    expect(body.operationId).toBeTruthy();
    const task = await appA!.db.query<{ id: string }>(
      'SELECT id FROM tasks WHERE operation_id=$1 AND task_key=$2',
      [body.operationId, 'root'],
    );
    expect(task.rowCount).toBe(1);
    return { operationId: body.operationId!, taskId: task.rows[0]!.id };
  }

  async function waitUntilTerminal(taskIds: string[]): Promise<void> {
    await waitFor(async () => {
      const result = await appA!.db.query<{ state: string }>(
        'SELECT state FROM tasks WHERE id=ANY($1::uuid[])', [taskIds],
      );
      return result.rowCount === taskIds.length && result.rows.every((row) => row.state === 'SUCCEEDED');
    }, 20_000, 'all accepted worker tasks to finish');
  }

  function verificationQueue(name: string): Queue {
    const existing = queues.find((queue) => queue.name === name);
    if (existing) return existing;
    const queue = new Queue(name, { connection: { url: process.env.REDIS_URL! } });
    queues.push(queue);
    return queue;
  }

  it('routes pinned v1/v2 work to distinct queues across two runtime replicas and counts each accepted claim once', async () => {
    const regV1 = await appA!.registry.registerVersion(manifestV1);
    const root = await appA!.db.query<{ lifecycle_revision: number | string }>(
      'SELECT lifecycle_revision FROM business_catalog WHERE business_id=$1', [businessId],
    );
    await appA!.registry.setBusinessEnabled(businessId, true, Number(root.rows[0]!.lifecycle_revision));
    await appA!.enableVersionForTest(businessId, '1.0.0');

    const firstV1 = await submit('v1-one');
    const secondV1 = await submit('v1-two');
    expect(await appA!.dispatcher.dispatchOnce()).toBe(2);
    expect(regV1.queue).toBe(businessQueueName(businessId, '1.0.0'));

    const regV2 = await appA!.registry.registerVersion(manifestV2);
    await appA!.enableVersionForTest(businessId, '2.0.0');
    const v2 = await submit('v2-one');
    expect(await appB!.dispatcher.dispatchOnce()).toBe(1);
    expect(regV2.queue).toBe(businessQueueName(businessId, '2.0.0'));
    expect(regV2.queue).not.toBe(regV1.queue);

    const queueV1 = verificationQueue(regV1.queue);
    const queueV2 = verificationQueue(regV2.queue);
    const jobsV1 = await queueV1.getJobs(['waiting', 'prioritized']);
    const jobsV2 = await queueV2.getJobs(['waiting', 'prioritized']);
    const countsV1 = await queueV1.getJobCounts('waiting', 'prioritized', 'active', 'delayed', 'completed', 'failed', 'paused', 'waiting-children');
    const countsV2 = await queueV2.getJobCounts('waiting', 'prioritized', 'active', 'delayed', 'completed', 'failed', 'paused', 'waiting-children');
    const dispatchedRows = await appA!.db.query<{ business_version: string; queue: string; dispatched: boolean }>(
      `SELECT o.business_version,bv.queue,(x.dispatched_at IS NOT NULL) AS dispatched
         FROM operations o JOIN business_versions bv ON bv.business_id=o.business_id AND bv.version=o.business_version
         JOIN tasks t ON t.operation_id=o.id JOIN outbox x ON x.aggregate_id=t.id AND x.type='task.dispatch'
        WHERE o.business_id=$1 ORDER BY o.created_at`, [businessId],
    );
    console.info(`[VFY-WOC] queue observation=${JSON.stringify({ v1: countsV1, v2: countsV2, outbox: dispatchedRows.rows })}`);
    expect(jobsV1.map((job) => (job.data as { taskId: string }).taskId).sort())
      .toEqual([firstV1.taskId, secondV1.taskId].sort());
    expect(jobsV2.map((job) => (job.data as { taskId: string }).taskId)).toEqual([v2.taskId]);

    const v1Started: string[] = [];
    const releaseV1 = deferred();
    const v1Handler = async (ctx: { taskId: string }) => {
      v1Started.push(ctx.taskId);
      if (v1Started.length === 2) releaseV1.resolve();
      await releaseV1.promise;
      return { kind: 'completed' as const, resultRef: `vfy:${ctx.taskId}` };
    };
    let v2Started = 0;
    const v2Handler = async (ctx: { taskId: string }) => {
      v2Started += 1;
      v2HandlerInvocations += 1;
      return { kind: 'completed' as const, resultRef: `vfy:${ctx.taskId}` };
    };
    const definitionV1 = defineBusiness(manifestV1, { root: v1Handler });
    const definitionV2 = defineBusiness(manifestV2, { root: v2Handler });
    const workerConfig = (runtimeUrl: string, workerInstanceId: string) => ({
      runtimeUrl: `${runtimeUrl}/api/runtime/v1`,
      runtimeToken: workerToken,
      redis: { url: process.env.REDIS_URL! },
      workerInstanceId,
      concurrency: 1,
      heartbeatIntervalMs: 100,
      leaseSafetyMarginMs: 25,
      tempSweep: { enabled: false },
    });
    const v1WorkerAId = `vfy-v1-a-${randomUUID()}`;
    const v1WorkerBId = `vfy-v1-b-${randomUUID()}`;
    const v2WorkerId = `vfy-v2-${randomUUID()}`;
    v2WorkerInstanceId = v2WorkerId;
    workers.push(
      await startWorker(definitionV1, workerConfig(appAInternalUrl, v1WorkerAId)),
      await startWorker(definitionV1, workerConfig(appBInternalUrl, v1WorkerBId)),
      await startWorker(definitionV2, workerConfig(appBInternalUrl, v2WorkerId)),
    );

    await waitUntilTerminal([firstV1.taskId, secondV1.taskId, v2.taskId]);
    expect(v1Started.sort()).toEqual([firstV1.taskId, secondV1.taskId].sort());
    expect(v2Started).toBe(1);

    const counts = await appA!.db.query<{
      instance_id: string;
      business_version: string;
      accepted_task_count: number | string;
    }>(
      `SELECT instance_id,business_version,accepted_task_count FROM worker_instances
        WHERE business_id=$1 AND instance_id=ANY($2::text[]) ORDER BY instance_id`,
      [businessId, [v1WorkerAId, v1WorkerBId, v2WorkerId]],
    );
    expect(counts.rows).toHaveLength(3);
    expect(counts.rows.map((row) => Number(row.accepted_task_count)).sort((a, b) => a - b)).toEqual([1, 1, 1]);
    expect(counts.rows.map((row) => row.business_version).sort()).toEqual(['1.0.0', '1.0.0', '2.0.0']);
    const operationPins = await appA!.db.query<{ business_version: string; count: string }>(
      `SELECT business_version,count(*)::text AS count FROM operations
        WHERE id=ANY($1::uuid[]) GROUP BY business_version`,
      [[firstV1.operationId, secondV1.operationId, v2.operationId]],
    );
    expect(operationPins.rows).toEqual(expect.arrayContaining([
      { business_version: '1.0.0', count: '2' },
      { business_version: '2.0.0', count: '1' },
    ]));
  }, 60_000);

  it('keeps disabled business backlog un-dispatched and unclaimed, then accepts it once after CAS re-enable', async () => {
    const pending = await submit('disabled-backlog');
    const delivery = await appA!.db.query<{ delivery_id: string }>(
      `SELECT delivery_id FROM outbox WHERE aggregate_id=$1 AND type='task.dispatch'`, [pending.taskId],
    );
    expect(delivery.rowCount).toBe(1);

    const root = await appA!.db.query<{ lifecycle_revision: number | string }>(
      'SELECT lifecycle_revision FROM business_catalog WHERE business_id=$1', [businessId],
    );
    const disabled = await appB!.registry.setBusinessEnabled(
      businessId, false, Number(root.rows[0]!.lifecycle_revision),
    );
    expect(disabled.enabled).toBe(false);
    expect(await appA!.dispatcher.dispatchOnce()).toBe(0);

    const before = await appA!.db.query<{ state: string; lease_epoch: number; attempt: number }>(
      'SELECT state,lease_epoch,attempt FROM tasks WHERE id=$1', [pending.taskId],
    );
    expect(before.rows[0]).toMatchObject({ state: 'READY', lease_epoch: 0, attempt: 0 });
    const row = await appA!.db.query<{ dispatched_at: Date | null }>(
      'SELECT dispatched_at FROM outbox WHERE aggregate_id=$1 AND type=\'task.dispatch\'', [pending.taskId],
    );
    expect(row.rows[0]?.dispatched_at).toBeNull();
    const queueV2 = verificationQueue(businessQueueName(businessId, '2.0.0'));
    expect(await queueV2.getJobs(['waiting', 'prioritized', 'delayed', 'active'])).toHaveLength(0);

    expect(v2WorkerInstanceId).toBeTruthy();
    const claimResponse = await fetch(`${appBInternalUrl}/api/runtime/v1/tasks/${pending.taskId}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workerToken}` },
      body: JSON.stringify({
        deliveryId: delivery.rows[0]!.delivery_id,
        workerInstanceId: v2WorkerInstanceId!,
        businessId,
      }),
    });
    const claimBody = await claimResponse.json() as { code?: string };
    expect(claimResponse.status).toBe(409);
    expect(claimBody.code).toBe('BUSINESS_DISABLED');
    const afterDeniedClaim = await appA!.db.query<{ state: string; lease_epoch: number; attempt: number }>(
      'SELECT state,lease_epoch,attempt FROM tasks WHERE id=$1', [pending.taskId],
    );
    expect(afterDeniedClaim.rows[0]).toMatchObject({ state: 'READY', lease_epoch: 0, attempt: 0 });

    const reenabled = await appA!.registry.setBusinessEnabled(
      businessId, true, disabled.lifecycleRevision,
    );
    expect(reenabled.enabled).toBe(true);
    let redispatched = 0;
    await waitFor(async () => {
      redispatched = await appB!.dispatcher.dispatchOnce();
      return redispatched > 0;
    }, 8_000, 'disabled backlog dispatch after the pause claim expires');
    expect(redispatched).toBe(1);
    await waitUntilTerminal([pending.taskId]);
    expect(v2HandlerInvocations).toBe(2);
    const accepted = await appA!.db.query<{ accepted_task_count: number | string }>(
      'SELECT accepted_task_count FROM worker_instances WHERE business_id=$1 AND business_version=$2',
      [businessId, '2.0.0'],
    );
    expect(Number(accepted.rows[0]?.accepted_task_count)).toBe(2);
  }, 45_000);

  it('replaces a missing dispatched Redis job once under concurrent real sweepers with a fresh delivery generation', async () => {
    const queue = verificationQueue(businessQueueName(businessId, '2.0.0'));
    await queue.pause();
    const pending = await submit('queue-recovery-generation');
    expect(await appA!.dispatcher.dispatchOnce()).toBe(1);
    const originalJobs = await queue.getJobs(['waiting', 'prioritized', 'delayed', 'active', 'paused']);
    const original = originalJobs.find((job) => (job.data as { taskId: string }).taskId === pending.taskId);
    expect(original).toBeDefined();
    const oldDeliveryId = (original!.data as { deliveryId: string }).deliveryId;
    const oldJobId = original!.id!;
    await original!.remove();
    expect(await queue.getJob(oldJobId)).toBeUndefined();

    const [sweepA, sweepB] = await Promise.all([
      appA!.runtime.sweepQueueIntegrity({ graceMs: 0, limit: 50 }),
      appB!.runtime.sweepQueueIntegrity({ graceMs: 0, limit: 50 }),
    ]);
    expect(sweepA.rearmed + sweepB.rearmed).toBe(1);
    expect(sweepA.unconfirmed + sweepB.unconfirmed).toBe(0);
    expect(sweepA.stalled + sweepB.stalled).toBe(0);

    const durable = await appA!.db.query<{
      delivery_id: string;
      dispatched_at: Date | null;
      attempts: number;
      type: string;
    }>(
      `SELECT delivery_id,dispatched_at,attempts,type FROM outbox
        WHERE aggregate_id=$1 AND type='task.dispatch' ORDER BY created_at,id`,
      [pending.taskId],
    );
    expect(durable.rows).toHaveLength(2);
    const originalRow = durable.rows.find((row) => row.delivery_id === oldDeliveryId);
    expect(originalRow?.dispatched_at).not.toBeNull();
    const replacements = durable.rows.filter((row) => row.delivery_id !== oldDeliveryId);
    expect(replacements).toHaveLength(1);
    const replacement = replacements[0]!;
    expect(replacement.delivery_id).not.toBe(oldDeliveryId);
    expect(replacement.delivery_id).toContain(`${pending.taskId}:queue-recovery:`);
    expect(replacement.dispatched_at).toBeNull();

    let recoveredDispatch = 0;
    await waitFor(async () => {
      recoveredDispatch = await appB!.dispatcher.dispatchOnce();
      return recoveredDispatch === 1;
    }, 8_000, 'recovery-generation outbox due time');
    expect(recoveredDispatch).toBe(1);
    const newJobId = jobIdForDelivery(replacement.delivery_id);
    expect(newJobId).not.toBe(oldJobId);
    const recoveredJob = await queue.getJob(newJobId);
    expect(recoveredJob).toBeDefined();
    expect(recoveredJob!.data).toMatchObject({ taskId: pending.taskId, deliveryId: replacement.delivery_id });
    await queue.resume();
    await waitUntilTerminal([pending.taskId]);
    const settled = await appA!.db.query<{ state: string; attempt: number; lease_epoch: number }>(
      'SELECT state,attempt,lease_epoch FROM tasks WHERE id=$1', [pending.taskId],
    );
    expect(settled.rows[0]).toMatchObject({ state: 'SUCCEEDED', attempt: 1, lease_epoch: 1 });
    expect(v2HandlerInvocations).toBe(3);
  }, 45_000);
});
