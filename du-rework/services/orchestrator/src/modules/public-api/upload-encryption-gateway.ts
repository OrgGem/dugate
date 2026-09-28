import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
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
import {
  MULTIPART_FIXED_PART_BYTES,
  MULTIPART_MAX_TOTAL_BYTES,
  MULTIPART_MIN_TOTAL_BYTES,
  MULTIPART_SESSION_TTL_MS,
} from '@du/contracts';
import { HttpError } from '../../http/errors';
import type { Db } from '../../db/db';
import {
  CRYPTO_STORAGE_CHUNK_SIZE_BYTES,
  CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES,
  CryptoStorageError,
  type CryptoStorageEncryptContext,
  type CryptoStorageFacade,
  type EncryptedStorageManifest,
  type EncryptedStorageObject,
} from '../encryption/crypto-storage-facade';

const FIVE_GIB = 5 * 1024 * 1024 * 1024;
const DEFAULT_MAX_UPLOAD_BYTES = MULTIPART_MAX_TOTAL_BYTES;
const DEFAULT_S3_PART_BYTES = MULTIPART_FIXED_PART_BYTES;
const MIN_S3_PART_BYTES = 5 * 1024 * 1024;
const SINGLE_INIT_LIMIT_BYTES = MULTIPART_MIN_TOTAL_BYTES - 1;
const PUBLIC_SESSION_TTL_MS = MULTIPART_SESSION_TTL_MS;
const MAX_S3_PARTS = 10_000;
const CLAIM_TTL_MS = 60 * 60 * 1000;
const SHA256_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface StagingUpload {
  readonly artifactId: string;
  readonly tenantId: string;
  readonly storageKey: string;
  readonly storageBackend: string;
  readonly uploadToken: string | null;
  readonly multipartUploadId: string | null;
  readonly mimeType: string;
  readonly sizeBytes: number | string;
  readonly state: string;
  readonly claimToken: string | null;
  readonly originalToken?: string | null;
  readonly claimExpiresAt: Date | string | null;
  readonly sessionExpiresAt?: Date | string | null;
  readonly storageVersionId: string | null;
  readonly sha256: string | null;
}

interface ClaimedUpload extends StagingUpload {
  readonly sizeBytes: number;
  readonly uploadToken: string;
  readonly claimToken: string;
  readonly originalToken: string;
}

interface CiphertextStats {
  bytes: number;
  readonly hash: ReturnType<typeof createHash>;
}

export interface PublicEncryptedUploadAck {
  readonly artifactId: string;
  readonly state: 'READY';
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly ciphertextSizeBytes: number;
  readonly ciphertextSha256: string;
  readonly plaintextSha256?: string;
  readonly storageVersionId: string;
  readonly manifestKey: string;
  readonly replayed: boolean;
}

export interface PublicUploadGateway {
  initSingle(tenantId: string, body: unknown): Promise<PublicUploadInitAck>;
  upload(input: {
    readonly artifactId: string;
    readonly tenantId: string;
    readonly source: AsyncIterable<Uint8Array>;
    readonly contentLength?: string;
    readonly plaintextSha256?: string;
  }): Promise<PublicEncryptedUploadAck>;
  completeReplay(artifactId: string, tenantId: string, body: unknown): Promise<PublicEncryptedUploadAck>;
}

export interface PublicUploadInitAck {
  readonly artifactId: string;
  readonly uploadHandle: string;
  readonly partSizeBytes: number;
  readonly partCount: 1;
  readonly expiresAt: string;
  readonly replayed: boolean;
}

export interface PublicUploadGatewayOptions {
  readonly db: Db;
  readonly client: S3Client;
  readonly bucket: string;
  readonly cryptoStorage: Pick<CryptoStorageFacade, 'encrypt' | 'encryptStream'>;
  readonly keyRef: string;
  readonly keyVersion?: number;
  readonly maxBytes?: number;
  /** Exposed as a narrow offline seam; production keeps the S3 5 GiB limit. */
  readonly putObjectMaxBytes?: number;
  readonly multipartPartBytes?: number;
  readonly now?: () => number;
}

function unavailable(message = 'encrypted upload storage is temporarily unavailable'): HttpError {
  return new HttpError(503, 'TEMPORARY_UNAVAILABLE', message);
}

function conflict(message: string): HttpError {
  return new HttpError(409, 'STATE_CONFLICT', message);
}

