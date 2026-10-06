import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  ChecksumAlgorithm,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { SourceIngestionError, type PinnedSourceStorage, type PinnedSourceWrite, type SourceIngestionReceipt } from '@du/worker-sdk';
import type { Db } from '../../db/db';
import {
  CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES,
  CryptoStorageError,
  type CryptoStorageEncryptContext,
  type CryptoStorageFacade,
  type EncryptedStorageManifest,
  type EncryptedStorageObject,
} from '../encryption/crypto-storage-facade';
import {
  ENCRYPTED_OBJECT_MARKER,
  ENCRYPTED_OBJECT_MARKER_VALUE,
  MANIFEST_KEY_METADATA,
  PUBLIC_UPLOAD_PURPOSE,
  manifestKeyFor,
} from '../encryption/artifact-read-decrypt';

/**
 * W-DATA03-CONSUMER-JOIN-1: the PinnedSourceStorage port over private S3.
 *
 * Two legs, deliberately split by durability:
 * - putVerified streams the acquired file into a NEW immutable object version
 *   (same rule as the artifact facade: the bucket must have versioning;
 *   a missing/'null' VersionId fails closed) while re-hashing and
 *   re-counting the exact bytes handed to the SDK. When S3 reports
 *   ChecksumSHA256 it is cross-checked against that measurement, so the
 *   versionId on the receipt is a digest storage itself agreed to.
 * - resolvePinned answers from the artifacts table: the READY row the
 *   consumer materializes IS the durable pin registry (storage_key +
 *   storage_version_id + sha256 + size_bytes), so a retry after a crash
 *   answers the pin - with its artifactId - without touching the network,
 *   exactly the idempotence the producer leg was built around.
 *
 * SEC-ENC-03 (SD-02): source bytes persisted from the URL / IAM-S3 legs are
 * CIPHERTEXT ONLY when the platform composes the encrypted variant. The
 * encrypted adapter reuses the canonical envelope writer
 * (`CryptoStorageFacade`) and the reader-compatible S3 layout
 * (`artifact-read-decrypt`): a `du-encrypted` ciphertext object plus a
 * `.crypto-manifest.json` sidecar whose immutable version the consumer stores
 * on the artifact row (`manifest_version_id`), together with the AAD-bound
 * `upload_token`. The PLAINTEXT business hash/length remain the receipt and
 * the row's `sha256`/`size_bytes`; the CIPHERTEXT hash/length are measured
 * separately for transfer integrity and never leak into the pin.
 *
 * The plaintext factory is byte-identical in behaviour to before this packet
 * (existing tests pin it); the encrypted factory is a distinct constructor so
 * a deployment either writes sealed source objects or keeps the historical
 * path, never a silent in-place switch.
 */

export interface S3PinnedSendResult {
  VersionId?: string;
  ChecksumSHA256?: string;
}

export type S3PinnedCommandSender = (command: unknown) => Promise<S3PinnedSendResult>;

export interface S3PinnedSourceStorageOptions {
  bucket: string;
  /** Real deployments pass (command) => client.send(command as never). */
  send: S3PinnedCommandSender;
  db: Db;
}

const PIN_FIND_SQL =
  'SELECT storage_version_id AS "versionId", sha256, size_bytes AS "sizeBytes", id FROM artifacts ' +
  "WHERE storage_key=$1 AND state='READY' AND storage_version_id IS NOT NULL AND sha256 IS NOT NULL " +
  'ORDER BY created_at DESC LIMIT 1';

function createResolvePinned(db: Db): PinnedSourceStorage['resolvePinned'] {
  return async (storageKey: string): Promise<SourceIngestionReceipt | null> => {
    const res = await db.query(PIN_FIND_SQL, [storageKey]);
    const row = res.rows[0] as
      | { versionId: string; sha256: string; sizeBytes: string | number; id: string }
      | undefined;
    if (!row || typeof row.versionId !== 'string' || typeof row.sha256 !== 'string') return null;
    return {
      storageKey,
      versionId: row.versionId,
      sha256: row.sha256.toLowerCase(),
      sizeBytes: Number(row.sizeBytes),
      artifactId: row.id,
    };
  };
}

/* ------------------------------------------------------------------ */
/* SEC-ENC-03: encrypted source variant                                */
/* ------------------------------------------------------------------ */

