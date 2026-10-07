import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import {
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createApp, type App } from '../src/server';
import { createMultipartService } from '../src/modules/artifacts/multipart-service';
import { createS3ArtifactStorageFacade } from '../src/modules/artifacts/s3-storage-facade';
import {
  RuntimeClient,
  RuntimeError,
  uploadArtifactMultipart,
  type MultipartUploadTransport,
} from '../../../packages/worker-sdk/src';

/**
 * T-DATA-LIVE-2 / DATA-02 + DATA-04 live PG + S3 pilot verification.
 * Run only inside the exclusive Tester DB window with DU_LIVE_INFRA=1 and
 * the approved private MinIO bucket configured in the process environment.
 * This suite writes only suite-owned tenants, operations, tasks and artifacts;
 * it never migrates, truncates, flushes Redis, or touches public upload routes.
 */

jest.setTimeout(600_000);

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const SIGNED_JSON_LIMIT_BYTES = 1 * MiB;
const SIGNED_SINGLE_PUT_LIMIT_BYTES = 64 * MiB;
const SIGNED_MULTIPART_MAX_BYTES = 8 * GiB;
const SIGNED_MULTIPART_TTL_MS = 24 * 60 * 60 * 1000;
const PART_BYTES = 64 * MiB;
const LARGE_OBJECT_BYTES = SIGNED_SINGLE_PUT_LIMIT_BYTES + 1;

const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn('data-02-04-live-s3.test.ts: SKIPPED - set DU_LIVE_INFRA=1 inside the exclusive DB window.');
}

const DATABASE_URL = process.env.DATABASE_URL ??
  'postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
const S3_ENDPOINT = process.env.ARTIFACT_S3_ENDPOINT ?? 'http://127.0.0.1:9003';
const S3_BUCKET = process.env.ARTIFACT_S3_BUCKET ?? 'du-artifacts-live2';
const EPOCH = 47;
const RUNTIME_TOKEN_A = 'data-live2-runtime-a-' + randomUUID();
const RUNTIME_TOKEN_B = 'data-live2-runtime-b-' + randomUUID();
const WORKER_TOKEN_A = 'data-live2-worker-a-' + randomUUID();
const WORKER_TOKEN_B = 'data-live2-worker-b-' + randomUUID();
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const BUSINESS_A = 'data-live2-a-' + randomUUID().slice(0, 8);
const BUSINESS_B = 'data-live2-b-' + randomUUID().slice(0, 8);
const API_KEY_A = randomUUID();
const API_KEY_B = randomUUID();
const RAW_API_KEY_A = 'du_data_live2_a_' + randomUUID().replace(/-/g, '');
const RAW_API_KEY_B = 'du_data_live2_b_' + randomUUID().replace(/-/g, '');

let app: App | undefined;
let baseUrl = '';
let runtimeA: RuntimeClient;
let runtimeB: RuntimeClient;
let s3: S3Client | undefined;
let liveSweeper: ReturnType<typeof createMultipartService> | undefined;
let taskA = '';
let taskB = '';
let operationA = '';
let operationB = '';
let peakRssBytes = 0;
let peakRssPoint = 'baseline';
let baselineRssBytes = 0;

function sampleRss(point: string): void {
  const rss = process.memoryUsage().rss;
  if (rss > peakRssBytes) {
    peakRssBytes = rss;
    peakRssPoint = point;
  }
}

function assertTestDatabase(): void {
  const databaseName = new URL(DATABASE_URL).pathname.split('/').pop() ?? '';
  if (!/test/i.test(databaseName)) {
    throw new Error(`refusing live data test: database "${databaseName}" is not a test database`);
  }
}

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function* patternedChunks(totalBytes: number, chunkBytes: number): Generator<Buffer> {
  for (let offset = 0; offset < totalBytes; offset += chunkBytes) {
    const length = Math.min(chunkBytes, totalBytes - offset);
    const chunk = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index += 1) {
      chunk[index] = ((offset + index) * 31 + 7) % 251;
    }
    sampleRss('multipart source chunk');
    yield chunk;
  }
}

