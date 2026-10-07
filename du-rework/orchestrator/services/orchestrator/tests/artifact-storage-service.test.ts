import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Db } from '../src/db/db';
import { createArtifactService } from '../src/modules/artifacts/artifacts';
import { createS3ArtifactStorageFacade } from '../src/modules/artifacts/s3-storage-facade';
import {
  ArtifactStorageError,
  type ArtifactStorageFacade,
  type StoredArtifactVersion,
} from '../src/modules/artifacts/storage-facade';
import { absoluteGrantUrl } from '../src/server';
import { PrivateVersionedS3Fixture } from './fixtures/private-versioned-s3-fixture';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const ARTIFACT_ID = '44444444-4444-4444-8444-444444444444';
const STORAGE_KEY = `art-${ARTIFACT_ID}`;
const VERSION = 's3-generation-9';
const BYTES = Buffer.from('s3-backed bytes');
const SHA256 = createHash('sha256').update(BYTES).digest('hex');

interface MemoryArtifact {
  id: string;
  tenantId: string;
  operationId: string;
  taskId: string;
  storageKey: string;
  storageBackend: string;
  storageVersionId: string | null;
  purpose: string;
  fileName: string | null;
  mimeType: string;
  sizeBytes: number;
  state: string;
  token: string;
  tokenMode: string | null;
  tokenExpiresAt: string | null;
  sha256: string | null;
  finalizedLeaseEpoch: number | null;
}

class OfflineArtifactServiceDb {
  readonly task = {
    id: TASK_ID,
    leaseEpoch: 5,
    state: 'RUNNING',
    leaseActive: true,
    tenantId: TENANT_ID,
    operationId: OPERATION_ID,
    submitArtifacts: [],
  };
  readonly artifacts = new Map<string, MemoryArtifact>();
  readonly blobs = new Map<string, Buffer>();
  artifactBlobWrites = 0;
  failAfterNextCommit = false;