/**
 * Per-write envelope identity. `artifactId` is the artifacts row id the
 * consumer will insert; `objectVersion` is the `artifacts.upload_token` the
 * reader rebuilds its AAD from. Both are deterministic for a
 * (tenant, operation, storageKey) so a re-delivery re-derives the same row.
 */
export interface EncryptedSourceWriteContext {
  tenantId: string;
  artifactId: string;
  objectVersion: string;
}

/** Durable row-side facts of one encrypted write (never ciphertext itself). */
export interface EncryptedSourceWriteDescription {
  artifactId: string;
  objectVersion: string;
  manifestVersionId: string;
  ciphertextSha256: string;
  ciphertextSizeBytes: number;
}

export interface S3SourceEncryptionOptions {
  /** Canonical envelope writer (AES-256-GCM chunks / single-shot + wrapped DEK). */
  facade: Pick<CryptoStorageFacade, 'encrypt' | 'encryptStream'>;
  /** Allowlisted Vault Transit key ref; never a key value. */
  keyRef: string;
  keyVersion?: number;
}

export interface S3EncryptedPinnedSourceStorageOptions extends S3PinnedSourceStorageOptions {
  encryption: S3SourceEncryptionOptions;
}

export interface S3EncryptedPinnedSourceStorage extends PinnedSourceStorage {
  /**
   * Seal `input.body` with the canonical envelope writer and persist
   * ciphertext + manifest sidecar. Returns the SDK write receipt (plaintext
   * sha/size, ciphertext version) plus the description the caller stores on
   * the artifact row.
   */
  putEncrypted(
    input: Parameters<PinnedSourceStorage['putVerified']>[0],
    context: EncryptedSourceWriteContext,
  ): Promise<{ write: PinnedSourceWrite; description: EncryptedSourceWriteDescription }>;
}

/** Fixed namespace for the deterministic encrypted source identities. */
export const ENCRYPTED_SOURCE_NAMESPACE = '5e7c1b64-2f0a-5d8e-9b31-7c4a0f2e6d19';

function uuid5(namespace: string, name: string): string {
  const hash = createHash('sha1')
    .update(Buffer.concat([
      Buffer.from(namespace.replace(/-/g, ''), 'hex'),
      Buffer.from(name, 'utf8'),
    ]))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return (
    hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' + hex.slice(20)
  );
}

/** Deterministic row id for an encrypted source write. */
export function encryptedSourceArtifactId(input: {
  tenantId: string;
  operationId: string;
  storageKey: string;
}): string {
  return uuid5(ENCRYPTED_SOURCE_NAMESPACE, 'du-source-enc|' + input.tenantId + '|' + input.operationId + '|' + input.storageKey);
}

/** Deterministic AAD object version for an encrypted source write. */
export function encryptedSourceObjectVersion(input: {
  tenantId: string;
  operationId: string;
  storageKey: string;
}): string {
  return uuid5(ENCRYPTED_SOURCE_NAMESPACE, 'du-source-objver|' + input.tenantId + '|' + input.operationId + '|' + input.storageKey);
}

const PRINTABLE = /^[\x20-\x7e]+$/;

function invalidEncryption(message: string): never {
  throw new SourceIngestionError(502, 'STORAGE_FAILURE', message);
}

function assertContext(context: EncryptedSourceWriteContext): EncryptedSourceWriteContext {
  for (const [label, value] of [
    ['tenantId', context?.tenantId],
    ['artifactId', context?.artifactId],
    ['objectVersion', context?.objectVersion],
  ] as const) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 512 || !PRINTABLE.test(value)) {
      invalidEncryption('encrypted source context ' + label + ' is invalid');
    }
  }
  return context;
}

function assertEncryptionOptions(encryption: S3SourceEncryptionOptions): S3SourceEncryptionOptions {
  if (
    !encryption
    || !encryption.facade
    || typeof encryption.facade.encrypt !== 'function'
    || typeof encryption.facade.encryptStream !== 'function'
  ) {
    invalidEncryption('an envelope crypto facade is required for encrypted source storage');
  }
  if (typeof encryption.keyRef !== 'string' || encryption.keyRef.length < 1 || encryption.keyRef.length > 256) {
    invalidEncryption('an allowlisted storage key ref is required for encrypted source storage');
  }
  if (
    encryption.keyVersion !== undefined
    && (!Number.isSafeInteger(encryption.keyVersion) || encryption.keyVersion < 1 || encryption.keyVersion > 2_147_483_647)
  ) {
    invalidEncryption('encrypted source key version must be a positive safe integer');
  }
  return encryption;
}

