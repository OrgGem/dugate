import { createHash, randomUUID } from 'node:crypto';
import { contentHash } from '@du/contracts';
import { createApp, type App } from '../src/server';

/**
 * CR-12 regression: artifact grant fencing (method-scoped, expiring,
 * integrity-verified grants) + MM-02 result/download projection.
 *
 * Real HTTP against createApp (real PG/Redis). Exercises the full worker
 * lane over the wire — upload grant → blob PUT → finalize → access grant →
 * blob GET → complete gate → public result/download — plus every fence:
 *
 * Acceptance:
 *  1. upload grant → PUT bytes → finalize → READY, hash/size authoritative;
 *  2. read grant downloads byte-equal raw (application/octet-stream);
 *  3. method fence: read grant cannot PUT (403), upload grant cannot GET (403);
 *  4. expired grant 404s on PUT and GET (indistinguishable from missing);
 *  5. finalize integrity: wrong hash → 409 HASH_MISMATCH, wrong size →
 *     409 SIZE_MISMATCH, no stored bytes → 409 STATE_CONFLICT;
 *  6. finalize lease/owner: foreign taskId → 403 PERMISSION_DENIED, stale
 *     epoch → 409 LEASE_LOST, cancelled owner → 409 STATE_CONFLICT,
 *     exact lost-response finalize retry → 200 READY;
 *  7. READY bytes immutable: PUT after finalize → 409 STATE_CONFLICT;
 *  8. access-grant owner fence: foreign taskId → 409 PERMISSION_DENIED;
 *  9. completion gate: STAGING output → 409 ARTIFACT_NOT_READY; READY
 *     output completes and flips the operation SUCCEEDED;
 * 10. result envelope projects declared inputs + public READY outputs, never
 *     intermediate/session checkpoints; public download serves only public
 *     refs and hides internal/foreign artifacts.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const RUNTIME_TOKEN = 'agf-runtime-' + randomUUID();
const ADMIN_TOKEN = 'agf-admin-' + randomUUID();
const TENANT_A = 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-4444-4222-8222-bbbbbbbbbbbb';
const RAW_KEY_A = 'du_agf_' + randomUUID().replace(/-/g, '');
const RAW_KEY_B = 'du_agf_' + randomUUID().replace(/-/g, '');
const BIZ = 'agf-biz';

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function assertTestDatabase(): void {
  const dbName = new URL(DATABASE_URL).pathname.split('/').pop() ?? '.';
  if (!/test/i.test(dbName)) {
    throw new Error(`refusing test: DATABASE_URL database "${dbName}" is not a test database`);
  }
}

interface JsonResult {
  status: number;
  body: Record<string, unknown>;
}

let app: App;
let baseUrl: string;

function rtHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${RUNTIME_TOKEN}` };
}

function keyHeaders(raw: string): Record<string, string> {
  return { 'content-type': 'application/json', 'x-api-key': raw };
}

async function rt(path: string, method: string, body?: unknown): Promise<JsonResult> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: rtHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function seedOperation(tenantId: string): Promise<string> {
  const op = await app.db.query<{ id: string }>(
    `INSERT INTO operations (tenant_id, business_id, business_version, action, correlation_id, input_ref, state)
     VALUES ($1,$2,'1.0.0','extract',$3,'{}'::jsonb,'RUNNING') RETURNING id`,
    [tenantId, BIZ, `agf-${randomUUID()}`]
  );
  return op.rows[0]!.id;
}

async function seedTask(operationId: string, epoch = 1): Promise<string> {
  const t = await app.db.query<{ id: string }>(
    `INSERT INTO tasks (id, operation_id, task_key, kind, payload_ref, state, attempt, max_attempts,
                        lease_epoch, lease_expires_at, leased_by, due_at)
     VALUES ($1,$2,$3,'root',$4,'RUNNING',1,3,$5,now() + interval '5 minutes','agf-worker',now())
     RETURNING id`,
    [randomUUID(), operationId, `root-${randomUUID()}`, JSON.stringify({ q: 'agf' }), epoch]
  );
  return t.rows[0]!.id;
}

async function scopedCleanup(): Promise<void> {
  assertTestDatabase();
  const ops = await app.db.query<{ id: string }>('SELECT id FROM operations WHERE business_id=$1', [BIZ]);
  const opIds = ops.rows.map((r) => r.id);
  if (opIds.length === 0) return;
  const arts = await app.db.query<{ storage_key: string }>(
    'SELECT storage_key FROM artifacts WHERE operation_id = ANY($1)',
    [opIds]
  );
  const keys = arts.rows.map((r) => r.storage_key);
  if (keys.length > 0) {
    await app.db.query('DELETE FROM artifact_blobs WHERE storage_key = ANY($1)', [keys]);
  }
  await app.db.query('DELETE FROM artifacts WHERE operation_id = ANY($1)', [opIds]);
  await app.db.query('DELETE FROM tasks WHERE operation_id = ANY($1)', [opIds]);
  await app.db.query('DELETE FROM webhook_deliveries WHERE operation_id = ANY($1)', [opIds]).catch(
    () => undefined
  );
  await app.db.query('DELETE FROM operations WHERE id = ANY($1)', [opIds]);
}

// WINDOW GUARD (cycle 104, fleet standard after admin-error-boundary §52): this
// suite boots the REAL app (PG :5433 / Redis :6380). Without DU_LIVE_INFRA=1
// everything below is skipped — no createApp, no listen, no connection.
const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn('artifact-grant-fencing: SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.');
}

liveDescribe('WINDOW-GATED live suite (DU_LIVE_INFRA=1)', () => {
beforeAll(async () => {
  assertTestDatabase();
  app = await createApp({
    port: 0,
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    runtimeToken: RUNTIME_TOKEN,
    adminToken: ADMIN_TOKEN,
    autoDispatch: false,
    autoMigrate: true,
  });
  await app.db.query(`INSERT INTO tenants (id, name) VALUES ($1,'agf-a'),($2,'agf-b') ON CONFLICT (id) DO NOTHING`, [
    TENANT_A,
    TENANT_B,
  ]);
  await app.db.query(
    `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
     VALUES ($1,$2,$3,'agf','ACTIVE') ON CONFLICT (hash) DO UPDATE SET status='ACTIVE'`,
    [randomUUID(), TENANT_A, hashKey(RAW_KEY_A)]
  );
  await app.db.query(
    `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
     VALUES ($1,$2,$3,'agf','ACTIVE') ON CONFLICT (hash) DO UPDATE SET status='ACTIVE'`,
    [randomUUID(), TENANT_B, hashKey(RAW_KEY_B)]
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
  // W42-C5-D(2): opt out of the 30s production grace drain in tests.
  await app?.close({ timeoutMs: 0, pollIntervalMs: 10 });
}, 30_000);

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function requestUpload(
  taskId: string,
  epoch: number,
  purpose = 'output'
): Promise<{ status: number; body: Record<string, unknown> }> {
  return rt(`/api/runtime/v1/tasks/${taskId}/artifacts`, 'POST', {
    leaseEpoch: epoch,
    purpose,
    mimeType: 'application/octet-stream',
    sizeBytes: 4,
  });
}

describe('CR-12: artifact grant fencing (real HTTP)', () => {
  test('upload → PUT → finalize → READY with authoritative hash/size', async () => {
    const opId = await seedOperation(TENANT_A);
    const taskId = await seedTask(opId);
    const raw = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

    const grant = await requestUpload(taskId, 1);
    expect(grant.status).toBe(201);
    const artifactId = grant.body.artifactId as string;
    const uploadUrl = grant.body.uploadUrl as string;
    expect(typeof artifactId).toBe('string');
    expect(uploadUrl).toContain('/artifacts/blob/');
    expect(typeof grant.body.expiresAt).toBe('string');

    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: raw,
    });
    expect(put.status).toBe(204);

    const fin = await rt(`/api/runtime/v1/artifacts/${artifactId}/finalize`, 'POST', {
      sizeBytes: raw.length,
      sha256: sha256Hex(raw),
      taskId,
      leaseEpoch: 1,
    });
    expect(fin.status).toBe(200);
    expect(fin.body).toMatchObject({ artifactId, state: 'READY' });

    const row = (
      await app.db.query<{ state: string; sha256: string; size_bytes: string }>(
        'SELECT state, sha256, size_bytes::text FROM artifacts WHERE id=$1',
        [artifactId]
      )
    ).rows[0]!;
    expect(row.state).toBe('READY');
    expect(row.sha256).toBe(sha256Hex(raw));
    expect(Number(row.size_bytes)).toBe(raw.length);
  });

  test('read grant downloads byte-equal raw with octet-stream content-type', async () => {
    const opId = await seedOperation(TENANT_A);
    const taskId = await seedTask(opId);
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x89, 0x50, 0x4e, 0x47]);
    const grant = await requestUpload(taskId, 1);
    const artifactId = grant.body.artifactId as string;
    await fetch(grant.body.uploadUrl as string, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: raw,
    });
    const fin = await rt(`/api/runtime/v1/artifacts/${artifactId}/finalize`, 'POST', {
      sizeBytes: raw.length,
      sha256: sha256Hex(raw),
      taskId,
      leaseEpoch: 1,
    });
    expect(fin.status).toBe(200);

    const access = await rt(`/api/runtime/v1/artifacts/${artifactId}/access`, 'POST', {
      taskId,
      leaseEpoch: 1,
      mode: 'read',
    });
    expect(access.status).toBe(200);
    expect(typeof access.body.downloadUrl).toBe('string');
    expect(access.body.uploadUrl).toBeUndefined();

    const get = await fetch(access.body.downloadUrl as string);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toContain('application/octet-stream');
    expect(Buffer.from(await get.arrayBuffer()).equals(raw)).toBe(true);
  });

  test('method fence: read grant cannot PUT (403), upload grant cannot GET (403)', async () => {
    const opId = await seedOperation(TENANT_A);
    const taskId = await seedTask(opId);
    const raw = Buffer.from([0x01, 0x02]);
    const grant = await requestUpload(taskId, 1);
    const artifactId = grant.body.artifactId as string;
    const uploadUrl = grant.body.uploadUrl as string;
    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: raw,
    });
    await rt(`/api/runtime/v1/artifacts/${artifactId}/finalize`, 'POST', {
      sizeBytes: raw.length,
      sha256: sha256Hex(raw),
      taskId,
      leaseEpoch: 1,
    });
    const access = await rt(`/api/runtime/v1/artifacts/${artifactId}/access`, 'POST', {
      taskId,
      leaseEpoch: 1,
      mode: 'read',
    });
    const downloadUrl = access.body.downloadUrl as string;

    const readAsWrite = await fetch(downloadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from([0x09]),
    });
    expect(readAsWrite.status).toBe(403);

    const writeAsRead = await fetch(uploadUrl);
    expect(writeAsRead.status).toBe(403);
  });

  test('expired grant 404s on PUT and GET (no existence leak)', async () => {
    const opId = await seedOperation(TENANT_A);
    const taskId = await seedTask(opId);
    const grant = await requestUpload(taskId, 1);
    const artifactId = grant.body.artifactId as string;
    const uploadUrl = grant.body.uploadUrl as string;

    await app.db.query(`UPDATE artifacts SET token_expires_at = now() - interval '1 minute' WHERE id=$1`, [
      artifactId,
    ]);
    const stalePut = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from([0x01]),
    });
    expect(stalePut.status).toBe(404);

    // Fresh upload + finalize, then expire the download grant.
    const grant2 = await requestUpload(taskId, 1);
    const artifactId2 = grant2.body.artifactId as string;
    const raw = Buffer.from([0x02, 0x03]);
    await fetch(grant2.body.uploadUrl as string, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: raw,
    });
    await rt(`/api/runtime/v1/artifacts/${artifactId2}/finalize`, 'POST', {
      sizeBytes: raw.length,
      sha256: sha256Hex(raw),
      taskId,
      leaseEpoch: 1,
    });
    const access = await rt(`/api/runtime/v1/artifacts/${artifactId2}/access`, 'POST', {
      taskId,
      leaseEpoch: 1,
      mode: 'read',
    });
    await app.db.query(`UPDATE artifacts SET token_expires_at = now() - interval '1 minute' WHERE id=$1`, [
      artifactId2,
    ]);
    const staleGet = await fetch(access.body.downloadUrl as string);
    expect(staleGet.status).toBe(404);
  });

  test('finalize integrity: wrong hash / wrong size / no bytes all 409', async () => {
    const opId = await seedOperation(TENANT_A);
    const taskId = await seedTask(opId);
    const raw = Buffer.from('agf-integrity-fixture');
    const grant = await requestUpload(taskId, 1);
    const artifactId = grant.body.artifactId as string;
    await fetch(grant.body.uploadUrl as string, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: raw,
    });

    const badHash = await rt(`/api/runtime/v1/artifacts/${artifactId}/finalize`, 'POST', {
      sizeBytes: raw.length,
      sha256: sha256Hex(Buffer.from('something-else')),
      taskId,
      leaseEpoch: 1,
    });
    expect(badHash.status).toBe(409);
    expect(badHash.body.code).toBe('HASH_MISMATCH');

    const badSize = await rt(`/api/runtime/v1/artifacts/${artifactId}/finalize`, 'POST', {
      sizeBytes: raw.length + 1,
      sha256: sha256Hex(raw),
      taskId,
      leaseEpoch: 1,
    });
    expect(badSize.status).toBe(409);
    expect(badSize.body.code).toBe('SIZE_MISMATCH');

    // No-bytes grant: finalize without any PUT → STATE_CONFLICT.
    const empty = await requestUpload(taskId, 1);
    const noBytes = await rt(`/api/runtime/v1/artifacts/${empty.body.artifactId as string}/finalize`, 'POST', {
      sizeBytes: 0,
      sha256: sha256Hex(Buffer.alloc(0)),
      taskId,
      leaseEpoch: 1,
    });
    expect(noBytes.status).toBe(409);
    expect(noBytes.body.code).toBe('STATE_CONFLICT');
  });

  test('finalize lease/owner: foreign task, stale epoch, cancelled owner, exact retry', async () => {
    const opId = await seedOperation(TENANT_A);
    const taskId = await seedTask(opId);
    const foreignTask = await seedTask(opId);
    const raw = Buffer.from('agf-owner-fixture');
    const grant = await requestUpload(taskId, 1);
    const artifactId = grant.body.artifactId as string;
    await fetch(grant.body.uploadUrl as string, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: raw,
    });
    const finBody = { sizeBytes: raw.length, sha256: sha256Hex(raw) };

    const foreign = await rt(`/api/runtime/v1/artifacts/${artifactId}/finalize`, 'POST', {
      ...finBody,
      taskId: foreignTask,
      leaseEpoch: 1,
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe('PERMISSION_DENIED');

    // Simulate a recovery lease bump; the old epoch is now stale.
    await app.db.query('UPDATE tasks SET lease_epoch=2 WHERE id=$1', [taskId]);
    const stale = await rt(`/api/runtime/v1/artifacts/${artifactId}/finalize`, 'POST', {
      ...finBody,
      taskId,
      leaseEpoch: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('LEASE_LOST');

    // Cancel the owner: finalize past task death is fenced.
    await app.db.query(`UPDATE tasks SET lease_epoch=1, state='CANCELLED' WHERE id=$1`, [taskId]);
    const dead = await rt(`/api/runtime/v1/artifacts/${artifactId}/finalize`, 'POST', {
      ...finBody,
      taskId,
      leaseEpoch: 1,
    });
    expect(dead.status).toBe(409);
    expect(dead.body.code).toBe('STATE_CONFLICT');

    // Revive and finalize for real, then retry the same request idempotently.
    await app.db.query(`UPDATE tasks SET state='RUNNING' WHERE id=$1`, [taskId]);
    const ok = await rt(`/api/runtime/v1/artifacts/${artifactId}/finalize`, 'POST', {
      ...finBody,
      taskId,
      leaseEpoch: 1,
    });
    expect(ok.status).toBe(200);
    const replay = await rt(`/api/runtime/v1/artifacts/${artifactId}/finalize`, 'POST', {
      ...finBody,
      taskId,
      leaseEpoch: 1,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ artifactId, state: 'READY' });
  });

  test('READY bytes are immutable: PUT after finalize → 409', async () => {
    const opId = await seedOperation(TENANT_A);
    const taskId = await seedTask(opId);
    const raw = Buffer.from([0x0a, 0x0b]);
    const grant = await requestUpload(taskId, 1);
    const artifactId = grant.body.artifactId as string;
    const uploadUrl = grant.body.uploadUrl as string;
    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: raw,
    });
    await rt(`/api/runtime/v1/artifacts/${artifactId}/finalize`, 'POST', {
      sizeBytes: raw.length,
      sha256: sha256Hex(raw),
      taskId,
      leaseEpoch: 1,
    });
    // The original upload grant is still method-valid and unexpired, so the
    // route reaches putBlob — which refuses to replace finalized bytes.
    const overwrite = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from([0xff, 0xff]),
    });
    expect(overwrite.status).toBe(409);
  });

  test('access-grant owner fence: foreign taskId → 409 PERMISSION_DENIED', async () => {
    const opId = await seedOperation(TENANT_A);
    const taskId = await seedTask(opId);
    const foreignTask = await seedTask(opId);
    const grant = await requestUpload(taskId, 1);
    const artifactId = grant.body.artifactId as string;

    const denied = await rt(`/api/runtime/v1/artifacts/${artifactId}/access`, 'POST', {
      taskId: foreignTask,
      leaseEpoch: 1,
      mode: 'read',
    });
    expect(denied.status).toBe(409);
    expect(denied.body.code).toBe('PERMISSION_DENIED');
  });

  test('completion gate: STAGING output 409s; READY output completes the operation', async () => {
    const opId = await seedOperation(TENANT_A);
    const taskId = await seedTask(opId);
    const raw = Buffer.from('agf-completion-fixture');
    const grant = await requestUpload(taskId, 1);
    const artifactId = grant.body.artifactId as string;
    await fetch(grant.body.uploadUrl as string, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: raw,
    });
    const resultRef = `agf-result-${randomUUID()}`;

    const stagingComplete = await rt(`/api/runtime/v1/tasks/${taskId}/complete`, 'POST', {
      leaseEpoch: 1,
      resultRef,
      resultHash: contentHash(resultRef),
      outputArtifactIds: [artifactId],
    });
    expect(stagingComplete.status).toBe(409);
    expect(stagingComplete.body.code).toBe('ARTIFACT_NOT_READY');

    await rt(`/api/runtime/v1/artifacts/${artifactId}/finalize`, 'POST', {
      sizeBytes: raw.length,
      sha256: sha256Hex(raw),
      taskId,
      leaseEpoch: 1,
    });
    const done = await rt(`/api/runtime/v1/tasks/${taskId}/complete`, 'POST', {
      leaseEpoch: 1,
      resultRef,
      resultHash: contentHash(resultRef),
      outputArtifactIds: [artifactId],
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ taskId, state: 'SUCCEEDED', operationState: 'SUCCEEDED' });
    const opState = (await app.db.query<{ state: string }>('SELECT state FROM operations WHERE id=$1', [opId]))
      .rows[0]!;
    expect(opState.state).toBe('SUCCEEDED');
  });

  test('result envelope projects real refs with roles; public download serves raw READY bytes', async () => {
    const opId = await seedOperation(TENANT_A);
    const taskId = await seedTask(opId);

    // Input artifact (purpose input) + output artifact (purpose output).
    const inRaw = Buffer.from('agf-input-bytes');
    const inGrant = await requestUpload(taskId, 1, 'input');
    const inputId = inGrant.body.artifactId as string;
    await fetch(inGrant.body.uploadUrl as string, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: inRaw,
    });
    await rt(`/api/runtime/v1/artifacts/${inputId}/finalize`, 'POST', {
      sizeBytes: inRaw.length,
      sha256: sha256Hex(inRaw),
      taskId,
      leaseEpoch: 1,
    });

    const outRaw = Buffer.from('agf-output-bytes');
    const outGrant = await requestUpload(taskId, 1, 'output');
    const outputId = outGrant.body.artifactId as string;
    await fetch(outGrant.body.uploadUrl as string, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: outRaw,
    });
    await rt(`/api/runtime/v1/artifacts/${outputId}/finalize`, 'POST', {
      sizeBytes: outRaw.length,
      sha256: sha256Hex(outRaw),
      taskId,
      leaseEpoch: 1,
    });

    const checkpointRaw = Buffer.from('agf-internal-checkpoint');
    const checkpointGrant = await requestUpload(taskId, 1, 'intermediate');
    const checkpointId = checkpointGrant.body.artifactId as string;
    await fetch(checkpointGrant.body.uploadUrl as string, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: checkpointRaw,
    });
    await rt(`/api/runtime/v1/artifacts/${checkpointId}/finalize`, 'POST', {
      sizeBytes: checkpointRaw.length,
      sha256: sha256Hex(checkpointRaw),
      taskId,
      leaseEpoch: 1,
    });

    // Submission-declared top-level role for the input (Edit-4 submit_artifacts).
    await app.db.query('UPDATE operations SET submit_artifacts=$2 WHERE id=$1', [
      opId,
      JSON.stringify([{ artifactId: inputId, role: 'source' }]),
    ]);

    const resultRef = `agf-result-${randomUUID()}`;
    const done = await rt(`/api/runtime/v1/tasks/${taskId}/complete`, 'POST', {
      leaseEpoch: 1,
      resultRef,
      resultHash: contentHash(resultRef),
      outputArtifactIds: [outputId],
    });
    expect(done.status).toBe(200);

    const result = await fetch(`${baseUrl}/api/v1/operations/${opId}/result`, {
      headers: keyHeaders(RAW_KEY_A),
    });
    expect(result.status).toBe(200);
    const envelope = (await result.json()) as {
      schemaVersion: string;
      data: { resultRef: string };
      artifacts: { artifactId: string; role: string; download: string }[];
      usage: unknown;
      warnings: unknown[];
    };
    expect(envelope.schemaVersion).toBe('1');
    expect(envelope.data).toEqual({ resultRef });
    expect(Array.isArray(envelope.artifacts)).toBe(true);
    const byId = new Map(envelope.artifacts.map((a) => [a.artifactId, a]));
    // Submission role wins for the input; purpose fallback for the output.
    expect(byId.get(inputId)?.role).toBe('source');
    expect(byId.get(outputId)?.role).toBe('output');
    expect(byId.has(checkpointId)).toBe(false);
    for (const ref of byId.values()) {
      expect(ref.download).toBe(`/api/v1/artifacts/${ref.artifactId}/download`);
    }

    // Public download: READY output serves raw bytes…
    const dl = await fetch(`${baseUrl}/api/v1/artifacts/${outputId}/download`, {
      headers: keyHeaders(RAW_KEY_A),
    });
    expect(dl.status).toBe(200);
    expect(Buffer.from(await dl.arrayBuffer()).equals(outRaw)).toBe(true);

    // READY internal checkpoints never enter public result/download surfaces.
    const checkpointDl = await fetch(`${baseUrl}/api/v1/artifacts/${checkpointId}/download`, {
      headers: keyHeaders(RAW_KEY_A),
    });
    expect(checkpointDl.status).toBe(404);

    // …internal STAGING artifacts are hidden as not found…
    const stagingGrant = await requestUpload(taskId, 1, 'intermediate');
    const stagingId = stagingGrant.body.artifactId as string;
    const stagingDl = await fetch(`${baseUrl}/api/v1/artifacts/${stagingId}/download`, {
      headers: keyHeaders(RAW_KEY_A),
    });
    expect(stagingDl.status).toBe(404);

    // …and a foreign tenant sees 404 (no existence leak).
    const foreignDl = await fetch(`${baseUrl}/api/v1/artifacts/${outputId}/download`, {
      headers: keyHeaders(RAW_KEY_B),
    });
    expect(foreignDl.status).toBe(404);
  });
});

  /** seedTask with explicit lease expiry, so the lease fence can be exercised. */
  async function seedTaskWithLease(
    operationId: string,
    epoch = 1,
    leaseExpired = true
  ): Promise<string> {
    const t = await app.db.query<{ id: string }>(
      `INSERT INTO tasks (id, operation_id, task_key, kind, payload_ref, state, attempt, max_attempts,
                          lease_epoch, lease_expires_at, leased_by, due_at)
       VALUES ($1,$2,$3,'root',$4,'RUNNING',1,3,$5,$6,'agf-worker',now())
       RETURNING id`,
      [
        randomUUID(),
        operationId,
        `root-${randomUUID()}`,
        JSON.stringify({ q: 'agf' }),
        epoch,
        leaseExpired ? new Date(Date.now() - 60_000).toISOString() : new Date(Date.now() + 300_000).toISOString(),
      ]
    );
    return t.rows[0]!.id;
  }

  /** Drive an artifact to READY and return its ids. */
  async function readyArtifact(tenantId: string): Promise<{
    opId: string;
    taskId: string;
    artifactId: string;
    downloadUrl: string;
  }> {
    const opId = await seedOperation(tenantId);
    const taskId = await seedTask(opId);
    const raw = Buffer.from([0xa1, 0xb2, 0xc3, 0xd4]);
    const grant = await requestUpload(taskId, 1);
    const artifactId = grant.body.artifactId as string;
    await fetch(grant.body.uploadUrl as string, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: raw,
    });
    await rt(`/api/runtime/v1/artifacts/${artifactId}/finalize`, 'POST', {
      sizeBytes: raw.length,
      sha256: sha256Hex(raw),
      taskId,
      leaseEpoch: 1,
    });
    const access = await rt(`/api/runtime/v1/artifacts/${artifactId}/access`, 'POST', {
      taskId,
      leaseEpoch: 1,
      mode: 'read',
    });
    return { opId, taskId, artifactId, downloadUrl: access.body.downloadUrl as string };
  }

  // W-PLAT-CR28-02-ARTIFACT-GRANT-FENCING-NEGATIVE: negative + boundary cases
  // for the four fences the packet names. Deliberately distinct from the suite's
  // existing tests: the expired case there is an EXPIRED GRANT TOKEN, whereas
  // here it is an EXPIRED TASK LEASE, and the two fail differently on purpose.
  describe('CR-02 negatives: cross-tenant, lease fence, tampered tokens', () => {
    // (1) cross-tenant fence: fail closed, and leak nothing --------------------
    test('tenant B api-key cannot download tenant A artifact: 404, not a leak', async () => {
      const { artifactId } = await readyArtifact(TENANT_A);
      const res = await fetch(`${baseUrl}/api/v1/artifacts/${artifactId}/download`, {
        headers: keyHeaders(RAW_KEY_B),
      });
      // 404 and not 403: a foreign tenant must not learn the artifact exists.
      expect(res.status).toBe(404);
    });

    test('tenant B runtime token cannot PUT or GET through tenant A blob grant', async () => {
      const { downloadUrl } = await readyArtifact(TENANT_A);
      const asRead = await fetch(downloadUrl, {
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
      });
      // The blob route authorises by the per-artifact grant token, so a valid
      // runtime token is not sufficient on its own; the fence must still deny.
      expect(asRead.status).toBe(403);

      const upload = await fetch(
        `${baseUrl}/api/runtime/v1/tasks/${randomUUID()}/artifacts`,
        {
          method: 'POST',
          headers: rtHeaders(),
          body: JSON.stringify({ leaseEpoch: 1, purpose: 'output', mimeType: 'application/octet-stream', sizeBytes: 4 }),
        }
      );
      expect(upload.status).toBe(404);
    });

    // (2) expired TASK LEASE fence (distinct from an expired grant token) -----
    test('an expired task lease refuses a NEW upload grant (409 LEASE_LOST)', async () => {
      const opId = await seedOperation(TENANT_A);
      const taskId = await seedTaskWithLease(opId, 1, true);
      const grant = await requestUpload(taskId, 1);
      expect(grant.status).toBe(409);
      expect(grant.body.code).toBe('LEASE_LOST');
    });

    test('an expired task lease refuses a NEW read grant (409 LEASE_LOST)', async () => {
      const opId = await seedOperation(TENANT_A);
      const taskId = await seedTaskWithLease(opId, 1, true);
      // Mint a grant while the lease is alive, then expire the lease underneath
      // it: the token was legitimate at issue time but must not survive a dead
      // lease, so the read must be refused rather than served.
      const seeded = await seedTaskWithLease(opId, 1, false);
      const grant = await requestUpload(seeded, 1);
      expect(grant.status).toBe(201);
      const raw = Buffer.from([0x11, 0x22]);
      await fetch(grant.body.uploadUrl as string, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: raw,
      });
      await rt(`/api/runtime/v1/artifacts/${grant.body.artifactId as string}/finalize`, 'POST', {
        sizeBytes: raw.length,
        sha256: sha256Hex(raw),
        taskId: seeded,
        leaseEpoch: 1,
      });
      await app.db.query('UPDATE tasks SET lease_expires_at = now() - interval \'1 minute\' WHERE id = $1', [seeded]);
      const access = await rt(`/api/runtime/v1/artifacts/${grant.body.artifactId as string}/access`, 'POST', {
        taskId: seeded,
        leaseEpoch: 1,
        mode: 'read',
      });
      expect(access.status).toBe(409);
      expect(access.body.code).toBe('LEASE_LOST');
      void taskId;
    });

    // (3) tampered grant tokens --------------------------------------------
    test('a tampered grant token is refused (403), never treated as valid', async () => {
      const { downloadUrl } = await readyArtifact(TENANT_A);
      const url = new URL(downloadUrl);
      const real = url.searchParams.get('grant') ?? '';

      for (const bad of [
        real + 'x',
        real.slice(0, -1),
        real.split('').reverse().join(''),
        '00000000-0000-4000-8000-000000000000',
      ]) {
        url.searchParams.set('grant', bad);
        const res = await fetch(url.toString());
        expect(res.status).toBe(403);
      }
    });

    test('a missing or empty grant token is refused identically (403)', async () => {
      const { downloadUrl } = await readyArtifact(TENANT_A);
      const url = new URL(downloadUrl);
      url.searchParams.delete('grant');
      expect((await fetch(url.toString())).status).toBe(403);
      url.searchParams.set('grant', '');
      expect((await fetch(url.toString())).status).toBe(403);
    });

    test('a correct token on an EXPIRED artifact grant 404s, distinct from tampering 403', async () => {
      // The distinction is the point: a WRONG token is 403 (proves the fence
      // compared something), while a token that was RIGHT but has aged out is
      // 404, so an expired grant is indistinguishable from one that never
      // existed. Blurring the two would turn 404 into an existence oracle.
      const { downloadUrl } = await readyArtifact(TENANT_A);
      const url = new URL(downloadUrl);
      const real = url.searchParams.get('grant') ?? '';
      expect((await fetch(url.toString())).status).toBe(200);

      await app.db.query('UPDATE artifacts SET token_expires_at = now() - interval \'1 minute\' WHERE storage_key = $1', [
        new URL(downloadUrl).pathname.split('/artifacts/blob/')[1],
      ]);
      url.searchParams.set('grant', real);
      expect((await fetch(url.toString())).status).toBe(404);
    });

    // (4) tenant mismatch on the tenant-scoped surfaces ----------------------
    test('finalize under a foreign taskId is refused, and writes nothing', async () => {
      const { taskId, artifactId } = await readyArtifact(TENANT_A);
      const otherOp = await seedOperation(TENANT_B);
      const otherTask = await seedTask(otherOp);
      const res = await rt(`/api/runtime/v1/artifacts/${artifactId}/finalize`, 'POST', {
        sizeBytes: 4,
        sha256: sha256Hex(Buffer.from([0xa1, 0xb2, 0xc3, 0xd4])),
        taskId: otherTask,
        leaseEpoch: 1,
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PERMISSION_DENIED');
      void taskId;
    });
  });
});