async function httpJson(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(baseUrl + path, {
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const raw = await response.text();
  return {
    status: response.status,
    body: raw ? JSON.parse(raw) as Record<string, unknown> : {},
  };
}

function publicSubmitHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', 'x-api-key': RAW_API_KEY_A };
}

async function submitArtifact(artifactId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return httpJson(`/api/v1/businesses/${encodeURIComponent(BUSINESS_A)}/actions/extract`, {
    method: 'POST',
    headers: publicSubmitHeaders(),
    body: {
      input: { q: 'T-DATA-LIVE-2 submit fence' },
      artifacts: [{ artifactId, role: 'input' }],
    },
  });
}

async function seedTask(tenantId: string, apiKeyId: string, businessId: string, label: string): Promise<{
  operationId: string;
  taskId: string;
}> {
  const op = await app!.db.query<{ id: string }>(
    `INSERT INTO operations (id, tenant_id, api_key_id, business_id, business_version, action,
                            state, state_version, input_ref, correlation_id)
     VALUES ($1,$2,$3,$4,'1.0.0','extract','RUNNING',1,'{}'::jsonb,$5)
     RETURNING id`,
    [randomUUID(), tenantId, apiKeyId, businessId, `data-live2-${label}-${randomUUID()}`],
  );
  const operationId = op.rows[0]!.id;
  const task = await app!.db.query<{ id: string }>(
    `INSERT INTO tasks (id, operation_id, task_key, kind, payload_ref, state, attempt, max_attempts,
                        lease_epoch, lease_expires_at, leased_by, due_at)
     VALUES ($1,$2,$3,'root','{}'::jsonb,'RUNNING',1,3,$4,now()+interval '15 minutes',$5,now())
     RETURNING id`,
    [randomUUID(), operationId, `root-${label}-${randomUUID()}`, EPOCH, `data-live2-${label}`],
  );
  const taskId = task.rows[0]!.id;
  await app!.db.query('UPDATE operations SET root_task_id=$2 WHERE id=$1', [operationId, taskId]);
  return { operationId, taskId };
}

async function seedExpiredReadyArtifact(): Promise<string> {
  const artifactId = randomUUID();
  await app!.db.query(
    `INSERT INTO artifacts (id, tenant_id, operation_id, purpose, file_name, mime_type, size_bytes,
                            state, token, token_mode, token_expires_at, storage_key, storage_backend, expires_at)
     VALUES ($1,$2,$3,'input','expired.bin','application/octet-stream',16,'READY',$4,'upload',
             now()+interval '1 hour',$5,'s3',now()-interval '1 second')`,
    [artifactId, TENANT_A, operationA, randomUUID(), `art-${artifactId}`],
  );
  return artifactId;
}

async function seedBusiness(businessId: string): Promise<void> {
  const manifest = {
    businessId,
    version: '1.0.0',
    runtime: { wireVersion: '1', handlerKinds: ['root'] },
    actions: [{ name: 'extract', inputSchema: { type: 'object', additionalProperties: true } }],
  };
  await app!.db.query(
    `INSERT INTO business_versions (business_id, version, status, is_active, digest, queue, manifest)
     VALUES ($1,'1.0.0','ENABLED',true,$2,$3,$4::jsonb)`,
    [businessId, `sha256-${randomUUID()}`, `queue-${businessId}`, JSON.stringify(manifest)],
  );
}

async function uploadFirstGrantedPart(client: RuntimeClient, artifactId: string): Promise<void> {
  const partBytes = PART_BYTES;
  const body = Buffer.alloc(partBytes, 0x5a);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const grant = await client.multipartPartGrant(artifactId, {
    leaseEpoch: EPOCH,
    partNumber: 1,
    sha256,
  });
  expect(grant.sizeBytes).toBe(partBytes);
  sampleRss('abort/sweep part body allocated');
  const response = await fetch(grant.partUrl, {
    method: 'PUT',
    headers: grant.requiredHeaders,
    body,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('etag')).toBeTruthy();
}

async function removeObjectVersions(storageKeys: string[]): Promise<void> {
  if (!s3) return;
  for (const prefix of storageKeys) {
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    do {
      const page = await s3.send(new ListObjectVersionsCommand({
        Bucket: S3_BUCKET,
        Prefix: prefix,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }));
      const versions = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])];
      for (const version of versions) {
        if (!version.Key || !version.VersionId) continue;
        await s3.send(new DeleteObjectCommand({
          Bucket: S3_BUCKET,
          Key: version.Key,
          VersionId: version.VersionId,
        }));
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker !== undefined || versionIdMarker !== undefined);
  }
}