function abortError(): SourceIngestionError {
  return new SourceIngestionError(502, 'STORAGE_FAILURE', 'pinned upload aborted before the version committed');
}

/** True when the storage adapter can perform context-bound encrypted writes. */
export function hasEncryptedSourceWriteCapability(
  storage: PinnedSourceStorage,
): storage is S3EncryptedPinnedSourceStorage {
  return typeof (storage as Partial<S3EncryptedPinnedSourceStorage>).putEncrypted === 'function';
}

/**
 * Bind one acquisition's envelope context to the shared encrypted adapter.
 * The SDK only knows the port, so this wrapper injects the per-operation
 * (tenant, operation, storageKey) identity and captures the write description
 * for the artifact-row materializer. Refuses to run when the base adapter has
 * no encrypted capability: a required-encryption deployment must never fall
 * back to the plaintext writer.
 */
export function createEncryptedSourceStorageWrapper(
  base: PinnedSourceStorage,
  options: {
    context: EncryptedSourceWriteContext;
    onWritten?: (description: EncryptedSourceWriteDescription) => void;
  },
): PinnedSourceStorage {
  if (!hasEncryptedSourceWriteCapability(base)) {
    throw new Error('encrypted source writes are required but the storage adapter does not implement putEncrypted');
  }
  const encrypted = base;
  assertContext(options.context);
  return {
    async putVerified(input) {
      const { write, description } = await encrypted.putEncrypted(input, options.context);
      options.onWritten?.(description);
      return write;
    },
    resolvePinned: (storageKey) => base.resolvePinned(storageKey),
  };
}

interface PlaintextSink {
  sha256: string;
  sizeBytes: number;
}

interface CiphertextSink {
  sha256: string;
  sizeBytes: number;
}

/**
 * Read the source until it either ends at or below the canonical single-shot
 * limit (buffer it for `facade.encrypt`) or crosses it (keep the read prefix
 * and hand the rest to `facade.encryptStream`). Memory stays bounded by the
 * single-shot limit plus one source chunk; the prefix is never double-held.
 */
async function planPlaintext(
  source: AsyncIterable<Uint8Array> | Readable,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<
  | { kind: 'single'; buffer: Buffer }
  | { kind: 'stream'; prefix: Buffer; rest: AsyncIterator<Uint8Array> }
> {
  const iterator = (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    if (signal?.aborted) {
      chunks.length = 0;
      throw abortError();
    }
    const next = await iterator.next();
    if (next.done) {
      const buffer = Buffer.concat(chunks, total);
      // Do NOT zero the chunk views here: they may be views into the caller's
      // buffer/stream. The concatenated copy is zeroed by putEncrypted.
      chunks.length = 0;
      return { kind: 'single', buffer };
    }
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    if (chunk.length === 0) continue;
    total += chunk.length;
    if (total > maxBytes) {
      chunks.length = 0;
      throw new SourceIngestionError(413, 'TOO_LARGE', 'pinned upload exceeded the transfer byte budget');
    }
    chunks.push(chunk);
    if (total > CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES) {
      const prefix = Buffer.concat(chunks, total);
      chunks.length = 0;
      return { kind: 'stream', prefix, rest: iterator };
    }
  }
}

/** Hash/cap the read prefix and the remaining source exactly once. */
async function* measuredPlaintext(
  prefix: Buffer,
  rest: AsyncIterator<Uint8Array>,
  maxBytes: number,
  sink: PlaintextSink,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  try {
    hash.update(prefix);
    sizeBytes += prefix.length;
    yield prefix;
    while (true) {
      if (signal?.aborted) throw abortError();
      const next = await rest.next();
      if (next.done) break;
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      if (chunk.length === 0) continue;
      sizeBytes += chunk.length;
      if (sizeBytes > maxBytes) {
        throw new SourceIngestionError(413, 'TOO_LARGE', 'pinned upload exceeded the transfer byte budget');
      }
      hash.update(chunk);
      yield chunk;
    }
    if (signal?.aborted) throw abortError();
    sink.sha256 = hash.digest('hex');
    sink.sizeBytes = sizeBytes;
  } finally {
    prefix.fill(0);
  }
}

/** Count/hash the ciphertext exactly as it leaves the envelope writer. */
async function* monitoredCiphertext(
  source: AsyncIterable<Uint8Array>,
  sink: CiphertextSink,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const raw of source) {
    if (signal?.aborted) throw abortError();
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (chunk.length === 0) continue;
    sizeBytes += chunk.length;
    hash.update(chunk);
    yield chunk;
  }
  sink.sha256 = hash.digest('hex');
  sink.sizeBytes = sizeBytes;
}

