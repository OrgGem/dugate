import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { Db } from '../src/db/db';
import { decryptStoredArtifact, type StoredObjectReader } from '../src/modules/encryption/artifact-read-decrypt';
import { CryptoStorageFacade } from '../src/modules/encryption/crypto-storage-facade';
import {
  createEncryptedSourceStorageWrapper,
  createS3EncryptedPinnedSourceStorage,
  createS3PinnedSourceStorage,
  encryptedSourceArtifactId,
  encryptedSourceObjectVersion,
  hasEncryptedSourceWriteCapability,
} from '../src/modules/operations/ingestion-storage-s3';
import { createSourceAcquisitionIngestor } from '@du/worker-sdk';
import { createIngestionConsumer } from '../src/modules/operations/ingestion-consumer';

/**
 * SEC-ENC-03 (SD-02) focused tests. Offline only: an in-memory versioned
 * S3-compatible store + a deterministic DEK-wrapping provider + the REAL
 * canonical envelope facade and the REAL strict artifact reader. Proves:
 * - source bytes persisted by the encrypted adapter are ciphertext only
 *   (no plaintext sentinel), single-shot and chunked;
 * - the strict reader roundtrips the object using the description the
 *   consumer persists on the artifacts row;
 * - tampered/missing envelopes fail closed;
 * - failed writes abort their committed versions (no orphan READY);
 * - the plaintext adapter is unchanged and cannot run without envelopes.
 */

/* ---------------- in-memory versioned S3 fixture ---------------- */

interface StoredObject {
  body: Buffer;
  metadata: Record<string, string>;
}

interface S3FixtureOptions {
  /** Flip the stored ciphertext after Put so read-back verification trips. */
  tamperReadback?: boolean;
}

function makeVersionedS3(options: S3FixtureOptions = {}) {
  const buckets = new Map<string, { versions: Map<string, StoredObject>; latest: string }>();
  const deletes: Array<{ key: string; versionId: string | undefined }> = [];
  let counter = 0;
  const send = async (command: unknown): Promise<Record<string, unknown>> => {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;
    const key = String(input.Key);
    if (name === 'PutObjectCommand') {
      const body = await readAll(input.Body);
      counter += 1;
      const versionId = 'v' + counter;
      if (options.tamperReadback && String(input.ContentType) === 'application/octet-stream') {
        body.fill(0x41);
      }
      const entry = buckets.get(key) ?? { versions: new Map<string, StoredObject>(), latest: '' };
      entry.versions.set(versionId, { body, metadata: { ...(input.Metadata as Record<string, string> | undefined) } });
      entry.latest = versionId;
      buckets.set(key, entry);
      const sha = createHash('sha256').update(body).digest('hex');
      return { VersionId: versionId, ChecksumSHA256: Buffer.from(sha, 'hex').toString('base64') };
    }
    if (name === 'HeadObjectCommand') {
      const stored = findStored(buckets, key, input.VersionId);
      if (!stored) throw notFound();
      return { VersionId: stored.versionId, ContentLength: stored.object.body.length, Metadata: { ...stored.object.metadata } };
    }
    if (name === 'GetObjectCommand') {
      const stored = findStored(buckets, key, input.VersionId);
      if (!stored) throw notFound();
      return { Body: Buffer.from(stored.object.body) };
    }
    if (name === 'DeleteObjectCommand') {
      deletes.push({ key, versionId: input.VersionId === undefined ? undefined : String(input.VersionId) });
      const entry = buckets.get(key);
      if (entry && input.VersionId !== undefined) entry.versions.delete(String(input.VersionId));
      return {};
    }
    throw new Error('fixture: unsupported command ' + name);
  };
  const versionsOf = (key: string): number => buckets.get(key)?.versions.size ?? 0;
  const bodyOf = (key: string): Buffer | null => {
    const entry = buckets.get(key);
    if (!entry) return null;
    return entry.versions.get(entry.latest)?.body ?? null;
  };
  const metadataOf = (key: string): Record<string, string> | null => {
    const entry = buckets.get(key);
    if (!entry) return null;
    return entry.versions.get(entry.latest)?.metadata ?? null;
  };
  const replaceBody = (key: string, body: Buffer): void => {
    const entry = buckets.get(key);
    const stored = entry?.versions.get(entry.latest);
    if (stored) stored.body = body;
  };
  return { send, deletes, versionsOf, bodyOf, metadataOf, replaceBody, buckets };
}

