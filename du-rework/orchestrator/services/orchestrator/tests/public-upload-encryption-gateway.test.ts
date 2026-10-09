import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { mkdtemp, open, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import type { Db } from '../src/db/db';
import {
  CRYPTO_STORAGE_CHUNK_SIZE_BYTES,
  CryptoStorageFacade,
  CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES,
} from '../src/modules/encryption/crypto-storage-facade';
import type { KeyProvider, WrappedDek, WrapDekInput } from '../src/modules/encryption/vault-transit-provider';
import type { ProfileService } from '../src/modules/profiles/profiles';
import type { RegistryService } from '../src/modules/registry/registry';
import { createSubmissionService } from '../src/modules/operations/submission';
import { createPublicUploadGateway } from '../src/modules/public-api/upload-encryption-gateway';
import { route, type RouteContext } from '../src/server';

const ARTIFACT_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const TENANT_ID = '73000000-0000-4000-8000-0000000000a1';
const API_KEY_ID = '74000000-0000-4000-8000-0000000000a1';
const UPLOAD_TOKEN = 'dddddddd-0000-4000-8000-00000000000d';
const ORIGINAL_BEARER = 'server-upload-bearer';
const STORAGE_KEY = 'art-' + ARTIFACT_ID;
const KEY_REF = 'artifact-key';

interface MemoryObject {
  body: Buffer;
  versionId: string;
  metadata: Record<string, string>;
  contentLength?: number;
}

interface StreamedObjectSummary {
  byteCount: number;
  sha256: string;
  chunkCount: number;
  maxChunkBytes: number;
  producerActiveAtFirstChunk: boolean | null;
}

interface MemoryMultipart {
  key: string;
  metadata: Record<string, string>;
  parts: Map<number, Buffer>;
}

async function bytesOf(body: unknown, afterChunk?: () => Promise<void>): Promise<Buffer> {
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (!body || typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== 'function') {
    throw new Error('test S3 received a body that is not a byte stream');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    await afterChunk?.();
  }
  return Buffer.concat(chunks);
}

class MemoryS3 {
  public readonly objects = new Map<string, MemoryObject>();
  public readonly versions = new Map<string, Map<string, MemoryObject>>();
  public readonly streamedObjects = new Map<string, StreamedObjectSummary>();
  public readonly commands: string[] = [];
  public readonly versionRequests: Array<{ command: string; key: string; versionId?: string }> = [];
  public readonly deletedVersions: Array<{ key: string; versionId: string }> = [];
  public readonly objectWrites: Array<{ key: string; versionId: string; body: Buffer }> = [];
  public stateAtEncryptedPut: string[] = [];
  public state: () => string = () => 'unknown';
  public sourcePullsAtFirstEncryptedRead: number | null = null;
  public sourcePulls: () => number = () => 0;
  public producerFinished: () => boolean = () => false;
  public sinkEncryptedObjects = false;
  public afterFirstEncryptedChunk?: () => Promise<void>;
  public delayReadsMs = 0;
  public beforeFirstEncryptedPut?: () => Promise<void>;
  private readonly multiparts = new Map<string, MemoryMultipart>();
  private readonly streamedObjectFiles = new Map<string, Map<string, string>>();
  private readonly sinkFiles = new Set<string>();
  private sinkDirectory: string | null = null;
  private sinkFileCount = 0;
  private version = 0;
  private upload = 0;
  private encryptedPutCount = 0;

  public async enableEncryptedStreamSink(): Promise<void> {
    this.sinkDirectory = await mkdtemp(join(tmpdir(), 'du-public-upload-sink-'));
    this.sinkEncryptedObjects = true;
  }

  public async cleanupEncryptedStreamSink(): Promise<void> {
    const directory = this.sinkDirectory;
    if (!directory) return;
    if (dirname(directory) !== tmpdir() || !basename(directory).startsWith('du-public-upload-sink-')) {
      throw new Error('test S3 sink cleanup refused an unexpected temporary directory');
    }
    for (const file of this.sinkFiles) await unlink(file);
    await rmdir(directory);
    this.sinkFiles.clear();
    this.streamedObjectFiles.clear();
    this.sinkDirectory = null;
  }

  private async consumeEncryptedObject(key: string, body: unknown, metadata: Record<string, string>): Promise<{ summary: StreamedObjectSummary; versionId: string }> {
    const directory = this.sinkDirectory;
    if (!directory) throw new Error('test S3 encrypted stream sink was not initialized');
    const filePath = join(directory, `ciphertext-${++this.sinkFileCount}.bin`);
    const file = await open(filePath, 'wx');
    this.sinkFiles.add(filePath);
    const hash = createHash('sha256');
    let byteCount = 0;
    let chunkCount = 0;
    let maxChunkBytes = 0;
    let producerActiveAtFirstChunk: boolean | null = null;
    const consumeChunk = async (chunk: Uint8Array): Promise<void> => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (chunkCount === 0) {
        this.sourcePullsAtFirstEncryptedRead = this.sourcePulls();
        producerActiveAtFirstChunk = !this.producerFinished();
      }
      await file.writeFile(bytes);
      hash.update(bytes);
      byteCount += bytes.byteLength;
      chunkCount++;
      maxChunkBytes = Math.max(maxChunkBytes, bytes.byteLength);
      if (chunkCount === 1) await this.afterFirstEncryptedChunk?.();
    };
    try {
      if (body instanceof Uint8Array) {
        await consumeChunk(body);
      } else if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
        for await (const chunk of body as AsyncIterable<Uint8Array>) await consumeChunk(chunk);
      } else {
        throw new Error('test S3 received a body that is not a byte stream');
      }
    } finally {
      await file.close();
    }
    const versionId = `version-${++this.version}`;
    const versions = this.streamedObjectFiles.get(key) ?? new Map<string, string>();
    versions.set(versionId, filePath);
    this.streamedObjectFiles.set(key, versions);
    const summary = {
      byteCount,
      sha256: hash.digest('hex'),
      chunkCount,
      maxChunkBytes,
      producerActiveAtFirstChunk,
    };
    this.streamedObjects.set(key, summary);
    this.storeObject(key, {
      body: Buffer.alloc(0),
      versionId,
      metadata: { ...metadata },
      contentLength: byteCount,
    });
    return { summary, versionId };
  }

  private storeObject(key: string, object: MemoryObject): void {
    const versions = this.versions.get(key) ?? new Map<string, MemoryObject>();
    versions.set(object.versionId, object);
    this.versions.set(key, versions);
    this.objects.set(key, object);
    this.objectWrites.push({ key, versionId: object.versionId, body: Buffer.from(object.body) });
  }

  private getObject(key: string, versionId?: string): MemoryObject | undefined {
    return versionId ? this.versions.get(key)?.get(versionId) : this.objects.get(key);
  }

  public async getVersion(key: string, versionId: string): Promise<MemoryObject> {
    const object = this.getObject(key, versionId);
    if (!object) throw new Error('NoSuchVersion');
    return object;
  }

  public async send(command: unknown): Promise<unknown> {
    if (command instanceof AbortMultipartUploadCommand) {
      this.commands.push('AbortMultipartUpload');
      const uploadId = command.input.UploadId!;
      this.multiparts.delete(uploadId);
      return {};
    }
    if (command instanceof PutObjectCommand) {
      this.commands.push('PutObject');
      const body = command.input.Body;
      const metadata = command.input.Metadata ?? {};
      const isEncryptedObject = metadata['du-encrypted'] === 'aes-256-gcm-v1';
      if (isEncryptedObject) {
        this.stateAtEncryptedPut.push(this.state());
        this.encryptedPutCount++;
        if (this.encryptedPutCount === 1) await this.beforeFirstEncryptedPut?.();
      }
      if (isEncryptedObject && this.sinkEncryptedObjects) {
        const stored = await this.consumeEncryptedObject(command.input.Key!, body, metadata);
        return { VersionId: stored.versionId };
      }
      let firstChunk = true;
      const bytes = await bytesOf(body, isEncryptedObject
        ? async () => {
            if (firstChunk && this.sourcePullsAtFirstEncryptedRead === null) {
              this.sourcePullsAtFirstEncryptedRead = this.sourcePulls();
              firstChunk = false;
            }
            if (this.delayReadsMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayReadsMs));
          }
        : undefined);
      const versionId = `version-${++this.version}`;
      this.storeObject(command.input.Key!, { body: bytes, versionId, metadata: { ...metadata } });
      return { VersionId: versionId };
    }
    if (command instanceof CreateMultipartUploadCommand) {
      this.commands.push('CreateMultipartUpload');
      const uploadId = `encrypted-upload-${++this.upload}`;
      this.multiparts.set(uploadId, {
        key: command.input.Key!,
        metadata: { ...(command.input.Metadata ?? {}) },
        parts: new Map(),
      });
      return { UploadId: uploadId };
    }
    if (command instanceof UploadPartCommand) {
      this.commands.push('UploadPart');
      const upload = this.multiparts.get(command.input.UploadId!);
      if (!upload) throw new Error('unknown test multipart upload');
      upload.parts.set(command.input.PartNumber!, await bytesOf(command.input.Body));
      return { ETag: `"etag-${command.input.PartNumber}"` };
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      this.commands.push('CompleteMultipartUpload');
      const upload = this.multiparts.get(command.input.UploadId!);
      if (!upload) throw new Error('unknown test multipart upload');
      const ordered = [...(command.input.MultipartUpload?.Parts ?? [])]
        .sort((left, right) => (left.PartNumber ?? 0) - (right.PartNumber ?? 0));
      const body = Buffer.concat(ordered.map((part) => upload.parts.get(part.PartNumber!)!));
      const versionId = `version-${++this.version}`;
      this.storeObject(upload.key, { body, versionId, metadata: upload.metadata });
      this.multiparts.delete(command.input.UploadId!);
      return { VersionId: versionId };
    }
    if (command instanceof HeadObjectCommand) {
      this.commands.push('HeadObject');
      const key = command.input.Key!;
      const versionId = command.input.VersionId;
      this.versionRequests.push({ command: 'HeadObject', key, ...(versionId ? { versionId } : {}) });
      const object = this.getObject(key, versionId);
      if (!object) throw new Error('test object not found');
      return {
        ContentLength: object.contentLength ?? object.body.length,
        VersionId: object.versionId,
        Metadata: { ...object.metadata },
      };
    }
    if (command instanceof GetObjectCommand) {
      this.commands.push('GetObject');
      const key = command.input.Key!;
      const versionId = command.input.VersionId;
      this.versionRequests.push({ command: 'GetObject', key, ...(versionId ? { versionId } : {}) });
      const object = this.getObject(key, versionId);
      if (!object) throw new Error('test object not found');
      const streamedFile = this.streamedObjectFiles.get(key)?.get(object.versionId);
      return {
        Body: streamedFile
          ? createReadStream(streamedFile)
          : Readable.from([Buffer.from(object.body)]),
      };
    }
    if (command instanceof DeleteObjectCommand) {
      this.commands.push('DeleteObject');
      const key = command.input.Key!;
      const versionId = command.input.VersionId;
      this.versionRequests.push({ command: 'DeleteObject', key, ...(versionId ? { versionId } : {}) });
      if (versionId) {
        const versions = this.versions.get(key);
        versions?.delete(versionId);
        this.deletedVersions.push({ key, versionId });
        if (this.objects.get(key)?.versionId === versionId) {
          const remaining = versions ? [...versions.values()] : [];
          const latest = remaining[remaining.length - 1];
          if (latest) this.objects.set(key, latest);
          else this.objects.delete(key);
        }
        if (versions?.size === 0) this.versions.delete(key);
      } else {
        // Model an S3 delete marker: current reads hide the key while old
        // versions remain addressable by VersionId.
        this.objects.delete(key);
      }
      return {};
    }
    throw new Error('unsupported S3 command in test: ' + (command as { constructor?: { name?: string } }).constructor?.name);
  }
}