/** Project the single-shot envelope into the sidecar JSON the reader parses. */
function singleShotManifest(encrypted: EncryptedStorageObject): Record<string, unknown> {
  return {
    version: encrypted.version,
    algorithm: encrypted.algorithm,
    nonce: encrypted.nonce,
    tag: encrypted.tag,
    aad: encrypted.aad,
    plaintextSizeBytes: encrypted.plaintextSizeBytes,
    plaintextSha256: encrypted.plaintextSha256,
    dek: encrypted.dek,
  };
}

export function createS3EncryptedPinnedSourceStorage(
  options: S3EncryptedPinnedSourceStorageOptions,
): S3EncryptedPinnedSourceStorage {
  if (!options || typeof options.bucket !== 'string' || !options.bucket) {
    throw new Error('encrypted source storage requires a bucket');
  }
  const encryption = assertEncryptionOptions(options.encryption);
  const resolvePinned = createResolvePinned(options.db);

  const deleteVersion = async (key: string, versionId: string | undefined): Promise<void> => {
    if (!versionId) return;
    try {
      await options.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key, VersionId: versionId }));
    } catch {
      // Best-effort cleanup: the safe failure result must not change.
    }
  };

  const readBackHash = async (body: unknown, expectedBytes: number): Promise<string> => {
    if (!body || (typeof body !== 'object' && typeof body !== 'string')) {
      throw new SourceIngestionError(502, 'STORAGE_FAILURE', 'stored encrypted object could not be read back');
    }
    const hash = createHash('sha256');
    let bytes = 0;
    if (typeof body === 'string') {
      const chunk = Buffer.from(body);
      bytes = chunk.length;
      hash.update(chunk);
    } else if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
      const chunk = Buffer.isBuffer(body) ? body : Buffer.from(body);
      bytes = chunk.length;
      hash.update(chunk);
    } else if (typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
      for await (const raw of body as AsyncIterable<Uint8Array>) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        bytes += chunk.length;
        hash.update(chunk);
      }
    } else {
      throw new SourceIngestionError(502, 'STORAGE_FAILURE', 'stored encrypted object could not be read back');
    }
    if (bytes !== expectedBytes) {
      throw new SourceIngestionError(502, 'STORAGE_FAILURE', 'stored encrypted object size does not match its expected length');
    }
    return hash.digest('hex');
  };

  /**
   * Persist the manifest sidecar and pin its immutable version. Mirrors the
   * public upload gateway: metadata is the artifact/tenant binding, the head
   * is re-read, and the body hash is verified before the version is trusted.
   */
  const storeManifest = async (input: {
    storageKey: string;
    artifactId: string;
    tenantId: string;
    manifest: Record<string, unknown>;
  }): Promise<string> => {
    const manifestKey = manifestKeyFor(input.storageKey);
    const body = Buffer.from(JSON.stringify(input.manifest), 'utf8');
    const expectedSha256 = createHash('sha256').update(body).digest('hex');
    let versionId: string | undefined;
    try {
      const put = await options.send(new PutObjectCommand({
        Bucket: options.bucket,
        Key: manifestKey,
        Body: body,
        ContentLength: body.length,
        ContentType: 'application/json',
        Metadata: {
          artifactid: input.artifactId,
          tenantid: input.tenantId,
          'du-encrypted': 'manifest-v1',
        },
      }));
      versionId = put.VersionId;
      if (!versionId || versionId === 'null') {
        throw new SourceIngestionError(502, 'STORAGE_FAILURE', 'storage did not return an immutable manifest version');
      }
      const head = await options.send(new HeadObjectCommand({
        Bucket: options.bucket,
        Key: manifestKey,
        VersionId: versionId,
      })) as unknown as { ContentLength?: number; VersionId?: string; Metadata?: Record<string, string> };
      if (
        head.ContentLength !== body.length
        || (head.VersionId !== undefined && head.VersionId !== versionId)
        || head.Metadata?.artifactid !== input.artifactId
        || head.Metadata?.tenantid !== input.tenantId
        || head.Metadata?.['du-encrypted'] !== 'manifest-v1'
      ) {
        throw new SourceIngestionError(502, 'STORAGE_FAILURE', 'encrypted source manifest could not be verified');
      }
      const output = await options.send(new GetObjectCommand({
        Bucket: options.bucket,
        Key: manifestKey,
        VersionId: versionId,
      })) as unknown as { Body?: unknown };
      const actualSha256 = await readBackHash(output.Body, body.length);
      if (actualSha256 !== expectedSha256) {
        throw new SourceIngestionError(502, 'PIN_MISMATCH', 'encrypted source manifest checksum does not match');
      }
      return versionId;
    } catch (error) {
      await deleteVersion(manifestKey, versionId);
      throw error;
    } finally {
      body.fill(0);
    }
  };

  /** Head + read-back verification that the committed ciphertext is intact. */
  const verifyCiphertext = async (input: {
    storageKey: string;
    versionId: string;
    manifestKey: string;
    artifactId: string;
    tenantId: string;
    ciphertextSha256: string;
    ciphertextSizeBytes: number;
  }): Promise<void> => {
    const head = await options.send(new HeadObjectCommand({
      Bucket: options.bucket,
      Key: input.storageKey,
      VersionId: input.versionId,
      ChecksumMode: 'ENABLED',
    })) as unknown as { ContentLength?: number; VersionId?: string; Metadata?: Record<string, string> };
    if (
      head.ContentLength !== input.ciphertextSizeBytes
      || (head.VersionId !== undefined && head.VersionId !== input.versionId)
      || head.Metadata?.artifactid !== input.artifactId
      || head.Metadata?.tenantid !== input.tenantId
      || head.Metadata?.[ENCRYPTED_OBJECT_MARKER] !== ENCRYPTED_OBJECT_MARKER_VALUE
      || head.Metadata?.[MANIFEST_KEY_METADATA] !== input.manifestKey
    ) {
      throw new SourceIngestionError(502, 'STORAGE_FAILURE', 'stored encrypted source metadata does not match the write');
    }
    let output: { Body?: unknown };
    try {
      output = await options.send(new GetObjectCommand({
        Bucket: options.bucket,
        Key: input.storageKey,
        VersionId: input.versionId,
      })) as unknown as { Body?: unknown };
    } catch {
      throw new SourceIngestionError(502, 'STORAGE_FAILURE', 'encrypted source object could not be verified');
    }
    const actualSha256 = await readBackHash(output.Body, input.ciphertextSizeBytes);
    if (actualSha256 !== input.ciphertextSha256) {
      throw new SourceIngestionError(502, 'PIN_MISMATCH', 'stored ciphertext checksum does not match the write');
    }
  };

  function mapWriteError(error: unknown): never {
    if (error instanceof SourceIngestionError) throw error;
    if (error instanceof CryptoStorageError) {
      if (error.code === 'SIZE_LIMIT') {
        throw new SourceIngestionError(413, 'TOO_LARGE', 'source exceeds the envelope encryption limit');
      }
      throw new SourceIngestionError(502, 'STORAGE_FAILURE', 'source envelope encryption failed');
    }
    throw new SourceIngestionError(502, 'STORAGE_FAILURE', 'encrypted source write failed');
  }

  return {
    resolvePinned,

    async putVerified(): Promise<PinnedSourceWrite> {
      // The encrypted adapter never writes raw plaintext: a caller without an
      // envelope context must fail closed instead of silently downgrading.
      throw new SourceIngestionError(
        502,
        'STORAGE_FAILURE',
        'encrypted source storage requires an envelope context (putEncrypted)',
      );
    },

    async putEncrypted(input, rawContext) {
      const context = assertContext(rawContext);
      const cryptoContext: CryptoStorageEncryptContext = {
        tenantId: context.tenantId,
        artifactId: context.artifactId,
        objectVersion: context.objectVersion,
        // The strict artifact reader pins this purpose today
        // (artifact-read-decrypt.PUBLIC_UPLOAD_PURPOSE); using the exported
        // constant keeps source envelopes readable by the SAME reader until
        // SEC-ENC-01 freezes a per-purpose contract with migration coverage.
        purpose: PUBLIC_UPLOAD_PURPOSE,
        keyRef: encryption.keyRef,
        ...(encryption.keyVersion === undefined ? {} : { keyVersion: encryption.keyVersion }),
      };
      const storageKey = input.storageKey;
      const manifestKey = manifestKeyFor(storageKey);
      const metadata = {
        artifactid: context.artifactId,
        tenantid: context.tenantId,
        [ENCRYPTED_OBJECT_MARKER]: ENCRYPTED_OBJECT_MARKER_VALUE,
        [MANIFEST_KEY_METADATA]: manifestKey,
      };
      const plaintextSink: PlaintextSink = { sha256: '', sizeBytes: -1 };
      const ciphertextSink: CiphertextSink = { sha256: '', sizeBytes: -1 };
      let versionId: string | undefined;
      let manifestVersionId: string | undefined;
      let encryptionStream: ReturnType<CryptoStorageFacade['encryptStream']> | undefined;
      let plainBuffer: Buffer | undefined;
      try {
        const plan = await planPlaintext(input.body, input.maxBytes, input.signal);
        let manifest: Record<string, unknown>;
        if (plan.kind === 'single') {
          plainBuffer = plan.buffer;
          plaintextSink.sha256 = createHash('sha256').update(plainBuffer).digest('hex');
          plaintextSink.sizeBytes = plainBuffer.length;
          const encrypted = await encryption.facade.encrypt(plainBuffer, cryptoContext);
          manifest = singleShotManifest(encrypted);
          const ciphertext = encrypted.ciphertext;
          ciphertextSink.sha256 = createHash('sha256').update(ciphertext).digest('hex');
          ciphertextSink.sizeBytes = ciphertext.length;
          const put = await options.send(new PutObjectCommand({
            Bucket: options.bucket,
            Key: storageKey,
            Body: ciphertext,
            ContentLength: ciphertext.length,
            ContentType: input.contentType ?? 'application/octet-stream',
            Metadata: metadata,
            ChecksumAlgorithm: ChecksumAlgorithm.SHA256,
          }));
          versionId = put.VersionId;
          ciphertext.fill(0);
        } else {
          encryptionStream = encryption.facade.encryptStream(
            measuredPlaintext(plan.prefix, plan.rest, input.maxBytes, plaintextSink, input.signal),
            cryptoContext,
          );
          const body = Readable.from(
            monitoredCiphertext(encryptionStream.ciphertext, ciphertextSink, input.signal),
            { objectMode: false, highWaterMark: CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES },
          );
          const [put, encryptedManifest] = await Promise.all([
            options.send(new PutObjectCommand({
              Bucket: options.bucket,
              Key: storageKey,
              Body: body,
              ContentType: input.contentType ?? 'application/octet-stream',
              Metadata: metadata,
              ChecksumAlgorithm: ChecksumAlgorithm.SHA256,
            })),
            encryptionStream.manifest,
          ]);
          versionId = put.VersionId;
          manifest = encryptedManifest as unknown as Record<string, unknown>;
          if (plaintextSink.sha256 !== encryptedManifest.fileSha256 || plaintextSink.sizeBytes !== encryptedManifest.totalSizeBytes) {
            throw new SourceIngestionError(502, 'PIN_MISMATCH', 'plaintext stream disagrees with the encrypted manifest');
          }
        }
        if (!versionId || versionId === 'null') {
          throw new SourceIngestionError(502, 'STORAGE_FAILURE', 'S3 returned no immutable version id (enable bucket versioning)');
        }
        if (ciphertextSink.sizeBytes !== plaintextSink.sizeBytes) {
          throw new SourceIngestionError(502, 'PIN_MISMATCH', 'ciphertext length does not match the plaintext length');
        }
        manifestVersionId = await storeManifest({
          storageKey,
          artifactId: context.artifactId,
          tenantId: context.tenantId,
          manifest,
        });
        await verifyCiphertext({
          storageKey,
          versionId,
          manifestKey,
          artifactId: context.artifactId,
          tenantId: context.tenantId,
          ciphertextSha256: ciphertextSink.sha256,
          ciphertextSizeBytes: ciphertextSink.sizeBytes,
        });
        return {
          write: {
            storageKey,
            versionId,
            sha256: plaintextSink.sha256,
            sizeBytes: plaintextSink.sizeBytes,
          },
          description: {
            artifactId: context.artifactId,
            objectVersion: context.objectVersion,
            manifestVersionId,
            ciphertextSha256: ciphertextSink.sha256,
            ciphertextSizeBytes: ciphertextSink.sizeBytes,
          },
        };
      } catch (error) {
        encryptionStream?.ciphertext.destroy();
        await deleteVersion(storageKey, versionId);
        await deleteVersion(manifestKey, manifestVersionId);
        mapWriteError(error);
      } finally {
        plainBuffer?.fill(0);
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Historical plaintext variant                                        */
/* ------------------------------------------------------------------ */

export function createS3PinnedSourceStorage(options: S3PinnedSourceStorageOptions): PinnedSourceStorage {
  return {
    resolvePinned: createResolvePinned(options.db),

    async putVerified(input: {
      storageKey: string;
      contentType?: string;
      body: AsyncIterable<Uint8Array> | import('node:stream').Readable;
      maxBytes: number;
      signal?: AbortSignal;
    }): Promise<PinnedSourceWrite> {
      const hash = createHash('sha256');
      let sizeBytes = 0;
      async function* measured(): AsyncGenerator<Buffer> {
        for await (const raw of input.body as AsyncIterable<Uint8Array>) {
          if (input.signal?.aborted) {
            throw new SourceIngestionError(502, 'STORAGE_FAILURE', 'pinned upload aborted before the version committed');
          }
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
          if (chunk.length === 0) continue;
          sizeBytes += chunk.length;
          if (sizeBytes > input.maxBytes) {
            throw new SourceIngestionError(413, 'TOO_LARGE', 'pinned upload exceeded the transfer byte budget');
          }
          hash.update(chunk);
          yield chunk;
        }
      }

      let output: S3PinnedSendResult;
      try {
        output = await options.send(new PutObjectCommand({
          Bucket: options.bucket,
          Key: input.storageKey,
          // SDK v3 types Body as Readable/ReadableStream/... - an async
          // generator must enter the wire through Readable.from, never a
          // cast that hides the chunk accounting above.
          Body: Readable.from(measured()),
          ContentType: input.contentType,
          ChecksumAlgorithm: ChecksumAlgorithm.SHA256,
        }));
      } catch (err) {
        if (err instanceof SourceIngestionError) throw err;
        throw new SourceIngestionError(502, 'STORAGE_FAILURE', 'S3 rejected the pinned object version');
      }

      const sha256 = hash.digest('hex');
      const versionId = output.VersionId;
      if (!versionId || versionId === 'null') {
        // Same fail-closed rule the artifact facade applies at finalize:
        // without an immutable version id the receipt could be overwritten.
        throw new SourceIngestionError(502, 'STORAGE_FAILURE', 'S3 returned no immutable version id (enable bucket versioning)');
      }
      if (typeof output.ChecksumSHA256 === 'string' && output.ChecksumSHA256.length > 0) {
        const reported = Buffer.from(output.ChecksumSHA256, 'base64').toString('hex');
        if (reported !== sha256) {
          // SEC-ENC-03 cleanup: a version whose bytes storage checksummed
          // differently is never referenced by a receipt; remove it instead of
          // leaving an orphan generation behind.
          try {
            await options.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: input.storageKey, VersionId: versionId }));
          } catch {
            // Best-effort; the PIN_MISMATCH result is unchanged.
          }
          throw new SourceIngestionError(502, 'PIN_MISMATCH', 'S3 checksummed different bytes than this call streamed');
        }
      }
      return { storageKey: input.storageKey, versionId, sha256, sizeBytes };
    },
  };
}