  async query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
    return this.execute(text, params ?? []) as unknown as QueryResult<T>;
  }

  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const result = await fn({ query: this.query.bind(this) } as unknown as PoolClient);
    if (this.failAfterNextCommit) {
      this.failAfterNextCommit = false;
      throw new Error('simulated lost response after transaction commit');
    }
    return result;
  }

  private result<T extends QueryResultRow>(rows: T[], command = 'SELECT'): QueryResult<T> {
    return { command, rowCount: rows.length, oid: 0, fields: [], rows };
  }

  private async execute(text: string, params: unknown[]): Promise<QueryResult> {
    const sql = text.replace(/\s+/g, ' ').trim().toUpperCase();
    if (sql.includes('FROM TASKS T JOIN OPERATIONS O')) {
      return this.result([{
        lease_epoch: this.task.leaseEpoch,
        operation_id: this.task.operationId,
        operationId: this.task.operationId,
        tenant_id: this.task.tenantId,
        tenantId: this.task.tenantId,
        state: this.task.state,
        submitArtifacts: this.task.submitArtifacts,
        lease_active: this.task.leaseActive,
      }]);
    }
    if (sql.includes('FROM TASKS WHERE ID=$1')) {
      return this.result([{
        lease_epoch: this.task.leaseEpoch,
        state: this.task.state,
        lease_active: this.task.leaseActive,
      }]);
    }
    if (sql.startsWith('INSERT INTO ARTIFACTS')) {
      const [id, tenantId, operationId, taskId, purpose, fileName, mimeType, sizeBytes, token, tokenExpiresAt, storageKey, storageBackend] = params;
      this.artifacts.set(String(id), {
        id: String(id), tenantId: String(tenantId), operationId: String(operationId), taskId: String(taskId),
        purpose: String(purpose), fileName: fileName === null ? null : String(fileName),
        mimeType: String(mimeType), sizeBytes: Number(sizeBytes),
        token: String(token), tokenMode: 'upload', tokenExpiresAt: String(tokenExpiresAt),
        storageKey: String(storageKey), storageBackend: String(storageBackend), storageVersionId: null,
        state: 'STAGING', sha256: null, finalizedLeaseEpoch: null,
      });
      return this.result([], 'INSERT');
    }
    if (sql.includes('FROM ARTIFACTS A') && sql.includes('STORAGE_KEY=$1')) {
      const artifact = Array.from(this.artifacts.values()).find(
        (row) => row.storageKey === params[0] && row.tenantId === params[1],
      );
      return this.result(artifact ? [{ state: artifact.state, storageBackend: artifact.storageBackend }] : []);
    }
    if (sql.startsWith('INSERT INTO ARTIFACT_BLOBS')) {
      this.artifactBlobWrites += 1;
      this.blobs.set(String(params[0]), Buffer.from(params[2] as Buffer));
      return this.result([], 'INSERT');
    }
    if (sql.startsWith('SELECT BYTES FROM ARTIFACT_BLOBS')) {
      const blob = this.blobs.get(String(params[0]));
      return this.result(blob ? [{ bytes: Buffer.from(blob) }] : []);
    }
    if (sql.startsWith('DELETE FROM ARTIFACT_BLOBS')) {
      this.blobs.delete(String(params[0]));
      return this.result([], 'DELETE');
    }
    if (sql.includes('FROM ARTIFACTS WHERE ID=$1')) {
      const artifact = this.artifacts.get(String(params[0]));
      return this.result(artifact ? [this.project(artifact)] : []);
    }
    if (sql.includes('FROM ARTIFACTS WHERE STORAGE_KEY=$1')) {
      const artifact = Array.from(this.artifacts.values()).find((row) => row.storageKey === params[0]);
      return this.result(artifact ? [this.project(artifact)] : []);
    }
    if (sql.startsWith('UPDATE ARTIFACTS SET TOKEN=')) {
      const artifact = this.artifacts.get(String(params[0]));
      if (artifact) {
        artifact.token = String(params[1]);
        artifact.tokenMode = String(params[2]);
        artifact.tokenExpiresAt = String(params[3]);
      }
      return this.result([], 'UPDATE');
    }
    if (sql.startsWith("UPDATE ARTIFACTS SET STATE='READY'")) {
      const [id, sizeBytes, sha256, taskId, epoch, versionId] = params;
      const artifact = this.artifacts.get(String(id));
      if (!artifact || artifact.state !== 'STAGING' || artifact.taskId !== taskId || this.task.state !== 'RUNNING') {
        return this.result([], 'UPDATE');
      }
      artifact.state = 'READY';
      artifact.sizeBytes = Number(sizeBytes);
      artifact.sha256 = String(sha256);
      artifact.finalizedLeaseEpoch = Number(epoch);
      artifact.storageVersionId = String(versionId);
      return this.result([{ id: artifact.id, state: artifact.state }], 'UPDATE');
    }
    if (sql.startsWith('UPDATE ARTIFACTS SET STORAGE_VERSION_ID=')) {
      const artifact = this.artifacts.get(String(params[0]));
      if (artifact && !artifact.storageVersionId) artifact.storageVersionId = String(params[1]);
      return this.result([], 'UPDATE');
    }
    throw new Error(`Unhandled offline artifact SQL: ${sql}`);
  }

  private project(artifact: MemoryArtifact) {
    return {
      id: artifact.id,
      tenantId: artifact.tenantId,
      operationId: artifact.operationId,
      taskId: artifact.taskId,
      storageKey: artifact.storageKey,
      storageBackend: artifact.storageBackend,
      storageVersionId: artifact.storageVersionId,
      purpose: artifact.purpose,
      fileName: artifact.fileName,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      state: artifact.state,
      token: artifact.token,
      sha256: artifact.sha256,
      finalizedLeaseEpoch: artifact.finalizedLeaseEpoch,
    };
  }
}