liveDescribe('T-DATA-LIVE-2 DATA-02/DATA-04 real PostgreSQL + private S3 pilot', () => {
  beforeAll(async () => {
    assertTestDatabase();
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      throw new Error('S3 pilot credentials missing from the process environment (names only; values are not logged)');
    }
    app = await createApp({
      port: 0,
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      runtimeToken: RUNTIME_TOKEN_A,
      workerIdentityTokensByBusiness: {
        [BUSINESS_A]: WORKER_TOKEN_A,
        [BUSINESS_B]: WORKER_TOKEN_B,
      },
      autoDispatch: false,
      autoMigrate: false,
      maxJsonBytes: SIGNED_JSON_LIMIT_BYTES,
      maxBlobBytes: SIGNED_SINGLE_PUT_LIMIT_BYTES,
      multipartLimits: {
        partSizeBytes: PART_BYTES,
        maxTotalBytes: SIGNED_MULTIPART_MAX_BYTES,
        sessionTtlMs: SIGNED_MULTIPART_TTL_MS,
      },
      artifactStorage: {
        backend: 's3',
        bucket: S3_BUCKET,
        region: 'us-east-1',
        endpoint: S3_ENDPOINT,
        forcePathStyle: true,
      },
    });
    const migration = await app.db.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations WHERE sequence=15 AND filename='0015_artifact_multipart.sql'",
    );
    expect(migration.rowCount).toBe(1);

    const server = await app.listen();
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    runtimeA = new RuntimeClient({ baseUrl: `${baseUrl}/api/runtime/v1`, token: WORKER_TOKEN_A });
    runtimeB = new RuntimeClient({ baseUrl: `${baseUrl}/api/runtime/v1`, token: WORKER_TOKEN_B });
    s3 = new S3Client({ region: 'us-east-1', endpoint: S3_ENDPOINT, forcePathStyle: true });
    liveSweeper = createMultipartService(app.db, {
      storage: createS3ArtifactStorageFacade({ bucket: S3_BUCKET, client: s3 }),
      partSizeBytes: PART_BYTES,
      maxTotalBytes: SIGNED_MULTIPART_MAX_BYTES,
      sessionTtlMs: SIGNED_MULTIPART_TTL_MS,
    });

    await app.db.query(
      'INSERT INTO tenants (id,name) VALUES ($1,$2),($3,$4)',
      [TENANT_A, `data-live2-a-${TENANT_A}`, TENANT_B, `data-live2-b-${TENANT_B}`],
    );
    await app.db.query(
      `INSERT INTO api_keys (id,tenant_id,hash,prefix,status)
       VALUES ($1,$2,$3,'du_data_l2','ACTIVE'),($4,$5,$6,'du_data_l2','ACTIVE')`,
      [API_KEY_A, TENANT_A, hashKey(RAW_API_KEY_A), API_KEY_B, TENANT_B, hashKey(RAW_API_KEY_B)],
    );
    await seedBusiness(BUSINESS_A);
    await seedBusiness(BUSINESS_B);
    const a = await seedTask(TENANT_A, API_KEY_A, BUSINESS_A, 'a');
    const b = await seedTask(TENANT_B, API_KEY_B, BUSINESS_B, 'b');
    operationA = a.operationId;
    taskA = a.taskId;
    operationB = b.operationId;
    taskB = b.taskId;
    baselineRssBytes = process.memoryUsage().rss;
    peakRssBytes = baselineRssBytes;
  }, 120_000);

  afterAll(async () => {
    if (!app) {
      s3?.destroy();
      return;
    }
    let cleanupError: unknown;
    try {
      const operations = await app.db.query<{ id: string }>(
        'SELECT id FROM operations WHERE business_id = ANY($1::text[])',
        [[BUSINESS_A, BUSINESS_B]],
      );
      const operationIds = operations.rows.map((row) => row.id);
      if (operationIds.length > 0) {
        const keys = await app.db.query<{ storage_key: string }>(
          'SELECT storage_key FROM artifacts WHERE operation_id=ANY($1::uuid[])',
          [operationIds],
        );
        await removeObjectVersions(keys.rows.map((row) => row.storage_key));
        await app.db.query('DELETE FROM usage_events WHERE operation_id=ANY($1::uuid[])', [operationIds]);
        await app.db.query('DELETE FROM webhook_deliveries WHERE operation_id=ANY($1::uuid[])', [operationIds]);
        await app.db.query('DELETE FROM submission_keys WHERE operation_id=ANY($1::uuid[])', [operationIds]);
        await app.db.query(
          'DELETE FROM artifact_blobs WHERE storage_key IN (SELECT storage_key FROM artifacts WHERE operation_id=ANY($1::uuid[]))',
          [operationIds],
        );
        await app.db.query('DELETE FROM artifacts WHERE operation_id=ANY($1::uuid[])', [operationIds]);
        await app.db.query(
          'DELETE FROM outbox WHERE aggregate_id IN (SELECT id FROM tasks WHERE operation_id=ANY($1::uuid[]))',
          [operationIds],
        );
        await app.db.query('DELETE FROM tasks WHERE operation_id=ANY($1::uuid[])', [operationIds]);
        await app.db.query('DELETE FROM operations WHERE id=ANY($1::uuid[])', [operationIds]);
      }
      await app.db.query('DELETE FROM api_keys WHERE id=ANY($1::uuid[])', [[API_KEY_A, API_KEY_B]]);
      await app.db.query('DELETE FROM business_versions WHERE business_id=ANY($1::text[])', [[BUSINESS_A, BUSINESS_B]]);
      await app.db.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
    } catch (error) {
      cleanupError = error;
    } finally {
      s3?.destroy();
      await app.close();
    }
    if (cleanupError) throw cleanupError;
  }, 60_000);

  test('streams >64 MiB through worker SDK, recovers lost init/complete ACKs, finalizes and submits READY row', async () => {
    const initStartedAt = Date.now();
    let initArtifactId = '';
    let completeRequest: Parameters<MultipartUploadTransport['complete']>[1] | undefined;
    let completeReplayRecovered = false;
    const transport: MultipartUploadTransport = {
      async init(body) {
        const request = { ...body, leaseEpoch: EPOCH };
        const firstResponse = await runtimeA.multipartInit(taskA, request);
        // Simulate that the first server write succeeded but its response was
        // lost: the worker sees only an exact idempotent replay response.
        const recovered = await runtimeA.multipartInit(taskA, request);
        expect(recovered.artifactId).toBe(firstResponse.artifactId);
        expect(recovered.replayed).toBe(true);
        initArtifactId = recovered.artifactId;
        return recovered;
      },
      async partGrant(artifactId, body) {
        return runtimeA.multipartPartGrant(artifactId, { ...body, leaseEpoch: EPOCH });
      },
      async complete(artifactId, body) {
        completeRequest = body;
        const firstResponse = await runtimeA.multipartComplete(artifactId, { ...body, leaseEpoch: EPOCH });
        // Simulate response loss after the completed generation was committed.
        const recovered = await runtimeA.multipartComplete(artifactId, { ...body, leaseEpoch: EPOCH });
        expect(recovered).toMatchObject({
          artifactId: firstResponse.artifactId,
          sizeBytes: firstResponse.sizeBytes,
          sha256: firstResponse.sha256,
          committed: true,
          replayed: true,
        });
        completeReplayRecovered = true;
        return recovered;
      },
      async abort(artifactId, body) {
        return runtimeA.multipartAbort(artifactId, { ...body, leaseEpoch: EPOCH });
      },
    };

    const upload = await uploadArtifactMultipart(
      Readable.from(patternedChunks(LARGE_OBJECT_BYTES, 256 * 1024)),
      {
        transport,
        fileName: 'data-live2-over-64mib.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: LARGE_OBJECT_BYTES,
        timeoutMs: 180_000,
        fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
          sampleRss('real presigned S3 part PUT entry');
          const response = await fetch(url, init);
          sampleRss('real presigned S3 part PUT response');
          return response;
        }) as typeof fetch,
      },
    );
    expect(upload.sizeBytes).toBe(LARGE_OBJECT_BYTES);
    expect(upload.partCount).toBe(2);
    expect(upload.artifactId).toBe(initArtifactId);
    expect(upload.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(completeRequest?.parts).toHaveLength(2);
    expect(completeReplayRecovered).toBe(true);

    const initTtlMs = Date.parse((await app!.db.query<{ multipart_expires_at: Date }>(
      'SELECT multipart_expires_at FROM artifacts WHERE id=$1', [upload.artifactId],
    )).rows[0]!.multipart_expires_at.toISOString()) - initStartedAt;
    expect(initTtlMs).toBeGreaterThan(SIGNED_MULTIPART_TTL_MS - 10_000);
    expect(initTtlMs).toBeLessThan(SIGNED_MULTIPART_TTL_MS + 10_000);

    const stagingRow = await app!.db.query<{
      state: string;
      size_bytes: string;
      sha256: string;
      part_size_bytes: number;
      part_count: number;
      storage_backend: string;
      storage_version_id: string | null;
      storage_key: string;
    }>(
      `SELECT state,size_bytes,sha256,part_size_bytes,part_count,storage_backend,storage_version_id,storage_key
       FROM artifacts WHERE id=$1`,
      [upload.artifactId],
    );
    expect(stagingRow.rows[0]).toMatchObject({
      state: 'STAGING',
      size_bytes: String(LARGE_OBJECT_BYTES),
      sha256: upload.sha256,
      part_size_bytes: PART_BYTES,
      part_count: 2,
      storage_backend: 's3',
      storage_version_id: expect.any(String),
    });
    expect(stagingRow.rows[0]!.storage_version_id).not.toBe('null');

    const stagingSubmit = await submitArtifact(upload.artifactId);
    expect(stagingSubmit.status).toBe(409);
    expect(stagingSubmit.body.code).toBe('STATE_CONFLICT');

    await runtimeA.finalizeArtifact(upload.artifactId, {
      taskId: taskA,
      leaseEpoch: EPOCH,
      sizeBytes: upload.sizeBytes,
      sha256: upload.sha256,
    });
    const ready = await app!.db.query<{ state: string; storage_version_id: string | null }>(
      'SELECT state,storage_version_id FROM artifacts WHERE id=$1', [upload.artifactId],
    );
    expect(ready.rows[0]?.state).toBe('READY');
    expect(ready.rows[0]?.storage_version_id).toBeTruthy();

    const anonymousRead = await fetch(`${S3_ENDPOINT}/${S3_BUCKET}/${stagingRow.rows[0]!.storage_key}`);
    expect(anonymousRead.status).toBe(403);

    const accepted = await submitArtifact(upload.artifactId);
    expect(accepted.status).toBe(202);
    expect(accepted.body.state).toBe('ACCEPTED');

    console.info('[T-DATA-LIVE-2] upload=%s bytes=%d partBytes=%d parts=%d ttlMs=%d initReplay=same-artifact completeReplay=same-result stagingSubmit=%d readySubmit=%d privateAnonymousGet=%d',
      upload.artifactId,
      upload.sizeBytes,
      PART_BYTES,
      upload.partCount,
      initTtlMs,
      stagingSubmit.status,
      accepted.status,
      anonymousRead.status,
    );
    console.info('[T-DATA-LIVE-2] RSS process=jest+createApp-http baselineBytes=%d peakBytes=%d deltaBytes=%d sampledAt=%s',
      baselineRssBytes,
      peakRssBytes,
      peakRssBytes - baselineRssBytes,
      peakRssPoint,
    );
  });

  test('enforces 8 GiB multipart ceiling and 1 MiB JSON ingress limit', async () => {
    let sizeFailure: RuntimeError | undefined;
    try {
      await runtimeA.multipartInit(taskA, {
        leaseEpoch: EPOCH,
        uploadToken: randomUUID(),
        purpose: 'output',
        mimeType: 'application/octet-stream',
        fileName: 'over-8gib.bin',
        sizeBytes: SIGNED_MULTIPART_MAX_BYTES + 1,
      });
    } catch (error) {
      if (error instanceof RuntimeError) sizeFailure = error;
      else throw error;
    }
    expect(sizeFailure).toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });

    const prefix = '{"x":"';
    const suffix = '"}';
    const bodyOfExactLength = (length: number) =>
      prefix + 'x'.repeat(length - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) + suffix;
    const atLimit = await fetch(`${baseUrl}/api/v1/businesses/no-such-business/actions/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bodyOfExactLength(SIGNED_JSON_LIMIT_BYTES),
    });
    expect(atLimit.status).not.toBe(413);
    const overLimit = await fetch(`${baseUrl}/api/v1/businesses/no-such-business/actions/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bodyOfExactLength(SIGNED_JSON_LIMIT_BYTES + 1),
    });
    expect(overLimit.status).toBe(413);
    console.info('[T-DATA-LIVE-2] policy maxMultipartBytes=%d overCapStatus=%d jsonLimitBytes=%d exactStatus=%d overStatus=%d',
      SIGNED_MULTIPART_MAX_BYTES,
      sizeFailure!.status,
      SIGNED_JSON_LIMIT_BYTES,
      atLimit.status,
      overLimit.status,
    );
  });

  test('fences multipart lifecycle by artifact business identity and aborts a real S3 part', async () => {
    const opened = await runtimeB.multipartInit(taskB, {
      leaseEpoch: EPOCH,
      uploadToken: randomUUID(),
      purpose: 'output',
      mimeType: 'application/octet-stream',
      fileName: 'data-live2-foreign.bin',
      sizeBytes: LARGE_OBJECT_BYTES,
    });
    let authFailure: RuntimeError | undefined;
    try {
      await runtimeA.multipartPartGrant(opened.artifactId, {
        leaseEpoch: EPOCH,
        partNumber: 1,
        sha256: 'a'.repeat(64),
      });
    } catch (error) {
      if (error instanceof RuntimeError) authFailure = error;
      else throw error;
    }
    expect(authFailure).toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });

    const foreignSubmit = await submitArtifact(opened.artifactId);
    expect(foreignSubmit.status).toBe(404);

    await uploadFirstGrantedPart(runtimeB, opened.artifactId);
    const aborted = await runtimeB.multipartAbort(opened.artifactId, {
      leaseEpoch: EPOCH,
      reason: 'cancelled',
    });
    expect(aborted.state).toBe('ABORTED');
    const abortedRow = await app!.db.query<{ state: string; multipart_upload_id: string | null }>(
      'SELECT state,multipart_upload_id FROM artifacts WHERE id=$1', [opened.artifactId],
    );
    expect(abortedRow.rows[0]).toEqual({ state: 'ABORTED', multipart_upload_id: null });
    console.info('[T-DATA-LIVE-2] workerA-on-businessB=403 foreign-submit=%d abort=%s providerUploadCleared=%s',
      foreignSubmit.status,
      aborted.state,
      String(abortedRow.rows[0]?.multipart_upload_id === null),
    );
  });

  test('TTL sweep reclaims an expired uploaded S3 multipart orphan', async () => {
    const opened = await runtimeA.multipartInit(taskA, {
      leaseEpoch: EPOCH,
      uploadToken: randomUUID(),
      purpose: 'output',
      mimeType: 'application/octet-stream',
      fileName: 'data-live2-orphan.bin',
      sizeBytes: LARGE_OBJECT_BYTES,
    });
    await uploadFirstGrantedPart(runtimeA, opened.artifactId);

    await app!.db.query(
      `UPDATE artifacts SET multipart_expires_at='2000-01-01T00:00:00Z'
       WHERE id=$1 AND state='STAGING' AND multipart_upload_id IS NOT NULL`,
      [opened.artifactId],
    );
    const nextExpired = await app!.db.query<{ id: string }>(
      `SELECT id FROM artifacts WHERE part_count IS NOT NULL
       AND ((state='STAGING' AND multipart_expires_at IS NOT NULL AND multipart_expires_at <= now())
            OR (state='ABORTED' AND multipart_upload_id IS NOT NULL))
       ORDER BY multipart_expires_at LIMIT 1`,
    );
    expect(nextExpired.rows[0]?.id).toBe(opened.artifactId);
    const summary = await liveSweeper!.sweepExpiredSessions({ limit: 1 });
    expect(summary).toEqual({ scanned: 1, aborted: 1, purged: 1, failed: 0 });
    const row = await app!.db.query<{ state: string; abort_reason: string | null; multipart_upload_id: string | null }>(
      'SELECT state,abort_reason,multipart_upload_id FROM artifacts WHERE id=$1', [opened.artifactId],
    );
    expect(row.rows[0]).toEqual({ state: 'ABORTED', abort_reason: 'expired', multipart_upload_id: null });
    console.info('[T-DATA-LIVE-2] ttlSweep scanned=%d aborted=%d purged=%d failed=%d orphanUploadCleared=%s',
      summary.scanned,
      summary.aborted,
      summary.purged,
      summary.failed,
      String(row.rows[0]?.multipart_upload_id === null),
    );
  });

  test('submission rejects expired same-tenant artifacts without accepting a forged ready state', async () => {
    const expiredArtifactId = await seedExpiredReadyArtifact();
    const expiredSubmit = await submitArtifact(expiredArtifactId);
    expect(expiredSubmit.status).toBe(404);
    expect(expiredSubmit.body.code).toBe('NOT_FOUND');
    console.info('[T-DATA-LIVE-2] expiredSubmit=%d code=%s', expiredSubmit.status, String(expiredSubmit.body.code));
  });
});
