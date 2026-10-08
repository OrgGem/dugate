import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { createArtifactService } from '../src/modules/artifacts/artifacts';
import { CryptoStorageFacade } from '../src/modules/encryption/crypto-storage-facade';
import type {
  ArtifactStorageFacade,
  ArtifactStorageUploadGrant,
  StoredArtifactVersion,
  VerifyAndPinArtifactInput,
  ArtifactUploadGrantInput,
} from '../src/modules/artifacts/storage-facade';

interface PublicRow {
  id: string;
  tenantId: string;
  storageKey: string;
  storageBackend: string;
  uploadToken: string;
  storageVersionId: string | null;
  manifestVersionId: string | null;
  state: string;
  abortReason: string | null;
  sizeBytes: number;
  sha256: string;
}

class PublicArtifactDb {
  readonly rows = new Map<string, PublicRow>();
  failManifestPin = false;

  query = async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> => {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    const result = <R extends QueryResultRow>(rows: R[], rowCount = rows.length, command = 'SELECT') => ({
      command,
      rowCount,
      oid: 0,
      fields: [],
      rows,
    }) as QueryResult<R>;
    if (normalized.startsWith('insert into artifacts')) {
      const [id, tenantId, fileName, mimeType, sizeBytes, sha256, , storageKey, backend, uploadToken] = params;
      this.rows.set(String(id), {
        id: String(id), tenantId: String(tenantId), storageKey: String(storageKey),
        storageBackend: String(backend), uploadToken: String(uploadToken),
        storageVersionId: null, manifestVersionId: null, state: 'STAGING', abortReason: null,
        sizeBytes: Number(sizeBytes), sha256: String(sha256),
      });
      void fileName;
      void mimeType;
      return result<T>([], 1, 'INSERT');
    }
    if (normalized.startsWith('select id, upload_token as "uploadtoken" from artifacts')) {
      const row = [...this.rows.values()].find((candidate) =>
        candidate.storageKey === params[0] && candidate.tenantId === params[1] && candidate.state === 'STAGING');
      return result<T>(row ? [{ id: row.id, uploadToken: row.uploadToken } as unknown as T] : []);
    }
    if (normalized.startsWith('update artifacts set storage_version_id=')) {
      const row = this.rows.get(String(params[0]));
      if (!row || row.tenantId !== params[2] || row.uploadToken !== params[3] || row.state !== 'STAGING') {
        return result<T>([], 0, 'UPDATE');
      }
      row.storageVersionId = String(params[1]);
      return result<T>([], 1, 'UPDATE');
    }
    if (normalized.startsWith('update artifacts set manifest_version_id=')) {
      const row = this.rows.get(String(params[0]));
      if (this.failManifestPin || !row || row.tenantId !== params[2] || row.uploadToken !== params[3] || row.state !== 'STAGING') {
        return result<T>([], 0, 'UPDATE');
      }
      row.manifestVersionId = String(params[1]);
      return result<T>([], 1, 'UPDATE');
    }
    if (normalized.startsWith('select id, upload_token as "uploadtoken", storage_version_id as "storageversionid"')) {
      const row = this.rows.get(String(params[0]));
      return result<T>(row && row.tenantId === params[1] && row.state === 'STAGING'
        ? [{
            id: row.id,
            uploadToken: row.uploadToken,
            storageVersionId: row.storageVersionId,
            manifestVersionId: row.manifestVersionId,
          } as unknown as T]
        : []);
    }
    if (normalized.startsWith("update artifacts set state='ready'")) {
      const row = this.rows.get(String(params[0]));
      if (!row || row.tenantId !== params[2] || row.state !== 'STAGING') return result<T>([], 0, 'UPDATE');
      row.storageVersionId = String(params[1]);
      row.state = 'READY';
      return result<T>([{ id: row.id } as unknown as T], 1, 'UPDATE');
    }
    if (normalized.startsWith("update artifacts set state='aborted'")) {
      const row = this.rows.get(String(params[0]));
      if (!row || row.tenantId !== params[3]) return result<T>([], 0, 'UPDATE');
      row.state = 'ABORTED';
      row.abortReason = 'failed';
      if (params[1] !== null && params[1] !== undefined) row.storageVersionId = String(params[1]);
      if (params[2] !== null && params[2] !== undefined) row.manifestVersionId = String(params[2]);
      return result<T>([], 1, 'UPDATE');
    }
    if (normalized.includes('from artifacts') && normalized.includes('for update')) {
      const row = this.rows.get(String(params[0]));
      return result<T>(row && row.tenantId === params[1]
        ? [{ ...row } as unknown as T]
        : []);
    }
    if (normalized.startsWith('select exists (')) return result<T>([{ linked: false } as unknown as T]);
    if (normalized.startsWith('delete from artifacts')) {
      const row = this.rows.get(String(params[0]));
      if (row && row.tenantId === params[1] && row.state === 'ABORTED') this.rows.delete(row.id);
      return result<T>([], 1, 'DELETE');
    }
    throw new Error(`Unhandled public-artifact test SQL: ${normalized}`);
  };

  tx = async <T>(callback: (client: PoolClient) => Promise<T>): Promise<T> =>
    callback({ query: this.query } as unknown as PoolClient);
}

class MemoryVersionedStore implements ArtifactStorageFacade {
  readonly objects = new Map<string, Map<string, Buffer>>();
  readonly writes: { key: string; version: string; bytes: Buffer }[] = [];
  readonly deletes: { key: string; version: string }[] = [];
  private nextVersion = 0;

