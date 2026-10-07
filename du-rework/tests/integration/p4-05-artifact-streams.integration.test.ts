import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Queue } from 'bullmq';
import {
  BusinessJobV1Schema,
  BusinessManifestSchema,
  ClaimResultSchema,
  TaskReportAckSchema,
  contentHash,
} from '@du/contracts';
import { createApp, type App } from '@du/orchestrator';
import { PgSqlClient } from '@du/connector';

// P4-05 helpers are imported from SOURCE (relative) so this suite needs no
// dependency/lockfile edits in the shared integration package; ts-jest
// compiles the workspace sources in place.
import {
  ArtifactStreamError,
  createTempWorkspace,
  downloadArtifactById,
  uploadArtifact,
  withDownloadedArtifact,
} from '../../orchestrator/packages/worker-sdk/src/index';
import type { TempWorkspace } from '../../orchestrator/packages/worker-sdk/src/index';

import {
  createTestIsolationContext,
  generateSchemaSetupDdl,
  generateSchemaTeardownDdl,
  type TestIsolationContext,
} from '../isolation/namespace';

/**
 * P4-05 integration proof (W40-CC): the worker-sdk artifact-stream helpers
 * against the REAL orchestrator artifact endpoints (ART-01 grant flow,
 * ART-03 limits) with real temp isolation/cleanup (ART-02 SDK side).
 *
 * Endpoints exercised for real:
 *   POST /api/runtime/v1/tasks/:id/artifacts        (upload grant, lease-fenced)
 *   PUT  <grant.uploadUrl>                          (blob bytes behind the grant)
 *   POST /api/runtime/v1/artifacts/:id/finalize     (sha256+size verified READY)
 *   POST /api/runtime/v1/artifacts/:id/access       (tokenized read grant)
 *   GET  <grant.downloadUrl>                        (streamed download)
 *
 * Service-side ART-02 staging-orphan semantics are covered by the existing
 * `artifacts-grants` and `p8-02-fault-recovery` suites; this file proves the
 * SDK consumer half end-to-end.
 */

const isolationCtx: TestIsolationContext | null =
  process.env.TEST_ISOLATION === 'disabled'
    ? null
    : createTestIsolationContext({ runId: process.env.TEST_RUN_ID });

const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const DATABASE_URL = isolationCtx
  ? isolationCtx.getDatabaseUrlWithSchema(BASE_DATABASE_URL)
  : BASE_DATABASE_URL;

const BASE_REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const REDIS_URL = process.env.REDIS_URL ?? (
  isolationCtx && process.env.REDIS_DB_INDEX
    ? `redis://localhost:6380/${process.env.REDIS_DB_INDEX}`
    : BASE_REDIS_URL
);

const RUNTIME_TOKEN = `integration-runtime-${randomUUID()}`;
const ADMIN_TOKEN = `integration-admin-${randomUUID()}`;
const API_KEY = `integration-api-${randomUUID()}`;
const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

const BUSINESS_ID = `p405-artifact-streams-${randomUUID().replaceAll('-', '')}`;
const BUSINESS_VERSION = '1.0.0';

const manifest = BusinessManifestSchema.parse({
  contractVersion: '1',
  businessId: BUSINESS_ID,
  version: BUSINESS_VERSION,
  displayName: 'P4-05 artifact streams integration proof',
  description: 'SDK streaming upload/download against real runtime endpoints',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  runtime: { wireVersion: '1', handlerKinds: ['root'] },
  capabilities: { cancel: true, resume: false, parallel: false },
  actions: [
    {
      name: 'process',
      displayName: 'Process artifacts',
      description: 'Root task used to hold a real lease for artifact flows',
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string', minLength: 1 } },
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
      profileSchema: { type: 'object' },
      connectorSlots: [],
      artifactPolicy: { minFiles: 0, maxFiles: 5 },
      capabilities: { cancel: true, resume: false },
      defaultLimits: { maxParallelTasks: 1 },
    },
  ],
});

interface HttpResult {
  status: number;
  body: unknown;
}

async function request(
  baseUrl: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : undefined };
}