function createDb(initialSize: number, initiallyExists = true): {
  db: Db;
  control: { releaseFailuresRemaining: number };
  row: {
    artifactId: string;
    tenantId: string;
    storageKey: string;
    uploadToken: string;
    purpose: string;
    fileName: string | null;
    mimeType: string;
    storageBackend: string;
    state: string;
    token: string;
    tokenMode: string | null;
    claimExpiresAt: Date | null;
    sessionExpiresAt: Date | null;
    multipartUploadId: string | null;
    storageVersionId: string | null;
    manifestVersionId: string | null;
    sha256: string | null;
    sizeBytes: number;
  };
} {
  const row = {
    artifactId: ARTIFACT_ID as string,
    tenantId: TENANT_ID as string,
    storageKey: STORAGE_KEY as string,
    storageBackend: 's3' as string,
    uploadToken: UPLOAD_TOKEN as string,
    purpose: 'input' as string,
    fileName: null as string | null,
    mimeType: 'application/octet-stream' as string,
    multipartUploadId: 'pre-existing-direct-upload' as string | null,
    sizeBytes: initialSize,
    state: 'STAGING',
    token: ORIGINAL_BEARER,
    tokenMode: null as string | null,
    claimExpiresAt: null as Date | null,
    sessionExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) as Date | null,
    storageVersionId: null as string | null,
    manifestVersionId: null as string | null,
    sha256: null as string | null,
  };
  const control = { releaseFailuresRemaining: 0 };
  let exists = initiallyExists;
  let submittedOperation: Record<string, unknown> | null = null;
  let linkedOperationId: string | null = null;
  const linkedTaskId: string | null = null;
  const execute = async (sql: string, params: unknown[] = []) => {
    const query = sql.replace(/\s+/g, ' ').trim();
    if (query.startsWith('SELECT') && query.includes('FROM api_keys')) {
      return { rowCount: 1, rows: [{ id: API_KEY_ID, tenant_id: row.tenantId }] };
    }
    if (query.startsWith('SELECT') && query.includes('FROM artifacts') && query.includes('id = ANY($1::uuid[])')) {
      const ids = Array.isArray(params[0]) ? params[0] as string[] : [];
      if (!exists || row.tenantId !== params[1] || !ids.includes(row.artifactId)) {
        return { rowCount: 0, rows: [] };
      }
      const expiresAt = row.sessionExpiresAt?.getTime() ?? 0;
      return {
        rowCount: 1,
        rows: [{ id: row.artifactId, state: row.state, expired: expiresAt <= Date.now() }],
      };
    }
    if (query.startsWith('SELECT') && query.includes('FROM business_versions')) {
      return {
        rowCount: 1,
        rows: [{
          version: '1.0.0',
          manifest: {
            actions: [{ name: 'ingest', inputSchema: { type: 'object' } }],
            runtime: { handlerKinds: ['root'] },
          },
          digest: 'sha256:offline-data02',
          queue: 'du-business-document-core-1.0.0',
        }],
      };
    }
    if (query.startsWith('INSERT INTO operations')) {
      const now = new Date().toISOString();
      submittedOperation = {
        id: params[0],
        tenant_id: params[1],
        business_id: params[3],
        business_version: params[4],
        action: params[5],
        state: params[6],
        state_version: 1,
        created_at: now,
        updated_at: now,
        deadline_at: null,
        result_ref: null,
      };
      return { rowCount: 1, rows: [] };
    }
    if (query.startsWith('INSERT INTO tasks') || query.startsWith('INSERT INTO outbox')) {
      return { rowCount: 1, rows: [] };
    }
    if (query.startsWith('SELECT') && query.includes('FROM operations WHERE id=$1')) {
      return submittedOperation && submittedOperation.id === params[0]
        ? { rowCount: 1, rows: [submittedOperation] }
        : { rowCount: 0, rows: [] };
    }
    if (query.startsWith('SELECT') && query.includes('FROM artifacts')) {
      if (!exists) return { rowCount: 0, rows: [] };
      if (query.includes('WHERE tenant_id=$1 AND upload_token=$2')) {
        if (params[0] !== row.tenantId || params[1] !== row.uploadToken) return { rowCount: 0, rows: [] };
        return {
          rowCount: 1,
          rows: [{
            artifactId: row.artifactId,
            purpose: row.purpose,
            fileName: row.fileName,
            mimeType: row.mimeType,
            sizeBytes: row.sizeBytes,
            state: row.state,
            expiresAt: row.sessionExpiresAt,
          }],
        };
      }
      if (params[0] !== row.artifactId || params[1] !== row.tenantId) return { rowCount: 0, rows: [] };
      return {
        rowCount: 1,
        rows: [{
          artifactId: row.artifactId,
          tenantId: row.tenantId,
          storageKey: row.storageKey,
          storageBackend: row.storageBackend,
          uploadToken: row.uploadToken,
          multipartUploadId: row.multipartUploadId,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          state: row.state,
          claimToken: row.token,
          claimExpiresAt: row.claimExpiresAt,
          sessionExpiresAt: row.sessionExpiresAt,
          storageVersionId: row.storageVersionId,
          manifestVersionId: row.manifestVersionId,
          sha256: row.sha256,
        }],
      };
    }
    if (query.startsWith('INSERT INTO artifacts')) {
      if (exists) return { rowCount: 0, rows: [] };
      row.artifactId = String(params[0]);
      row.tenantId = String(params[1]);
      row.fileName = params[2] === null ? null : String(params[2]);
      row.mimeType = String(params[3]);
      row.sizeBytes = Number(params[4]);
      row.token = String(params[5]);
      row.storageKey = String(params[6]);
      row.uploadToken = String(params[7]);
      row.sessionExpiresAt = params[9] as Date;
      row.multipartUploadId = null;
      exists = true;
      return { rowCount: 1, rows: [{ id: row.artifactId }] };
    }
    if (query.includes("SET token=$3")) {
      row.token = String(params[2]);
      row.claimExpiresAt = params[3] as Date;
      return { rowCount: 1, rows: [] };
    }
    if (query.startsWith('UPDATE artifacts SET token_expires_at=NULL')) {
      if (control.releaseFailuresRemaining > 0) {
        control.releaseFailuresRemaining--;
        throw new Error('simulated lost process before claim release');
      }
      if (row.token === params[2] && row.state === 'STAGING') {
        row.claimExpiresAt = null;
      }
      return { rowCount: 1, rows: [] };
    }
    if (query.includes("SET state='READY'")) {
      if (row.state !== 'STAGING' || row.token !== params[2]) return { rowCount: 0, rows: [] };
      row.state = 'READY';
      row.storageVersionId = String(params[3]);
      row.sha256 = String(params[4]);
      row.sizeBytes = Number(params[5]);
      row.manifestVersionId = String(params[6]);
      row.multipartUploadId = null;
      row.claimExpiresAt = null;
      return { rowCount: 1, rows: [{ id: ARTIFACT_ID }] };
    }
    if (query.startsWith('UPDATE artifacts SET operation_id=$2')) {
      const ids = Array.isArray(params[0]) ? params[0] as string[] : [];
      if (
        !exists ||
        !ids.includes(row.artifactId) ||
        params[2] !== row.tenantId ||
        row.state !== 'READY' ||
        linkedOperationId !== null ||
        linkedTaskId !== null
      ) {
        return { rowCount: 0, rows: [] };
      }
      linkedOperationId = String(params[1]);
      return { rowCount: 1, rows: [{ id: row.artifactId }] };
    }
    throw new Error('unexpected test DB query: ' + query);
  };
  const db = {
    query: execute,
    tx: async (callback: (client: never) => Promise<unknown>) => callback({ query: execute } as never),
    close: async () => undefined,
  } as unknown as Db;
  return { db, row, control };
}

