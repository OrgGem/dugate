/**
 * W-ENC-04-SEAM: the worker-side application encryption seam for artifact
 * bytes (ADR-18 baseline 1-3).
 *
 * This is a FAITHFUL PORT of the orchestrator crypto-storage-facade (ENC-03),
 * not a rewrite. Every wire-visible detail is byte-identical on purpose: the
 * AAD JSON formats, the single-shot and per-chunk AAD strings, the 4-byte
 * nonce prefix with a big-endian chunk index, the 4 MiB chunk size, the HKDF
 * manifest MAC key, and the error taxonomy. Orchestrator and worker must
 * interoperate on the same ciphertext, so a cleaner rewrite here would
 * silently break every object the two sides exchange (delta 43).
 *
 * The one thing that could not be imported is the key provider: it lives in
 * the orchestrator package, which worker-sdk must not depend on. The provider
 * shape below is declared locally and is structurally identical to the
 * orchestrator KeyProvider, so the real Vault Transit provider satisfies it
 * as-is when a deployment wires one in.
 *
 * No storage backend is called here: this module turns plaintext into
 * ciphertext and back. Where those bytes are persisted is the storage
 * adapter business (ENC-03); upload boundaries are ENC-05.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Readable } from 'node:stream';

/**
 * Vault Transit ciphertext plus the application key reference it was made
 * with. Structurally identical to the orchestrator provider WrappedDek, so the
 * same provider object satisfies both packages.
 */
export interface WrappedDek {
  readonly keyRef: string;
  readonly keyVersion: number;
  readonly ciphertext: string;
}

/** What the facade asks the provider to wrap. */
export interface WrapDekInput {
  readonly keyRef: string;
  readonly dek: Uint8Array;
  /** Pin to a known Transit key version; omitted uses the latest. */
  readonly keyVersion?: number;
}

/**
 * The only key surface this seam needs. A provider returns wrapped DEKs and
 * resolves them again; it never hands out a long-lived master key.
 */
export interface CryptoKeyProvider {
  wrapDek(input: WrapDekInput): Promise<WrappedDek>;
  unwrapDek(wrapped: WrappedDek): Promise<Buffer>;
}

export const CRYPTO_STORAGE_CHUNK_SIZE_BYTES = 4 * 1024 * 1024;
export const CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES = 5 * 1024 * 1024;

const VERSION = 1 as const;
const ALGORITHM = 'aes-256-gcm' as const;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MANIFEST_MAC_BYTES = 32;
const DEFAULT_MAX_CHUNKS = 65_536;
const SHA256_RE = /^[a-f0-9]{64}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type CryptoStorageErrorCode =
  | 'INVALID_INPUT'
  | 'SIZE_LIMIT'
  | 'INVALID_MANIFEST'
  | 'AUTHENTICATION_FAILED'
  | 'KEY_PROVIDER_FAILED'
  | 'STREAM_ABORTED';

export class CryptoStorageError extends Error {
  public readonly code: CryptoStorageErrorCode;

  public constructor(code: CryptoStorageErrorCode, message: string) {
    super(message);
    this.name = 'CryptoStorageError';
    this.code = code;
  }
}

/** The immutable identity expected when storing or reading one ciphertext version. */
export interface CryptoStorageContext {
  readonly tenantId: string;
  readonly artifactId: string;
  /** Bind ciphertext to a caller-managed immutable version to prevent replay across versions. */
  readonly objectVersion: string;
  readonly purpose?: string;
}

export interface CryptoStorageEncryptContext extends CryptoStorageContext {
  readonly keyRef: string;
  readonly keyVersion?: number;
}

export interface EncryptedStorageObject {
  readonly version: typeof VERSION;
  readonly algorithm: typeof ALGORITHM;
  readonly nonce: string;
  readonly tag: string;
  readonly ciphertext: Buffer;
  readonly aad: string;
  readonly plaintextSizeBytes: number;
  readonly plaintextSha256: string;
  readonly dek: WrappedDek;
}