function s3Facade(overrides: Partial<ArtifactStorageFacade> = {}): ArtifactStorageFacade {
  const version: StoredArtifactVersion = {
    objectKey: STORAGE_KEY,
    versionId: VERSION,
    sizeBytes: BYTES.byteLength,
    sha256: SHA256,
  };
  return {
    createUploadGrant: jest.fn(async (input) => ({
      url: 'https://s3.test/presigned-put',
      expiresAt: input.expiresAt,
      headers: { 'content-type': input.contentType },
    })),
    verifyAndPin: jest.fn(async (input) => ({ ...version, objectKey: input.objectKey })),
    openRead: jest.fn(async () => Readable.from([BYTES])),
    delete: jest.fn(async () => undefined),
    ...overrides,
  };
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

describe('artifact service storage facade integration (offline)', () => {
  test('keeps presigned S3 URLs intact and absolutizes PostgreSQL proxy URLs', () => {
    expect(absoluteGrantUrl('orchestrator.test', 'https://s3.test/signed?X-Amz-Signature=opaque'))
      .toBe('https://s3.test/signed?X-Amz-Signature=opaque');
    // RFX-11: the Host-derived form is the dev/test fallback only, so the
    // decision is passed explicitly (ambient NODE_ENV may be anything).
    expect(absoluteGrantUrl('orchestrator.test', '/api/runtime/v1/artifacts/blob/key?grant=opaque', { env: { NODE_ENV: 'test' } }))
      .toBe('http://orchestrator.test/api/runtime/v1/artifacts/blob/key?grant=opaque');
  });

  test('RFX-15: the proxy grant TTL is the short hygiene window, not a session-length token', async () => {
    // The grant token rides the blob URL, so its lifetime is the only
    // server-side bound on a leaked access-log entry. Assert the constant is
    // the 2-minute hygiene window (and still comfortably longer than the
    // immediate request-grant -> PUT/GET flow it must serve).
    const db = new OfflineArtifactServiceDb();
    const service = createArtifactService(db as unknown as Db);
    const before = Date.now();
    const grant = await service.requestUpload(TASK_ID, 5, {
      leaseEpoch: 5, purpose: 'output', mimeType: 'application/octet-stream', sizeBytes: BYTES.byteLength,
    });
    const ttlMs = new Date(grant.expiresAt).getTime() - before;
    expect(ttlMs).toBeGreaterThan(30_000);
    expect(ttlMs).toBeLessThanOrEqual(2 * 60 * 1000 + 5_000);
  });

  test('issues a scoped S3 grant and records the selected backend', async () => {
    const db = new OfflineArtifactServiceDb();
    const storage = s3Facade();
    const service = createArtifactService(db as unknown as Db, { storageBackend: 's3', storageFacade: storage });

    const grant = await service.requestUpload(TASK_ID, 5, {
      leaseEpoch: 5,
      purpose: 'output',
      fileName: 'retained-source.pdf',
      mimeType: 'application/pdf',
      sizeBytes: BYTES.byteLength,
    });

    expect(grant).toEqual({ artifactId: expect.any(String), uploadUrl: 'https://s3.test/presigned-put', expiresAt: expect.any(String) });
    expect(storage.createUploadGrant).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: grant.artifactId,
      tenantId: TENANT_ID,
      objectKey: `art-${grant.artifactId}`,
      contentType: 'application/pdf',
      maxBytes: BYTES.byteLength,
    }));
    expect(db.artifacts.get(grant.artifactId)?.storageBackend).toBe('s3');
  });

  test('applies the configured ingress byte cap before asking either backend for a grant', async () => {
    const db = new OfflineArtifactServiceDb();
    const storage = s3Facade();
    const service = createArtifactService(db as unknown as Db, {
      storageBackend: 's3', storageFacade: storage, maxArtifactBytes: 4,
    });

    await expect(service.requestUpload(TASK_ID, 5, {
      leaseEpoch: 5, purpose: 'output', mimeType: 'application/pdf', sizeBytes: 5,
    })).rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
    expect(storage.createUploadGrant).not.toHaveBeenCalled();
    expect(db.artifacts.size).toBe(0);
  });

  test('finalize verifies actual storage bytes and persists the pinned version', async () => {
    const db = new OfflineArtifactServiceDb();
    const storage = s3Facade();
    const service = createArtifactService(db as unknown as Db, { storageBackend: 's3', storageFacade: storage });
    const grant = await service.requestUpload(TASK_ID, 5, {
      leaseEpoch: 5, purpose: 'output', fileName: 'retained-source.pdf',
      mimeType: 'application/pdf', sizeBytes: BYTES.byteLength,
    });

    await expect(service.finalize(grant.artifactId, {
      taskId: TASK_ID, leaseEpoch: 5, sizeBytes: BYTES.byteLength, sha256: SHA256,
    })).resolves.toEqual({ artifactId: grant.artifactId, state: 'READY' });
    expect(storage.verifyAndPin).toHaveBeenCalledWith({
      artifactId: grant.artifactId,
      tenantId: TENANT_ID,
      objectKey: `art-${grant.artifactId}`,
      expectedSizeBytes: BYTES.byteLength,
      expectedSha256: SHA256,
    });
    expect(db.artifacts.get(grant.artifactId)).toMatchObject({
      state: 'READY', storageVersionId: VERSION, sha256: SHA256,
    });
  });

  test('applies owner, lease epoch, task state, and expiry fences before S3 verification', async () => {
    const db = new OfflineArtifactServiceDb();
    const storage = s3Facade();
    const service = createArtifactService(db as unknown as Db, {
      storageBackend: 's3',
      storageFacade: storage,
    });
    const grant = await service.requestUpload(TASK_ID, 5, {
      leaseEpoch: 5,
      purpose: 'output',
      mimeType: 'application/octet-stream',
      sizeBytes: BYTES.byteLength,
    });
    const finalize = (taskId: string, leaseEpoch: number) => service.finalize(grant.artifactId, {
      taskId,
      leaseEpoch,
      sizeBytes: BYTES.byteLength,
      sha256: SHA256,
    });

    await expect(finalize('99999999-9999-4999-8999-999999999999', 5)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(finalize(TASK_ID, 4)).rejects.toMatchObject({ code: 'LEASE_LOST' });

    db.task.leaseActive = false;
    await expect(finalize(TASK_ID, 5)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    db.task.leaseActive = true;

    db.task.state = 'CANCELLED';
    await expect(finalize(TASK_ID, 5)).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    db.task.state = 'RUNNING';

    expect(storage.verifyAndPin).not.toHaveBeenCalled();
    expect(db.artifacts.get(grant.artifactId)?.state).toBe('STAGING');
  });

  test('pins an S3 generation across a late PUT and replays finalize after a lost response', async () => {
    const db = new OfflineArtifactServiceDb();
    const s3 = new PrivateVersionedS3Fixture();
    const storage = createS3ArtifactStorageFacade({
      bucket: s3.bucket,
      client: s3.client,
      presignPut: s3.presignPut,
    });
    const service = createArtifactService(db as unknown as Db, {
      storageBackend: 's3',
      migrationWindow: false,
      storageFacade: storage,
    });
    const grant = await service.requestUpload(TASK_ID, 5, {
      leaseEpoch: 5,
      purpose: 'output',
      fileName: 'result.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: BYTES.byteLength,
    });
    const storageKey = `art-${grant.artifactId}`;
    expect(grant.uploadUrl).toContain('https://s3.private.test/upload/');
    await expect(service.putBlob(storageKey, TENANT_ID, BYTES)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
    });
    expect(db.artifactBlobWrites).toBe(0);

    const firstVersion = await s3.uploadUsingGrant(grant.uploadUrl, BYTES);
    const lateBytes = Buffer.alloc(BYTES.byteLength, 0x7a);
    let lateVersion = '';
    s3.afterHead = ({ objectKey }) => {
      expect(objectKey).toBe(storageKey);
      lateVersion = s3.putLateVersion({
        objectKey,
        artifactId: grant.artifactId,
        tenantId: TENANT_ID,
        bytes: lateBytes,
      });
    };

    db.failAfterNextCommit = true;
    await expect(service.finalize(grant.artifactId, {
      taskId: TASK_ID,
      leaseEpoch: 5,
      sizeBytes: BYTES.byteLength,
      sha256: SHA256,
    })).rejects.toThrow('simulated lost response after transaction commit');

    expect(lateVersion).toBeTruthy();
    expect(db.artifacts.get(grant.artifactId)).toMatchObject({
      state: 'READY',
      storageBackend: 's3',
      storageVersionId: firstVersion,
      sizeBytes: BYTES.byteLength,
      sha256: SHA256,
      finalizedLeaseEpoch: 5,
    });
    expect(s3.getVersions(storageKey)).toEqual([firstVersion, lateVersion]);
    expect(db.artifactBlobWrites).toBe(0);

    const callsBeforeReplay = s3.requests.length;
    await expect(service.finalize(grant.artifactId, {
      taskId: TASK_ID,
      leaseEpoch: 5,
      sizeBytes: BYTES.byteLength,
      sha256: SHA256,
    })).resolves.toEqual({ artifactId: grant.artifactId, state: 'READY' });
    expect(s3.requests).toHaveLength(callsBeforeReplay);

    await expect(collect(await service.getBlob(storageKey))).resolves.toEqual(BYTES);
    expect(s3.requests.filter((request) => request.command === 'get').map((request) => request.versionId))
      .toEqual([firstVersion, firstVersion]);
    expect(s3.requests.every((request) => request.bucket === s3.bucket)).toBe(true);

    await expect(service.finalize(grant.artifactId, {
      taskId: TASK_ID,
      leaseEpoch: 5,
      sizeBytes: BYTES.byteLength,
      sha256: createHash('sha256').update(lateBytes).digest('hex'),
    })).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    expect(db.artifactBlobWrites).toBe(0);

    const sizeMismatchGrant = await service.requestUpload(TASK_ID, 5, {
      leaseEpoch: 5,
      purpose: 'output',
      mimeType: 'application/octet-stream',
      sizeBytes: BYTES.byteLength,
    });
    const oversizedBytes = Buffer.concat([BYTES, Buffer.from('!')]);
    s3.putLateVersion({
      objectKey: `art-${sizeMismatchGrant.artifactId}`,
      artifactId: sizeMismatchGrant.artifactId,
      tenantId: TENANT_ID,
      bytes: oversizedBytes,
    });
    await expect(service.finalize(sizeMismatchGrant.artifactId, {
      taskId: TASK_ID,
      leaseEpoch: 5,
      sizeBytes: BYTES.byteLength,
      sha256: SHA256,
    })).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    expect(db.artifacts.get(sizeMismatchGrant.artifactId)?.state).toBe('STAGING');
    expect(db.artifactBlobWrites).toBe(0);
  });

  test('authorized reads open a stream from the stored pinned version', async () => {
    const db = new OfflineArtifactServiceDb();
    const storage = s3Facade();
    const service = createArtifactService(db as unknown as Db, { storageBackend: 's3', storageFacade: storage });
    const grant = await service.requestUpload(TASK_ID, 5, {
      leaseEpoch: 5, purpose: 'output', fileName: 'retained-source.pdf',
      mimeType: 'application/pdf', sizeBytes: BYTES.byteLength,
    });
    await service.finalize(grant.artifactId, {
      taskId: TASK_ID, leaseEpoch: 5, sizeBytes: BYTES.byteLength, sha256: SHA256,
    });
    const readGrant = await service.requestAccess(grant.artifactId, {
      taskId: TASK_ID, leaseEpoch: 5, mode: 'read',
    });

    expect(readGrant.downloadUrl).toContain(`/art-${grant.artifactId}?grant=`);
    expect(readGrant).toMatchObject({
      fileName: 'retained-source.pdf',
      mimeType: 'application/pdf',
      sizeBytes: BYTES.byteLength,
      sha256: SHA256,
    });
    await expect(collect(await service.getBlob(`art-${grant.artifactId}`))).resolves.toEqual(BYTES);
    expect(storage.openRead).toHaveBeenCalledWith({ objectKey: `art-${grant.artifactId}`, versionId: VERSION });
  });

  test('provider exception text is converted to a safe storage error', async () => {
    const db = new OfflineArtifactServiceDb();
    const storage = s3Facade({
      verifyAndPin: jest.fn(async () => { throw new Error('AKIA_SENTINEL https://secret.invalid/key'); }),
    });
    const service = createArtifactService(db as unknown as Db, { storageBackend: 's3', storageFacade: storage });
    const grant = await service.requestUpload(TASK_ID, 5, {
      leaseEpoch: 5, purpose: 'output', mimeType: 'application/pdf', sizeBytes: BYTES.byteLength,
    });

    let failure: unknown;
    try {
      await service.finalize(grant.artifactId, {
        taskId: TASK_ID, leaseEpoch: 5, sizeBytes: BYTES.byteLength, sha256: SHA256,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ status: 503, code: 'TEMPORARY_UNAVAILABLE' });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain('AKIA_SENTINEL');
    expect((failure as Error).message).not.toContain('secret.invalid');
  });

  test('defaults to the PostgreSQL proxy fallback and pins then streams its content generation', async () => {
    const db = new OfflineArtifactServiceDb();
    const service = createArtifactService(db as unknown as Db);
    const bytes = Buffer.from('postgres fallback bytes');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const grant = await service.requestUpload(TASK_ID, 5, {
      leaseEpoch: 5, purpose: 'output', mimeType: 'application/octet-stream', sizeBytes: bytes.byteLength,
    });
    expect(grant.uploadUrl).toContain('/api/runtime/v1/artifacts/blob/');
    await service.putBlob(`art-${grant.artifactId}`, TENANT_ID, bytes);
    await service.finalize(grant.artifactId, {
      taskId: TASK_ID, leaseEpoch: 5, sizeBytes: bytes.byteLength, sha256: hash,
    });

    expect(db.artifacts.get(grant.artifactId)).toMatchObject({
      storageBackend: 'postgres', storageVersionId: hash, state: 'READY',
    });
    await expect(collect(await service.getBlob(`art-${grant.artifactId}`))).resolves.toEqual(bytes);
  });

  test('migration-window reads prefer a verified S3 copy while the artifact still points to PostgreSQL', async () => {
    const db = new OfflineArtifactServiceDb();
    const legacyBytes = Buffer.from('retained PostgreSQL rollback bytes');
    const legacyHash = createHash('sha256').update(legacyBytes).digest('hex');
    const legacyService = createArtifactService(db as unknown as Db);
    const grant = await legacyService.requestUpload(TASK_ID, 5, {
      leaseEpoch: 5, purpose: 'output', mimeType: 'application/octet-stream', sizeBytes: legacyBytes.byteLength,
    });
    await legacyService.putBlob(`art-${grant.artifactId}`, TENANT_ID, legacyBytes);
    await legacyService.finalize(grant.artifactId, {
      taskId: TASK_ID, leaseEpoch: 5, sizeBytes: legacyBytes.byteLength, sha256: legacyHash,
    });

    const s3Bytes = Buffer.from(legacyBytes);
    const s3 = s3Facade({
      verifyAndPin: jest.fn(async (input) => ({
        objectKey: input.objectKey,
        versionId: 's3-backfill-version-1',
        sizeBytes: s3Bytes.byteLength,
        sha256: createHash('sha256').update(s3Bytes).digest('hex'),
      })),
      openRead: jest.fn(async () => Readable.from([s3Bytes])),
    });
    const migrationWindowService = createArtifactService(db as unknown as Db, {
      storageBackend: 's3', storageFacade: s3, migrationWindow: true,
    });

    await expect(collect(await migrationWindowService.getBlob(`art-${grant.artifactId}`))).resolves.toEqual(s3Bytes);
    expect(s3.verifyAndPin).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: grant.artifactId,
      tenantId: TENANT_ID,
      expectedSizeBytes: legacyBytes.byteLength,
      expectedSha256: legacyHash,
    }));
    expect(s3.openRead).toHaveBeenCalledWith({ objectKey: `art-${grant.artifactId}`, versionId: 's3-backfill-version-1' });
    expect(db.blobs.get(`art-${grant.artifactId}`)).toEqual(legacyBytes);
  });

  test('migration-window mode forces new artifacts and upload grants to S3', async () => {
    const db = new OfflineArtifactServiceDb();
    const s3 = s3Facade();
    const service = createArtifactService(db as unknown as Db, {
      storageBackend: 'postgres',
      storageFacade: s3,
      migrationWindow: true,
    });

    const grant = await service.requestUpload(TASK_ID, 5, {
      leaseEpoch: 5, purpose: 'output', mimeType: 'application/octet-stream', sizeBytes: BYTES.byteLength,
    });

    expect(db.artifacts.get(grant.artifactId)?.storageBackend).toBe('s3');
    expect(s3.createUploadGrant).toHaveBeenCalledTimes(1);
    expect(grant.uploadUrl).toBe('https://s3.test/presigned-put');
  });

  test('migration-window reads fall back to PostgreSQL only when S3 has no object yet', async () => {
    const db = new OfflineArtifactServiceDb();
    const bytes = Buffer.from('legacy PostgreSQL fallback bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const legacyService = createArtifactService(db as unknown as Db);
    const grant = await legacyService.requestUpload(TASK_ID, 5, {
      leaseEpoch: 5, purpose: 'output', mimeType: 'application/octet-stream', sizeBytes: bytes.byteLength,
    });
    await legacyService.putBlob(`art-${grant.artifactId}`, TENANT_ID, bytes);
    await legacyService.finalize(grant.artifactId, {
      taskId: TASK_ID, leaseEpoch: 5, sizeBytes: bytes.byteLength, sha256,
    });
    const s3 = s3Facade({
      verifyAndPin: jest.fn(async () => { throw new ArtifactStorageError('OBJECT_NOT_FOUND'); }),
    });
    const migrationWindowService = createArtifactService(db as unknown as Db, {
      storageBackend: 's3', storageFacade: s3, migrationWindow: true,
    });

    await expect(collect(await migrationWindowService.getBlob(`art-${grant.artifactId}`))).resolves.toEqual(bytes);
    expect(s3.verifyAndPin).toHaveBeenCalledTimes(1);
    expect(s3.openRead).not.toHaveBeenCalled();
  });

  test('missing or closed rollback window keeps writes on S3 and refuses PostgreSQL fallback', async () => {
    const db = new OfflineArtifactServiceDb();
    const bytes = Buffer.from('legacy PostgreSQL bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const legacyService = createArtifactService(db as unknown as Db);
    const legacyGrant = await legacyService.requestUpload(TASK_ID, 5, {
      leaseEpoch: 5, purpose: 'output', mimeType: 'application/octet-stream', sizeBytes: bytes.byteLength,
    });
    await legacyService.putBlob(`art-${legacyGrant.artifactId}`, TENANT_ID, bytes);
    await legacyService.finalize(legacyGrant.artifactId, {
      taskId: TASK_ID, leaseEpoch: 5, sizeBytes: bytes.byteLength, sha256,
    });

    const s3 = s3Facade({
      verifyAndPin: jest.fn(async () => { throw new ArtifactStorageError('OBJECT_NOT_FOUND'); }),
    });
    const defaultS3Service = createArtifactService(db as unknown as Db, {
      storageBackend: 's3', storageFacade: s3,
    });
    const s3OnlyService = createArtifactService(db as unknown as Db, {
      storageBackend: 's3', storageFacade: s3, migrationWindow: false,
    });
    const databaseQuery = jest.spyOn(db, 'query');

    await expect(defaultS3Service.getBlob(`art-${legacyGrant.artifactId}`)).rejects.toMatchObject({
      status: 409,
      code: 'STATE_CONFLICT',
    });
    expect(databaseQuery.mock.calls.filter(([sql]) => String(sql).includes('SELECT BYTES FROM ARTIFACT_BLOBS'))).toHaveLength(0);

    const newGrant = await s3OnlyService.requestUpload(TASK_ID, 5, {
      leaseEpoch: 5, purpose: 'output', mimeType: 'application/octet-stream', sizeBytes: BYTES.byteLength,
    });
    expect(db.artifacts.get(newGrant.artifactId)?.storageBackend).toBe('s3');
    expect(s3.createUploadGrant).toHaveBeenCalledTimes(1);

    await expect(s3OnlyService.getBlob(`art-${legacyGrant.artifactId}`)).rejects.toMatchObject({
      status: 409,
      code: 'STATE_CONFLICT',
    });
    expect(databaseQuery.mock.calls.filter(([sql]) => String(sql).includes('SELECT BYTES FROM ARTIFACT_BLOBS'))).toHaveLength(0);
    expect(s3.verifyAndPin).toHaveBeenCalledTimes(2);
  });
});