function malformed(message: string): HttpError {
  return new HttpError(400, 'MALFORMED_BODY', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveSafeInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function isNotFoundMultipart(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const name = typeof error.name === 'string' ? error.name : '';
  const code = typeof error.Code === 'string' ? error.Code : '';
  return name === 'NoSuchUpload' || code === 'NoSuchUpload';
}

function validStorageKey(value: string): boolean {
  return value.length > 0 && value.length <= 1024 && !value.includes('..') && !/[\u0000-\u001f\u007f]/.test(value);
}

function mapCryptoError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  if (error instanceof CryptoStorageError) {
    if (error.code === 'INVALID_INPUT' || error.code === 'SIZE_LIMIT') {
      throw new HttpError(error.code === 'SIZE_LIMIT' ? 413 : 400,
        error.code === 'SIZE_LIMIT' ? 'PAYLOAD_TOO_LARGE' : 'MALFORMED_BODY',
        'encrypted upload could not be completed');
    }
    throw unavailable('encrypted upload could not be completed');
  }
  throw unavailable();
}

async function* countAndHashPlaintext(
  source: AsyncIterable<Uint8Array>,
  expectedBytes: number,
  maxBytes: number,
  digest: ReturnType<typeof createHash>,
): AsyncGenerator<Uint8Array, void, void> {
  let seen = 0;
  try {
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array)) throw malformed('upload stream chunks must be byte arrays');
      seen += chunk.byteLength;
      if (!Number.isSafeInteger(seen) || seen > maxBytes || seen > expectedBytes) {
        throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'upload exceeds its declared size limit');
      }
      digest.update(chunk);
      yield chunk;
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw malformed('upload stream was interrupted');
  }
  if (seen !== expectedBytes) throw malformed('upload byte count does not match the declared size');
}

async function collectBounded(
  source: AsyncIterable<Uint8Array>,
  expectedBytes: number,
  maxBytes: number,
): Promise<Buffer> {
  if (expectedBytes > maxBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'upload exceeds its configured size limit');
  const body = Buffer.allocUnsafe(expectedBytes);
  let offset = 0;
  try {
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array)) throw malformed('upload stream chunks must be byte arrays');
      if (chunk.byteLength > expectedBytes - offset) {
        throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'upload exceeds its declared size limit');
      }
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).copy(body, offset);
      offset += chunk.byteLength;
    }
    if (offset !== expectedBytes) throw malformed('upload byte count does not match the declared size');
    return body;
  } catch (error) {
    body.fill(0);
    if (error instanceof HttpError) throw error;
    throw malformed('upload stream was interrupted');
  }
}

async function* monitorCiphertext(
  source: AsyncIterable<Uint8Array>,
  stats: CiphertextStats,
  expectedBytes: number,
): AsyncGenerator<Uint8Array, void, void> {
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) throw new Error('ciphertext stream returned a non-byte chunk');
    stats.bytes += chunk.byteLength;
    if (!Number.isSafeInteger(stats.bytes) || stats.bytes > expectedBytes) {
      throw new Error('ciphertext length exceeded its declared size');
    }
    stats.hash.update(chunk);
    yield chunk;
  }
  if (stats.bytes !== expectedBytes) throw new Error('ciphertext length did not match its declared size');
}

async function* fixedS3Parts(
  source: AsyncIterable<Uint8Array>,
  partBytes: number,
): AsyncGenerator<Buffer, void, void> {
  const buffer = Buffer.allocUnsafe(partBytes);
  let used = 0;
  try {
    for await (const chunk of source) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const take = Math.min(partBytes - used, chunk.byteLength - offset);
        Buffer.from(chunk.buffer, chunk.byteOffset + offset, take).copy(buffer, used, 0, take);
        offset += take;
        used += take;
        if (used === partBytes) {
          yield Buffer.from(buffer);
          used = 0;
        }
      }
    }
    if (used > 0) yield Buffer.from(buffer.subarray(0, used));
  } finally {
    buffer.fill(0);
  }
}

async function hashReadable(body: unknown, expectedBytes: number): Promise<{ bytes: number; sha256: string }> {
  if (!body || typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== 'function') {
    throw unavailable('uploaded object could not be read back for verification');
  }
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      if (!(chunk instanceof Uint8Array)) throw new Error('object body contains a non-byte chunk');
      bytes += chunk.byteLength;
      if (!Number.isSafeInteger(bytes) || bytes > expectedBytes) {
        throw conflict('stored object size does not match its encrypted upload');
      }
      hash.update(chunk);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unavailable('uploaded object could not be read back for verification');
  }
  if (bytes !== expectedBytes) throw conflict('stored object size does not match its encrypted upload');
  return { bytes, sha256: hash.digest('hex') };
}

function manifestKeyFor(storageKey: string): string {
  return storageKey + '.crypto-manifest.json';
}