export interface EncryptedStorageChunk {
  readonly index: number;
  readonly nonce: string;
  readonly tag: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/**
 * A local storage manifest. `manifestMac` authenticates every manifest field,
 * including the wrapped DEK and ordered chunk metadata. It is an internal
 * extension because the shared contract schema has not yet frozen a MAC field.
 */
export interface EncryptedStorageManifest {
  readonly version: typeof VERSION;
  readonly algorithm: typeof ALGORITHM;
  readonly chunkSizeBytes: typeof CRYPTO_STORAGE_CHUNK_SIZE_BYTES;
  readonly totalChunks: number;
  readonly totalSizeBytes: number;
  readonly fileSha256: string;
  readonly contextAad: string;
  readonly chunks: readonly EncryptedStorageChunk[];
  readonly dek: WrappedDek;
  readonly manifestMac: string;
}

export interface EncryptedStorageStream {
  /** Concatenated ciphertext chunks, emitted in manifest order. */
  readonly ciphertext: Readable;
  /** Resolves only after the ciphertext stream has completed successfully. */
  readonly manifest: Promise<EncryptedStorageManifest>;
}

export interface CryptoStorageFacadeOptions {
  /** Bounds manifest size and total work. Defaults to 65,536 chunks. */
  readonly maxChunks?: number;
}

type CryptoStorageKeyProvider = Pick<CryptoKeyProvider, 'wrapDek' | 'unwrapDek'>;

function invalidInput(message: string): never {
  throw new CryptoStorageError('INVALID_INPUT', message);
}

function invalidManifest(message: string): never {
  throw new CryptoStorageError('INVALID_MANIFEST', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateText(value: unknown, label: string, maxLength = 512): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maxLength
    || /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    invalidInput(label + ' is invalid');
  }
  return value;
}

function validateContext(context: CryptoStorageContext): CryptoStorageContext {
  if (!isRecord(context)) invalidInput('Storage context is required');
  const tenantId = validateText(context.tenantId, 'tenantId');
  const artifactId = validateText(context.artifactId, 'artifactId');
  const objectVersion = validateText(context.objectVersion, 'objectVersion');
  const purpose = context.purpose === undefined
    ? 'artifact-storage'
    : validateText(context.purpose, 'purpose', 128);
  return { tenantId, artifactId, objectVersion, purpose };
}

function validateEncryptContext(context: CryptoStorageEncryptContext): CryptoStorageEncryptContext {
  const validated = validateContext(context);
  const keyRef = validateText(context.keyRef, 'keyRef', 256);
  const keyVersion = context.keyVersion;
  if (
    keyVersion !== undefined
    && (!Number.isSafeInteger(keyVersion) || keyVersion < 1 || keyVersion > 2_147_483_647)
  ) {
    invalidInput('keyVersion must be a positive integer');
  }
  return { ...validated, keyRef, ...(keyVersion === undefined ? {} : { keyVersion }) };
}

function contextAad(context: CryptoStorageContext): Buffer {
  const validated = validateContext(context);
  return Buffer.from(JSON.stringify({
    format: 'du-crypto-storage-v1',
    tenantId: validated.tenantId,
    artifactId: validated.artifactId,
    objectVersion: validated.objectVersion,
    purpose: validated.purpose,
  }), 'utf8');
}

function singleAad(context: CryptoStorageContext, sizeBytes: number, sha256: string): Buffer {
  return Buffer.from(JSON.stringify({
    format: 'du-crypto-storage-single-v1',
    context: JSON.parse(contextAad(context).toString('utf8')) as Record<string, unknown>,
    sizeBytes,
    sha256,
  }), 'utf8');
}

function chunkAad(
  context: CryptoStorageContext,
  index: number,
  sizeBytes: number,
  sha256: string,
): Buffer {
  return Buffer.from(JSON.stringify({
    format: 'du-crypto-storage-chunk-v1',
    context: JSON.parse(contextAad(context).toString('utf8')) as Record<string, unknown>,
    index,
    sizeBytes,
    sha256,
  }), 'utf8');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeBase64(value: unknown, length: number | undefined, label: string): Buffer {
  const expectedChars = length === undefined ? 8192 : Math.ceil(length / 3) * 4;
  if (
    typeof value !== 'string'
    || value.length > expectedChars
    || (length !== undefined && value.length !== expectedChars)
    || !BASE64_RE.test(value)
  ) {
    invalidManifest(label + ' is invalid');
  }
  const bytes = Buffer.from(value, 'base64');
  if ((length !== undefined && bytes.length !== length) || bytes.toString('base64') !== value) {
    bytes.fill(0);
    invalidManifest(label + ' has an invalid length or encoding');
  }
  return bytes;
}

function validateWrappedDek(value: unknown): WrappedDek {
  if (!isRecord(value)) invalidManifest('Wrapped DEK metadata is invalid');
  if (
    typeof value.keyRef !== 'string'
    || value.keyRef.length < 1
    || value.keyRef.length > 256
    || /[\u0000-\u001f\u007f-\u009f]/.test(value.keyRef)
    || !Number.isSafeInteger(value.keyVersion)
    || (value.keyVersion as number) < 1
    || typeof value.ciphertext !== 'string'
    || value.ciphertext.length < 1
    || value.ciphertext.length > 16 * 1024
  ) {
    invalidManifest('Wrapped DEK metadata is invalid');
  }
  return {
    keyRef: value.keyRef,
    keyVersion: value.keyVersion as number,
    ciphertext: value.ciphertext,
  };
}

function validateWrappedResult(value: unknown): WrappedDek {
  if (!isRecord(value)) throw new CryptoStorageError('KEY_PROVIDER_FAILED', 'Key provider returned invalid wrapped DEK metadata');
  try {
    return validateWrappedDek(value);
  } catch {
    throw new CryptoStorageError('KEY_PROVIDER_FAILED', 'Key provider returned invalid wrapped DEK metadata');
  }
}

function unsignedManifest(manifest: EncryptedStorageManifest): Omit<EncryptedStorageManifest, 'manifestMac'> {
  return {
    version: manifest.version,
    algorithm: manifest.algorithm,
    chunkSizeBytes: manifest.chunkSizeBytes,
    totalChunks: manifest.totalChunks,
    totalSizeBytes: manifest.totalSizeBytes,
    fileSha256: manifest.fileSha256,
    contextAad: manifest.contextAad,
    chunks: manifest.chunks.map((chunk) => ({
      index: chunk.index,
      nonce: chunk.nonce,
      tag: chunk.tag,
      sha256: chunk.sha256,
      sizeBytes: chunk.sizeBytes,
    })),
    dek: {
      keyRef: manifest.dek.keyRef,
      keyVersion: manifest.dek.keyVersion,
      ciphertext: manifest.dek.ciphertext,
    },
  };
}

function manifestMacKey(dek: Buffer, aad: Buffer): Buffer {
  return Buffer.from(hkdfSync(
    'sha256',
    dek,
    createHash('sha256').update(aad).digest(),
    Buffer.from('du-crypto-storage-manifest-v1', 'utf8'),
    MANIFEST_MAC_BYTES,
  ));
}

function validateManifest(value: unknown, context: CryptoStorageContext, maxChunks: number): EncryptedStorageManifest {
  if (!isRecord(value)) invalidManifest('Chunk manifest is required');
  const allowedManifestKeys = [
    'version', 'algorithm', 'chunkSizeBytes', 'totalChunks', 'totalSizeBytes',
    'fileSha256', 'contextAad', 'chunks', 'dek', 'manifestMac',
  ];
  if (Object.keys(value).some((key) => !allowedManifestKeys.includes(key))) {
    invalidManifest('Chunk manifest contains unsupported fields');
  }
  if (
    value.version !== VERSION
    || value.algorithm !== ALGORITHM
    || value.chunkSizeBytes !== CRYPTO_STORAGE_CHUNK_SIZE_BYTES
    || !Number.isSafeInteger(value.totalChunks)
    || (value.totalChunks as number) < 1
    || (value.totalChunks as number) > maxChunks
    || !Number.isSafeInteger(value.totalSizeBytes)
    || (value.totalSizeBytes as number) <= CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES
    || typeof value.fileSha256 !== 'string'
    || !SHA256_RE.test(value.fileSha256)
    || typeof value.contextAad !== 'string'
    || value.contextAad.length > 2048
    || !Array.isArray(value.chunks)
    || value.chunks.length !== value.totalChunks
  ) {
    invalidManifest('Chunk manifest metadata is invalid');
  }
  const aad = contextAad(context);
  const suppliedAad = Buffer.from(value.contextAad, 'base64');
  if (
    suppliedAad.toString('base64') !== value.contextAad
    || !timingSafeEqual(
      suppliedAad.length === aad.length ? suppliedAad : Buffer.alloc(aad.length),
      aad,
    )
  ) {
    suppliedAad.fill(0);
    aad.fill(0);
    invalidManifest('Chunk manifest belongs to a different storage context');
  }
  suppliedAad.fill(0);
  aad.fill(0);

  const chunks: EncryptedStorageChunk[] = [];
  const nonceSet = new Set<string>();
  let summedBytes = 0;
  for (let index = 0; index < value.chunks.length; index++) {
    const raw = value.chunks[index];
    if (!isRecord(raw)) invalidManifest('Chunk metadata is invalid');
    const allowedChunkKeys = ['index', 'nonce', 'tag', 'sha256', 'sizeBytes'];
    if (Object.keys(raw).some((key) => !allowedChunkKeys.includes(key))) {
      invalidManifest('Chunk metadata contains unsupported fields');
    }
    if (
      raw.index !== index
      || !Number.isSafeInteger(raw.sizeBytes)
      || (raw.sizeBytes as number) < 1
      || (raw.sizeBytes as number) > CRYPTO_STORAGE_CHUNK_SIZE_BYTES
      || (index < value.chunks.length - 1 && raw.sizeBytes !== CRYPTO_STORAGE_CHUNK_SIZE_BYTES)
      || typeof raw.sha256 !== 'string'
      || !SHA256_RE.test(raw.sha256)
      || typeof raw.nonce !== 'string'
      || typeof raw.tag !== 'string'
    ) {
      invalidManifest('Chunk metadata is invalid or out of order');
    }
    decodeBase64(raw.nonce, NONCE_BYTES, 'Chunk nonce').fill(0);
    decodeBase64(raw.tag, TAG_BYTES, 'Chunk tag').fill(0);
    if (nonceSet.has(raw.nonce)) invalidManifest('Chunk nonces must be unique');
    nonceSet.add(raw.nonce);
    summedBytes += raw.sizeBytes as number;
    if (!Number.isSafeInteger(summedBytes)) invalidManifest('Chunk total size is invalid');
    chunks.push({
      index,
      nonce: raw.nonce,
      tag: raw.tag,
      sha256: raw.sha256,
      sizeBytes: raw.sizeBytes as number,
    });
  }
  if (summedBytes !== value.totalSizeBytes) invalidManifest('Chunk sizes do not match totalSizeBytes');
  const manifestMac = value.manifestMac;
  if (typeof manifestMac !== 'string') invalidManifest('Manifest authentication code is missing');
  decodeBase64(manifestMac, MANIFEST_MAC_BYTES, 'Manifest authentication code').fill(0);

  const manifest: EncryptedStorageManifest = {
    version: VERSION,
    algorithm: ALGORITHM,
    chunkSizeBytes: CRYPTO_STORAGE_CHUNK_SIZE_BYTES,
    totalChunks: value.totalChunks as number,
    totalSizeBytes: value.totalSizeBytes as number,
    fileSha256: value.fileSha256,
    contextAad: value.contextAad,
    chunks,
    dek: validateWrappedDek(value.dek),
    manifestMac,
  };
  return manifest;
}

async function* splitIntoChunks(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<Buffer, void, void> {
  const scratch = Buffer.allocUnsafe(CRYPTO_STORAGE_CHUNK_SIZE_BYTES);
  let used = 0;
  try {
    for await (const input of source) {
      if (!(input instanceof Uint8Array)) invalidInput('Stream chunks must be Uint8Array values');
      let offset = 0;
      while (offset < input.byteLength) {
        const take = Math.min(CRYPTO_STORAGE_CHUNK_SIZE_BYTES - used, input.byteLength - offset);
        Buffer.from(input.buffer, input.byteOffset + offset, take).copy(scratch, used, 0, take);
        used += take;
        offset += take;
        if (used === CRYPTO_STORAGE_CHUNK_SIZE_BYTES) {
          yield Buffer.from(scratch.subarray(0, used));
          used = 0;
        }
      }
    }
    if (used > 0) yield Buffer.from(scratch.subarray(0, used));
  } finally {
    scratch.fill(0);
  }
}

class CiphertextReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private current: Buffer = Buffer.alloc(0);
  private offset = 0;
  private ended = false;

  public constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  public async readExactly(byteLength: number): Promise<Buffer> {
    const output = Buffer.allocUnsafe(byteLength);
    let written = 0;
    while (written < byteLength) {
      if (this.offset >= this.current.length) {
        if (this.ended) {
          output.fill(0);
          throw new CryptoStorageError('AUTHENTICATION_FAILED', 'Ciphertext stream is truncated');
        }
        const next = await this.iterator.next();
        if (next.done) {
          this.ended = true;
          continue;
        }
        if (!(next.value instanceof Uint8Array)) {
          output.fill(0);
          throw new CryptoStorageError('INVALID_INPUT', 'Ciphertext stream chunks must be Uint8Array values');
        }
        this.current = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
        this.offset = 0;
        if (this.current.length === 0) continue;
      }
      const take = Math.min(byteLength - written, this.current.length - this.offset);
      this.current.copy(output, written, this.offset, this.offset + take);
      this.offset += take;
      written += take;
    }
    return output;
  }

  public async assertEnd(): Promise<void> {
    if (this.offset < this.current.length) {
      throw new CryptoStorageError('AUTHENTICATION_FAILED', 'Ciphertext stream has trailing bytes');
    }
    while (!this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        return;
      }
      if (!(next.value instanceof Uint8Array)) {
        throw new CryptoStorageError('INVALID_INPUT', 'Ciphertext stream chunks must be Uint8Array values');
      }
      if (next.value.byteLength > 0) {
        throw new CryptoStorageError('AUTHENTICATION_FAILED', 'Ciphertext stream has trailing bytes');
      }
    }
  }

  public async close(): Promise<void> {
    try {
      if (!this.ended && this.iterator.return) await this.iterator.return();
    } finally {
      this.current = Buffer.alloc(0);
      this.offset = 0;
      this.ended = true;
    }
  }
}

/**
 * Application storage boundary. Each object gets a fresh random 256-bit DEK;
 * only the Vault Transit wrapped form is returned with persisted ciphertext.
 */
export class CryptoStorageFacade {
  private readonly keyProvider: CryptoStorageKeyProvider;
  private readonly maxChunks: number;