function findStored(
  buckets: Map<string, { versions: Map<string, StoredObject>; latest: string }>,
  key: string,
  versionId: unknown,
): { object: StoredObject; versionId: string } | null {
  const entry = buckets.get(key);
  if (!entry) return null;
  const id = versionId === undefined ? entry.latest : String(versionId);
  const object = entry.versions.get(id);
  return object ? { object, versionId: id } : null;
}

function notFound(): Error {
  return Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
}

async function readAll(body: unknown): Promise<Buffer> {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const raw of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
  }
  return Buffer.concat(chunks);
}

/* ---------------- fixtures ---------------- */

function makeKeyProvider() {
  return {
    wrapDek: async (input: { keyRef: string; dek: Buffer; keyVersion?: number }) => ({
      keyRef: input.keyRef,
      keyVersion: input.keyVersion ?? 1,
      ciphertext: input.dek.toString('base64'),
    }),
    unwrapDek: async (wrapped: { ciphertext: string }) => Buffer.from(wrapped.ciphertext, 'base64'),
  };
}

function readerOver(s3: ReturnType<typeof makeVersionedS3>): StoredObjectReader {
  return {
    head: async (storageKey) => s3.metadataOf(storageKey),
    read: async (storageKey) => {
      const body = s3.bodyOf(storageKey);
      if (!body) throw notFound();
      return Buffer.from(body);
    },
    readManifest: async (manifestKey) => {
      const body = s3.bodyOf(manifestKey);
      if (!body) throw notFound();
      return JSON.parse(body.toString('utf8')) as unknown;
    },
  };
}

const emptyDb = {
  query: async () => ({ command: 'SELECT', rowCount: 0, oid: 0, fields: [], rows: [] }),
} as unknown as Db;

const SOURCE_KEY = 'du/tenants/tenant-1/operations/op-1/source';
const TENANT = 'tenant-1';
const OPERATION = 'op-1';
const BUCKET = 'du-private';

function contextFor(storageKey = SOURCE_KEY) {
  return {
    tenantId: TENANT,
    artifactId: encryptedSourceArtifactId({ tenantId: TENANT, operationId: OPERATION, storageKey }),
    objectVersion: encryptedSourceObjectVersion({ tenantId: TENANT, operationId: OPERATION, storageKey }),
  };
}

function chunkStream(bytes: Buffer, size: number): AsyncGenerator<Buffer> {
  return (async function* () {
    for (let offset = 0; offset < bytes.length; offset += size) {
      yield bytes.subarray(offset, Math.min(offset + size, bytes.length));
    }
  })();
}

const SENTINEL = 'SEC-ENC-03-PLAINTEXT-SENTINEL';