  async createUploadGrant(_input: ArtifactUploadGrantInput): Promise<ArtifactStorageUploadGrant> {
    throw new Error('not used');
  }
  async verifyAndPin(_input: VerifyAndPinArtifactInput): Promise<StoredArtifactVersion> {
    throw new Error('not used');
  }
  async openRead(input: { objectKey: string; versionId: string }): Promise<Readable> {
    const value = this.objects.get(input.objectKey)?.get(input.versionId);
    if (!value) throw new Error('missing version');
    return Readable.from([value]);
  }
  async delete(input: { objectKey: string; versionId: string }): Promise<void> {
    this.deletes.push({ key: input.objectKey, version: input.versionId });
    this.objects.get(input.objectKey)?.delete(input.versionId);
  }
  async putServerObject(input: { objectKey: string; tenantId: string; body: Buffer }): Promise<{ versionId: string }> {
    void input.tenantId;
    const versionId = `s3-version-${++this.nextVersion}`;
    const versions = this.objects.get(input.objectKey) ?? new Map<string, Buffer>();
    versions.set(versionId, Buffer.from(input.body));
    this.objects.set(input.objectKey, versions);
    this.writes.push({ key: input.objectKey, version: versionId, bytes: Buffer.from(input.body) });
    return { versionId };
  }
  async readServerObject(objectKey: string): Promise<Buffer> {
    const versions = this.objects.get(objectKey);
    const latest = versions ? [...versions.values()].at(-1) : undefined;
    if (!latest) throw new Error('missing sidecar');
    return Buffer.from(latest);
  }
}

function testCrypto() {
  return new CryptoStorageFacade({
    async wrapDek(input) {
      return {
        keyRef: input.keyRef,
        keyVersion: input.keyVersion ?? 1,
        ciphertext: Buffer.from(input.dek).toString('base64'),
      };
    },
    async unwrapDek(input) { return Buffer.from(input.ciphertext, 'base64'); },
  });
}

describe('WFA API encrypted inline artifact storage', () => {
  it('marks worker upload grants for server-side sealing only when the encrypted proxy path is active', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('FROM tasks t JOIN operations o')) {
        return {
          rowCount: 1,
          rows: [{ lease_epoch: 1, operation_id: 'operation-a', tenant_id: 'tenant-a', state: 'RUNNING', lease_active: true }],
        };
      }
      return { rowCount: 1, rows: [] };
    });
    const service = createArtifactService({ query } as unknown as Db, {
      storageBackend: 'postgres',
      encryption: { facade: testCrypto(), keyRef: 'test-artifact-key', required: true },
    });

    const grant = await service.requestUpload('task-a', 1, {
      leaseEpoch: 1,
      purpose: 'intermediate',
      mimeType: 'application/json',
      sizeBytes: 128,
    });

    expect(grant.storageEncryption).toBe('server');
    expect(grant.uploadUrl).toContain('/api/runtime/v1/artifacts/blob/');
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO artifacts'))).toBe(true);
  });

  it('seals workflow input bytes through the versioned S3 server-write path and verifies them before READY', async () => {
    const db = new PublicArtifactDb();
    const storage = new MemoryVersionedStore();
    const service = createArtifactService(db as unknown as Db, {
      storageBackend: 's3',
      storageFacade: storage,
      encryption: { facade: testCrypto(), keyRef: 'test-artifact-key', required: true },
    });
    const plaintext = Buffer.from('%PDF-1.7 confidential invoice');
    const result = await service.putPublicArtifact({
      tenantId: 'tenant-a',
      fileName: 'invoice.pdf',
      mimeType: 'application/pdf',
      bytes: plaintext,
      requireEncryption: true,
    });
    const row = db.rows.get(result.artifactId)!;
    const ciphertextObject = storage.writes.find((write) => write.key === row.storageKey)!;
    const sidecarObject = storage.writes.find((write) => write.key !== row.storageKey)!;

    expect(result.state).toBe('READY');
    expect(row).toMatchObject({
      tenantId: 'tenant-a',
      state: 'READY',
      storageBackend: 's3',
      storageVersionId: ciphertextObject.version,
      manifestVersionId: sidecarObject.version,
      sizeBytes: plaintext.byteLength,
      sha256: createHash('sha256').update(plaintext).digest('hex'),
    });
    expect(ciphertextObject.bytes).not.toEqual(plaintext);
    expect(storage.writes).toHaveLength(2);
  });

  it('refuses workflow input before inserting a row when artifact encryption is absent', async () => {
    const db = new PublicArtifactDb();
    const service = createArtifactService(db as unknown as Db, { storageBackend: 'postgres' });

    expect(() => service.assertPublicArtifactEncryptionReady()).toThrow('encrypted workflow artifact storage');
    await expect(service.putPublicArtifact({
      tenantId: 'tenant-a',
      fileName: 'invoice.pdf',
      mimeType: 'application/pdf',
      bytes: Buffer.from('%PDF plaintext must not be stored'),
      requireEncryption: true,
    })).rejects.toMatchObject({ status: 503, code: 'TEMPORARY_UNAVAILABLE' });
    expect(db.rows.size).toBe(0);
  });

  it('cleans exact encrypted S3 generations and removes its row after a sidecar pin failure', async () => {
    const db = new PublicArtifactDb();
    db.failManifestPin = true;
    const storage = new MemoryVersionedStore();
    const service = createArtifactService(db as unknown as Db, {
      storageBackend: 's3',
      storageFacade: storage,
      encryption: { facade: testCrypto(), keyRef: 'test-artifact-key', required: true },
    });
    await expect(service.putPublicArtifact({
      tenantId: 'tenant-a',
      fileName: 'invoice.pdf',
      mimeType: 'application/pdf',
      bytes: Buffer.from('%PDF confidential'),
    })).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });

    expect(storage.deletes).toHaveLength(3);
    expect([...storage.objects.values()].every((versions) => versions.size === 0)).toBe(true);
    expect(db.rows.size).toBe(0);
  });
});