  public constructor(keyProvider: CryptoStorageKeyProvider, options: CryptoStorageFacadeOptions = {}) {
    if (!keyProvider || typeof keyProvider.wrapDek !== 'function' || typeof keyProvider.unwrapDek !== 'function') {
      invalidInput('A DEK key provider is required');
    }
    const maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;
    if (!Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > DEFAULT_MAX_CHUNKS) {
      invalidInput('maxChunks must be between 1 and ' + DEFAULT_MAX_CHUNKS);
    }
    this.keyProvider = keyProvider;
    this.maxChunks = maxChunks;
  }

  /** Encrypt one non-empty object up to the 5 MiB single-shot threshold. */
  public async encrypt(
    plaintext: Uint8Array,
    context: CryptoStorageEncryptContext,
  ): Promise<EncryptedStorageObject> {
    if (!(plaintext instanceof Uint8Array)) invalidInput('Plaintext must be a Uint8Array');
    const validatedContext = validateEncryptContext(context);
    if (plaintext.byteLength < 1) invalidInput('Empty artifacts are not supported');
    if (plaintext.byteLength > CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES) {
      throw new CryptoStorageError('SIZE_LIMIT', 'Artifact exceeds the single-shot encryption limit');
    }
    const plaintextCopy = Buffer.from(plaintext);
    const digest = sha256(plaintextCopy);
    const aad = singleAad(validatedContext, plaintextCopy.length, digest);
    const dek = randomBytes(KEY_BYTES);
    let wrapped: WrappedDek;
    try {
      wrapped = await this.wrapDek(dek, validatedContext);
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, dek, nonce);
      cipher.setAAD(aad, { plaintextLength: plaintextCopy.length });
      const first = cipher.update(plaintextCopy);
      const last = cipher.final();
      const ciphertext = Buffer.concat([first, last]);
      first.fill(0);
      last.fill(0);
      return {
        version: VERSION,
        algorithm: ALGORITHM,
        nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext,
        aad: aad.toString('base64'),
        plaintextSizeBytes: plaintextCopy.length,
        plaintextSha256: digest,
        dek: wrapped,
      };
    } catch (error) {
      if (error instanceof CryptoStorageError) throw error;
      throw new CryptoStorageError('AUTHENTICATION_FAILED', 'Artifact encryption failed');
    } finally {
      dek.fill(0);
      plaintextCopy.fill(0);
      aad.fill(0);
    }
  }