describe('SEC-ENC-03 encrypted source acquisition (SD-02)', () => {
  it('single-shot: destination S3 body is ciphertext only and the strict reader roundtrips', async () => {
    const s3 = makeVersionedS3();
    const facade = new CryptoStorageFacade(makeKeyProvider());
    const writer = createS3EncryptedPinnedSourceStorage({
      bucket: BUCKET,
      send: s3.send,
      db: emptyDb,
      encryption: { facade, keyRef: 'du-source-kv', keyVersion: 1 },
    });
    const plaintext = Buffer.from(`invoice bytes ${SENTINEL} tail`, 'utf8');
    const context = contextFor();

    const { write, description } = await writer.putEncrypted({
      storageKey: SOURCE_KEY,
      contentType: 'application/octet-stream',
      body: chunkStream(plaintext, 7),
      maxBytes: 1024 * 1024,
    }, context);

    // The SDK receipt keeps the PLAINTEXT business hash/length.
    expect(write.storageKey).toBe(SOURCE_KEY);
    expect(write.sha256).toBe(createHash('sha256').update(plaintext).digest('hex'));
    expect(write.sizeBytes).toBe(plaintext.length);
    expect(typeof write.versionId).toBe('string');
    expect(description.ciphertextSizeBytes).toBeGreaterThan(0);

    const stored = s3.bodyOf(SOURCE_KEY)!;
    expect(stored.equals(plaintext)).toBe(false);
    expect(stored.includes(Buffer.from(SENTINEL, 'utf8'))).toBe(false);
    const metadata = s3.metadataOf(SOURCE_KEY)!;
    expect(metadata).toMatchObject({
      artifactid: context.artifactId,
      tenantid: TENANT,
      'du-encrypted': 'aes-256-gcm-v1',
      'du-manifest-key': SOURCE_KEY + '.crypto-manifest.json',
    });

    const opened = await decryptStoredArtifact(
      { reader: readerOver(s3), facade, encryptionRequired: true },
      {
        artifactId: context.artifactId,
        tenantId: TENANT,
        storageKey: SOURCE_KEY,
        uploadToken: description.objectVersion,
        manifestVersionId: description.manifestVersionId,
      },
    );
    expect(opened.decrypted).toBe(true);
    expect(opened.bytes.equals(plaintext)).toBe(true);
  });

  it('chunked: a source above the single-shot limit roundtrips through the streaming envelope', async () => {
    const s3 = makeVersionedS3();
    const facade = new CryptoStorageFacade(makeKeyProvider());
    const writer = createS3EncryptedPinnedSourceStorage({
      bucket: BUCKET,
      send: s3.send,
      db: emptyDb,
      encryption: { facade, keyRef: 'du-source-kv' },
    });
    const plaintext = Buffer.alloc(5 * 1024 * 1024 + 2048, 0x5a);
    plaintext.write(SENTINEL, 1024, 'utf8');
    const context = contextFor('du/tenants/t/operations/o/large-source');

    const { write, description } = await writer.putEncrypted({
      storageKey: 'du/tenants/t/operations/o/large-source',
      body: chunkStream(plaintext, 128 * 1024),
      maxBytes: 64 * 1024 * 1024,
    }, context);

    expect(write.sha256).toBe(createHash('sha256').update(plaintext).digest('hex'));
    expect(write.sizeBytes).toBe(plaintext.length);
    const stored = s3.bodyOf('du/tenants/t/operations/o/large-source')!;
    expect(stored.length).toBe(plaintext.length);
    expect(stored.includes(Buffer.from(SENTINEL, 'utf8'))).toBe(false);
    const manifest = JSON.parse(s3.bodyOf('du/tenants/t/operations/o/large-source.crypto-manifest.json')!.toString('utf8')) as {
      chunks?: unknown[];
    };
    expect(Array.isArray(manifest.chunks)).toBe(true);

    const opened = await decryptStoredArtifact(
      { reader: readerOver(s3), facade, encryptionRequired: true },
      {
        artifactId: context.artifactId,
        tenantId: TENANT,
        storageKey: 'du/tenants/t/operations/o/large-source',
        uploadToken: description.objectVersion,
        manifestVersionId: description.manifestVersionId,
      },
    );
    expect(opened.bytes.equals(plaintext)).toBe(true);
  });

  it('tampered ciphertext read-back fails closed and deletes the committed versions', async () => {
    const s3 = makeVersionedS3({ tamperReadback: true });
    const facade = new CryptoStorageFacade(makeKeyProvider());
    const writer = createS3EncryptedPinnedSourceStorage({
      bucket: BUCKET,
      send: s3.send,
      db: emptyDb,
      encryption: { facade, keyRef: 'du-source-kv' },
    });

    await expect(writer.putEncrypted({
      storageKey: SOURCE_KEY,
      body: chunkStream(Buffer.from('some bytes'), 4),
      maxBytes: 1024,
    }, contextFor())).rejects.toMatchObject({ name: 'SourceIngestionError', code: 'PIN_MISMATCH' });

    expect(s3.versionsOf(SOURCE_KEY)).toBe(0);
    expect(s3.versionsOf(SOURCE_KEY + '.crypto-manifest.json')).toBe(0);
    expect(s3.deletes.map((entry) => entry.key).sort()).toEqual([
      SOURCE_KEY,
      SOURCE_KEY + '.crypto-manifest.json',
    ].sort());
  });

  it('missing marker and tampered manifest are refused by the strict reader', async () => {
    const s3 = makeVersionedS3();
    const facade = new CryptoStorageFacade(makeKeyProvider());
    const writer = createS3EncryptedPinnedSourceStorage({
      bucket: BUCKET,
      send: s3.send,
      db: emptyDb,
      encryption: { facade, keyRef: 'du-source-kv' },
    });
    const context = contextFor();
    const { description } = await writer.putEncrypted({
      storageKey: SOURCE_KEY,
      body: chunkStream(Buffer.from('payload'), 3),
      maxBytes: 1024,
    }, context);
    const ref = {
      artifactId: context.artifactId,
      tenantId: TENANT,
      storageKey: SOURCE_KEY,
      uploadToken: description.objectVersion,
      manifestVersionId: description.manifestVersionId,
    };

    // Tampered manifest body -> authentication failure, never plaintext.
    const manifestKey = SOURCE_KEY + '.crypto-manifest.json';
    const manifest = JSON.parse(s3.bodyOf(manifestKey)!.toString('utf8')) as Record<string, unknown>;
    manifest.nonce = Buffer.from('0'.repeat(12)).toString('base64');
    s3.replaceBody(manifestKey, Buffer.from(JSON.stringify(manifest), 'utf8'));
    await expect(decryptStoredArtifact({ reader: readerOver(s3), facade, encryptionRequired: true }, ref))
      .rejects.toMatchObject({ status: 503, code: 'STORAGE_FAILURE' });

    // A marker-less object fails closed when the deployment requires encryption.
    const metadata = s3.metadataOf(SOURCE_KEY)!;
    delete metadata['du-encrypted'];
    await expect(decryptStoredArtifact({ reader: readerOver(s3), facade, encryptionRequired: true }, ref))
      .rejects.toMatchObject({ status: 503, code: 'STORAGE_FAILURE' });
  });

  it('deterministic identities are stable and distinct per role', () => {
    const first = contextFor();
    expect(contextFor()).toEqual(first);
    expect(first.artifactId).not.toBe(first.objectVersion);
    expect(encryptedSourceArtifactId({ tenantId: TENANT, operationId: 'op-2', storageKey: SOURCE_KEY }))
      .not.toBe(first.artifactId);
    expect(first.artifactId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('the plaintext adapter is unchanged and cannot serve as an encrypted writer', async () => {
    const s3 = makeVersionedS3();
    const plaintextAdapter = createS3PinnedSourceStorage({ bucket: BUCKET, send: s3.send, db: emptyDb });
    expect(hasEncryptedSourceWriteCapability(plaintextAdapter)).toBe(false);
    expect(() => createEncryptedSourceStorageWrapper(plaintextAdapter, { context: contextFor() }))
      .toThrow(/does not implement putEncrypted/);

    const facade = new CryptoStorageFacade(makeKeyProvider());
    const encrypted = createS3EncryptedPinnedSourceStorage({
      bucket: BUCKET,
      send: s3.send,
      db: emptyDb,
      encryption: { facade, keyRef: 'du-source-kv' },
    });
    // The encrypted adapter never silently writes plaintext without a context.
    await expect(encrypted.putVerified({
      storageKey: SOURCE_KEY,
      body: chunkStream(Buffer.from('x'), 1),
      maxBytes: 1024,
    })).rejects.toMatchObject({ name: 'SourceIngestionError', code: 'STORAGE_FAILURE' });
    expect(s3.versionsOf(SOURCE_KEY)).toBe(0);
  });

  it('the wrapper captures the description the consumer stores on the artifact row', async () => {
    const s3 = makeVersionedS3();
    const facade = new CryptoStorageFacade(makeKeyProvider());
    const encrypted = createS3EncryptedPinnedSourceStorage({
      bucket: BUCKET,
      send: s3.send,
      db: emptyDb,
      encryption: { facade, keyRef: 'du-source-kv' },
    });
    const captured: Array<Record<string, unknown>> = [];
    const wrapper = createEncryptedSourceStorageWrapper(encrypted, {
      context: contextFor(),
      onWritten: (description) => captured.push({ ...description }),
    });
    const write = await wrapper.putVerified({
      storageKey: SOURCE_KEY,
      body: chunkStream(Buffer.from('row binding'), 2),
      maxBytes: 1024,
    });
    expect(write.sizeBytes).toBe('row binding'.length);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ artifactId: contextFor().artifactId, objectVersion: contextFor().objectVersion });
    expect(typeof captured[0]!.manifestVersionId).toBe('string');
  });

  it('URL and IAM-s3 producer legs both persist ciphertext through the same envelope path', async () => {
    const s3 = makeVersionedS3();
    const facade = new CryptoStorageFacade(makeKeyProvider());
    const encrypted = createS3EncryptedPinnedSourceStorage({
      bucket: BUCKET,
      send: s3.send,
      db: emptyDb,
      encryption: { facade, keyRef: 'du-source-kv' },
    });

    const payloads = [Buffer.from(`https leg ${SENTINEL}`), Buffer.from(`s3 leg ${SENTINEL}`)];
    for (const [index, source] of ['https://example.com/doc.pdf', 's3://customer-docs/doc.pdf'].entries()) {
      const storageKey = `du/tenants/${TENANT}/operations/op-legged-${index}/source`;
      const captured: Array<{ manifestVersionId: string; objectVersion: string; artifactId: string }> = [];
      const wrapper = createEncryptedSourceStorageWrapper(encrypted, {
        context: contextFor(storageKey),
        onWritten: (description) => captured.push(description),
      });
      const ingestor = createSourceAcquisitionIngestor({
        storage: wrapper,
        storageKey,
        transfer: { maxBytes: 1024 * 1024 },
        taskId: `task-legged-${index}`,
        acquireFile: async (workspace, fileName) => {
          const path = workspace.filePath(fileName);
          await writeFile(path, payloads[index]!);
          return {
            path,
            sizeBytes: payloads[index]!.length,
            sha256: createHash('sha256').update(payloads[index]!).digest('hex'),
            hops: 0,
          };
        },
      });

      const receipt = await ingestor.acquire(source);

      expect(receipt.sha256).toBe(createHash('sha256').update(payloads[index]!).digest('hex'));
      expect(receipt.sizeBytes).toBe(payloads[index]!.length);
      const stored = s3.bodyOf(storageKey)!;
      expect(stored.includes(Buffer.from(SENTINEL, 'utf8'))).toBe(false);
      expect(captured).toHaveLength(1);
      const opened = await decryptStoredArtifact(
        { reader: readerOver(s3), facade, encryptionRequired: true },
        {
          artifactId: captured[0]!.artifactId,
          tenantId: TENANT,
          storageKey,
          uploadToken: captured[0]!.objectVersion,
          manifestVersionId: captured[0]!.manifestVersionId,
        },
      );
      expect(opened.bytes.equals(payloads[index]!)).toBe(true);
    }
  });

  it('the consumer refuses required encryption when the storage adapter cannot seal', () => {
    const s3 = makeVersionedS3();
    const plaintextAdapter = createS3PinnedSourceStorage({ bucket: BUCKET, send: s3.send, db: emptyDb });
    expect(() => createIngestionConsumer({
      db: emptyDb,
      storage: plaintextAdapter,
      transfer: { maxBytes: 1024, timeoutMs: 10_000 },
      storageBackend: 's3',
      requireEncryptedSourceWrites: true,
    })).toThrow(/does not implement putEncrypted/);

    const facade = new CryptoStorageFacade(makeKeyProvider());
    const encryptedAdapter = createS3EncryptedPinnedSourceStorage({
      bucket: BUCKET,
      send: s3.send,
      db: emptyDb,
      encryption: { facade, keyRef: 'du-source-kv' },
    });
    expect(() => createIngestionConsumer({
      db: emptyDb,
      storage: encryptedAdapter,
      transfer: { maxBytes: 1024, timeoutMs: 10_000 },
      storageBackend: 's3',
      requireEncryptedSourceWrites: true,
    })).not.toThrow();
  });
});