function keyProvider(failWrap = false): KeyProvider {
  return {
    async wrapDek(input: WrapDekInput): Promise<WrappedDek> {
      if (failWrap) throw new Error('Vault Transit unavailable');
      const wrapped = createHmac('sha256', 'offline test wrapping key').update(input.dek).digest('base64');
      return { keyRef: input.keyRef, keyVersion: input.keyVersion ?? 3, ciphertext: 'vault:v3:' + wrapped };
    },
    async unwrapDek(): Promise<Buffer> {
      throw new Error('not used by upload tests');
    },
    async rewrap(value: WrappedDek): Promise<WrappedDek> {
      return value;
    },
  };
}

function sourceOf(bytes: Buffer, chunkSize = 64 * 1024): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        yield bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
      }
    },
  };
}

function gatewayFor(options: {
  size: number;
  initiallyExists?: boolean;
  maxBytes?: number;
  putObjectMaxBytes?: number;
  multipartPartBytes?: number;
  provider?: KeyProvider;
  claimTtlMs?: number;
  now?: () => number;
}): {
  gateway: ReturnType<typeof createPublicUploadGateway>;
  db: Db;
  control: ReturnType<typeof createDb>['control'];
  row: ReturnType<typeof createDb>['row'];
  s3: MemoryS3;
} {
  const { db, row, control } = createDb(options.size, options.initiallyExists);
  const s3 = new MemoryS3();
  s3.state = () => row.state;
  const gateway = createPublicUploadGateway({
    db,
    client: { send: (command: unknown) => s3.send(command) } as unknown as S3Client,
    bucket: 'offline-artifacts',
    cryptoStorage: new CryptoStorageFacade(options.provider ?? keyProvider()),
    keyRef: KEY_REF,
    keyVersion: 3,
    maxBytes: options.maxBytes,
    putObjectMaxBytes: options.putObjectMaxBytes,
    multipartPartBytes: options.multipartPartBytes,
    claimTtlMs: options.claimTtlMs,
    now: options.now,
  });
  return { gateway, db, control, row, s3 };
}