  /** Authenticate the GCM tag, context, size, and plaintext digest before returning bytes. */
  public async decrypt(
    encrypted: EncryptedStorageObject,
    context: CryptoStorageContext,
  ): Promise<Buffer> {
    const validatedContext = validateContext(context);
    if (!isRecord(encrypted) || encrypted.version !== VERSION || encrypted.algorithm !== ALGORITHM) {
      invalidInput('Encrypted object metadata is invalid');
    }
    if (
      !(encrypted.ciphertext instanceof Uint8Array)
      || encrypted.ciphertext.byteLength < 1
      || !Number.isSafeInteger(encrypted.plaintextSizeBytes)
      || encrypted.plaintextSizeBytes < 1
      || encrypted.plaintextSizeBytes > CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES
      || encrypted.ciphertext.byteLength !== encrypted.plaintextSizeBytes
      || typeof encrypted.plaintextSha256 !== 'string'
      || !SHA256_RE.test(encrypted.plaintextSha256)
    ) {
      invalidInput('Encrypted object metadata is invalid');
    }
    const nonce = decodeBase64(encrypted.nonce, NONCE_BYTES, 'Nonce');
    const tag = decodeBase64(encrypted.tag, TAG_BYTES, 'Authentication tag');
    const aad = decodeBase64(encrypted.aad, undefined, 'AAD');
    const expectedAad = singleAad(validatedContext, encrypted.plaintextSizeBytes, encrypted.plaintextSha256);
    if (!timingSafeEqual(aad.length === expectedAad.length ? aad : Buffer.alloc(expectedAad.length), expectedAad)) {
      nonce.fill(0);
      tag.fill(0);
      aad.fill(0);
      expectedAad.fill(0);
      throw new CryptoStorageError('AUTHENTICATION_FAILED', 'Encrypted object context does not match');
    }
    const dek = await this.unwrapDek(encrypted.dek);
    let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv(ALGORITHM, dek, nonce);
      decipher.setAAD(aad, { plaintextLength: encrypted.ciphertext.byteLength });
      decipher.setAuthTag(tag);
      const first = decipher.update(encrypted.ciphertext);
      const last = decipher.final();
      plaintext = Buffer.concat([first, last]);
      first.fill(0);
      last.fill(0);
      if (
        plaintext.length !== encrypted.plaintextSizeBytes
        || sha256(plaintext) !== encrypted.plaintextSha256
      ) {
        throw new CryptoStorageError('AUTHENTICATION_FAILED', 'Encrypted object integrity check failed');
      }
      const result = plaintext;
      plaintext = undefined;
      return result;
    } catch {
      plaintext?.fill(0);
      throw new CryptoStorageError('AUTHENTICATION_FAILED', 'Encrypted object authentication failed');
    } finally {
      dek.fill(0);
      nonce.fill(0);
      tag.fill(0);
      aad.fill(0);
      expectedAad.fill(0);
    }
  }

  /**
   * Encrypt a large async byte source as independent authenticated 4 MiB
   * chunks. Consumers must persist/finalize the object only after `manifest`
   * resolves; an interrupted stream has no valid manifest.
   */
  public encryptStream(
    source: AsyncIterable<Uint8Array>,
    context: CryptoStorageEncryptContext,
  ): EncryptedStorageStream {
    if (!source || typeof source[Symbol.asyncIterator] !== 'function') invalidInput('An async plaintext stream is required');
    const validatedContext = validateEncryptContext(context);
    let resolveManifest!: (manifest: EncryptedStorageManifest) => void;
    let rejectManifest!: (error: Error) => void;
    let settled = false;
    const manifest = new Promise<EncryptedStorageManifest>((resolve, reject) => {
      resolveManifest = resolve;
      rejectManifest = reject;
    });
    // The stream itself is the primary error channel; attach a handler so a
    // caller that only consumes ciphertext does not cause an unhandled reject.
    void manifest.catch(() => undefined);
    const failManifest = (error: unknown): void => {
      if (settled) return;
      settled = true;
      rejectManifest(error instanceof Error ? error : new Error('Stream encryption failed'));
    };
    const completeManifest = (value: EncryptedStorageManifest): void => {
      if (settled) return;
      settled = true;
      resolveManifest(value);
    };
    const self = this;
    async function* run(): AsyncGenerator<Buffer, void, void> {
      try {
        yield* self.encryptChunkGenerator(source, validatedContext, completeManifest);
      } catch (error) {
        failManifest(error);
        throw error;
      } finally {
        if (!settled) failManifest(new CryptoStorageError('STREAM_ABORTED', 'Ciphertext stream ended before its manifest was complete'));
      }
    }
    const ciphertext = Readable.from(run(), {
      objectMode: false,
      highWaterMark: CRYPTO_STORAGE_CHUNK_SIZE_BYTES * 2,
    });
    ciphertext.on('close', () => {
      if (!settled) failManifest(new CryptoStorageError('STREAM_ABORTED', 'Ciphertext stream was closed before completion'));
    });
    return { ciphertext, manifest };
  }

  /** Verify the complete authenticated manifest before yielding any plaintext. */
  public decryptStream(
    ciphertext: AsyncIterable<Uint8Array>,
    rawManifest: EncryptedStorageManifest,
    context: CryptoStorageContext,
  ): Readable {
    if (!ciphertext || typeof ciphertext[Symbol.asyncIterator] !== 'function') invalidInput('An async ciphertext stream is required');
    const validatedContext = validateContext(context);
    const manifest = validateManifest(rawManifest, validatedContext, this.maxChunks);
    const self = this;
    async function* decrypt(): AsyncGenerator<Buffer, void, void> {
      yield* self.decryptChunkGenerator(ciphertext, manifest, validatedContext);
    }
    return Readable.from(decrypt(), {
      objectMode: false,
      highWaterMark: CRYPTO_STORAGE_CHUNK_SIZE_BYTES * 2,
    });
  }

  private async wrapDek(dek: Buffer, context: CryptoStorageEncryptContext): Promise<WrappedDek> {
    let wrapped: unknown;
    try {
      wrapped = await this.keyProvider.wrapDek({
        keyRef: context.keyRef,
        dek,
        ...(context.keyVersion === undefined ? {} : { keyVersion: context.keyVersion }),
      });
    } catch {
      throw new CryptoStorageError('KEY_PROVIDER_FAILED', 'DEK could not be wrapped');
    }
    return validateWrappedResult(wrapped);
  }

  private async unwrapDek(wrapped: WrappedDek): Promise<Buffer> {
    let dek: Buffer;
    try {
      dek = await this.keyProvider.unwrapDek(wrapped);
    } catch {
      throw new CryptoStorageError('KEY_PROVIDER_FAILED', 'DEK could not be unwrapped');
    }
    if (!Buffer.isBuffer(dek) || dek.byteLength !== KEY_BYTES) {
      if (dek instanceof Uint8Array) dek.fill(0);
      throw new CryptoStorageError('KEY_PROVIDER_FAILED', 'Key provider returned an invalid DEK');
    }
    return dek;
  }

  private async *encryptChunkGenerator(
    source: AsyncIterable<Uint8Array>,
    context: CryptoStorageEncryptContext,
    complete: (manifest: EncryptedStorageManifest) => void,
  ): AsyncGenerator<Buffer, void, void> {
    const dek = randomBytes(KEY_BYTES);
    let contextBytes: Buffer | undefined;
    let manifestKey: Buffer | undefined;
    try {
      const wrappedDek = await this.wrapDek(dek, context);
      contextBytes = contextAad(context);
      const noncePrefix = randomBytes(4);
      const fullHash = createHash('sha256');
      const chunks: EncryptedStorageChunk[] = [];
      let totalSizeBytes = 0;
      let index = 0;
      for await (const plaintext of splitIntoChunks(source)) {
        if (index >= this.maxChunks) {
          plaintext.fill(0);
          throw new CryptoStorageError('SIZE_LIMIT', 'Artifact exceeds the configured chunk limit');
        }
        totalSizeBytes += plaintext.length;
        if (!Number.isSafeInteger(totalSizeBytes)) {
          plaintext.fill(0);
          throw new CryptoStorageError('SIZE_LIMIT', 'Artifact size exceeds the supported limit');
        }
        const digest = sha256(plaintext);
        fullHash.update(plaintext);
        const nonce = Buffer.allocUnsafe(NONCE_BYTES);
        noncePrefix.copy(nonce, 0);
        nonce.writeBigUInt64BE(BigInt(index), 4);
        const aad = chunkAad(context, index, plaintext.length, digest);
        try {
          const cipher = createCipheriv(ALGORITHM, dek, nonce);
          cipher.setAAD(aad, { plaintextLength: plaintext.length });
          const first = cipher.update(plaintext);
          const last = cipher.final();
          const encrypted = Buffer.concat([first, last]);
          first.fill(0);
          last.fill(0);
          chunks.push({
            index,
            nonce: nonce.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
            sha256: digest,
            sizeBytes: plaintext.length,
          });
          yield encrypted;
        } finally {
          plaintext.fill(0);
          nonce.fill(0);
          aad.fill(0);
        }
        index++;
      }
      if (totalSizeBytes <= CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES) {
        throw new CryptoStorageError('SIZE_LIMIT', 'Chunked encryption requires an artifact larger than 5 MiB');
      }
      const withoutMac = {
        version: VERSION,
        algorithm: ALGORITHM,
        chunkSizeBytes: CRYPTO_STORAGE_CHUNK_SIZE_BYTES,
        totalChunks: chunks.length,
        totalSizeBytes,
        fileSha256: fullHash.digest('hex'),
        contextAad: contextBytes.toString('base64'),
        chunks,
        dek: wrappedDek,
        manifestMac: '',
      } satisfies EncryptedStorageManifest;
      manifestKey = manifestMacKey(dek, contextBytes);
      const mac = createHmac('sha256', manifestKey)
        .update(JSON.stringify(unsignedManifest(withoutMac)), 'utf8')
        .digest();
      const manifest: EncryptedStorageManifest = { ...withoutMac, manifestMac: mac.toString('base64') };
      mac.fill(0);
      complete(manifest);
    } finally {
      dek.fill(0);
      contextBytes?.fill(0);
      manifestKey?.fill(0);
    }
  }

  private async *decryptChunkGenerator(
    ciphertext: AsyncIterable<Uint8Array>,
    manifest: EncryptedStorageManifest,
    context: CryptoStorageContext,
  ): AsyncGenerator<Buffer, void, void> {
    const dek = await this.unwrapDek(manifest.dek);
    const aad = contextAad(context);
    const suppliedMac = Buffer.from(manifest.manifestMac, 'base64');
    let key: Buffer | undefined;
    const reader = new CiphertextReader(ciphertext);
    const totalHash = createHash('sha256');
    let totalSizeBytes = 0;
    try {
      key = manifestMacKey(dek, aad);
      const expectedMac = createHmac('sha256', key)
        .update(JSON.stringify(unsignedManifest(manifest)), 'utf8')
        .digest();
      if (!timingSafeEqual(expectedMac, suppliedMac)) {
        expectedMac.fill(0);
        throw new CryptoStorageError('AUTHENTICATION_FAILED', 'Chunk manifest authentication failed');
      }
      expectedMac.fill(0);

      for (const metadata of manifest.chunks) {
        const encrypted = await reader.readExactly(metadata.sizeBytes);
        const nonce = Buffer.from(metadata.nonce, 'base64');
        const tag = Buffer.from(metadata.tag, 'base64');
        const chunkAdditionalData = chunkAad(context, metadata.index, metadata.sizeBytes, metadata.sha256);
        let plaintext: Buffer | undefined;
        try {
          const decipher = createDecipheriv(ALGORITHM, dek, nonce);
          decipher.setAAD(chunkAdditionalData, { plaintextLength: metadata.sizeBytes });
          decipher.setAuthTag(tag);
          const first = decipher.update(encrypted);
          const last = decipher.final();
          plaintext = Buffer.concat([first, last]);
          first.fill(0);
          last.fill(0);
          if (plaintext.length !== metadata.sizeBytes || sha256(plaintext) !== metadata.sha256) {
            throw new CryptoStorageError('AUTHENTICATION_FAILED', 'Chunk integrity check failed');
          }
          totalHash.update(plaintext);
          totalSizeBytes += plaintext.length;
          yield plaintext;
          plaintext = undefined;
        } catch {
          plaintext?.fill(0);
          throw new CryptoStorageError('AUTHENTICATION_FAILED', 'Ciphertext chunk authentication failed');
        } finally {
          encrypted.fill(0);
          nonce.fill(0);
          tag.fill(0);
          chunkAdditionalData.fill(0);
        }
      }
      await reader.assertEnd();
      if (totalSizeBytes !== manifest.totalSizeBytes || totalHash.digest('hex') !== manifest.fileSha256) {
        throw new CryptoStorageError('AUTHENTICATION_FAILED', 'Artifact integrity check failed');
      }
    } finally {
      try {
        await reader.close();
      } finally {
        dek.fill(0);
        aad.fill(0);
        suppliedMac.fill(0);
        key?.fill(0);
      }
    }
  }
}
