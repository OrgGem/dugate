import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import {
  BusinessJobV1,
  businessQueueName,
  ClaimResult,
  HeartbeatAck,
  TaskHeartbeatAck,
  ArtifactUploadGrant,
  SaveStepAck,
  TaskReportAck,
} from '@du/contracts';
import { startDocumentCoreWorker, WorkerHandle } from '../src';

/**
 * Opt-in BullMQ Redis smoke test (WORKLOAD-REBALANCE-03).
 *
 * Verifies that DocumentCoreWorker operates as a real production service against
 * live Redis at 6380 using the real BullMQ QueueConsumer (ADR-05), consuming jobs,
 * claiming tasks via HTTP against a local fake runtime server, executing document actions,
 * saving step checkpoints and artifacts, reporting completion, and shutting down gracefully.
 *
 * Opt-in behaviour:
 * - If REDIS_SMOKE=1, runs unconditionally (fails if Redis unreachable).
 * - If REDIS_SMOKE=0, skipped.
 * - Otherwise (default), probes 127.0.0.1:6380: if reachable, runs; if unreachable, skips.
 */

async function isRedisReachable(port = 6380, host = '127.0.0.1', timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const REDIS_ENV = process.env.REDIS_SMOKE;
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';

describe('Document Core — BullMQ & Redis Smoke Suite', () => {
  let redisAvailable = false;

  beforeAll(async () => {
    if (REDIS_ENV === '0') {
      redisAvailable = false;
      return;
    }
    if (REDIS_ENV === '1') {
      redisAvailable = true;
      return;
    }
    redisAvailable = await isRedisReachable(6380, '127.0.0.1');
  });

  test('proves queue consumption, claim, step execution, completion and drain against Redis 6380', async () => {
    if (!redisAvailable) {
      console.log('Skipping Redis smoke test: Redis not reachable at 127.0.0.1:6380 (opt-in via REDIS_SMOKE=1)');
      return;
    }

    const testId = randomUUID().slice(0, 8);
    const taskId = randomUUID();
    const operationId = randomUUID();
    const deliveryId = `smoke-delivery-${testId}`;
    const queueName = businessQueueName('document-core', '1.0.0');

    // Recorded events at fake runtime
    const recorded = {
      workerHeartbeats: [] as unknown[],
      claims: [] as { taskId: string; body: unknown }[],
      taskHeartbeats: [] as unknown[],
      artifactGrants: [] as unknown[],
      artifactUploads: new Map<string, string>(),
      artifactFinalizations: [] as unknown[],
      savedSteps: [] as { stepKey: string; body: unknown }[],
      completions: [] as { taskId: string; body: unknown }[],
    };

    let fakeServerPort = 0;

    // In-process fake runtime HTTP server
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${fakeServerPort}`);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: any = null;
      try {
        body = rawBody.length > 0 ? JSON.parse(rawBody) : null;
      } catch {
        // non-JSON body (e.g. raw artifact upload)
      }

      // 1. Worker Heartbeat: PUT /workers/:instanceId/heartbeat
      if (req.method === 'PUT' && url.pathname.includes('/heartbeat') && url.pathname.startsWith('/workers/')) {
        recorded.workerHeartbeats.push(body);
        const ack: HeartbeatAck = {
          health: 'HEALTHY',
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          capacity: 1,
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(ack));
        return;
      }

      // 2. Task Claim: POST /tasks/:taskId/claim
      if (req.method === 'POST' && url.pathname.endsWith('/claim')) {
        const pathTaskId = url.pathname.split('/')[2] ?? '';
        recorded.claims.push({ taskId: pathTaskId, body });
        const claimResult: ClaimResult = {
          taskId: pathTaskId,
          operationId,
          leaseEpoch: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          attempt: 1,
          deadlineAt: null,
          executionSnapshot: {
            operationId,
            tenantId: 'tenant-smoke',
            businessId: 'document-core',
            businessVersion: '1.0.0',
            action: 'ingest',
            schemaDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            manifestDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            resolvedInputRef: {
              mode: 'parse',
              text: '# Smoke Test Document\n\nVerified execution through Redis 6380 and fake runtime.',
              outputFormat: 'markdown',
            },
            pinned: {
              profileRevision: 1,
              promptRevisions: {},
              connectorBindings: {},
            },
            taskKey: 'root',
            kind: 'ingest',
            payloadRef: {},
            deadlineAt: null,
            cancelRequested: false,
          },
          checkpointRefs: [],
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(claimResult));
        return;
      }

      // 3. Task Heartbeat: POST /tasks/:taskId/heartbeat
      if (req.method === 'POST' && url.pathname.endsWith('/heartbeat') && url.pathname.startsWith('/tasks/')) {
        recorded.taskHeartbeats.push(body);
        const ack: TaskHeartbeatAck = {
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          cancelRequested: false,
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(ack));
        return;
      }

      // 4. Artifact Grant: POST /tasks/:taskId/artifacts
      if (req.method === 'POST' && url.pathname.endsWith('/artifacts') && url.pathname.startsWith('/tasks/')) {
        const artifactId = randomUUID();
        recorded.artifactGrants.push({ artifactId, body });
        const grant: ArtifactUploadGrant = {
          artifactId,
          storageKey: `tasks/artifacts/${artifactId}`,
          uploadUrl: `http://127.0.0.1:${fakeServerPort}/upload-sink/${artifactId}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(grant));
        return;
      }

      // 5. Artifact Upload Sink: PUT /upload-sink/:artifactId
      if (req.method === 'PUT' && url.pathname.startsWith('/upload-sink/')) {
        const artifactId = url.pathname.split('/')[2] ?? '';
        recorded.artifactUploads.set(artifactId, rawBody);
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('OK');
        return;
      }

      // 6. Artifact Finalize: POST /artifacts/:artifactId/finalize
      if (req.method === 'POST' && url.pathname.includes('/finalize') && url.pathname.startsWith('/artifacts/')) {
        const artifactId = url.pathname.split('/')[2] ?? '';
        recorded.artifactFinalizations.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({}));
        return;
      }

      // 7. Save Step: PUT /tasks/:taskId/steps/:stepKey
      if (req.method === 'PUT' && url.pathname.includes('/steps/') && url.pathname.startsWith('/tasks/')) {
        const parts = url.pathname.split('/');
        const stepKey = decodeURIComponent(parts[4] ?? '');
        recorded.savedSteps.push({ stepKey, body });
        const ack: SaveStepAck = {
          stepKey,
          generation: 1,
          replayed: false,
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(ack));
        return;
      }

      // 8. Task Complete: POST /tasks/:taskId/complete
      if (req.method === 'POST' && url.pathname.endsWith('/complete') && url.pathname.startsWith('/tasks/')) {
        const pathTaskId = url.pathname.split('/')[2] ?? '';
        recorded.completions.push({ taskId: pathTaskId, body });
        const ack: TaskReportAck = {
          taskId: pathTaskId,
          state: 'SUCCEEDED',
          operationState: 'SUCCEEDED',
          replayed: false,
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(ack));
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          fakeServerPort = addr.port;
        }
        resolve();
      });
    });

    let workerHandle: WorkerHandle | undefined;
    let bullmqQueue: Queue | undefined;

    try {
      // Start the real worker connected to Redis and the local fake runtime
      workerHandle = await startDocumentCoreWorker({
        runtimeUrl: `http://127.0.0.1:${fakeServerPort}`,
        runtimeToken: 'secret-smoke-token',
        redis: { url: REDIS_URL },
        concurrency: 1,
        workerInstanceId: `smoke-worker-${testId}`,
        heartbeatIntervalMs: 5000,
      });

      expect(workerHandle.workerInstanceId).toBe(`smoke-worker-${testId}`);
      expect(workerHandle.queueName).toBe(queueName);
      expect(workerHandle.stopped).toBe(false);

      // Verify worker registration heartbeat occurred
      expect(recorded.workerHeartbeats.length).toBeGreaterThanOrEqual(1);

      // Connect a real BullMQ Queue and enqueue the job
      bullmqQueue = new Queue(queueName, {
        connection: { url: REDIS_URL },
      });

      const jobPayload: BusinessJobV1 = {
        contractVersion: '1',
        deliveryId,
        taskId,
        operationId,
        businessId: 'document-core',
        businessVersion: '1.0.0',
        action: 'ingest',
        kind: 'ingest',
        correlationId: `corr-${testId}`,
      };

      await bullmqQueue.add('delivery', jobPayload);

      // Poll until task completion is reported to fake runtime
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !recorded.completions.some((c) => c.taskId === taskId)) {
        await new Promise((r) => setTimeout(r, 100));
      }

      // Assertions proving the complete lifecycle:
      // 1. Queue consumption led to claim
      expect(recorded.claims.some((c) => c.taskId === taskId)).toBe(true);

      // 2. Step checkpoints saved to runtime
      expect(recorded.savedSteps.length).toBeGreaterThanOrEqual(2);
      expect(recorded.savedSteps.some((s) => s.stepKey === 'ingest:prepare-source')).toBe(true);
      expect(recorded.savedSteps.some((s) => s.stepKey === 'ingest:execute-parse')).toBe(true);

      // 3. Artifacts generated and finalized
      expect(recorded.artifactGrants.length).toBeGreaterThan(0);
      expect(recorded.artifactUploads.size).toBeGreaterThan(0);
      expect(recorded.artifactFinalizations.length).toBeGreaterThan(0);

      // 4. Task reported completed with resultRef pointing to artifact
      const completion = recorded.completions.find((c) => c.taskId === taskId);
      expect(completion).toBeDefined();
      expect((completion?.body as any)?.resultRef).toMatch(/^artifact:\/\//);
      expect((completion?.body as any)?.leaseEpoch).toBe(1);

      // 5. Graceful drain: handle.stop() closes consumer and marks worker stopped
      await workerHandle.stop(5000);
      expect(workerHandle.stopped).toBe(true);

    } finally {
      if (workerHandle && !workerHandle.stopped) {
        await workerHandle.stop(2000).catch(() => {});
      }
      if (bullmqQueue) {
        await bullmqQueue.close().catch(() => {});
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});