function encryptContext(upload: ClaimedUpload, tenantId: string, options: PublicUploadGatewayOptions): CryptoStorageEncryptContext {
  return {
    tenantId,
    artifactId: upload.artifactId,
    objectVersion: upload.uploadToken,
    purpose: 'public-artifact-upload',
    keyRef: options.keyRef,
    ...(options.keyVersion === undefined ? {} : { keyVersion: options.keyVersion }),
  };
}

export function createPublicUploadGateway(options: PublicUploadGatewayOptions): PublicUploadGateway {
  if (!options || !options.db || !options.client || typeof options.bucket !== 'string' || !options.bucket) {
    throw new Error('public upload gateway requires database, S3 client, and bucket');
  }
  if (!options.cryptoStorage || typeof options.cryptoStorage.encrypt !== 'function'
      || typeof options.cryptoStorage.encryptStream !== 'function') {
    throw new Error('public upload gateway requires a crypto storage facade');
  }
  if (typeof options.keyRef !== 'string' || options.keyRef.length < 1 || options.keyRef.length > 256
      || /[\u0000-\u001f\u007f-\u009f]/.test(options.keyRef)) {
    throw new Error('public upload gateway requires an allowlisted storage key ref');
  }
  if (options.keyVersion !== undefined
      && (!Number.isSafeInteger(options.keyVersion) || options.keyVersion < 1 || options.keyVersion > 2_147_483_647)) {
    throw new Error('public upload Vault key version must be a positive safe integer');
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const putObjectMaxBytes = options.putObjectMaxBytes ?? FIVE_GIB;
  const multipartPartBytes = options.multipartPartBytes ?? DEFAULT_S3_PART_BYTES;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_UPLOAD_BYTES) {
    throw new Error('public upload maxBytes must be between 1 byte and 8 GiB');
  }
  if (!Number.isSafeInteger(putObjectMaxBytes) || putObjectMaxBytes < 1 || putObjectMaxBytes > FIVE_GIB) {
    throw new Error('S3 PutObject threshold must be a positive value no greater than 5 GiB');
  }
  if (!Number.isSafeInteger(multipartPartBytes) || multipartPartBytes < MIN_S3_PART_BYTES) {
    throw new Error('S3 multipart part size must be at least 5 MiB');
  }

  async function claim(artifactId: string, tenantId: string): Promise<ClaimedUpload> {
    const claimToken = randomUUID();
    const at = new Date(now());
    const expires = new Date(at.getTime() + CLAIM_TTL_MS);
    return options.db.tx(async (client) => {
      const selected = await client.query<StagingUpload>(
        `SELECT id AS "artifactId", tenant_id AS "tenantId", storage_key AS "storageKey",
                storage_backend AS "storageBackend", upload_token AS "uploadToken",
                multipart_upload_id AS "multipartUploadId", mime_type AS "mimeType",
                size_bytes AS "sizeBytes", state, token AS "claimToken", token AS "originalToken",
                token_expires_at AS "claimExpiresAt", storage_version_id AS "storageVersionId",
                multipart_expires_at AS "sessionExpiresAt",
                sha256
         FROM artifacts WHERE id=$1 AND tenant_id=$2 AND task_id IS NULL FOR UPDATE`,
        [artifactId, tenantId],
      );
      if (!selected.rowCount) throw new HttpError(404, 'NOT_FOUND', 'upload session not found');
      const row = selected.rows[0]!;
      if (row.state !== 'STAGING' || row.storageVersionId) throw conflict('upload is not in STAGING state');
      if (row.storageBackend !== 's3') throw conflict('public encrypted uploads require S3 object storage');
      if (!row.uploadToken || !row.originalToken || !validStorageKey(row.storageKey)) {
        throw conflict('upload session is missing required storage metadata');
      }
      const expiresAt = row.claimExpiresAt === null ? null : new Date(row.claimExpiresAt).getTime();
      if (expiresAt !== null && Number.isFinite(expiresAt) && expiresAt > at.getTime()) {
        throw conflict('another upload request is already active');
      }
      const sizeBytes = positiveSafeInteger(row.sizeBytes);
      if (sizeBytes === null || sizeBytes > maxBytes) {
        throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'upload exceeds its configured size limit');
      }
      if (!row.multipartUploadId && sizeBytes > SINGLE_INIT_LIMIT_BYTES) {
        throw conflict('large upload session is missing its server-side multipart handle');
      }
      const sessionExpiresAt = row.sessionExpiresAt === null || row.sessionExpiresAt === undefined
        ? Number.NaN
        : new Date(row.sessionExpiresAt).getTime();
      if (!Number.isFinite(sessionExpiresAt) || sessionExpiresAt <= at.getTime()) {
        throw conflict('upload session expired; start a new upload');
      }
      await client.query(
        `UPDATE artifacts SET token=$3, token_expires_at=$4
         WHERE id=$1 AND tenant_id=$2 AND state='STAGING'`,
        [artifactId, tenantId, claimToken, expires],
      );
      return { ...row, sizeBytes, uploadToken: row.uploadToken, claimToken, originalToken: row.originalToken };
    });
  }

  async function release(upload: ClaimedUpload): Promise<void> {
    await options.db.query(
      `UPDATE artifacts SET token=$4, token_expires_at=NULL
       WHERE id=$1 AND tenant_id=$2 AND state='STAGING' AND token=$3`,
      [upload.artifactId, upload.tenantId, upload.claimToken, upload.originalToken],
    ).catch(() => undefined);
  }

  async function abortMultipart(uploadId: string, key: string): Promise<void> {
    try {
      await options.client.send(new AbortMultipartUploadCommand({
        Bucket: options.bucket,
        Key: key,
        UploadId: uploadId,
      }));
    } catch (error) {
      if (!isNotFoundMultipart(error)) throw unavailable('an old direct-upload session could not be closed');
    }
  }

  async function storeCiphertext(input: {
    upload: ClaimedUpload;
    source: AsyncIterable<Uint8Array>;
    expectedPlaintextSha256?: string;
    manifestKey: string;
  }): Promise<{
    readonly manifest: EncryptedStorageManifest | EncryptedStorageObject;
    readonly versionId: string;
    readonly ciphertextSizeBytes: number;
    readonly ciphertextSha256: string;
    readonly plaintextSha256: string;
  }> {
    const { upload } = input;
    const cryptoContext = encryptContext(upload, upload.tenantId, options);
    const metadata = {
      artifactid: upload.artifactId,
      tenantid: upload.tenantId,
      'du-encrypted': 'aes-256-gcm-v1',
      'du-manifest-key': input.manifestKey,
    };
    const stats: CiphertextStats = { bytes: 0, hash: createHash('sha256') };
    let versionId: string | undefined;
    let newMultipartId: string | undefined;
    let multipartCompleted = false;
    let encryptionStream: ReturnType<CryptoStorageFacade['encryptStream']> | undefined;
    let plainBuffer: Buffer | undefined;
    let cipherBuffer: Buffer | undefined;
    let manifest: EncryptedStorageManifest | EncryptedStorageObject;
    let plaintextSha256: string;

    try {
      if (upload.sizeBytes <= CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES) {
        plainBuffer = await collectBounded(input.source, upload.sizeBytes, maxBytes);
        plaintextSha256 = createHash('sha256').update(plainBuffer).digest('hex');
        if (input.expectedPlaintextSha256 && plaintextSha256 !== input.expectedPlaintextSha256) {
          throw conflict('plaintext checksum does not match the declared checksum');
        }
        const encrypted = await options.cryptoStorage.encrypt(plainBuffer, cryptoContext);
        manifest = encrypted;
        cipherBuffer = encrypted.ciphertext;
        stats.bytes = cipherBuffer.length;
        stats.hash.update(cipherBuffer);
        if (stats.bytes !== upload.sizeBytes) throw conflict('ciphertext size does not match the declared size');
        const output = await options.client.send(new PutObjectCommand({
          Bucket: options.bucket,
          Key: upload.storageKey,
          Body: cipherBuffer,
          ContentLength: stats.bytes,
          ContentType: 'application/octet-stream',
          Metadata: metadata,
        }));
        versionId = (output as { VersionId?: string }).VersionId;
      } else {
        const plaintextDigest = createHash('sha256');
        const boundedSource = countAndHashPlaintext(input.source, upload.sizeBytes, maxBytes, plaintextDigest);
        encryptionStream = options.cryptoStorage.encryptStream(boundedSource, cryptoContext);
        const monitored = monitorCiphertext(encryptionStream.ciphertext, stats, upload.sizeBytes);
        const body = Readable.from(monitored, {
          objectMode: false,
          highWaterMark: CRYPTO_STORAGE_CHUNK_SIZE_BYTES * 2,
        });
        if (upload.sizeBytes <= putObjectMaxBytes) {
          const [output, encryptedManifest] = await Promise.all([
            options.client.send(new PutObjectCommand({
              Bucket: options.bucket,
              Key: upload.storageKey,
              Body: body,
              ContentLength: upload.sizeBytes,
              ContentType: 'application/octet-stream',
              Metadata: metadata,
            })),
            encryptionStream.manifest,
          ]);
          versionId = (output as { VersionId?: string }).VersionId;
          manifest = encryptedManifest;
          plaintextSha256 = encryptedManifest.fileSha256;
          if (plaintextDigest.digest('hex') !== plaintextSha256) {
            throw conflict('plaintext checksum does not match the encrypted manifest');
          }
        } else {
          const created = await options.client.send(new CreateMultipartUploadCommand({
            Bucket: options.bucket,
            Key: upload.storageKey,
            ContentType: 'application/octet-stream',
            Metadata: metadata,
          }));
          newMultipartId = (created as { UploadId?: string }).UploadId;
          if (!newMultipartId) throw unavailable('encrypted multipart upload could not be started');
          const parts: Array<{ ETag: string; PartNumber: number }> = [];
          let partNumber = 0;
          for await (const part of fixedS3Parts(body, multipartPartBytes)) {
            partNumber++;
            if (partNumber > MAX_S3_PARTS) {
              part.fill(0);
              throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'upload exceeds the S3 multipart part limit');
            }
            const partResult = await options.client.send(new UploadPartCommand({
              Bucket: options.bucket,
              Key: upload.storageKey,
              UploadId: newMultipartId,
              PartNumber: partNumber,
              Body: part,
              ContentLength: part.length,
            }));
            const etag = (partResult as { ETag?: string }).ETag;
            part.fill(0);
            if (!etag) throw unavailable('encrypted multipart part was not acknowledged');
            parts.push({ ETag: etag, PartNumber: partNumber });
          }
          const encryptedManifest = await encryptionStream.manifest;
          plaintextSha256 = encryptedManifest.fileSha256;
          if (plaintextDigest.digest('hex') !== plaintextSha256) {
            throw conflict('plaintext checksum does not match the encrypted manifest');
          }
          const completed = await options.client.send(new CompleteMultipartUploadCommand({
            Bucket: options.bucket,
            Key: upload.storageKey,
            UploadId: newMultipartId,
            MultipartUpload: { Parts: parts },
          }));
          versionId = (completed as { VersionId?: string }).VersionId;
          manifest = encryptedManifest;
          multipartCompleted = true;
        }
      }
      if (stats.bytes !== upload.sizeBytes) throw conflict('ciphertext size does not match the declared size');
      if (!versionId || versionId === 'null') throw unavailable('storage did not return an immutable object version');
      const ciphertextSha256 = stats.hash.digest('hex');
      if (input.expectedPlaintextSha256 && plaintextSha256 !== input.expectedPlaintextSha256) {
        throw conflict('plaintext checksum does not match the declared checksum');
      }
      if (encryptionStream) {
        // Count-and-hash sits below the crypto facade, so the manifest is the
        // authenticated source of the whole plaintext digest.
        const streamManifest = await encryptionStream.manifest;
        if (streamManifest.totalSizeBytes !== upload.sizeBytes) throw conflict('plaintext size does not match the declared size');
      }
      cipherBuffer?.fill(0);
      plainBuffer?.fill(0);
      return {
        manifest,
        versionId,
        ciphertextSizeBytes: stats.bytes,
        ciphertextSha256,
        plaintextSha256,
      };
    } catch (error) {
      encryptionStream?.ciphertext.destroy();
      if (newMultipartId && !multipartCompleted) {
        await options.client.send(new AbortMultipartUploadCommand({
          Bucket: options.bucket,
          Key: upload.storageKey,
          UploadId: newMultipartId,
        })).catch(() => undefined);
      }
      {
        await options.client.send(new DeleteObjectCommand({
          Bucket: options.bucket,
          Key: upload.storageKey,
          ...(versionId ? { VersionId: versionId } : {}),
        })).catch(() => undefined);
      }
      if (cipherBuffer) cipherBuffer.fill(0);
      plainBuffer?.fill(0);
      mapCryptoError(error);
    }
  }

  async function verifyCiphertext(
    upload: Pick<ClaimedUpload, 'artifactId' | 'tenantId' | 'storageKey'>,
    versionId: string,
    manifestKey: string,
    expectedBytes: number,
    expectedSha256: string,
  ): Promise<void> {
    let head: { ContentLength?: number; VersionId?: string; Metadata?: Record<string, string> };
    try {
      head = await options.client.send(new HeadObjectCommand({
        Bucket: options.bucket,
        Key: upload.storageKey,
        VersionId: versionId,
        ChecksumMode: 'ENABLED',
      })) as typeof head;
    } catch {
      throw unavailable('encrypted upload could not be verified');
    }
    if (
      head.ContentLength !== expectedBytes
      || (head.VersionId !== undefined && head.VersionId !== versionId)
      || head.Metadata?.artifactid !== upload.artifactId
      || head.Metadata?.tenantid !== upload.tenantId
      || head.Metadata?.['du-encrypted'] !== 'aes-256-gcm-v1'
      || head.Metadata?.['du-manifest-key'] !== manifestKey
    ) {
      throw conflict('stored encrypted object metadata does not match the upload');
    }
    let body: unknown;
    try {
      const output = await options.client.send(new GetObjectCommand({
        Bucket: options.bucket,
        Key: upload.storageKey,
        VersionId: versionId,
      }));
      body = (output as { Body?: unknown }).Body;
    } catch {
      throw unavailable('encrypted upload could not be verified');
    }
    const actual = await hashReadable(body, expectedBytes);
    if (actual.sha256 !== expectedSha256) throw conflict('stored ciphertext checksum does not match the upload');
  }

  async function storeAndVerifyManifest(
    upload: ClaimedUpload,
    manifestKey: string,
    manifest: EncryptedStorageManifest | EncryptedStorageObject,
    ciphertextSha256: string,
    ciphertextSizeBytes: number,
  ): Promise<void> {
    const kind = 'chunks' in manifest ? 'chunked' : 'single';
    const encryption = 'chunks' in manifest
      ? manifest
      : {
          version: manifest.version,
          algorithm: manifest.algorithm,
          nonce: manifest.nonce,
          tag: manifest.tag,
          aad: manifest.aad,
          plaintextSizeBytes: manifest.plaintextSizeBytes,
          plaintextSha256: manifest.plaintextSha256,
          dek: manifest.dek,
        };
    const metadata = Buffer.from(JSON.stringify({
      version: 1,
      kind,
      artifactId: upload.artifactId,
      tenantId: upload.tenantId,
      objectVersion: upload.uploadToken,
      ciphertextSizeBytes,
      ciphertextSha256,
      encryption,
    }), 'utf8');
    try {
      await options.client.send(new PutObjectCommand({
        Bucket: options.bucket,
        Key: manifestKey,
        Body: metadata,
        ContentLength: metadata.length,
        ContentType: 'application/json',
        Metadata: {
          artifactid: upload.artifactId,
          tenantid: upload.tenantId,
          'du-encrypted': 'manifest-v1',
        },
      }));
      const head = await options.client.send(new HeadObjectCommand({
        Bucket: options.bucket,
        Key: manifestKey,
      })) as { ContentLength?: number; Metadata?: Record<string, string> };
      if (
        head.ContentLength !== metadata.length
        || head.Metadata?.artifactid !== upload.artifactId
        || head.Metadata?.tenantid !== upload.tenantId
        || head.Metadata?.['du-encrypted'] !== 'manifest-v1'
      ) {
        throw conflict('encrypted upload manifest could not be verified');
      }
      const output = await options.client.send(new GetObjectCommand({ Bucket: options.bucket, Key: manifestKey }));
      const actual = await hashReadable((output as { Body?: unknown }).Body, metadata.length);
      const expected = createHash('sha256').update(metadata).digest('hex');
      if (actual.sha256 !== expected) throw conflict('encrypted upload manifest checksum does not match');
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw unavailable('encrypted upload manifest could not be stored');
    } finally {
      metadata.fill(0);
    }
  }

  async function commit(
    upload: ClaimedUpload,
    input: { versionId: string; ciphertextSha256: string; ciphertextSizeBytes: number },
  ): Promise<void> {
    const updated = await options.db.tx(async (client) => client.query(
      `UPDATE artifacts SET state='READY', storage_version_id=$4, sha256=$5,
                            size_bytes=$6, multipart_upload_id=NULL, token=$7, token_expires_at=NULL
       WHERE id=$1 AND tenant_id=$2 AND state='STAGING' AND token=$3
       RETURNING id`,
      [upload.artifactId, upload.tenantId, upload.claimToken, input.versionId,
        input.ciphertextSha256, input.ciphertextSizeBytes, upload.originalToken],
    ));
    if (!updated.rowCount) throw conflict('upload changed before the encrypted bytes could be committed');
  }

  async function deleteWrittenObjects(
    upload: ClaimedUpload,
    manifestKey: string,
    versionId: string | undefined,
    manifestWritten: boolean,
  ): Promise<void> {
    if (manifestWritten) {
      await options.client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: manifestKey })).catch(() => undefined);
    }
    if (versionId) {
      await options.client.send(new DeleteObjectCommand({
        Bucket: options.bucket,
        Key: upload.storageKey,
        VersionId: versionId,
      })).catch(() => undefined);
    }
  }

  return {
    async initSingle(tenantId, body): Promise<PublicUploadInitAck> {
      if (!isRecord(body)) throw malformed('upload initialization must be an object');
      const uploadToken = body.uploadToken;
      const mimeType = body.mimeType;
      const sizeBytes = positiveSafeInteger(body.sizeBytes);
      const fileName = body.fileName;
      if (typeof uploadToken !== 'string' || !UUID_RE.test(uploadToken)) {
        throw malformed('uploadToken must be a UUID');
      }
      if (typeof mimeType !== 'string' || mimeType.length < 1 || mimeType.length > 255
          || /[\u0000-\u001f\u007f-\u009f]/.test(mimeType)) {
        throw malformed('mimeType is invalid');
      }
      if (fileName !== undefined && (typeof fileName !== 'string' || fileName.length < 1 || fileName.length > 1024
          || /[\u0000-\u001f\u007f-\u009f]/.test(fileName))) {
        throw malformed('fileName is invalid');
      }
      if (sizeBytes === null) throw malformed('sizeBytes must be a positive integer');
      if (sizeBytes > SINGLE_INIT_LIMIT_BYTES || sizeBytes > maxBytes) {
        throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'single upload exceeds its configured size limit');
      }

      const expiresAt = new Date(now() + PUBLIC_SESSION_TTL_MS);
      const result = await options.db.tx(async (client) => {
        const selectByToken = `SELECT id AS "artifactId", purpose, file_name AS "fileName",
                                      mime_type AS "mimeType", size_bytes AS "sizeBytes", state,
                                      multipart_expires_at AS "expiresAt"
                               FROM artifacts
                               WHERE tenant_id=$1 AND upload_token=$2 AND task_id IS NULL FOR UPDATE`;
        const existing = await client.query<{
          artifactId: string;
          purpose: string;
          fileName: string | null;
          mimeType: string;
          sizeBytes: number | string;
          state: string;
          expiresAt: Date | string | null;
        }>(selectByToken, [tenantId, uploadToken]);
        if (existing.rowCount) {
          const row = existing.rows[0]!;
          if (
            row.purpose !== 'input'
            || row.fileName !== (fileName ?? null)
            || row.mimeType !== mimeType
            || Number(row.sizeBytes) !== sizeBytes
          ) {
            throw conflict('uploadToken is already bound to different upload parameters');
          }
          if (row.state !== 'STAGING' && row.state !== 'READY') {
            throw conflict('upload session is no longer active');
          }
          if (!row.expiresAt) throw conflict('upload session expiry is missing');
          return {
            artifactId: row.artifactId,
            replayed: true,
            expiresAt: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : new Date(row.expiresAt).toISOString(),
          };
        }

        const artifactId = randomUUID();
        const storageKey = `art-${artifactId}`;
        const inserted = await client.query(
          `INSERT INTO artifacts (id, tenant_id, purpose, file_name, mime_type, size_bytes,
                                 state, token, storage_key, storage_backend, upload_token,
                                 part_size_bytes, part_count, multipart_expires_at)
           VALUES ($1,$2,'input',$3,$4,$5,'STAGING',$6,$7,'s3',$8,$9,1,$10)
           ON CONFLICT (tenant_id, upload_token) WHERE task_id IS NULL AND upload_token IS NOT NULL DO NOTHING
           RETURNING id`,
          [artifactId, tenantId, fileName ?? null, mimeType, sizeBytes, randomUUID(), storageKey,
            uploadToken, DEFAULT_S3_PART_BYTES, expiresAt],
        );
        if (!inserted.rowCount) {
          const winner = await client.query<{
            artifactId: string;
            purpose: string;
            fileName: string | null;
            mimeType: string;
            sizeBytes: number | string;
            state: string;
            expiresAt: Date | string | null;
          }>(selectByToken, [tenantId, uploadToken]);
          const row = winner.rows[0];
          if (!row || row.purpose !== 'input' || row.fileName !== (fileName ?? null)
              || row.mimeType !== mimeType || Number(row.sizeBytes) !== sizeBytes
              || (row.state !== 'STAGING' && row.state !== 'READY')) {
            throw conflict('uploadToken is already bound to another upload');
          }
          if (!row.expiresAt) throw conflict('upload session expiry is missing');
          return {
            artifactId: row.artifactId,
            replayed: true,
            expiresAt: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : new Date(row.expiresAt).toISOString(),
          };
        }
        return { artifactId, replayed: false, expiresAt: expiresAt.toISOString() };
      });
      const stableHandle = createHash('sha256')
        .update('du-public-single-upload|' + tenantId + '|' + uploadToken)
        .digest('hex')
        .slice(0, 32);
      return {
        ...result,
        uploadHandle: 'gateway_' + stableHandle,
        partSizeBytes: DEFAULT_S3_PART_BYTES,
        partCount: 1,
        expiresAt: result.expiresAt,
      };
    },

    async upload(input): Promise<PublicEncryptedUploadAck> {
      if (!input || !input.source || typeof input.source[Symbol.asyncIterator] !== 'function') {
        throw malformed('an upload byte stream is required');
      }
      const contentLength = input.contentLength === undefined
        ? null
        : positiveSafeInteger(input.contentLength);
      if (input.contentLength !== undefined && contentLength === null) {
        throw malformed('Content-Length must be a positive integer');
      }
      if (input.plaintextSha256 !== undefined && !SHA256_RE.test(input.plaintextSha256)) {
        throw malformed('x-content-sha256 must be a lowercase SHA-256 digest');
      }

      const upload = await claim(input.artifactId, input.tenantId);
      if (contentLength !== null && contentLength !== upload.sizeBytes) {
        await release(upload);
        throw malformed('Content-Length does not match the initialized upload size');
      }
      const manifestKey = manifestKeyFor(upload.storageKey);
      let writtenVersion: string | undefined;
      let manifestWritten = false;
      try {
        if (upload.multipartUploadId) await abortMultipart(upload.multipartUploadId, upload.storageKey);
        const stored = await storeCiphertext({
          upload,
          source: input.source,
          expectedPlaintextSha256: input.plaintextSha256,
          manifestKey,
        });
        writtenVersion = stored.versionId;
        await verifyCiphertext(upload, stored.versionId, manifestKey, stored.ciphertextSizeBytes, stored.ciphertextSha256);
        manifestWritten = true;
        await storeAndVerifyManifest(upload, manifestKey, stored.manifest, stored.ciphertextSha256, stored.ciphertextSizeBytes);
        await commit(upload, {
          versionId: stored.versionId,
          ciphertextSha256: stored.ciphertextSha256,
          ciphertextSizeBytes: stored.ciphertextSizeBytes,
        });
        return {
          artifactId: upload.artifactId,
          state: 'READY',
          sizeBytes: upload.sizeBytes,
          sha256: stored.ciphertextSha256,
          ciphertextSizeBytes: stored.ciphertextSizeBytes,
          ciphertextSha256: stored.ciphertextSha256,
          plaintextSha256: stored.plaintextSha256,
          storageVersionId: stored.versionId,
          manifestKey,
          replayed: false,
        };
      } catch (error) {
        await deleteWrittenObjects(upload, manifestKey, writtenVersion, manifestWritten);
        await release(upload);
        if (error instanceof HttpError) throw error;
        mapCryptoError(error);
      }
    },

    async completeReplay(artifactId, tenantId, body): Promise<PublicEncryptedUploadAck> {
      if (!isRecord(body) || typeof body.sha256 !== 'string' || !SHA256_RE.test(body.sha256)) {
        throw malformed('complete replay requires the ciphertext SHA-256');
      }
      const result = await options.db.query<StagingUpload>(
        `SELECT id AS "artifactId", tenant_id AS "tenantId", storage_key AS "storageKey",
                storage_backend AS "storageBackend", upload_token AS "uploadToken",
                multipart_upload_id AS "multipartUploadId", mime_type AS "mimeType",
                size_bytes AS "sizeBytes", state, token AS "claimToken",
                token_expires_at AS "claimExpiresAt", storage_version_id AS "storageVersionId",
                sha256
         FROM artifacts WHERE id=$1 AND tenant_id=$2 AND task_id IS NULL`,
        [artifactId, tenantId],
      );
      if (!result.rowCount) throw new HttpError(404, 'NOT_FOUND', 'upload session not found');
      const row = result.rows[0]!;
      if (row.state !== 'READY' || !row.storageVersionId || row.sha256 !== body.sha256) {
        throw conflict('upload is not a completed encrypted upload with this checksum');
      }
      const sizeBytes = positiveSafeInteger(row.sizeBytes);
      if (sizeBytes === null) throw conflict('completed upload metadata is invalid');
      const manifestKey = manifestKeyFor(row.storageKey);
      await verifyCiphertext({
        artifactId: row.artifactId,
        tenantId: row.tenantId,
        storageKey: row.storageKey,
      }, row.storageVersionId, manifestKey, sizeBytes, row.sha256);
      return {
        artifactId: row.artifactId,
        state: 'READY',
        sizeBytes,
        sha256: row.sha256,
        ciphertextSizeBytes: sizeBytes,
        ciphertextSha256: row.sha256,
        storageVersionId: row.storageVersionId,
        manifestKey,
        replayed: true,
      };
    },
  };
}