async function waitForOperationJob(queue: Queue, operationId: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed']);
    const match = jobs.find((job) => {
      const parsed = BusinessJobV1Schema.safeParse(job.data);
      return parsed.success && parsed.data.operationId === operationId;
    });
    if (match) return match;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No dispatch job appeared for operation ${operationId}.`);
}

describe('P4-05 — SDK artifact streams against the real runtime (ART-01/02/03)', () => {
  let app: App | undefined;
  let queue: Queue | undefined;
  let baseUrl = '';
  let runtimeBase = '';
  let taskId = '';
  let leaseEpoch = 0;
  let dispatchJob: Awaited<ReturnType<typeof waitForOperationJob>> | undefined;

  // Shared fixtures across the ordered tests below (single claimed lease).
  const payload = Buffer.from(`P4-05 integration payload ${randomUUID()}`, 'utf8');
  // uploadArtifact zeroes the caller buffer (temp-cleanup invariant), so a
  // pristine copy is kept for the download round-trip comparison.
  const payloadCopy = Buffer.from(payload);
  const payloadSha = createHash('sha256').update(payload).digest('hex');
  let uploadedArtifactId = '';
  let workspace: TempWorkspace | undefined;

  beforeAll(async () => {
    if (isolationCtx) {
      const client = new PgSqlClient({ connectionString: BASE_DATABASE_URL });
      await client.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
      await client.close();
    }

    const runtime = await createApp({
      port: 0,
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      runtimeToken: RUNTIME_TOKEN,
      adminToken: ADMIN_TOKEN,
      connectorId: 'default-connector',
      connectorRevision: 1,
      autoDispatch: true,
      autoMigrate: true,
    });
    app = runtime;
    await runtime.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1,$2,$3,'test','ACTIVE')
       ON CONFLICT (hash) DO UPDATE SET status='ACTIVE'`,
      [randomUUID(), TENANT_ID, hashKey(API_KEY)]
    );
    const server = await runtime.listen();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Orchestrator did not bind.');
    baseUrl = `http://127.0.0.1:${address.port}`;
    runtimeBase = `${baseUrl}/api/runtime/v1`;

    const registration = await request(
      baseUrl,
      `/api/runtime/v1/businesses/${BUSINESS_ID}/versions/${BUSINESS_VERSION}`,
      { method: 'PUT', headers: { authorization: `Bearer ${RUNTIME_TOKEN}` }, body: manifest }
    );
    expect([200, 201]).toContain(registration.status);
    await runtime.enableVersionForTest(BUSINESS_ID, BUSINESS_VERSION);

    const submission = await request(baseUrl, `/api/v1/businesses/${BUSINESS_ID}/actions/process`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'idempotency-key': `submit-${randomUUID()}` },
      body: { input: { text: 'p4-05 streaming proof' } },
    });
    expect(submission.status).toBe(202);

    queue = new Queue(`du-business-${BUSINESS_ID}-${BUSINESS_VERSION}`, {
      connection: { url: REDIS_URL },
    });
    dispatchJob = await waitForOperationJob(queue, (submission.body as { operationId: string }).operationId);
    const dispatch = BusinessJobV1Schema.parse(dispatchJob.data);
    taskId = dispatch.taskId;

    const claimResponse = await request(baseUrl, `/api/runtime/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
      body: { deliveryId: dispatch.deliveryId, workerInstanceId: 'p4-05-integration-worker', businessId: BUSINESS_ID },
    });
    expect(claimResponse.status).toBe(200);
    leaseEpoch = ClaimResultSchema.parse(claimResponse.body).leaseEpoch;

    workspace = await createTempWorkspace(taskId);
  });

  afterAll(async () => {
    await workspace?.dispose().catch(() => undefined);
    await dispatchJob?.remove().catch(() => undefined);
    await queue?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    if (isolationCtx && process.env.PRESERVE_TEST_SCHEMA !== 'true') {
      const client = new PgSqlClient({ connectionString: BASE_DATABASE_URL });
      await client.query(generateSchemaTeardownDdl(isolationCtx.dbSchema));
      await client.close();
    }
  });

  test('uploadArtifact completes the real staged flow: grant → PUT blob → finalize READY', async () => {
    const out = await uploadArtifact(
      { taskId, leaseEpoch },
      payload,
      { fileName: 'p4-05-payload.bin', mimeType: 'application/octet-stream', purpose: 'output' },
      runtimeBase,
      RUNTIME_TOKEN
    );
    expect(out.sha256).toBe(payloadSha);
    expect(out.sizeBytes).toBe(payload.byteLength);
    expect(out.artifactId).toMatch(/^[0-9a-f-]{36}$/);
    uploadedArtifactId = out.artifactId;
    // Temp-cleanup invariant held against the real service too.
    expect(payload.every((b) => b === 0)).toBe(true);
  });

  test('downloadArtifactById streams the READY artifact through a real read grant', async () => {
    expect(workspace).toBeDefined();
    const out = await downloadArtifactById(
      { taskId, leaseEpoch },
      uploadedArtifactId,
      workspace!,
      'roundtrip.bin',
      {
        runtimeBaseUrl: runtimeBase,
        runtimeToken: RUNTIME_TOKEN,
        maxBytes: 4 * 1024 * 1024,
      }
    );
    expect(existsSync(out.path)).toBe(true);
    expect(out.path.startsWith(workspace!.dir)).toBe(true);

    // The runtime blob endpoint serves the original bytes; the SDK streams
    // the granted response and hashes those same bytes.
    const onDisk = await readFile(out.path);
    expect(createHash('sha256').update(onDisk).digest('hex')).toBe(out.sha256);
    expect(out.sizeBytes).toBe(onDisk.byteLength);

    // Content round-trip: downloaded bytes must exactly match the upload.
    expect(onDisk.equals(payloadCopy)).toBe(true);
  });

  test('withDownloadedArtifact bounds the file lifetime around real bytes', async () => {
    const artifact = await downloadArtifactById({ taskId, leaseEpoch }, uploadedArtifactId, workspace!, 'scoped.bin', {
      runtimeBaseUrl: runtimeBase,
      runtimeToken: RUNTIME_TOKEN,
      maxBytes: 4 * 1024 * 1024,
    });
    let pathInside = '';
    const result = await withDownloadedArtifact(artifact, async (a) => {
      pathInside = a.path;
      expect(existsSync(a.path)).toBe(true);
      const buf = await readFile(a.path);
      return buf.byteLength;
    });
    expect(result).toBe(artifact.sizeBytes);
    expect(existsSync(pathInside)).toBe(false); // deleted after the scope
  });

  test('maxBytes rejects an oversized real download and leaves no file (ART-03)', async () => {
    await expect(
      downloadArtifactById({ taskId, leaseEpoch }, uploadedArtifactId, workspace!, 'too-big.bin', {
        runtimeBaseUrl: runtimeBase,
        runtimeToken: RUNTIME_TOKEN,
        maxBytes: 8, // raw payload exceeds this limit
      })
    ).rejects.toMatchObject({ name: 'ArtifactStreamError', code: 'TOO_LARGE' });
    expect(existsSync(workspace!.filePath('too-big.bin'))).toBe(false);
  });

  test('a stale leaseEpoch is fenced by the real access grant (ART-01 ownership)', async () => {
    await expect(
      downloadArtifactById({ taskId, leaseEpoch: leaseEpoch + 999 }, uploadedArtifactId, workspace!, 'fenced.bin', {
        runtimeBaseUrl: runtimeBase,
        runtimeToken: RUNTIME_TOKEN,
        maxBytes: 4 * 1024 * 1024,
      })
    ).rejects.toMatchObject({ name: 'ArtifactStreamError', code: 'GRANT_REJECTED' });
    expect(existsSync(workspace!.filePath('fenced.bin'))).toBe(false);
  });

  test('hash verification catches a corrupted expectation against the real artifact', async () => {
    await expect(
      downloadArtifactById({ taskId, leaseEpoch }, uploadedArtifactId, workspace!, 'bad-hash.bin', {
        runtimeBaseUrl: runtimeBase,
        runtimeToken: RUNTIME_TOKEN,
        maxBytes: 4 * 1024 * 1024,
        expectedSha256: 'f'.repeat(64),
      })
    ).rejects.toBeInstanceOf(ArtifactStreamError);
    expect(existsSync(workspace!.filePath('bad-hash.bin'))).toBe(false);
  });

  test('the task completes with an artifact resultRef and the workspace disposes cleanly', async () => {
    const resultRef = `artifact://${uploadedArtifactId}`;
    const completeResp = await request(baseUrl, `/api/runtime/v1/tasks/${taskId}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
      body: { leaseEpoch, resultRef, resultHash: contentHash(resultRef) },
    });
    expect(completeResp.status).toBe(200);
    expect(TaskReportAckSchema.parse(completeResp.body).state).toBe('SUCCEEDED');

    const dir = workspace!.dir;
    await workspace!.dispose();
    expect(existsSync(dir)).toBe(false);
  });
});