describe('public upload encryption gateway', () => {
  test('completes the public grant, binary upload, finalize replay, and submit route journey', async () => {
    const binaryFixture = Buffer.from([0x00, 0xff, 0x80, 0x01, 0xc3, 0x28, 0x0a, 0x7f, 0x00, 0xfe]);
    const { gateway, db, row, s3 } = gatewayFor({ size: binaryFixture.length, initiallyExists: false });
    const submission = createSubmissionService(
      db,
      {} as RegistryService,
      {
        resolveBinding: async () => ({ mode: 'legacy' as const }),
        resolveEffectiveProfile: async () => ({ mode: 'legacy' as const }),
      } as unknown as ProfileService,
      { maxBlobBytes: 1024, storageBackend: 's3' },
    );
    const ctx = {
      method: 'POST',
      pathname: '/api/v1/uploads',
      searchParams: new URLSearchParams(),
      headers: { 'x-api-key': 'offline-public-upload-key' },
      body: undefined,
      rawBody: Buffer.alloc(0),
      correlationId: 'data02-upload-submit-journey',
      host: 'orchestrator.test',
      db,
      redis: {},
      registry: {},
      profiles: {},
      audit: {},
      submission,
      runtime: {},
      usage: {},
      artifacts: {},
      multipart: {},
      publicUploadGateway: gateway,
      grants: null,
      connectors: {},
      lifecycle: {},
      dispatcher: { dispatchOnce: jest.fn() },
      getQueue: jest.fn(),
      queueIntegrity: () => undefined,
      credentialWorkflow: undefined,
      deliveryEncryption: null,
      cryptoConfig: null,
      config: { autoDispatch: false, publicUploadEncryption: { maxBytes: 1024 } },
    } as unknown as RouteContext;
    const request = (
      method: string,
      pathname: string,
      body: unknown,
      headers: Record<string, string> = {},
      bodyStream?: AsyncIterable<Uint8Array>,
    ): RouteContext => ({
      ...ctx,
      method,
      pathname,
      body,
      headers: { ...ctx.headers, ...headers },
      ...(bodyStream ? { bodyStream } : {}),
    });

    const initBody = {
      uploadToken: UPLOAD_TOKEN,
      mimeType: 'application/octet-stream',
      sizeBytes: binaryFixture.length,
      fileName: 'binary-fixture.bin',
    };
    const init = await route(request('POST', '/api/v1/uploads', initBody));
    expect(init.status).toBe(201);
    const grant = init.body as { artifactId: string; uploadUrl: string };
    expect(grant.uploadUrl).toBe(`/api/v1/uploads/${grant.artifactId}/content`);

    const plaintextSha256 = createHash('sha256').update(binaryFixture).digest('hex');
    const uploaded = await route(request(
      'PUT',
      grant.uploadUrl,
      undefined,
      { 'content-length': String(binaryFixture.length), 'x-content-sha256': plaintextSha256 },
      sourceOf(binaryFixture, 3),
    ));
    expect(uploaded.status).toBe(201);
    const uploadAck = uploaded.body as { artifactId: string; plaintextSha256?: string; sha256: string };
    expect(uploadAck.artifactId).toBe(grant.artifactId);
    expect(uploadAck.plaintextSha256).toBe(plaintextSha256);
    expect(row.state).toBe('READY');
    expect(s3.objects.get(row.storageKey)?.body.equals(binaryFixture)).toBe(false);

    const finalized = await route(request(
      'POST',
      `/api/v1/uploads/${grant.artifactId}/complete`,
      { sha256: uploadAck.sha256 },
    ));
    expect(finalized.status).toBe(200);
    expect(finalized.body).toMatchObject({ artifactId: grant.artifactId, state: 'READY', replayed: true });

    const submitted = await route(request(
      'POST',
      '/api/v1/businesses/document-core/actions/ingest',
      { input: {}, artifacts: [{ artifactId: grant.artifactId, role: 'source' }] },
    ));
    expect(submitted.status).toBe(202);
    expect(submitted.body).toMatchObject({ state: 'ACCEPTED', replayed: false });
    expect(submitted.body).toHaveProperty('operationId');
    expect(submitted.body).toHaveProperty('links.self');
    expect(row.state).toBe('READY');
    expect(submitted.body).not.toMatchObject({
      errors: [{ code: 'STATE_CONFLICT' }],
    });
  });

  test('creates a tenant-fenced small upload session and replays the same handle by uploadToken', async () => {
    const size = 1024;
    const { gateway, row } = gatewayFor({ size, initiallyExists: false });
    const input = { uploadToken: UPLOAD_TOKEN, mimeType: 'application/octet-stream', sizeBytes: size };
    const first = await gateway.initSingle(TENANT_ID, input);
    const replay = await gateway.initSingle(TENANT_ID, input);

    expect(first.artifactId).toBe(row.artifactId);
    expect(first.partCount).toBe(1);
    expect(first.replayed).toBe(false);
    expect(replay.uploadHandle).toBe(first.uploadHandle);
    expect(replay.expiresAt).toBe(first.expiresAt);
    expect(replay.replayed).toBe(true);
    expect(row.state).toBe('STAGING');
    expect(row.multipartUploadId).toBeNull();
  });

  test('cannot finalize an unencrypted STAGING object through the replay endpoint', async () => {
    const { gateway, row, s3 } = gatewayFor({ size: 1024 });
    await expect(gateway.completeReplay(ARTIFACT_ID, TENANT_ID, { sha256: 'a'.repeat(64) }))
      .rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    expect(row.state).toBe('STAGING');
    expect(s3.commands).toEqual([]);
  });

  test('legacy READY rows with NULL manifest version retain key-only replay verification', async () => {
    const plaintext = Buffer.from('legacy manifest fallback');
    const { gateway, row, s3 } = gatewayFor({ size: plaintext.length });
    const ack = await gateway.upload({
      artifactId: ARTIFACT_ID,
      tenantId: TENANT_ID,
      source: sourceOf(plaintext),
    });
    expect(row.manifestVersionId).toBeTruthy();

    // Model a pre-0025 READY row. Ciphertext verification remains pinned, but
    // historical NULL manifests keep the prior key-only fallback behavior.
    row.manifestVersionId = null;
    s3.versionRequests.length = 0;
    const replay = await gateway.completeReplay(ARTIFACT_ID, TENANT_ID, { sha256: ack.ciphertextSha256 });

    expect(replay).toMatchObject({ state: 'READY', replayed: true, storageVersionId: ack.storageVersionId });
    expect(s3.versionRequests).toEqual([
      { command: 'HeadObject', key: STORAGE_KEY, versionId: ack.storageVersionId },
      { command: 'GetObject', key: STORAGE_KEY, versionId: ack.storageVersionId },
    ]);
  });

  test('encrypts before S3 PUT, verifies the ciphertext and authenticated sidecar, then marks READY', async () => {
    const plaintext = Buffer.from('tenant confidential upload');
    const { gateway, row, s3 } = gatewayFor({ size: plaintext.length });
    const ack = await gateway.upload({
      artifactId: ARTIFACT_ID,
      tenantId: TENANT_ID,
      source: sourceOf(plaintext),
      contentLength: String(plaintext.length),
      plaintextSha256: createHash('sha256').update(plaintext).digest('hex'),
    });

    const stored = s3.objects.get(STORAGE_KEY)!;
    const sidecar = s3.objects.get(STORAGE_KEY + '.crypto-manifest.json')!;
    const manifest = JSON.parse(sidecar.body.toString('utf8')) as {
      kind: string;
      ciphertextSizeBytes: number;
      ciphertextSha256: string;
      encryption: Record<string, unknown>;
    };
    expect(stored.body.equals(plaintext)).toBe(false);
    expect(stored.body.length).toBe(plaintext.length);
    expect(stored.metadata['du-encrypted']).toBe('aes-256-gcm-v1');
    expect(stored.metadata['du-manifest-key']).toBe(STORAGE_KEY + '.crypto-manifest.json');
    expect(manifest.kind).toBe('single');
    expect(manifest.encryption).toHaveProperty('nonce');
    expect(manifest.encryption).toHaveProperty('tag');
    expect(manifest.encryption).toHaveProperty('dek');
    expect(manifest.encryption).not.toHaveProperty('ciphertext');
    expect(manifest.ciphertextSizeBytes).toBe(plaintext.length);
    expect(manifest.ciphertextSha256).toBe(createHash('sha256').update(stored.body).digest('hex'));
    expect(ack.plaintextSha256).toBe(createHash('sha256').update(plaintext).digest('hex'));
    expect(ack.ciphertextSha256).toBe(manifest.ciphertextSha256);
    expect(row.state).toBe('READY');
    expect(row.sizeBytes).toBe(stored.body.length);
    expect(row.sha256).toBe(manifest.ciphertextSha256);
    expect(row.storageVersionId).toBe(ack.storageVersionId);
    expect(row.manifestVersionId).toBe(sidecar.versionId);
    expect(row.token).not.toBe(ORIGINAL_BEARER);
    expect(row.claimExpiresAt).toBeNull();
    expect(row.tokenMode).toBeNull();
    const manifestVersionChecks = s3.versionRequests.filter((request) =>
      request.key === STORAGE_KEY + '.crypto-manifest.json'
      && (request.command === 'HeadObject' || request.command === 'GetObject'));
    expect(manifestVersionChecks).toHaveLength(2);
    expect(manifestVersionChecks.every((request) => request.versionId === sidecar.versionId)).toBe(true);
    expect(s3.stateAtEncryptedPut).toEqual(['STAGING']);
    expect(s3.commands).toContain('AbortMultipartUpload');
  });

  test('streams chunked encryption with downstream backpressure and keeps the object size exact', async () => {
    const size = CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES + 20 * 1024 * 1024;
    const { gateway, s3, row } = gatewayFor({ size });
    await s3.enableEncryptedStreamSink();
    let pulls = 0;
    let producerFinished = false;
    let producerFinishedAtFirstEncryptedChunk: boolean | null = null;
    let signalFirstEncryptedChunk!: () => void;
    const firstEncryptedChunk = new Promise<void>((resolve) => { signalFirstEncryptedChunk = resolve; });
    let resumeSink!: () => void;
    const sinkResume = new Promise<void>((resolve) => { resumeSink = resolve; });
    s3.sourcePulls = () => pulls;
    s3.producerFinished = () => producerFinished;
    s3.afterFirstEncryptedChunk = async () => {
      producerFinishedAtFirstEncryptedChunk = producerFinished;
      signalFirstEncryptedChunk();
      await sinkResume;
    };
    async function* slowSource(): AsyncGenerator<Uint8Array> {
      for (let offset = 0; offset < size; offset += 1024 * 1024) {
        pulls++;
        yield Buffer.alloc(Math.min(size - offset, 1024 * 1024), pulls % 251);
      }
      producerFinished = true;
    }
    try {
      const upload = gateway.upload({ artifactId: ARTIFACT_ID, tenantId: TENANT_ID, source: slowSource() });
      try {
        await Promise.race([
          firstEncryptedChunk,
          upload.then(() => { throw new Error('upload finished before the sink consumed ciphertext'); }),
        ]);
        expect(producerFinishedAtFirstEncryptedChunk).toBe(false);
      } finally {
        resumeSink();
      }

      const ack = await upload;
      const stored = s3.objects.get(STORAGE_KEY)!;
      const retainedWrite = s3.objectWrites.find((write) => write.key === STORAGE_KEY)!;
      const streamed = s3.streamedObjects.get(STORAGE_KEY)!;
      const manifest = JSON.parse(s3.objects.get(STORAGE_KEY + '.crypto-manifest.json')!.body.toString('utf8')) as {
        kind: string;
        ciphertextSizeBytes: number;
        ciphertextSha256: string;
        encryption: { totalSizeBytes: number; fileSha256: string; chunks: readonly { sizeBytes: number }[] };
      };

      expect(s3.sourcePullsAtFirstEncryptedRead).not.toBeNull();
      expect(s3.sourcePullsAtFirstEncryptedRead).toBeLessThan(pulls);
      expect(streamed.producerActiveAtFirstChunk).toBe(true);
      expect(streamed.byteCount).toBe(size);
      expect(streamed.chunkCount).toBeGreaterThan(1);
      expect(streamed.sha256).toBe(ack.ciphertextSha256);
      expect(manifest.kind).toBe('chunked');
      expect(manifest.ciphertextSizeBytes).toBe(size);
      expect(manifest.ciphertextSha256).toBe(streamed.sha256);
      expect(manifest.encryption.totalSizeBytes).toBe(size);
      expect(manifest.encryption.chunks.length).toBeGreaterThan(1);
      expect(manifest.encryption.chunks.every((chunk) => chunk.sizeBytes <= CRYPTO_STORAGE_CHUNK_SIZE_BYTES)).toBe(true);
      expect(manifest.encryption.chunks.reduce((total, chunk) => total + chunk.sizeBytes, 0)).toBe(size);
      expect(stored.body.length).toBe(0);
      expect(retainedWrite.body.length).toBe(0);
      expect(ack.ciphertextSizeBytes).toBe(size);
      expect(row.sizeBytes).toBe(size);
    } finally {
      await s3.cleanupEncryptedStreamSink();
    }
  });

  test('uses S3 multipart only for ciphertext and commits the completed immutable generation', async () => {
    const size = CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES + 1;
    const plaintext = Buffer.alloc(size, 91);
    const { gateway, s3, row } = gatewayFor({
      size,
      putObjectMaxBytes: 1,
      multipartPartBytes: 5 * 1024 * 1024,
    });
    const ack = await gateway.upload({ artifactId: ARTIFACT_ID, tenantId: TENANT_ID, source: sourceOf(plaintext) });
    const stored = s3.objects.get(STORAGE_KEY)!;

    expect(s3.commands).toContain('CreateMultipartUpload');
    expect(s3.commands).toContain('UploadPart');
    expect(s3.commands).toContain('CompleteMultipartUpload');
    expect(stored.body.equals(plaintext)).toBe(false);
    expect(stored.body.length).toBe(size);
    expect(row.state).toBe('READY');
    expect(ack.storageVersionId).toBe(stored.versionId);
  });

  test('rejects a declared object above the configured cap before reading or storing bytes', async () => {
    const { gateway, row, s3 } = gatewayFor({ size: 10, maxBytes: 9 });
    let pulled = false;
    async function* source(): AsyncGenerator<Uint8Array> {
      pulled = true;
      yield Buffer.alloc(10);
    }
    await expect(gateway.upload({ artifactId: ARTIFACT_ID, tenantId: TENANT_ID, source: source() }))
      .rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
    expect(pulled).toBe(false);
    expect(row.state).toBe('STAGING');
    expect(s3.commands).toEqual([]);
  });

  test('source abort releases only its claim and a retry can complete encrypted upload', async () => {
    const size = CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES + 100;
    const { gateway, row, s3 } = gatewayFor({ size });
    async function* aborted(): AsyncGenerator<Uint8Array> {
      yield Buffer.alloc(CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES + 1, 17);
      throw new Error('client disconnected');
    }
    await expect(gateway.upload({ artifactId: ARTIFACT_ID, tenantId: TENANT_ID, source: aborted() }))
      .rejects.toMatchObject({ status: 400, code: 'MALFORMED_BODY' });
    expect(row.state).toBe('STAGING');
    expect(row.token).not.toBe(ORIGINAL_BEARER);
    expect(row.claimExpiresAt).toBeNull();
    expect(s3.objects.has(STORAGE_KEY)).toBe(false);

    const plaintext = Buffer.alloc(size, 29);
    const ack = await gateway.upload({ artifactId: ARTIFACT_ID, tenantId: TENANT_ID, source: sourceOf(plaintext) });
    expect(ack.state).toBe('READY');
    expect(row.state).toBe('READY');
    expect(s3.objects.has(STORAGE_KEY)).toBe(true);
  });

  test('same upload session takes over an abandoned claim after grace and fences the stale uploader', async () => {
    let clock = Date.now();
    const claimTtlMs = 40;
    const { gateway, row, s3 } = gatewayFor({
      size: 14,
      claimTtlMs,
      now: () => clock,
    });
    let announceFirstPut!: () => void;
    const firstPutStarted = new Promise<void>((resolve) => { announceFirstPut = resolve; });
    let resumeFirstPut!: () => void;
    const firstPutBarrier = new Promise<void>((resolve) => { resumeFirstPut = resolve; });
    s3.beforeFirstEncryptedPut = async () => {
      announceFirstPut();
      await firstPutBarrier;
    };

    const staleUpload = gateway.upload({
      artifactId: ARTIFACT_ID,
      tenantId: TENANT_ID,
      source: sourceOf(Buffer.from('first uploader')),
    });
    await firstPutStarted;
    const abandonedClaimToken = row.token;
    const abandonedUploadToken = row.uploadToken;
    expect(row.claimExpiresAt?.getTime()).toBe(clock + claimTtlMs);
    await expect(gateway.upload({
      artifactId: ARTIFACT_ID,
      tenantId: TENANT_ID,
      source: sourceOf(Buffer.from('second attempt')),
    })).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    expect(row.token).toBe(abandonedClaimToken);

    // Model a retry after the crashed uploader's configured grace period.
    clock += claimTtlMs + 1;
    const winnerPlaintext = Buffer.from('retry upload!!');
    const winner = await gateway.upload({
      artifactId: ARTIFACT_ID,
      tenantId: TENANT_ID,
      source: sourceOf(winnerPlaintext),
    });
    const winningClaimToken = row.token;
    expect(row.uploadToken).toBe(abandonedUploadToken);
    expect(winningClaimToken).not.toBe(abandonedClaimToken);
    expect(winner.state).toBe('READY');

    // The old uploader may finish its S3 work, but its stale claim CAS cannot
    // commit over the retry; its own exact object versions are then removed.
    resumeFirstPut();
    await expect(staleUpload).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    expect(row.state).toBe('READY');
    expect(row.token).toBe(winningClaimToken);
    expect(row.uploadToken).toBe(UPLOAD_TOKEN);

    const manifestKey = STORAGE_KEY + '.crypto-manifest.json';
    const loserManifestDelete = s3.deletedVersions.find((item) => item.key === manifestKey);
    expect(loserManifestDelete).toBeDefined();
    expect(s3.versions.get(manifestKey)?.has(loserManifestDelete!.versionId)).toBe(false);
    await expect(s3.getVersion(manifestKey, loserManifestDelete!.versionId)).rejects.toThrow('NoSuchVersion');

    const winningManifest = s3.objects.get(manifestKey)!;
    const manifest = JSON.parse(winningManifest.body.toString('utf8')) as { ciphertextSha256: string };
    expect(manifest.ciphertextSha256).toBe(winner.ciphertextSha256);
    expect(s3.objects.get(STORAGE_KEY)?.versionId).toBe(winner.storageVersionId);
    const committedManifestVersionId = row.manifestVersionId!;
    await s3.send(new PutObjectCommand({
      Bucket: 'offline-test',
      Key: manifestKey,
      Body: Buffer.from('newer object at the same manifest key'),
      Metadata: { ...winningManifest.metadata },
    }));
    s3.versionRequests.length = 0;
    const replays = await Promise.allSettled([
      gateway.completeReplay(ARTIFACT_ID, TENANT_ID, { sha256: winner.ciphertextSha256 }),
      gateway.completeReplay(ARTIFACT_ID, TENANT_ID, { sha256: '0'.repeat(64) }),
    ]);
    expect(replays[0]).toMatchObject({
      status: 'fulfilled',
      value: { state: 'READY', replayed: true, storageVersionId: winner.storageVersionId },
    });
    expect(replays[1]).toMatchObject({
      status: 'rejected',
      reason: { status: 409, code: 'STATE_CONFLICT' },
    });
    expect(s3.versionRequests.filter((request) => request.key === manifestKey)).toEqual([
      { command: 'HeadObject', key: manifestKey, versionId: committedManifestVersionId },
      { command: 'GetObject', key: manifestKey, versionId: committedManifestVersionId },
    ]);
  });

  test('a claim whose release is lost can be retried after the configured grace', async () => {
    let clock = Date.now();
    const claimTtlMs = 25;
    const { gateway, row, control } = gatewayFor({ size: 8, claimTtlMs, now: () => clock });
    control.releaseFailuresRemaining = 1;
    async function* disconnected(): AsyncGenerator<Uint8Array> {
      throw new Error('simulated process loss after claim');
    }

    await expect(gateway.upload({ artifactId: ARTIFACT_ID, tenantId: TENANT_ID, source: disconnected() }))
      .rejects.toMatchObject({ status: 400, code: 'MALFORMED_BODY' });
    const abandonedClaimToken = row.token;
    expect(abandonedClaimToken).not.toBe(ORIGINAL_BEARER);
    expect(row.claimExpiresAt?.getTime()).toBe(clock + claimTtlMs);
    expect(row.uploadToken).toBe(UPLOAD_TOKEN);

    clock += claimTtlMs + 1;
    const ack = await gateway.upload({
      artifactId: ARTIFACT_ID,
      tenantId: TENANT_ID,
      source: sourceOf(Buffer.from('retry-ok')),
    });
    expect(ack.state).toBe('READY');
    expect(row.state).toBe('READY');
    expect(row.token).not.toBe(abandonedClaimToken);
    expect(row.claimExpiresAt).toBeNull();
  });

  test('Vault wrap outage fails closed and leaves no plaintext or ciphertext object', async () => {
    const plaintext = Buffer.from('cannot persist when transit is unavailable');
    const { gateway, row, s3 } = gatewayFor({ size: plaintext.length, provider: keyProvider(true) });
    await expect(gateway.upload({ artifactId: ARTIFACT_ID, tenantId: TENANT_ID, source: sourceOf(plaintext) }))
      .rejects.toMatchObject({ status: 503, code: 'TEMPORARY_UNAVAILABLE' });
    expect(row.state).toBe('STAGING');
    expect(row.token).not.toBe(ORIGINAL_BEARER);
    expect(row.claimExpiresAt).toBeNull();
    expect(s3.objects.size).toBe(0);
    expect(s3.commands).not.toContain('PutObject');
  });
});
